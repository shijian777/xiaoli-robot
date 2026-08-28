#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>

#include "pending_audio_store.h"

namespace xiaoli {

inline constexpr size_t kPcmFrameBytes = 640;
inline constexpr size_t kMaxPlaybackBytes = 1'920'000;
inline constexpr size_t kMaxTrackedSegments = 64;

enum class AsrEndFailureAction : uint8_t {
    kRetryIncompleteEnd,
    kRestartLink,
};

AsrEndFailureAction EndFailureActionFor(bool complete);

enum class BridgeErrorTarget : uint8_t {
    kCaseWide,
    kActiveRecording,
    kReplay,
    kStale,
};

BridgeErrorTarget ClassifyBridgeErrorTarget(const char* error_segment_id,
                                             const char* active_segment_id,
                                             const char* replay_segment_id);

enum class LinkLevel : uint8_t {
    kDisconnected,
    kOther,
    kReady,
};

struct LinkEdgeSnapshot {
    uint32_t epoch = 0;
    LinkLevel latest = LinkLevel::kDisconnected;
    bool disconnect_seen = false;
};

// Agent callbacks are edge notifications, not just a latest-value signal. A
// sticky disconnect bit prevents DISCONNECTED -> READY from hiding the media
// cleanup boundary when both callbacks arrive before the owner task runs.
class LinkEdgeTracker {
public:
    void Notify(LinkLevel level);
    LinkEdgeSnapshot Take();

private:
    std::atomic<uint8_t> latest_{
        static_cast<uint8_t>(LinkLevel::kDisconnected)};
    std::atomic<uint32_t> epoch_{0};
    std::atomic<bool> disconnect_seen_{false};
};

class CallbackAdmissionGate {
public:
    bool TryCapture(uint32_t* epoch) const;
    bool Accepts(uint32_t epoch) const;
    void Open();
    void Close();
    void CloseAndAdvance();

    bool open() const {
        return open_.load(std::memory_order_acquire);
    }
    uint32_t epoch() const {
        return epoch_.load(std::memory_order_acquire);
    }

private:
    std::atomic<uint32_t> epoch_{1};
    std::atomic<bool> open_{false};
};

class MediationProbeBudget {
public:
    static constexpr uint8_t kMaxAttempts = 3;

    bool Take();
    void Reset() { attempts_ = 0; }
    uint8_t attempts() const { return attempts_; }

private:
    uint8_t attempts_ = 0;
};

class BusinessIdGenerator {
public:
    bool Initialize(const uint8_t mac[6], uint32_t boot_epoch,
                    bool epoch_committed);
    bool NextCase(char* output, size_t capacity);
    bool NextSegment(const char* case_id, char* output, size_t capacity);
    bool NextMessage(char* output, size_t capacity);

    bool ready() const { return ready_; }
    const char* device_id() const { return device_id_; }
    uint32_t boot_epoch() const { return boot_epoch_; }

private:
    bool Format(char* output, size_t capacity, const char* suffix,
                uint64_t counter) const;

    char device_id_[24] = {};
    uint32_t boot_epoch_ = 0;
    uint64_t case_counter_ = 0;
    uint64_t segment_counter_ = 0;
    uint64_t message_counter_ = 0;
    bool ready_ = false;
};

class ReplayFrameCursor {
public:
    void Reset(size_t total_bytes);
    size_t CurrentBytes() const;
    void CommitSuccess();
    void OnTimeout() {}

