package com.tezz.tezzdagoat;

import android.content.Intent;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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
