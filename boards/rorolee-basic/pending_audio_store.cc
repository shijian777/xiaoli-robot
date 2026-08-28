#include "pending_audio_store.h"

#include <cstring>

#include "esp_heap_caps.h"

namespace xiaoli {
namespace {

bool TerminatedNonEmpty(const char* value, size_t capacity) {
    return value != nullptr && value[0] != '\0' &&
           std::memchr(value, '\0', capacity) != nullptr;
}

bool Equals(const char* lhs, const char* rhs, size_t capacity) {
    return std::strncmp(lhs, rhs, capacity) == 0;
}

}  // namespace

PendingAudioStore::~PendingAudioStore() {
    if (!owns_buffers_) {
        return;
    }
    for (SlotId slot_id = 0; slot_id < kPendingSlotCount; ++slot_id) {
        Slot& slot = slots_[slot_id];
        heap_caps_free(slot.pcm);
        slot.pcm = nullptr;
    }
}

void PendingAudioStore::Reset() {
    for (Slot& slot : slots_) {
        slot.bytes = 0;
        slot.insertion_ordinal = 0;
        slot.meta = {};
        slot.state = SlotState::kFree;
    }
    next_ordinal_ = 1;
}

bool PendingAudioStore::InitProduction() {
    if (initialized_) {
        return true;
    }
    uint8_t* first = static_cast<uint8_t*>(
        heap_caps_malloc(kMaxPcmBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    uint8_t* second = static_cast<uint8_t*>(
        heap_caps_malloc(kMaxPcmBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (first == nullptr || second == nullptr) {
        heap_caps_free(first);
        heap_caps_free(second);
        return false;
    }
    slots_[0].pcm = first;
    slots_[1].pcm = second;
    capacity_ = kMaxPcmBytes;
    owns_buffers_ = true;
    initialized_ = true;
    Reset();
    return true;
}

bool PendingAudioStore::InitWithBuffers(uint8_t* first, uint8_t* second,
                                        size_t capacity) {
    if (initialized_ || first == nullptr || second == nullptr ||
        first == second || capacity == 0) {
        return false;
    }
    slots_[0].pcm = first;
    slots_[1].pcm = second;
    capacity_ = capacity;
    owns_buffers_ = false;
    initialized_ = true;
    Reset();
    return true;
}

bool PendingAudioStore::MetaValid(const PendingSegmentMeta& meta) {
    return TerminatedNonEmpty(meta.case_id, sizeof(meta.case_id)) &&
           TerminatedNonEmpty(meta.segment_id, sizeof(meta.segment_id)) &&
           TerminatedNonEmpty(meta.start_message_id,
                              sizeof(meta.start_message_id)) &&
           TerminatedNonEmpty(meta.end_message_id,
                              sizeof(meta.end_message_id)) &&
           TerminatedNonEmpty(meta.start_json, sizeof(meta.start_json)) &&
           (meta.speaker == Speaker::kA || meta.speaker == Speaker::kB) &&
           meta.case_generation != 0;
}

StoreResult PendingAudioStore::Begin(const PendingSegmentMeta& meta,
                                     SlotId* slot_id) {
    if (!initialized_) {
        return StoreResult::kNotInitialized;
    }
    if (slot_id == nullptr || !MetaValid(meta)) {
        return StoreResult::kInvalidArgument;
    }
    for (SlotId index = 0; index < kPendingSlotCount; ++index) {
        Slot& slot = slots_[index];
        if (slot.state != SlotState::kFree) {
            continue;
        }
        slot.bytes = 0;
        slot.meta = meta;
        slot.state = SlotState::kRecording;
        slot.insertion_ordinal = next_ordinal_++;
        if (next_ordinal_ == 0) {
            next_ordinal_ = 1;
        }
        *slot_id = index;
        return StoreResult::kOk;
    }
    return StoreResult::kNoFreeSlot;
}

StoreResult PendingAudioStore::Append(SlotId slot_id, const uint8_t* pcm,
                                      size_t bytes) {
    if (!initialized_) {
        return StoreResult::kNotInitialized;
    }
    if (slot_id >= kPendingSlotCount) {
        return StoreResult::kInvalidSlot;
    }
    if (bytes != 0 && pcm == nullptr) {
        return StoreResult::kInvalidArgument;
    }
    Slot& slot = slots_[slot_id];
    if (slot.state != SlotState::kRecording) {
        return StoreResult::kWrongState;
    }
    if (bytes > capacity_ - slot.bytes) {
        return StoreResult::kOverflow;
    }
    if (bytes != 0) {
        std::memcpy(slot.pcm + slot.bytes, pcm, bytes);
        slot.bytes += bytes;
    }
    return StoreResult::kOk;
}

StoreResult PendingAudioStore::MarkLocallyComplete(SlotId slot_id) {
    if (!initialized_) {
        return StoreResult::kNotInitialized;
    }
    if (slot_id >= kPendingSlotCount) {
        return StoreResult::kInvalidSlot;
    }
    Slot& slot = slots_[slot_id];
    if (slot.state != SlotState::kRecording || slot.bytes == 0) {
        return StoreResult::kWrongState;
    }
    slot.state = SlotState::kCompleteUnacked;
    slot.quarantined = false;
    return StoreResult::kOk;
}

void PendingAudioStore::Release(Slot& slot) {
    if (slot.pcm != nullptr && slot.bytes != 0) {
        std::memset(slot.pcm, 0, slot.bytes);
    }
    slot.bytes = 0;
    slot.insertion_ordinal = 0;
    slot.meta = {};
    slot.state = SlotState::kFree;
    slot.quarantined = false;
}

void PendingAudioStore::AbortIncomplete(SlotId slot_id) {
    if (!initialized_ || slot_id >= kPendingSlotCount) {
        return;
    }
    Slot& slot = slots_[slot_id];
    if (slot.state == SlotState::kRecording) {
        Release(slot);
    }
}

bool PendingAudioStore::QuarantineComplete(
    SlotId slot_id, uint64_t insertion_ordinal) {
    if (!initialized_ || slot_id >= kPendingSlotCount ||
        insertion_ordinal == 0) {
        return false;
    }
    Slot& slot = slots_[slot_id];
    if (slot.state != SlotState::kCompleteUnacked ||
        slot.insertion_ordinal != insertion_ordinal) {
        return false;
    }
    slot.quarantined = true;
    return true;
}

bool PendingAudioStore::Get(SlotId slot_id, PendingSegmentView* view) const {
    if (!initialized_ || view == nullptr || slot_id >= kPendingSlotCount) {
        return false;
    }
    const Slot& slot = slots_[slot_id];
    if (slot.state == SlotState::kFree) {
        return false;
    }
    view->slot = slot_id;
    view->meta = slot.meta;
    view->pcm = slot.pcm;
    view->bytes = slot.bytes;
    view->insertion_ordinal = slot.insertion_ordinal;
    view->locally_complete = slot.state == SlotState::kCompleteUnacked;
    view->quarantined = slot.quarantined;
    return true;
}

bool PendingAudioStore::OldestCompleteUnacked(PendingSegmentView* view) const {
    if (!initialized_ || view == nullptr) {
        return false;
    }
    const Slot* oldest = nullptr;
    SlotId oldest_id = kInvalidSlot;
    for (SlotId index = 0; index < kPendingSlotCount; ++index) {
        const Slot& slot = slots_[index];
        if (slot.state != SlotState::kCompleteUnacked || slot.quarantined) {
            continue;
        }
        if (oldest == nullptr ||
            slot.insertion_ordinal < oldest->insertion_ordinal) {
            oldest = &slot;
            oldest_id = index;
        }
    }
    if (oldest == nullptr) {
        return false;
    }
    view->slot = oldest_id;
    view->meta = oldest->meta;
    view->pcm = oldest->pcm;
    view->bytes = oldest->bytes;
    view->insertion_ordinal = oldest->insertion_ordinal;
    view->locally_complete = true;
    view->quarantined = false;
    return true;
}

AckResult PendingAudioStore::ApplyDurableAck(const DurableAck& ack) {
    AckResult result{};
    if (!initialized_ || !ack.durable ||
        !TerminatedNonEmpty(ack.case_id, sizeof(ack.case_id)) ||
        !TerminatedNonEmpty(ack.segment_id, sizeof(ack.segment_id)) ||
        !TerminatedNonEmpty(ack.message_id, sizeof(ack.message_id))) {
        return result;
    }
    for (SlotId slot_id = 0; slot_id < kPendingSlotCount; ++slot_id) {
        Slot& slot = slots_[slot_id];
        if (slot.state != SlotState::kCompleteUnacked ||
            !Equals(slot.meta.case_id, ack.case_id, sizeof(ack.case_id)) ||
            !Equals(slot.meta.segment_id, ack.segment_id,
                    sizeof(ack.segment_id)) ||
            !Equals(slot.meta.end_message_id, ack.message_id,
                    sizeof(ack.message_id)) ||
            slot.bytes != ack.bytes) {
            continue;
        }
        result.released = true;
        result.slot = slot_id;
        result.insertion_ordinal = slot.insertion_ordinal;
        result.speaker = slot.meta.speaker;
        result.case_generation = slot.meta.case_generation;
        result.bytes = static_cast<uint32_t>(slot.bytes);
        Release(slot);
        return result;
    }
    return result;
}

bool PendingAudioStore::HasFreeSlot() const {
    if (!initialized_) {
        return false;
    }
    for (const Slot& slot : slots_) {
        if (slot.state == SlotState::kFree) {
            return true;
        }
    }
    return false;
}

bool PendingAudioStore::HasCompleteUnacked() const {
    return CompleteCount() != 0;
}

uint8_t PendingAudioStore::CompleteCount() const {
    uint8_t count = 0;
    if (!initialized_) {
        return count;
    }
    for (const Slot& slot : slots_) {
        if (slot.state == SlotState::kCompleteUnacked) {
            ++count;
        }
    }
    return count;
}

}  // namespace xiaoli
