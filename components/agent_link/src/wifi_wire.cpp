#include "wifi_wire.h"

#include <limits>

namespace xiaoli {
namespace {

constexpr uint8_t kMagic0 = 0x58;
constexpr uint8_t kMagic1 = 0x4c;
constexpr uint8_t kVersion = 1;

bool IsSupportedKind(uint8_t kind) {
    return kind >= static_cast<uint8_t>(WireKind::kControl) &&
           kind <= static_cast<uint8_t>(WireKind::kStreamEnd);
}

bool IsSupportedStreamType(uint8_t stream_type) {
    return stream_type <= 4;
}

}  // namespace

bool EncodeWireFrame(const WireFrame& frame, std::vector<uint8_t>& output) {
    output.clear();

    const uint8_t kind = static_cast<uint8_t>(frame.kind);
    if (!IsSupportedKind(kind) ||
        !IsSupportedStreamType(frame.stream_type) ||
        frame.payload_len > std::numeric_limits<uint16_t>::max() ||
        (frame.payload_len > 0 && frame.payload == nullptr)) {
        return false;
    }

    output.reserve(kWireHeaderSize + frame.payload_len);
    output.push_back(kMagic0);
    output.push_back(kMagic1);
    output.push_back(kVersion);
    output.push_back(kind);
    output.push_back(frame.stream_type);
    output.push_back(frame.flags);
    output.push_back(static_cast<uint8_t>(frame.sequence & 0xff));
    output.push_back(static_cast<uint8_t>((frame.sequence >> 8) & 0xff));
    if (frame.payload_len > 0) {
        output.insert(output.end(), frame.payload, frame.payload + frame.payload_len);
    }
    return true;
}

bool DecodeWireFrame(const uint8_t* data, size_t len, WireFrame& output) {
    if (data == nullptr || len < kWireHeaderSize) {
        return false;
    }

    const size_t payload_len = len - kWireHeaderSize;
    if (data[0] != kMagic0 ||
        data[1] != kMagic1 ||
        data[2] != kVersion ||
        !IsSupportedKind(data[3]) ||
        !IsSupportedStreamType(data[4]) ||
        payload_len > std::numeric_limits<uint16_t>::max()) {
        return false;
    }

    WireFrame decoded{};
    decoded.kind = static_cast<WireKind>(data[3]);
    decoded.stream_type = data[4];
    decoded.flags = data[5];
    decoded.sequence = static_cast<uint16_t>(data[6]) |
                       (static_cast<uint16_t>(data[7]) << 8);
    decoded.payload = data + kWireHeaderSize;
    decoded.payload_len = payload_len;
    output = decoded;
    return true;
}

}  // namespace xiaoli
