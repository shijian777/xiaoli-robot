#include "wifi_endpoint.h"

#include <cctype>
#include <cstring>

namespace xiaoli::wifi {
namespace {

bool ValidHostname(const char* host, size_t host_len) {
    if (host_len == 0 || host_len > 253) return false;
    bool label_start = true;
    size_t label_len = 0;
    for (size_t i = 0; i < host_len; ++i) {
        const unsigned char c = static_cast<unsigned char>(host[i]);
        if (c == '.') {
            if (label_start || host[i - 1] == '-' || label_len > 63) return false;
            label_start = true;
            label_len = 0;
        } else {
            if (!(std::isalnum(c) || c == '-') || (label_start && c == '-')) return false;
            label_start = false;
            ++label_len;
        }
    }
    return !label_start && host[host_len - 1] != '-' && label_len <= 63;
}

bool HasLocalSuffix(const std::string& host) {
    constexpr char kSuffix[] = ".local";
    if (host.size() <= sizeof(kSuffix) - 1) return false;
    const size_t offset = host.size() - (sizeof(kSuffix) - 1);
    for (size_t i = 0; i < sizeof(kSuffix) - 1; ++i) {
        if (std::tolower(static_cast<unsigned char>(host[offset + i])) != kSuffix[i]) {
            return false;
        }
    }
    return true;
}

bool HasPublicDnsShape(const std::string& host) {
    const size_t dot = host.rfind('.');
    if (dot == std::string::npos || dot == 0 || dot + 1 == host.size()) return false;
    for (size_t i = dot + 1; i < host.size(); ++i) {
        if (std::isalpha(static_cast<unsigned char>(host[i]))) return true;
    }
    return false;
}

enum class Ipv4ParseResult {
    kNotIpv4,
    kInvalid,
    kValid,
};

Ipv4ParseResult ParseCanonicalIpv4(const std::string& host,
                                   unsigned octets[4]) {
    for (const unsigned char c : host) {
        if (!std::isdigit(c) && c != '.') return Ipv4ParseResult::kNotIpv4;
    }
    size_t cursor = 0;
    for (size_t index = 0; index < 4; ++index) {
        const size_t start = cursor;
        unsigned value = 0;
        while (cursor < host.size() && host[cursor] != '.') {
            value = value * 10u + static_cast<unsigned>(host[cursor] - '0');
            ++cursor;
        }
        const size_t digits = cursor - start;
        if (digits == 0 || digits > 3 ||
            (digits > 1 && host[start] == '0') || value > 255) {
            return Ipv4ParseResult::kInvalid;
        }
        octets[index] = value;
        if (index < 3) {
            if (cursor >= host.size() || host[cursor] != '.') {
                return Ipv4ParseResult::kInvalid;
            }
            ++cursor;
        }
    }
    return cursor == host.size() ? Ipv4ParseResult::kValid
                                 : Ipv4ParseResult::kInvalid;
}

size_t BoundedLength(const char* value, size_t capacity) {
    size_t len = 0;
    while (len < capacity && value[len] != '\0') ++len;
    return len;
}

}  // namespace

bool ParseEndpoint(const char* endpoint, ParsedEndpoint& parsed) {
    parsed = {};
    if (endpoint == nullptr) return false;
    const size_t len = BoundedLength(endpoint, kEndpointCapacity);
    if (len == 0 || len >= kEndpointCapacity) return false;
    constexpr char kWsPrefix[] = "ws://";
    constexpr char kWssPrefix[] = "wss://";
    size_t prefix_len = 0;
    if (len > sizeof(kWssPrefix) - 1 &&
        strncmp(endpoint, kWssPrefix, sizeof(kWssPrefix) - 1) == 0) {
        parsed.scheme = EndpointScheme::kWss;
        prefix_len = sizeof(kWssPrefix) - 1;
    } else if (len > sizeof(kWsPrefix) - 1 &&
               strncmp(endpoint, kWsPrefix, sizeof(kWsPrefix) - 1) == 0) {
        parsed.scheme = EndpointScheme::kWs;
        prefix_len = sizeof(kWsPrefix) - 1;
    } else {
        return false;
    }
    for (size_t i = 0; i < len; ++i) {
        const unsigned char c = static_cast<unsigned char>(endpoint[i]);
        if (c <= 0x20 || c >= 0x7f || c == '@' || c == '?' || c == '#' || c == '%') {
            return false;
        }
    }

    const char* authority = endpoint + prefix_len;
    const char* path = strchr(authority, '/');
    if (path == nullptr || strcmp(path, "/device") != 0 || path == authority) return false;
    const char* host_end = path;
    const char* colon = static_cast<const char*>(memchr(authority, ':', path - authority));
    if (colon != nullptr) {
        if (colon == authority || colon + 1 == path) return false;
        unsigned port = 0;
        for (const char* p = colon + 1; p < path; ++p) {
            if (!std::isdigit(static_cast<unsigned char>(*p))) return false;
            port = port * 10u + static_cast<unsigned>(*p - '0');
            if (port > 65535u) return false;
        }
        if (port == 0) return false;
        host_end = colon;
        parsed.port.assign(colon + 1, path);
    }

    const size_t host_len = static_cast<size_t>(host_end - authority);
    if (!ValidHostname(authority, host_len)) return false;
    parsed.host.assign(authority, host_end);

    unsigned octets[4] = {};
    const Ipv4ParseResult ipv4 = ParseCanonicalIpv4(parsed.host, octets);
    if (ipv4 == Ipv4ParseResult::kInvalid) return false;
    if (ipv4 == Ipv4ParseResult::kValid) {
        parsed.private_ipv4 = octets[0] == 10 ||
                              (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31) ||
                              (octets[0] == 192 && octets[1] == 168);
        return parsed.scheme == EndpointScheme::kWs && parsed.private_ipv4;
    }

    parsed.local_hostname = HasLocalSuffix(parsed.host);
    if (parsed.scheme == EndpointScheme::kWs) return parsed.local_hostname;
    return !parsed.local_hostname && HasPublicDnsShape(parsed.host);
}

}  // namespace xiaoli::wifi
