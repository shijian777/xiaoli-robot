// agent_link WiFi transport backend — station (STA) bring-up + captive-portal provisioning (配网).
//
// What this file owns:
//    1.The ESP-IDF WiFi stack for the WiFi transport: esp_netif + driver init, STA connect,
//     auto-reconnect with backoff, and credential persistence in NVS
//    2.First-run provisioning: with no stored credentials it brings up an open SoftAP and hands
//     off to the captive portal (wifi_provision.cpp) — the user joins the device's WiFi, a page
//     opens automatically, and they enter their home SSID/password. Credentials are saved only
//     once the device confirms it can actually join (got an IP), so a wrong password is never kept
//    3.Self-healing: if stored credentials stop working (AP moved / password changed), it reopens
//     the portal after a bounded number of failed joins
#include "agent_link_transport.h"
#include "agent_link.h"          // agent_wifi_config_t (STA credentials + cloud endpoint)
#include "protocol.h"
#include "wifi_provision.h"
#include "wifi_transport_utils.h"
#include "wifi_wire.h"

#include <algorithm>
#include <atomic>
#include <cstring>
#include <cstdio>
#include <new>
#include <mutex>
#include <string>
#include <vector>

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "mdns.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "lwip/def.h"

#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

namespace {
constexpr const char* TAG = "agent_link.wifi";

// NVS store for provisioned station credentials.
constexpr const char* kNvsNs   = "al_wifi";
constexpr const char* kNvsSsid = "ssid";
constexpr const char* kNvsPass = "pass";
constexpr const char* kNvsEndpoint = "endpoint";
constexpr const char* kNvsDeviceToken = "dev_token";

// Reconnect / provisioning-fallback thresholds.
constexpr int      kProvFailLimit   = 3;      // provisioning: give up an attempt after 3 disconnects
constexpr int      kBootFailLimit   = 8;      // stored creds: after 8 failed joins without ever getting IP ,then open the portal
constexpr uint32_t kReconnectBaseMs = 2000;   // base station reconnect backoff
constexpr uint32_t kReconnectMaxMs  = 30000;  // backoff cap
constexpr uint32_t kProvTeardownMs  = 4000;   // linger on the portal after success so the page can show it, then drop the AP
constexpr uint32_t kBridgeRetryMaxMs = 30000;
constexpr uint32_t kHelloAckTimeoutMs = 5000;
constexpr uint32_t kWorkerPollMs = 100;
constexpr size_t kRxItemCapacity = 8;
constexpr size_t kCallbackItemCapacity = 24;

constexpr EventBits_t kWsGotIp = BIT0;
constexpr EventBits_t kWsConnected = BIT1;
constexpr EventBits_t kWsAuthenticated = BIT2;
constexpr EventBits_t kWsRecycle = BIT3;
constexpr EventBits_t kWsTxReady = BIT4;
constexpr EventBits_t kWsRxReady = BIT5;
constexpr EventBits_t kWsStop = BIT6;

enum class Phase { kIdle, kProvisioning, kStaConnecting, kStaConnected };

char  s_name[25]    = "AgentLink";   // device name,SoftAP SSID prefix
char  s_ap_ssid[33] = {0};           // "<name>-XXXX" (XXXX from the SoftAP MAC)

const agent_wifi_config_s* s_cfg = nullptr;   // STA creds + cloud endpoint/token

// Transport -> core uplink callbacks
void (*s_on_recv)(const uint8_t*, size_t) = nullptr;
void (*s_on_conn)(bool) = nullptr;
void (*s_on_stream)(agent_stream_t, const uint8_t*, size_t) = nullptr;

bool  s_wifi_inited = false;
bool  s_started     = false;
Phase s_phase       = Phase::kIdle;
bool  s_want_connect = false;    // gate STA_START/reconnect auto-connect (off while waiting for portal input)
bool  s_ever_got_ip  = false;    // once true, keep retrying forever instead of falling back to the portal
int   s_retry        = 0;        // consecutive failed joins in the current phase

char       s_ssid[33] = {0};     // credentials currently being tried
char       s_pass[65] = {0};
char       s_endpoint[AL_PROV_ENDPOINT_CAPACITY] = {0};
char       s_device_token[AL_PROV_DEVICE_TOKEN_CAPACITY] = {0};
std::mutex s_cred_mtx;

struct TxItem {
    bool text = false;
    xiaoli::wifi::TxClass tx_class = xiaoli::wifi::TxClass::kReserved;
    std::vector<uint8_t> payload;
};

using RxItem = xiaoli::wifi::CompleteMessage;

enum class CallbackKind : uint8_t { kConnection, kControl, kStream };

struct CallbackItem {
    CallbackKind kind = CallbackKind::kConnection;
    bool connected = false;
    bool counted = false;
    agent_stream_t stream = AGENT_STREAM_VOICE;
    uint32_t generation = 0;
    std::vector<uint8_t> payload;
};

QueueHandle_t s_tx_queue = nullptr;
QueueHandle_t s_rx_queue = nullptr;
SemaphoreHandle_t s_tx_lock = nullptr;
SemaphoreHandle_t s_tx_space = nullptr;
SemaphoreHandle_t s_worker_done = nullptr;
EventGroupHandle_t s_ws_events = nullptr;
TaskHandle_t s_ws_worker = nullptr;
esp_websocket_client_handle_t s_ws_client = nullptr;
QueueHandle_t s_callback_queue = nullptr;
TaskHandle_t s_callback_worker = nullptr;

xiaoli::wifi::TxQueuePolicy s_tx_policy;
xiaoli::wifi::UplinkStreams s_uplink;
xiaoli::wifi::FragmentAssembler s_fragments;
xiaoli::wifi::VoiceRxTracker s_voice_rx;
xiaoli::wifi::PublicCallBarrier s_public_calls;
xiaoli::wifi::PublicCallBarrier s_callback_calls;

std::atomic<bool> s_got_ip{false};
std::atomic<bool> s_ws_connected{false};
std::atomic<bool> s_ws_authenticated{false};
std::atomic<bool> s_accepting{false};
std::atomic<bool> s_stopping{false};
std::atomic<bool> s_ready_announced{false};
std::atomic<bool> s_destroying_client{false};
std::atomic<int64_t> s_hello_deadline_us{0};
std::atomic<size_t> s_callback_queued{0};
std::atomic<uint32_t> s_callback_generation{0};
std::atomic<bool> s_callbacks_active{false};

uint8_t s_rx_control_sequence = 0;
uint32_t s_boot_nonce = 0;
uint32_t s_client_generation = 0;
uint32_t s_bridge_retry_ms = kReconnectBaseMs;
bool s_mdns_owned = false;
std::mutex s_lifecycle_mtx;
std::string s_mac12;
std::string s_device_id;
std::string s_hello_message_id;

esp_timer_handle_t s_reconnect_timer = nullptr;
esp_timer_handle_t s_teardown_timer  = nullptr;

void StartProvisioning();

// NVS credential store
esp_err_t EnsureNvs() {
    esp_err_t r = nvs_flash_init();
    if (r == ESP_ERR_NVS_NO_FREE_PAGES || r == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        (void)nvs_flash_erase();
        r = nvs_flash_init();
    }
    return r;
}

void LoadStoredSettings(al_prov_settings_t& settings) {
    settings = {};
    nvs_handle_t h;
    if (nvs_open(kNvsNs, NVS_READONLY, &h) != ESP_OK) return;
    struct Field { const char* key; char* value; size_t capacity; };
    const Field fields[] = {
        {kNvsSsid, settings.ssid, sizeof settings.ssid},
        {kNvsPass, settings.password, sizeof settings.password},
        {kNvsEndpoint, settings.endpoint, sizeof settings.endpoint},
        {kNvsDeviceToken, settings.device_token, sizeof settings.device_token},
    };
    for (const auto& field : fields) {
        size_t size = field.capacity;
        if (nvs_get_str(h, field.key, field.value, &size) != ESP_OK) field.value[0] = '\0';
    }
    nvs_close(h);
}

bool SaveSettings() {
    nvs_handle_t h;
    if (nvs_open(kNvsNs, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGW(TAG, "nvs open failed; settings not saved");
        return false;
    }
    esp_err_t r = nvs_set_str(h, kNvsSsid, s_ssid);
    if (r == ESP_OK) r = nvs_set_str(h, kNvsPass, s_pass);
    if (r == ESP_OK) r = nvs_set_str(h, kNvsEndpoint, s_endpoint);
    if (r == ESP_OK) r = nvs_set_str(h, kNvsDeviceToken, s_device_token);
    if (r == ESP_OK) r = nvs_commit(h);  // exactly one commit for the complete settings set
    nvs_close(h);
    if (r != ESP_OK) ESP_LOGW(TAG, "nvs settings commit failed: %s", esp_err_to_name(r));
    return r == ESP_OK;
}

bool CopyPreferred(char* dst, size_t capacity, const char* explicit_value, const char* stored_value) {
    const char* src = (explicit_value && explicit_value[0]) ? explicit_value : stored_value;
    if (!src) src = "";
    const size_t len = strnlen(src, capacity);
    if (len >= capacity) { dst[0] = '\0'; return false; }
    memcpy(dst, src, len + 1);
    return true;
}

bool BuildEffectiveSettings(al_prov_settings_t& settings) {
    al_prov_settings_t stored = {};
    LoadStoredSettings(stored);
    const bool sizes_ok =
        CopyPreferred(settings.ssid, sizeof settings.ssid, s_cfg ? s_cfg->ssid : nullptr, stored.ssid) &&
        CopyPreferred(settings.password, sizeof settings.password, s_cfg ? s_cfg->password : nullptr, stored.password) &&
        CopyPreferred(settings.endpoint, sizeof settings.endpoint, s_cfg ? s_cfg->endpoint : nullptr, stored.endpoint) &&
        CopyPreferred(settings.device_token, sizeof settings.device_token, s_cfg ? s_cfg->token : nullptr, stored.device_token);
    return sizes_ok && settings.ssid[0] && al_wifi_endpoint_valid(settings.endpoint) &&
           al_wifi_device_token_valid(settings.device_token);
}

//  Helpers 
// Returns a short machine code (not prose) so the portal page can localize it — see connecting.html.
const char* ReasonStr(uint8_t reason) {
    switch (reason) {
    case WIFI_REASON_NO_AP_FOUND:              return "notfound";
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:   return "badpass";
    default:                                   return "fail";
    }
}

void BuildApSsid() {
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    snprintf(s_ap_ssid, sizeof s_ap_ssid, "%s-%02X%02X", s_name, mac[4], mac[5]);
}

void ApplyStaConfig(const char* ssid, const char* pass) {
    wifi_config_t wc = {};
    strncpy(reinterpret_cast<char*>(wc.sta.ssid), ssid, sizeof(wc.sta.ssid) - 1);
    if (pass) strncpy(reinterpret_cast<char*>(wc.sta.password), pass, sizeof(wc.sta.password) - 1);
    wc.sta.pmf_cfg.capable = true;   // allow WPA3/PMF APs
    esp_wifi_set_config(WIFI_IF_STA, &wc);
}

void ApplyApConfig() {
    wifi_config_t wc = {};
    strncpy(reinterpret_cast<char*>(wc.ap.ssid), s_ap_ssid, sizeof(wc.ap.ssid) - 1);
    wc.ap.ssid_len       = strlen(s_ap_ssid);
    wc.ap.channel        = 1;
    wc.ap.max_connection = 4;
    wc.ap.authmode       = WIFI_AUTH_OPEN;   // open network
    wc.ap.beacon_interval = 100;
    esp_wifi_set_config(WIFI_IF_AP, &wc);
}

void ScheduleReconnect(uint32_t ms) {
    if (!s_reconnect_timer) return;
    esp_timer_stop(s_reconnect_timer);                 // harmless if not running
    esp_timer_start_once(s_reconnect_timer, static_cast<uint64_t>(ms) * 1000);
}

void ReconnectCb(void*) {
    if (s_want_connect) esp_wifi_connect();
}

// Fired ~kProvTeardownMs after a successful provisioning join: close the portal and drop the AP.
void TeardownProvCb(void*) {
    al_wifi_prov_stop();
    esp_wifi_set_mode(WIFI_MODE_STA);
    ESP_LOGI(TAG, "provisioning portal closed; SoftAP down");
}

class TxLockGuard {
public:
    TxLockGuard() : locked_(s_tx_lock && xSemaphoreTake(s_tx_lock, portMAX_DELAY) == pdTRUE) {}
    ~TxLockGuard() { if (locked_) xSemaphoreGive(s_tx_lock); }
    bool locked() const { return locked_; }
private:
    bool locked_;
};

class PublicCallGuard {
public:
    PublicCallGuard() : entered_(s_public_calls.TryEnter()) {}
    ~PublicCallGuard() { if (entered_) s_public_calls.Exit(); }
    bool entered() const { return entered_; }
private:
    bool entered_;
};

class CallbackCallGuard {
public:
    CallbackCallGuard() : entered_(s_callback_calls.TryEnter()) {}
    ~CallbackCallGuard() { if (entered_) s_callback_calls.Exit(); }
    bool entered() const { return entered_; }
private:
    bool entered_;
};

bool TryLifecycleMutex(void*) {
    return s_lifecycle_mtx.try_lock();
}

bool LifecycleStopInProgress(void*) {
    return s_stopping.load(std::memory_order_acquire);
}

void SignalWs(EventBits_t bits) {
    if (s_ws_events != nullptr) xEventGroupSetBits(s_ws_events, bits);
}

void CloseAdmissionAndResetStreams() {
    s_accepting.store(false);
    if (s_tx_lock == nullptr) return;
    TxLockGuard lock;
    if (!lock.locked()) return;
    s_uplink.ResetAll();
}

void MarkConnectionUnusable() {
    s_accepting.store(false);
    s_ws_authenticated.store(false);
    s_ws_connected.store(false);
    s_hello_deadline_us.store(0);
    if (!s_stopping.load() && !s_destroying_client.load()) SignalWs(kWsRecycle);
}

void DrainTxQueue() {
    if (s_tx_queue == nullptr) return;
    TxItem* item = nullptr;
    while (xQueueReceive(s_tx_queue, &item, 0) == pdTRUE) {
        if (item != nullptr) {
            {
                TxLockGuard lock;
                if (lock.locked()) s_tx_policy.Release(item->tx_class, item->payload.size());
            }
            delete item;
        }
    }
    {
        TxLockGuard lock;
        if (lock.locked()) {
            s_tx_policy.Reset();
            s_uplink.ResetAll();
        }
    }
    if (s_tx_space != nullptr) xSemaphoreGive(s_tx_space);
}

void DrainRxQueue() {
    if (s_rx_queue == nullptr) return;
    RxItem* item = nullptr;
    while (xQueueReceive(s_rx_queue, &item, 0) == pdTRUE) delete item;
}

void CallbackWorker(void*) {
    while (true) {
        CallbackItem* item = nullptr;
        if (xQueueReceive(s_callback_queue, &item, portMAX_DELAY) != pdTRUE || item == nullptr) {
            continue;
        }
        if (item->counted) s_callback_queued.fetch_sub(1, std::memory_order_acq_rel);
        CallbackCallGuard callback;
        if (!callback.entered()) {
            delete item;
            continue;
        }
        const bool current = item->generation ==
                             s_callback_generation.load(std::memory_order_acquire);
        const bool deliver = current &&
                             (s_callbacks_active.load(std::memory_order_acquire) ||
                              (item->kind == CallbackKind::kConnection && !item->connected));
        if (!deliver) {
            delete item;
            continue;
        }
        switch (item->kind) {
        case CallbackKind::kConnection:
            if (s_on_conn != nullptr) s_on_conn(item->connected);
            break;
        case CallbackKind::kControl:
            if (s_on_recv != nullptr) s_on_recv(item->payload.data(), item->payload.size());
            break;
        case CallbackKind::kStream:
            if (s_on_stream != nullptr) {
                s_on_stream(item->stream, item->payload.data(), item->payload.size());
            }
            break;
        }
        delete item;
    }
}

bool InitializeCallbackWorker() {
    if (s_callback_worker != nullptr) return true;
    if (s_callback_queue == nullptr) {
        s_callback_queue = xQueueCreate(kCallbackItemCapacity, sizeof(CallbackItem*));
        if (s_callback_queue == nullptr) return false;
    }
    if (xTaskCreate(&CallbackWorker, "al_ws_callback", 8192, nullptr, 5,
                    &s_callback_worker) == pdPASS) {
        return true;
    }
    vQueueDelete(s_callback_queue);
    s_callback_queue = nullptr;
    return false;
}

bool QueueCallback(CallbackItem* item, bool reserve_disconnect_slot = true) {
    if (item == nullptr || s_callback_queue == nullptr) {
        delete item;
        return false;
    }
    if (reserve_disconnect_slot) {
        size_t queued = s_callback_queued.load(std::memory_order_acquire);
        do {
            if (queued >= kCallbackItemCapacity - 1) {
                delete item;
                return false;
            }
        } while (!s_callback_queued.compare_exchange_weak(
            queued, queued + 1, std::memory_order_acq_rel, std::memory_order_acquire));
        item->counted = true;
    }
    if (xQueueSend(s_callback_queue, &item, 0) == pdTRUE) return true;
    if (item->counted) s_callback_queued.fetch_sub(1, std::memory_order_acq_rel);
    delete item;
    return false;
}

bool QueueConnectionCallback(bool connected) {
    if (s_on_conn == nullptr) return true;
    auto* item = new (std::nothrow) CallbackItem;
    if (item == nullptr) return false;
    item->kind = CallbackKind::kConnection;
    item->connected = connected;
    item->generation = s_callback_generation.load(std::memory_order_acquire);
    return QueueCallback(item, connected);
}

bool QueueDataCallback(CallbackKind kind, agent_stream_t stream,
                       const uint8_t* data, size_t len) {
    auto* item = new (std::nothrow) CallbackItem;
    if (item == nullptr) return false;
    item->kind = kind;
    item->stream = stream;
    item->generation = s_callback_generation.load(std::memory_order_acquire);
    if (len > 0) item->payload.assign(data, data + len);
    return QueueCallback(item);
}

void PublishDisconnected() {
    if (s_ready_announced.exchange(false) && !QueueConnectionCallback(false)) {
        ESP_LOGE(TAG, "could not enqueue disconnect callback");
    }
}

bool IsHelloAckMessage(const uint8_t* data, size_t len) {
    if (data == nullptr || len == 0) return false;
    cJSON* root = cJSON_ParseWithLength(reinterpret_cast<const char*>(data), len);
    cJSON* type = root ? cJSON_GetObjectItemCaseSensitive(root, "type") : nullptr;
    const bool is_ack = cJSON_IsString(type) && type->valuestring != nullptr &&
                        strcmp(type->valuestring, "hello.ack") == 0;
    cJSON_Delete(root);
    return is_ack;
}

void TrackAudioMarker(const uint8_t* data, size_t len) {
    cJSON* root = cJSON_ParseWithLength(reinterpret_cast<const char*>(data), len);
    cJSON* type = root ? cJSON_GetObjectItemCaseSensitive(root, "type") : nullptr;
    if (cJSON_IsString(type) && type->valuestring != nullptr) {
        if (strcmp(type->valuestring, "audio.start") == 0) s_voice_rx.OnAudioStart();
        else if (strcmp(type->valuestring, "audio.end") == 0) s_voice_rx.OnAudioEnd();
    }
    cJSON_Delete(root);
}

void DispatchText(const uint8_t* data, size_t len) {
    if (IsHelloAckMessage(data, len)) {
        if (!s_ws_authenticated.load() &&
            xiaoli::wifi::IsMatchingHelloAck(data, len, s_hello_message_id, s_device_id)) {
            s_ws_authenticated.store(true);
            s_hello_deadline_us.store(0);
            s_accepting.store(true);
            SignalWs(kWsAuthenticated);
        }
        return;
    }
    if (!s_ws_authenticated.load()) return;
    TrackAudioMarker(data, len);
    std::vector<uint8_t> command = agentlink::BuildCommand(
        0x7e, s_rx_control_sequence, data, len);
    if (command.empty()) return;
    ++s_rx_control_sequence;
    if (s_on_recv != nullptr &&
        !QueueDataCallback(CallbackKind::kControl, AGENT_STREAM_VOICE,
                           command.data(), command.size())) {
        MarkConnectionUnusable();
    }
}

void DispatchBinary(const uint8_t* data, size_t len) {
    if (!s_ws_authenticated.load()) return;
    xiaoli::WireFrame frame{};
    if (!xiaoli::DecodeWireFrame(data, len, frame)) {
        s_voice_rx.Reset();
        return;
    }
    if (frame.kind == xiaoli::WireKind::kControl) {
        if (s_on_recv != nullptr &&
            !QueueDataCallback(CallbackKind::kControl, AGENT_STREAM_VOICE,
                               frame.payload, frame.payload_len)) {
            MarkConnectionUnusable();
        }
        return;
    }
    if (frame.kind == xiaoli::WireKind::kStreamChunk) {
        if (!s_voice_rx.AcceptChunk(static_cast<agent_stream_t>(frame.stream_type),
                                    frame.flags, frame.sequence, frame.payload_len)) {
            s_voice_rx.Reset();
            return;
        }
        if (s_on_stream != nullptr &&
            !QueueDataCallback(CallbackKind::kStream, AGENT_STREAM_VOICE,
                               frame.payload, frame.payload_len)) {
            MarkConnectionUnusable();
        }
        return;
    }
    if (frame.kind == xiaoli::WireKind::kStreamEnd) {
        if (!s_voice_rx.AcceptEnd(frame.sequence, (frame.flags & 1) != 0) ||
            frame.stream_type != AGENT_STREAM_VOICE || (frame.flags & ~1U) != 0) {
            s_voice_rx.Reset();
            return;
        }
        const uint8_t status[] = {0, 0, 0, 0, 3};
        const std::vector<uint8_t> command = agentlink::BuildCommand(
            0x05, static_cast<uint8_t>(frame.sequence), status, sizeof(status));
        if (!command.empty() && s_on_recv != nullptr &&
            !QueueDataCallback(CallbackKind::kControl, AGENT_STREAM_VOICE,
                               command.data(), command.size())) {
            MarkConnectionUnusable();
        }
        return;
    }
    s_voice_rx.Reset();
}

void OnWsData(const esp_websocket_event_data_t& event) {
    if (event.data_len < 0 || event.payload_len < 0 || event.payload_offset < 0) {
        s_fragments.Reset();
        return;
    }
    if (event.op_code == 0x8 || event.op_code == 0x9 || event.op_code == 0xa) return;
    xiaoli::wifi::CompleteMessage complete;
    const auto result = s_fragments.Append(
        event.op_code, event.fin, static_cast<size_t>(event.payload_len),
        static_cast<size_t>(event.payload_offset),
        reinterpret_cast<const uint8_t*>(event.data_ptr),
        static_cast<size_t>(event.data_len), complete);
    if (result != xiaoli::wifi::FragmentResult::kComplete) return;
    RxItem* item = new (std::nothrow) RxItem{
        complete.text, std::move(complete.payload)};
    if (item == nullptr || xQueueSend(s_rx_queue, &item, 0) != pdTRUE) {
        delete item;
        MarkConnectionUnusable();
        return;
    }
    SignalWs(kWsRxReady);
}

void WebSocketEvent(void*, esp_event_base_t, int32_t id, void* data) {
    auto* event = static_cast<esp_websocket_event_data_t*>(data);
    if (event == nullptr || s_stopping.load() || s_destroying_client.load()) return;
    switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
        s_ws_connected.store(true);
        s_ws_authenticated.store(false);
        s_accepting.store(false);
        SignalWs(kWsConnected);
        break;
    case WEBSOCKET_EVENT_DATA:
        OnWsData(*event);
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED:
    case WEBSOCKET_EVENT_ERROR:
        MarkConnectionUnusable();
        break;
    default:
        break;
    }
}

esp_err_t MdnsResolve(const char* host, uint32_t timeout_ms, uint32_t* ipv4_be, void*) {
    if (host == nullptr || ipv4_be == nullptr) return ESP_ERR_INVALID_ARG;
    esp_ip4_addr_t address{};
    esp_err_t result = mdns_query_a(host, timeout_ms, &address);
    if (result == ESP_OK) *ipv4_be = lwip_ntohl(address.addr);
    return result;
}

esp_err_t MdnsInit(void*) {
    return mdns_init();
}

esp_err_t ResolveConfiguredEndpoint(std::string& resolved) {
    std::string endpoint;
    {
        std::lock_guard<std::mutex> lock(s_cred_mtx);
        endpoint = s_endpoint;
    }
    return xiaoli::wifi::ResolveEndpointWithMdnsOwnership(
        endpoint.c_str(), &MdnsResolve, &MdnsInit, nullptr, s_mdns_owned, resolved);
}

bool BuildIdentity() {
    uint8_t mac[6] = {};
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK) return false;
    char mac12[13] = {};
    snprintf(mac12, sizeof(mac12), "%02x%02x%02x%02x%02x%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    s_mac12 = mac12;
    s_device_id = "xiaoli-" + s_mac12;
    return true;
}

esp_err_t SendHello() {
    std::string token;
    {
        std::lock_guard<std::mutex> lock(s_cred_mtx);
        token = s_device_token;
    }
    char nonce[9] = {};
    snprintf(nonce, sizeof(nonce), "%08lx", static_cast<unsigned long>(s_boot_nonce));
    xiaoli::wifi::HelloIdentity identity{
        s_mac12, nonce, s_client_generation, esp_app_get_description()->version, token};
    std::string json;
    std::string message_id;
    std::string device_id;
    const bool built = xiaoli::wifi::BuildHelloJson(
        identity, json, message_id, device_id);
    std::fill(token.begin(), token.end(), '\0');
    if (!built || device_id != s_device_id ||
        (!s_hello_message_id.empty() && message_id != s_hello_message_id)) {
        std::fill(json.begin(), json.end(), '\0');
        return ESP_FAIL;
    }
    s_hello_message_id = message_id;
    const int sent = esp_websocket_client_send_text(
        s_ws_client, json.data(), static_cast<int>(json.size()), pdMS_TO_TICKS(10000));
    const bool complete = sent == static_cast<int>(json.size());
    std::fill(json.begin(), json.end(), '\0');
    if (!complete) return ESP_FAIL;
    s_hello_deadline_us.store(esp_timer_get_time() +
                              static_cast<int64_t>(kHelloAckTimeoutMs) * 1000);
    return ESP_OK;
}

esp_err_t CreateWebSocketClient() {
    std::string uri;
    esp_err_t result = ResolveConfiguredEndpoint(uri);
    if (result != ESP_OK) {
        ESP_LOGW(TAG, "Bridge resolution failed: %s", esp_err_to_name(result));
        return result;
    }
    ++s_client_generation;
    s_hello_message_id.clear();
    esp_websocket_client_config_t config = {};
    config.uri = uri.c_str();
    config.network_timeout_ms = 10000;
    config.reconnect_timeout_ms = 2000;
    config.disable_auto_reconnect = false;
    config.enable_close_reconnect = true;
    config.task_stack = 8192;
    config.buffer_size = 4096;
    config.ping_interval_sec = 10;
    config.pingpong_timeout_sec = 20;
    s_ws_client = esp_websocket_client_init(&config);
    if (s_ws_client == nullptr) return ESP_ERR_NO_MEM;
    result = esp_websocket_register_events(
        s_ws_client, WEBSOCKET_EVENT_ANY, &WebSocketEvent, nullptr);
    if (result == ESP_OK) result = esp_websocket_client_start(s_ws_client);
    if (result != ESP_OK) {
        s_destroying_client.store(true);
        esp_websocket_client_destroy(s_ws_client);
        s_ws_client = nullptr;
        s_destroying_client.store(false);
    } else {
        ESP_LOGI(TAG, "Bridge WebSocket client started");
    }
    return result;
}

void DestroyWebSocketClient() {
    if (s_ws_client == nullptr) return;
    s_destroying_client.store(true);
    (void)esp_websocket_client_stop(s_ws_client);
    (void)esp_websocket_client_destroy(s_ws_client);
    s_ws_client = nullptr;
    s_destroying_client.store(false);
    s_ws_connected.store(false);
    s_ws_authenticated.store(false);
    s_accepting.store(false);
    s_hello_deadline_us.store(0);
    s_fragments.Reset();
    s_voice_rx.Reset();
    if (s_ws_events != nullptr) {
        xEventGroupClearBits(s_ws_events,
                             kWsConnected | kWsAuthenticated | kWsRecycle |
                             kWsTxReady | kWsRxReady);
    }
}

void DrainReceive() {
    RxItem* item = nullptr;
    while (xQueueReceive(s_rx_queue, &item, 0) == pdTRUE) {
        if (item != nullptr) {
            if (item->text) DispatchText(item->payload.data(), item->payload.size());
            else DispatchBinary(item->payload.data(), item->payload.size());
            delete item;
        }
    }
}

void DrainTransmit() {
    while (s_ws_authenticated.load() && s_ws_client != nullptr) {
        TxItem* item = nullptr;
        if (xQueueReceive(s_tx_queue, &item, 0) != pdTRUE) return;
        if (item == nullptr) continue;
        int sent = -1;
        if (item->text) {
            sent = esp_websocket_client_send_text(
                s_ws_client, reinterpret_cast<const char*>(item->payload.data()),
                static_cast<int>(item->payload.size()), pdMS_TO_TICKS(10000));
        } else {
            sent = esp_websocket_client_send_bin(
                s_ws_client, reinterpret_cast<const char*>(item->payload.data()),
                static_cast<int>(item->payload.size()), pdMS_TO_TICKS(10000));
        }
        const bool sent_all = sent == static_cast<int>(item->payload.size());
        {
            TxLockGuard lock;
            if (lock.locked()) s_tx_policy.Release(item->tx_class, item->payload.size());
        }
        delete item;
        if (s_tx_space != nullptr) xSemaphoreGive(s_tx_space);
        if (!sent_all) {
            MarkConnectionUnusable();
            return;
        }
    }
}

bool WaitRetry(uint32_t delay_ms) {
    const EventBits_t bits = xEventGroupWaitBits(
        s_ws_events, kWsStop | kWsGotIp, pdTRUE, pdFALSE, pdMS_TO_TICKS(delay_ms));
    return (bits & kWsStop) == 0 && !s_stopping.load();
}

void WebSocketWorker(void*) {
    while (!s_stopping.load()) {
        const EventBits_t bits = xEventGroupWaitBits(
            s_ws_events, kWsGotIp | kWsConnected | kWsAuthenticated |
                         kWsRecycle | kWsTxReady | kWsRxReady | kWsStop,
            pdTRUE, pdFALSE, pdMS_TO_TICKS(kWorkerPollMs));
        if ((bits & kWsStop) != 0 || s_stopping.load()) break;

        if ((bits & kWsRecycle) != 0) {
            CloseAdmissionAndResetStreams();
            PublishDisconnected();
            DestroyWebSocketClient();
            DrainTxQueue();
            DrainRxQueue();
            if (s_got_ip.load()) {
                const uint32_t delay = s_bridge_retry_ms;
                s_bridge_retry_ms = std::min(s_bridge_retry_ms * 2, kBridgeRetryMaxMs);
                if (!WaitRetry(delay)) break;
            }
        }

        if (s_ws_client == nullptr && s_got_ip.load()) {
            esp_err_t result = CreateWebSocketClient();
            if (result != ESP_OK) {
                const uint32_t delay = s_bridge_retry_ms;
                s_bridge_retry_ms = std::min(s_bridge_retry_ms * 2, kBridgeRetryMaxMs);
                if (!WaitRetry(delay)) break;
                continue;
            }
        }

        if ((bits & kWsConnected) != 0 && s_ws_connected.load()) {
            if (SendHello() != ESP_OK) MarkConnectionUnusable();
        }

        if ((bits & kWsAuthenticated) != 0 && s_ws_authenticated.load() &&
            s_got_ip.load() && s_ws_connected.load()) {
            s_accepting.store(true);
            s_bridge_retry_ms = kReconnectBaseMs;
            if (!s_ready_announced.exchange(true) && !QueueConnectionCallback(true)) {
                ESP_LOGE(TAG, "could not enqueue ready callback");
                MarkConnectionUnusable();
            }
        }

        if ((bits & kWsTxReady) != 0) DrainTransmit();
        if ((bits & kWsRxReady) != 0) DrainReceive();

        const int64_t deadline = s_hello_deadline_us.load();
        if (deadline != 0 && esp_timer_get_time() >= deadline &&
            !s_ws_authenticated.load()) {
            ESP_LOGW(TAG, "Bridge hello acknowledgment timed out");
            MarkConnectionUnusable();
        }
    }
    CloseAdmissionAndResetStreams();
    PublishDisconnected();
    DestroyWebSocketClient();
    DrainTxQueue();
    DrainRxQueue();
    s_ws_worker = nullptr;
    if (s_worker_done != nullptr) xSemaphoreGive(s_worker_done);
    vTaskDelete(nullptr);
}

bool TryQueueLocked(TxItem* item) {
    if (item == nullptr || !s_accepting.load() || !s_ws_authenticated.load() ||
        !s_tx_policy.Admit(item->tx_class, item->payload.size())) {
        return false;
    }
    if (xQueueSend(s_tx_queue, &item, 0) != pdTRUE) {
        s_tx_policy.Release(item->tx_class, item->payload.size());
        return false;
    }
    SignalWs(kWsTxReady);
    return true;
}

esp_err_t QueueReserved(xiaoli::wifi::OutboundMessage&& message) {
    TxItem* item = new (std::nothrow) TxItem{
        message.text, xiaoli::wifi::TxClass::kReserved, std::move(message.payload)};
    if (item == nullptr) return ESP_ERR_NO_MEM;
    const TickType_t start = xTaskGetTickCount();
    const TickType_t wait_ticks = pdMS_TO_TICKS(xiaoli::wifi::kReservedAdmissionWaitMs);
    while (true) {
        {
            TxLockGuard lock;
            if (!lock.locked() || !s_accepting.load()) {
                delete item;
                return ESP_ERR_INVALID_STATE;
            }
            if (TryQueueLocked(item)) return ESP_OK;
        }
        const TickType_t elapsed = xTaskGetTickCount() - start;
        if (elapsed >= wait_ticks) {
            delete item;
            return ESP_ERR_TIMEOUT;
        }
        (void)xSemaphoreTake(s_tx_space, wait_ticks - elapsed);
    }
}

bool InitializeWebSocketWorker() {
    if (s_ws_worker != nullptr) return true;
    if (!InitializeCallbackWorker()) return false;
    s_tx_queue = xQueueCreate(xiaoli::wifi::kTxItemCapacity, sizeof(TxItem*));
    s_rx_queue = xQueueCreate(kRxItemCapacity, sizeof(RxItem*));
    s_tx_lock = xSemaphoreCreateMutex();
    s_tx_space = xSemaphoreCreateBinary();
    s_worker_done = xSemaphoreCreateBinary();
    s_ws_events = xEventGroupCreate();
    if (s_tx_queue == nullptr || s_rx_queue == nullptr || s_tx_lock == nullptr ||
        s_tx_space == nullptr ||
        s_worker_done == nullptr || s_ws_events == nullptr) {
        return false;
    }
    s_stopping.store(false);
    s_boot_nonce = esp_random();
    s_client_generation = 0;
    s_bridge_retry_ms = kReconnectBaseMs;
    s_rx_control_sequence = 0;
    if (!BuildIdentity()) return false;
    return xTaskCreate(&WebSocketWorker, "al_ws_lifecycle", 8192, nullptr, 5,
                       &s_ws_worker) == pdPASS;
}

void DeleteWebSocketWorkerResources() {
    if (s_tx_queue) { vQueueDelete(s_tx_queue); s_tx_queue = nullptr; }
    if (s_rx_queue) { vQueueDelete(s_rx_queue); s_rx_queue = nullptr; }
    if (s_tx_lock) { vSemaphoreDelete(s_tx_lock); s_tx_lock = nullptr; }
    if (s_tx_space) { vSemaphoreDelete(s_tx_space); s_tx_space = nullptr; }
    if (s_worker_done) { vSemaphoreDelete(s_worker_done); s_worker_done = nullptr; }
    if (s_ws_events) { vEventGroupDelete(s_ws_events); s_ws_events = nullptr; }
}

// Station reached the network
void OnGotIp(const esp_netif_ip_info_t& ip) {
    char ip_str[16];
    esp_ip4addr_ntoa(&ip.ip, ip_str, sizeof ip_str);
    s_ever_got_ip = true;
    s_retry = 0;

    if (s_phase == Phase::kProvisioning) {
        // First successful join from the portal: persist all settings in one commit now.
        std::lock_guard<std::mutex> lk(s_cred_mtx);
        const bool saved = SaveSettings();
        al_wifi_prov_set_status(AL_PROV_CONNECTED, ip_str, nullptr);
        ESP_LOGI(TAG, "provisioning succeeded: joined '%s', ip=%s (settings %s)",
                 s_ssid, ip_str, saved ? "saved" : "not saved");
        if (s_teardown_timer) esp_timer_start_once(s_teardown_timer, static_cast<uint64_t>(kProvTeardownMs) * 1000);
    } else {
        ESP_LOGI(TAG, "WiFi connected: ip=%s", ip_str);
    }
    s_phase = Phase::kStaConnected;
    s_got_ip.store(true);
    SignalWs(kWsGotIp);
}

void OnStaDisconnected(uint8_t reason) {
    s_got_ip.store(false);
    MarkConnectionUnusable();
    if (s_phase == Phase::kProvisioning) {
        // A join attempt during provisioning failed,retry a couple times, then tell the page.
        if (++s_retry >= kProvFailLimit) {
            s_want_connect = false;                    // stop hammering; wait for a fresh submit from the page
            al_wifi_prov_set_status(AL_PROV_FAILED, nullptr, ReasonStr(reason));
            ESP_LOGW(TAG, "provisioning join failed (reason=%d) after %d tries — awaiting retry", reason, s_retry);
        } else {
            ESP_LOGD(TAG, "provisioning join retry %d (reason=%d)", s_retry, reason);
            ScheduleReconnect(1500);
        }
        return;
    }

    // Normal station path
    s_phase = Phase::kStaConnecting;
    if (!s_ever_got_ip && ++s_retry >= kBootFailLimit) {
        ESP_LOGW(TAG, "cannot join '%s' after %d tries — starting provisioning portal", s_ssid, s_retry);
        StartProvisioning();
        return;
    }
    uint32_t backoff = kReconnectBaseMs << (s_retry < 4 ? s_retry : 4);
    if (backoff > kReconnectMaxMs) backoff = kReconnectMaxMs;
    ESP_LOGD(TAG, "station disconnected (reason=%d) — reconnect in %ums", reason, static_cast<unsigned>(backoff));
    ScheduleReconnect(backoff);
}

void WifiEvent(void*, esp_event_base_t base, int32_t id, void* data) {
    if (base != WIFI_EVENT) return;
    switch (id) {
    case WIFI_EVENT_STA_START:
        if (s_want_connect) esp_wifi_connect();
        break;
    case WIFI_EVENT_STA_CONNECTED:
        ESP_LOGD(TAG, "station associated — awaiting IP");
        break;
    case WIFI_EVENT_STA_DISCONNECTED:
        OnStaDisconnected(static_cast<const wifi_event_sta_disconnected_t*>(data)->reason);
        break;
    case WIFI_EVENT_AP_STACONNECTED:
        ESP_LOGD(TAG, "portal: a client joined the SoftAP");
        break;
    case WIFI_EVENT_AP_STADISCONNECTED:
        ESP_LOGD(TAG, "portal: a client left the SoftAP");
        break;
    default:
        break;
    }
}

void IpEvent(void*, esp_event_base_t base, int32_t id, void* data) {
    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        OnGotIp(static_cast<const ip_event_got_ip_t*>(data)->ip_info);
    }
}

