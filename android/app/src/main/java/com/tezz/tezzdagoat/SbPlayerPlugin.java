package com.tezz.tezzdagoat;

import android.content.Intent;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Iterator;

/** JS bridge for the built-in Android player (SbPlayer.play / stop). */
@CapacitorPlugin(name = "SbPlayer")
public class SbPlayerPlugin extends Plugin {
    static SbPlayerPlugin instance;

    @Override
    public void load() { instance = this; }

    @PluginMethod
    public void play(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) { call.reject("no url"); return; }
        Intent i = new Intent(getContext(), PlayerActivity.class);
        i.putExtra("url", url);
        i.putExtra("startAt", call.getDouble("startAt", 0.0));
        i.putExtra("title", call.getString("title", ""));
        i.putExtra("referer", call.getString("referer", ""));
        i.putExtra("session", call.getString("session", ""));
        i.putExtra("offline", Boolean.TRUE.equals(call.getBoolean("offline", false)));
        i.putExtra("mime", call.getString("mime", ""));
        // Headers the page used for this stream (Referer, Origin, User-Agent, Cookie).
        HashMap<String, String> headers = new HashMap<>();
        JSObject h = call.getObject("headers");
        if (h != null) for (Iterator<String> it = h.keys(); it.hasNext(); ) {
            String k = it.next();
            String v = h.optString(k, "");
            if (!v.isEmpty()) headers.put(k, v);
        }
        i.putExtra("headers", headers);
        JSArray subs = call.getArray("subtitles");
        if (subs != null) i.putExtra("subtitles", subs.toString());
        JSObject up = call.getObject("upNext");
        if (up != null && up.length() > 0) i.putExtra("upNext", up.toString());
        i.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        getActivity().runOnUiThread(() -> getActivity().startActivity(i));
        call.resolve();
    }

    // ── Watch Party (src/watch/adapters/android.js) ─────────────────────────
    // JS drives the player with watch({cmd}); the player's state goes back
    // ~every 250 ms as "watchState", the viewer's own taps as "watchIntent"
    // and chat sends as "watchChatSend". Mirrors the iPhone app's sbWatch.
    static volatile boolean watchOn;
    static JSONArray watchChat = new JSONArray();
    static JSONObject watchParty;
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static final Runnable watchTick = new Runnable() {
        @Override public void run() {
            if (!watchOn) return;
            pushWatchState();
            main.postDelayed(this, 250);
        }
    };

    @PluginMethod
    public void watch(PluginCall call) {
        final String cmd = call.getString("cmd", "");
        final JSObject d = call.getData();
        main.post(() -> handleWatch(cmd, d));
        call.resolve();
    }

    private static double num(JSONObject d, String k, double def) {
        double v = d.optDouble(k, def);
        return Double.isNaN(v) || Double.isInfinite(v) ? def : v;
    }

    static void handleWatch(String cmd, JSONObject d) {
        PlayerActivity a = PlayerActivity.current;
        switch (cmd) {
            case "begin":
                watchOn = true;
                main.removeCallbacks(watchTick);
                main.post(watchTick);
                if (a != null) a.setPartyUi(true);
                break;
            case "end":
                watchOn = false;
                main.removeCallbacks(watchTick);
                watchChat = new JSONArray();
                watchParty = null;
                if (a != null) a.setPartyUi(false);
                break;
            case "pause":
                if (a != null) a.watchPause(num(d, "pos", 0));
                break;
            case "playAt":
                if (a != null) a.watchPlayAt(num(d, "pos", 0), num(d, "atMs", System.currentTimeMillis()), (float) num(d, "rate", 1));
                break;
            case "setRate": {
                double r = num(d, "rate", 1);
                if (a != null && r > 0) a.watchSetRate((float) r);
                break;
            }
            case "seek":
                if (a != null) a.watchSeek(num(d, "pos", 0));
                break;
            case "chat": {
                JSONArray m = d.optJSONArray("messages");
                watchChat = m == null ? new JSONArray() : m;
                if (a != null) a.setPartyChat(watchChat);
                break;
            }
            case "party":
                watchParty = d;
                if (a != null) a.setPartyInfo(d);
                break;
            default:
                break;
        }
    }

    static void pushWatchState() {
        SbPlayerPlugin p = instance;
        if (p == null) return;
        PlayerActivity a = PlayerActivity.current;
        JSObject o = a != null ? a.watchState() : null;
        if (o == null) {
            o = new JSObject();
            o.put("open", false);
            o.put("pos", 0);
            o.put("rate", 1);
            o.put("status", "paused");
            o.put("ready", false);
            o.put("seeking", false);
        }
        o.put("sampledAt", (double) System.currentTimeMillis());
        p.notifyListeners("watchState", o);
    }

    /** The viewer tapped play / pause / seek / speed, or closed the player ("stop"). */
    static void emitIntent(String action, double pos, double rate) {
        SbPlayerPlugin p = instance;
        if (p == null || !watchOn) return;
        JSObject o = new JSObject();
        o.put("action", action);
        o.put("pos", Double.isNaN(pos) || pos < 0 ? 0 : pos);
        o.put("rate", Double.isNaN(rate) || rate <= 0 ? 1 : rate);
        p.notifyListeners("watchIntent", o);
    }

    static void emitChatSend(String text) {
        SbPlayerPlugin p = instance;
        if (p == null || !watchOn || text == null) return;
        JSObject o = new JSObject();
        o.put("text", text);
        p.notifyListeners("watchChatSend", o);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        PlayerActivity a = PlayerActivity.current;
        if (a != null) a.runOnUiThread(a::finishQuiet);
        call.resolve();
    }

    static void emit(String event, String session, double pos, double dur, String why) {
        emit(event, session, pos, dur, why, null);
    }

    static void emit(String event, String session, double pos, double dur, String why, JSONObject extra) {
        SbPlayerPlugin p = instance;
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("pos", pos);
        o.put("dur", dur);
        o.put("session", session == null ? "" : session);
        if (why != null) o.put("why", why);
        if (extra != null) for (Iterator<String> it = extra.keys(); it.hasNext(); ) {
            String k = it.next();
            o.put(k, extra.opt(k));
        }
        p.notifyListeners(event, o);
    }
}
