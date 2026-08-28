#include "wifi_transport_utils.h"

#include <cstdio>
#include <cstring>
#include <limits>
#include <utility>

#include "cJSON.h"
#include "protocol.h"
#include "wifi_wire.h"

namespace xiaoli::wifi {
namespace {

bool AddString(cJSON* object, const char* name, const std::string& value) {
    return cJSON_AddStringToObject(object, name, value.c_str()) != nullptr;
}

bool JsonString(cJSON* object, const char* name, std::string& output) {
    cJSON* value = cJSON_GetObjectItemCaseSensitive(object, name);
    if (!cJSON_IsString(value) || value->valuestring == nullptr || value->valuestring[0] == '\0') {
        return false;
    }
    output = value->valuestring;
    return true;
}

bool JsonStringEquals(cJSON* object, const char* name, const std::string& expected) {
    cJSON* value = cJSON_GetObjectItemCaseSensitive(object, name);
    return cJSON_IsString(value) && value->valuestring != nullptr &&
           expected == value->valuestring;
}

bool JsonNumberEquals(cJSON* object, const char* name, int expected) {
    cJSON* value = cJSON_GetObjectItemCaseSensitive(object, name);
    return cJSON_IsNumber(value) && value->valuedouble == expected;
}

bool Encode(xiaoli::WireKind kind, agent_stream_t type, uint8_t flags,
            uint16_t sequence, const uint8_t* payload, size_t payload_len,
            std::vector<uint8_t>& output) {
    return xiaoli::EncodeWireFrame(
        {kind, static_cast<uint8_t>(type), flags, sequence, payload, payload_len}, output);
}

bool ParseRecordingStart(const uint8_t* meta, size_t meta_len,
                         std::string& message_id, std::string& case_id,
                         std::string& segment_id) {
    if (meta == nullptr || meta_len == 0 || meta_len > UINT16_MAX) return false;
    cJSON* root = cJSON_ParseWithLength(reinterpret_cast<const char*>(meta), meta_len);
    if (!cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return false;
    }
    const bool ok = JsonNumberEquals(root, "v", 1) &&
                    JsonStringEquals(root, "type", "speech.start") &&
                    JsonString(root, "messageId", message_id) &&
                    JsonString(root, "caseId", case_id) &&
                    JsonString(root, "segmentId", segment_id);
    cJSON_Delete(root);
    return ok;
}

bool BuildRecordingEnd(const std::string& message_id, const std::string& case_id,
                       const std::string& segment_id, size_t bytes,
                       uint32_t next_chunk, bool complete,
                       std::vector<uint8_t>& payload) {
    cJSON* root = cJSON_CreateObject();
    if (root == nullptr) return false;
    const std::string end_id = message_id + "-end";
    bool ok = cJSON_AddNumberToObject(root, "v", 1) != nullptr &&
              cJSON_AddStringToObject(root, "type", "speech.end") != nullptr &&
              AddString(root, "messageId", end_id) &&
              AddString(root, "caseId", case_id) &&
              AddString(root, "segmentId", segment_id) &&
              cJSON_AddNumberToObject(root, "bytes", static_cast<double>(bytes)) != nullptr &&
              cJSON_AddNumberToObject(root, "lastSequence",
                                      next_chunk == 0 ? 0 : next_chunk - 1) != nullptr &&
              cJSON_AddBoolToObject(root, "complete", complete) != nullptr;
    char* printed = ok ? cJSON_PrintUnformatted(root) : nullptr;
    cJSON_Delete(root);
    if (printed == nullptr) return false;
    const size_t len = strlen(printed);
    if (len > UINT16_MAX) {
        cJSON_free(printed);
        return false;
    }
    payload.assign(reinterpret_cast<uint8_t*>(printed),
                   reinterpret_cast<uint8_t*>(printed) + len);
    cJSON_free(printed);
    return true;
}

}  // namespace

bool BuildHelloJson(const HelloIdentity& identity, std::string& json,
                    std::string& message_id, std::string& device_id) {
    json.clear();
    if (identity.mac12.size() != 12 || identity.boot_nonce8.size() != 8 ||
        identity.firmware_version.empty() || identity.token.empty()) {
        return false;
    }
    char generation[11] = {};
    snprintf(generation, sizeof(generation), "%lu",
             static_cast<unsigned long>(identity.client_generation));
    message_id = "hello-" + identity.mac12 + "-" + identity.boot_nonce8 + "-" + generation;
    device_id = "xiaoli-" + identity.mac12;

    cJSON* root = cJSON_CreateObject();
    cJSON* caps = cJSON_CreateArray();
    bool ok = root != nullptr && caps != nullptr &&
              cJSON_AddNumberToObject(root, "v", 1) != nullptr &&
              cJSON_AddStringToObject(root, "type", "hello") != nullptr &&
              AddString(root, "messageId", message_id) &&
              AddString(root, "deviceId", device_id) &&
              AddString(root, "firmwareVersion", identity.firmware_version) &&
              AddString(root, "token", identity.token) &&
              cJSON_AddItemToArray(caps, cJSON_CreateString("recording")) &&
              cJSON_AddItemToArray(caps, cJSON_CreateString("voice"));
    if (ok) cJSON_AddItemToObject(root, "capabilities", caps);
    else cJSON_Delete(caps);
    char* printed = ok ? cJSON_PrintUnformatted(root) : nullptr;
    cJSON_Delete(root);
    if (printed == nullptr) return false;
    json.assign(printed);
    cJSON_free(printed);
    return true;
}

bool IsMatchingHelloAck(const uint8_t* data, size_t len,
                        const std::string& message_id,
                        const std::string& device_id) {
    if (data == nullptr || len == 0) return false;
    cJSON* root = cJSON_ParseWithLength(reinterpret_cast<const char*>(data), len);
    if (!cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return false;
    }
    const bool ok = JsonNumberEquals(root, "v", 1) &&
                    JsonStringEquals(root, "type", "hello.ack") &&
                    JsonStringEquals(root, "messageId", message_id) &&
                    JsonStringEquals(root, "deviceId", device_id) &&
                    JsonNumberEquals(root, "protocol", 1);
    cJSON_Delete(root);
    return ok;
}

esp_err_t EncodeControl(const uint8_t* frame, size_t len, OutboundMessage& output) {
    output = {};
    agentlink::Frame parsed;
    if (!agentlink::ParseFrame(frame, len, parsed)) return ESP_ERR_INVALID_ARG;
    if (parsed.msg_type == agentlink::kMsgEvent && parsed.command_id == 0x64) {
        output.text = true;
        output.payload = std::move(parsed.payload);
        return ESP_OK;
    }
    if (!Encode(xiaoli::WireKind::kControl, AGENT_STREAM_VOICE, 0, 0,
                frame, len, output.payload)) {
        return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
}

bool TxQueuePolicy::CanAdmit(TxClass tx_class, size_t bytes) const {
    if (queued_items_ >= kTxItemCapacity || bytes > kTxByteCapacity - queued_bytes_) {
        return false;
    }
    return tx_class != TxClass::kAudioChunk || queued_audio_items_ < kAudioItemCapacity;
}

bool TxQueuePolicy::Admit(TxClass tx_class, size_t bytes) {
    if (!CanAdmit(tx_class, bytes)) return false;
    ++queued_items_;
    if (tx_class == TxClass::kAudioChunk) ++queued_audio_items_;
    queued_bytes_ += bytes;
    return true;
}

void TxQueuePolicy::Release(TxClass tx_class, size_t bytes) {
    if (queued_items_ == 0 || bytes > queued_bytes_) return;
    --queued_items_;
    if (tx_class == TxClass::kAudioChunk && queued_audio_items_ > 0) {
        --queued_audio_items_;
    }
    queued_bytes_ -= bytes;
}

void TxQueuePolicy::Reset() {
    queued_items_ = 0;
    queued_audio_items_ = 0;
    queued_bytes_ = 0;
}

void PublicCallBarrier::Open() {
    state_.store(0, std::memory_order_release);
}

void PublicCallBarrier::Close() {
    state_.fetch_or(kClosed, std::memory_order_acq_rel);
}

bool PublicCallBarrier::TryEnter() {
    size_t state = state_.load(std::memory_order_acquire);
    while ((state & kClosed) == 0) {
        if ((state & kCountMask) == kCountMask) return false;
        if (state_.compare_exchange_weak(
                state, state + 1, std::memory_order_acq_rel, std::memory_order_acquire)) {
            return true;
        }
    }
    return false;
}

size_t PublicCallBarrier::Exit() {
    return (state_.fetch_sub(1, std::memory_order_acq_rel) & kCountMask) - 1;
}

size_t PublicCallBarrier::in_flight() const {
    return state_.load(std::memory_order_acquire) & kCountMask;
}

bool UplinkStreams::ValidType(agent_stream_t type) {
    return static_cast<unsigned>(type) < 5;
}

UplinkStreams::State& UplinkStreams::At(agent_stream_t type) {
    return states_[static_cast<size_t>(type)];
}

const UplinkStreams::State& UplinkStreams::At(agent_stream_t type) const {
    return states_[static_cast<size_t>(type)];
}

esp_err_t UplinkStreams::Start(agent_stream_t type, const uint8_t* meta, size_t meta_len,
                               std::vector<uint8_t>& wire) {
    if (!ValidType(type) || (meta_len > 0 && meta == nullptr) || meta_len > UINT16_MAX) {
        return ESP_ERR_INVALID_ARG;
    }
    State& state = At(type);
    if (state.active) return ESP_ERR_INVALID_STATE;
    State next;
    next.active = true;
    if (type == AGENT_STREAM_RECORDING &&
        !ParseRecordingStart(meta, meta_len, next.message_id, next.case_id, next.segment_id)) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!Encode(xiaoli::WireKind::kStreamStart, type, 0, 0, meta, meta_len, wire)) {
        return ESP_ERR_INVALID_SIZE;
    }
    state = std::move(next);
    return ESP_OK;
}

esp_err_t UplinkStreams::PrepareChunk(agent_stream_t type, const uint8_t* data, size_t len,
                                      std::vector<uint8_t>& wire) const {
    if (!ValidType(type) || (len > 0 && data == nullptr)) return ESP_ERR_INVALID_ARG;
    const State& state = At(type);
    if (!state.active) return ESP_ERR_INVALID_STATE;
    if (state.next_chunk > UINT16_MAX || len > UINT16_MAX) return ESP_ERR_INVALID_SIZE;
    if (!Encode(xiaoli::WireKind::kStreamChunk, type, 0,
                static_cast<uint16_t>(state.next_chunk), data, len, wire)) {
        return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
}

void UplinkStreams::CommitChunk(agent_stream_t type, size_t len) {
    if (!ValidType(type)) return;
    State& state = At(type);
    if (!state.active || state.next_chunk > UINT16_MAX ||
        len > std::numeric_limits<size_t>::max() - state.bytes) return;
    ++state.next_chunk;
    state.bytes += len;
}

esp_err_t UplinkStreams::PrepareEnd(agent_stream_t type, bool complete, const uint8_t* meta,
                                    size_t meta_len, std::vector<uint8_t>& wire) const {
    if (!ValidType(type) || (meta_len > 0 && meta == nullptr) || meta_len > UINT16_MAX) {
        return ESP_ERR_INVALID_ARG;
    }
    const State& state = At(type);
    if (!state.active) return ESP_ERR_INVALID_STATE;
    if (complete && state.next_chunk == 0) return ESP_ERR_INVALID_STATE;
    const uint16_t last = state.next_chunk == 0 ? 0 : static_cast<uint16_t>(state.next_chunk - 1);
    std::vector<uint8_t> generated;
    if (type == AGENT_STREAM_RECORDING) {
        if (!BuildRecordingEnd(state.message_id, state.case_id, state.segment_id,
                               state.bytes, state.next_chunk, complete, generated)) {
            return ESP_ERR_NO_MEM;
        }
        meta = generated.data();
        meta_len = generated.size();
    }
    if (!Encode(xiaoli::WireKind::kStreamEnd, type, complete ? 1 : 0, last,
                meta, meta_len, wire)) {
        return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
}

void UplinkStreams::CommitEnd(agent_stream_t type) { Reset(type); }

void UplinkStreams::Reset(agent_stream_t type) {
    if (ValidType(type)) At(type) = {};
}

void UplinkStreams::ResetAll() {
    for (auto& state : states_) state = {};
}

bool UplinkStreams::active(agent_stream_t type) const {
    return ValidType(type) && At(type).active;
}

uint32_t UplinkStreams::next_chunk(agent_stream_t type) const {
    return ValidType(type) ? At(type).next_chunk : 0;
}

size_t UplinkStreams::admitted_bytes(agent_stream_t type) const {
    return ValidType(type) ? At(type).bytes : 0;
}

FragmentResult FragmentAssembler::Append(uint8_t opcode, bool fin, size_t payload_len,
                                         size_t payload_offset, const uint8_t* data,
                                         size_t data_len, CompleteMessage& complete) {
    complete = {};
    if (data_len > 0 && data == nullptr) {
        Reset();
        return FragmentResult::kRejected;
    }
    if (payload_offset == 0) {
        if (opcode == 0x1 || opcode == 0x2) {
            if (active_) {
                Reset();
                return FragmentResult::kRejected;
            }
            active_ = true;
            text_ = opcode == 0x1;
            payload_.clear();
        } else if (opcode == 0x0) {
            if (!active_ || frame_open_) {
                Reset();
                return FragmentResult::kRejected;
            }
        } else {
            Reset();
            return FragmentResult::kRejected;
        }
        frame_open_ = true;
        frame_len_ = payload_len;
        frame_received_ = 0;
    } else if (!active_ || !frame_open_) {
        Reset();
        return FragmentResult::kRejected;
    }
    if (payload_offset != frame_received_ || payload_offset > payload_len ||
        data_len > payload_len - payload_offset ||
        payload_len != frame_len_) {
        Reset();
        return FragmentResult::kRejected;
    }
    const size_t cap = text_ ? kTextMessageCapacity : kBinaryMessageCapacity;
    if (data_len > cap - payload_.size()) {
        Reset();
        return FragmentResult::kRejected;
    }
    if (data_len > 0) payload_.insert(payload_.end(), data, data + data_len);
    frame_received_ += data_len;
    if (frame_received_ != frame_len_) return FragmentResult::kPending;
    frame_open_ = false;
    if (!fin) return FragmentResult::kPending;
    complete.text = text_;
    complete.payload = std::move(payload_);
    Reset();
    return FragmentResult::kComplete;
}

void FragmentAssembler::Reset() {
    active_ = false;
    text_ = false;
    frame_open_ = false;
    frame_len_ = 0;
    frame_received_ = 0;
    payload_.clear();
}

void VoiceRxTracker::OnAudioStart() {
    active_ = true;
    next_chunk_ = 0;
}

void VoiceRxTracker::OnAudioEnd() { Reset(); }

bool VoiceRxTracker::AcceptChunk(agent_stream_t type, uint8_t flags, uint16_t sequence,
                                 size_t payload_len) {
    if (!active_ || type != AGENT_STREAM_VOICE || flags != 0 ||
        payload_len > kVoiceChunkCapacity || sequence != next_chunk_) {
        return false;
    }
    ++next_chunk_;
    return true;
}

bool VoiceRxTracker::AcceptEnd(uint16_t sequence, bool complete) {
    if (!active_ || !complete || next_chunk_ == 0 || sequence != next_chunk_ - 1) {
        return false;
    }
    Reset();
    return true;
}

void VoiceRxTracker::Reset() {
    active_ = false;
    next_chunk_ = 0;
}

esp_err_t ResolveEndpoint(const char* endpoint, EndpointResolver resolver,
                          void* context, std::string& resolved) {
    resolved.clear();
    if (endpoint == nullptr || strncmp(endpoint, "ws://", 5) != 0) {
        return ESP_ERR_INVALID_ARG;
    }
    const char* authority = endpoint + 5;
    const char* path = strchr(authority, '/');
    if (path == nullptr || strcmp(path, "/device") != 0 || path == authority) {
        return ESP_ERR_INVALID_ARG;
    }
    const char* colon = static_cast<const char*>(memchr(authority, ':', path - authority));
    const char* host_end = colon ? colon : path;
    const std::string host(authority, host_end);
    if (host.size() < 7 || host.compare(host.size() - 6, 6, ".local") != 0) {
        resolved = endpoint;
        return ESP_OK;
    }
    if (resolver == nullptr) return ESP_ERR_INVALID_ARG;
    const std::string query = host.substr(0, host.size() - 6);
    if (query.empty()) return ESP_ERR_INVALID_ARG;
    uint32_t ipv4 = 0;
    esp_err_t result = resolver(query.c_str(), 2000, &ipv4, context);
    if (result != ESP_OK) return result;
    const uint8_t a = static_cast<uint8_t>(ipv4 >> 24);
    const uint8_t b = static_cast<uint8_t>(ipv4 >> 16);
    const uint8_t c = static_cast<uint8_t>(ipv4 >> 8);
    const uint8_t d = static_cast<uint8_t>(ipv4);
    const bool private_ip = a == 10 || (a == 172 && b >= 16 && b <= 31) ||
                            (a == 192 && b == 168);
    if (!private_ip) return ESP_ERR_INVALID_RESPONSE;
    char address[16] = {};
    snprintf(address, sizeof(address), "%u.%u.%u.%u", a, b, c, d);
    resolved = "ws://";
    resolved += address;
    if (colon != nullptr) resolved.append(colon, path);
    resolved += path;
    return ESP_OK;
}

esp_err_t ResolveEndpointWithMdnsOwnership(const char* endpoint,
                                            EndpointResolver resolver,
                                            EndpointInitializer initializer,
                                            void* context, bool& owned,
                                            std::string& resolved) {
    esp_err_t result = ResolveEndpoint(endpoint, resolver, context, resolved);
    if (result != ESP_ERR_INVALID_STATE) return result;
    if (initializer == nullptr) return ESP_ERR_INVALID_ARG;
    result = initializer(context);
    if (result != ESP_OK) return result;
    owned = true;
    return ResolveEndpoint(endpoint, resolver, context, resolved);
}

}  // namespace xiaoli::wifi
