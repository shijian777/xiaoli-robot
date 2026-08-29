#pragma once

#include <cstddef>
#include <cstdint>

#include "mediation_state.h"
#include "pending_audio_store.h"

namespace xiaoli {

inline constexpr size_t kMaxBridgeMessageBytes = 1024;
inline constexpr size_t kBridgeCodeCapacity = 48;

enum class BridgeParseResult : uint8_t { kOk, kUnknown, kInvalid, kOversized };

enum class BridgeMessageType : uint8_t {
    kUnknown,
    kAck,
    kState,
    kTranscriptSaved,
    kAudioStart,
    kAudioEnd,
    kError,
};

enum class BridgeState : uint8_t {
    kNone,
    kWaiting,
    kRecording,
    kTranscribing,
    kMediating,
    kPlaying,
    kError,
};

struct BridgeMessage {
    BridgeMessageType type = BridgeMessageType::kUnknown;
    char message_id[kIdCapacity] = {};
    char case_id[kIdCapacity] = {};
    char segment_id[kIdCapacity] = {};
    char mediation_message_id[kIdCapacity] = {};
    char code[kBridgeCodeCapacity] = {};
    Speaker speaker = Speaker::kNone;
    BridgeState state = BridgeState::kNone;
    uint32_t bytes = 0;
    uint16_t last_sequence = 0;
    uint32_t sample_rate = 0;
    uint8_t bits = 0;
    uint8_t channels = 0;
    bool has_accepted = false;
    bool accepted = false;
    bool has_durable = false;
    bool durable = false;
    bool has_bytes = false;
    bool has_last_sequence = false;
    bool has_complete = false;
    bool complete = false;
    bool has_retryable = false;
    bool retryable = false;
};

BridgeParseResult ParseBridgeMessage(const uint8_t* payload, size_t len,
                                     BridgeMessage* message);

}  // namespace xiaoli
