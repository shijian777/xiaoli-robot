#pragma once

#include <cstddef>
#include <string>

namespace xiaoli::wifi {

constexpr size_t kEndpointCapacity = 192;

enum class EndpointScheme {
    kWs,
    kWss,
};

struct ParsedEndpoint {
    EndpointScheme scheme = EndpointScheme::kWs;
    std::string host;
    std::string port;
    bool private_ipv4 = false;
    bool local_hostname = false;
};

bool ParseEndpoint(const char* endpoint, ParsedEndpoint& parsed);

}  // namespace xiaoli::wifi
