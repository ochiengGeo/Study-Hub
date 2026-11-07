package com.studyhub.app;

import android.net.Uri;
import android.view.WindowManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * JS side: www/nearby.js. Starts/stops ShareServer and reports what friends fetch.
 *   start({ pin, manifest, files: [{token, uri, name, type}] }) → { port, addresses: [{address, iface}] }
 *   stop()
 *   status() → { running, port }
 *   addresses() → { addresses }
 *   events: "share" { type: open|sent|badpin|locked|stopped, ip, detail }
 */
@CapacitorPlugin(name = "NearbyShare")
public class NearbySharePlugin extends Plugin {

    private ShareServer server;
    private int port;

    @PluginMethod
    public void start(PluginCall call) {
        String pin = call.getString("pin");
        String manifest = call.getString("manifest");
        JSArray files = call.getArray("files", new JSArray());
        if (pin == null || pin.length() < 4 || manifest == null) {
            call.reject("pin and manifest are needed");
            return;
        }
        List<String[]> addrs = ShareServer.addresses();
        if (addrs.isEmpty()) {
            call.reject("Turn on Wi-Fi or your hotspot first: this phone isn't on any local network.", "NO_NETWORK");
            return;
        }
        List<ShareServer.Item> items = new ArrayList<>();
        try {
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.getJSONObject(i);
                String uri = f.getString("uri");
                String path = uri.startsWith("file:") ? Uri.parse(uri).getPath() : uri;
                items.add(new ShareServer.Item(f.getString("token"), path, f.optString("name", "file"), f.optString("type", "")));
            }
        } catch (JSONException e) {
            call.reject("bad file list: " + e.getMessage());
            return;
        }
        byte[] page;
        try (InputStream in = getContext().getAssets().open("public/share-page.html")) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
            page = b.toByteArray();
        } catch (IOException e) {
            page = "<h1>StudyHub share</h1><p>Open this in the StudyHub app.</p>".getBytes();
        }
        stopServer();
        server = new ShareServer(pin, manifest, items, page, (type, ip, detail) -> {
            JSObject ev = new JSObject();
            ev.put("type", type);
            ev.put("ip", ip);
            ev.put("detail", detail);
            notifyListeners("share", ev);
            if (type.equals("stopped")) keepScreenOn(false);
        });
        try {
            port = server.start(8765);
        } catch (IOException e) {
            server = null;
            call.reject("Couldn't start sharing: " + e.getMessage());
            return;
        }
        keepScreenOn(true);
        JSObject ret = new JSObject();
        ret.put("port", port);
        ret.put("addresses", addrList(addrs));
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopServer();
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", server != null && server.isRunning());
        ret.put("port", port);
        call.resolve(ret);
    }

    @PluginMethod
    public void addresses(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("addresses", addrList(ShareServer.addresses()));
        call.resolve(ret);
    }

    @Override
    protected void handleOnDestroy() {
        stopServer();
    }

    private void stopServer() {
        if (server != null) server.stop();
        server = null;
        keepScreenOn(false);
    }

    private static JSArray addrList(List<String[]> addrs) {
        JSArray a = new JSArray();
        for (String[] e : addrs) {
            JSObject o = new JSObject();
            o.put("address", e[0]);
            o.put("iface", e[1]);
            a.put(o);
        }
        return a;
    }

    /** While sharing, keep the screen on: Android may pause a phone that has gone to sleep. */
    private void keepScreenOn(boolean on) {
        if (getActivity() == null) return;
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }
}