    bool done() const { return offset_ >= total_bytes_; }
    size_t offset() const { return offset_; }
    uint16_t sequence() const { return sequence_; }

private:
    size_t total_bytes_ = 0;
    size_t offset_ = 0;
    uint16_t sequence_ = 0;
};

class ConnectionReplayLedger {
public:
    bool WasSent(SlotId slot, uint64_t insertion_ordinal) const;
    void MarkSent(SlotId slot, uint64_t insertion_ordinal);
    void Forget(SlotId slot, uint64_t insertion_ordinal);
    void Reset();

private:
    uint64_t sent_ordinal_[kPendingSlotCount] = {};
};

class TranscriptTracker {
public:
    bool NoteDurable(const char* segment_id, Speaker speaker);
    bool NoteSaved(const char* segment_id, Speaker speaker);
    bool NoteFailed(const char* segment_id);
    bool HasPending() const;
    bool ReadyToMediate() const;
    void Reset();

private:
    enum class Status : uint8_t { kEmpty, kPending, kSaved, kFailed };
    struct Entry {
        char segment_id[kIdCapacity] = {};
        Speaker speaker = Speaker::kNone;
        Status status = Status::kEmpty;
    };

    Entry* Find(const char* segment_id);
    const Entry* Find(const char* segment_id) const;
    Entry* Add(const char* segment_id, Speaker speaker, Status status);

    Entry entries_[kMaxTrackedSegments] = {};
};

uint32_t ClampHapticDuration(uint32_t duration_ms);

class PlaybackSession {
public:
    bool Begin(const char* case_id, uint32_t case_generation,
               uint32_t expected_bytes, uint32_t sample_rate,
               uint8_t bits, uint8_t channels);
    bool ReserveChunks(size_t bytes, uint32_t chunks);
    bool ReserveChunk(size_t bytes);
    void FailIngress();
    bool AcceptChunk(size_t requested_bytes, size_t accepted_bytes);
    bool AcceptEnd(const char* case_id, uint32_t bytes,
                   uint16_t last_sequence, bool complete);
    bool MarkWritten(size_t bytes);
    bool ReadyToFinish(bool buffer_empty) const;
    void Finish();
    void Abort();

    bool active() const { return active_; }
    bool incomplete() const { return incomplete_; }
    bool input_complete() const { return input_complete_; }
    uint32_t expected_bytes() const { return expected_bytes_; }
    uint32_t received_bytes() const { return received_bytes_; }
    uint32_t written_bytes() const { return written_bytes_; }
    uint32_t chunk_count() const { return chunk_count_; }
    uint32_t case_generation() const { return case_generation_; }
    const char* case_id() const { return case_id_; }

private:
    char case_id_[kIdCapacity] = {};
    uint32_t case_generation_ = 0;
    uint32_t expected_bytes_ = 0;
    uint32_t received_bytes_ = 0;
    uint32_t written_bytes_ = 0;
    uint32_t chunk_count_ = 0;
    bool active_ = false;
    bool incomplete_ = false;
    bool input_complete_ = false;
};

class PlaybackIngressGate {
public:
    bool ArmPending();
    bool Arm(const char* case_id, uint32_t expected_bytes,
             uint32_t sample_rate, uint8_t bits, uint8_t channels);
    bool Bind(const char* case_id, uint32_t expected_bytes,
              uint32_t sample_rate, uint8_t bits, uint8_t channels);
    bool ReserveChunk(size_t bytes);
    void FailIngress();
    bool Matches(const char* case_id, uint32_t expected_bytes,
                 uint32_t sample_rate, uint8_t bits,
                 uint8_t channels) const;
    bool AdoptInto(PlaybackSession& playback);
    void Reset();

    bool armed() const { return armed_; }
    bool bound() const { return bound_; }
    bool incomplete() const { return incomplete_; }
    uint32_t received_bytes() const { return received_bytes_; }
    uint32_t chunk_count() const { return chunk_count_; }

private:
    char case_id_[kIdCapacity] = {};
    uint32_t expected_bytes_ = 0;
    uint32_t sample_rate_ = 0;
    uint32_t received_bytes_ = 0;
    uint32_t chunk_count_ = 0;
    uint8_t bits_ = 0;
    uint8_t channels_ = 0;
    bool armed_ = false;
    bool bound_ = false;
    bool incomplete_ = false;
};

}  // namespace xiaoli
