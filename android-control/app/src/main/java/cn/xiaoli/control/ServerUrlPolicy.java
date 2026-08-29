package cn.xiaoli.control;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** Defines the one HTTPS origin that the WebView may navigate within. */
public final class ServerUrlPolicy {
    private static final int HTTPS_DEFAULT_PORT = 443;

    private final String host;
    private final int effectivePort;
    private final String origin;

    private ServerUrlPolicy(String host, int effectivePort, String origin) {
        this.host = host;
        this.effectivePort = effectivePort;
        this.origin = origin;
    }

    public static ServerUrlPolicy fromUserInput(String input) {
        URI uri = parseUri(input);
        if (!isHttpsHierarchicalUrl(uri) || uri.getRawUserInfo() != null) {
            throw invalidAddress();
        }

        String parsedHost = uri.getHost();
        int parsedPort = uri.getPort();
        if (parsedHost == null || parsedHost.trim().isEmpty() || !hasValidPort(uri)) {
            throw invalidAddress();
        }

        String canonicalHost = parsedHost.toLowerCase(Locale.ROOT);
        int canonicalPort = parsedPort == -1 ? HTTPS_DEFAULT_PORT : parsedPort;
        int renderedPort = canonicalPort == HTTPS_DEFAULT_PORT ? -1 : canonicalPort;
        try {
            String canonicalOrigin = new URI(
                    "https", null, canonicalHost, renderedPort, null, null, null)
                    .toASCIIString();
            return new ServerUrlPolicy(canonicalHost, canonicalPort, canonicalOrigin);
        } catch (URISyntaxException error) {
            throw invalidAddress();
        }
    }

    public String origin() {
        return origin;
    }

    public String dashboardUrl() {
        return origin + "/mobile/";
    }

    public boolean isAllowedNavigation(String candidate) {
        URI uri;
        try {
            uri = parseUri(candidate);
        } catch (IllegalArgumentException error) {
            return false;
        }

        if (!isHttpsHierarchicalUrl(uri)
                || uri.getRawUserInfo() != null
                || uri.getHost() == null
                || !hasValidPort(uri)) {
            return false;
        }

        int candidatePort = uri.getPort() == -1 ? HTTPS_DEFAULT_PORT : uri.getPort();
        return host.equalsIgnoreCase(uri.getHost()) && effectivePort == candidatePort;
    }

    private static URI parseUri(String input) {
        if (input == null || input.trim().isEmpty()) {
            throw invalidAddress();
        }
        try {
            return new URI(input.trim());
        } catch (URISyntaxException error) {
            throw invalidAddress();
        }
    }

    private static boolean isHttpsHierarchicalUrl(URI uri) {
        return !uri.isOpaque() && "https".equalsIgnoreCase(uri.getScheme());
    }

    private static boolean hasValidPort(URI uri) {
        int port = uri.getPort();
        String authority = uri.getRawAuthority();
        return authority != null
                && !authority.endsWith(":")
                && port != 0
                && port <= 65535;
    }

    private static IllegalArgumentException invalidAddress() {
        return new IllegalArgumentException("A valid HTTPS Bridge address is required");
    }
}
