#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <type_traits>
#include <vector>

#include "bridge_message.h"
#include "config.h"
#include "mediation_state.h"
#include "mediation_runtime.h"
#include "pending_audio_store.h"
#include "protocol.h"
#include "unity.h"
#include "wifi_provision.h"
#include "wifi_transport_utils.h"
#include "wifi_wire.h"

TEST_CASE("Bridge endpoint accepts the local MVP WebSocket targets", "[wifi_provision]") {
    TEST_ASSERT_TRUE(al_wifi_endpoint_valid("ws://192.168.1.8:8788/device"));
    TEST_ASSERT_TRUE(al_wifi_endpoint_valid("ws://10.0.0.9/device"));
    TEST_ASSERT_TRUE(al_wifi_endpoint_valid("ws://xiaoli-bridge.local:8788/device"));
}

TEST_CASE("Bridge endpoint rejects unsafe or ambiguous URLs", "[wifi_provision]") {
    TEST_ASSERT_FALSE(al_wifi_endpoint_valid(nullptr));
    TEST_ASSERT_FALSE(al_wifi_endpoint_valid(""));
    TEST_ASSERT_FALSE(al_wifi_endpoint_valid("http://192.168.1.8:8788/device"));
    TEST_ASSERT_FALSE(al_wifi_endpoint_valid("wss://192.168.1.8:8788/device"));
    TEST_ASSERT_FALSE(al_wifi_endpoint_valid("ws://192.168.1.8:8788"));
    TEST_ASSERT_FALSE(al_wifi_endpoint_valid("ws://192.168.1.8:8788/wrong"));
    TEST_ASSERT_FALSE(al_wifi_endpoint_valid("ws://user@192.168.1.8:8788/device"));
    TEST_ASSERT_FALSE(al_wifi_endpoint_valid("ws://192.168.1.8:8788/device?x=1"));
    TEST_ASSERT_FALSE(al_wifi_endpoint_valid("ws://192.168.1.8:8788/device#x"));
    TEST_ASSERT_FALSE(al_wifi_endpoint_valid("ws://8.8.8.8:8788/device"));
    TEST_ASSERT_FALSE(al_wifi_endpoint_valid("ws://bridge.example.com:8788/device"));
}

TEST_CASE("Bridge endpoint enforces its fixed storage boundary", "[wifi_provision]") {
    std::vector<char> overlong(193, 'a');
    overlong[0] = 'w';
    overlong[1] = 's';
    overlong[2] = ':';
    overlong[3] = '/';
    overlong[4] = '/';
    overlong.back() = '\0';

    TEST_ASSERT_EQUAL_UINT32(192, strlen(overlong.data()));
    TEST_ASSERT_FALSE(al_wifi_endpoint_valid(overlong.data()));
}

TEST_CASE("Device token must be non-empty and fit fixed storage", "[wifi_provision]") {
    TEST_ASSERT_FALSE(al_wifi_device_token_valid(nullptr));
    TEST_ASSERT_FALSE(al_wifi_device_token_valid(""));
    TEST_ASSERT_TRUE(al_wifi_device_token_valid("demo-device-token"));

    std::vector<char> overlong(AL_PROV_DEVICE_TOKEN_CAPACITY + 1, 't');
    overlong.back() = '\0';
    TEST_ASSERT_FALSE(al_wifi_device_token_valid(overlong.data()));
}

TEST_CASE("Provisioning form decodes one complete settings value", "[wifi_provision]") {
    const char body[] =
        "ssid=Room+WiFi&password=p%40ss&endpoint=ws%3A%2F%2F192.168.1.8%3A8788%2Fdevice"
        "&device_token=demo%2Dtoken";
    al_prov_settings_t settings = {};

    TEST_ASSERT_TRUE(al_wifi_parse_provision_body(body, strlen(body), &settings));
    TEST_ASSERT_EQUAL_STRING("Room WiFi", settings.ssid);
    TEST_ASSERT_EQUAL_STRING("p@ss", settings.password);
    TEST_ASSERT_EQUAL_STRING("ws://192.168.1.8:8788/device", settings.endpoint);
    TEST_ASSERT_EQUAL_STRING("demo-token", settings.device_token);
}

TEST_CASE("Provisioning form rejects malformed ambiguous and oversized bodies", "[wifi_provision]") {
    al_prov_settings_t settings = {};
    const char malformed[] =
        "ssid=Room&password=%ZZ&endpoint=ws%3A%2F%2F192.168.1.8%3A8788%2Fdevice"
        "&device_token=demo";
    const char duplicate[] =
        "ssid=Room&ssid=Other&endpoint=ws%3A%2F%2F192.168.1.8%3A8788%2Fdevice"
        "&device_token=demo";
    const char malformed_unknown[] =
        "ssid=Room&password=&endpoint=ws%3A%2F%2F192.168.1.8%3A8788%2Fdevice"
        "&device_token=demo&ignored=%ZZ";
    std::vector<char> oversized(1024, 'x');

    TEST_ASSERT_FALSE(al_wifi_parse_provision_body(malformed, strlen(malformed), &settings));
    TEST_ASSERT_FALSE(al_wifi_parse_provision_body(duplicate, strlen(duplicate), &settings));
    TEST_ASSERT_FALSE(al_wifi_parse_provision_body(malformed_unknown, strlen(malformed_unknown), &settings));
    TEST_ASSERT_FALSE(al_wifi_parse_provision_body(oversized.data(), oversized.size(), &settings));
}

TEST_CASE("XL stream chunk encoding is byte exact", "[xiaoli_wire]") {
    const uint8_t payload[] = {0x11, 0x22};
    const xiaoli::WireFrame frame{
        xiaoli::WireKind::kStreamChunk, 2, 0, 513, payload, sizeof(payload)};
    std::vector<uint8_t> encoded;

    TEST_ASSERT_TRUE(xiaoli::EncodeWireFrame(frame, encoded));

    const uint8_t expected[] = {0x58, 0x4c, 1, 3, 2, 0, 1, 2, 0x11, 0x22};
    TEST_ASSERT_EQUAL_UINT32(sizeof(expected), encoded.size());
    TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, encoded.data(), sizeof(expected));
}

TEST_CASE("BuildCommand creates a valid Agent Link command", "[agent_link_protocol]") {
    const uint8_t json[] = {'{', '}'};

    const auto raw = agentlink::BuildCommand(0x7e, 9, json, sizeof(json));
    agentlink::Frame parsed;

    TEST_ASSERT_TRUE(agentlink::ParseFrame(raw.data(), raw.size(), parsed));
    TEST_ASSERT_EQUAL_UINT8(agentlink::kMsgCommand, parsed.msg_type);
    TEST_ASSERT_EQUAL_UINT8(0x7e, parsed.command_id);
    TEST_ASSERT_EQUAL_UINT8(9, parsed.sequence);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(json, parsed.payload.data(), sizeof(json));
}

TEST_CASE("XL decoding exposes the exact header and payload", "[xiaoli_wire]") {
    const uint8_t raw[] = {0x58, 0x4c, 1, 2, 4, 1, 0x34, 0x12, 0xaa, 0xbb};
    xiaoli::WireFrame decoded{};

    TEST_ASSERT_TRUE(xiaoli::DecodeWireFrame(raw, sizeof(raw), decoded));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::WireKind::kStreamStart),
                           static_cast<uint8_t>(decoded.kind));
    TEST_ASSERT_EQUAL_UINT8(4, decoded.stream_type);
    TEST_ASSERT_EQUAL_UINT8(1, decoded.flags);
    TEST_ASSERT_EQUAL_UINT16(0x1234, decoded.sequence);
    TEST_ASSERT_EQUAL_UINT32(2, decoded.payload_len);
    TEST_ASSERT_EQUAL_PTR(raw + xiaoli::kWireHeaderSize, decoded.payload);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(raw + xiaoli::kWireHeaderSize, decoded.payload,
                                  decoded.payload_len);
}

TEST_CASE("XL encoding rejects a null non-empty payload", "[xiaoli_wire]") {
    const xiaoli::WireFrame frame{
        xiaoli::WireKind::kControl, 0, 0, 0, nullptr, 1};
    std::vector<uint8_t> encoded = {0xaa};

    TEST_ASSERT_FALSE(xiaoli::EncodeWireFrame(frame, encoded));
    TEST_ASSERT_TRUE(encoded.empty());
}

TEST_CASE("XL encoding rejects payloads above UINT16_MAX", "[xiaoli_wire]") {
    std::vector<uint8_t> payload(65536, 0);
    const xiaoli::WireFrame frame{
        xiaoli::WireKind::kStreamChunk, 0, 0, 0, payload.data(), payload.size()};
    std::vector<uint8_t> encoded = {0xaa};

    TEST_ASSERT_FALSE(xiaoli::EncodeWireFrame(frame, encoded));
    TEST_ASSERT_TRUE(encoded.empty());
}

TEST_CASE("XL encoding rejects unsupported kinds", "[xiaoli_wire]") {
    std::vector<uint8_t> encoded;
    const xiaoli::WireFrame below{
        static_cast<xiaoli::WireKind>(0), 0, 0, 0, nullptr, 0};
    const xiaoli::WireFrame above{
        static_cast<xiaoli::WireKind>(5), 0, 0, 0, nullptr, 0};

    TEST_ASSERT_FALSE(xiaoli::EncodeWireFrame(below, encoded));
    TEST_ASSERT_FALSE(xiaoli::EncodeWireFrame(above, encoded));
}

TEST_CASE("XL encoding rejects stream types above four", "[xiaoli_wire]") {
    const xiaoli::WireFrame frame{
        xiaoli::WireKind::kStreamStart, 5, 0, 0, nullptr, 0};
    std::vector<uint8_t> encoded;

    TEST_ASSERT_FALSE(xiaoli::EncodeWireFrame(frame, encoded));
}

TEST_CASE("XL decoding rejects null and short frames", "[xiaoli_wire]") {
    const uint8_t short_frame[] = {0x58, 0x4c, 1, 1, 0, 0, 0};
    xiaoli::WireFrame decoded{};

    TEST_ASSERT_FALSE(xiaoli::DecodeWireFrame(nullptr, 8, decoded));
    TEST_ASSERT_FALSE(xiaoli::DecodeWireFrame(short_frame, sizeof(short_frame), decoded));
}

TEST_CASE("XL decoding rejects the wrong magic", "[xiaoli_wire]") {
    const uint8_t raw[] = {0x59, 0x4c, 1, 1, 0, 0, 0, 0};
    xiaoli::WireFrame decoded{};

    TEST_ASSERT_FALSE(xiaoli::DecodeWireFrame(raw, sizeof(raw), decoded));
}

TEST_CASE("XL decoding rejects unsupported versions", "[xiaoli_wire]") {
    const uint8_t raw[] = {0x58, 0x4c, 2, 1, 0, 0, 0, 0};
    xiaoli::WireFrame decoded{};

    TEST_ASSERT_FALSE(xiaoli::DecodeWireFrame(raw, sizeof(raw), decoded));
}

