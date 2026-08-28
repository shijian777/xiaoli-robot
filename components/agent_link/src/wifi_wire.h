#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace xiaoli {

constexpr size_t kWireHeaderSize = 8;

enum class WireKind : uint8_t {
    kControl = 1,
    kStreamStart = 2,
    kStreamChunk = 3,
    kStreamEnd = 4,
};

struct WireFrame {
    WireKind kind;
    uint8_t stream_type;
    uint8_t flags;
    uint16_t sequence;
    const uint8_t* payload;
    size_t payload_len;
};

bool EncodeWireFrame(const WireFrame& frame, std::vector<uint8_t>& output);
bool DecodeWireFrame(const uint8_t* data, size_t len, WireFrame& output);

}  // namespace xiaoli
