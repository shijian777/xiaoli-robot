#pragma once

#include <cstddef>
#include <cstdint>

namespace xiaoli {

inline constexpr uint32_t kDebounceMs = 40;
inline constexpr uint32_t kLongPressMs = 3000;
inline constexpr uint32_t kEndStatusMs = 5000;
inline constexpr uint32_t kErrorVibrateMs = 120;
inline constexpr size_t kMaxActions = 4;
inline constexpr size_t kMaxButtonEvents = 3;

enum class MediationState : uint8_t {
    kWelcome,
    kWaiting,
    kRecordingA,
    kRecordingB,
    kMediating,
    kPlaying,
    kRecoverableError,
};

enum class Button : uint8_t { kCase, kPersonA, kPersonB };
enum class Speaker : uint8_t { kNone, kA, kB };

enum class StatusId : uint8_t {
    kWelcome,
    kWaiting,
    kRecordingA,
    kRecordingB,
    kStatementEndedA,
    kStatementEndedB,
    kMediating,
    kNeedCase,
    kNeedBothStatements,
    kNetworkUnavailable,
    kRecordingIncomplete,
    kAudioCapacity,
    kMediationFailed,
};

const char* StatusText(StatusId id);

enum class ErrorReason : uint8_t {
    kNetworkUnavailable,
    kRecordingIncomplete,
    kAudioCapacity,
    kMediationFailed,
};

enum class EventType : uint8_t {
    kBoot,
    kButtonPressed,
    kButtonReleased,
    kTick,
    kSegmentDurableAck,
    kAudioStart,
    kAudioEnd,
    kRecoverableError,
    kRecovered,
};

struct Event {
    EventType type = EventType::kTick;
    uint64_t now_ms = 0;
    Button button = Button::kCase;
    Speaker speaker = Speaker::kNone;
    ErrorReason error = ErrorReason::kNetworkUnavailable;
    uint32_t case_generation = 0;
};

enum class ActionType : uint8_t {
    kNone,
    kNewCase,
    kStartRecording,
    kStopRecording,
    kRequestMediation,
    kVibrate,
    kShowStatus,
};

struct Action {
    ActionType type = ActionType::kNone;
    Speaker speaker = Speaker::kNone;
    StatusId status = StatusId::kWaiting;
    uint32_t duration_ms = 0;
    uint32_t case_generation = 0;
};

struct ActionBatch {
    Action items[kMaxActions] = {};
    uint8_t count = 0;
};

class MediationStateMachine {
public:
    ActionBatch Handle(const Event& event);

    MediationState state() const { return state_; }
    uint16_t completed_a() const { return completed_a_; }
    uint16_t completed_b() const { return completed_b_; }
    uint32_t case_generation() const { return case_generation_; }
    bool has_case() const { return has_case_; }

private:
    ActionBatch HandleButtonPressed(const Event& event);
    ActionBatch HandleButtonReleased(const Event& event);
    ActionBatch HandleLongPress();
    ActionBatch StartOrStopSpeaker(Button button);
    ActionBatch StartNewCase();
    void CancelEndStatus();

    MediationState state_ = MediationState::kWelcome;
    uint16_t completed_a_ = 0;
    uint16_t completed_b_ = 0;
    uint32_t case_generation_ = 0;
    uint64_t last_now_ms_ = 0;
    uint64_t case_pressed_at_ms_ = 0;
    uint64_t end_status_deadline_ms_ = 0;
    bool has_case_ = false;
    bool case_button_down_ = false;
    bool case_long_fired_ = false;
    bool short_press_allowed_at_press_ = false;
    bool end_status_active_ = false;
};

struct ButtonEventBatch {
    Event items[kMaxButtonEvents] = {};
    uint8_t count = 0;
};

class ButtonDebouncer {
public:
    void Reset(uint64_t now_ms, uint8_t pressed_mask);
    ButtonEventBatch Sample(uint64_t now_ms, uint8_t pressed_mask);

private:
    struct Slot {
        uint64_t candidate_since_ms = 0;
        bool candidate_pressed = false;
        bool stable_pressed = false;
    } slots_[3] = {};
    uint64_t last_now_ms_ = 0;
    bool initialized_ = false;
};

}  // namespace xiaoli