TEST_CASE("XL decoding rejects unsupported kinds", "[xiaoli_wire]") {
    const uint8_t below[] = {0x58, 0x4c, 1, 0, 0, 0, 0, 0};
    const uint8_t above[] = {0x58, 0x4c, 1, 5, 0, 0, 0, 0};
    xiaoli::WireFrame decoded{};

    TEST_ASSERT_FALSE(xiaoli::DecodeWireFrame(below, sizeof(below), decoded));
    TEST_ASSERT_FALSE(xiaoli::DecodeWireFrame(above, sizeof(above), decoded));
}

TEST_CASE("XL decoding rejects stream types above four", "[xiaoli_wire]") {
    const uint8_t raw[] = {0x58, 0x4c, 1, 1, 5, 0, 0, 0};
    xiaoli::WireFrame decoded{};

    TEST_ASSERT_FALSE(xiaoli::DecodeWireFrame(raw, sizeof(raw), decoded));
}

TEST_CASE("XL decoding rejects payloads above UINT16_MAX", "[xiaoli_wire]") {
    std::vector<uint8_t> raw(8 + 65536, 0);
    raw[0] = 0x58;
    raw[1] = 0x4c;
    raw[2] = 1;
    raw[3] = 1;
    xiaoli::WireFrame decoded{};

    TEST_ASSERT_FALSE(xiaoli::DecodeWireFrame(raw.data(), raw.size(), decoded));
}

TEST_CASE("BuildCommand rejects malformed payload lengths", "[agent_link_protocol]") {
    std::vector<uint8_t> oversized(65536, 0);

    TEST_ASSERT_TRUE(agentlink::BuildCommand(1, 1, oversized.data(), oversized.size()).empty());
    TEST_ASSERT_TRUE(agentlink::BuildCommand(1, 1, nullptr, 1).empty());
}

TEST_CASE("BuildCommand accepts a UINT16_MAX payload", "[agent_link_protocol]") {
    std::vector<uint8_t> payload(65535, 0x5a);

    const auto raw = agentlink::BuildCommand(1, 2, payload.data(), payload.size());
    agentlink::Frame parsed;

    TEST_ASSERT_TRUE(agentlink::ParseFrame(raw.data(), raw.size(), parsed));
    TEST_ASSERT_EQUAL_UINT32(payload.size(), parsed.payload.size());
    TEST_ASSERT_EQUAL_UINT8(0x5a, parsed.payload.front());
    TEST_ASSERT_EQUAL_UINT8(0x5a, parsed.payload.back());
}

TEST_CASE("Existing response and event bytes remain unchanged", "[agent_link_protocol]") {
    const uint8_t extra[] = {0xaa, 0xbb};
    const uint8_t expected_response[] = {
        1, 2, 0x22, 7, 6, 0, 0x22, 1, 0x34, 0x12, 0xaa, 0xbb};
    const uint8_t expected_event[] = {1, 3, 0x18, 0, 2, 0, 0xaa, 0xbb};

    const auto response = agentlink::BuildResponse(0x22, 7, 1, 0x1234,
                                                   extra, sizeof(extra));
    const auto event = agentlink::BuildEvent(0x18, extra, sizeof(extra));

    TEST_ASSERT_EQUAL_UINT32(sizeof(expected_response), response.size());
    TEST_ASSERT_EQUAL_UINT8_ARRAY(expected_response, response.data(), response.size());
    TEST_ASSERT_EQUAL_UINT32(sizeof(expected_event), event.size());
    TEST_ASSERT_EQUAL_UINT8_ARRAY(expected_event, event.data(), event.size());
}

TEST_CASE("Existing builders reject malformed payload lengths", "[agent_link_protocol]") {
    std::vector<uint8_t> oversized(65536, 0);

    TEST_ASSERT_TRUE(agentlink::BuildEvent(1, oversized.data(), oversized.size()).empty());
    TEST_ASSERT_TRUE(agentlink::BuildEvent(1, nullptr, 1).empty());
    TEST_ASSERT_TRUE(agentlink::BuildResponse(1, 1, 0, 0,
                                             oversized.data(), 65532).empty());
    TEST_ASSERT_TRUE(agentlink::BuildResponse(1, 1, 0, 0, nullptr, 1).empty());
}

TEST_CASE("WiFi hello has the exact authenticated schema and escaped token", "[wifi_transport]") {
    xiaoli::wifi::HelloIdentity identity{
        "a1b2c3d4e5f6", "0123abcd", 7, "1.2.3", "quoted\"\\token"};
    std::string json;
    std::string message_id;
    std::string device_id;

    TEST_ASSERT_TRUE(xiaoli::wifi::BuildHelloJson(identity, json, message_id, device_id));
    TEST_ASSERT_EQUAL_STRING("hello-a1b2c3d4e5f6-0123abcd-7", message_id.c_str());
    TEST_ASSERT_EQUAL_STRING("xiaoli-a1b2c3d4e5f6", device_id.c_str());
    TEST_ASSERT_EQUAL_STRING(
        "{\"v\":1,\"type\":\"hello\","
        "\"messageId\":\"hello-a1b2c3d4e5f6-0123abcd-7\","
        "\"deviceId\":\"xiaoli-a1b2c3d4e5f6\",\"firmwareVersion\":\"1.2.3\","
        "\"token\":\"quoted\\\"\\\\token\",\"capabilities\":[\"recording\",\"voice\"]}",
        json.c_str());

    const std::string ack =
        "{\"v\":1,\"type\":\"hello.ack\",\"messageId\":\"" + message_id +
        "\",\"deviceId\":\"" + device_id + "\",\"protocol\":1}";
    TEST_ASSERT_TRUE(xiaoli::wifi::IsMatchingHelloAck(
        reinterpret_cast<const uint8_t*>(ack.data()), ack.size(), message_id, device_id));
    const char wrong[] =
        "{\"v\":1,\"type\":\"hello.ack\",\"messageId\":\"wrong\","
        "\"deviceId\":\"xiaoli-a1b2c3d4e5f6\",\"protocol\":1}";
    TEST_ASSERT_FALSE(xiaoli::wifi::IsMatchingHelloAck(
        reinterpret_cast<const uint8_t*>(wrong), strlen(wrong), message_id, device_id));
    const char wrong_protocol[] =
        "{\"v\":1,\"type\":\"hello.ack\","
        "\"messageId\":\"hello-a1b2c3d4e5f6-0123abcd-7\","
        "\"deviceId\":\"xiaoli-a1b2c3d4e5f6\",\"protocol\":2}";
    TEST_ASSERT_FALSE(xiaoli::wifi::IsMatchingHelloAck(
        reinterpret_cast<const uint8_t*>(wrong_protocol), strlen(wrong_protocol),
        message_id, device_id));
}

TEST_CASE("WiFi control mapping preserves custom JSON and wraps compatibility frames", "[wifi_transport]") {
    const uint8_t json[] = {'{', '"', 'x', '"', ':', '1', '}'};
    const auto custom = agentlink::BuildEvent(0x64, json, sizeof(json));
    xiaoli::wifi::OutboundMessage out;

    TEST_ASSERT_EQUAL(ESP_OK, xiaoli::wifi::EncodeControl(custom.data(), custom.size(), out));
    TEST_ASSERT_TRUE(out.text);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(json, out.payload.data(), sizeof(json));

    const auto control = agentlink::BuildEvent(0x18, json, sizeof(json));
    TEST_ASSERT_EQUAL(ESP_OK, xiaoli::wifi::EncodeControl(control.data(), control.size(), out));
    TEST_ASSERT_FALSE(out.text);
    xiaoli::WireFrame wire{};
    TEST_ASSERT_TRUE(xiaoli::DecodeWireFrame(out.payload.data(), out.payload.size(), wire));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::WireKind::kControl),
                           static_cast<uint8_t>(wire.kind));
    TEST_ASSERT_EQUAL_UINT8(0, wire.stream_type);
    TEST_ASSERT_EQUAL_UINT8(0, wire.flags);
    TEST_ASSERT_EQUAL_UINT16(0, wire.sequence);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(control.data(), wire.payload, control.size());

    const uint8_t malformed[] = {1, 3, 0x64, 0, 10, 0, '{'};
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG,
                      xiaoli::wifi::EncodeControl(malformed, sizeof(malformed), out));
}

TEST_CASE("WiFi queue reserves eight FIFO slots for control traffic", "[wifi_transport]") {
    xiaoli::wifi::TxQueuePolicy policy;
    for (int i = 0; i < 32; ++i) {
        TEST_ASSERT_TRUE(policy.Admit(xiaoli::wifi::TxClass::kAudioChunk, 100));
    }
    TEST_ASSERT_FALSE(policy.Admit(xiaoli::wifi::TxClass::kAudioChunk, 100));
    TEST_ASSERT_TRUE(policy.Admit(xiaoli::wifi::TxClass::kReserved, 100));
    TEST_ASSERT_EQUAL_UINT32(33, policy.queued_items());
    TEST_ASSERT_EQUAL_UINT32(32, policy.queued_audio_items());
    TEST_ASSERT_EQUAL_UINT32(200, xiaoli::wifi::kReservedAdmissionWaitMs);
}

TEST_CASE("WiFi queue byte cap accounts and releases owning payloads", "[wifi_transport]") {
    xiaoli::wifi::TxQueuePolicy policy;
    TEST_ASSERT_TRUE(policy.Admit(xiaoli::wifi::TxClass::kReserved,
                                  xiaoli::wifi::kTxByteCapacity));
    TEST_ASSERT_FALSE(policy.Admit(xiaoli::wifi::TxClass::kReserved, 1));
    policy.Release(xiaoli::wifi::TxClass::kReserved, xiaoli::wifi::kTxByteCapacity);
    TEST_ASSERT_EQUAL_UINT32(0, policy.queued_bytes());
    TEST_ASSERT_TRUE(policy.Admit(xiaoli::wifi::TxClass::kReserved, 1));
}

