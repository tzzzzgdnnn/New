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
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.ScrollView;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.text.InputFilter;
import android.text.InputType;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.text.style.StyleSpan;
import android.util.Base64;
import android.util.LruCache;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import androidx.core.view.ViewCompat;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import androidx.appcompat.app.AlertDialog;
import androidx.media3.common.Format;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.PlaybackParameters;
import com.getcapacitor.JSObject;
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
import androidx.media3.exoplayer.upstream.DefaultBandwidthMeter;
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

import android.util.Log;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.HttpDataSource;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.Serializable;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
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
    /** What the on-screen controls drive: the player itself, or (in a Watch Party) a wrapper that reports the viewer's taps to the party. */
    private Player ui;
    private PlayerView view;
    // ── Watch Party (driven by SbPlayerPlugin.handleWatch) ──
    private boolean bg; // activity in the background: never start playing
    private boolean seekInFlight;
    private long seekAt;
    private double watchStartPos;
    private double watchStartAt;
    private float watchRate = 1f;
    private final Runnable watchStart = () -> {
        if (player == null || bg) return;
        double late = (System.currentTimeMillis() - watchStartAt) / 1000.0;
        if (late > 0.25) exactSeek(watchStartPos + late * watchRate);
        player.setPlayWhenReady(true);
    };
    private static boolean partyOn() { return SbPlayerPlugin.watchOn; }
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean quiet, reported, started;
    static final String TAG = "SuperPlayer";
    /** Whose player this is (the page's session id), echoed in every event. */
    private String session = "";
    private boolean offline;
    private String streamUrl = "";
    private int generation; // bumped by every start(), to tell a new play from a stale timer
    // A stream that never gets ready within this long counts as failed, so
    // the page moves on instead of leaving a black screen.
    private static final long START_TIMEOUT_MS = 20_000;
    private final Runnable startWatchdog = () -> {
        if (player == null || started || reported) return;
        fail("timed out: no picture after " + (START_TIMEOUT_MS / 1000) + " s from " + host(streamUrl));
    };
    // Up Next (downloaded episodes): the next download offered at the end.
    private JSONObject upNext;
    private LinearLayout upNextCard;
    private TextView upNextLine;
    private int upNextLeft;
    private boolean upNextShown, upNextDismissed;
    private final Runnable upNextTick = new Runnable() {
        @Override public void run() {
            if (!upNextShown) return;
            if (player != null && !player.isPlaying() && player.getPlaybackState() != Player.STATE_ENDED) {
                handler.postDelayed(this, 1000); // paused by the viewer: hold the countdown
                return;
            }
            upNextLeft--;
            updateUpNextLine();
            if (upNextLeft <= 0) playUpNext(); else handler.postDelayed(this, 1000);
        }
    };
    private final Runnable upNextWatch = new Runnable() {
        @Override public void run() {
            if (player != null && upNext != null && !upNextShown && !upNextDismissed) {
                long d = player.getDuration();
                if (d != C.TIME_UNSET && d > 60_000 && d - player.getCurrentPosition() <= 1500) showUpNext();
            }
            handler.postDelayed(this, 500);
        }
    };
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
                SbPlayerPlugin.emit("progress", session, pos(), dur(), null);
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
                .setSingleChoiceItems(labels, sel, (d, w) -> { ui.setPlaybackSpeed(SPEEDS[w]); updatePill(); d.dismiss(); hideBars(); })
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
        buildUpNext(root);
        buildPartyChat(root);
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
                ui.seekTo(Math.max(0, player.getCurrentPosition() + d));
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
        // Opened during a party: show the chat the party already has.
        if (partyOn()) {
            setPartyUi(true);
            setPartyChat(SbPlayerPlugin.watchChat);
            if (SbPlayerPlugin.watchParty != null) setPartyInfo(SbPlayerPlugin.watchParty);
            if (player != null) player.setVolume(SbPlayerPlugin.watchDuck);
        }
    }

    // TV remote (Fire TV / Android TV): with the controls hidden, Left/Right
    // skip 10 s and OK pauses or plays; with them showing, the D-pad moves
    // between the buttons. Play/Pause, Rewind and Fast-forward always work.
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        if (player == null || view == null || ui == null) return super.dispatchKeyEvent(e);
        // Typing in the party chat: keys belong to the text box, never the player.
        if (chatField != null && chatField.hasFocus()) return super.dispatchKeyEvent(e);
        int k = e.getKeyCode();
        boolean down = e.getAction() == KeyEvent.ACTION_DOWN;
        switch (k) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                if (down && e.getRepeatCount() == 0) {
                    if (k == KeyEvent.KEYCODE_MEDIA_PAUSE || (k == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE && player.getPlayWhenReady())) ui.pause();
                    else ui.play();
                    view.showController();
                }
                return true;
            case KeyEvent.KEYCODE_MEDIA_REWIND:
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                if (down) {
                    long d = k == KeyEvent.KEYCODE_MEDIA_REWIND ? -10_000 : 10_000;
                    ui.seekTo(Math.max(0, player.getCurrentPosition() + d));
                    view.showController();
                }
                return true;
        }
        if (!view.isControllerFullyVisible()) {
            if (k == KeyEvent.KEYCODE_DPAD_LEFT || k == KeyEvent.KEYCODE_DPAD_RIGHT) {
                if (down) {
                    long d = k == KeyEvent.KEYCODE_DPAD_LEFT ? -10_000 : 10_000;
                    ui.seekTo(Math.max(0, player.getCurrentPosition() + d));
                    Toast.makeText(this, d < 0 ? "⏪ 10s" : "10s ⏩", Toast.LENGTH_SHORT).show();
                }
                return true;
            }
            if (k == KeyEvent.KEYCODE_DPAD_CENTER || k == KeyEvent.KEYCODE_ENTER || k == KeyEvent.KEYCODE_NUMPAD_ENTER) {
                if (down && e.getRepeatCount() == 0) {
                    if (player.getPlayWhenReady()) ui.pause(); else ui.play();
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

    private static String host(String url) {
        try { return Uri.parse(url).getHost(); } catch (Exception e) { return "?"; }
    }

    @SuppressWarnings("unchecked")
    private void start(Intent in) {
        String url = in.getStringExtra("url");
        double startAt = in.getDoubleExtra("startAt", 0);
        String referer = in.getStringExtra("referer");
        session = in.getStringExtra("session") == null ? "" : in.getStringExtra("session");
        offline = in.getBooleanExtra("offline", false);
        streamUrl = url == null ? "" : url;
        reported = false; started = false;
        generation++;
        upNextShown = false; upNextDismissed = false;
        if (upNextCard != null) upNextCard.setVisibility(View.GONE);
        try { upNext = in.getStringExtra("upNext") == null ? null : new JSONObject(in.getStringExtra("upNext")); } catch (Exception e) { upNext = null; }

        // Headers the stream's own page used. Without its Referer/Origin many
        // hosts answer 403, which left a black player that then closed.
        Map<String, String> headers = new HashMap<>();
        Serializable hx = in.getSerializableExtra("headers");
        if (hx instanceof Map) for (Map.Entry<?, ?> e : ((Map<?, ?>) hx).entrySet())
            if (e.getKey() != null && e.getValue() != null) headers.put(String.valueOf(e.getKey()), String.valueOf(e.getValue()));
        if (referer != null && !referer.isEmpty() && !headers.containsKey("Referer")) {
            headers.put("Referer", referer);
            Uri r = Uri.parse(referer);
            if (r.getScheme() != null && r.getHost() != null && !headers.containsKey("Origin"))
                headers.put("Origin", r.getScheme() + "://" + r.getHost() + (r.getPort() > 0 ? ":" + r.getPort() : ""));
        }
        String ua = headers.remove("User-Agent");
        Log.i(TAG, "player: open " + (offline ? "offline " : "") + host(streamUrl) + " headers=" + headers.keySet());
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent(ua != null ? ua : "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36")
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
                // Best-quality rule: assume a fast link at the start, so the
                // first segments come from the top rendition instead of the
                // lowest; ABR still steps down if the connection can't keep up.
                .setBandwidthMeter(new DefaultBandwidthMeter.Builder(this).setInitialBitrateEstimate(20_000_000L).build())
                .setMediaSourceFactory(new DefaultMediaSourceFactory(new UnwrapDataSource.Factory(new DefaultDataSource.Factory(this, http))))
                .setLoadControl(load)
                .setSeekBackIncrementMs(10_000)
                .setSeekForwardIncrementMs(10_000)
                .build();
        ui = new PartyAwarePlayer(player);
        view.setPlayer(ui);
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
        String mime = in.getStringExtra("mime");
        if ("hls".equals(mime) || (!"mp4".equals(mime) && (l.contains("m3u8") || l.contains("mpegurl") || !l.contains(".mp4"))))
            mi.setMimeType(MimeTypes.APPLICATION_M3U8);
        // Subtitles saved with a download.
        List<MediaItem.SubtitleConfiguration> subs = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(in.getStringExtra("subtitles") == null ? "[]" : in.getStringExtra("subtitles"));
            for (int i = 0; i < a.length(); i++) {
                JSONObject s = a.getJSONObject(i);
                subs.add(new MediaItem.SubtitleConfiguration.Builder(Uri.parse(s.getString("url")))
                        .setMimeType(MimeTypes.TEXT_VTT).setLanguage(s.optString("lang", null))
                        .setLabel(s.optString("lang", "Subtitles")).build());
            }
        } catch (Exception ignored) {}
        if (!subs.isEmpty()) mi.setSubtitleConfigurations(subs);
        player.setMediaItem(mi.build(), startAt > 0 ? (long) (startAt * 1000) : 0);
        player.addListener(new Player.Listener() {
            @Override public void onPlaybackStateChanged(int s) {
                if (s == Player.STATE_READY && !started) {
                    started = true;
                    handler.removeCallbacks(startWatchdog);
                    Log.i(TAG, "player: playing " + host(streamUrl));
                }
                if (s == Player.STATE_ENDED) {
                    if (partyOn()) return; // party: stay on the last frame, the room decides what's next
                    if (upNext != null && !upNextDismissed) { if (!upNextShown) showUpNext(); }
                    else finish();
                }
            }
            @Override public void onPlayerError(@NonNull PlaybackException err) {
                fail(describe(err));
            }
        });
        // Party: open paused at 1x; the room seeks every phone to the same
        // frame and starts them all together once each one is buffered.
        boolean party = partyOn();
        float rate = party ? 1f : getSharedPreferences("sb", MODE_PRIVATE).getFloat("rate", 1f);
        watchRate = rate;
        player.setPlaybackSpeed(rate);
        player.setPlayWhenReady(!party);
        player.prepare();
        handler.removeCallbacks(tick);
        handler.postDelayed(tick, 5000);
        handler.removeCallbacks(startWatchdog);
        if (!offline) handler.postDelayed(startWatchdog, START_TIMEOUT_MS);
        handler.removeCallbacks(upNextWatch);
        if (upNext != null) handler.postDelayed(upNextWatch, 500);
    }

    /** A readable reason for a playback error: HTTP status and host when there is one. */
    private String describe(PlaybackException err) {
        Throwable c = err.getCause();
        while (c != null) {
            if (c instanceof HttpDataSource.InvalidResponseCodeException) {
                HttpDataSource.InvalidResponseCodeException h = (HttpDataSource.InvalidResponseCodeException) c;
                return "HTTP " + h.responseCode + " from " + host(h.dataSpec.uri.toString())
                        + (h.responseCode == 403 ? " (refused: the host wants the page's headers)" : "");
            }
            if (c instanceof HttpDataSource.HttpDataSourceException) {
                HttpDataSource.HttpDataSourceException h = (HttpDataSource.HttpDataSourceException) c;
                return err.getErrorCodeName() + " (" + host(h.dataSpec.uri.toString()) + ")";
            }
            c = c.getCause();
        }
        return err.getErrorCodeName() + (err.getMessage() != null ? ": " + err.getMessage() : "");
    }

    /**
     * Playback failed: log it, tell the page why (it tries the next stream or
     * server), and close. Never left on a black screen.
     */
    private void fail(String why) {
        if (reported) return;
        reported = true;
        handler.removeCallbacks(startWatchdog);
        Log.e(TAG, "player: " + (started ? "stopped" : "failed to start") + ": " + why + " url=" + streamUrl);
        SbPlayerPlugin.emit(started ? "closed" : "failed", session, pos(), dur(), why);
        if (!started) {
            quiet = true;
            Toast.makeText(this, "Couldn't play this server (" + why + ")", Toast.LENGTH_SHORT).show();
        }
        finish();
    }

    // ── Up Next (downloads) ────────────────────────────────────────────────

    private void buildUpNext(FrameLayout root) {
        upNextCard = new LinearLayout(this);
        upNextCard.setOrientation(LinearLayout.VERTICAL);
        int p = dp(14);
        upNextCard.setPadding(p, p, p, p);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(14));
        bg.setColor(0xEE1A1A1A);
        upNextCard.setBackground(bg);
        upNextLine = new TextView(this);
        upNextLine.setTextColor(0xFFCCCCCC);
        upNextLine.setTextSize(12);
        upNextLine.setTypeface(Typeface.DEFAULT_BOLD);
        TextView title = new TextView(this);
        title.setTag("title");
        title.setTextColor(0xFFFFFFFF);
        title.setTextSize(15);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setMaxLines(2);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        TextView cancel = chip("Cancel", false);
        cancel.setFocusable(true);
        cancel.setOnClickListener(v -> { upNextDismissed = true; hideUpNext(); if (player != null && player.getPlaybackState() == Player.STATE_ENDED) finish(); });
        TextView play = chip("▶  Play Now", true);
        play.setFocusable(true);
        play.setOnClickListener(v -> playUpNext());
        row.addView(cancel);
        View gap = new View(this);
        row.addView(gap, new LinearLayout.LayoutParams(dp(10), 1));
        row.addView(play);
        upNextCard.addView(upNextLine);
        upNextCard.addView(title);
        LinearLayout.LayoutParams rl = new LinearLayout.LayoutParams(-2, -2);
        rl.topMargin = dp(10);
        upNextCard.addView(row, rl);
        upNextCard.setVisibility(View.GONE);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(dp(300), -2, Gravity.BOTTOM | Gravity.END);
        lp.setMargins(0, 0, dp(20), dp(80));
        root.addView(upNextCard, lp);
    }

    private void showUpNext() {
        if (upNext == null || upNextCard == null || upNextShown || upNextDismissed) return;
        upNextShown = true;
        String sub = upNext.optString("subtitle", "");
        String t = upNext.optString("title", "Next episode");
        ((TextView) upNextCard.findViewWithTag("title")).setText(sub.isEmpty() ? t : sub + " · " + t);
        upNextLeft = Math.max(0, upNext.optInt("countdown", 10));
        updateUpNextLine();
        upNextCard.setAlpha(0f);
        upNextCard.setVisibility(View.VISIBLE);
        upNextCard.animate().alpha(1f).setDuration(250).start();
        upNextCard.bringToFront();
        handler.removeCallbacks(upNextTick);
        if (upNextLeft > 0) handler.postDelayed(upNextTick, 1000); // 0 = buttons only
    }

    private void updateUpNextLine() {
        if (upNextLine != null) upNextLine.setText(upNextLeft > 0 ? "UP NEXT IN " + upNextLeft : "UP NEXT");
    }

    private void hideUpNext() {
        handler.removeCallbacks(upNextTick);
        upNextShown = false;
        if (upNextCard != null) upNextCard.setVisibility(View.GONE);
    }

    /** Hands the next download to the page, which opens it in this player. */
    private void playUpNext() {
        if (upNext == null) return;
        String next = upNext.optString("downloadId", "");
        hideUpNext();
        upNextDismissed = true;
        JSONObject extra = new JSONObject();
        try { extra.put("next", next); } catch (Exception ignored) {}
        reported = true;
        SbPlayerPlugin.emit("upnext", session, pos(), dur(), null, extra);
        // The page answers with a new play; close if it doesn't.
        final int gen = generation;
        handler.postDelayed(() -> { if (gen == generation && !isFinishing()) finishQuiet(); }, 8000);
    }

    private void hideBars() {
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.hide(WindowInsetsCompat.Type.systemBars());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    @Override public void onWindowFocusChanged(boolean f) { super.onWindowFocusChanged(f); if (f) hideBars(); }

    @Override protected void onPause() {
        super.onPause();
        bg = true;
        handler.removeCallbacks(watchStart);
        if (player != null) {
            SbPlayerPlugin.emit("progress", session, pos(), dur(), null);
            player.pause(); // never a party Pause: only the viewer's own tap is
        }
    }

    @Override protected void onResume() {
        super.onResume();
        bg = false; // party: the sync engine puts this phone back on the room's timeline
    }

    // ── Watch Party ────────────────────────────────────────────────────────

    /**
     * The controls' player. Outside a party it is the player itself. In a
     * party: Pause pauses here at once and tells the party (everyone pauses on
     * that frame); Play only asks the party (everyone starts together); seeks
     * and speed apply here and go to the party. Stalls, the app going to the
     * background and the chat keyboard never reach the party.
     */
    private final class PartyAwarePlayer extends ForwardingPlayer {
        PartyAwarePlayer(Player p) { super(p); }
        @Override public void play() {
            if (!partyOn()) { super.play(); return; }
            SbPlayerPlugin.emitIntent("play", pos(), speed());
        }
        @Override public void pause() {
            super.pause();
            if (partyOn()) { handler.removeCallbacks(watchStart); SbPlayerPlugin.emitIntent("pause", pos(), speed()); }
        }
        @Override public void setPlayWhenReady(boolean b) { if (b) play(); else pause(); }
        @Override public void seekTo(long ms) {
            super.seekTo(ms);
            if (partyOn()) { seekInFlight = true; seekAt = System.currentTimeMillis(); SbPlayerPlugin.emitIntent("seek", Math.max(0, ms) / 1000.0, speed()); }
        }
        @Override public void seekTo(int index, long ms) {
            super.seekTo(index, ms);
            if (partyOn()) { seekInFlight = true; seekAt = System.currentTimeMillis(); SbPlayerPlugin.emitIntent("seek", Math.max(0, ms) / 1000.0, speed()); }
        }
        @Override public void seekBack() { seekTo(Math.max(0, getCurrentPosition() - 10_000)); }
        @Override public void seekForward() { seekTo(getCurrentPosition() + 10_000); }
        @Override public void setPlaybackSpeed(float r) {
            super.setPlaybackSpeed(r);
            if (partyOn()) SbPlayerPlugin.emitIntent("rate", pos(), r);
        }
        @Override public void setPlaybackParameters(@NonNull PlaybackParameters p) {
            super.setPlaybackParameters(p);
            if (partyOn()) SbPlayerPlugin.emitIntent("rate", pos(), p.speed);
        }
    }

    private float speed() { return player == null ? 1f : player.getPlaybackParameters().speed; }

    private void exactSeek(double pos) {
        if (player == null) return;
        seekInFlight = true;
        seekAt = System.currentTimeMillis();
        player.seekTo((long) (Math.max(0, pos) * 1000));
    }

    /** Player state for the party (null once closing: the plugin then reports "no player"). */
    JSObject watchState() {
        if (player == null || isFinishing()) return null;
        int st = player.getPlaybackState();
        if (seekInFlight && st == Player.STATE_READY && System.currentTimeMillis() - seekAt > 120) seekInFlight = false;
        if (seekInFlight && System.currentTimeMillis() - seekAt > 10_000) seekInFlight = false;
        String status = player.isPlaying() ? "playing"
                : (player.getPlayWhenReady() && st == Player.STATE_BUFFERING) ? "waiting" : "paused";
        JSObject o = new JSObject();
        o.put("open", true);
        o.put("pos", pos());
        o.put("rate", (double) speed());
        o.put("status", status);
        o.put("ready", st == Player.STATE_READY);
        o.put("seeking", seekInFlight);
        return o;
    }

    /** Stop, then land exactly on `pos`. */
    void watchPause(double pos) {
        if (player == null) return;
        handler.removeCallbacks(watchStart);
        player.setPlayWhenReady(false);
        if (Math.abs(pos() - pos) > 0.02) exactSeek(pos);
    }

    /** Start item time `pos` at wall-clock instant `atMs` (JS Date.now() ms). */
    void watchPlayAt(double pos, double atMs, float rate) {
        if (player == null) return;
        handler.removeCallbacks(watchStart);
        watchRate = rate > 0 ? rate : 1f;
        player.setPlaybackSpeed(watchRate);
        long delay = (long) (atMs - System.currentTimeMillis());
        if (delay > 0) {
            player.setPlayWhenReady(false);
            if (Math.abs(pos() - pos) > 0.02) exactSeek(pos);
            watchStartPos = pos;
            watchStartAt = atMs;
            handler.postDelayed(watchStart, delay);
        } else {
            double target = pos + (-delay / 1000.0) * watchRate;
            if (Math.abs(pos() - target) > 0.05) exactSeek(target);
            if (!bg) player.setPlayWhenReady(true);
        }
    }

    void watchSetRate(float r) {
        watchRate = r;
        if (player != null) player.setPlaybackSpeed(r);
    }

    void watchSeek(double pos) { exactSeek(pos); }

    /** Party voice: the movie glides to `level` of its volume while someone talks, then back. */
    private Runnable duckStep;
    void setDuck(float level) {
        if (player == null) return;
        if (duckStep != null) handler.removeCallbacks(duckStep);
        final float from = player.getVolume(), to = Math.max(0f, Math.min(1f, level));
        final int[] i = {0};
        duckStep = new Runnable() {
            @Override public void run() {
                if (player == null) return;
                i[0]++;
                player.setVolume(from + (to - from) * Math.min(1f, i[0] / 10f));
                if (i[0] < 10) handler.postDelayed(this, 25);
            }
        };
        handler.post(duckStep);
    }

    // ── Party chat (the counterpart of the iPhone player's chat column) ──
    // Video on the left, chat on the right (36%, at most 360 dp): the
    // party's code and head count, the messages with each sender's profile
    // picture, and a compose bar. The 💬 chip hides it (full-screen video,
    // unread count on the chip) and brings it back. Chat never pauses
    // anything: typing, the keyboard and sending are not player events.
    private static final int CHAT_MAX_LEN = 280;
    private static final LruCache<String, Bitmap> avatarCache = new LruCache<>(64);
    private static final ExecutorService avatarLoader = Executors.newFixedThreadPool(2);
    private boolean chatOn, chatHidden;
    private int chatUnread;
    private final Set<String> chatSeen = new HashSet<>();
    private boolean chatPrimed;
    private LinearLayout chatPanel, chatList;
    private ScrollView chatScroll;
    private EditText chatField;
    private TextView chatPill, chatToggle;

    private void buildPartyChat(FrameLayout root) {
        chatPanel = new LinearLayout(this);
        chatPanel.setOrientation(LinearLayout.VERTICAL);
        chatPanel.setBackgroundColor(0xFF0C0C10);
        chatPanel.setPadding(dp(10), dp(12), dp(10), dp(8));
        chatPanel.setClickable(true); // taps on the chat never reach the video

        chatPill = new TextView(this);
        chatPill.setTextColor(0xFFFFD0E6);
        chatPill.setTextSize(13);
        chatPill.setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD));
        chatPill.setLetterSpacing(0.08f);
        chatPanel.addView(chatPill, new LinearLayout.LayoutParams(-1, -2));

        chatScroll = new ScrollView(this);
        chatScroll.setFillViewport(true);
        chatList = new LinearLayout(this);
        chatList.setOrientation(LinearLayout.VERTICAL);
        chatList.setGravity(Gravity.BOTTOM);
        chatScroll.addView(chatList, new FrameLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams sl = new LinearLayout.LayoutParams(-1, 0, 1f);
        sl.topMargin = dp(6);
        chatPanel.addView(chatScroll, sl);

        LinearLayout compose = new LinearLayout(this);
        compose.setOrientation(LinearLayout.HORIZONTAL);
        compose.setGravity(Gravity.CENTER_VERTICAL);
        chatField = new EditText(this);
        chatField.setHint("Say something…");
        chatField.setHintTextColor(0x88FFFFFF);
        chatField.setTextColor(0xFFFFFFFF);
        chatField.setTextSize(15);
        chatField.setSingleLine(true);
        chatField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        chatField.setImeOptions(EditorInfo.IME_ACTION_SEND | EditorInfo.IME_FLAG_NO_FULLSCREEN | EditorInfo.IME_FLAG_NO_EXTRACT_UI);
        chatField.setFilters(new InputFilter[]{new InputFilter.LengthFilter(CHAT_MAX_LEN)});
        chatField.setPadding(dp(12), dp(8), dp(12), dp(8));
        GradientDrawable fb = new GradientDrawable();
        fb.setCornerRadius(dp(12));
        fb.setColor(0x14FFFFFF);
        fb.setStroke(dp(1), 0x2EFFFFFF);
        chatField.setBackground(fb);
        chatField.setOnEditorActionListener((v, id, ev) -> {
            if (id == EditorInfo.IME_ACTION_SEND || (ev != null && ev.getKeyCode() == KeyEvent.KEYCODE_ENTER && ev.getAction() == KeyEvent.ACTION_DOWN)) {
                sendChat();
                return true;
            }
            return false;
        });
        compose.addView(chatField, new LinearLayout.LayoutParams(0, -2, 1f));
        TextView send = chip("Send", true);
        send.setOnClickListener(v -> sendChat());
        LinearLayout.LayoutParams snd = new LinearLayout.LayoutParams(-2, -2);
        snd.leftMargin = dp(6);
        compose.addView(send, snd);
        LinearLayout.LayoutParams cl = new LinearLayout.LayoutParams(-1, -2);
        cl.topMargin = dp(6);
        chatPanel.addView(compose, cl);
        chatPanel.setVisibility(View.GONE);
        root.addView(chatPanel, new FrameLayout.LayoutParams(chatWidth(), -1, Gravity.END));

        // 💬 chip: hide / show the chat (always reachable, top right under the meter).
        chatToggle = chip("💬", false);
        chatToggle.setOnClickListener(v -> setChatHidden(!chatHidden));
        chatToggle.setVisibility(View.GONE);
        FrameLayout.LayoutParams tl = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.END);
        tl.setMargins(0, dp(56), dp(18), 0);
        root.addView(chatToggle, tl);

        // The keyboard pushes the compose bar up instead of covering it.
        ViewCompat.setOnApplyWindowInsetsListener(chatPanel, (v, insets) -> {
            int ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
            v.setPadding(dp(10), dp(12), dp(10), dp(8) + ime);
            return insets;
        });
    }

    private int chatWidth() {
        int w = getResources().getDisplayMetrics().widthPixels;
        int h = getResources().getDisplayMetrics().heightPixels;
        return Math.min((int) (Math.max(w, h) * 0.36f), dp(360));
    }

    private void layoutForChat() {
        if (chatPanel == null) return;
        boolean show = chatOn && !chatHidden;
        chatPanel.setVisibility(show ? View.VISIBLE : View.GONE);
        chatToggle.setVisibility(chatOn ? View.VISIBLE : View.GONE);
        FrameLayout.LayoutParams vl = (FrameLayout.LayoutParams) view.getLayoutParams();
        vl.rightMargin = show ? chatWidth() : 0;
        view.setLayoutParams(vl);
        FrameLayout.LayoutParams pl = (FrameLayout.LayoutParams) netPill.getLayoutParams();
        pl.rightMargin = dp(18) + (show ? chatWidth() : 0);
        netPill.setLayoutParams(pl);
        FrameLayout.LayoutParams tl = (FrameLayout.LayoutParams) chatToggle.getLayoutParams();
        tl.rightMargin = dp(18) + (show ? chatWidth() : 0);
        chatToggle.setLayoutParams(tl);
        updateChatToggle();
        if (!show && chatField.hasFocus()) hideKeyboard();
    }

    private void setChatHidden(boolean hidden) {
        chatHidden = hidden;
        if (!hidden) chatUnread = 0;
        layoutForChat();
        if (!hidden) scrollChatToEnd();
    }

    private void updateChatToggle() {
        if (chatToggle == null) return;
        chatToggle.setText(chatHidden && chatUnread > 0 ? "💬 " + chatUnread : "💬");
    }

    private void hideKeyboard() {
        InputMethodManager im = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (im != null) im.hideSoftInputFromWindow(chatField.getWindowToken(), 0);
        chatField.clearFocus();
        hideBars();
    }

    private void sendChat() {
        String t = chatField.getText().toString().trim();
        if (t.isEmpty()) return;
        if (t.length() > CHAT_MAX_LEN) t = t.substring(0, CHAT_MAX_LEN);
        SbPlayerPlugin.emitChatSend(t);
        chatField.setText("");
    }

    private void scrollChatToEnd() {
        if (chatScroll != null) chatScroll.post(() -> chatScroll.fullScroll(View.FOCUS_DOWN));
    }

    void setPartyUi(boolean on) {
        if (chatPanel == null) return;
        chatOn = on;
        chatHidden = false; // a party opens with the chat beside the video
        chatUnread = 0;
        if (!on) {
            chatSeen.clear();
            chatPrimed = false;
            chatList.removeAllViews();
            chatField.setText("");
            chatPill.setText("");
        }
        layoutForChat();
    }

    /** Recent messages, latest last: {id, name, text (HTML-escaped by the room), ts, mine, avatarUrl, avatarFrom, avatarTo, initial}. */
    void setPartyChat(JSONArray messages) {
        if (chatList == null || messages == null) return;
        boolean first = !chatPrimed;
        chatPrimed = true;
        chatList.removeAllViews();
        int from = Math.max(0, messages.length() - 50);
        for (int i = from; i < messages.length(); i++) {
            JSONObject m = messages.optJSONObject(i);
            if (m == null) continue;
            String id = m.has("id") && !m.isNull("id") ? m.optString("id") : m.optString("ts") + "|" + m.optString("name") + "|" + m.optString("text");
            if (chatSeen.add(id) && !first && chatHidden && !m.optBoolean("mine")) chatUnread++;
            chatList.addView(chatRow(m));
        }
        updateChatToggle();
        scrollChatToEnd();
    }

    void setPartyInfo(JSONObject info) {
        if (chatPill == null || info == null) return;
        String code = info.optString("code", "");
        String pretty = code.length() == 6 ? code.substring(0, 3) + " " + code.substring(3) : code;
        int count = info.optInt("count", 0), max = info.optInt("max", 0);
        chatPill.setText("PARTY " + pretty + (max > 0 ? "  ·  " + count + "/" + max : ""));
    }

    private static String unescapeHtml(String s) {
        return s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"")
                .replace("&#39;", "'").replace("&#x27;", "'").replace("&amp;", "&");
    }

    private View chatRow(JSONObject m) {
        boolean mine = m.optBoolean("mine");
        String name = unescapeHtml(m.optString("name", ""));
        String text = unescapeHtml(m.optString("text", ""));
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.TOP);
        row.setPadding(0, dp(3), 0, dp(3));
        row.addView(avatarView(m), new LinearLayout.LayoutParams(dp(26), dp(26)));
        TextView t = new TextView(this);
        SpannableStringBuilder sb = new SpannableStringBuilder();
        String who = mine ? "You" : name;
        sb.append(who.isEmpty() ? "" : who + ": ");
        sb.setSpan(new StyleSpan(Typeface.BOLD), 0, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        sb.setSpan(new ForegroundColorSpan(mine ? 0xFFFF4F6A : 0xBFFFFFFF), 0, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        sb.append(text); // plain text, never HTML
        t.setText(sb);
        t.setTextColor(0xFFFFFFFF);
        t.setTextSize(14);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, -2, 1f);
        lp.leftMargin = dp(8);
        row.addView(t, lp);
        return row;
    }

    private static int color(String hex, int def) {
        try { return 0xFF000000 | Integer.parseInt(hex.replace("#", ""), 16); } catch (Exception e) { return def; }
    }

    /** The sender's profile picture, or their profile gradient with their initial. */
    private View avatarView(JSONObject m) {
        FrameLayout f = new FrameLayout(this);
        GradientDrawable g = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{color(m.optString("avatarFrom"), 0xFF8E8E93), color(m.optString("avatarTo"), 0xFF1C1C1E)});
        g.setShape(GradientDrawable.OVAL);
        f.setBackground(g);
        f.setClipToOutline(true);
        f.setOutlineProvider(new android.view.ViewOutlineProvider() {
            @Override public void getOutline(View v, android.graphics.Outline o) { o.setOval(0, 0, v.getWidth(), v.getHeight()); }
        });
        TextView ini = new TextView(this);
        String initial = m.optString("initial", "");
        ini.setText(initial.isEmpty() ? "" : initial.substring(0, 1));
        ini.setTextColor(0xFFFFFFFF);
        ini.setTextSize(12);
        ini.setTypeface(Typeface.DEFAULT_BOLD);
        ini.setGravity(Gravity.CENTER);
        f.addView(ini, new FrameLayout.LayoutParams(-1, -1));
        ImageView img = new ImageView(this);
        img.setScaleType(ImageView.ScaleType.CENTER_CROP);
        f.addView(img, new FrameLayout.LayoutParams(-1, -1));
        loadAvatar(m.optString("avatarUrl", ""), img);
        return f;
    }

    private void loadAvatar(String url, ImageView into) {
        if (url == null || url.isEmpty()) return;
        Bitmap hit = avatarCache.get(url);
        if (hit != null) { into.setImageBitmap(hit); return; }
        avatarLoader.execute(() -> {
            Bitmap b = null;
            try {
                if (url.startsWith("data:image/")) {
                    int comma = url.indexOf(',');
                    byte[] bytes = Base64.decode(url.substring(comma + 1), Base64.DEFAULT);
                    b = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                } else if (url.startsWith("https://")) {
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(6000);
                    c.setReadTimeout(8000);
                    try (InputStream in = c.getInputStream()) { b = BitmapFactory.decodeStream(in); }
                    finally { c.disconnect(); }
                }
            } catch (Exception e) {
                Log.w(TAG, "chat avatar: " + e.getMessage());
            }
            if (b == null) return;
            avatarCache.put(url, b);
            final Bitmap bm = b;
            into.post(() -> into.setImageBitmap(bm));
        });
    }

    /** Closed by the app (another title / server): no "closed" event. */
    void finishQuiet() { quiet = true; finish(); }

    private void release(boolean silent) {
        handler.removeCallbacks(tick);
        handler.removeCallbacks(meter);
        handler.removeCallbacks(startWatchdog);
        handler.removeCallbacks(upNextWatch);
        handler.removeCallbacks(upNextTick);
        if (player == null) return;
        if (!silent && !quiet && !reported) {
            reported = true;
            SbPlayerPlugin.emit("closed", session, pos(), dur(), null);
            // The viewer closed the party player: "stop" pauses the party on this frame.
            if (partyOn()) SbPlayerPlugin.emitIntent("stop", pos(), speed());
        }
        handler.removeCallbacks(watchStart);
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
