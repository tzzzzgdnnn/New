package com.tezz.tezzdagoat;

import android.os.Bundle;
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
    private View fullView;
    private WebChromeClient.CustomViewCallback fullCallback;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView wv = getBridge().getWebView();
        WebSettings ws = wv.getSettings();
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