TEST_CASE("WiFi recording sequence commits only admitted chunks and builds canonical end", "[wifi_transport]") {
    const char start[] =
        "{\"v\":1,\"type\":\"speech.start\",\"messageId\":\"m1\","
        "\"caseId\":\"c1\",\"segmentId\":\"s1\"}";
    xiaoli::wifi::UplinkStreams streams;
    std::vector<uint8_t> wire;
    TEST_ASSERT_EQUAL(ESP_OK, streams.Start(AGENT_STREAM_RECORDING,
        reinterpret_cast<const uint8_t*>(start), strlen(start), wire));
    xiaoli::WireFrame decoded{};
    TEST_ASSERT_TRUE(xiaoli::DecodeWireFrame(wire.data(), wire.size(), decoded));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::WireKind::kStreamStart),
                           static_cast<uint8_t>(decoded.kind));
    TEST_ASSERT_EQUAL_UINT16(0, decoded.sequence);
    TEST_ASSERT_EQUAL(ESP_OK, streams.PrepareChunk(AGENT_STREAM_RECORDING,
                                                  reinterpret_cast<const uint8_t*>("aa"), 2, wire));
    TEST_ASSERT_TRUE(xiaoli::DecodeWireFrame(wire.data(), wire.size(), decoded));
    TEST_ASSERT_EQUAL_UINT16(0, decoded.sequence);
    streams.CommitChunk(AGENT_STREAM_RECORDING, 2);
    TEST_ASSERT_EQUAL(ESP_OK, streams.PrepareChunk(AGENT_STREAM_RECORDING,
                                                  reinterpret_cast<const uint8_t*>("bbb"), 3, wire));
    TEST_ASSERT_TRUE(xiaoli::DecodeWireFrame(wire.data(), wire.size(), decoded));
    TEST_ASSERT_EQUAL_UINT16(1, decoded.sequence);
    // Simulate failed admission: no commit, so sequence and byte count stay unchanged.
    TEST_ASSERT_EQUAL_UINT32(1, streams.next_chunk(AGENT_STREAM_RECORDING));
    TEST_ASSERT_EQUAL_UINT32(2, streams.admitted_bytes(AGENT_STREAM_RECORDING));
    streams.CommitChunk(AGENT_STREAM_RECORDING, 3);

    TEST_ASSERT_EQUAL(ESP_OK, streams.PrepareEnd(AGENT_STREAM_RECORDING, true,
                                                 nullptr, 0, wire));
    xiaoli::WireFrame end{};
    TEST_ASSERT_TRUE(xiaoli::DecodeWireFrame(wire.data(), wire.size(), end));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::WireKind::kStreamEnd),
                           static_cast<uint8_t>(end.kind));
    TEST_ASSERT_EQUAL_UINT8(1, end.flags);
    TEST_ASSERT_EQUAL_UINT16(1, end.sequence);
    const std::string end_json(reinterpret_cast<const char*>(end.payload), end.payload_len);
    TEST_ASSERT_EQUAL_STRING(
        "{\"v\":1,\"type\":\"speech.end\",\"messageId\":\"m1-end\","
        "\"caseId\":\"c1\",\"segmentId\":\"s1\",\"bytes\":5,"
        "\"lastSequence\":1,\"complete\":true}", end_json.c_str());
}

TEST_CASE("WiFi recording admits sequence 65535 once and never wraps", "[wifi_transport]") {
    const char start[] =
        "{\"v\":1,\"type\":\"speech.start\",\"messageId\":\"m\","
        "\"caseId\":\"c\",\"segmentId\":\"s\"}";
    xiaoli::wifi::UplinkStreams streams;
    std::vector<uint8_t> wire;
    TEST_ASSERT_EQUAL(ESP_OK, streams.Start(AGENT_STREAM_RECORDING,
        reinterpret_cast<const uint8_t*>(start), strlen(start), wire));
    for (uint32_t i = 0; i < 65535; ++i) {
        streams.CommitChunk(AGENT_STREAM_RECORDING, 0);
    }
    TEST_ASSERT_EQUAL(ESP_OK, streams.PrepareChunk(AGENT_STREAM_RECORDING,
                                                  reinterpret_cast<const uint8_t*>("x"), 1, wire));
    streams.CommitChunk(AGENT_STREAM_RECORDING, 1);
    TEST_ASSERT_EQUAL_UINT32(65536, streams.next_chunk(AGENT_STREAM_RECORDING));
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_SIZE,
                      streams.PrepareChunk(AGENT_STREAM_RECORDING,
                                           reinterpret_cast<const uint8_t*>("x"), 1, wire));
}

TEST_CASE("WiFi fragment assembler handles continuation and rejects discontinuity", "[wifi_transport]") {
    xiaoli::wifi::FragmentAssembler assembler;
    xiaoli::wifi::CompleteMessage message;
    const uint8_t a[] = {'a', 'b'};
    const uint8_t b[] = {'c'};
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::wifi::FragmentResult::kPending),
        static_cast<uint8_t>(assembler.Append(0x1, false, 2, 0, a, 2, message)));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::wifi::FragmentResult::kComplete),
        static_cast<uint8_t>(assembler.Append(0x0, true, 1, 0, b, 1, message)));
    TEST_ASSERT_TRUE(message.text);
    const uint8_t expected[] = {'a', 'b', 'c'};
    TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, message.payload.data(), sizeof(expected));

    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::wifi::FragmentResult::kRejected),
        static_cast<uint8_t>(assembler.Append(0x0, true, 1, 0, b, 1, message)));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::wifi::FragmentResult::kPending),
        static_cast<uint8_t>(assembler.Append(0x1, true, 2, 0, a, 1, message)));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::wifi::FragmentResult::kRejected),
        static_cast<uint8_t>(assembler.Append(0x1, true, 2, 0, b, 1, message)));

    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::wifi::FragmentResult::kPending),
        static_cast<uint8_t>(assembler.Append(0x1, true, 3, 0, a, 2, message)));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::wifi::FragmentResult::kComplete),
        static_cast<uint8_t>(assembler.Append(0x1, true, 3, 2, b, 1, message)));
    TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, message.payload.data(), sizeof(expected));
}

TEST_CASE("WiFi fragment assembler enforces exact text and binary caps", "[wifi_transport]") {
    xiaoli::wifi::FragmentAssembler assembler;
    xiaoli::wifi::CompleteMessage message;
    static const std::array<uint8_t, 4096> chunk{};
    auto append_message = [&](uint8_t opcode, size_t size, bool over_cap) {
        size_t sent = 0;
        bool first = true;
        while (sent < size) {
            const size_t part = std::min(chunk.size(), size - sent);
            const bool final = !over_cap && sent + part == size;
            const auto result = assembler.Append(first ? opcode : 0x0, final, part, 0,
                                                 chunk.data(), part, message);
            TEST_ASSERT_EQUAL_UINT8(
                static_cast<uint8_t>(final ? xiaoli::wifi::FragmentResult::kComplete
                                           : xiaoli::wifi::FragmentResult::kPending),
                static_cast<uint8_t>(result));
            first = false;
            sent += part;
        }
        if (over_cap) {
            TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::wifi::FragmentResult::kRejected),
                static_cast<uint8_t>(assembler.Append(0x0, true, 1, 0,
                                                      chunk.data(), 1, message)));
        }
    };

    append_message(0x1, 65535, false);
    TEST_ASSERT_EQUAL_UINT32(65535, message.payload.size());
    std::vector<uint8_t>().swap(message.payload);
    append_message(0x1, 65535, true);

    append_message(0x2, xiaoli::kWireHeaderSize + 65535, false);
    TEST_ASSERT_EQUAL_UINT32(xiaoli::kWireHeaderSize + 65535, message.payload.size());
    std::vector<uint8_t>().swap(message.payload);
    append_message(0x2, xiaoli::kWireHeaderSize + 65535, true);
}

TEST_CASE("WiFi downlink voice enforces start order sequence flags type and size", "[wifi_transport]") {
    xiaoli::wifi::VoiceRxTracker voice;
    TEST_ASSERT_FALSE(voice.AcceptChunk(AGENT_STREAM_VOICE, 0, 0, 10));
    voice.OnAudioStart();
    TEST_ASSERT_TRUE(voice.AcceptChunk(AGENT_STREAM_VOICE, 0, 0, 4096));
    TEST_ASSERT_FALSE(voice.AcceptChunk(AGENT_STREAM_VOICE, 0, 0, 1));
    TEST_ASSERT_FALSE(voice.AcceptChunk(AGENT_STREAM_VOICE, 1, 1, 1));
    TEST_ASSERT_FALSE(voice.AcceptChunk(AGENT_STREAM_RECORDING, 0, 1, 1));
    TEST_ASSERT_FALSE(voice.AcceptChunk(AGENT_STREAM_VOICE, 0, 1, 4097));
    TEST_ASSERT_TRUE(voice.AcceptChunk(AGENT_STREAM_VOICE, 0, 1, 1));
    TEST_ASSERT_TRUE(voice.AcceptEnd(1, true));
    TEST_ASSERT_FALSE(voice.active());
}

namespace {
esp_err_t TestResolve(const char* host, uint32_t timeout_ms, uint32_t* address,
                      void* context) {
    *static_cast<std::string*>(context) = host;
    TEST_ASSERT_EQUAL_UINT32(2000, timeout_ms);
    *address = 0xc0a80108;
    return ESP_OK;
}
}

TEST_CASE("WiFi mDNS resolution strips local suffix and retains URI structure", "[wifi_transport]") {
    std::string queried;
    std::string resolved;
    TEST_ASSERT_EQUAL(ESP_OK, xiaoli::wifi::ResolveEndpoint(
        "ws://xiaoli-bridge.local:8788/device", &TestResolve, &queried, resolved));
    TEST_ASSERT_EQUAL_STRING("xiaoli-bridge", queried.c_str());
    TEST_ASSERT_EQUAL_STRING("ws://192.168.1.8:8788/device", resolved.c_str());
}

namespace {

using xiaoli::ActionBatch;
using xiaoli::ActionType;
using xiaoli::Button;
using xiaoli::ButtonDebouncer;
using xiaoli::ErrorReason;
using xiaoli::Event;
using xiaoli::EventType;
using xiaoli::MediationState;
using xiaoli::MediationStateMachine;
using xiaoli::Speaker;
using xiaoli::StatusId;

Event StateEvent(EventType type, uint64_t now_ms = 0) {
    Event event{};
    event.type = type;
    event.now_ms = now_ms;
    return event;
}

Event ButtonEvent(EventType type, Button button, uint64_t now_ms) {
    Event event = StateEvent(type, now_ms);
    event.button = button;
    return event;
}

Event CaseEvent(EventType type, uint32_t generation, uint64_t now_ms) {
    Event event = StateEvent(type, now_ms);
    event.case_generation = generation;
    return event;
}

Event AckEvent(Speaker speaker, uint32_t generation, uint64_t now_ms) {
    Event event = CaseEvent(EventType::kSegmentDurableAck, generation, now_ms);
    event.speaker = speaker;
    return event;
}

void AssertSafeBatch(const ActionBatch& batch) {
    TEST_ASSERT_LESS_OR_EQUAL_UINT8(xiaoli::kMaxActions, batch.count);
    for (uint8_t i = 0; i < batch.count; ++i) {
        TEST_ASSERT_NOT_EQUAL(static_cast<uint8_t>(ActionType::kNone),
                              static_cast<uint8_t>(batch.items[i].type));
    }
}

void AssertAction(const ActionBatch& batch, uint8_t index, ActionType type,
                  Speaker speaker = Speaker::kNone,
                  StatusId status = StatusId::kWaiting,
                  uint32_t duration_ms = 0) {
    AssertSafeBatch(batch);
    TEST_ASSERT_GREATER_THAN_UINT8(index, batch.count);
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(type),
                           static_cast<uint8_t>(batch.items[index].type));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(speaker),
                           static_cast<uint8_t>(batch.items[index].speaker));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(status),
                           static_cast<uint8_t>(batch.items[index].status));
    TEST_ASSERT_EQUAL_UINT32(duration_ms, batch.items[index].duration_ms);
}

ActionBatch ShortCase(MediationStateMachine& machine, uint64_t press_ms,
                      uint64_t release_ms) {
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(
        ButtonEvent(EventType::kButtonPressed, Button::kCase, press_ms)).count);
    return machine.Handle(
        ButtonEvent(EventType::kButtonReleased, Button::kCase, release_ms));
}

