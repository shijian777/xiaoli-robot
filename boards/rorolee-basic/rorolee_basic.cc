// RoRoLee Basic (ESP32-S3): local Wi-Fi A/B mediation controls.

#include "board.h"
#include "bridge_message.h"
#include "config.h"
#include "mediation_runtime.h"
#include "mediation_state.h"
#include "pending_audio_store.h"
#include "sh8501_panel.h"
#include "es_codec.h"
#include "bq27220.h"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <limits>

#include "agent_link.h"
#include "driver/gpio.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"
#include "nvs.h"

#define TAG "RoRoLeeS3"

namespace {

constexpr uint16_t kBridgeCustomCommand = 0x7e;
constexpr size_t kCaptureSamples = AUDIO_SAMPLE_RATE / 50;
constexpr size_t kCaptureBytes = kCaptureSamples * sizeof(int16_t);
constexpr size_t kBridgeQueueDepth = 16;
constexpr size_t kPlaybackNoticeDepth = 4;
constexpr size_t kPlaybackStorageBytes = xiaoli::kMaxPlaybackBytes + 1;

uint64_t NowMs() {
    return static_cast<uint64_t>(esp_timer_get_time()) / 1000ULL;
}

bool SameId(const char* lhs, const char* rhs) {
    return lhs != nullptr && rhs != nullptr &&
           std::strncmp(lhs, rhs, xiaoli::kIdCapacity) == 0;
}

struct PlaybackNotice {
    uint32_t case_generation = 0;
    bool drained = false;
};

struct CaseRuntime {
    char case_id[xiaoli::kIdCapacity] = {};
    char start_message_id[xiaoli::kIdCapacity] = {};
    char start_json[256] = {};
    uint32_t generation = 0;
    bool active = false;
    bool registered = false;
};

struct ReplayRuntime {
    xiaoli::SlotId slot = xiaoli::kInvalidSlot;
    uint64_t insertion_ordinal = 0;
    xiaoli::ReplayFrameCursor cursor{};
    bool active = false;
    bool stream_open = false;
};

}  // namespace

class RoRoLeeS3Board : public Board {
public:
    RoRoLeeS3Board() {
        PowerOnRail();
        InitDisplay();
        InitCodec();
        InitQueues();
        InitPlayback();
        InitHaptic();
        InitButtons();
        capture_store_ok_ = capture_store_.InitProduction();
        if (!capture_store_ok_) {
            ESP_LOGE(TAG, "PSRAM capture store allocation failed");
        }
        InitFuelGauge();
    }

    const char* Name() const override { return "ROROLEE_S3"; }

    uint32_t Capabilities() const override {
        return AGENT_CAP_MIC | AGENT_CAP_SPEAKER | AGENT_CAP_SCREEN |
               AGENT_CAP_BUTTON | AGENT_CAP_HAPTIC | AGENT_CAP_BATTERY |
               AGENT_CAP_RECORDING;
    }

    void Start() override {
        if (mediation_task_ != nullptr) {
            return;
        }
        if (xTaskCreate(&RoRoLeeS3Board::MediationTaskEntry, "xiaoli_case",
                        8192, this, 6, &mediation_task_) != pdPASS) {
            mediation_task_ = nullptr;
            ESP_LOGE(TAG, "mediation task creation failed");
        }
    }

    void ShowText(const char* utf8) override {
        ESP_LOGI(TAG, "status=%s", utf8 ? utf8 : "");
        if (panel_.Ready()) {
            panel_.FillSolid(rgb565::kBlue);
        }
    }

    void PlayAudio(const uint8_t* pcm16, size_t bytes) override {
        if (play_buf_ == nullptr || pcm16 == nullptr || bytes == 0) {
            return;
        }

        // audio.start is parsed and arms the bounded ingress gate in the same
        // ordered callback worker before the first binary callback.  Account
        // either there or in the adopted session before publishing bytes.
        portENTER_CRITICAL(&playback_mux_);
        const bool staged = playback_ingress_.armed();
        const bool reserved = staged
            ? playback_ingress_.ReserveChunk(bytes)
            : playback_.ReserveChunk(bytes);
        portEXIT_CRITICAL(&playback_mux_);
        if (!reserved) {
            SignalBridgeIngressFault();
            return;
        }

        const size_t sent = xStreamBufferSend(play_buf_, pcm16, bytes, 0);
        if (sent != bytes) {
            portENTER_CRITICAL(&playback_mux_);
            // Adoption may have happened while xStreamBufferSend ran.  The
            // reservation was transferred to playback_ in that case.
            if (playback_ingress_.armed()) {
                playback_ingress_.FailIngress();
            } else {
                playback_.FailIngress();
            }
            portEXIT_CRITICAL(&playback_mux_);
            ESP_LOGE(TAG, "playback ingress incomplete (%u/%u bytes)",
                     static_cast<unsigned>(sent), static_cast<unsigned>(bytes));
            if (play_task_ != nullptr) {
                xTaskNotifyGive(play_task_);
            }
        }
    }

    // Bridge JSON audio.end, not the raw stream callback, owns business completion.
    void AudioEnd() override {
        ESP_LOGD(TAG, "transport voice stream end observed");
    }

    void Vibrate(uint32_t duration_ms) override {
        if (haptic_timer_ == nullptr || haptic_mutex_ == nullptr ||
            xSemaphoreTake(haptic_mutex_, portMAX_DELAY) != pdTRUE) {
            return;
        }
        const uint32_t clamped = xiaoli::ClampHapticDuration(duration_ms);
        // Serialize stop/start requests.  The deadline also prevents an old
        // callback that was already dispatched from switching off a newer
        // vibration.
        (void)esp_timer_stop(haptic_timer_);
        const int64_t deadline_us = esp_timer_get_time() +
            static_cast<int64_t>(clamped) * 1000LL;
        portENTER_CRITICAL(&haptic_mux_);
        haptic_deadline_us_ = deadline_us;
        gpio_set_level(HAPTIC_PIN, 1);
        portEXIT_CRITICAL(&haptic_mux_);
        const esp_err_t started = esp_timer_start_once(
            haptic_timer_, static_cast<uint64_t>(clamped) * 1000ULL);
        if (started != ESP_OK) {
            portENTER_CRITICAL(&haptic_mux_);
            if (haptic_deadline_us_ == deadline_us) {
                haptic_deadline_us_ = 0;
                gpio_set_level(HAPTIC_PIN, 0);
            }
            portEXIT_CRITICAL(&haptic_mux_);
        }
        xSemaphoreGive(haptic_mutex_);
    }

    void HandleCustom(uint16_t command, const uint8_t* payload,
                      size_t len) override {
        if (command != kBridgeCustomCommand || payload == nullptr || len == 0) {
            return;
        }
        if (len > xiaoli::kMaxBridgeMessageBytes || custom_queue_ == nullptr) {
            ESP_LOGW(TAG, "Bridge message rejected (size=%u)",
                     static_cast<unsigned>(len));
            return;
        }
        xiaoli::BridgeMessage message{};
        const xiaoli::BridgeParseResult parsed =
            xiaoli::ParseBridgeMessage(payload, len, &message);
        if (parsed == xiaoli::BridgeParseResult::kUnknown) {
            ESP_LOGW(TAG, "unknown Bridge message ignored");
            return;
        }
        if (parsed != xiaoli::BridgeParseResult::kOk) {
            ESP_LOGW(TAG, "invalid Bridge message rejected");
            return;
        }
        if (message.type == xiaoli::BridgeMessageType::kAudioStart &&
            !ArmPlaybackIngress(message)) {
            ESP_LOGE(TAG, "audio.start ingress could not be armed");
            SignalBridgeIngressFault();
            return;
        }
        if (xQueueSend(custom_queue_, &message, 0) != pdTRUE) {
            ESP_LOGE(TAG, "Bridge message queue full; reconnect required");
            SignalBridgeIngressFault();
        } else if (mediation_task_ != nullptr) {
            xTaskNotifyGive(mediation_task_);
        }
    }