// One-time WiFi stack bring-up: netif + event loop + default STA/AP interfaces + driver + handlers.
esp_err_t WifiInitOnce() {
    if (s_wifi_inited) return ESP_OK;

    esp_err_t r = EnsureNvs();
    if (r != ESP_OK) { ESP_LOGE(TAG, "nvs init: %s", esp_err_to_name(r)); return r; }

    r = esp_netif_init();
    if (r != ESP_OK) { ESP_LOGE(TAG, "netif init: %s", esp_err_to_name(r)); return r; }

    r = esp_event_loop_create_default();
    if (r != ESP_OK && r != ESP_ERR_INVALID_STATE) { ESP_LOGE(TAG, "event loop: %s", esp_err_to_name(r)); return r; }

    esp_netif_create_default_wifi_sta();
    esp_netif_create_default_wifi_ap();

    wifi_init_config_t ic = WIFI_INIT_CONFIG_DEFAULT();
    r = esp_wifi_init(&ic);
    if (r != ESP_OK) { ESP_LOGE(TAG, "wifi init: %s", esp_err_to_name(r)); return r; }

    esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &WifiEvent, nullptr, nullptr);
    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &IpEvent, nullptr, nullptr);

    esp_wifi_set_storage(WIFI_STORAGE_RAM);   // we manage credential persistence ourselves (kNvsNs)

    const esp_timer_create_args_t rc = { .callback = &ReconnectCb,   .arg = nullptr, .dispatch_method = ESP_TIMER_TASK, .name = "al_wifi_reconn", .skip_unhandled_events = true };
    esp_timer_create(&rc, &s_reconnect_timer);
    const esp_timer_create_args_t tc = { .callback = &TeardownProvCb, .arg = nullptr, .dispatch_method = ESP_TIMER_TASK, .name = "al_wifi_teardown", .skip_unhandled_events = true };
    esp_timer_create(&tc, &s_teardown_timer);

    BuildApSsid();
    s_wifi_inited = true;
    return ESP_OK;
}