void AddDurablePair(MediationStateMachine& machine, uint64_t now_ms) {
    const uint32_t generation = machine.case_generation();
    machine.Handle(AckEvent(Speaker::kA, generation, now_ms));
    machine.Handle(AckEvent(Speaker::kB, generation, now_ms + 1));
}

}  // namespace

static_assert(std::is_trivially_destructible_v<xiaoli::MediationStateMachine>);
static_assert(std::is_trivially_destructible_v<xiaoli::ButtonDebouncer>);
static_assert(std::is_trivially_destructible_v<xiaoli::Event>);
static_assert(std::is_trivially_destructible_v<xiaoli::ActionBatch>);

TEST_CASE("Mediation status text is fixed and heap-free", "[mediation_state]") {
    TEST_ASSERT_EQUAL_STRING("欢迎来到小理天秤官", xiaoli::StatusText(StatusId::kWelcome));
    TEST_ASSERT_EQUAL_STRING("小理开始倾听", xiaoli::StatusText(StatusId::kWaiting));
    TEST_ASSERT_EQUAL_STRING("小理开始倾听A发言", xiaoli::StatusText(StatusId::kRecordingA));
    TEST_ASSERT_EQUAL_STRING("小理开始倾听B发言", xiaoli::StatusText(StatusId::kRecordingB));
    TEST_ASSERT_EQUAL_STRING("A发言结束", xiaoli::StatusText(StatusId::kStatementEndedA));
    TEST_ASSERT_EQUAL_STRING("B发言结束", xiaoli::StatusText(StatusId::kStatementEndedB));
    TEST_ASSERT_EQUAL_STRING("小理调解中", xiaoli::StatusText(StatusId::kMediating));
    TEST_ASSERT_EQUAL_STRING("请先短按侧边键创建案件", xiaoli::StatusText(StatusId::kNeedCase));
    TEST_ASSERT_EQUAL_STRING("请先收集双方发言", xiaoli::StatusText(StatusId::kNeedBothStatements));
    TEST_ASSERT_EQUAL_STRING("网络连接不可用，请稍后重试", xiaoli::StatusText(StatusId::kNetworkUnavailable));
    TEST_ASSERT_EQUAL_STRING("录音不完整，请重新发言", xiaoli::StatusText(StatusId::kRecordingIncomplete));
    TEST_ASSERT_EQUAL_STRING("录音缓存已满，请稍后重试", xiaoli::StatusText(StatusId::kAudioCapacity));
    TEST_ASSERT_EQUAL_STRING("调解失败，请稍后重试", xiaoli::StatusText(StatusId::kMediationFailed));
}

TEST_CASE("Debouncer honors 39 40 ms boundaries and fixed edge order", "[mediation_state]") {
    ButtonDebouncer debounce;
    debounce.Reset(0, 0);
    TEST_ASSERT_EQUAL_UINT8(0, debounce.Sample(0, 0x07).count);
    TEST_ASSERT_EQUAL_UINT8(0, debounce.Sample(39, 0x07).count);
    const auto pressed = debounce.Sample(40, 0x07);
    TEST_ASSERT_EQUAL_UINT8(3, pressed.count);
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(Button::kCase),
                            static_cast<uint8_t>(pressed.items[0].button));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(Button::kPersonA),
                            static_cast<uint8_t>(pressed.items[1].button));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(Button::kPersonB),
                            static_cast<uint8_t>(pressed.items[2].button));
    for (uint8_t i = 0; i < pressed.count; ++i) {
        TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(EventType::kButtonPressed),
                               static_cast<uint8_t>(pressed.items[i].type));
        TEST_ASSERT_TRUE(pressed.items[i].now_ms == 40);
    }
    TEST_ASSERT_EQUAL_UINT8(0, debounce.Sample(400, 0x07).count);
    TEST_ASSERT_EQUAL_UINT8(0, debounce.Sample(401, 0).count);
    TEST_ASSERT_EQUAL_UINT8(0, debounce.Sample(440, 0).count);
    const auto released = debounce.Sample(441, 0);
    TEST_ASSERT_EQUAL_UINT8(3, released.count);
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(EventType::kButtonReleased),
                           static_cast<uint8_t>(released.items[0].type));
}

TEST_CASE("Debouncer restarts after bounce and rejects time reversal", "[mediation_state]") {
    ButtonDebouncer debounce;
    debounce.Reset(0, 0);
    TEST_ASSERT_EQUAL_UINT8(0, debounce.Sample(0, 0x01).count);
    TEST_ASSERT_EQUAL_UINT8(0, debounce.Sample(39, 0).count);
    TEST_ASSERT_EQUAL_UINT8(0, debounce.Sample(40, 0x01).count);
    TEST_ASSERT_EQUAL_UINT8(0, debounce.Sample(79, 0x01).count);
    TEST_ASSERT_EQUAL_UINT8(1, debounce.Sample(80, 0x01).count);
    TEST_ASSERT_EQUAL_UINT8(0, debounce.Sample(79, 0).count);
    TEST_ASSERT_EQUAL_UINT8(0, debounce.Sample(120, 0x01).count);

    debounce.Reset(200, 0x02);
    TEST_ASSERT_EQUAL_UINT8(0, debounce.Sample(300, 0x02).count);
    TEST_ASSERT_EQUAL_UINT8(0, debounce.Sample(301, 0).count);
    const auto held_release = debounce.Sample(341, 0);
    TEST_ASSERT_EQUAL_UINT8(1, held_release.count);
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(Button::kPersonA),
                            static_cast<uint8_t>(held_release.items[0].button));
}

TEST_CASE("Boot short case and generation reset preserve strict lifecycle", "[mediation_state]") {
    MediationStateMachine machine;
    auto batch = machine.Handle(StateEvent(EventType::kBoot, 1));
    TEST_ASSERT_EQUAL_UINT8(1, batch.count);
    AssertAction(batch, 0, ActionType::kShowStatus, Speaker::kNone, StatusId::kWelcome);
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(MediationState::kWelcome),
                           static_cast<uint8_t>(machine.state()));
    TEST_ASSERT_FALSE(machine.has_case());

    batch = ShortCase(machine, 10, 3009);
    TEST_ASSERT_EQUAL_UINT8(2, batch.count);
    AssertAction(batch, 0, ActionType::kNewCase);
    AssertAction(batch, 1, ActionType::kShowStatus, Speaker::kNone, StatusId::kWaiting);
    TEST_ASSERT_NOT_EQUAL(0, batch.items[0].case_generation);
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(MediationState::kWaiting),
                           static_cast<uint8_t>(machine.state()));
    const uint32_t first_generation = machine.case_generation();

    machine.Handle(AckEvent(Speaker::kA, first_generation, 3010));
    machine.Handle(AckEvent(Speaker::kB, first_generation, 3011));
    batch = ShortCase(machine, 3020, 3021);
    TEST_ASSERT_EQUAL_UINT8(2, batch.count);
    TEST_ASSERT_NOT_EQUAL(first_generation, machine.case_generation());
    TEST_ASSERT_EQUAL_UINT16(0, machine.completed_a());
    TEST_ASSERT_EQUAL_UINT16(0, machine.completed_b());
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(AckEvent(
        Speaker::kA, first_generation, 3022)).count);
    TEST_ASSERT_EQUAL_UINT16(0, machine.completed_a());
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(CaseEvent(
        EventType::kAudioStart, first_generation, 3023)).count);
}

TEST_CASE("Case long press uses exact 2999 3000 ms boundary once", "[mediation_state]") {
    MediationStateMachine machine;
    machine.Handle(StateEvent(EventType::kBoot, 0));
    const auto no_case_press = machine.Handle(
        ButtonEvent(EventType::kButtonPressed, Button::kCase, 10));
    TEST_ASSERT_EQUAL_UINT8(0, no_case_press.count);
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(StateEvent(EventType::kTick, 3009)).count);
    auto batch = machine.Handle(StateEvent(EventType::kTick, 3010));
    TEST_ASSERT_EQUAL_UINT8(2, batch.count);
    AssertAction(batch, 0, ActionType::kVibrate, Speaker::kNone,
                 StatusId::kWaiting, xiaoli::kErrorVibrateMs);
    AssertAction(batch, 1, ActionType::kShowStatus, Speaker::kNone, StatusId::kNeedCase);
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(StateEvent(EventType::kTick, 9000)).count);
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(ButtonEvent(
        EventType::kButtonReleased, Button::kCase, 9001)).count);

    batch = ShortCase(machine, 9010, 12009);
    TEST_ASSERT_EQUAL_UINT8(2, batch.count);
    const uint32_t generation = machine.case_generation();
    machine.Handle(AckEvent(Speaker::kA, generation, 12010));
    machine.Handle(AckEvent(Speaker::kB, generation, 12011));
    machine.Handle(ButtonEvent(EventType::kButtonPressed, Button::kCase, 13000));
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(StateEvent(EventType::kTick, 15999)).count);
    batch = machine.Handle(StateEvent(EventType::kTick, 16000));
    TEST_ASSERT_EQUAL_UINT8(2, batch.count);
    AssertAction(batch, 0, ActionType::kRequestMediation);
    TEST_ASSERT_EQUAL_UINT32(generation, batch.items[0].case_generation);
    AssertAction(batch, 1, ActionType::kShowStatus, Speaker::kNone, StatusId::kMediating);
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(StateEvent(EventType::kTick, 16001)).count);
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(ButtonEvent(
        EventType::kButtonReleased, Button::kCase, 17000)).count);
}

TEST_CASE("Release at long boundary decides long while 2999 remains short", "[mediation_state]") {
    MediationStateMachine short_machine;
    short_machine.Handle(StateEvent(EventType::kBoot, 0));
    auto batch = ShortCase(short_machine, 100, 3099);
    TEST_ASSERT_EQUAL_UINT8(2, batch.count);
    AssertAction(batch, 0, ActionType::kNewCase);

    MediationStateMachine long_machine;
    long_machine.Handle(StateEvent(EventType::kBoot, 0));
    ShortCase(long_machine, 10, 20);
    AddDurablePair(long_machine, 21);
    long_machine.Handle(ButtonEvent(EventType::kButtonPressed, Button::kCase, 100));
    batch = long_machine.Handle(ButtonEvent(
        EventType::kButtonReleased, Button::kCase, 3100));
    TEST_ASSERT_EQUAL_UINT8(2, batch.count);
    AssertAction(batch, 0, ActionType::kRequestMediation);
    TEST_ASSERT_EQUAL_UINT8(0, long_machine.Handle(ButtonEvent(
        EventType::kButtonReleased, Button::kCase, 3101)).count);
}

