package com.tezz.tezzdagoat;

import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

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