// Join a network as a station (boot path with known credentials).
void StartSta(const al_prov_settings_t& settings) {
    {
        std::lock_guard<std::mutex> lk(s_cred_mtx);
        memcpy(s_ssid, settings.ssid, sizeof s_ssid);
        memcpy(s_pass, settings.password, sizeof s_pass);
        memcpy(s_endpoint, settings.endpoint, sizeof s_endpoint);
        memcpy(s_device_token, settings.device_token, sizeof s_device_token);
    }
    s_phase = Phase::kStaConnecting;
    s_want_connect = true;
    s_retry = 0;
    esp_wifi_set_mode(WIFI_MODE_STA);
    ApplyStaConfig(s_ssid, s_pass);
    if (!s_started) { esp_wifi_start(); s_started = true; }   // STA_START -> connect
    else            { esp_wifi_connect(); }
    ESP_LOGI(TAG, "joining WiFi '%s'…", s_ssid);
}

// The user submitted complete settings on the portal. Copy them before returning.
void OnProvSettings(const al_prov_settings_t* settings) {
    if (!settings || !settings->ssid[0] || !al_wifi_endpoint_valid(settings->endpoint) ||
        !al_wifi_device_token_valid(settings->device_token)) return;
    {
        std::lock_guard<std::mutex> lk(s_cred_mtx);
        memcpy(s_ssid, settings->ssid, sizeof s_ssid);
        memcpy(s_pass, settings->password, sizeof s_pass);
        memcpy(s_endpoint, settings->endpoint, sizeof s_endpoint);
        memcpy(s_device_token, settings->device_token, sizeof s_device_token);
    }
    s_retry = 0;
    s_want_connect = true;
    al_wifi_prov_set_status(AL_PROV_CONNECTING, nullptr, nullptr);
    ApplyStaConfig(s_ssid, s_pass);
    esp_wifi_disconnect();   // drop any half-open attempt, then connect with the new creds
    esp_wifi_connect();
}