TEST_CASE("Speaker buttons toggle only their side and reject the opposite side", "[mediation_state]") {
    MediationStateMachine machine;
    machine.Handle(StateEvent(EventType::kBoot, 0));
    ShortCase(machine, 1, 2);

    auto batch = machine.Handle(ButtonEvent(
        EventType::kButtonPressed, Button::kPersonA, 3));
    TEST_ASSERT_EQUAL_UINT8(2, batch.count);
    AssertAction(batch, 0, ActionType::kStartRecording, Speaker::kA);
    AssertAction(batch, 1, ActionType::kShowStatus, Speaker::kNone, StatusId::kRecordingA);
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(ButtonEvent(
        EventType::kButtonReleased, Button::kPersonA, 4)).count);
    batch = machine.Handle(ButtonEvent(EventType::kButtonPressed, Button::kPersonB, 5));
    TEST_ASSERT_EQUAL_UINT8(1, batch.count);
    AssertAction(batch, 0, ActionType::kVibrate, Speaker::kNone,
                 StatusId::kWaiting, xiaoli::kErrorVibrateMs);
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(MediationState::kRecordingA),
                           static_cast<uint8_t>(machine.state()));
    batch = machine.Handle(ButtonEvent(EventType::kButtonPressed, Button::kPersonA, 6));
    TEST_ASSERT_EQUAL_UINT8(2, batch.count);
    AssertAction(batch, 0, ActionType::kStopRecording, Speaker::kA);
    TEST_ASSERT_EQUAL_UINT16(0, machine.completed_a());

    batch = machine.Handle(ButtonEvent(EventType::kButtonPressed, Button::kPersonB, 7));
    AssertAction(batch, 0, ActionType::kStartRecording, Speaker::kB);
    batch = machine.Handle(ButtonEvent(EventType::kButtonPressed, Button::kPersonA, 8));
    TEST_ASSERT_EQUAL_UINT8(1, batch.count);
    AssertAction(batch, 0, ActionType::kVibrate, Speaker::kNone,
                 StatusId::kWaiting, xiaoli::kErrorVibrateMs);
    batch = machine.Handle(ButtonEvent(EventType::kButtonPressed, Button::kPersonB, 9));
    AssertAction(batch, 0, ActionType::kStopRecording, Speaker::kB);
    TEST_ASSERT_EQUAL_UINT16(0, machine.completed_b());
}

TEST_CASE("Durable ACK alone counts and owns the nonblocking five second status", "[mediation_state]") {
    MediationStateMachine machine;
    machine.Handle(StateEvent(EventType::kBoot, 0));
    ShortCase(machine, 1, 2);
    const uint32_t generation = machine.case_generation();

    auto batch = machine.Handle(AckEvent(Speaker::kA, generation, 100));
    TEST_ASSERT_EQUAL_UINT8(1, batch.count);
    AssertAction(batch, 0, ActionType::kShowStatus, Speaker::kNone,
                 StatusId::kStatementEndedA);
    TEST_ASSERT_EQUAL_UINT16(1, machine.completed_a());
    TEST_ASSERT_EQUAL_UINT16(0, machine.completed_b());
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(StateEvent(EventType::kTick, 5099)).count);
    batch = machine.Handle(StateEvent(EventType::kTick, 5100));
    TEST_ASSERT_EQUAL_UINT8(1, batch.count);
    AssertAction(batch, 0, ActionType::kShowStatus, Speaker::kNone, StatusId::kWaiting);

    machine.Handle(AckEvent(Speaker::kA, generation, 6000));
    batch = machine.Handle(AckEvent(Speaker::kB, generation, 10000));
    AssertAction(batch, 0, ActionType::kShowStatus, Speaker::kNone,
                 StatusId::kStatementEndedB);
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(StateEvent(EventType::kTick, 14999)).count);
    TEST_ASSERT_EQUAL_UINT8(1, machine.Handle(StateEvent(EventType::kTick, 15000)).count);
    TEST_ASSERT_EQUAL_UINT16(2, machine.completed_a());
    TEST_ASSERT_EQUAL_UINT16(1, machine.completed_b());

    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(AckEvent(
        Speaker::kNone, generation, 15001)).count);
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(AckEvent(
        Speaker::kA, generation - 1, 15002)).count);
}

TEST_CASE("ACK status never overwrites active recording mediation playback or error", "[mediation_state]") {
    MediationStateMachine machine;
    machine.Handle(StateEvent(EventType::kBoot, 0));
    ShortCase(machine, 1, 2);
    const uint32_t generation = machine.case_generation();
    machine.Handle(ButtonEvent(EventType::kButtonPressed, Button::kPersonA, 10));
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(AckEvent(Speaker::kA, generation, 11)).count);
    TEST_ASSERT_EQUAL_UINT16(1, machine.completed_a());
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(StateEvent(EventType::kTick, 10000)).count);
    machine.Handle(ButtonEvent(EventType::kButtonPressed, Button::kPersonA, 10001));
    machine.Handle(AckEvent(Speaker::kB, generation, 10002));
    machine.Handle(ButtonEvent(EventType::kButtonPressed, Button::kCase, 10003));
    machine.Handle(StateEvent(EventType::kTick, 13003));
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(AckEvent(Speaker::kA, generation, 13004)).count);
    machine.Handle(CaseEvent(EventType::kAudioStart, generation, 13005));
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(AckEvent(Speaker::kB, generation, 13006)).count);
    Event error = CaseEvent(EventType::kRecoverableError, generation, 13007);
    error.error = ErrorReason::kMediationFailed;
    machine.Handle(error);
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(AckEvent(Speaker::kA, generation, 13008)).count);
}

TEST_CASE("Mediation gate rejects missing side and orders stop before request", "[mediation_state]") {
    MediationStateMachine missing;
    missing.Handle(StateEvent(EventType::kBoot, 0));
    ShortCase(missing, 1, 2);
    missing.Handle(AckEvent(Speaker::kA, missing.case_generation(), 3));
    missing.Handle(ButtonEvent(EventType::kButtonPressed, Button::kPersonB, 4));
    missing.Handle(ButtonEvent(EventType::kButtonPressed, Button::kCase, 5));
    auto batch = missing.Handle(StateEvent(EventType::kTick, 3005));
    TEST_ASSERT_EQUAL_UINT8(3, batch.count);
    AssertAction(batch, 0, ActionType::kStopRecording, Speaker::kB);
    AssertAction(batch, 1, ActionType::kVibrate, Speaker::kNone,
                 StatusId::kWaiting, xiaoli::kErrorVibrateMs);
    AssertAction(batch, 2, ActionType::kShowStatus, Speaker::kNone,
                 StatusId::kNeedBothStatements);
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(MediationState::kWaiting),
                           static_cast<uint8_t>(missing.state()));
    TEST_ASSERT_EQUAL_UINT16(0, missing.completed_b());

    missing.Handle(ButtonEvent(EventType::kButtonReleased, Button::kCase, 3006));
    missing.Handle(AckEvent(Speaker::kB, missing.case_generation(), 3007));
    missing.Handle(ButtonEvent(EventType::kButtonPressed, Button::kPersonA, 3008));
    missing.Handle(ButtonEvent(EventType::kButtonPressed, Button::kCase, 3009));
    batch = missing.Handle(StateEvent(EventType::kTick, 6009));
    TEST_ASSERT_EQUAL_UINT8(3, batch.count);
    AssertAction(batch, 0, ActionType::kStopRecording, Speaker::kA);
    AssertAction(batch, 1, ActionType::kRequestMediation);
    AssertAction(batch, 2, ActionType::kShowStatus, Speaker::kNone, StatusId::kMediating);
}

TEST_CASE("Playback accepts only current generation and preserves the case", "[mediation_state]") {
    MediationStateMachine machine;
    machine.Handle(StateEvent(EventType::kBoot, 0));
    ShortCase(machine, 1, 2);
    const uint32_t generation = machine.case_generation();
    AddDurablePair(machine, 3);
    machine.Handle(ButtonEvent(EventType::kButtonPressed, Button::kCase, 10));
    machine.Handle(StateEvent(EventType::kTick, 3010));

    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(CaseEvent(
        EventType::kAudioStart, generation + 1, 3011)).count);
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(CaseEvent(
        EventType::kAudioStart, generation, 3012)).count);
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(MediationState::kPlaying),
                           static_cast<uint8_t>(machine.state()));
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(CaseEvent(
        EventType::kAudioStart, generation, 3013)).count);
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(CaseEvent(
        EventType::kAudioEnd, generation + 1, 3014)).count);
    const auto batch = machine.Handle(CaseEvent(EventType::kAudioEnd, generation, 3015));
    TEST_ASSERT_EQUAL_UINT8(1, batch.count);
    AssertAction(batch, 0, ActionType::kShowStatus, Speaker::kNone, StatusId::kWaiting);
    TEST_ASSERT_EQUAL_UINT16(1, machine.completed_a());
    TEST_ASSERT_EQUAL_UINT16(1, machine.completed_b());
    TEST_ASSERT_EQUAL_UINT32(generation, machine.case_generation());
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(CaseEvent(
        EventType::kAudioEnd, generation, 3016)).count);
}

TEST_CASE("Active short case presses are rejected without data loss", "[mediation_state]") {
    MediationStateMachine machine;
    machine.Handle(StateEvent(EventType::kBoot, 0));
    ShortCase(machine, 1, 2);
    const uint32_t generation = machine.case_generation();
    AddDurablePair(machine, 3);
    machine.Handle(ButtonEvent(EventType::kButtonPressed, Button::kPersonA, 10));
    auto batch = ShortCase(machine, 11, 12);
    TEST_ASSERT_EQUAL_UINT8(1, batch.count);
    AssertAction(batch, 0, ActionType::kVibrate, Speaker::kNone,
                 StatusId::kWaiting, xiaoli::kErrorVibrateMs);
    TEST_ASSERT_EQUAL_UINT32(generation, machine.case_generation());
    TEST_ASSERT_EQUAL_UINT16(1, machine.completed_a());
    TEST_ASSERT_EQUAL_UINT16(1, machine.completed_b());
}

TEST_CASE("Case press begun while recording cannot reset after recording stops", "[mediation_state]") {
    MediationStateMachine machine;
    machine.Handle(StateEvent(EventType::kBoot, 0));
    ShortCase(machine, 1, 2);
    const uint32_t generation = machine.case_generation();
    AddDurablePair(machine, 3);
    machine.Handle(ButtonEvent(EventType::kButtonPressed, Button::kPersonA, 10));
    machine.Handle(ButtonEvent(EventType::kButtonPressed, Button::kCase, 11));
    const auto stopped = machine.Handle(ButtonEvent(
        EventType::kButtonPressed, Button::kPersonA, 12));
    AssertAction(stopped, 0, ActionType::kStopRecording, Speaker::kA);

    const auto released = machine.Handle(ButtonEvent(
        EventType::kButtonReleased, Button::kCase, 13));
    TEST_ASSERT_EQUAL_UINT8(1, released.count);
    AssertAction(released, 0, ActionType::kVibrate, Speaker::kNone,
                 StatusId::kWaiting, xiaoli::kErrorVibrateMs);
    TEST_ASSERT_EQUAL_UINT32(generation, machine.case_generation());
    TEST_ASSERT_EQUAL_UINT16(1, machine.completed_a());
    TEST_ASSERT_EQUAL_UINT16(1, machine.completed_b());
}