    void HandleAgentState(agent_state_t state) override {
        latest_agent_state_.store(static_cast<uint8_t>(state),
                                  std::memory_order_release);
        agent_state_epoch_.fetch_add(1, std::memory_order_acq_rel);
        if (mediation_task_ != nullptr) {
            xTaskNotifyGive(mediation_task_);
        }
    }

    int GetBatteryLevel() override { return gauge_ok_ ? gauge_.Soc() : -1; }
    bool IsCharging() override { return gauge_ok_ && gauge_.IsCharging(); }

private:
    static void MediationTaskEntry(void* arg) {
        static_cast<RoRoLeeS3Board*>(arg)->MediationLoop();
    }

    static void PlayTaskEntry(void* arg) {
        static_cast<RoRoLeeS3Board*>(arg)->PlayLoop();
    }

    static void HapticTimerEntry(void* arg) {
        auto* self = static_cast<RoRoLeeS3Board*>(arg);
        const int64_t now_us = esp_timer_get_time();
        portENTER_CRITICAL(&self->haptic_mux_);
        if (self->haptic_deadline_us_ != 0 &&
            now_us >= self->haptic_deadline_us_) {
            self->haptic_deadline_us_ = 0;
            gpio_set_level(HAPTIC_PIN, 0);
        }
        portEXIT_CRITICAL(&self->haptic_mux_);
    }

    void InitQueues() {
        custom_queue_ = xQueueCreateStatic(
            kBridgeQueueDepth, sizeof(xiaoli::BridgeMessage),
            custom_queue_storage_,
            &custom_queue_control_);
        playback_notice_queue_ = xQueueCreateStatic(
            kPlaybackNoticeDepth, sizeof(PlaybackNotice),
            playback_notice_storage_, &playback_notice_control_);
        haptic_mutex_ = xSemaphoreCreateMutexStatic(&haptic_mutex_control_);
        if (custom_queue_ == nullptr || playback_notice_queue_ == nullptr ||
            haptic_mutex_ == nullptr) {
            ESP_LOGE(TAG, "static queue initialization failed");
        }
    }

    void SignalBridgeIngressFault() {
        bridge_ingress_fault_.store(true, std::memory_order_release);
        if (mediation_task_ != nullptr) {
            xTaskNotifyGive(mediation_task_);
        }
    }

    bool ArmPlaybackIngress(const xiaoli::BridgeMessage& message) {
        if (play_buf_ == nullptr || play_task_ == nullptr) {
            return false;
        }
        portENTER_CRITICAL(&playback_mux_);
        const bool idle = !playback_.active() && !playback_ingress_.armed();
        portEXIT_CRITICAL(&playback_mux_);
        if (!idle || xStreamBufferReset(play_buf_) != pdPASS) {
            return false;
        }
        portENTER_CRITICAL(&playback_mux_);
        const bool armed = !playback_.active() &&
            playback_ingress_.Arm(
                message.case_id, message.bytes, message.sample_rate,
                message.bits, message.channels);
        portEXIT_CRITICAL(&playback_mux_);
        return armed;
    }

    void CancelPlaybackIngress() {
        if (play_buf_ == nullptr) {
            return;
        }
        portENTER_CRITICAL(&playback_mux_);
        const bool reset_buffer = playback_ingress_.armed();
        playback_ingress_.Reset();
        portEXIT_CRITICAL(&playback_mux_);
        if (reset_buffer) {
            xStreamBufferReset(play_buf_);
        }
    }

    void InitButtons() {
        gpio_config_t config = {};
        config.pin_bit_mask = (1ULL << BUTTON_BOOT_PIN) |
                              (1ULL << BUTTON_PERSON_A_PIN) |
                              (1ULL << BUTTON_PERSON_B_PIN);
        config.mode = GPIO_MODE_INPUT;
        config.pull_up_en = GPIO_PULLUP_ENABLE;
        config.pull_down_en = GPIO_PULLDOWN_DISABLE;
        config.intr_type = GPIO_INTR_DISABLE;
        if (gpio_config(&config) != ESP_OK) {
            ESP_LOGE(TAG, "button GPIO initialization failed");
            return;
        }
        buttons_ok_ = true;
        ESP_LOGI(TAG, "buttons: case=GPIO0 left/A=GPIO40 right/B=GPIO39");
    }

    void InitHaptic() {
        gpio_config_t config = {};
        config.pin_bit_mask = 1ULL << HAPTIC_PIN;
        config.mode = GPIO_MODE_OUTPUT;
        config.pull_up_en = GPIO_PULLUP_DISABLE;
        config.pull_down_en = GPIO_PULLDOWN_DISABLE;
        config.intr_type = GPIO_INTR_DISABLE;
        if (gpio_config(&config) != ESP_OK) {
            ESP_LOGE(TAG, "haptic GPIO initialization failed");
            return;
        }
        gpio_set_level(HAPTIC_PIN, 0);
        esp_timer_create_args_t args = {};
        args.callback = &RoRoLeeS3Board::HapticTimerEntry;
        args.arg = this;
        args.name = "xiaoli_haptic";
        if (esp_timer_create(&args, &haptic_timer_) != ESP_OK) {
            haptic_timer_ = nullptr;
            ESP_LOGE(TAG, "haptic timer initialization failed");
        }
    }