// Bring up the SoftAP + captive portal and wait for the user to enter their WiFi
void StartProvisioning() {
    s_want_connect = false;
    s_retry = 0;
    s_phase = Phase::kProvisioning;
    if (s_teardown_timer) esp_timer_stop(s_teardown_timer);

    if (s_started) esp_wifi_disconnect();
    esp_wifi_set_mode(WIFI_MODE_APSTA);   // AP for the portal, STA idle so the page can scan + then join
    ApplyApConfig();
    if (!s_started) { esp_wifi_start(); s_started = true; }
    al_wifi_prov_start(s_ap_ssid, &OnProvSettings);
}

// agent_transport_t interface
esp_err_t wifi_start(void* /*impl*/) {
    if (xTaskGetCurrentTaskHandle() == s_callback_worker) return ESP_ERR_INVALID_STATE;
    std::lock_guard<std::mutex> lifecycle(s_lifecycle_mtx);
    if (!s_callback_calls.Open()) return ESP_ERR_INVALID_STATE;
    if (!s_public_calls.Open()) {
        s_callback_calls.Close();
        return ESP_ERR_INVALID_STATE;
    }
    if (!InitializeWebSocketWorker()) {
        s_public_calls.Close();
        s_callback_calls.Close();
        s_stopping.store(true);
        DeleteWebSocketWorkerResources();
        return ESP_ERR_NO_MEM;
    }
    esp_err_t r = WifiInitOnce();
    if (r != ESP_OK) {
        s_public_calls.Close();
        s_callback_calls.Close();
        s_stopping.store(true);
        SignalWs(kWsStop);
        if (s_worker_done) xSemaphoreTake(s_worker_done, pdMS_TO_TICKS(5000));
        DeleteWebSocketWorkerResources();
        return r;
    }
    s_callback_generation.fetch_add(1, std::memory_order_acq_rel);
    s_callbacks_active.store(true, std::memory_order_release);

    al_prov_settings_t settings = {};
    if (BuildEffectiveSettings(settings)) {
        ESP_LOGI(TAG, "using complete WiFi and Bridge settings for '%s'", settings.ssid);
        StartSta(settings);
    } else {
        ESP_LOGI(TAG, "WiFi or Bridge settings missing/invalid; starting captive-portal provisioning");
        StartProvisioning();
    }
    return ESP_OK;
}