TEST_CASE("Case press begun while playing cannot reset after audio ends", "[mediation_state]") {
    MediationStateMachine machine;
    machine.Handle(StateEvent(EventType::kBoot, 0));
    ShortCase(machine, 1, 2);
    const uint32_t generation = machine.case_generation();
    AddDurablePair(machine, 3);
    machine.Handle(ButtonEvent(EventType::kButtonPressed, Button::kCase, 10));
    machine.Handle(StateEvent(EventType::kTick, 3010));
    machine.Handle(ButtonEvent(EventType::kButtonReleased, Button::kCase, 3011));
    machine.Handle(CaseEvent(EventType::kAudioStart, generation, 3012));
    machine.Handle(ButtonEvent(EventType::kButtonPressed, Button::kCase, 3020));
    machine.Handle(CaseEvent(EventType::kAudioEnd, generation, 3021));

    const auto released = machine.Handle(ButtonEvent(
        EventType::kButtonReleased, Button::kCase, 3022));
    TEST_ASSERT_EQUAL_UINT8(1, released.count);
    AssertAction(released, 0, ActionType::kVibrate, Speaker::kNone,
                 StatusId::kWaiting, xiaoli::kErrorVibrateMs);
    TEST_ASSERT_EQUAL_UINT32(generation, machine.case_generation());
    TEST_ASSERT_EQUAL_UINT16(1, machine.completed_a());
    TEST_ASSERT_EQUAL_UINT16(1, machine.completed_b());
}

TEST_CASE("Recoverable errors stop recording map whitelist and recover safely", "[mediation_state]") {
    MediationStateMachine machine;
    machine.Handle(StateEvent(EventType::kBoot, 0));
    Event error = StateEvent(EventType::kRecoverableError, 1);
    error.error = ErrorReason::kNetworkUnavailable;
    auto batch = machine.Handle(error);
    TEST_ASSERT_EQUAL_UINT8(2, batch.count);
    AssertAction(batch, 0, ActionType::kVibrate, Speaker::kNone,
                 StatusId::kWaiting, xiaoli::kErrorVibrateMs);
    AssertAction(batch, 1, ActionType::kShowStatus, Speaker::kNone,
                 StatusId::kNetworkUnavailable);
    batch = machine.Handle(StateEvent(EventType::kRecovered, 2));
    AssertAction(batch, 0, ActionType::kShowStatus, Speaker::kNone, StatusId::kWelcome);

    ShortCase(machine, 3, 4);
    const uint32_t generation = machine.case_generation();
    machine.Handle(AckEvent(Speaker::kA, generation, 5));
    machine.Handle(ButtonEvent(EventType::kButtonPressed, Button::kPersonB, 6));
    error = CaseEvent(EventType::kRecoverableError, generation, 7);
    error.error = ErrorReason::kRecordingIncomplete;
    batch = machine.Handle(error);
    TEST_ASSERT_EQUAL_UINT8(3, batch.count);
    AssertAction(batch, 0, ActionType::kStopRecording, Speaker::kB);
    AssertAction(batch, 1, ActionType::kVibrate, Speaker::kNone,
                 StatusId::kWaiting, xiaoli::kErrorVibrateMs);
    AssertAction(batch, 2, ActionType::kShowStatus, Speaker::kNone,
                 StatusId::kRecordingIncomplete);
    TEST_ASSERT_EQUAL_UINT16(1, machine.completed_a());
    TEST_ASSERT_EQUAL_UINT16(0, machine.completed_b());

    error = CaseEvent(EventType::kRecoverableError, generation, 8);
    error.error = ErrorReason::kAudioCapacity;
    batch = machine.Handle(error);
    TEST_ASSERT_EQUAL_UINT8(2, batch.count);
    AssertAction(batch, 1, ActionType::kShowStatus, Speaker::kNone, StatusId::kAudioCapacity);
    batch = machine.Handle(StateEvent(EventType::kRecovered, 9));
    AssertAction(batch, 0, ActionType::kShowStatus, Speaker::kNone, StatusId::kWaiting);
    TEST_ASSERT_EQUAL_UINT32(generation, machine.case_generation());
}

TEST_CASE("Nonmonotonic state events do not mutate state counters or button arming", "[mediation_state]") {
    MediationStateMachine machine;
    machine.Handle(StateEvent(EventType::kBoot, 100));
    ShortCase(machine, 101, 102);
    const uint32_t generation = machine.case_generation();
    machine.Handle(AckEvent(Speaker::kA, generation, 200));
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(AckEvent(Speaker::kB, generation, 199)).count);
    TEST_ASSERT_EQUAL_UINT16(1, machine.completed_a());
    TEST_ASSERT_EQUAL_UINT16(0, machine.completed_b());
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(ButtonEvent(
        EventType::kButtonPressed, Button::kCase, 198)).count);
    TEST_ASSERT_EQUAL_UINT8(0, machine.Handle(StateEvent(EventType::kTick, 3198)).count);
}

namespace {
struct CallbackLockFixture {
    bool lock_available = false;
    bool stopping = false;
    int lock_calls = 0;
    int stopping_calls = 0;
};

bool TryCallbackLock(void* raw) {
    auto* fixture = static_cast<CallbackLockFixture*>(raw);
    ++fixture->lock_calls;
    return fixture->lock_available;
}

bool CallbackStopInProgress(void* raw) {
    auto* fixture = static_cast<CallbackLockFixture*>(raw);
    ++fixture->stopping_calls;
    return fixture->stopping;
}
}  // namespace

TEST_CASE("WiFi callback stop lock handshake retries or returns without blocking",
          "[wifi_transport]") {
    CallbackLockFixture fixture;
    TEST_ASSERT_EQUAL(static_cast<int>(xiaoli::wifi::CallbackLockStep::kRetry),
                      static_cast<int>(xiaoli::wifi::TryCallbackLifecycleLock(
                          &TryCallbackLock, &CallbackStopInProgress, &fixture)));
    TEST_ASSERT_EQUAL_INT(1, fixture.lock_calls);
    TEST_ASSERT_EQUAL_INT(1, fixture.stopping_calls);

    fixture.stopping = true;
    TEST_ASSERT_EQUAL(static_cast<int>(xiaoli::wifi::CallbackLockStep::kStopInProgress),
                      static_cast<int>(xiaoli::wifi::TryCallbackLifecycleLock(
                          &TryCallbackLock, &CallbackStopInProgress, &fixture)));

    fixture.lock_available = true;
    const int stopping_calls = fixture.stopping_calls;
    TEST_ASSERT_EQUAL(static_cast<int>(xiaoli::wifi::CallbackLockStep::kAcquired),
                      static_cast<int>(xiaoli::wifi::TryCallbackLifecycleLock(
                          &TryCallbackLock, &CallbackStopInProgress, &fixture)));
    TEST_ASSERT_EQUAL_INT(stopping_calls, fixture.stopping_calls);
}

TEST_CASE("WiFi public call barrier rejects entrants after stop and drains existing calls",
          "[wifi_transport]") {
    xiaoli::wifi::PublicCallBarrier barrier;
    TEST_ASSERT_TRUE(barrier.Open());
    TEST_ASSERT_TRUE(barrier.TryEnter());
    TEST_ASSERT_TRUE(barrier.TryEnter());
    barrier.Close();
    TEST_ASSERT_FALSE(barrier.TryEnter());
    TEST_ASSERT_FALSE(barrier.Open());
    TEST_ASSERT_EQUAL_UINT32(2, barrier.in_flight());
    TEST_ASSERT_EQUAL_UINT32(1, barrier.Exit());
    TEST_ASSERT_EQUAL_UINT32(0, barrier.Exit());
    TEST_ASSERT_EQUAL_UINT32(0, barrier.in_flight());

    TEST_ASSERT_TRUE(barrier.Open());
    TEST_ASSERT_TRUE(barrier.TryEnter());
    barrier.Close();
    TEST_ASSERT_FALSE(barrier.Open());
    TEST_ASSERT_EQUAL_UINT32(1, barrier.in_flight());
    TEST_ASSERT_EQUAL_UINT32(0, barrier.Exit());
    TEST_ASSERT_TRUE(barrier.Open());
    TEST_ASSERT_EQUAL_UINT32(0, barrier.in_flight());
}

namespace {
struct MdnsOwnershipFixture {
    int resolve_calls = 0;
    int init_calls = 0;
    bool initially_missing = false;
};

esp_err_t OwnershipResolve(const char*, uint32_t, uint32_t* address, void* raw) {
    auto* fixture = static_cast<MdnsOwnershipFixture*>(raw);
    ++fixture->resolve_calls;
    if (fixture->initially_missing && fixture->resolve_calls == 1) {
        return ESP_ERR_INVALID_STATE;
    }
    *address = 0xc0a80108;
    return fixture->initially_missing ? ESP_OK : ESP_ERR_NOT_FOUND;
}

esp_err_t OwnershipInit(void* raw) {
    auto* fixture = static_cast<MdnsOwnershipFixture*>(raw);
    ++fixture->init_calls;
    return ESP_OK;
}
}  // namespace

TEST_CASE("WiFi mDNS ownership follows query state rather than hostname presence",
          "[wifi_transport]") {
    std::string resolved;
    bool owned = false;
    MdnsOwnershipFixture existing;
    TEST_ASSERT_EQUAL(ESP_ERR_NOT_FOUND, xiaoli::wifi::ResolveEndpointWithMdnsOwnership(
        "ws://xiaoli-bridge.local:8788/device", &OwnershipResolve, &OwnershipInit,
        &existing, owned, resolved));
    TEST_ASSERT_EQUAL_INT(1, existing.resolve_calls);
    TEST_ASSERT_EQUAL_INT(0, existing.init_calls);
    TEST_ASSERT_FALSE(owned);

    MdnsOwnershipFixture missing;
    missing.initially_missing = true;
    TEST_ASSERT_EQUAL(ESP_OK, xiaoli::wifi::ResolveEndpointWithMdnsOwnership(
        "ws://xiaoli-bridge.local:8788/device", &OwnershipResolve, &OwnershipInit,
        &missing, owned, resolved));
    TEST_ASSERT_EQUAL_INT(2, missing.resolve_calls);
    TEST_ASSERT_EQUAL_INT(1, missing.init_calls);
    TEST_ASSERT_TRUE(owned);
    TEST_ASSERT_EQUAL_STRING("ws://192.168.1.8:8788/device", resolved.c_str());
}

namespace {

xiaoli::PendingSegmentMeta SegmentMeta(const char* case_id,
                                       const char* segment_id,
                                       const char* start_id,
                                       const char* end_id,
                                       xiaoli::Speaker speaker,
                                       uint32_t generation) {
    xiaoli::PendingSegmentMeta meta{};
    snprintf(meta.case_id, sizeof(meta.case_id), "%s", case_id);
    snprintf(meta.segment_id, sizeof(meta.segment_id), "%s", segment_id);
    snprintf(meta.start_message_id, sizeof(meta.start_message_id), "%s", start_id);
    snprintf(meta.end_message_id, sizeof(meta.end_message_id), "%s", end_id);
    snprintf(meta.start_json, sizeof(meta.start_json),
             "{\"v\":1,\"type\":\"speech.start\",\"messageId\":\"%s\","
             "\"caseId\":\"%s\",\"segmentId\":\"%s\",\"speaker\":\"%s\","
             "\"audio\":{\"sampleRate\":16000,\"bits\":16,\"channels\":1}}",
             start_id, case_id, segment_id,
             speaker == xiaoli::Speaker::kA ? "A" : "B");
    meta.speaker = speaker;
    meta.case_generation = generation;
    return meta;
}

xiaoli::DurableAck Durable(const char* case_id, const char* segment_id,
                           const char* message_id, uint32_t bytes,
                           bool durable = true) {
    xiaoli::DurableAck ack{};
    snprintf(ack.case_id, sizeof(ack.case_id), "%s", case_id);
    snprintf(ack.segment_id, sizeof(ack.segment_id), "%s", segment_id);
    snprintf(ack.message_id, sizeof(ack.message_id), "%s", message_id);
    ack.bytes = bytes;
    ack.durable = durable;
    return ack;
}

}  // namespace