    void InitPlayback() {
        if (!codec_ok_ || playback_notice_queue_ == nullptr) {
            return;
        }
        play_storage_ = static_cast<uint8_t*>(heap_caps_malloc(
            kPlaybackStorageBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
        if (play_storage_ == nullptr) {
            ESP_LOGE(TAG, "PSRAM playback allocation failed");
            return;
        }
        play_buf_ = xStreamBufferCreateStatic(
            kPlaybackStorageBytes, 1, play_storage_, &play_buf_control_);
        if (play_buf_ == nullptr) {
            ESP_LOGE(TAG, "playback stream initialization failed");
            return;
        }
        if (xTaskCreate(&RoRoLeeS3Board::PlayTaskEntry, "spk_play", 4096,
                        this, 5, &play_task_) != pdPASS) {
            play_task_ = nullptr;
            ESP_LOGE(TAG, "speaker task creation failed");
        }
    }

    bool InitIds() {
        uint8_t mac[6] = {};
        if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK) {
            ESP_LOGE(TAG, "device MAC read failed");
            return false;
        }
        nvs_handle_t handle = 0;
        if (nvs_open("xiaoli_ids", NVS_READWRITE, &handle) != ESP_OK) {
            ESP_LOGE(TAG, "ID epoch NVS open failed");
            return false;
        }
        uint32_t current = 0;
        const esp_err_t read = nvs_get_u32(handle, "boot_epoch", &current);
        if (read != ESP_OK && read != ESP_ERR_NVS_NOT_FOUND) {
            nvs_close(handle);
            ESP_LOGE(TAG, "ID epoch NVS read failed");
            return false;
        }
        uint32_t next = current + 1;
        if (next == 0) {
            next = 1;
        }
        const bool committed = nvs_set_u32(handle, "boot_epoch", next) == ESP_OK &&
                               nvs_commit(handle) == ESP_OK;
        nvs_close(handle);
        if (!committed || !ids_.Initialize(mac, next, true)) {
            ESP_LOGE(TAG, "ID epoch commit failed; business IDs disabled");
            return false;
        }
        ESP_LOGI(TAG, "business ID epoch initialized (%lu)",
                 static_cast<unsigned long>(next));
        return true;
    }

    uint8_t ReadPressedMask() const {
        uint8_t mask = 0;
        if (gpio_get_level(BUTTON_BOOT_PIN) == 0) mask |= 1U << 0;
        if (gpio_get_level(BUTTON_PERSON_A_PIN) == 0) mask |= 1U << 1;
        if (gpio_get_level(BUTTON_PERSON_B_PIN) == 0) mask |= 1U << 2;
        return mask;
    }

    void MediationLoop() {
        ids_ok_ = InitIds();
        const uint64_t boot_ms = NowMs();
        button_debouncer_.Reset(boot_ms, buttons_ok_ ? ReadPressedMask() : 0);
        xiaoli::Event boot{};
        boot.type = xiaoli::EventType::kBoot;
        boot.now_ms = boot_ms;
        ApplyActions(state_machine_.Handle(boot));

        if (!ids_ok_) {
            FeedError(xiaoli::ErrorReason::kMediationFailed);
        } else if (!capture_store_ok_ || play_buf_ == nullptr ||
                   play_task_ == nullptr) {
            FeedError(xiaoli::ErrorReason::kAudioCapacity);
        }

        while (true) {
            DrainBridgeIngressFault();
            ReconcileAgentState();
            DrainBridgeMessages();
            DrainPlaybackNotices();
            SampleButtons();

            xiaoli::Event tick{};
            tick.type = xiaoli::EventType::kTick;
            tick.now_ms = NowMs();
            ApplyActions(state_machine_.Handle(tick));
            MaybeRecoverRetryableError(tick.now_ms);

            if (active_slot_ != xiaoli::kInvalidSlot) {
                CaptureOneFrame();
                SampleButtons();
                continue;
            }

            StartReplayIfPossible();
            if (replay_.active) {
                PumpReplay();
                ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(5));
            } else {
                ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(10));
            }
        }
    }

    void SampleButtons() {
        if (!buttons_ok_) {
            return;
        }
        auto batch = button_debouncer_.Sample(NowMs(), ReadPressedMask());
        for (uint8_t index = 0; index < batch.count; ++index) {
            xiaoli::Event event = batch.items[index];
            if (event.type == xiaoli::EventType::kButtonReleased &&
                event.button == xiaoli::Button::kCase) {
                event.allow_new_case = !capture_store_.HasCompleteUnacked();
            }
            ApplyActions(state_machine_.Handle(event));
        }
    }

    bool ApplyActions(const xiaoli::ActionBatch& batch) {
        for (uint8_t index = 0; index < batch.count; ++index) {
            const xiaoli::Action& action = batch.items[index];
            bool keep_going = true;
            switch (action.type) {
                case xiaoli::ActionType::kNewCase:
                    keep_going = StartNewCase(action.case_generation);
                    break;
                case xiaoli::ActionType::kStartRecording:
                    keep_going = StartRecording(action.speaker);
                    break;
                case xiaoli::ActionType::kStopRecording:
                    keep_going = StopRecordingNormally();
                    break;
                case xiaoli::ActionType::kRequestMediation:
                    keep_going = RequestMediation(action.case_generation);
                    break;
                case xiaoli::ActionType::kVibrate:
                    Vibrate(action.duration_ms);
                    break;
                case xiaoli::ActionType::kShowStatus:
                    ShowBusinessStatus(action.status);
                    break;
                case xiaoli::ActionType::kNone:
                    break;
            }
            if (!keep_going) {
                return false;
            }
        }
        return true;
    }

    void ShowBusinessStatus(xiaoli::StatusId status) {
        const char* segment = "-";
        xiaoli::PendingSegmentView active{};
        if (active_slot_ != xiaoli::kInvalidSlot &&
            capture_store_.Get(active_slot_, &active)) {
            segment = active.meta.segment_id;
        }
        ESP_LOGI(TAG, "business state case=%s segment=%s status=%u",
                 case_.active ? case_.case_id : "-", segment,
                 static_cast<unsigned>(status));
        ShowText(xiaoli::StatusText(status));
        switch (status) {
            case xiaoli::StatusId::kWelcome: Vibrate(20); break;
            case xiaoli::StatusId::kWaiting: Vibrate(35); break;
            case xiaoli::StatusId::kRecordingA: Vibrate(70); break;
            case xiaoli::StatusId::kRecordingB: Vibrate(90); break;
            case xiaoli::StatusId::kMediating: Vibrate(160); break;
            default: break;
        }
    }

    bool StartNewCase(uint32_t generation) {
        if (!ids_ok_ || generation == 0 || capture_store_.HasCompleteUnacked()) {
            FeedError(capture_store_.HasCompleteUnacked()
                          ? xiaoli::ErrorReason::kAudioCapacity
                          : xiaoli::ErrorReason::kMediationFailed);
            return false;
        }
        CaseRuntime next{};
        if (!ids_.NextCase(next.case_id, sizeof(next.case_id)) ||
            !ids_.NextMessage(next.start_message_id,
                              sizeof(next.start_message_id))) {
            FeedError(xiaoli::ErrorReason::kMediationFailed);
            return false;
        }
        const int written = std::snprintf(
            next.start_json, sizeof(next.start_json),
            "{\"v\":1,\"type\":\"case.start\",\"messageId\":\"%s\","
            "\"caseId\":\"%s\"}",
            next.start_message_id, next.case_id);
        if (written <= 0 || static_cast<size_t>(written) >=
                                sizeof(next.start_json)) {
            FeedError(xiaoli::ErrorReason::kMediationFailed);
            return false;
        }
        next.generation = generation;
        next.active = true;
        case_ = next;
        transcript_tracker_.Reset();
        mediation_request_pending_ = false;
        mediation_request_inflight_ = false;
        mediation_pending_generation_ = 0;
        ResetReplayConnectionMarks();
        if (!link_ready_ || SendCaseStart() != ESP_OK) {
            FeedError(xiaoli::ErrorReason::kNetworkUnavailable);
            return false;
        }
        ESP_LOGI(TAG, "case started locally case=%s generation=%lu",
                 case_.case_id, static_cast<unsigned long>(generation));
        return true;
    }

    esp_err_t SendCaseStart() {
        if (!case_.active || !link_ready_) {
            return ESP_ERR_INVALID_STATE;
        }
        case_.registered = false;
        return agent_link_push_event(
            AGENT_EVT_CUSTOM,
            reinterpret_cast<const uint8_t*>(case_.start_json),
            std::strlen(case_.start_json));
    }

    bool StartRecording(xiaoli::Speaker speaker) {
        if (!ids_ok_ || !codec_ok_ || !capture_store_ok_ || !case_.active ||
            !case_.registered || !link_ready_ || replay_.active ||
            active_slot_ != xiaoli::kInvalidSlot) {
            FeedError(!capture_store_.HasFreeSlot()
                          ? xiaoli::ErrorReason::kAudioCapacity
                          : xiaoli::ErrorReason::kNetworkUnavailable);
            return false;
        }
        xiaoli::PendingSegmentMeta meta{};
        if (!ids_.NextSegment(case_.case_id, meta.segment_id,
                              sizeof(meta.segment_id)) ||
            !ids_.NextMessage(meta.start_message_id,
                              sizeof(meta.start_message_id))) {
            FeedError(xiaoli::ErrorReason::kMediationFailed);
            return false;
        }
        std::snprintf(meta.case_id, sizeof(meta.case_id), "%s", case_.case_id);
        const int end_written = std::snprintf(
            meta.end_message_id, sizeof(meta.end_message_id), "%s-end",
            meta.start_message_id);
        meta.speaker = speaker;
        meta.case_generation = case_.generation;
        const int json_written = std::snprintf(
            meta.start_json, sizeof(meta.start_json),
            "{\"v\":1,\"type\":\"speech.start\",\"messageId\":\"%s\","
            "\"caseId\":\"%s\",\"segmentId\":\"%s\",\"speaker\":\"%s\","
            "\"audio\":{\"sampleRate\":16000,\"bits\":16,\"channels\":1}}",
            meta.start_message_id, meta.case_id, meta.segment_id,
            speaker == xiaoli::Speaker::kA ? "A" : "B");
        if (end_written <= 0 ||
            static_cast<size_t>(end_written) >= sizeof(meta.end_message_id) ||
            json_written <= 0 ||
            static_cast<size_t>(json_written) >= sizeof(meta.start_json)) {
            FeedError(xiaoli::ErrorReason::kMediationFailed);
            return false;
        }

        xiaoli::SlotId slot = xiaoli::kInvalidSlot;
        const xiaoli::StoreResult begin = capture_store_.Begin(meta, &slot);
        if (begin != xiaoli::StoreResult::kOk) {
            FeedError(xiaoli::ErrorReason::kAudioCapacity);
            return false;
        }
        if (agent_link_asr_start(meta.start_json) != ESP_OK) {
            capture_store_.AbortIncomplete(slot);
            FeedError(xiaoli::ErrorReason::kNetworkUnavailable);
            return false;
        }
        if (codec_.StartMic() != ESP_OK) {
            CloseAsrStreamFailClosed(false);
            capture_store_.AbortIncomplete(slot);
            FeedError(xiaoli::ErrorReason::kRecordingIncomplete);
            return false;
        }
        active_slot_ = slot;
        active_speaker_ = speaker;
        recording_frames_ = 0;
        ESP_LOGI(TAG, "recording start case=%s segment=%s speaker=%s",
                 meta.case_id, meta.segment_id,
                 speaker == xiaoli::Speaker::kA ? "A" : "B");
        return true;
    }

    void CaptureOneFrame() {
        if (active_slot_ == xiaoli::kInvalidSlot) {
            return;
        }
        if (!link_ready_ || agent_link_state() != AGENT_STATE_READY) {
            AbortActiveRecording();
            FeedError(xiaoli::ErrorReason::kNetworkUnavailable);
            return;
        }
        int16_t pcm[kCaptureSamples] = {};
        size_t got = 0;
        if (codec_.ReadPcm(pcm, kCaptureSamples, &got) != ESP_OK ||
            got != kCaptureSamples) {
            AbortActiveRecording();
            FeedError(xiaoli::ErrorReason::kRecordingIncomplete);
            return;
        }
        const uint8_t* bytes = reinterpret_cast<const uint8_t*>(pcm);
        const xiaoli::StoreResult appended =
            capture_store_.Append(active_slot_, bytes, kCaptureBytes);
        if (appended != xiaoli::StoreResult::kOk) {
            AbortActiveRecording();
            FeedError(appended == xiaoli::StoreResult::kOverflow
                          ? xiaoli::ErrorReason::kAudioCapacity
                          : xiaoli::ErrorReason::kRecordingIncomplete);
            return;
        }
        if (agent_link_asr_push(bytes, kCaptureBytes) != ESP_OK) {
            AbortActiveRecording();
            FeedError(xiaoli::ErrorReason::kNetworkUnavailable);
            return;
        }
        ++recording_frames_;
    }

    void AbortActiveRecording() {
        if (active_slot_ == xiaoli::kInvalidSlot) {
            return;
        }
        (void)codec_.StopMic();
        CloseAsrStreamFailClosed(false);
        capture_store_.AbortIncomplete(active_slot_);
        active_slot_ = xiaoli::kInvalidSlot;
        active_speaker_ = xiaoli::Speaker::kNone;
        recording_frames_ = 0;
    }

    bool StopRecordingNormally() {
        if (active_slot_ == xiaoli::kInvalidSlot) {
            return true;
        }
        const xiaoli::SlotId slot = active_slot_;
        xiaoli::PendingSegmentView view{};
        (void)codec_.StopMic();
        if (recording_frames_ == 0 || !capture_store_.Get(slot, &view) ||
            view.bytes == 0 ||
            capture_store_.MarkLocallyComplete(slot) !=
                xiaoli::StoreResult::kOk) {
            CloseAsrStreamFailClosed(false);
            capture_store_.AbortIncomplete(slot);
            active_slot_ = xiaoli::kInvalidSlot;
            active_speaker_ = xiaoli::Speaker::kNone;
            recording_frames_ = 0;
            FeedError(xiaoli::ErrorReason::kRecordingIncomplete);
            return false;
        }
        const bool ended = CloseAsrStreamFailClosed(true);
        active_slot_ = xiaoli::kInvalidSlot;
        active_speaker_ = xiaoli::Speaker::kNone;
        recording_frames_ = 0;
        ESP_LOGI(TAG, "recording locally complete case=%s segment=%s bytes=%u",
                 view.meta.case_id, view.meta.segment_id,
                 static_cast<unsigned>(view.bytes));
        if (!ended) {
            FeedError(xiaoli::ErrorReason::kNetworkUnavailable);
            return false;
        }
        replay_ledger_.MarkSent(slot, view.insertion_ordinal);
        return true;
    }

    bool RequestMediation(uint32_t generation) {
        if (!case_.active || generation != case_.generation) {
            FeedError(xiaoli::ErrorReason::kNetworkUnavailable);
            return false;
        }
        mediation_request_pending_ = true;
        mediation_request_inflight_ = false;
        mediation_pending_generation_ = generation;
        if (active_slot_ == xiaoli::kInvalidSlot && !replay_.active &&
            !capture_store_.HasCompleteUnacked() &&
            !transcript_tracker_.ReadyToMediate() &&
            !transcript_tracker_.HasPending()) {
            mediation_request_pending_ = false;
            FeedError(xiaoli::ErrorReason::kMediationFailed, true);
            return false;
        }
        MaybeDispatchPendingMediation(false);
        return true;
    }

    bool SendMediationRequestNow() {
        char message_id[xiaoli::kIdCapacity] = {};
        char json[256] = {};
        if (!ids_.NextMessage(message_id, sizeof(message_id))) {
            FeedError(xiaoli::ErrorReason::kMediationFailed);
            return false;
        }
        const int written = std::snprintf(
            json, sizeof(json),
            "{\"v\":1,\"type\":\"mediate.request\",\"messageId\":\"%s\","
            "\"caseId\":\"%s\"}",
            message_id, case_.case_id);
        if (written <= 0 || static_cast<size_t>(written) >= sizeof(json)) {
            FeedError(xiaoli::ErrorReason::kMediationFailed);
            return false;
        }
        if (agent_link_push_event(
                AGENT_EVT_CUSTOM, reinterpret_cast<const uint8_t*>(json),
                static_cast<size_t>(written)) != ESP_OK) {
            RestartLinkPreservingCompleteAudio();
            return false;
        }
        mediation_request_inflight_ = true;
        ESP_LOGI(TAG, "mediation requested case=%s", case_.case_id);
        return true;
    }

    void MaybeDispatchPendingMediation(bool allow_readiness_probe) {
        if (!mediation_request_pending_ || mediation_request_inflight_ ||
            !case_.active ||
            mediation_pending_generation_ != case_.generation ||
            state_machine_.state() != xiaoli::MediationState::kMediating ||
            !link_ready_ || !case_.registered || replay_.active ||
            active_slot_ != xiaoli::kInvalidSlot ||
            capture_store_.HasCompleteUnacked()) {
            return;
        }
        if (!transcript_tracker_.ReadyToMediate() &&
            !allow_readiness_probe) {
            return;
        }
        (void)SendMediationRequestNow();
    }

    void FeedError(xiaoli::ErrorReason reason, bool auto_recover = false) {
        xiaoli::Event event{};
        event.type = xiaoli::EventType::kRecoverableError;
        event.now_ms = NowMs();
        event.error = reason;
        event.case_generation = case_.active ? case_.generation : 0;
        ApplyActions(state_machine_.Handle(event));
        recoverable_error_deadline_ms_ = auto_recover
            ? NowMs() + 1500 : 0;
    }

    void FeedRecovered() {
        recoverable_error_deadline_ms_ = 0;
        xiaoli::Event event{};
        event.type = xiaoli::EventType::kRecovered;
        event.now_ms = NowMs();
        event.case_generation = case_.active ? case_.generation : 0;
        ApplyActions(state_machine_.Handle(event));
    }

    void MaybeRecoverRetryableError(uint64_t now_ms) {
        if (recoverable_error_deadline_ms_ == 0 ||
            now_ms < recoverable_error_deadline_ms_ ||
            state_machine_.state() !=
                xiaoli::MediationState::kRecoverableError) {
            return;
        }
        FeedRecovered();
    }

    void ReconcileAgentState() {
        const uint32_t epoch =
            agent_state_epoch_.load(std::memory_order_acquire);
        const agent_state_t state = agent_link_state();
        if (epoch == observed_agent_state_epoch_ &&
            state == last_agent_state_) {
            return;
        }
        observed_agent_state_epoch_ = epoch;
        last_agent_state_ = state;
        if (state == AGENT_STATE_READY) {
            link_ready_ = true;
            mediation_request_inflight_ = false;
            ResetReplayConnectionMarks();
            if (case_.active) {
                if (SendCaseStart() != ESP_OK) {
                    RestartLinkPreservingCompleteAudio();
                }
            } else {
                FeedRecovered();
            }
            return;
        }

        link_ready_ = false;
        case_.registered = false;
        mediation_request_inflight_ = false;
        if (state != AGENT_STATE_DISCONNECTED) {
            return;
        }
        AbortActiveRecording();
        replay_ = {};
        AbortPlayback(false);
        CancelPlaybackIngress();
        if (!mediation_request_pending_) {
            FeedError(xiaoli::ErrorReason::kNetworkUnavailable);
        }
    }

    void DrainBridgeIngressFault() {
        if (!bridge_ingress_fault_.exchange(false,
                                            std::memory_order_acq_rel)) {
            return;
        }
        ESP_LOGE(TAG, "Bridge callback ingress lost ordering; restarting link");
        if (custom_queue_ != nullptr) {
            xQueueReset(custom_queue_);
        }
        CancelPlaybackIngress();
        AbortPlayback(false);
        RestartLinkPreservingCompleteAudio();
    }

    void DrainBridgeMessages() {
        if (custom_queue_ == nullptr) {
            return;
        }
        xiaoli::BridgeMessage message{};
        while (xQueueReceive(custom_queue_, &message, 0) == pdTRUE) {
            ApplyBridgeMessage(message);
        }
    }

    void ApplyBridgeMessage(const xiaoli::BridgeMessage& message) {
        switch (message.type) {
            case xiaoli::BridgeMessageType::kAck:
                ApplyAck(message);
                break;
            case xiaoli::BridgeMessageType::kAudioStart:
                ApplyAudioStart(message);
                break;
            case xiaoli::BridgeMessageType::kAudioEnd:
                ApplyAudioEnd(message);
                break;
            case xiaoli::BridgeMessageType::kError:
                ApplyBridgeError(message);
                break;
            case xiaoli::BridgeMessageType::kState:
                if (message.case_id[0] == '\0' ||
                    (case_.active && SameId(message.case_id, case_.case_id))) {
                    ESP_LOGI(TAG, "Bridge state=%u case=%s segment=%s",
                             static_cast<unsigned>(message.state),
                             message.case_id[0] ? message.case_id : "-",
                             message.segment_id[0] ? message.segment_id : "-");
                    if (message.state == xiaoli::BridgeState::kWaiting) {
                        if (state_machine_.state() ==
                            xiaoli::MediationState::kRecoverableError) {
                            FeedRecovered();
                        }
                        MaybeDispatchPendingMediation(true);
                    } else if (message.state ==
                               xiaoli::BridgeState::kMediating) {
                        mediation_request_pending_ = false;
                        mediation_request_inflight_ = false;
                    }
                }
                break;
            case xiaoli::BridgeMessageType::kTranscriptSaved:
                if (case_.active && SameId(message.case_id, case_.case_id)) {
                    ESP_LOGI(TAG, "transcript saved case=%s segment=%s speaker=%s",
                             message.case_id, message.segment_id,
                             message.speaker == xiaoli::Speaker::kA ? "A" : "B");
                    if (!transcript_tracker_.NoteSaved(message.segment_id,
                                                       message.speaker)) {
                        ESP_LOGE(TAG, "conflicting transcript identity rejected");
                        FeedError(xiaoli::ErrorReason::kMediationFailed);
                        break;
                    }
                    MaybeDispatchPendingMediation(false);
                }
                break;
            case xiaoli::BridgeMessageType::kUnknown:
                break;
        }
    }

    void ApplyAck(const xiaoli::BridgeMessage& message) {
        if (!case_.active || !SameId(message.case_id, case_.case_id)) {
            return;
        }
        if (message.has_accepted && message.accepted &&
            SameId(message.message_id, case_.start_message_id) &&
            message.segment_id[0] == '\0') {
            case_.registered = true;
            ESP_LOGI(TAG, "case registered case=%s", case_.case_id);
            FeedRecovered();
            StartReplayIfPossible();
            MaybeDispatchPendingMediation(true);
            return;
        }
        if (!message.has_durable || !message.has_bytes ||
            message.segment_id[0] == '\0') {
            return;
        }
        xiaoli::DurableAck ack{};
        std::snprintf(ack.case_id, sizeof(ack.case_id), "%s", message.case_id);
        std::snprintf(ack.segment_id, sizeof(ack.segment_id), "%s",
                      message.segment_id);
        std::snprintf(ack.message_id, sizeof(ack.message_id), "%s",
                      message.message_id);
        ack.bytes = message.bytes;
        ack.durable = message.durable;
        const xiaoli::AckResult released = capture_store_.ApplyDurableAck(ack);
        if (!released.released) {
            return;
        }
        if (!transcript_tracker_.NoteDurable(message.segment_id,
                                             released.speaker)) {
            ESP_LOGE(TAG, "durable ACK transcript identity conflict");
            FeedError(xiaoli::ErrorReason::kMediationFailed);
            return;
        }
        const bool acknowledged_active_replay =
            replay_.active && replay_.slot == released.slot &&
            replay_.insertion_ordinal == released.insertion_ordinal;
        if (acknowledged_active_replay) {
            // The cached ACK can race ahead of replay completion.  Disconnect
            // to discard the local stream without sending terminal
            // speech.end(complete=false) for data we still promise to retain.
            RestartLinkPreservingCompleteAudio();
        }
        ESP_LOGI(TAG, "durable audio ACK case=%s segment=%s bytes=%lu",
                 message.case_id, message.segment_id,
                 static_cast<unsigned long>(message.bytes));
        xiaoli::Event event{};
        event.type = xiaoli::EventType::kSegmentDurableAck;
        event.now_ms = NowMs();
        event.speaker = released.speaker;
        event.case_generation = released.case_generation;
        ApplyActions(state_machine_.Handle(event));
        // A complete retry can be acknowledged after an earlier end-admission
        // failure put the UI in the recoverable error state.  The durable ACK
        // is the evidence that this path has recovered.  In normal waiting
        // state we intentionally leave the five-second "statement ended"
        // status untouched.
        if (state_machine_.state() ==
            xiaoli::MediationState::kRecoverableError) {
            FeedRecovered();
        }
        MaybeDispatchPendingMediation(acknowledged_active_replay);
        StartReplayIfPossible();
    }

    void ApplyAudioStart(const xiaoli::BridgeMessage& message) {
        if (!case_.active || !SameId(message.case_id, case_.case_id)) {
            CancelPlaybackIngress();
            return;
        }
        if (state_machine_.state() != xiaoli::MediationState::kMediating ||
            play_buf_ == nullptr || play_task_ == nullptr) {
            CancelPlaybackIngress();
            return;
        }
        portENTER_CRITICAL(&playback_mux_);
        play_abort_requested_ = false;
        play_abort_report_error_ = false;
        const bool matches = playback_ingress_.Matches(
            message.case_id, message.bytes, message.sample_rate,
            message.bits, message.channels);
        const bool begun = matches && playback_.Begin(
            message.case_id, case_.generation, message.bytes,
            message.sample_rate, message.bits, message.channels);
        const bool adopted = begun && playback_ingress_.AdoptInto(playback_);
        portEXIT_CRITICAL(&playback_mux_);
        if (!adopted) {
            AbortPlayback(false);
            CancelPlaybackIngress();
            FeedError(xiaoli::ErrorReason::kMediationFailed);
            return;
        }
        mediation_request_pending_ = false;
        mediation_request_inflight_ = false;
        xiaoli::Event event{};
        event.type = xiaoli::EventType::kAudioStart;
        event.now_ms = NowMs();
        event.case_generation = case_.generation;
        ApplyActions(state_machine_.Handle(event));
        Vibrate(110);
        xTaskNotifyGive(play_task_);
    }

    void ApplyAudioEnd(const xiaoli::BridgeMessage& message) {
        if (!case_.active || !SameId(message.case_id, case_.case_id)) {
            return;
        }
        portENTER_CRITICAL(&playback_mux_);
        const bool accepted = playback_.AcceptEnd(
            message.case_id, message.bytes, message.last_sequence,
            message.complete);
        portEXIT_CRITICAL(&playback_mux_);
        if (!accepted) {
            AbortPlayback(false);
            FeedError(xiaoli::ErrorReason::kMediationFailed);
            return;
        }
        xTaskNotifyGive(play_task_);
    }

    void ApplyBridgeError(const xiaoli::BridgeMessage& message) {
        if (message.case_id[0] != '\0' &&
            (!case_.active || !SameId(message.case_id, case_.case_id))) {
            return;
        }
        ESP_LOGE(TAG, "Bridge error code=%s retryable=%d case=%s segment=%s",
                 message.code, static_cast<int>(message.retryable),
                 message.case_id[0] ? message.case_id : "-",
                 message.segment_id[0] ? message.segment_id : "-");

        if (std::strcmp(message.code, "mediation_not_ready") == 0 &&
            mediation_request_pending_) {
            // Admission raced durable storage/transcription.  Keep the
            // original long-press intent and mediating UI; transcript.saved
            // or a later waiting state will retry automatically.
            mediation_request_inflight_ = false;
            Vibrate(xiaoli::kErrorVibrateMs);
            return;
        }

        char active_segment[xiaoli::kIdCapacity] = {};
        char replay_segment[xiaoli::kIdCapacity] = {};
        xiaoli::PendingSegmentView view{};
        if (active_slot_ != xiaoli::kInvalidSlot &&
            capture_store_.Get(active_slot_, &view)) {
            std::snprintf(active_segment, sizeof(active_segment), "%s",
                          view.meta.segment_id);
        }
        if (replay_.active && capture_store_.Get(replay_.slot, &view) &&
            view.insertion_ordinal == replay_.insertion_ordinal) {
            std::snprintf(replay_segment, sizeof(replay_segment), "%s",
                          view.meta.segment_id);
        }
        const xiaoli::BridgeErrorTarget target =
            xiaoli::ClassifyBridgeErrorTarget(
                message.segment_id, active_segment, replay_segment);

        if (std::strcmp(message.code, "transcription_failed") == 0 &&
            message.segment_id[0] != '\0') {
            (void)transcript_tracker_.NoteFailed(message.segment_id);
            if (mediation_request_pending_ &&
                transcript_tracker_.ReadyToMediate()) {
                mediation_request_inflight_ = false;
                MaybeDispatchPendingMediation(false);
                return;
            }
            mediation_request_pending_ = false;
            mediation_request_inflight_ = false;
        }

        if (target == xiaoli::BridgeErrorTarget::kStale &&
            (active_segment[0] != '\0' || replay_segment[0] != '\0')) {
            ESP_LOGW(TAG, "stale segment error left current stream untouched");
            return;
        }
        if (target == xiaoli::BridgeErrorTarget::kActiveRecording ||
            target == xiaoli::BridgeErrorTarget::kCaseWide) {
            AbortActiveRecording();
        } else if (target == xiaoli::BridgeErrorTarget::kReplay) {
            RestartLinkPreservingCompleteAudio();
        }
        if (target == xiaoli::BridgeErrorTarget::kCaseWide) {
            AbortPlayback(false);
        }
        xiaoli::ErrorReason reason = xiaoli::ErrorReason::kNetworkUnavailable;
        if (std::strstr(message.code, "mediation") != nullptr) {
            reason = xiaoli::ErrorReason::kMediationFailed;
            mediation_request_pending_ = false;
            mediation_request_inflight_ = false;
        } else if (std::strstr(message.code, "audio") != nullptr ||
                   std::strstr(message.code, "segment") != nullptr ||
                   std::strstr(message.code, "transcription") != nullptr) {
            reason = xiaoli::ErrorReason::kRecordingIncomplete;
        }
        FeedError(reason, message.retryable);
    }

    bool FindReplayCandidate(xiaoli::PendingSegmentView* selected) {
        bool found = false;
        xiaoli::PendingSegmentView best{};
        for (xiaoli::SlotId slot = 0; slot < xiaoli::kPendingSlotCount; ++slot) {
            xiaoli::PendingSegmentView view{};
            if (!capture_store_.Get(slot, &view) || !view.locally_complete ||
                replay_ledger_.WasSent(slot, view.insertion_ordinal)) {
                continue;
            }
            if (!found || view.insertion_ordinal < best.insertion_ordinal) {
                best = view;
                found = true;
            }
        }
        if (found) {
            *selected = best;
        }
        return found;
    }

    void StartReplayIfPossible() {
        if (replay_.active || active_slot_ != xiaoli::kInvalidSlot ||
            !link_ready_ || !case_.registered) {
            return;
        }
        xiaoli::PendingSegmentView view{};
        if (!FindReplayCandidate(&view)) {
            return;
        }
        if (!SameId(view.meta.case_id, case_.case_id)) {
            ESP_LOGE(TAG, "pending prior-case audio blocks case replacement");
            return;
        }
        if (agent_link_asr_start(view.meta.start_json) != ESP_OK) {
            return;
        }
        replay_.slot = view.slot;
        replay_.insertion_ordinal = view.insertion_ordinal;
        replay_.cursor.Reset(view.bytes);
        replay_.active = true;
        replay_.stream_open = true;
        ESP_LOGI(TAG, "replay start case=%s segment=%s bytes=%u",
                 view.meta.case_id, view.meta.segment_id,
                 static_cast<unsigned>(view.bytes));
    }

    void PumpReplay() {
        if (!replay_.active) {
            return;
        }
        if (!link_ready_ || agent_link_state() != AGENT_STATE_READY) {
            replay_ = {};
            return;
        }
        xiaoli::PendingSegmentView view{};
        if (!capture_store_.Get(replay_.slot, &view) ||
            !view.locally_complete ||
            view.insertion_ordinal != replay_.insertion_ordinal) {
            if (replay_.stream_open) {
                RestartLinkPreservingCompleteAudio();
            }
            replay_ = {};
            StartReplayIfPossible();
            return;
        }
        if (replay_.cursor.done()) {
            const bool ended = CloseAsrStreamFailClosed(true);
            if (ended) {
                replay_ledger_.MarkSent(replay_.slot,
                                        replay_.insertion_ordinal);
            }
            replay_ = {};
            if (!ended) {
                FeedError(xiaoli::ErrorReason::kNetworkUnavailable);
                return;
            }
            FeedRecovered();
            StartReplayIfPossible();
            return;
        }
        const size_t bytes = replay_.cursor.CurrentBytes();
        const esp_err_t pushed = agent_link_asr_push(
            view.pcm + replay_.cursor.offset(), bytes);
        if (pushed == ESP_OK) {
            replay_.cursor.CommitSuccess();
        } else if (pushed == ESP_ERR_TIMEOUT) {
            replay_.cursor.OnTimeout();
        } else {
            // The slot remains complete-unacked.  Never tell Bridge that this
            // retained business segment is terminally incomplete.
            RestartLinkPreservingCompleteAudio();
            FeedError(xiaoli::ErrorReason::kNetworkUnavailable);
        }
    }

    void ResetReplayConnectionMarks() {
        replay_ledger_.Reset();
        replay_ = {};
    }

    bool CloseAsrStreamFailClosed(bool complete) {
        const esp_err_t ended = agent_link_asr_end(complete);
        if (ended == ESP_OK) {
            return true;
        }
        ESP_LOGW(TAG, "ASR stream %s end failed: %s",
                 complete ? "complete" : "incomplete",
                 esp_err_to_name(ended));

        if (xiaoli::EndFailureActionFor(complete) ==
            xiaoli::AsrEndFailureAction::kRestartLink) {
            // A locally complete slot must remain replayable from its original
            // speech.start after reconnect.  end(false) would make the Bridge
            // segment terminal-failed and permanently poison that retry.
            RestartLinkPreservingCompleteAudio();
            return false;
        }

        // A truly discarded recording may retry its terminal incomplete end
        // once because agent_link keeps the core stream open on admission
        // failure.  If that also fails, tear down the transport.
        const esp_err_t aborted = agent_link_asr_end(false);
        if (aborted != ESP_OK) {
            ESP_LOGE(TAG, "ASR abort admission failed; restarting link");
            RestartLinkPreservingCompleteAudio();
        }
        return false;
    }

    void RestartLinkPreservingCompleteAudio() {
        // A callback-ingress or transport fault can arrive while a live
        // recording still owns the microphone. Stop that local producer
        // before restarting the link. AbortIncomplete deliberately leaves a
        // slot untouched once MarkLocallyComplete() has succeeded, so this is
        // also safe on the complete-end admission failure path.
        if (active_slot_ != xiaoli::kInvalidSlot) {
            (void)codec_.StopMic();
            capture_store_.AbortIncomplete(active_slot_);
            active_slot_ = xiaoli::kInvalidSlot;
            active_speaker_ = xiaoli::Speaker::kNone;
            recording_frames_ = 0;
        }
        link_ready_ = false;
        case_.registered = false;
        mediation_request_inflight_ = false;
        ResetReplayConnectionMarks();
        agent_link_stop();
        const esp_err_t restarted = agent_link_start();
        if (restarted != ESP_OK) {
            ESP_LOGE(TAG, "link restart failed after protocol fault: %s",
                     esp_err_to_name(restarted));
        }
    }

    void AbortPlayback(bool report_error) {
        if (play_task_ == nullptr) {
            return;
        }
        portENTER_CRITICAL(&playback_mux_);
        if (playback_.active()) {
            playback_.Abort();
            play_abort_requested_ = true;
            play_abort_report_error_ = report_error;
        }
        portEXIT_CRITICAL(&playback_mux_);
        xTaskNotifyGive(play_task_);
    }

    void QueuePlaybackNotice(uint32_t generation, bool drained) {
        PlaybackNotice notice{};
        notice.case_generation = generation;
        notice.drained = drained;
        if (playback_notice_queue_ == nullptr ||
            xQueueSend(playback_notice_queue_, &notice, 0) != pdTRUE) {
            ESP_LOGE(TAG, "playback notice queue full");
        } else if (mediation_task_ != nullptr) {
            xTaskNotifyGive(mediation_task_);
        }
    }

    void PlayLoop() {
        int16_t pcm[256] = {};
        while (true) {
            ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
            while (true) {
                portENTER_CRITICAL(&playback_mux_);
                const bool abort = play_abort_requested_;
                const bool report_abort = play_abort_report_error_;
                const bool active = playback_.active();
                const bool incomplete = playback_.incomplete();
                const uint32_t generation = playback_.case_generation();
                if (abort) {
                    play_abort_requested_ = false;
                    play_abort_report_error_ = false;
                }
                portEXIT_CRITICAL(&playback_mux_);

                if (abort || incomplete) {
                    xStreamBufferReset(play_buf_);
                    if (report_abort || incomplete) {
                        QueuePlaybackNotice(generation, false);
                    }
                    break;
                }
                if (!active) {
                    break;
                }

                const size_t bytes = xStreamBufferReceive(
                    play_buf_, pcm, sizeof(pcm), pdMS_TO_TICKS(50));
                if (bytes != 0) {
                    if ((bytes & 1U) != 0 ||
                        codec_.WritePcm(pcm, bytes / sizeof(int16_t)) != ESP_OK) {
                        portENTER_CRITICAL(&playback_mux_);
                        playback_.Abort();
                        portEXIT_CRITICAL(&playback_mux_);
                        xStreamBufferReset(play_buf_);
                        QueuePlaybackNotice(generation, false);
                        break;
                    }
                    portENTER_CRITICAL(&playback_mux_);
                    const bool written = playback_.MarkWritten(bytes);
                    portEXIT_CRITICAL(&playback_mux_);
                    if (!written) {
                        xStreamBufferReset(play_buf_);
                        QueuePlaybackNotice(generation, false);
                        break;
                    }
                }

                const bool empty = xStreamBufferBytesAvailable(play_buf_) == 0;
                portENTER_CRITICAL(&playback_mux_);
                const bool drained = playback_.ReadyToFinish(empty);
                const uint32_t finished_generation = playback_.case_generation();
                if (drained) {
                    playback_.Finish();
                }
                portEXIT_CRITICAL(&playback_mux_);
                if (drained) {
                    QueuePlaybackNotice(finished_generation, true);
                    break;
                }
            }
        }
    }

    void DrainPlaybackNotices() {
        if (playback_notice_queue_ == nullptr) {
            return;
        }
        PlaybackNotice notice{};
        while (xQueueReceive(playback_notice_queue_, &notice, 0) == pdTRUE) {
            if (!case_.active || notice.case_generation != case_.generation) {
                continue;
            }
            if (!notice.drained) {
                FeedError(xiaoli::ErrorReason::kMediationFailed);
                continue;
            }
            xiaoli::Event event{};
            event.type = xiaoli::EventType::kAudioEnd;
            event.now_ms = NowMs();
            event.case_generation = notice.case_generation;
            ApplyActions(state_machine_.Handle(event));
        }
    }

    void InitCodec() {
        EsCodecConfig config = {};
        config.i2c_port = I2C_NUM_0;
        config.pin_sda = AUDIO_I2C_SDA;
        config.pin_scl = AUDIO_I2C_SCL;
        config.pin_mclk = AUDIO_I2S_MCLK;
        config.pin_bclk = AUDIO_I2S_BCLK;
        config.pin_ws = AUDIO_I2S_WS;
        config.pin_din = AUDIO_I2S_DIN;
        config.pin_dout = AUDIO_I2S_DOUT;
        config.pin_pa_en = AUDIO_PA_EN;
        config.es7210_addr = ES7210_ADDR;
        config.es8311_addr = ES8311_ADDR;
        config.sample_rate = AUDIO_SAMPLE_RATE;
        config.mic_gain = 30;
        config.out_volume = 80;
        if (codec_.Init(config) != ESP_OK) {
            ESP_LOGE(TAG, "codec init failed");
            return;
        }
        codec_ok_ = true;
    }

    void InitFuelGauge() {
        if (!codec_ok_) {
            ESP_LOGW(TAG, "codec/I2C not ready; skipping fuel gauge");
            return;
        }
        if (gauge_.Init(I2C_NUM_0, BQ27220_ADDR) != ESP_OK) {
            ESP_LOGW(TAG, "BQ27220 unavailable");
            return;
        }
        gauge_ok_ = true;
    }

    void PowerOnRail() {
        gpio_config_t config = {};
        config.pin_bit_mask = 1ULL << POWER_CTRL_PIN;
        config.mode = GPIO_MODE_OUTPUT;
        if (gpio_config(&config) != ESP_OK) {
            ESP_LOGE(TAG, "power GPIO initialization failed");
            return;
        }
        gpio_set_level(POWER_CTRL_PIN, POWER_CTRL_ACTIVE_HIGH ? 1 : 0);
        (void)gpio_hold_en(POWER_CTRL_PIN);
        vTaskDelay(pdMS_TO_TICKS(50));
    }

    void InitDisplay() {
        Sh8501Config config = {};
        config.spi_host = DISPLAY_SPI_HOST;
        config.pin_sck = DISPLAY_SCK_PIN;
        config.pin_mosi = DISPLAY_MOSI_PIN;
        config.pin_cs = DISPLAY_CS_PIN;
        config.pin_dc = DISPLAY_DC_PIN;
        config.pin_rst = DISPLAY_RST_PIN;
        config.width = DISPLAY_WIDTH;
        config.height = DISPLAY_HEIGHT;
        config.pclk_hz = DISPLAY_SPI_CLK_HZ;
        config.spi_mode = DISPLAY_SPI_MODE;
        if (panel_.Init(config) != ESP_OK) {
            ESP_LOGE(TAG, "display init failed");
            return;
        }
        const uint16_t sequence[] = {
            rgb565::kRed, rgb565::kGreen, rgb565::kBlue, rgb565::kWhite};
        for (uint16_t color : sequence) {
            panel_.FillSolid(color);
            vTaskDelay(pdMS_TO_TICKS(400));
        }
        panel_.FillSolid(rgb565::kWhite);
    }

    Sh8501Panel panel_;
    EsCodec codec_;
    Bq27220 gauge_;
    bool codec_ok_ = false;
    bool gauge_ok_ = false;
    bool buttons_ok_ = false;
    bool capture_store_ok_ = false;
    bool ids_ok_ = false;
    bool link_ready_ = false;
    agent_state_t last_agent_state_ = static_cast<agent_state_t>(0xff);
    std::atomic<uint8_t> latest_agent_state_{
        static_cast<uint8_t>(AGENT_STATE_DISCONNECTED)};
    std::atomic<uint32_t> agent_state_epoch_{0};
    uint32_t observed_agent_state_epoch_ = 0;
    std::atomic<bool> bridge_ingress_fault_{false};

    xiaoli::MediationStateMachine state_machine_;
    xiaoli::ButtonDebouncer button_debouncer_;
    xiaoli::PendingAudioStore capture_store_;
    xiaoli::BusinessIdGenerator ids_;
    CaseRuntime case_;
    ReplayRuntime replay_;
    xiaoli::ConnectionReplayLedger replay_ledger_;
    xiaoli::TranscriptTracker transcript_tracker_;
    xiaoli::SlotId active_slot_ = xiaoli::kInvalidSlot;
    xiaoli::Speaker active_speaker_ = xiaoli::Speaker::kNone;
    uint32_t recording_frames_ = 0;
    bool mediation_request_pending_ = false;
    bool mediation_request_inflight_ = false;
    uint32_t mediation_pending_generation_ = 0;
    uint64_t recoverable_error_deadline_ms_ = 0;

    TaskHandle_t mediation_task_ = nullptr;
    TaskHandle_t play_task_ = nullptr;
    esp_timer_handle_t haptic_timer_ = nullptr;
    StaticSemaphore_t haptic_mutex_control_{};
    SemaphoreHandle_t haptic_mutex_ = nullptr;
    portMUX_TYPE haptic_mux_ = portMUX_INITIALIZER_UNLOCKED;
    int64_t haptic_deadline_us_ = 0;

    StaticQueue_t custom_queue_control_{};
    uint8_t custom_queue_storage_[
        kBridgeQueueDepth * sizeof(xiaoli::BridgeMessage)] = {};
    QueueHandle_t custom_queue_ = nullptr;
    StaticQueue_t playback_notice_control_{};
    uint8_t playback_notice_storage_[kPlaybackNoticeDepth * sizeof(PlaybackNotice)] = {};
    QueueHandle_t playback_notice_queue_ = nullptr;

    uint8_t* play_storage_ = nullptr;
    StaticStreamBuffer_t play_buf_control_{};
    StreamBufferHandle_t play_buf_ = nullptr;
    portMUX_TYPE playback_mux_ = portMUX_INITIALIZER_UNLOCKED;
    xiaoli::PlaybackSession playback_;
    xiaoli::PlaybackIngressGate playback_ingress_;
    bool play_abort_requested_ = false;
    bool play_abort_report_error_ = false;
};

DECLARE_BOARD(RoRoLeeS3Board);
