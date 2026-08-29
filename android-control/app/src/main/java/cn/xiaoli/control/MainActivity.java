package cn.xiaoli.control;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

public final class MainActivity extends Activity {
    private static final String PREFERENCES_NAME = "bridge_configuration";
    private static final String PREFERENCE_SERVER_ORIGIN = "server_origin";
    private static final int MENU_CLEAR_CONFIGURATION = 1;

    private WebView webView;
    private TextView errorBanner;
    private ServerUrlPolicy serverUrlPolicy;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.dashboard_web_view);
        errorBanner = findViewById(R.id.network_error_banner);
        errorBanner.setOnClickListener(view -> retryDashboard());

        configureWebView();
        registerBackNavigation();
        restoreConfigurationOrPrompt();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setGeolocationEnabled(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSafeBrowsingEnabled(true);

        WebView.setWebContentsDebuggingEnabled(false);
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                boolean allowed = serverUrlPolicy != null
                        && serverUrlPolicy.isAllowedNavigation(request.getUrl().toString());
                if (!allowed && request.isForMainFrame()) {
                    Toast.makeText(
                            MainActivity.this,
                            R.string.blocked_navigation,
                            Toast.LENGTH_SHORT)
                            .show();
                }
                return !allowed;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (serverUrlPolicy != null && serverUrlPolicy.isAllowedNavigation(url)) {
                    hideNetworkError();
                }
            }

            @Override
            public void onReceivedError(
                    WebView view,
                    WebResourceRequest request,
                    WebResourceError error) {
                if (request.isForMainFrame()) {
                    showNetworkError();
                }
            }

            @Override
            public void onReceivedHttpError(
                    WebView view,
                    WebResourceRequest request,
                    WebResourceResponse errorResponse) {
                if (request.isForMainFrame()) {
                    showNetworkError();
                }
            }
        });
    }

    private void restoreConfigurationOrPrompt() {
        String savedOrigin = preferences().getString(PREFERENCE_SERVER_ORIGIN, "");
        if (savedOrigin == null || savedOrigin.trim().isEmpty()) {
            showConfigurationDialog();
            return;
        }

        try {
            serverUrlPolicy = ServerUrlPolicy.fromUserInput(savedOrigin);
            loadDashboard();
        } catch (IllegalArgumentException error) {
            preferences().edit().remove(PREFERENCE_SERVER_ORIGIN).apply();
            showConfigurationDialog();
        }
    }

    private void showConfigurationDialog() {
        EditText addressInput = new EditText(this);
        addressInput.setSingleLine(true);
        addressInput.setInputType(
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        addressInput.setHint(R.string.bridge_url_hint);
        addressInput.setText(R.string.bridge_url_default);
        addressInput.setSelection(addressInput.length());

        int horizontalPadding = Math.round(24 * getResources().getDisplayMetrics().density);
        FrameLayout inputContainer = new FrameLayout(this);
        inputContainer.setPadding(horizontalPadding, 0, horizontalPadding, 0);
        inputContainer.addView(
                addressInput,
                new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT));

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.bridge_url_dialog_title)
                .setMessage(R.string.bridge_url_dialog_message)
                .setView(inputContainer)
                .setPositiveButton(R.string.save_configuration, null)
                .setCancelable(false)
                .create();

        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(view -> saveConfiguration(addressInput, dialog)));
        dialog.show();
    }

    private void saveConfiguration(EditText addressInput, AlertDialog dialog) {
        try {
            ServerUrlPolicy candidate = ServerUrlPolicy.fromUserInput(
                    addressInput.getText().toString());
            preferences()
                    .edit()
                    .putString(PREFERENCE_SERVER_ORIGIN, candidate.origin())
                    .apply();
            serverUrlPolicy = candidate;
            dialog.dismiss();
            loadDashboard();
        } catch (IllegalArgumentException error) {
            addressInput.setError(getString(R.string.invalid_bridge_url));
        }
    }

    private void loadDashboard() {
        hideNetworkError();
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(serverUrlPolicy.dashboardUrl());
    }

    private void retryDashboard() {
        if (serverUrlPolicy == null) {
            return;
        }
        hideNetworkError();
        webView.loadUrl(serverUrlPolicy.dashboardUrl());
    }

    private void showNetworkError() {
        errorBanner.setVisibility(View.VISIBLE);
    }

    private void hideNetworkError() {
        errorBanner.setVisibility(View.GONE);
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(Menu.NONE, MENU_CLEAR_CONFIGURATION, Menu.NONE, R.string.menu_clear_configuration)
                .setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() != MENU_CLEAR_CONFIGURATION) {
            return super.onOptionsItemSelected(item);
        }

        new AlertDialog.Builder(this)
                .setTitle(R.string.clear_configuration_title)
                .setMessage(R.string.clear_configuration_message)
                .setPositiveButton(
                        R.string.clear_configuration_confirm,
                        (dialog, which) -> clearConfiguration())
                .setNegativeButton(android.R.string.cancel, null)
                .show();
        return true;
    }

    private void clearConfiguration() {
        preferences().edit().remove(PREFERENCE_SERVER_ORIGIN).apply();
        serverUrlPolicy = null;

        webView.stopLoading();
        webView.clearHistory();
        webView.clearCache(true);
        webView.clearFormData();
        webView.clearSslPreferences();
        webView.setVisibility(View.INVISIBLE);
        WebStorage.getInstance().deleteAllData();
        CookieManager.getInstance().removeAllCookies(null);
        CookieManager.getInstance().flush();
        hideNetworkError();

        showConfigurationDialog();
    }

    private SharedPreferences preferences() {
        return getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE);
    }

    private void registerBackNavigation() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    () -> {
                        if (!navigateBackInWebView()) {
                            finish();
                        }
                    });
        }
    }

    private boolean navigateBackInWebView() {
        if (webView.getVisibility() == View.VISIBLE && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return false;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (!navigateBackInWebView()) {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) {
                parent.removeView(webView);
            }
            webView.destroy();
        }
        super.onDestroy();
    }
}