void wifi_stop(void* /*impl*/) {
    const bool callback_worker = xTaskGetCurrentTaskHandle() == s_callback_worker;
    std::unique_lock<std::mutex> lifecycle;
    if (callback_worker) {
        while (true) {
            const auto step = xiaoli::wifi::TryCallbackLifecycleLock(
                &TryLifecycleMutex, &LifecycleStopInProgress, nullptr);
            if (step == xiaoli::wifi::CallbackLockStep::kStopInProgress) return;
            if (step == xiaoli::wifi::CallbackLockStep::kAcquired) {
                lifecycle = std::unique_lock<std::mutex>(s_lifecycle_mtx, std::adopt_lock);
                break;
            }
            // Block for one tick so a lower-priority lifecycle owner can run and release.
            vTaskDelay(1);
        }
    } else {
        lifecycle = std::unique_lock<std::mutex>(s_lifecycle_mtx);
    }
    if (s_stopping.exchange(true, std::memory_order_acq_rel)) return;
    s_callback_calls.Close();
    s_public_calls.Close();
    s_callbacks_active.store(false, std::memory_order_release);
    s_accepting.store(false);
    s_got_ip.store(false);
    if (s_reconnect_timer) esp_timer_stop(s_reconnect_timer);
    if (s_teardown_timer)  esp_timer_stop(s_teardown_timer);
    SignalWs(kWsStop);
    if (s_worker_done != nullptr) {
        (void)xSemaphoreTake(s_worker_done, portMAX_DELAY);
    }
    while (s_public_calls.in_flight() != 0) {
        vTaskDelay(1);
    }
    if (!callback_worker) {
        while (s_callback_calls.in_flight() != 0) {
            vTaskDelay(1);
        }
    }
    if (s_mdns_owned) {
        mdns_free();
        s_mdns_owned = false;
    }
    al_wifi_prov_stop();
    s_want_connect = false;
    if (s_started) { esp_wifi_disconnect(); esp_wifi_stop(); s_started = false; }
    s_phase = Phase::kIdle;
    DeleteWebSocketWorkerResources();
}