static_assert(BUTTON_PERSON_A_PIN == GPIO_NUM_40);
static_assert(BUTTON_PERSON_B_PIN == GPIO_NUM_39);
static_assert(BUTTON_BOOT_PIN == GPIO_NUM_0);
static_assert(AUDIO_PA_EN == GPIO_NUM_3);
static_assert(AUDIO_I2S_DIN == GPIO_NUM_12);
static_assert(HAPTIC_PIN == GPIO_NUM_1);

TEST_CASE("Pending audio accepts its exact capacity and atomically rejects overflow",
          "[pending_audio]") {
    std::array<uint8_t, 16> a{};
    std::array<uint8_t, 16> b{};
    xiaoli::PendingAudioStore store;
    TEST_ASSERT_TRUE(store.InitWithBuffers(a.data(), b.data(), a.size()));

    xiaoli::SlotId slot = xiaoli::kInvalidSlot;
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::StoreResult::kOk),
        static_cast<uint8_t>(store.Begin(
            SegmentMeta("case-1", "segment-a", "start-a", "start-a-end",
                        xiaoli::Speaker::kA, 7), &slot)));
    const uint8_t exact[16] = {0, 1, 2, 3, 4, 5, 6, 7,
                               8, 9, 10, 11, 12, 13, 14, 15};
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::StoreResult::kOk),
        static_cast<uint8_t>(store.Append(slot, exact, sizeof(exact))));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::StoreResult::kOverflow),
        static_cast<uint8_t>(store.Append(slot, exact, 1)));
    xiaoli::PendingSegmentView view{};
    TEST_ASSERT_TRUE(store.Get(slot, &view));
    TEST_ASSERT_EQUAL_UINT32(sizeof(exact), view.bytes);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(exact, view.pcm, sizeof(exact));
}

TEST_CASE("Pending audio keeps two speakers and replays complete slots oldest first",
          "[pending_audio]") {
    std::array<uint8_t, 8> a{};
    std::array<uint8_t, 8> b{};
    xiaoli::PendingAudioStore store;
    TEST_ASSERT_TRUE(store.InitWithBuffers(a.data(), b.data(), a.size()));
    xiaoli::SlotId first = xiaoli::kInvalidSlot;
    xiaoli::SlotId second = xiaoli::kInvalidSlot;
    const uint8_t pcm_a[] = {1, 2};
    const uint8_t pcm_b[] = {3, 4, 5, 6};

    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::StoreResult::kOk),
        static_cast<uint8_t>(store.Begin(SegmentMeta(
            "case", "a", "sa", "sa-end", xiaoli::Speaker::kA, 3), &first)));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::StoreResult::kOk),
        static_cast<uint8_t>(store.Append(first, pcm_a, sizeof(pcm_a))));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::StoreResult::kOk),
        static_cast<uint8_t>(store.MarkLocallyComplete(first)));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::StoreResult::kOk),
        static_cast<uint8_t>(store.Begin(SegmentMeta(
            "case", "b", "sb", "sb-end", xiaoli::Speaker::kB, 3), &second)));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::StoreResult::kOk),
        static_cast<uint8_t>(store.Append(second, pcm_b, sizeof(pcm_b))));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::StoreResult::kOk),
        static_cast<uint8_t>(store.MarkLocallyComplete(second)));

    xiaoli::SlotId third = xiaoli::kInvalidSlot;
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::StoreResult::kNoFreeSlot),
        static_cast<uint8_t>(store.Begin(SegmentMeta(
            "other", "third", "sc", "sc-end", xiaoli::Speaker::kA, 4), &third)));
    xiaoli::PendingSegmentView oldest{};
    TEST_ASSERT_TRUE(store.OldestCompleteUnacked(&oldest));
    TEST_ASSERT_EQUAL_UINT8(first, oldest.slot);
    TEST_ASSERT_EQUAL_STRING("a", oldest.meta.segment_id);
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::Speaker::kA),
                            static_cast<uint8_t>(oldest.meta.speaker));
    TEST_ASSERT_EQUAL_UINT8_ARRAY(pcm_a, oldest.pcm, sizeof(pcm_a));
}

TEST_CASE("Incomplete audio is zeroed and never enters replay iteration",
          "[pending_audio]") {
    std::array<uint8_t, 8> a{};
    std::array<uint8_t, 8> b{};
    xiaoli::PendingAudioStore store;
    TEST_ASSERT_TRUE(store.InitWithBuffers(a.data(), b.data(), a.size()));
    xiaoli::SlotId slot = xiaoli::kInvalidSlot;
    const uint8_t pcm[] = {9, 8, 7, 6};
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::StoreResult::kOk),
        static_cast<uint8_t>(store.Begin(SegmentMeta(
            "case", "bad", "start", "start-end", xiaoli::Speaker::kA, 1), &slot)));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::StoreResult::kOk),
        static_cast<uint8_t>(store.Append(slot, pcm, sizeof(pcm))));
    store.AbortIncomplete(slot);
    TEST_ASSERT_TRUE(store.HasFreeSlot());
    xiaoli::PendingSegmentView view{};
    TEST_ASSERT_FALSE(store.OldestCompleteUnacked(&view));
    TEST_ASSERT_EQUAL_UINT8(0, a[0]);
    TEST_ASSERT_EQUAL_UINT8(0, a[1]);
    TEST_ASSERT_EQUAL_UINT8(0, a[2]);
    TEST_ASSERT_EQUAL_UINT8(0, a[3]);
}

TEST_CASE("Only the exact durable end ACK releases one pending segment",
          "[pending_audio]") {
    std::array<uint8_t, 8> a{};
    std::array<uint8_t, 8> b{};
    xiaoli::PendingAudioStore store;
    TEST_ASSERT_TRUE(store.InitWithBuffers(a.data(), b.data(), a.size()));
    xiaoli::SlotId first = xiaoli::kInvalidSlot;
    xiaoli::SlotId second = xiaoli::kInvalidSlot;
    const uint8_t pcm[] = {1, 2, 3, 4};
    store.Begin(SegmentMeta("case", "a", "start-a", "start-a-end",
                            xiaoli::Speaker::kA, 5), &first);
    store.Append(first, pcm, sizeof(pcm));
    store.MarkLocallyComplete(first);
    store.Begin(SegmentMeta("case", "b", "start-b", "start-b-end",
                            xiaoli::Speaker::kB, 5), &second);
    store.Append(second, pcm, sizeof(pcm));
    store.MarkLocallyComplete(second);

    TEST_ASSERT_FALSE(store.ApplyDurableAck(Durable(
        "case", "a", "start-a", sizeof(pcm), false)).released);
    TEST_ASSERT_FALSE(store.ApplyDurableAck(Durable(
        "wrong", "a", "start-a-end", sizeof(pcm))).released);
    TEST_ASSERT_FALSE(store.ApplyDurableAck(Durable(
        "case", "wrong", "start-a-end", sizeof(pcm))).released);
    TEST_ASSERT_FALSE(store.ApplyDurableAck(Durable(
        "case", "a", "wrong-end", sizeof(pcm))).released);
    TEST_ASSERT_FALSE(store.ApplyDurableAck(Durable(
        "case", "a", "start-a-end", sizeof(pcm) + 2)).released);
    TEST_ASSERT_EQUAL_UINT8(2, store.CompleteCount());

    const auto released = store.ApplyDurableAck(Durable(
        "case", "a", "start-a-end", sizeof(pcm)));
    TEST_ASSERT_TRUE(released.released);
    TEST_ASSERT_EQUAL_UINT8(first, released.slot);
    TEST_ASSERT_NOT_EQUAL(0, released.insertion_ordinal);
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::Speaker::kA),
                            static_cast<uint8_t>(released.speaker));
    TEST_ASSERT_EQUAL_UINT32(5, released.case_generation);
    TEST_ASSERT_EQUAL_UINT32(sizeof(pcm), released.bytes);
    TEST_ASSERT_EQUAL_UINT8(1, store.CompleteCount());
    TEST_ASSERT_FALSE(store.ApplyDurableAck(Durable(
        "case", "a", "start-a-end", sizeof(pcm))).released);
    xiaoli::PendingSegmentView oldest{};
    TEST_ASSERT_TRUE(store.OldestCompleteUnacked(&oldest));
    TEST_ASSERT_EQUAL_STRING("b", oldest.meta.segment_id);
}

TEST_CASE("Business IDs are boot-epoch unique and require committed storage",
          "[mediation_runtime]") {
    const uint8_t mac[6] = {0xaa, 0xbb, 0xcc, 0x01, 0x02, 0x03};
    xiaoli::BusinessIdGenerator boot_one;
    xiaoli::BusinessIdGenerator boot_two;
    xiaoli::BusinessIdGenerator failed;
    TEST_ASSERT_TRUE(boot_one.Initialize(mac, 41, true));
    TEST_ASSERT_TRUE(boot_two.Initialize(mac, 42, true));
    TEST_ASSERT_FALSE(failed.Initialize(mac, 43, false));
    char case_one[xiaoli::kIdCapacity] = {};
    char case_two[xiaoli::kIdCapacity] = {};
    char message_one[xiaoli::kIdCapacity] = {};
    char message_two[xiaoli::kIdCapacity] = {};
    TEST_ASSERT_TRUE(boot_one.NextCase(case_one, sizeof(case_one)));
    TEST_ASSERT_TRUE(boot_two.NextCase(case_two, sizeof(case_two)));
    TEST_ASSERT_TRUE(boot_one.NextMessage(message_one, sizeof(message_one)));
    TEST_ASSERT_TRUE(boot_two.NextMessage(message_two, sizeof(message_two)));
    TEST_ASSERT_NOT_EQUAL(0, strcmp(case_one, case_two));
    TEST_ASSERT_NOT_EQUAL(0, strcmp(message_one, message_two));
    TEST_ASSERT_FALSE(failed.NextCase(case_one, sizeof(case_one)));
}

