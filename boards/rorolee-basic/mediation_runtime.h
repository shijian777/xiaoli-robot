#pragma once

#include <cstddef>
#include <cstdint>

#include "pending_audio_store.h"

namespace xiaoli {

inline constexpr size_t kPcmFrameBytes = 640;
inline constexpr size_t kMaxPlaybackBytes = 1'920'000;

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
    void Reset();

private:
    uint64_t sent_ordinal_[kPendingSlotCount] = {};
};

uint32_t ClampHapticDuration(uint32_t duration_ms);

class PlaybackSession {
public:
    bool Begin(const char* case_id, uint32_t case_generation,
               uint32_t expected_bytes, uint32_t sample_rate,
               uint8_t bits, uint8_t channels);
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

}  // namespace xiaoli
