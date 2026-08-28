#include "bridge_message.h"

#include <cmath>
#include <cstring>

#include "cJSON.h"

namespace xiaoli {
namespace {

const cJSON* Field(const cJSON* object, const char* name) {
    return cJSON_GetObjectItemCaseSensitive(object, name);
}

bool NumberInRange(const cJSON* item, uint32_t maximum, uint32_t* value) {
    if (!cJSON_IsNumber(item) || !std::isfinite(item->valuedouble) ||
        item->valuedouble < 0 || item->valuedouble > maximum ||
        std::floor(item->valuedouble) != item->valuedouble) {
        return false;
    }
    *value = static_cast<uint32_t>(item->valuedouble);
    return true;
}

template <size_t N>
bool CopyRequiredString(const cJSON* object, const char* name, char (&output)[N]) {
    const cJSON* item = Field(object, name);
    if (!cJSON_IsString(item) || item->valuestring == nullptr ||
        item->valuestring[0] == '\0') {
        return false;
    }
    const size_t length = std::strlen(item->valuestring);
    if (length >= N) {
        return false;
    }
    std::memcpy(output, item->valuestring, length + 1);
    return true;
}

template <size_t N>
bool CopyOptionalString(const cJSON* object, const char* name, char (&output)[N]) {
    const cJSON* item = Field(object, name);
    if (item == nullptr) {
        output[0] = '\0';
        return true;
    }
    return CopyRequiredString(object, name, output);
}

bool OptionalBool(const cJSON* object, const char* name, bool* present,
                  bool* value) {
    const cJSON* item = Field(object, name);
    if (item == nullptr) {
        *present = false;
        *value = false;
        return true;
    }
    if (!cJSON_IsBool(item)) {
        return false;
    }
    *present = true;
    *value = cJSON_IsTrue(item);
    return true;
}

bool OptionalUint32(const cJSON* object, const char* name, bool* present,
                    uint32_t* value) {
    const cJSON* item = Field(object, name);
    if (item == nullptr) {
        *present = false;
        *value = 0;
        return true;
    }
    *present = true;
    return NumberInRange(item, UINT32_MAX, value);
}

bool ParseAck(const cJSON* root, BridgeMessage* out) {
    out->type = BridgeMessageType::kAck;
    if (!CopyRequiredString(root, "messageId", out->message_id) ||
        !CopyRequiredString(root, "caseId", out->case_id) ||
        !CopyOptionalString(root, "segmentId", out->segment_id) ||
        !OptionalBool(root, "accepted", &out->has_accepted, &out->accepted) ||
        !OptionalBool(root, "durable", &out->has_durable, &out->durable) ||
        !OptionalUint32(root, "bytes", &out->has_bytes, &out->bytes)) {
        return false;
    }
    if (!out->has_accepted && !out->has_durable) {
        return false;
    }
    if (out->has_durable &&
        (out->segment_id[0] == '\0' || !out->has_bytes)) {
        return false;
    }
    return true;
}

bool ParseState(const cJSON* root, BridgeMessage* out) {
    out->type = BridgeMessageType::kState;
    char state[24] = {};
    if (!CopyRequiredString(root, "state", state) ||
        !CopyOptionalString(root, "caseId", out->case_id) ||
        !CopyOptionalString(root, "segmentId", out->segment_id)) {
        return false;
    }
    if (std::strcmp(state, "waiting") == 0) out->state = BridgeState::kWaiting;
    else if (std::strcmp(state, "recording") == 0) out->state = BridgeState::kRecording;
    else if (std::strcmp(state, "transcribing") == 0) out->state = BridgeState::kTranscribing;
    else if (std::strcmp(state, "mediating") == 0) out->state = BridgeState::kMediating;
    else if (std::strcmp(state, "playing") == 0) out->state = BridgeState::kPlaying;
    else if (std::strcmp(state, "error") == 0) out->state = BridgeState::kError;
    else return false;
    return true;
}

bool ParseTranscript(const cJSON* root, BridgeMessage* out) {
    out->type = BridgeMessageType::kTranscriptSaved;
    char speaker[2] = {};
    if (!CopyRequiredString(root, "caseId", out->case_id) ||
        !CopyRequiredString(root, "segmentId", out->segment_id) ||
        !CopyRequiredString(root, "speaker", speaker)) {
        return false;
    }
    if (std::strcmp(speaker, "A") == 0) out->speaker = Speaker::kA;
    else if (std::strcmp(speaker, "B") == 0) out->speaker = Speaker::kB;
    else return false;
    return true;
}

bool ParseAudioStart(const cJSON* root, BridgeMessage* out) {
    out->type = BridgeMessageType::kAudioStart;
    const cJSON* audio = Field(root, "audio");
    uint32_t bits = 0;
    uint32_t channels = 0;
    if (!CopyRequiredString(root, "caseId", out->case_id) ||
        !OptionalUint32(root, "bytes", &out->has_bytes, &out->bytes) ||
        !out->has_bytes || !cJSON_IsObject(audio) ||
        !NumberInRange(Field(audio, "sampleRate"), UINT32_MAX,
                       &out->sample_rate) ||
        !NumberInRange(Field(audio, "bits"), UINT8_MAX, &bits) ||
        !NumberInRange(Field(audio, "channels"), UINT8_MAX, &channels)) {
        return false;
    }
    out->bits = static_cast<uint8_t>(bits);
    out->channels = static_cast<uint8_t>(channels);
    return true;
}

bool ParseAudioEnd(const cJSON* root, BridgeMessage* out) {
    out->type = BridgeMessageType::kAudioEnd;
    uint32_t last_sequence = 0;
    if (!CopyRequiredString(root, "caseId", out->case_id) ||
        !OptionalUint32(root, "bytes", &out->has_bytes, &out->bytes) ||
        !out->has_bytes ||
        !NumberInRange(Field(root, "lastSequence"), UINT16_MAX,
                       &last_sequence) ||
        !OptionalBool(root, "complete", &out->has_complete, &out->complete) ||
        !out->has_complete) {
        return false;
    }
    out->has_last_sequence = true;
    out->last_sequence = static_cast<uint16_t>(last_sequence);
    return true;
}

bool ParseError(const cJSON* root, BridgeMessage* out) {
    out->type = BridgeMessageType::kError;
    return CopyRequiredString(root, "code", out->code) &&
           CopyOptionalString(root, "caseId", out->case_id) &&
           CopyOptionalString(root, "segmentId", out->segment_id) &&
           OptionalBool(root, "retryable", &out->has_retryable,
                        &out->retryable) && out->has_retryable;
}

bool OnlyWhitespace(const char* cursor, const char* end) {
    while (cursor < end) {
        const char c = *cursor++;
        if (c != ' ' && c != '\t' && c != '\r' && c != '\n') {
            return false;
        }
    }
    return true;
}

}  // namespace

BridgeParseResult ParseBridgeMessage(const uint8_t* payload, size_t len,
                                     BridgeMessage* message) {
    if (message == nullptr || payload == nullptr || len == 0) {
        return BridgeParseResult::kInvalid;
    }
    if (len > kMaxBridgeMessageBytes) {
        return BridgeParseResult::kOversized;
    }
    char copy[kMaxBridgeMessageBytes + 1] = {};
    std::memcpy(copy, payload, len);
    copy[len] = '\0';
    const char* parse_end = nullptr;
    cJSON* root = cJSON_ParseWithLengthOpts(copy, len + 1, &parse_end, false);
    if (root == nullptr || parse_end == nullptr ||
        !OnlyWhitespace(parse_end, copy + len) || !cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return BridgeParseResult::kInvalid;
    }

    BridgeMessage parsed{};
    uint32_t version = 0;
    char type[32] = {};
    bool valid = NumberInRange(Field(root, "v"), UINT32_MAX, &version) &&
                 version == 1 && CopyRequiredString(root, "type", type);
    BridgeParseResult result = BridgeParseResult::kInvalid;
    if (valid) {
        if (std::strcmp(type, "ack") == 0) valid = ParseAck(root, &parsed);
        else if (std::strcmp(type, "state") == 0) valid = ParseState(root, &parsed);
        else if (std::strcmp(type, "transcript.saved") == 0) valid = ParseTranscript(root, &parsed);
        else if (std::strcmp(type, "audio.start") == 0) valid = ParseAudioStart(root, &parsed);
        else if (std::strcmp(type, "audio.end") == 0) valid = ParseAudioEnd(root, &parsed);
        else if (std::strcmp(type, "error") == 0) valid = ParseError(root, &parsed);
        else {
            parsed.type = BridgeMessageType::kUnknown;
            result = BridgeParseResult::kUnknown;
        }
        if (result != BridgeParseResult::kUnknown) {
            result = valid ? BridgeParseResult::kOk : BridgeParseResult::kInvalid;
        }
    }
    cJSON_Delete(root);
    if (result == BridgeParseResult::kOk ||
        result == BridgeParseResult::kUnknown) {
        *message = parsed;
    }
    return result;
}

}  // namespace xiaoli