// Control plane
esp_err_t wifi_send_ctrl(void* /*impl*/, const uint8_t* frame, size_t len) {
    PublicCallGuard call;
    if (!call.entered()) return ESP_ERR_INVALID_STATE;
    if (!s_accepting.load()) return ESP_ERR_INVALID_STATE;
    xiaoli::wifi::OutboundMessage message;
    esp_err_t result = xiaoli::wifi::EncodeControl(frame, len, message);
    if (result != ESP_OK) return result;
    return QueueReserved(std::move(message));
}
esp_err_t wifi_stream_start(void* /*impl*/, agent_stream_t type,
                            const uint8_t* meta, size_t meta_len) {
    PublicCallGuard call;
    if (!call.entered()) return ESP_ERR_INVALID_STATE;
    if (!s_accepting.load()) return ESP_ERR_INVALID_STATE;
    const TickType_t started = xTaskGetTickCount();
    const TickType_t wait_ticks = pdMS_TO_TICKS(xiaoli::wifi::kReservedAdmissionWaitMs);
    while (true) {
        TxLockGuard lock;
        if (!lock.locked() || !s_accepting.load()) return ESP_ERR_INVALID_STATE;
        std::vector<uint8_t> wire;
        esp_err_t result = s_uplink.Start(type, meta, meta_len, wire);
        if (result != ESP_OK) return result;
        TxItem* item = new (std::nothrow) TxItem{
            false, xiaoli::wifi::TxClass::kReserved, std::move(wire)};
        if (item == nullptr) {
            s_uplink.Reset(type);
            return ESP_ERR_NO_MEM;
        }
        if (TryQueueLocked(item)) return ESP_OK;
        s_uplink.Reset(type);
        delete item;
        xSemaphoreGive(s_tx_lock);
        const TickType_t elapsed = xTaskGetTickCount() - started;
        if (elapsed >= wait_ticks) {
            (void)xSemaphoreTake(s_tx_lock, portMAX_DELAY);
            return ESP_ERR_TIMEOUT;
        }
        (void)xSemaphoreTake(s_tx_space, wait_ticks - elapsed);
        (void)xSemaphoreTake(s_tx_lock, portMAX_DELAY);
    }
}
esp_err_t wifi_send_stream(void* /*impl*/, agent_stream_t type,
                           const uint8_t* data, size_t len) {
    PublicCallGuard call;
    if (!call.entered()) return ESP_ERR_INVALID_STATE;
    if (!s_accepting.load()) return ESP_ERR_INVALID_STATE;
    TxLockGuard lock;
    if (!lock.locked() || !s_accepting.load()) return ESP_ERR_INVALID_STATE;
    std::vector<uint8_t> wire;
    esp_err_t result = s_uplink.PrepareChunk(type, data, len, wire);
    if (result != ESP_OK) return result;
    TxItem* item = new (std::nothrow) TxItem{
        false, xiaoli::wifi::TxClass::kAudioChunk, std::move(wire)};
    if (item == nullptr) return ESP_ERR_NO_MEM;
    if (!TryQueueLocked(item)) {
        delete item;
        return s_accepting.load() ? ESP_ERR_TIMEOUT : ESP_ERR_INVALID_STATE;
    }
    s_uplink.CommitChunk(type, len);
    return ESP_OK;
}
esp_err_t wifi_stream_end(void* /*impl*/, agent_stream_t type, bool complete,
                          const uint8_t* meta, size_t meta_len) {
    PublicCallGuard call;
    if (!call.entered()) return ESP_ERR_INVALID_STATE;
    if (!s_accepting.load()) return ESP_ERR_INVALID_STATE;
    const TickType_t started = xTaskGetTickCount();
    const TickType_t wait_ticks = pdMS_TO_TICKS(xiaoli::wifi::kReservedAdmissionWaitMs);
    while (true) {
        TxLockGuard lock;
        if (!lock.locked() || !s_accepting.load()) return ESP_ERR_INVALID_STATE;
        std::vector<uint8_t> wire;
        esp_err_t result = s_uplink.PrepareEnd(type, complete, meta, meta_len, wire);
        if (result != ESP_OK) return result;
        TxItem* item = new (std::nothrow) TxItem{
            false, xiaoli::wifi::TxClass::kReserved, std::move(wire)};
        if (item == nullptr) return ESP_ERR_NO_MEM;
        if (TryQueueLocked(item)) {
            s_uplink.CommitEnd(type);
            return ESP_OK;
        }
        delete item;
        xSemaphoreGive(s_tx_lock);
        const TickType_t elapsed = xTaskGetTickCount() - started;
        if (elapsed >= wait_ticks) {
            (void)xSemaphoreTake(s_tx_lock, portMAX_DELAY);
            return ESP_ERR_TIMEOUT;
        }
        (void)xSemaphoreTake(s_tx_space, wait_ticks - elapsed);
        (void)xSemaphoreTake(s_tx_lock, portMAX_DELAY);
    }
}

