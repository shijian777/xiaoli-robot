#include "mediation_runtime.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <limits>

namespace xiaoli {
namespace {

bool FitsResult(int written, size_t capacity) {
    return written > 0 && static_cast<size_t>(written) < capacity;
}

bool ValidId(const char* value) {
    if (value == nullptr || value[0] == '\0') {
        return false;
    }
    return strnlen(value, kIdCapacity) < kIdCapacity;
}

bool ValidPlaybackStart(const char* case_id, uint32_t expected_bytes,
                        uint32_t sample_rate, uint8_t bits,
                        uint8_t channels) {
    return ValidId(case_id) && expected_bytes != 0 &&
           expected_bytes <= kMaxPlaybackBytes &&
           (expected_bytes & 1U) == 0 && sample_rate == 16000 &&
           bits == 16 && channels == 1;
}

}  // namespace

bool PcmUploadBatch::AppendCaptureFrame(const uint8_t* pcm, size_t bytes) {
    if (pcm == nullptr || bytes != kPcmCaptureFrameBytes || full()) {
        return false;
    }
    std::memcpy(data_ + bytes_, pcm, bytes);
    bytes_ += bytes;
    return true;
}

TailFlushAction PcmUploadBatch::HandleTailPushResult(esp_err_t result,
                                                      bool link_ready,
                                                      uint64_t elapsed_ms) {
    if (result == ESP_OK) {
        CommitSent();
        return TailFlushAction::kDone;
    }
    if (result == ESP_ERR_TIMEOUT && link_ready &&
        elapsed_ms < kTailFlushRetryBudgetMs) {
        return TailFlushAction::kRetry;
    }
    return TailFlushAction::kFail;
}

void PcmUploadBatch::CommitSent() {
    bytes_ = 0;
}

void PcmUploadBatch::Reset() {
    bytes_ = 0;
}

AsrEndFailureAction EndFailureActionFor(bool complete) {
    return complete ? AsrEndFailureAction::kRestartLink
                    : AsrEndFailureAction::kRetryIncompleteEnd;
}

BridgeErrorTarget ClassifyBridgeErrorTarget(
    const char* error_segment_id, const char* active_segment_id,
    const char* replay_segment_id) {
    if (error_segment_id == nullptr || error_segment_id[0] == '\0') {
        return BridgeErrorTarget::kCaseWide;
    }
    if (ValidId(active_segment_id) &&
        std::strncmp(error_segment_id, active_segment_id, kIdCapacity) == 0) {
        return BridgeErrorTarget::kActiveRecording;
    }
    if (ValidId(replay_segment_id) &&
        std::strncmp(error_segment_id, replay_segment_id, kIdCapacity) == 0) {
        return BridgeErrorTarget::kReplay;
    }
    return BridgeErrorTarget::kStale;
}

void LinkEdgeTracker::Notify(LinkLevel level) {
    latest_.store(static_cast<uint8_t>(level), std::memory_order_release);
    if (level == LinkLevel::kDisconnected) {
        disconnect_seen_.store(true, std::memory_order_release);
    }
    epoch_.fetch_add(1, std::memory_order_acq_rel);
}

LinkEdgeSnapshot LinkEdgeTracker::Take() {
    LinkEdgeSnapshot snapshot{};
    snapshot.disconnect_seen =
        disconnect_seen_.exchange(false, std::memory_order_acq_rel);
    snapshot.epoch = epoch_.load(std::memory_order_acquire);
    snapshot.latest = static_cast<LinkLevel>(
        latest_.load(std::memory_order_acquire));
    return snapshot;
}

bool CallbackAdmissionGate::TryCapture(uint32_t* epoch) const {
    if (epoch == nullptr || !open()) {
        return false;
    }
    const uint32_t captured = this->epoch();
    if (!Accepts(captured)) {
        return false;
    }
    *epoch = captured;
    return true;
}

bool CallbackAdmissionGate::Accepts(uint32_t epoch) const {
    return open() && this->epoch() == epoch;
}

void CallbackAdmissionGate::Open() {
    open_.store(true, std::memory_order_release);
}

void CallbackAdmissionGate::Close() {
    open_.store(false, std::memory_order_release);
}

void CallbackAdmissionGate::CloseAndAdvance() {
    Close();
    epoch_.fetch_add(1, std::memory_order_acq_rel);
}

void EpochFaultLatch::Signal(uint32_t epoch) {
    if (epoch == 0) {
        return;
    }
    uint32_t observed = pending_epoch_.load(std::memory_order_acquire);
    while (observed < epoch &&
           !pending_epoch_.compare_exchange_weak(
               observed, epoch, std::memory_order_acq_rel,
               std::memory_order_acquire)) {
    }
}

bool EpochFaultLatch::TakeIfCurrent(uint32_t current_epoch) {
    const uint32_t pending = pending_epoch_.exchange(
        0, std::memory_order_acq_rel);
    return pending != 0 && pending == current_epoch;
}

bool IsCurrentPlaybackNotice(uint32_t active_session_epoch,
                             uint32_t notice_session_epoch) {
    return active_session_epoch != 0 &&
           active_session_epoch == notice_session_epoch;
}

uint32_t PlaybackIoEpoch::RequestReset() {
    uint32_t next = reset_requested_.fetch_add(
        1, std::memory_order_acq_rel) + 1;
    if (next == 0) {
        next = reset_requested_.fetch_add(
            1, std::memory_order_acq_rel) + 1;
    }
    return next;
}

uint32_t PlaybackIoEpoch::requested_reset() const {
    return reset_requested_.load(std::memory_order_acquire);
}

void PlaybackIoEpoch::InvalidateSession() {
    callback_epoch_.store(0, std::memory_order_release);
    session_epoch_.fetch_add(1, std::memory_order_acq_rel);
}

void PlaybackIoEpoch::AcknowledgeReset(uint32_t reset_epoch) {
    reset_acknowledged_.store(reset_epoch, std::memory_order_release);
}

bool PlaybackIoEpoch::reset_confirmed() const {
    return reset_acknowledged_.load(std::memory_order_acquire) ==
           reset_requested_.load(std::memory_order_acquire);
}

uint32_t PlaybackIoEpoch::BeginSession(uint32_t callback_epoch) {
    if (callback_epoch == 0 || !reset_confirmed()) {
        return 0;
    }
    uint32_t session = session_epoch_.fetch_add(
        1, std::memory_order_acq_rel) + 1;
    if (session == 0) {
        session = session_epoch_.fetch_add(
            1, std::memory_order_acq_rel) + 1;
    }
    callback_epoch_.store(callback_epoch, std::memory_order_release);
    return session;
}

bool PlaybackIoEpoch::AcceptCallback(
    uint32_t captured_reset_epoch, bool callback_epoch_current) const {
    return callback_epoch_current && reset_confirmed() &&
           captured_reset_epoch == requested_reset();
}

PlaybackWriteLease PlaybackIoEpoch::CaptureWriteLease() const {
    PlaybackWriteLease lease{};
    do {
        lease.session_epoch = session_epoch_.load(std::memory_order_acquire);
        lease.callback_epoch = callback_epoch_.load(std::memory_order_acquire);
    } while (lease.session_epoch !=
             session_epoch_.load(std::memory_order_acquire));
    return lease;
}

bool PlaybackIoEpoch::AcceptWrite(
    const PlaybackWriteLease& lease, bool callback_epoch_current) const {
    return callback_epoch_current && reset_confirmed() &&
           lease.session_epoch != 0 && lease.callback_epoch != 0 &&
           lease.session_epoch ==
               session_epoch_.load(std::memory_order_acquire) &&
           lease.callback_epoch ==
               callback_epoch_.load(std::memory_order_acquire);
}

bool MediationProbeBudget::Take() {
    if (attempts_ >= kMaxAttempts) {
        return false;
    }
    ++attempts_;
    return true;
}

bool BusinessIdGenerator::Initialize(const uint8_t mac[6],
                                     uint32_t boot_epoch,
                                     bool epoch_committed) {
    ready_ = false;
    if (mac == nullptr || boot_epoch == 0 || !epoch_committed) {
        return false;
    }
    const int written = std::snprintf(
        device_id_, sizeof(device_id_), "xl-%02x%02x%02x%02x%02x%02x",
        mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    if (!FitsResult(written, sizeof(device_id_))) {
        device_id_[0] = '\0';
        return false;
    }
    boot_epoch_ = boot_epoch;
    case_counter_ = 0;
    segment_counter_ = 0;
    message_counter_ = 0;
    ready_ = true;
    return true;
}

bool BusinessIdGenerator::Format(char* output, size_t capacity,
                                 const char* suffix,
                                 uint64_t counter) const {
    if (!ready_ || output == nullptr || capacity == 0 || suffix == nullptr ||
        counter == 0) {
        return false;
    }
    const int written = std::snprintf(
        output, capacity, "%s-e%lu-%s%llu", device_id_,
        static_cast<unsigned long>(boot_epoch_), suffix,
        static_cast<unsigned long long>(counter));
    if (!FitsResult(written, capacity)) {
        output[0] = '\0';
        return false;
    }
    return true;
}

bool BusinessIdGenerator::NextCase(char* output, size_t capacity) {
    if (!ready_ || case_counter_ == std::numeric_limits<uint64_t>::max()) {
        return false;
    }
    const uint64_t next = case_counter_ + 1;
    if (!Format(output, capacity, "c", next)) {
        return false;
    }
    case_counter_ = next;
    return true;
}

bool BusinessIdGenerator::NextSegment(const char* case_id, char* output,
                                      size_t capacity) {
    if (!ready_ || !ValidId(case_id) || output == nullptr || capacity == 0 ||
        segment_counter_ == std::numeric_limits<uint64_t>::max()) {
        return false;
    }
    const uint64_t next = segment_counter_ + 1;
    const int written = std::snprintf(output, capacity, "%s-s%llu", case_id,
                                      static_cast<unsigned long long>(next));
    if (!FitsResult(written, capacity)) {
        output[0] = '\0';
        return false;
    }
    segment_counter_ = next;
    return true;
}

bool BusinessIdGenerator::NextMessage(char* output, size_t capacity) {
    if (!ready_ || message_counter_ == std::numeric_limits<uint64_t>::max()) {
        return false;
    }
    const uint64_t next = message_counter_ + 1;
    if (!Format(output, capacity, "m", next)) {
        return false;
    }
    message_counter_ = next;
    return true;
}

void ReplayFrameCursor::Reset(size_t total_bytes) {
    total_bytes_ = total_bytes;
    offset_ = 0;
    sequence_ = 0;
}

size_t ReplayFrameCursor::CurrentBytes() const {
    if (done()) {
        return 0;
    }
    return std::min(kPcmUploadBatchBytes, total_bytes_ - offset_);
}

void ReplayFrameCursor::CommitSuccess() {
    const size_t bytes = CurrentBytes();
    if (bytes == 0) {
        return;
    }
    offset_ += bytes;
    if (sequence_ != std::numeric_limits<uint16_t>::max()) {
        ++sequence_;
    }
}

bool ConnectionReplayLedger::WasSent(
    SlotId slot, uint64_t insertion_ordinal) const {
    return slot < kPendingSlotCount && insertion_ordinal != 0 &&
           sent_ordinal_[slot] == insertion_ordinal;
}

void ConnectionReplayLedger::MarkSent(
    SlotId slot, uint64_t insertion_ordinal) {
    if (slot < kPendingSlotCount && insertion_ordinal != 0) {
        sent_ordinal_[slot] = insertion_ordinal;
    }
}

void ConnectionReplayLedger::Reset() {
    for (uint64_t& ordinal : sent_ordinal_) {
        ordinal = 0;
    }
}

void ConnectionReplayLedger::Forget(
    SlotId slot, uint64_t insertion_ordinal) {
    if (slot < kPendingSlotCount && insertion_ordinal != 0 &&
        sent_ordinal_[slot] == insertion_ordinal) {
        sent_ordinal_[slot] = 0;
    }
}

bool CompleteFaultDeferral::DeferWhileRecording(
    SlotId active_slot, SlotId failed_slot, uint64_t insertion_ordinal,
    bool retryable) {
    if (active_slot == kInvalidSlot || failed_slot >= kPendingSlotCount ||
        insertion_ordinal == 0) {
        return false;
    }
    if (pending_) {
        if (fault_.slot != failed_slot ||
            fault_.insertion_ordinal != insertion_ordinal) {
            return false;
        }
        // A terminal report dominates a retryable duplicate for the same
        // retained segment.
        fault_.retryable = fault_.retryable && retryable;
        return true;
    }
    fault_.slot = failed_slot;
    fault_.insertion_ordinal = insertion_ordinal;
    fault_.retryable = retryable;
    pending_ = true;
    return true;
}

bool CompleteFaultDeferral::TakeIfIdle(
    SlotId active_slot, PendingCompleteFault* fault) {
    if (!pending_ || active_slot != kInvalidSlot || fault == nullptr) {
        return false;
    }
    *fault = fault_;
    Reset();
    return true;
}

void CompleteFaultDeferral::Reset() {
    fault_ = {};
    pending_ = false;
}

TranscriptTracker::Entry* TranscriptTracker::Find(const char* segment_id) {
    if (!ValidId(segment_id)) {
        return nullptr;
    }
    for (Entry& entry : entries_) {
        if (entry.status != Status::kEmpty &&
            std::strncmp(entry.segment_id, segment_id,
                         sizeof(entry.segment_id)) == 0) {
            return &entry;
        }
    }
    return nullptr;
}

const TranscriptTracker::Entry* TranscriptTracker::Find(
    const char* segment_id) const {
    return const_cast<TranscriptTracker*>(this)->Find(segment_id);
}

TranscriptTracker::Entry* TranscriptTracker::Add(
    const char* segment_id, Speaker speaker, Status status) {
    if (!ValidId(segment_id) ||
        (speaker != Speaker::kA && speaker != Speaker::kB) ||
        status == Status::kEmpty) {
        return nullptr;
    }
    for (Entry& entry : entries_) {
        if (entry.status != Status::kEmpty) {
            continue;
        }
        std::snprintf(entry.segment_id, sizeof(entry.segment_id), "%s",
                      segment_id);
        entry.speaker = speaker;
        entry.status = status;
        return &entry;
    }
    return nullptr;
}

bool TranscriptTracker::NoteDurable(const char* segment_id, Speaker speaker) {
    Entry* entry = Find(segment_id);
    if (entry == nullptr) {
        return Add(segment_id, speaker, Status::kPending) != nullptr;
    }
    return entry->speaker == speaker;
}

bool TranscriptTracker::NoteSaved(const char* segment_id, Speaker speaker) {
    Entry* entry = Find(segment_id);
    if (entry == nullptr) {
        entry = Add(segment_id, speaker, Status::kSaved);
        return entry != nullptr;
    }
    if (entry->speaker != speaker || entry->status == Status::kFailed) {
        return false;
    }
    entry->status = Status::kSaved;
    return true;
}

bool TranscriptTracker::NoteFailed(const char* segment_id) {
    Entry* entry = Find(segment_id);
    if (entry == nullptr || entry->status == Status::kSaved) {
        return false;
    }
    entry->status = Status::kFailed;
    return true;
}

bool TranscriptTracker::HasPending() const {
    for (const Entry& entry : entries_) {
        if (entry.status == Status::kPending) {
            return true;
        }
    }
    return false;
}

bool TranscriptTracker::ReadyToMediate() const {
    bool saved_a = false;
    bool saved_b = false;
    for (const Entry& entry : entries_) {
        if (entry.status == Status::kPending) {
            return false;
        }
        if (entry.status != Status::kSaved) {
            continue;
        }
        saved_a = saved_a || entry.speaker == Speaker::kA;
        saved_b = saved_b || entry.speaker == Speaker::kB;
    }
    return saved_a && saved_b;
}

void TranscriptTracker::Reset() {
    for (Entry& entry : entries_) {
        entry = {};
    }
}

uint32_t ClampHapticDuration(uint32_t duration_ms) {
    if (duration_ms < 20) {
        return 20;
    }
    return std::min<uint32_t>(duration_ms, 3000);
}

bool PlaybackAckTracker::Begin(const char* case_id,
                               const char* mediation_message_id) {
    if (active_ || pending_ || !ValidId(case_id) ||
        !ValidId(mediation_message_id)) {
        return false;
    }
    std::snprintf(case_id_, sizeof(case_id_), "%s", case_id);
    std::snprintf(mediation_message_id_, sizeof(mediation_message_id_), "%s",
                  mediation_message_id);
    played_message_id_[0] = '\0';
    active_ = true;
    end_validated_ = false;
    sent_ = false;
    return true;
}

bool PlaybackAckTracker::AcceptEnd(const char* case_id,
                                   const char* mediation_message_id) {
    if (!active_ || end_validated_ || !ValidId(case_id) ||
        !ValidId(mediation_message_id) ||
        std::strncmp(case_id_, case_id, sizeof(case_id_)) != 0 ||
        std::strncmp(mediation_message_id_, mediation_message_id,
                     sizeof(mediation_message_id_)) != 0) {
        return false;
    }
    end_validated_ = true;
    return true;
}

bool PlaybackAckTracker::MarkDrained(const char* played_message_id) {
    if (!active_ || !end_validated_ || pending_ ||
        !ValidId(played_message_id)) {
        return false;
    }
    std::snprintf(played_message_id_, sizeof(played_message_id_), "%s",
                  played_message_id);
    active_ = false;
    end_validated_ = false;
    pending_ = true;
    sent_ = false;
    return true;
}

bool PlaybackAckTracker::BuildJson(char* output, size_t capacity) const {
    if (output == nullptr || capacity == 0) {
        return false;
    }
    output[0] = '\0';
    if (!pending_ || !ValidId(case_id_) ||
        !ValidId(mediation_message_id_) || !ValidId(played_message_id_)) {
        return false;
    }
    const int written = std::snprintf(
        output, capacity,
        "{\"v\":1,\"type\":\"audio.played\",\"messageId\":\"%s\","
        "\"caseId\":\"%s\",\"mediationMessageId\":\"%s\"}",
        played_message_id_, case_id_, mediation_message_id_);
    if (!FitsResult(written, capacity)) {
        output[0] = '\0';
        return false;
    }
    return true;
}

bool PlaybackAckTracker::MarkSent() {
    if (!pending_ || sent_) {
        return false;
    }
    sent_ = true;
    return true;
}

bool PlaybackAckTracker::RequestResend(
        const char* case_id, const char* mediation_message_id) {
    if (!pending_ || !ValidId(case_id) || !ValidId(mediation_message_id) ||
        std::strncmp(case_id_, case_id, sizeof(case_id_)) != 0 ||
        std::strncmp(mediation_message_id_, mediation_message_id,
                     sizeof(mediation_message_id_)) != 0) {
        return false;
    }
    sent_ = false;
    return true;
}

bool PlaybackAckTracker::ApplyAck(const char* case_id, const char* message_id,
                                  bool accepted) {
    if (!pending_ || !accepted || !ValidId(case_id) || !ValidId(message_id) ||
        std::strncmp(case_id_, case_id, sizeof(case_id_)) != 0 ||
        std::strncmp(played_message_id_, message_id,
                     sizeof(played_message_id_)) != 0) {
        return false;
    }
    Clear();
    return true;
}

void PlaybackAckTracker::AbortPlayback() {
    if (!active_) {
        return;
    }
    Clear();
}

void PlaybackAckTracker::OnDisconnected() {
    if (active_) {
        Clear();
        return;
    }
    if (pending_) {
        sent_ = false;
    }
}

void PlaybackAckTracker::Clear() {
    case_id_[0] = '\0';
    mediation_message_id_[0] = '\0';
    played_message_id_[0] = '\0';
    active_ = false;
    end_validated_ = false;
    pending_ = false;
    sent_ = false;
}

bool PlaybackSession::Begin(const char* case_id, uint32_t case_generation,
                            uint32_t expected_bytes, uint32_t sample_rate,
                            uint8_t bits, uint8_t channels) {
    if (case_generation == 0 ||
        !ValidPlaybackStart(case_id, expected_bytes, sample_rate, bits,
                            channels)) {
        return false;
    }
    std::snprintf(case_id_, sizeof(case_id_), "%s", case_id);
    case_generation_ = case_generation;
    expected_bytes_ = expected_bytes;
    received_bytes_ = 0;
    written_bytes_ = 0;
    chunk_count_ = 0;
    active_ = true;
    incomplete_ = false;
    input_complete_ = false;
    return true;
}

bool PlaybackSession::ReserveChunks(size_t bytes, uint32_t chunks) {
    const bool empty = bytes == 0 && chunks == 0;
    if (!active_ || input_complete_ || incomplete_ ||
        (!empty && (bytes == 0 || chunks == 0)) || (bytes & 1U) != 0 ||
        bytes > expected_bytes_ || received_bytes_ > expected_bytes_ - bytes ||
        chunks > 0x10000U || chunk_count_ > 0x10000U - chunks) {
        if (active_) {
            incomplete_ = true;
        }
        return false;
    }
    received_bytes_ += static_cast<uint32_t>(bytes);
    chunk_count_ += chunks;
    return true;
}

bool PlaybackSession::ReserveChunk(size_t bytes) {
    return ReserveChunks(bytes, 1);
}

void PlaybackSession::FailIngress() {
    if (active_) {
        incomplete_ = true;
    }
}

bool PlaybackSession::AcceptChunk(size_t requested_bytes,
                                  size_t accepted_bytes) {
    if (accepted_bytes != requested_bytes) {
        FailIngress();
        return false;
    }
    return ReserveChunk(requested_bytes);
}

bool PlaybackSession::AcceptEnd(const char* case_id, uint32_t bytes,
                                uint16_t last_sequence, bool complete) {
    if (!active_ || incomplete_ || !ValidId(case_id) ||
        std::strncmp(case_id_, case_id, sizeof(case_id_)) != 0 || !complete ||
        bytes != expected_bytes_ || bytes != received_bytes_ ||
        chunk_count_ == 0 || last_sequence != chunk_count_ - 1) {
        return false;
    }
    input_complete_ = true;
    return true;
}

bool PlaybackSession::MarkWritten(size_t bytes) {
    if (!active_ || incomplete_ || bytes == 0 || (bytes & 1U) != 0 ||
        bytes > received_bytes_ - written_bytes_) {
        if (active_) {
            incomplete_ = true;
        }
        return false;
    }
    written_bytes_ += static_cast<uint32_t>(bytes);
    return true;
}

bool PlaybackSession::ReadyToFinish(bool buffer_empty) const {
    return active_ && !incomplete_ && input_complete_ && buffer_empty &&
           received_bytes_ == expected_bytes_ &&
           written_bytes_ == expected_bytes_;
}

void PlaybackSession::Finish() {
    active_ = false;
    incomplete_ = false;
    input_complete_ = true;
}

void PlaybackSession::Abort() {
    active_ = false;
    incomplete_ = true;
    input_complete_ = false;
}

bool PlaybackIngressGate::ArmPending() {
    if (armed_) {
        return false;
    }
    Reset();
    armed_ = true;
    return true;
}

bool PlaybackIngressGate::Arm(const char* case_id, uint32_t expected_bytes,
                              uint32_t sample_rate, uint8_t bits,
                              uint8_t channels) {
    if (!ArmPending()) {
        return false;
    }
    if (!Bind(case_id, expected_bytes, sample_rate, bits, channels)) {
        Reset();
        return false;
    }
    return true;
}

bool PlaybackIngressGate::Bind(const char* case_id,
                               uint32_t expected_bytes,
                               uint32_t sample_rate, uint8_t bits,
                               uint8_t channels) {
    if (!ValidPlaybackStart(case_id, expected_bytes, sample_rate, bits,
                            channels) || incomplete_ || bound_ ||
        received_bytes_ > expected_bytes) {
        if (armed_) {
            incomplete_ = true;
        }
        return false;
    }
    if (!armed_ && !ArmPending()) {
        return false;
    }
    std::snprintf(case_id_, sizeof(case_id_), "%s", case_id);
    expected_bytes_ = expected_bytes;
    sample_rate_ = sample_rate;
    bits_ = bits;
    channels_ = channels;
    bound_ = true;
    return true;
}

bool PlaybackIngressGate::ReserveChunk(size_t bytes) {
    const uint32_t capacity = bound_ ? expected_bytes_ : kMaxPlaybackBytes;
    if (!armed_ || incomplete_ || bytes == 0 || (bytes & 1U) != 0 ||
        bytes > capacity || received_bytes_ > capacity - bytes ||
        chunk_count_ >= 0x10000U) {
        if (armed_) {
            incomplete_ = true;
        }
        return false;
    }
    received_bytes_ += static_cast<uint32_t>(bytes);
    ++chunk_count_;
    return true;
}

void PlaybackIngressGate::FailIngress() {
    if (armed_) {
        incomplete_ = true;
    }
}

bool PlaybackIngressGate::Matches(const char* case_id,
                                  uint32_t expected_bytes,
                                  uint32_t sample_rate, uint8_t bits,
                                  uint8_t channels) const {
    return armed_ && bound_ && ValidId(case_id) &&
           std::strncmp(case_id_, case_id, sizeof(case_id_)) == 0 &&
           expected_bytes_ == expected_bytes && sample_rate_ == sample_rate &&
           bits_ == bits && channels_ == channels;
}

bool PlaybackIngressGate::AdoptInto(PlaybackSession& playback) {
    const bool valid = armed_ && bound_ && !incomplete_ && playback.active() &&
                       std::strncmp(case_id_, playback.case_id(),
                                    sizeof(case_id_)) == 0 &&
                       expected_bytes_ == playback.expected_bytes();
    const uint32_t received = received_bytes_;
    const uint32_t chunks = chunk_count_;
    Reset();
    if (!valid || !playback.ReserveChunks(received, chunks)) {
        playback.FailIngress();
        return false;
    }
    return true;
}

void PlaybackIngressGate::Reset() {
    std::memset(case_id_, 0, sizeof(case_id_));
    expected_bytes_ = 0;
    sample_rate_ = 0;
    received_bytes_ = 0;
    chunk_count_ = 0;
    bits_ = 0;
    channels_ = 0;
    armed_ = false;
    bound_ = false;
    incomplete_ = false;
}

}  // namespace xiaoli
