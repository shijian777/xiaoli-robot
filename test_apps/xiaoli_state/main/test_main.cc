#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <type_traits>
#include <vector>

#include "mediation_state.h"
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

extern "C" void app_main(void) {
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
