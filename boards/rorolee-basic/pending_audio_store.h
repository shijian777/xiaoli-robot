#pragma once

#include <cstddef>
#include <cstdint>

#include "mediation_state.h"

namespace xiaoli {

inline constexpr size_t kPendingSlotCount = 2;
inline constexpr size_t kMaxPcmBytes = 1'920'000;
inline constexpr size_t kIdCapacity = 72;
inline constexpr size_t kStartJsonCapacity = 384;

using SlotId = uint8_t;
inline constexpr SlotId kInvalidSlot = 0xff;

struct PendingSegmentMeta {
    char case_id[kIdCapacity] = {};
    char segment_id[kIdCapacity] = {};
    char start_message_id[kIdCapacity] = {};
    char end_message_id[kIdCapacity] = {};
    char start_json[kStartJsonCapacity] = {};
    Speaker speaker = Speaker::kNone;
    uint32_t case_generation = 0;
};

struct DurableAck {
    char case_id[kIdCapacity] = {};
    char segment_id[kIdCapacity] = {};
    char message_id[kIdCapacity] = {};
    uint32_t bytes = 0;
    bool durable = false;
};

enum class StoreResult : uint8_t {
    kOk,
    kNotInitialized,
    kInvalidArgument,
    kNoFreeSlot,
    kInvalidSlot,
    kWrongState,
    kOverflow,
};

struct PendingSegmentView {
    SlotId slot = kInvalidSlot;
    PendingSegmentMeta meta{};
    const uint8_t* pcm = nullptr;
    size_t bytes = 0;
    uint64_t insertion_ordinal = 0;
    bool locally_complete = false;
};

struct AckResult {
    bool released = false;
    SlotId slot = kInvalidSlot;
    uint64_t insertion_ordinal = 0;
    Speaker speaker = Speaker::kNone;
    uint32_t case_generation = 0;
    uint32_t bytes = 0;
};

class PendingAudioStore {
public:
    PendingAudioStore() = default;
    ~PendingAudioStore();
    PendingAudioStore(const PendingAudioStore&) = delete;
    PendingAudioStore& operator=(const PendingAudioStore&) = delete;

    bool InitProduction();
    bool InitWithBuffers(uint8_t* first, uint8_t* second, size_t capacity);

    StoreResult Begin(const PendingSegmentMeta& meta, SlotId* slot);
    StoreResult Append(SlotId slot, const uint8_t* pcm, size_t bytes);
    StoreResult MarkLocallyComplete(SlotId slot);
    void AbortIncomplete(SlotId slot);
    bool AbandonComplete(SlotId slot, uint64_t insertion_ordinal);

    bool Get(SlotId slot, PendingSegmentView* view) const;
    bool OldestCompleteUnacked(PendingSegmentView* view) const;
    AckResult ApplyDurableAck(const DurableAck& ack);

    bool initialized() const { return initialized_; }
    bool HasFreeSlot() const;
    bool HasCompleteUnacked() const;
    uint8_t CompleteCount() const;
    size_t slot_capacity() const { return capacity_; }

private:
    enum class SlotState : uint8_t { kFree, kRecording, kCompleteUnacked };

    struct Slot {
        uint8_t* pcm = nullptr;
        size_t bytes = 0;
        uint64_t insertion_ordinal = 0;
        PendingSegmentMeta meta{};
        SlotState state = SlotState::kFree;
    };

    static bool MetaValid(const PendingSegmentMeta& meta);
    void Release(Slot& slot);
    void Reset();

    Slot slots_[kPendingSlotCount] = {};
    size_t capacity_ = 0;
    uint64_t next_ordinal_ = 1;
    bool initialized_ = false;
    bool owns_buffers_ = false;
};

}  // namespace xiaoli
