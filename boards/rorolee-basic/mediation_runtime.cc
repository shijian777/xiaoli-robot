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

}  // namespace

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
    return std::min(kPcmFrameBytes, total_bytes_ - offset_);
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

uint32_t ClampHapticDuration(uint32_t duration_ms) {
    if (duration_ms < 20) {
        return 20;
    }
    return std::min<uint32_t>(duration_ms, 3000);
}

bool PlaybackSession::Begin(const char* case_id, uint32_t case_generation,
                            uint32_t expected_bytes, uint32_t sample_rate,
                            uint8_t bits, uint8_t channels) {
    if (!ValidId(case_id) || case_generation == 0 || expected_bytes == 0 ||
        expected_bytes > kMaxPlaybackBytes || (expected_bytes & 1U) != 0 ||
        sample_rate != 16000 || bits != 16 || channels != 1) {
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

bool PlaybackSession::ReserveChunk(size_t bytes) {
    if (!active_ || input_complete_ || incomplete_ || bytes == 0 ||
        (bytes & 1U) != 0 || bytes > expected_bytes_ - received_bytes_ ||
        chunk_count_ >= 0x10000U) {
        if (active_) {
            incomplete_ = true;
        }
        return false;
    }
    received_bytes_ += static_cast<uint32_t>(bytes);
    ++chunk_count_;
    return true;
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

}  // namespace xiaoli
