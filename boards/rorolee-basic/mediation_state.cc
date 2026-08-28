#include "mediation_state.h"

#include <cassert>
#include <limits>

namespace xiaoli {
namespace {

void AddAction(ActionBatch& batch, ActionType type,
               Speaker speaker = Speaker::kNone,
               StatusId status = StatusId::kWaiting,
               uint32_t duration_ms = 0,
               uint32_t case_generation = 0) {
    assert(batch.count < kMaxActions);
    Action& action = batch.items[batch.count++];
    action.type = type;
    action.speaker = speaker;
    action.status = status;
    action.duration_ms = duration_ms;
    action.case_generation = case_generation;
}

StatusId ErrorStatus(ErrorReason reason) {
    switch (reason) {
        case ErrorReason::kNetworkUnavailable:
            return StatusId::kNetworkUnavailable;
        case ErrorReason::kRecordingIncomplete:
            return StatusId::kRecordingIncomplete;
        case ErrorReason::kAudioCapacity:
            return StatusId::kAudioCapacity;
        case ErrorReason::kMediationFailed:
            return StatusId::kMediationFailed;
    }
    return StatusId::kMediationFailed;
}

Speaker RecordingSpeaker(MediationState state) {
    if (state == MediationState::kRecordingA) {
        return Speaker::kA;
    }
    if (state == MediationState::kRecordingB) {
        return Speaker::kB;
    }
    return Speaker::kNone;
}

bool ShortCaseAllowed(MediationState state) {
    return state == MediationState::kWelcome ||
           state == MediationState::kWaiting ||
           state == MediationState::kRecoverableError;
}

uint64_t DeadlineAfter(uint64_t now_ms, uint32_t delay_ms) {
    constexpr uint64_t kMax = std::numeric_limits<uint64_t>::max();
    return now_ms > kMax - delay_ms ? kMax : now_ms + delay_ms;
}

}  // namespace

const char* StatusText(StatusId id) {
    switch (id) {
        case StatusId::kWelcome:
            return "欢迎来到小理天秤官";
        case StatusId::kWaiting:
            return "小理开始倾听";
        case StatusId::kRecordingA:
            return "小理开始倾听A发言";
        case StatusId::kRecordingB:
            return "小理开始倾听B发言";
        case StatusId::kStatementEndedA:
            return "A发言结束";
        case StatusId::kStatementEndedB:
            return "B发言结束";
        case StatusId::kMediating:
            return "小理调解中";
        case StatusId::kNeedCase:
            return "请先短按侧边键创建案件";
        case StatusId::kNeedBothStatements:
            return "请先收集双方发言";
        case StatusId::kNetworkUnavailable:
            return "网络连接不可用，请稍后重试";
        case StatusId::kRecordingIncomplete:
            return "录音不完整，请重新发言";
        case StatusId::kAudioCapacity:
            return "录音缓存已满，请稍后重试";
        case StatusId::kMediationFailed:
            return "调解失败，请稍后重试";
    }
    return "调解失败，请稍后重试";
}

void MediationStateMachine::CancelEndStatus() {
    end_status_active_ = false;
    end_status_deadline_ms_ = 0;
}

ActionBatch MediationStateMachine::StartNewCase() {
    ActionBatch batch{};
    ++case_generation_;
    if (case_generation_ == 0) {
        ++case_generation_;
    }
    has_case_ = true;
    completed_a_ = 0;
    completed_b_ = 0;
    state_ = MediationState::kWaiting;
    CancelEndStatus();
    AddAction(batch, ActionType::kNewCase, Speaker::kNone, StatusId::kWaiting,
              0, case_generation_);
    AddAction(batch, ActionType::kShowStatus, Speaker::kNone, StatusId::kWaiting);
    return batch;
}

ActionBatch MediationStateMachine::StartOrStopSpeaker(Button button) {
    ActionBatch batch{};
    const Speaker requested = button == Button::kPersonA ? Speaker::kA : Speaker::kB;
    const MediationState requested_state = requested == Speaker::kA
        ? MediationState::kRecordingA : MediationState::kRecordingB;
    const StatusId requested_status = requested == Speaker::kA
        ? StatusId::kRecordingA : StatusId::kRecordingB;

    if (state_ == MediationState::kWelcome) {
        AddAction(batch, ActionType::kVibrate, Speaker::kNone, StatusId::kWaiting,
                  kErrorVibrateMs);
        AddAction(batch, ActionType::kShowStatus, Speaker::kNone, StatusId::kNeedCase);
        return batch;
    }

    if (state_ == MediationState::kWaiting) {
        CancelEndStatus();
        state_ = requested_state;
        AddAction(batch, ActionType::kStartRecording, requested);
        AddAction(batch, ActionType::kShowStatus, Speaker::kNone, requested_status);
        return batch;
    }

    const Speaker active = RecordingSpeaker(state_);
    if (active == requested) {
        state_ = MediationState::kWaiting;
        CancelEndStatus();
        AddAction(batch, ActionType::kStopRecording, active);
        AddAction(batch, ActionType::kShowStatus, Speaker::kNone, StatusId::kWaiting);
        return batch;
    }

    AddAction(batch, ActionType::kVibrate, Speaker::kNone, StatusId::kWaiting,
              kErrorVibrateMs);
    return batch;
}

ActionBatch MediationStateMachine::HandleLongPress() {
    ActionBatch batch{};
    const Speaker active = RecordingSpeaker(state_);
    const bool completing_a = active == Speaker::kA;
    const bool completing_b = active == Speaker::kB;
    if (active != Speaker::kNone) {
        AddAction(batch, ActionType::kStopRecording, active);
        state_ = MediationState::kWaiting;
    }

    if (!has_case_) {
        CancelEndStatus();
        AddAction(batch, ActionType::kVibrate, Speaker::kNone, StatusId::kWaiting,
                  kErrorVibrateMs);
        AddAction(batch, ActionType::kShowStatus, Speaker::kNone, StatusId::kNeedCase);
        return batch;
    }

    if (state_ == MediationState::kMediating) {
        return batch;
    }
    if (state_ == MediationState::kPlaying ||
        state_ == MediationState::kRecoverableError) {
        AddAction(batch, ActionType::kVibrate, Speaker::kNone, StatusId::kWaiting,
                  kErrorVibrateMs);
        return batch;
    }

    CancelEndStatus();
    // A long press while recording promises to close and save that utterance
    // before mediation.  Treat the just-stopped speaker as provisionally
    // present; the board defers the cloud request until its durable ACK and
    // transcript arrive, and aborts the remaining actions if local stop fails.
    if ((completed_a_ == 0 && !completing_a) ||
        (completed_b_ == 0 && !completing_b)) {
        AddAction(batch, ActionType::kVibrate, Speaker::kNone, StatusId::kWaiting,
                  kErrorVibrateMs);
        AddAction(batch, ActionType::kShowStatus, Speaker::kNone,
                  StatusId::kNeedBothStatements);
        return batch;
    }

    state_ = MediationState::kMediating;
    AddAction(batch, ActionType::kRequestMediation, Speaker::kNone,
              StatusId::kWaiting, 0, case_generation_);
    AddAction(batch, ActionType::kShowStatus, Speaker::kNone, StatusId::kMediating);
    return batch;
}

ActionBatch MediationStateMachine::HandleButtonPressed(const Event& event) {
    if (event.button == Button::kCase) {
        if (!case_button_down_) {
            case_button_down_ = true;
            case_long_fired_ = false;
            case_pressed_at_ms_ = event.now_ms;
            short_press_allowed_at_press_ = ShortCaseAllowed(state_);
        }
        return ActionBatch{};
    }
    return StartOrStopSpeaker(event.button);
}

ActionBatch MediationStateMachine::HandleButtonReleased(const Event& event) {
    if (event.button != Button::kCase || !case_button_down_) {
        return ActionBatch{};
    }

    const bool reached_long = event.now_ms - case_pressed_at_ms_ >= kLongPressMs;
    ActionBatch batch{};
    if (!case_long_fired_ && reached_long) {
        case_long_fired_ = true;
        batch = HandleLongPress();
    } else if (!case_long_fired_) {
        if (short_press_allowed_at_press_ && ShortCaseAllowed(state_)) {
            if (event.allow_new_case) {
                batch = StartNewCase();
            } else {
                AddAction(batch, ActionType::kVibrate, Speaker::kNone,
                          StatusId::kWaiting, kErrorVibrateMs);
            }
        } else {
            AddAction(batch, ActionType::kVibrate, Speaker::kNone,
                      StatusId::kWaiting, kErrorVibrateMs);
        }
    }
    case_button_down_ = false;
    case_long_fired_ = false;
    short_press_allowed_at_press_ = false;
    return batch;
}

ActionBatch MediationStateMachine::Handle(const Event& event) {
    if (event.now_ms < last_now_ms_) {
        return ActionBatch{};
    }
    last_now_ms_ = event.now_ms;

    if (event.type == EventType::kBoot) {
        state_ = MediationState::kWelcome;
        completed_a_ = 0;
        completed_b_ = 0;
        case_generation_ = 0;
        has_case_ = false;
        case_button_down_ = false;
        case_long_fired_ = false;
        short_press_allowed_at_press_ = false;
        CancelEndStatus();
        ActionBatch batch{};
        AddAction(batch, ActionType::kShowStatus, Speaker::kNone, StatusId::kWelcome);
        return batch;
    }

    if (event.type == EventType::kButtonPressed) {
        return HandleButtonPressed(event);
    }
    if (event.type == EventType::kButtonReleased) {
        return HandleButtonReleased(event);
    }

    if (event.type == EventType::kTick) {
        if (case_button_down_ && !case_long_fired_ &&
            event.now_ms - case_pressed_at_ms_ >= kLongPressMs) {
            case_long_fired_ = true;
            return HandleLongPress();
        }
        if (state_ == MediationState::kWaiting && end_status_active_ &&
            event.now_ms >= end_status_deadline_ms_) {
            CancelEndStatus();
            ActionBatch batch{};
            AddAction(batch, ActionType::kShowStatus, Speaker::kNone, StatusId::kWaiting);
            return batch;
        }
        return ActionBatch{};
    }

    const bool generation_matches = has_case_ &&
        event.case_generation == case_generation_;

    if (event.type == EventType::kSegmentDurableAck) {
        if (!generation_matches || event.speaker == Speaker::kNone) {
            return ActionBatch{};
        }
        uint16_t* completed = event.speaker == Speaker::kA ? &completed_a_ : &completed_b_;
        if (*completed != std::numeric_limits<uint16_t>::max()) {
            ++(*completed);
        }
        if (state_ != MediationState::kWaiting) {
            return ActionBatch{};
        }
        end_status_active_ = true;
        end_status_deadline_ms_ = DeadlineAfter(event.now_ms, kEndStatusMs);
        ActionBatch batch{};
        AddAction(batch, ActionType::kShowStatus, Speaker::kNone,
                  event.speaker == Speaker::kA
                      ? StatusId::kStatementEndedA : StatusId::kStatementEndedB);
        return batch;
    }

    if (event.type == EventType::kAudioStart) {
        if (!generation_matches || state_ != MediationState::kMediating) {
            return ActionBatch{};
        }
        CancelEndStatus();
        state_ = MediationState::kPlaying;
        return ActionBatch{};
    }

    if (event.type == EventType::kAudioEnd) {
        if (!generation_matches || state_ != MediationState::kPlaying) {
            return ActionBatch{};
        }
        state_ = MediationState::kWaiting;
        CancelEndStatus();
        ActionBatch batch{};
        AddAction(batch, ActionType::kShowStatus, Speaker::kNone, StatusId::kWaiting);
        return batch;
    }

    if (event.type == EventType::kRecoverableError) {
        if (has_case_ && !generation_matches) {
            return ActionBatch{};
        }
        ActionBatch batch{};
        const Speaker active = RecordingSpeaker(state_);
        if (active != Speaker::kNone) {
            AddAction(batch, ActionType::kStopRecording, active);
        }
        state_ = MediationState::kRecoverableError;
        CancelEndStatus();
        AddAction(batch, ActionType::kVibrate, Speaker::kNone, StatusId::kWaiting,
                  kErrorVibrateMs);
        AddAction(batch, ActionType::kShowStatus, Speaker::kNone,
                  ErrorStatus(event.error));
        return batch;
    }

    if (event.type == EventType::kRecovered &&
        state_ == MediationState::kRecoverableError) {
        state_ = has_case_ ? MediationState::kWaiting : MediationState::kWelcome;
        CancelEndStatus();
        ActionBatch batch{};
        AddAction(batch, ActionType::kShowStatus, Speaker::kNone,
                  has_case_ ? StatusId::kWaiting : StatusId::kWelcome);
        return batch;
    }

    return ActionBatch{};
}

void ButtonDebouncer::Reset(uint64_t now_ms, uint8_t pressed_mask) {
    for (uint8_t index = 0; index < 3; ++index) {
        const bool pressed = (pressed_mask & (1U << index)) != 0;
        slots_[index].candidate_since_ms = now_ms;
        slots_[index].candidate_pressed = pressed;
        slots_[index].stable_pressed = pressed;
    }
    last_now_ms_ = now_ms;
    initialized_ = true;
}

ButtonEventBatch ButtonDebouncer::Sample(uint64_t now_ms, uint8_t pressed_mask) {
    ButtonEventBatch batch{};
    if (!initialized_) {
        Reset(now_ms, pressed_mask);
        return batch;
    }
    if (now_ms < last_now_ms_) {
        return batch;
    }
    last_now_ms_ = now_ms;

    constexpr Button kButtons[3] = {
        Button::kCase, Button::kPersonA, Button::kPersonB};
    for (uint8_t index = 0; index < 3; ++index) {
        Slot& slot = slots_[index];
        const bool pressed = (pressed_mask & (1U << index)) != 0;
        if (pressed != slot.candidate_pressed) {
            slot.candidate_pressed = pressed;
            slot.candidate_since_ms = now_ms;
            continue;
        }
        if (pressed == slot.stable_pressed ||
            now_ms - slot.candidate_since_ms < kDebounceMs) {
            continue;
        }
        slot.stable_pressed = pressed;
        assert(batch.count < kMaxButtonEvents);
        Event& event = batch.items[batch.count++];
        event.type = pressed ? EventType::kButtonPressed : EventType::kButtonReleased;
        event.now_ms = now_ms;
        event.button = kButtons[index];
    }
    return batch;
}

}  // namespace xiaoli
