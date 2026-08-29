import * as SecureStore from 'expo-secure-store';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import CookieManager from '@preeternal/react-native-cookie-manager';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import WebView, {
  type WebViewMessageEvent,
  type WebViewProps,
} from 'react-native-webview';

import {
  DEFAULT_BRIDGE_ORIGIN,
  createServerUrlPolicy,
  isApkDownload,
  type ServerUrlPolicy,
} from './src/serverUrlPolicy';
import {
  CLEAR_SITE_DATA_MESSAGE,
  CLEAR_SITE_DATA_SCRIPT,
} from './src/webScripts';
import { WEBVIEW_THEME_SCRIPT } from './src/webTheme';

const SERVER_ORIGIN_KEY = 'xiaoli.bridge.origin.v1';
const BRAND_ICON = require('./assets/xiaoli-balance-icon.png');

function XiaoliControlApp() {
  const webViewRef = useRef<WebView>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearingRef = useRef(false);
  const currentMainUrlRef = useRef('');

  const [restoring, setRestoring] = useState(true);
  const [policy, setPolicy] = useState<ServerUrlPolicy | null>(null);
  const [address, setAddress] = useState(DEFAULT_BRIDGE_ORIGIN);
  const [addressError, setAddressError] = useState('');
  const [saving, setSaving] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [networkError, setNetworkError] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [webViewKey, setWebViewKey] = useState(0);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let active = true;

    async function restoreConfiguration() {
      try {
        const savedOrigin = await SecureStore.getItemAsync(SERVER_ORIGIN_KEY);
        if (!savedOrigin) {
          return;
        }

        const restoredPolicy = createServerUrlPolicy(savedOrigin);
        if (active) {
          setPolicy(restoredPolicy);
          setAddress(restoredPolicy.origin);
          currentMainUrlRef.current = restoredPolicy.dashboardUrl;
        }
      } catch {
        await SecureStore.deleteItemAsync(SERVER_ORIGIN_KEY);
      } finally {
        if (active) {
          setRestoring(false);
        }
      }
    }

    void restoreConfiguration();
    return () => {
      active = false;
      if (clearTimerRef.current) {
        clearTimeout(clearTimerRef.current);
      }
    };
  }, []);

  const saveConfiguration = useCallback(async () => {
    setAddressError('');

    let candidate: ServerUrlPolicy;
    try {
      candidate = createServerUrlPolicy(address);
    } catch {
      setAddressError('请输入有效的 HTTPS Bridge 地址');
      return;
    }

    setSaving(true);
    try {
      await SecureStore.setItemAsync(SERVER_ORIGIN_KEY, candidate.origin, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      currentMainUrlRef.current = candidate.dashboardUrl;
      setPolicy(candidate);
      setAddress(candidate.origin);
      setNetworkError(false);
      setWebViewKey((value) => value + 1);
    } catch {
      setAddressError('保存失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  }, [address]);

  const reloadDashboard = useCallback(() => {
    if (!policy) {
      return;
    }

    setShowSettings(false);
    setNetworkError(false);
    currentMainUrlRef.current = policy.dashboardUrl;
    setWebViewKey((value) => value + 1);
  }, [policy]);

  const finishClearing = useCallback(async () => {
    if (!clearingRef.current) {
      return;
    }

    clearingRef.current = false;
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }

    try {
      webViewRef.current?.clearCache(true);
      await Promise.all([
        CookieManager.clearAllStores(),
        SecureStore.deleteItemAsync(SERVER_ORIGIN_KEY),
      ]);
    } finally {
      setPolicy(null);
      setAddress(DEFAULT_BRIDGE_ORIGIN);
      setAddressError('');
      setNetworkError(false);
      setCanGoBack(false);
      setShowSettings(false);
      setWebViewKey((value) => value + 1);
      setClearing(false);
      currentMainUrlRef.current = '';
    }
  }, []);

  const clearConfiguration = useCallback(() => {
    Alert.alert(
      '清除本机数据？',
      'Bridge 地址、管理员令牌和网页缓存都会从这台 iPhone 删除。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清除',
          style: 'destructive',
          onPress: () => {
            setClearing(true);
            setShowSettings(false);
            clearingRef.current = true;
            webViewRef.current?.stopLoading();
            webViewRef.current?.injectJavaScript(CLEAR_SITE_DATA_SCRIPT);
            clearTimerRef.current = setTimeout(() => {
              void finishClearing();
            }, 900);
          },
        },
      ],
    );
  }, [finishClearing]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (event.nativeEvent.data === CLEAR_SITE_DATA_MESSAGE) {
        void finishClearing();
      }
    },
    [finishClearing],
  );

  const handleNavigationRequest = useCallback<
    NonNullable<WebViewProps['onShouldStartLoadWithRequest']>
  >(
    (request: { url: string; isTopFrame?: boolean }) => {
      if (!policy) {
        return false;
      }

      const allowed = policy.isAllowedNavigation(request.url) && !isApkDownload(request.url);
      if (!allowed && request.isTopFrame !== false) {
        Alert.alert('已阻止跳转', '为保护管理令牌，应用只允许访问当前 Bridge 站点。');
      }
      return allowed;
    },
    [policy],
  );

  const handleNavigationChange = useCallback<
    NonNullable<WebViewProps['onNavigationStateChange']>
  >((event) => {
      setCanGoBack(event.canGoBack);
      currentMainUrlRef.current = event.url;
    }, []);

  const handleHttpError = useCallback<NonNullable<WebViewProps['onHttpError']>>(
    (event) => {
      const failedUrl = event.nativeEvent.url;
      if (!failedUrl || failedUrl === currentMainUrlRef.current) {
        setNetworkError(true);
      }
    },
    [],
  );

  const handleLoadError = useCallback<NonNullable<WebViewProps['onError']>>(
    (event) => {
      event.preventDefault();
      setNetworkError(true);
    },
    [],
  );

  if (restoring) {
    return (
      <SafeAreaView style={styles.loadingScreen} edges={['top', 'bottom']}>
        <StatusBar style="dark" />
        <LinearGradient
          colors={['#f9f7f1', '#eef3f8']}
          end={{ x: 1, y: 1 }}
          start={{ x: 0, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
        <Image source={BRAND_ICON} style={styles.loadingIcon} />
        <ActivityIndicator color="#d99a3d" />
        <Text style={styles.loadingText}>正在打开安全控制台</Text>
      </SafeAreaView>
    );
  }

  if (!policy) {
    return (
      <SafeAreaView style={styles.configureScreen} edges={['top', 'bottom']}>
        <StatusBar style="dark" />
        <LinearGradient
          colors={['#fbf8f0', '#edf3f8']}
          end={{ x: 1, y: 1 }}
          start={{ x: 0, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.flex}
        >
          <ScrollView
            contentContainerStyle={styles.configureContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.brandRow}>
              <Image accessibilityIgnoresInvertColors source={BRAND_ICON} style={styles.brandMark} />
              <View style={styles.brandCopy}>
                <Text style={styles.eyebrow}>小理天秤官</Text>
                <Text style={styles.brandMeta}>公平、安心的设备控制</Text>
              </View>
            </View>
            <Text style={styles.configureTitle}>让每一次调解，{`\n`}都清晰有序</Text>
            <Text style={styles.configureDescription}>
              连接你的 Bridge，在 iPhone 上查看设备状态、发起调解并管理小理的声音。
            </Text>

            <View style={styles.formCard}>
              <View style={styles.formHeader}>
                <View>
                  <Text style={styles.formKicker}>安全连接</Text>
                  <Text style={styles.formTitle}>Bridge 地址</Text>
                </View>
                <View style={styles.httpsBadge}>
                  <Text style={styles.httpsBadgeText}>HTTPS</Text>
                </View>
              </View>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                onChangeText={(value) => {
                  setAddress(value);
                  setAddressError('');
                }}
                onSubmitEditing={() => void saveConfiguration()}
                placeholder="https://bridge.example.com"
                placeholderTextColor="#9aa5b4"
                returnKeyType="go"
                selectionColor="#d99a3d"
                style={[styles.input, addressError ? styles.inputError : null]}
                value={address}
              />
              {addressError ? <Text style={styles.errorText}>{addressError}</Text> : null}
              <Pressable
                accessibilityRole="button"
                disabled={saving}
                onPress={() => void saveConfiguration()}
                style={({ pressed }) => [
                  styles.primaryButtonOuter,
                  pressed && styles.buttonPressed,
                  saving && styles.buttonDisabled,
                ]}
              >
                <LinearGradient
                  colors={['#1d3155', '#14213d']}
                  end={{ x: 1, y: 0 }}
                  start={{ x: 0, y: 0 }}
                  style={styles.primaryButton}
                >
                  {saving ? (
                    <ActivityIndicator color="#f4c66d" />
                  ) : (
                    <Text style={styles.primaryButtonText}>连接小理控制台</Text>
                  )}
                </LinearGradient>
              </Pressable>

              <View style={styles.inlineSecurityNote}>
                <Text style={styles.securityNoteTitle}>只允许当前 HTTPS 站点</Text>
                <Text style={styles.securityNoteText}>管理员令牌只保存在这台设备的网页数据中。</Text>
              </View>
            </View>

            <View style={styles.assuranceRow}>
              <View style={styles.assuranceItem}>
                <Text style={styles.assuranceValue}>同源保护</Text>
                <Text style={styles.assuranceLabel}>自动拦截跨站跳转</Text>
              </View>
              <View style={styles.assuranceDivider} />
              <View style={styles.assuranceItem}>
                <Text style={styles.assuranceValue}>本机存储</Text>
                <Text style={styles.assuranceLabel}>随时可一键清除</Text>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.appShell} edges={['top', 'bottom']}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <View style={styles.headerSide}>
          {canGoBack ? (
            <Pressable
              accessibilityLabel="返回上一页"
              accessibilityRole="button"
              hitSlop={10}
              onPress={() => webViewRef.current?.goBack()}
              style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
            >
              <Text style={styles.headerButtonText}>返回</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.headerTitleGroup}>
          <Image accessibilityIgnoresInvertColors source={BRAND_ICON} style={styles.headerLogo} />
          <View style={styles.headerTitleCopy}>
            <Text numberOfLines={1} style={styles.headerTitle}>小理控制台</Text>
            <Text numberOfLines={1} style={styles.headerSubtitle}>{policy.host}</Text>
          </View>
        </View>
        <View style={[styles.headerSide, styles.headerSideRight]}>
          <Pressable
            accessibilityLabel="打开设置"
            accessibilityRole="button"
            hitSlop={10}
            onPress={() => setShowSettings(true)}
            style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
          >
            <Text style={styles.headerButtonText}>设置</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.webViewContainer}>
        <WebView
          ref={webViewRef}
          key={`${policy.origin}:${webViewKey}`}
          source={{ uri: policy.dashboardUrl }}
          style={styles.webView}
          applicationNameForUserAgent="XiaoliControl/1.0 Expo"
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          allowsBackForwardNavigationGestures
          allowsInlineMediaPlayback={false}
          allowsLinkPreview={false}
          cacheEnabled
          dataDetectorTypes="none"
          domStorageEnabled
          fraudulentWebsiteWarningEnabled
          geolocationEnabled={false}
          injectedJavaScript={WEBVIEW_THEME_SCRIPT}
          javaScriptCanOpenWindowsAutomatically={false}
          javaScriptEnabled
          mediaCapturePermissionGrantType="deny"
          mediaPlaybackRequiresUserAction
          mixedContentMode="never"
          onError={handleLoadError}
          onFileDownload={() => Alert.alert('无法下载', 'iPhone 版本不提供 Android APK 下载。')}
          onHttpError={handleHttpError}
          onLoadStart={(event) => {
            if (policy.isAllowedNavigation(event.nativeEvent.url)) {
              currentMainUrlRef.current = event.nativeEvent.url;
              setNetworkError(false);
            }
          }}
          onMessage={handleMessage}
          onNavigationStateChange={handleNavigationChange}
          onOpenWindow={() => Alert.alert('已阻止新窗口', '请在当前 Bridge 站点内完成操作。')}
          onShouldStartLoadWithRequest={handleNavigationRequest}
          originWhitelist={['*']}
          pullToRefreshEnabled
          setSupportMultipleWindows={false}
          sharedCookiesEnabled={false}
          startInLoadingState
          thirdPartyCookiesEnabled={false}
          webviewDebuggingEnabled={false}
          renderLoading={() => (
            <View style={styles.webLoading}>
              <ActivityIndicator color="#1368d4" />
            </View>
          )}
        />

        {networkError ? (
          <Pressable
            accessibilityRole="button"
            onPress={reloadDashboard}
            style={({ pressed }) => [styles.errorBanner, pressed && styles.errorBannerPressed]}
          >
            <Text style={styles.errorBannerTitle}>Bridge 暂时不可用</Text>
            <Text style={styles.errorBannerText}>点此重新连接</Text>
          </Pressable>
        ) : null}

        {clearing ? (
          <View style={styles.clearingOverlay}>
            <Image accessibilityIgnoresInvertColors source={BRAND_ICON} style={styles.clearingIcon} />
            <ActivityIndicator color="#f4c66d" />
            <Text style={styles.clearingText}>正在清除本机数据…</Text>
          </View>
        ) : null}
      </View>

      <Modal
        animationType="slide"
        onRequestClose={() => setShowSettings(false)}
        presentationStyle="overFullScreen"
        transparent
        visible={showSettings}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setShowSettings(false)}>
          <Pressable accessibilityViewIsModal style={styles.settingsCard}>
            <View style={styles.sheetHandle} />
            <View style={styles.settingsHeader}>
              <Image accessibilityIgnoresInvertColors source={BRAND_ICON} style={styles.settingsIcon} />
              <View style={styles.settingsHeaderCopy}>
                <Text style={styles.settingsTitle}>控制台设置</Text>
                <Text numberOfLines={1} style={styles.settingsOrigin}>{policy.origin}</Text>
              </View>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={reloadDashboard}
              style={({ pressed }) => [styles.settingsAction, pressed && styles.settingsActionPressed]}
            >
              <Text style={styles.settingsActionText}>重新加载控制台</Text>
              <Text style={styles.settingsActionHint}>刷新设备状态和控制页面</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={clearConfiguration}
              style={({ pressed }) => [styles.settingsAction, pressed && styles.settingsActionPressed]}
            >
              <Text style={styles.destructiveText}>清除配置与本机数据</Text>
              <Text style={styles.settingsActionHint}>删除地址、令牌、Cookie 和网页缓存</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setShowSettings(false)}
              style={({ pressed }) => [styles.cancelButton, pressed && styles.settingsActionPressed]}
            >
              <Text style={styles.cancelButtonText}>取消</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <XiaoliControlApp />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 13,
    backgroundColor: '#f9f7f1',
  },
  loadingIcon: {
    width: 82,
    height: 82,
    borderRadius: 24,
    marginBottom: 6,
    shadowColor: '#14213d',
    shadowOpacity: 0.16,
    shadowOffset: { width: 0, height: 10 },
    shadowRadius: 20,
  },
  loadingText: { color: '#526174', fontSize: 14, fontWeight: '600' },
  configureScreen: { flex: 1, backgroundColor: '#fbf8f0' },
  configureContent: {
    flexGrow: 1,
    justifyContent: 'center',
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    paddingHorizontal: 22,
    paddingVertical: 34,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 30,
  },
  brandMark: {
    width: 68,
    height: 68,
    borderRadius: 20,
    shadowColor: '#14213d',
    shadowOpacity: 0.14,
    shadowOffset: { width: 0, height: 9 },
    shadowRadius: 18,
  },
  brandCopy: { flex: 1 },
  eyebrow: {
    color: '#14213d',
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 0.2,
    marginBottom: 4,
  },
  brandMeta: { color: '#7b6b50', fontSize: 13, fontWeight: '600' },
  configureTitle: {
    color: '#14213d',
    fontSize: 34,
    lineHeight: 43,
    fontWeight: '800',
    letterSpacing: -1,
  },
  configureDescription: {
    color: '#5f6b79',
    fontSize: 16,
    lineHeight: 25,
    marginTop: 14,
    marginBottom: 26,
  },
  formCard: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(20, 33, 61, 0.08)',
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
    padding: 19,
    shadowColor: '#1d2a3a',
    shadowOpacity: 0.09,
    shadowOffset: { width: 0, height: 12 },
    shadowRadius: 28,
  },
  formHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  formKicker: {
    color: '#b17822',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginBottom: 3,
  },
  formTitle: { color: '#14213d', fontSize: 17, fontWeight: '700' },
  httpsBadge: {
    minHeight: 30,
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#c9e4df',
    backgroundColor: '#edf8f5',
    paddingHorizontal: 10,
  },
  httpsBadgeText: { color: '#24766b', fontSize: 11, fontWeight: '800', letterSpacing: 0.7 },
  input: {
    height: 56,
    borderWidth: 1,
    borderColor: '#d3dae4',
    borderRadius: 15,
    paddingHorizontal: 15,
    color: '#14213d',
    fontSize: 15,
    backgroundColor: '#f7f9fc',
  },
  inputError: { borderColor: '#c73737' },
  errorText: { color: '#b42318', fontSize: 13, marginTop: 7 },
  primaryButtonOuter: {
    borderRadius: 15,
    overflow: 'hidden',
    marginTop: 14,
    shadowColor: '#14213d',
    shadowOpacity: 0.17,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 14,
  },
  primaryButton: {
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
  },
  primaryButtonText: { color: '#fff8e8', fontSize: 16, fontWeight: '700' },
  buttonPressed: { opacity: 0.82 },
  buttonDisabled: { opacity: 0.55 },
  inlineSecurityNote: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e4e8ee',
    marginTop: 18,
    paddingTop: 15,
  },
  securityNoteTitle: { color: '#334155', fontSize: 13, fontWeight: '700' },
  securityNoteText: { color: '#7a8796', fontSize: 12, lineHeight: 18, marginTop: 3 },
  assuranceRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: 22,
    paddingHorizontal: 6,
  },
  assuranceItem: { flex: 1 },
  assuranceDivider: { width: 1, backgroundColor: '#d4dbe3', marginHorizontal: 18 },
  assuranceValue: { color: '#14213d', fontSize: 13, fontWeight: '700' },
  assuranceLabel: { color: '#7b8794', fontSize: 11, marginTop: 4 },
  appShell: { flex: 1, backgroundColor: '#14213d' },
  header: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#293957',
    backgroundColor: '#14213d',
    paddingHorizontal: 8,
  },
  headerSide: { width: 66, alignItems: 'flex-start' },
  headerSideRight: { alignItems: 'flex-end' },
  headerTitleGroup: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  headerLogo: { width: 32, height: 32, borderRadius: 10, marginRight: 9 },
  headerTitleCopy: { maxWidth: 180 },
  headerTitle: { color: '#fffaf0', fontSize: 15, fontWeight: '700' },
  headerSubtitle: { color: '#aebbd0', fontSize: 10, marginTop: 2, maxWidth: 165 },
  headerButton: {
    minHeight: 42,
    justifyContent: 'center',
    paddingHorizontal: 7,
    borderRadius: 10,
  },
  headerButtonPressed: { backgroundColor: '#263857' },
  headerButtonText: { color: '#f4c66d', fontSize: 14, fontWeight: '700' },
  webViewContainer: { flex: 1, backgroundColor: '#f5f2eb' },
  webView: { flex: 1, backgroundColor: '#f5f2eb' },
  webLoading: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f7f4ed',
  },
  errorBanner: {
    position: 'absolute',
    left: 14,
    right: 14,
    top: 10,
    minHeight: 58,
    alignItems: 'flex-start',
    justifyContent: 'center',
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#e8b4ae',
    backgroundColor: '#fff1ef',
    paddingHorizontal: 15,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowOffset: { width: 0, height: 5 },
    shadowRadius: 12,
  },
  errorBannerPressed: { opacity: 0.78 },
  errorBannerTitle: { color: '#8b2018', fontSize: 14, fontWeight: '700' },
  errorBannerText: { color: '#a84a41', fontSize: 12, fontWeight: '600', marginTop: 2 },
  clearingOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: 'rgba(20, 33, 61, 0.92)',
  },
  clearingIcon: { width: 60, height: 60, borderRadius: 18, marginBottom: 5 },
  clearingText: { color: '#fff8e8', fontSize: 15, fontWeight: '600' },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(10, 18, 31, 0.48)',
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  settingsCard: {
    borderRadius: 28,
    backgroundColor: '#f8f6f0',
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 12,
  },
  sheetHandle: {
    width: 38,
    height: 5,
    alignSelf: 'center',
    borderRadius: 3,
    backgroundColor: '#cdd3dc',
    marginBottom: 16,
  },
  settingsHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 18 },
  settingsIcon: { width: 48, height: 48, borderRadius: 15, marginRight: 12 },
  settingsHeaderCopy: { flex: 1 },
  settingsTitle: { color: '#14213d', fontSize: 20, fontWeight: '800' },
  settingsOrigin: { color: '#758094', fontSize: 11, marginTop: 4 },
  settingsAction: {
    minHeight: 68,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e1e5eb',
    borderRadius: 15,
    backgroundColor: '#ffffff',
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  settingsActionPressed: { opacity: 0.62 },
  settingsActionText: { color: '#14213d', fontSize: 15, fontWeight: '700' },
  settingsActionHint: { color: '#7a8594', fontSize: 11, marginTop: 4 },
  destructiveText: { color: '#a32b22', fontSize: 15, fontWeight: '700' },
  cancelButton: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    backgroundColor: '#e8ecf2',
  },
  cancelButtonText: { color: '#334155', fontSize: 15, fontWeight: '700' },
});
