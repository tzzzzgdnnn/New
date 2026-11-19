package com.tezz.tezzdagoat;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.GestureDetector;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.WindowManager;
import android.widget.Toast;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.appcompat.app.AlertDialog;
import androidx.media3.common.Format;
import androidx.media3.common.VideoSize;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.ui.TrackSelectionDialogBuilder;
import java.util.Locale;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;

import java.util.HashMap;
import java.util.Map;

/**
 * Built-in Android player (Media3 / ExoPlayer), the counterpart of the iPhone
 * app's native player: full screen, sideways, system bars hidden, screen on,
 * double-tap left/right = back/forward 10 s, speed + quality in the gear menu.
 * Reports progress to the app so Resume works.
 */
@UnstableApi
public class PlayerActivity extends AppCompatActivity {
    static PlayerActivity current;
    private ExoPlayer player;
    private PlayerView view;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean quiet, reported, started;
    // Premium overlay: live connection meter, quality and speed controls.
    private TextView netPill, speedBtn, qualityBtn;
    private LinearLayout topBar;
    private long bitrateEstimate;
    private int videoH;
    private Format videoFormat;
    private static final float[] SPEEDS = {0.5f, 0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f};

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (player != null && player.getCurrentPosition() > 0) {
                SbPlayerPlugin.emit("progress", pos(), dur(), null);
            }
            handler.postDelayed(this, 5000);
        }
    };
    private final Runnable meter = new Runnable() {
        @Override public void run() { updatePill(); handler.postDelayed(this, 1000); }
    };

    private TextView chip(String text, boolean accent) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(0xFFFFFFFF);
        t.setTextSize(13);
        t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        t.setLetterSpacing(0.02f);
        int px = (int) (14 * getResources().getDisplayMetrics().density);
        int py = (int) (8 * getResources().getDisplayMetrics().density);
        t.setPadding(px, py, px, py);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(100f);
        bg.setColor(accent ? 0xE6E50914 : 0x99000000);
        bg.setStroke(1, 0x33FFFFFF);
        t.setBackground(bg);
        return t;
    }

    private int dp(int v) { return (int) (v * getResources().getDisplayMetrics().density); }

    private void buildOverlay(FrameLayout root) {
        // Connection meter, always on, top-right: live Mbps + resolution.
        netPill = chip("● Connecting…", false);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.END);
        lp.setMargins(0, dp(14), dp(18), 0);
        root.addView(netPill, lp);

        // Controls row, shown with the player controls.
        topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);
        TextView back = chip("‹  Back", false);
        back.setOnClickListener(v -> finish());
        speedBtn = chip("1x", false);
        speedBtn.setOnClickListener(v -> pickSpeed());
        qualityBtn = chip("Auto", true);
        qualityBtn.setOnClickListener(v -> pickQuality());
        topBar.addView(back);
        View gap = new View(this);
        topBar.addView(gap, new LinearLayout.LayoutParams(dp(10), 1));
        topBar.addView(speedBtn);
        View gap2 = new View(this);
        topBar.addView(gap2, new LinearLayout.LayoutParams(dp(10), 1));
        topBar.addView(qualityBtn);
        FrameLayout.LayoutParams tl = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.START);
        tl.setMargins(dp(18), dp(14), 0, 0);
        root.addView(topBar, tl);
    }

    private void updatePill() {
        if (netPill == null || player == null) return;
        double mbps = bitrateEstimate / 1_000_000.0;
        String res = videoH > 0 ? (videoH >= 2160 ? "4K" : videoH + "p") : "—";
        String rate = videoFormat != null && videoFormat.bitrate > 0
                ? String.format(Locale.US, " · %.1f Mbps video", videoFormat.bitrate / 1_000_000.0) : "";
        int color = mbps >= 10 ? 0xFF2ECC71 : mbps >= 4 ? 0xFFF1C40F : 0xFFE74C3C;
        String dot = bitrateEstimate > 0 ? "●" : "○";
        netPill.setText(String.format(Locale.US, "%s %.1f Mbps  ·  %s%s", dot, mbps, res, rate));
        netPill.setTextColor(0xFFFFFFFF);
        GradientDrawable bg = (GradientDrawable) netPill.getBackground();
        bg.setStroke(dp(1), (color & 0x00FFFFFF) | 0x88000000);
        float sp = player.getPlaybackParameters().speed;
        speedBtn.setText(sp == (int) sp ? ((int) sp) + "x" : sp + "x");
    }

    private void pickSpeed() {
        if (player == null) return;
        String[] labels = new String[SPEEDS.length];
        int sel = 2;
        for (int i = 0; i < SPEEDS.length; i++) {
            labels[i] = (SPEEDS[i] == 1f ? "Normal" : SPEEDS[i] + "x");
            if (Math.abs(SPEEDS[i] - player.getPlaybackParameters().speed) < 0.01) sel = i;
        }
        new AlertDialog.Builder(this, androidx.appcompat.R.style.Theme_AppCompat_Dialog_Alert)
                .setTitle("Playback speed")
                .setSingleChoiceItems(labels, sel, (d, w) -> { player.setPlaybackSpeed(SPEEDS[w]); updatePill(); d.dismiss(); hideBars(); })
                .setOnDismissListener(d -> hideBars())
                .show();
    }

    private void pickQuality() {
        if (player == null) return;
        new TrackSelectionDialogBuilder(this, "Quality", player, C.TRACK_TYPE_VIDEO)
                .setTheme(androidx.appcompat.R.style.Theme_AppCompat_Dialog_Alert)
                .setShowDisableOption(false)
                .setAllowAdaptiveSelections(false)
                .build()
                .show();
    }

    private double pos() { return player == null ? 0 : player.getCurrentPosition() / 1000.0; }
    private double dur() {
        if (player == null) return 0;
        long d = player.getDuration();
        return d == C.TIME_UNSET ? 0 : d / 1000.0;
    }

    @SuppressLint("ClickableViewAccessibility")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = this;
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        hideBars();

        view = new PlayerView(this);
        view.setBackgroundColor(0xFF000000);
        view.setKeepScreenOn(true);
        // Lighter on the GPU than a TextureView.
        view.setUseArtwork(false);
        view.setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS);
        view.setShowNextButton(false);
        view.setShowPreviousButton(false);
        view.setControllerShowTimeoutMs(2500);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);
        root.addView(view, new FrameLayout.LayoutParams(-1, -1));
        buildOverlay(root);
        setContentView(root);
        view.setControllerVisibilityListener((PlayerView.ControllerVisibilityListener) vis -> {
            hideBars();
            if (topBar != null) topBar.animate().alpha(vis == View.VISIBLE ? 1f : 0f).setDuration(200)
                    .withEndAction(() -> topBar.setVisibility(vis == View.VISIBLE ? View.VISIBLE : View.GONE)).start();
            if (vis == View.VISIBLE && topBar != null) topBar.setVisibility(View.VISIBLE);
        });

        // Double-tap sides to skip 10 s; single tap shows/hides controls.
        GestureDetector gd = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override public boolean onDoubleTap(@NonNull MotionEvent e) {
                if (player == null) return false;
                long d = e.getX() < view.getWidth() / 2f ? -10_000 : 10_000;
                player.seekTo(Math.max(0, player.getCurrentPosition() + d));
                Toast.makeText(PlayerActivity.this, d < 0 ? "⏪ 10s" : "10s ⏩", Toast.LENGTH_SHORT).show();
                return true;
            }
            @Override public boolean onSingleTapConfirmed(@NonNull MotionEvent e) {
                if (view.isControllerFullyVisible()) view.hideController(); else view.showController();
                return true;
            }
        });
        view.setOnTouchListener((v, e) -> { gd.onTouchEvent(e); return true; });

        start(getIntent());
    }

    // TV remote (Fire TV / Android TV): with the controls hidden, Left/Right
    // skip 10 s and OK pauses or plays; with them showing, the D-pad moves
    // between the buttons. Play/Pause, Rewind and Fast-forward always work.
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        if (player == null || view == null) return super.dispatchKeyEvent(e);
        int k = e.getKeyCode();
        boolean down = e.getAction() == KeyEvent.ACTION_DOWN;
        switch (k) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                if (down && e.getRepeatCount() == 0) {
                    if (k == KeyEvent.KEYCODE_MEDIA_PAUSE || (k == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE && player.isPlaying())) player.pause();
                    else player.play();
                    view.showController();
                }
                return true;
            case KeyEvent.KEYCODE_MEDIA_REWIND:
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                if (down) {
                    long d = k == KeyEvent.KEYCODE_MEDIA_REWIND ? -10_000 : 10_000;
                    player.seekTo(Math.max(0, player.getCurrentPosition() + d));
                    view.showController();
                }
                return true;
        }
        if (!view.isControllerFullyVisible()) {
            if (k == KeyEvent.KEYCODE_DPAD_LEFT || k == KeyEvent.KEYCODE_DPAD_RIGHT) {
                if (down) {
                    long d = k == KeyEvent.KEYCODE_DPAD_LEFT ? -10_000 : 10_000;
                    player.seekTo(Math.max(0, player.getCurrentPosition() + d));
                    Toast.makeText(this, d < 0 ? "⏪ 10s" : "10s ⏩", Toast.LENGTH_SHORT).show();
                }
                return true;
            }
            if (k == KeyEvent.KEYCODE_DPAD_CENTER || k == KeyEvent.KEYCODE_ENTER || k == KeyEvent.KEYCODE_NUMPAD_ENTER) {
                if (down && e.getRepeatCount() == 0) {
                    if (player.isPlaying()) player.pause(); else player.play();
                    view.showController();
                }
                return true;
            }
            if (k == KeyEvent.KEYCODE_DPAD_UP || k == KeyEvent.KEYCODE_DPAD_DOWN || k == KeyEvent.KEYCODE_MENU) {
                if (down) view.showController();
                return true;
            }
        }
        return super.dispatchKeyEvent(e);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        release(true);
        start(intent);
    }

    private void start(Intent in) {
        String url = in.getStringExtra("url");
        double startAt = in.getDoubleExtra("startAt", 0);
        String referer = in.getStringExtra("referer");
        reported = false; started = false;

        Map<String, String> headers = new HashMap<>();
        if (referer != null && !referer.isEmpty()) headers.put("Referer", referer);
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36")
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(8000)
                .setReadTimeoutMs(10000)
                .setDefaultRequestProperties(headers);

        // Small start buffer = picture in well under a second, then buffer ahead.
        DefaultLoadControl load = new DefaultLoadControl.Builder()
                // Light on RAM: at most ~30 s / 24 MB of video held in memory.
                .setBufferDurationsMs(10_000, 30_000, 700, 1500)
                .setTargetBufferBytes(24 * 1024 * 1024)
                .setPrioritizeTimeOverSizeThresholds(false)
                .setBackBuffer(0, false)
                .build();

        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(new UnwrapDataSource.Factory(http)))
                .setLoadControl(load)
                .setSeekBackIncrementMs(10_000)
                .setSeekForwardIncrementMs(10_000)
                .build();
        view.setPlayer(player);
        player.addAnalyticsListener(new AnalyticsListener() {
            @Override public void onBandwidthEstimate(@NonNull EventTime t, int loadMs, long bytes, long estimate) {
                bitrateEstimate = estimate;
            }
            @Override public void onVideoInputFormatChanged(@NonNull EventTime t, @NonNull Format f,
                                                            @androidx.annotation.Nullable androidx.media3.exoplayer.DecoderReuseEvaluation e) {
                videoFormat = f;
                if (f.height > 0) videoH = f.height;
            }
            @Override public void onVideoSizeChanged(@NonNull EventTime t, @NonNull VideoSize v) {
                if (v.height > 0) videoH = v.height;
            }
        });
        handler.removeCallbacks(meter);
        handler.post(meter);

        MediaItem.Builder mi = new MediaItem.Builder().setUri(Uri.parse(url));
        String l = url.toLowerCase();
        if (l.contains("m3u8") || l.contains("mpegurl") || !l.contains(".mp4")) mi.setMimeType(MimeTypes.APPLICATION_M3U8);
        player.setMediaItem(mi.build(), startAt > 0 ? (long) (startAt * 1000) : 0);
        player.addListener(new Player.Listener() {
            @Override public void onPlaybackStateChanged(int s) {
                if (s == Player.STATE_READY) started = true;
                if (s == Player.STATE_ENDED) finish();
            }
            @Override public void onPlayerError(@NonNull PlaybackException err) {
                if (reported) return;
                reported = true;
                SbPlayerPlugin.emit(started ? "closed" : "failed", pos(), dur(), err.getErrorCodeName());
                if (!started) quiet = true;
                finish();
            }
        });
        float rate = getSharedPreferences("sb", MODE_PRIVATE).getFloat("rate", 1f);
        player.setPlaybackSpeed(rate);
        player.setPlayWhenReady(true);
        player.prepare();
        handler.removeCallbacks(tick);
        handler.postDelayed(tick, 5000);
    }

    private void hideBars() {
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.hide(WindowInsetsCompat.Type.systemBars());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    @Override public void onWindowFocusChanged(boolean f) { super.onWindowFocusChanged(f); if (f) hideBars(); }

    @Override protected void onPause() {
        super.onPause();
        if (player != null) {
            SbPlayerPlugin.emit("progress", pos(), dur(), null);
            if (!isInPictureInPictureMode()) player.pause();
        }
    }

    /** Closed by the app (another title / server): no "closed" event. */
    void finishQuiet() { quiet = true; finish(); }

    private void release(boolean silent) {
        handler.removeCallbacks(tick);
        handler.removeCallbacks(meter);
        if (player == null) return;
        if (!silent && !quiet && !reported) { reported = true; SbPlayerPlugin.emit("closed", pos(), dur(), null); }
        getSharedPreferences("sb", MODE_PRIVATE).edit().putFloat("rate", player.getPlaybackParameters().speed).apply();
        player.release();
        player = null;
    }

    @Override protected void onDestroy() {
        release(false);
        if (current == this) current = null;
        super.onDestroy();
    }
}
