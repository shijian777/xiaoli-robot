#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "agent_link_transport.h"
#include "esp_err.h"

namespace xiaoli::wifi {

constexpr size_t kTxItemCapacity = 40;
constexpr size_t kAudioItemCapacity = 32;
constexpr size_t kTxByteCapacity = 96 * 1024;
constexpr uint32_t kReservedAdmissionWaitMs = 200;
constexpr size_t kTextMessageCapacity = UINT16_MAX;
constexpr size_t kBinaryMessageCapacity = 8 + UINT16_MAX;
constexpr size_t kVoiceChunkCapacity = 4096;

struct HelloIdentity {
    std::string mac12;
    std::string boot_nonce8;
    uint32_t client_generation;
    std::string firmware_version;
    std::string token;
};

bool BuildHelloJson(const HelloIdentity& identity, std::string& json,
                    std::string& message_id, std::string& device_id);
bool IsMatchingHelloAck(const uint8_t* data, size_t len,
                        const std::string& message_id,
                        const std::string& device_id);

struct OutboundMessage {
    bool text = false;
    std::vector<uint8_t> payload;
};

esp_err_t EncodeControl(const uint8_t* frame, size_t len, OutboundMessage& output);

enum class TxClass : uint8_t { kAudioChunk, kReserved };

class TxQueuePolicy {
public:
    bool CanAdmit(TxClass tx_class, size_t bytes) const;
    bool Admit(TxClass tx_class, size_t bytes);
    void Release(TxClass tx_class, size_t bytes);
    void Reset();

    size_t queued_items() const { return queued_items_; }
    size_t queued_audio_items() const { return queued_audio_items_; }
    size_t queued_bytes() const { return queued_bytes_; }

private:
    size_t queued_items_ = 0;
    size_t queued_audio_items_ = 0;
    size_t queued_bytes_ = 0;
};

class PublicCallBarrier {
public:
    void Open();
    void Close();
    bool TryEnter();
    size_t Exit();
    size_t in_flight() const;

private:
    static constexpr size_t kClosed = size_t{1} << (sizeof(size_t) * 8 - 1);
    static constexpr size_t kCountMask = ~kClosed;
    std::atomic<size_t> state_{kClosed};
};

class UplinkStreams {
public:
    esp_err_t Start(agent_stream_t type, const uint8_t* meta, size_t meta_len,
                    std::vector<uint8_t>& wire);
    esp_err_t PrepareChunk(agent_stream_t type, const uint8_t* data, size_t len,
                           std::vector<uint8_t>& wire) const;
    void CommitChunk(agent_stream_t type, size_t len);
    esp_err_t PrepareEnd(agent_stream_t type, bool complete, const uint8_t* meta,
                         size_t meta_len, std::vector<uint8_t>& wire) const;
    void CommitEnd(agent_stream_t type);
    void Reset(agent_stream_t type);
    void ResetAll();

    bool active(agent_stream_t type) const;
    uint32_t next_chunk(agent_stream_t type) const;
    size_t admitted_bytes(agent_stream_t type) const;

private:
    struct State {
        bool active = false;
        uint32_t next_chunk = 0;
        size_t bytes = 0;
        std::string message_id;
        std::string case_id;
        std::string segment_id;
    };

    static bool ValidType(agent_stream_t type);
    State& At(agent_stream_t type);
    const State& At(agent_stream_t type) const;
    std::array<State, 5> states_{};
};

enum class FragmentResult : uint8_t { kPending, kComplete, kRejected };

struct CompleteMessage {
    bool text = false;
    std::vector<uint8_t> payload;
};

class FragmentAssembler {
public:
    FragmentResult Append(uint8_t opcode, bool fin, size_t payload_len,
                          size_t payload_offset, const uint8_t* data,
                          size_t data_len, CompleteMessage& complete);
    void Reset();

private:
    bool active_ = false;
    bool text_ = false;
    bool frame_open_ = false;
    size_t frame_len_ = 0;
    size_t frame_received_ = 0;
    std::vector<uint8_t> payload_;
};

class VoiceRxTracker {
public:
    void OnAudioStart();
    void OnAudioEnd();
    bool AcceptChunk(agent_stream_t type, uint8_t flags, uint16_t sequence,
                     size_t payload_len);
    bool AcceptEnd(uint16_t sequence, bool complete);
    void Reset();
    bool active() const { return active_; }

private:
    bool active_ = false;
    uint32_t next_chunk_ = 0;
};

using EndpointResolver = esp_err_t (*)(const char* host, uint32_t timeout_ms,
                                       uint32_t* ipv4_be, void* context);
using EndpointInitializer = esp_err_t (*)(void* context);

esp_err_t ResolveEndpoint(const char* endpoint, EndpointResolver resolver,
                          void* context, std::string& resolved);
esp_err_t ResolveEndpointWithMdnsOwnership(const char* endpoint,
                                            EndpointResolver resolver,
                                            EndpointInitializer initializer,
                                            void* context, bool& owned,
                                            std::string& resolved);

}  // namespace xiaoli::wifi