bool wifi_is_ready(void* /*impl*/) {
    return s_got_ip.load() && s_ws_connected.load() && s_ws_authenticated.load() &&
           !s_stopping.load();
}

agent_transport_t s_wifi = {
    wifi_start, wifi_stop, wifi_send_ctrl,
    wifi_stream_start, wifi_send_stream, wifi_stream_end,
    wifi_is_ready, nullptr,
};
}  // namespace

extern "C" agent_transport_t* agent_transport_wifi(void) { return &s_wifi; }

extern "C" void agent_transport_wifi_set_config(const struct agent_wifi_config_s* cfg) { s_cfg = cfg; }

extern "C" void agent_transport_wifi_set_name(const char* name) {
    if (name && *name) {
        strncpy(s_name, name, sizeof(s_name) - 1);
        s_name[sizeof(s_name) - 1] = '\0';
    }
}

extern "C" void agent_transport_wifi_set_recv(void (*cb)(const uint8_t*, size_t)) { s_on_recv = cb; }
extern "C" void agent_transport_wifi_set_conn(void (*cb)(bool)) { s_on_conn = cb; }
extern "C" void agent_transport_wifi_set_stream_recv(void (*cb)(agent_stream_t, const uint8_t*, size_t)) {
    s_on_stream = cb;
}