TEST_CASE("Replay cursor retries the same 640 byte frame without advancing",
          "[mediation_runtime]") {
    xiaoli::ReplayFrameCursor cursor;
    cursor.Reset(1300);
    TEST_ASSERT_EQUAL_UINT32(0, cursor.offset());
    TEST_ASSERT_EQUAL_UINT16(0, cursor.sequence());
    TEST_ASSERT_EQUAL_UINT32(640, cursor.CurrentBytes());
    cursor.OnTimeout();
    TEST_ASSERT_EQUAL_UINT32(0, cursor.offset());
    TEST_ASSERT_EQUAL_UINT16(0, cursor.sequence());
    cursor.CommitSuccess();
    TEST_ASSERT_EQUAL_UINT32(640, cursor.offset());
    TEST_ASSERT_EQUAL_UINT16(1, cursor.sequence());
    TEST_ASSERT_EQUAL_UINT32(640, cursor.CurrentBytes());
    cursor.CommitSuccess();
    TEST_ASSERT_EQUAL_UINT32(20, cursor.CurrentBytes());
    cursor.CommitSuccess();
    TEST_ASSERT_TRUE(cursor.done());
    TEST_ASSERT_EQUAL_UINT16(3, cursor.sequence());
}

TEST_CASE("Connection replay ledger suppresses immediate resend until reconnect",
          "[mediation_runtime]") {
    xiaoli::ConnectionReplayLedger ledger;
    constexpr xiaoli::SlotId slot = 1;
    constexpr uint64_t ordinal = 42;
    TEST_ASSERT_FALSE(ledger.WasSent(slot, ordinal));
    ledger.MarkSent(slot, ordinal);
    TEST_ASSERT_TRUE(ledger.WasSent(slot, ordinal));
    TEST_ASSERT_FALSE(ledger.WasSent(slot, ordinal + 1));
    ledger.Reset();
    TEST_ASSERT_FALSE(ledger.WasSent(slot, ordinal));
}

TEST_CASE("Durable retry ACK can recover an end-admission error without losing count",
          "[mediation_state]") {
    MediationStateMachine machine;
    machine.Handle(StateEvent(EventType::kBoot, 0));
    ShortCase(machine, 1, 2);
    const uint32_t generation = machine.case_generation();
    Event error = CaseEvent(EventType::kRecoverableError, generation, 3);
    error.error = ErrorReason::kNetworkUnavailable;
    machine.Handle(error);
    TEST_ASSERT_EQUAL_UINT8(
        static_cast<uint8_t>(MediationState::kRecoverableError),
        static_cast<uint8_t>(machine.state()));

    machine.Handle(AckEvent(Speaker::kA, generation, 4));
    TEST_ASSERT_EQUAL_UINT16(1, machine.completed_a());
    machine.Handle(CaseEvent(EventType::kRecovered, generation, 5));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(MediationState::kWaiting),
                            static_cast<uint8_t>(machine.state()));
}

TEST_CASE("Bridge parser accepts exact durable ACK and rejects unsafe variants",
          "[bridge_message]") {
    const char exact[] =
        "{\"v\":1,\"type\":\"ack\",\"messageId\":\"end-a\","
        "\"caseId\":\"case\",\"segmentId\":\"a\",\"bytes\":640,\"durable\":true}";
    xiaoli::BridgeMessage message{};
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::BridgeParseResult::kOk),
        static_cast<uint8_t>(xiaoli::ParseBridgeMessage(
            reinterpret_cast<const uint8_t*>(exact), strlen(exact), &message)));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::BridgeMessageType::kAck),
                            static_cast<uint8_t>(message.type));
    TEST_ASSERT_TRUE(message.has_durable);
    TEST_ASSERT_TRUE(message.durable);
    TEST_ASSERT_TRUE(message.has_bytes);
    TEST_ASSERT_EQUAL_UINT32(640, message.bytes);
    TEST_ASSERT_EQUAL_STRING("end-a", message.message_id);

    const char trailing[] =
        "{\"v\":1,\"type\":\"ack\",\"messageId\":\"x\",\"caseId\":\"c\","
        "\"segmentId\":\"s\",\"bytes\":2,\"durable\":true}garbage";
    const char wrong_type[] =
        "{\"v\":1,\"type\":\"ack\",\"messageId\":9,\"caseId\":\"c\","
        "\"segmentId\":\"s\",\"bytes\":2,\"durable\":true}";
    const char overflow[] =
        "{\"v\":1,\"type\":\"ack\",\"messageId\":\"x\",\"caseId\":\"c\","
        "\"segmentId\":\"s\",\"bytes\":4294967296,\"durable\":true}";
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::BridgeParseResult::kInvalid),
        static_cast<uint8_t>(xiaoli::ParseBridgeMessage(
            reinterpret_cast<const uint8_t*>(trailing), strlen(trailing), &message)));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::BridgeParseResult::kInvalid),
        static_cast<uint8_t>(xiaoli::ParseBridgeMessage(
            reinterpret_cast<const uint8_t*>(wrong_type), strlen(wrong_type), &message)));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::BridgeParseResult::kInvalid),
        static_cast<uint8_t>(xiaoli::ParseBridgeMessage(
            reinterpret_cast<const uint8_t*>(overflow), strlen(overflow), &message)));
    std::array<uint8_t, xiaoli::kMaxBridgeMessageBytes + 1> oversized{};
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::BridgeParseResult::kOversized),
        static_cast<uint8_t>(xiaoli::ParseBridgeMessage(
            oversized.data(), oversized.size(), &message)));
}

TEST_CASE("Bridge parser distinguishes harmless state transcript and start ACK",
          "[bridge_message]") {
    xiaoli::BridgeMessage message{};
    const char start_ack[] =
        "{\"v\":1,\"type\":\"ack\",\"messageId\":\"start\","
        "\"caseId\":\"case\",\"segmentId\":\"a\",\"accepted\":true}";
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::BridgeParseResult::kOk),
        static_cast<uint8_t>(xiaoli::ParseBridgeMessage(
            reinterpret_cast<const uint8_t*>(start_ack), strlen(start_ack), &message)));
    TEST_ASSERT_TRUE(message.has_accepted);
    TEST_ASSERT_FALSE(message.has_durable);
    const char transcript[] =
        "{\"v\":1,\"type\":\"transcript.saved\",\"caseId\":\"case\","
        "\"segmentId\":\"a\",\"speaker\":\"A\"}";
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::BridgeParseResult::kOk),
        static_cast<uint8_t>(xiaoli::ParseBridgeMessage(
            reinterpret_cast<const uint8_t*>(transcript), strlen(transcript), &message)));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::BridgeMessageType::kTranscriptSaved),
                            static_cast<uint8_t>(message.type));
    const char state[] =
        "{\"v\":1,\"type\":\"state\",\"state\":\"transcribing\","
        "\"caseId\":\"case\",\"segmentId\":\"a\"}";
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::BridgeParseResult::kOk),
        static_cast<uint8_t>(xiaoli::ParseBridgeMessage(
            reinterpret_cast<const uint8_t*>(state), strlen(state), &message)));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(xiaoli::BridgeMessageType::kState),
                            static_cast<uint8_t>(message.type));
}

TEST_CASE("Playback completion waits for validated end metadata and local drain",
          "[mediation_runtime]") {
    xiaoli::PlaybackSession playback;
    TEST_ASSERT_TRUE(playback.Begin("case", 9, 20000, 16000, 16, 1));
    TEST_ASSERT_TRUE(playback.AcceptChunk(12000, 12000));
    TEST_ASSERT_TRUE(playback.AcceptChunk(8000, 8000));
    TEST_ASSERT_FALSE(playback.AcceptEnd("other", 20000, 1, true));
    TEST_ASSERT_FALSE(playback.AcceptEnd("case", 19998, 1, true));
    TEST_ASSERT_FALSE(playback.AcceptEnd("case", 20000, 0, true));
    TEST_ASSERT_FALSE(playback.AcceptEnd("case", 20000, 1, false));
    TEST_ASSERT_TRUE(playback.AcceptEnd("case", 20000, 1, true));
    TEST_ASSERT_TRUE(playback.MarkWritten(20000));
    TEST_ASSERT_FALSE(playback.ReadyToFinish(false));
    TEST_ASSERT_TRUE(playback.ReadyToFinish(true));
    TEST_ASSERT_EQUAL_UINT32(9, playback.case_generation());
}

TEST_CASE("Playback accepts bursts beyond 16 KiB and fails closed on overflow",
          "[mediation_runtime]") {
    xiaoli::PlaybackSession playback;
    TEST_ASSERT_TRUE(playback.Begin("case", 1, xiaoli::kMaxPlaybackBytes,
                                    16000, 16, 1));
    TEST_ASSERT_TRUE(playback.AcceptChunk(20000, 20000));
    TEST_ASSERT_EQUAL_UINT32(20000, playback.received_bytes());
    TEST_ASSERT_FALSE(playback.AcceptChunk(xiaoli::kMaxPlaybackBytes, 0));
    TEST_ASSERT_TRUE(playback.incomplete());
    TEST_ASSERT_FALSE(playback.ReadyToFinish(true));
    TEST_ASSERT_FALSE(playback.Begin("case", 1, xiaoli::kMaxPlaybackBytes + 2,
                                     16000, 16, 1));
}

TEST_CASE("Playback ingress accounting precedes a deterministically interleaved reader",
          "[mediation_runtime]") {
    xiaoli::PlaybackSession playback;
    TEST_ASSERT_TRUE(playback.Begin("case", 2, 640, 16000, 16, 1));

    // Producer reserves before publishing to the stream buffer.  A reader
    // that runs immediately afterwards must be able to account the bytes.
    TEST_ASSERT_TRUE(playback.ReserveChunk(640));
    TEST_ASSERT_TRUE(playback.MarkWritten(640));
    TEST_ASSERT_TRUE(playback.AcceptEnd("case", 640, 0, true));
    TEST_ASSERT_TRUE(playback.ReadyToFinish(true));

    TEST_ASSERT_TRUE(playback.Begin("case", 3, 640, 16000, 16, 1));
    TEST_ASSERT_TRUE(playback.ReserveChunk(640));
    playback.FailIngress();
    TEST_ASSERT_TRUE(playback.incomplete());
    TEST_ASSERT_FALSE(playback.ReadyToFinish(true));
}

TEST_CASE("Haptic duration clamps without delay semantics", "[mediation_runtime]") {
    TEST_ASSERT_EQUAL_UINT32(20, xiaoli::ClampHapticDuration(0));
    TEST_ASSERT_EQUAL_UINT32(20, xiaoli::ClampHapticDuration(19));
    TEST_ASSERT_EQUAL_UINT32(120, xiaoli::ClampHapticDuration(120));
    TEST_ASSERT_EQUAL_UINT32(3000, xiaoli::ClampHapticDuration(4000));
}

TEST_CASE("New case can be denied before state generation changes", "[mediation_state]") {
    MediationStateMachine machine;
    machine.Handle(StateEvent(EventType::kBoot, 0));
    ShortCase(machine, 1, 2);
    const uint32_t generation = machine.case_generation();
    Event press = ButtonEvent(EventType::kButtonPressed, Button::kCase, 10);
    Event release = ButtonEvent(EventType::kButtonReleased, Button::kCase, 11);
    release.allow_new_case = false;
    machine.Handle(press);
    const auto batch = machine.Handle(release);
    TEST_ASSERT_EQUAL_UINT8(1, batch.count);
    AssertAction(batch, 0, ActionType::kVibrate, Speaker::kNone,
                 StatusId::kWaiting, xiaoli::kErrorVibrateMs);
    TEST_ASSERT_EQUAL_UINT32(generation, machine.case_generation());
}

extern "C" void app_main(void) {
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
