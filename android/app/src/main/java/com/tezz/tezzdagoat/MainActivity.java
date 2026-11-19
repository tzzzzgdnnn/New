package com.tezz.tezzdagoat;

import android.app.UiModeManager;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Bundle;
import android.speech.RecognizerIntent;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.BridgeWebViewClient;

import org.json.JSONObject;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Super Player for Android: the same phone app as the iPhone build (one
 * shared codebase), in Capacitor's WebView.
 *  - Videos start the instant Play is tapped (no extra gesture needed).
 *  - The player goes edge-to-edge full screen (system bars hidden) and keeps
 *    the screen on while it plays.
 *  - No pop-ups or new windows: embeds can't open ad tabs.
 *  - The Back button goes back a screen in the app, like the iPhone edge swipe.
 */
public class MainActivity extends BridgeActivity {
    // Player auto-opener (same as the iPhone app): any embed server's video
    // stream request is handed to the app, which plays it in its own player.
    private static final Pattern STREAM =
            Pattern.compile("(\\.|%2e)m3u8|/m3u8|\\.mp4(\\?|#|$)|mpegurl", Pattern.CASE_INSENSITIVE);
    private static final Pattern NOT_STREAM =
            Pattern.compile("\\.(ts|m4s|aac|jpg|png|webp|gif|css|js|woff2?)(\\?|#|$)|vast|preroll|/ads?/|doubleclick|googlesyndication|thumb|sprite|preview",
                    Pattern.CASE_INSENSITIVE);
    private final Set<String> seen = Collections.synchronizedSet(new HashSet<>());
    private static final int VOICE_REQ = 4711;
    private boolean tv;
    private View fullView;
    private WebChromeClient.CustomViewCallback fullCallback;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SbPlayerPlugin.class);
        super.onCreate(savedInstanceState);
        WebView wv = getBridge().getWebView();
        WebSettings ws = wv.getSettings();
        tv = isTv();
        if (!tv) setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
        if (tv) setupTv(wv, ws); else requestHighRefreshRate();
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setSupportMultipleWindows(false);
        ws.setJavaScriptCanOpenWindowsAutomatically(false);

        wv.setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                String u = req.getUrl().toString();
                if (!req.isForMainFrame() && u.startsWith("http") && !u.contains("://localhost")
                        && STREAM.matcher(u).find() && !NOT_STREAM.matcher(u).find() && seen.add(u)) {
                    String js = "window.dispatchEvent(new CustomEvent('sb-android-stream',{detail:{url:"
                            + JSONObject.quote(u) + "}}))";
                    view.post(() -> view.evaluateJavascript(js, null));
                }
                return super.shouldInterceptRequest(view, req);
            }
        });

        wv.setWebChromeClient(new BridgeWebChromeClient(getBridge()) {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullView != null) { callback.onCustomViewHidden(); return; }
                fullView = view;
                fullCallback = callback;
                ((FrameLayout) getWindow().getDecorView()).addView(view,
                        new FrameLayout.LayoutParams(-1, -1));
                setPlayerFullscreen(true);
            }

            @Override
            public void onHideCustomView() {
                if (fullView == null) return;
                ((FrameLayout) getWindow().getDecorView()).removeView(fullView);
                fullView = null;
                if (fullCallback != null) fullCallback.onCustomViewHidden();
                fullCallback = null;
                setPlayerFullscreen(false);
            }
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                wv.evaluateJavascript(
                        "(function(){try{return !!(window.__sbAndroidBack&&window.__sbAndroidBack())}catch(e){return false}})()",
                        handled -> { if (!"true".equals(handled)) moveTaskToBack(true); });
            }
        });
    }

    // ── Fire TV / Android TV ───────────────────────────────────────────────
    private boolean isTv() {
        try {
            PackageManager pm = getPackageManager();
            UiModeManager um = (UiModeManager) getSystemService(UI_MODE_SERVICE);
            return (um != null && um.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION)
                    || pm.hasSystemFeature("amazon.hardware.fire_tv")
                    || pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK);
        } catch (Throwable t) { return false; }
    }

    /** Tells the web app it runs on a TV (remote navigation, TV layout) and gives it voice search. */
    private void setupTv(WebView wv, WebSettings ws) {
        ws.setUserAgentString(ws.getUserAgentString() + " SuperPlayerTV");
        // Low-RAM sticks: no pre-drawing off screen, cache what's already loaded.
        ws.setOffscreenPreRaster(false);
        wv.setFocusable(true);
        wv.setFocusableInTouchMode(true);
        wv.requestFocus();
        wv.addJavascriptInterface(new Object() {
            @JavascriptInterface public boolean hasVoice() { return voiceAvailable(); }
            @JavascriptInterface public void startVoice() { runOnUiThread(MainActivity.this::startVoice); }
        }, "SbTV");
        // The page was already loading before the UA changed: load it once more.
        wv.post(wv::reload);
    }

    private boolean voiceAvailable() {
        try {
            return new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                    .resolveActivity(getPackageManager()) != null;
        } catch (Throwable t) { return false; }
    }

    private void startVoice() {
        WebView wv = getBridge().getWebView();
        if (!voiceAvailable()) {
            // Fire TV: no speech screen for apps; the on-screen keyboard's mic
            // dictates into the focused search box instead.
            wv.evaluateJavascript("(function(){var i=document.querySelector('.nfs input');if(i){i.focus();i.click();}})()", null);
            return;
        }
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH);
        i.putExtra(RecognizerIntent.EXTRA_PROMPT, "Search movies, shows, anime");
        try { startActivityForResult(i, VOICE_REQ); } catch (Throwable ignored) {}
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != VOICE_REQ || res != RESULT_OK || data == null) return;
        java.util.ArrayList<String> r = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        if (r == null || r.isEmpty()) return;
        getBridge().getWebView().evaluateJavascript(
                "window.__sbVoiceResult&&window.__sbVoiceResult(" + JSONObject.quote(r.get(0)) + ")", null);
    }

    // Remote's Search / voice key opens search (and voice input when the TV has it).
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        if (tv && (k == KeyEvent.KEYCODE_SEARCH || k == KeyEvent.KEYCODE_VOICE_ASSIST)) {
            if (e.getAction() == KeyEvent.ACTION_UP)
                getBridge().getWebView().evaluateJavascript("window.__sbTvSearch&&window.__sbTvSearch()", null);
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    // While the app is hidden (or the built-in player is on top), the web view
    // stops drawing and running animations, and its renderer may be dropped
    // first when the phone needs memory.
    // Many phones (Samsung, Xiaomi, OnePlus...) keep apps at 60 Hz unless the
    // app asks for the fast mode. Ask for the highest refresh rate at the
    // current resolution so scrolling and transitions run at 90/120 Hz.
    private void requestHighRefreshRate() {
        try {
            if (android.os.Build.VERSION.SDK_INT < 23) return;
            android.view.Display d = getWindowManager().getDefaultDisplay();
            android.view.Display.Mode cur = d.getMode();
            android.view.Display.Mode best = cur;
            for (android.view.Display.Mode m : d.getSupportedModes()) {
                if (m.getPhysicalWidth() == cur.getPhysicalWidth()
                        && m.getPhysicalHeight() == cur.getPhysicalHeight()
                        && m.getRefreshRate() > best.getRefreshRate()) best = m;
            }
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.preferredDisplayModeId = best.getModeId();
            lp.preferredRefreshRate = best.getRefreshRate();
            getWindow().setAttributes(lp);
        } catch (Throwable ignored) {}
    }

    @Override
    public void onResume() {
        super.onResume();
        if (!tv) requestHighRefreshRate();
    }

    @Override
    public void onStop() {
        super.onStop();
        WebView wv = getBridge() == null ? null : getBridge().getWebView();
        if (wv != null) {
            wv.onPause();
            if (android.os.Build.VERSION.SDK_INT >= 26)
                wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_WAIVED, true);
        }
    }

    @Override
    public void onStart() {
        super.onStart();
        WebView wv = getBridge() == null ? null : getBridge().getWebView();
        if (wv != null) {
            wv.onResume();
            if (android.os.Build.VERSION.SDK_INT >= 26)
                wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
        }
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        WebView wv = getBridge() == null ? null : getBridge().getWebView();
        if (wv != null && level >= TRIM_MEMORY_RUNNING_LOW) wv.clearCache(false);
    }

    private void setPlayerFullscreen(boolean on) {
        WindowInsetsControllerCompat c =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (on) {
            c.hide(WindowInsetsCompat.Type.systemBars());
            c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            c.show(WindowInsetsCompat.Type.systemBars());
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }
}
