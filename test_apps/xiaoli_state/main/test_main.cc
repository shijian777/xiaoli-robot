#include <cstdint>
#include <cstring>
#include <vector>

#include "protocol.h"
#include "unity.h"
#include "wifi_provision.h"
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

extern "C" void app_main(void) {
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
