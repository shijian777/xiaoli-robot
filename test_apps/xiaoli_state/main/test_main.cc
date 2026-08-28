#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <vector>

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

extern "C" void app_main(void) {
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
