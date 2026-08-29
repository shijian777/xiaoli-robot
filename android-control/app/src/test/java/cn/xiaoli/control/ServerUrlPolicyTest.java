package cn.xiaoli.control;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class ServerUrlPolicyTest {
    @Test
    public void acceptsHttpsAddressAndBuildsCanonicalDashboardUrl() {
        ServerUrlPolicy policy = ServerUrlPolicy.fromUserInput(
                "  https://Bridge.Example.com:443/previous/path?query=yes#fragment  ");

        assertEquals("https://bridge.example.com", policy.origin());
        assertEquals("https://bridge.example.com/mobile/", policy.dashboardUrl());
    }

    @Test
    public void acceptsHttpsAddressWithNonDefaultPort() {
        ServerUrlPolicy policy = ServerUrlPolicy.fromUserInput("https://bridge.example.com:8443");

        assertEquals("https://bridge.example.com:8443", policy.origin());
        assertEquals("https://bridge.example.com:8443/mobile/", policy.dashboardUrl());
    }

    @Test
    public void rejectsBlankAndNonHttpsBridgeAddresses() {
        assertThrows(IllegalArgumentException.class, () -> ServerUrlPolicy.fromUserInput(""));
        assertThrows(IllegalArgumentException.class, () -> ServerUrlPolicy.fromUserInput("http://bridge.example.com"));
        assertThrows(IllegalArgumentException.class, () -> ServerUrlPolicy.fromUserInput("file:///tmp/mobile.html"));
        assertThrows(IllegalArgumentException.class, () -> ServerUrlPolicy.fromUserInput("content://cn.xiaoli.control/mobile"));
        assertThrows(IllegalArgumentException.class, () -> ServerUrlPolicy.fromUserInput("javascript:alert(1)"));
    }

    @Test
    public void allowsOnlyHttpsNavigationOnTheExactConfiguredOrigin() {
        ServerUrlPolicy policy = ServerUrlPolicy.fromUserInput("https://bridge.example.com");

        assertTrue(policy.isAllowedNavigation("https://bridge.example.com/mobile/"));
        assertTrue(policy.isAllowedNavigation("https://BRIDGE.EXAMPLE.COM/api/mobile/v1/status?fresh=1"));
        assertTrue(policy.isAllowedNavigation("https://bridge.example.com:443/mobile/app.js"));
        assertFalse(policy.isAllowedNavigation("http://bridge.example.com/mobile/"));
        assertFalse(policy.isAllowedNavigation("https://bridge.example.com:8443/mobile/"));
        assertFalse(policy.isAllowedNavigation("file:///android_asset/index.html"));
        assertFalse(policy.isAllowedNavigation("content://cn.xiaoli.control/mobile"));
        assertFalse(policy.isAllowedNavigation("javascript:alert(1)"));
    }

    @Test
    public void rejectsHostConfusionAndCredentials() {
        ServerUrlPolicy policy = ServerUrlPolicy.fromUserInput("https://bridge.example.com");

        assertFalse(policy.isAllowedNavigation("https://bridge.example.com.evil.test/mobile/"));
        assertFalse(policy.isAllowedNavigation("https://bridge.example.com@evil.test/mobile/"));
        assertFalse(policy.isAllowedNavigation("https://evil.test/?next=https://bridge.example.com"));
        assertThrows(
                IllegalArgumentException.class,
                () -> ServerUrlPolicy.fromUserInput("https://user:password@bridge.example.com"));
    }

    @Test
    public void malformedNavigationIsRejectedWithoutThrowing() {
        ServerUrlPolicy policy = ServerUrlPolicy.fromUserInput("https://bridge.example.com");

        assertFalse(policy.isAllowedNavigation(null));
        assertFalse(policy.isAllowedNavigation(""));
        assertFalse(policy.isAllowedNavigation("not a url"));
    }
}
