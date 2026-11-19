package com.tezz.tezzdagoat;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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

    static void emit(String event, double pos, double dur, String why) {
        SbPlayerPlugin p = instance;
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("pos", pos);
        o.put("dur", dur);
        if (why != null) o.put("why", why);
        p.notifyListeners(event, o);
    }
}
