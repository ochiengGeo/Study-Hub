package com.studyhub.app;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * "Share nearby": a small, read-only web server that runs on the sending phone while its Share
 * screen is open. Friends on the same Wi-Fi or on this phone's hotspot fetch from it.
 *
 *   GET /               the download page, for friends without StudyHub (any browser)
 *   GET /api/hello      "this is a StudyHub share" (no PIN needed, shows nothing private)
 *   GET /api/manifest   what is being shared (JSON made by the app)       PIN needed
 *   GET /f/TOKEN[/name] one file's contents; supports Range (resume)       PIN needed
 *
 * The PIN comes in the X-Share-Pin header, or ?k= for plain browser links. After MAX_BAD wrong
 * PINs the server locks and stops. Nothing can be uploaded. It stops by itself after IDLE_MS
 * without requests. Plain Java (no Android classes), so it can be tested on a laptop.
 */
public class ShareServer {

    public interface Listener {
        /** type: open | sent | badpin | locked | stopped */
        void onEvent(String type, String ip, String detail);
    }

    public static class Item {
        public final String token, path, name, type;

        public Item(String token, String path, String name, String type) {
            this.token = token;
            this.path = path;
            this.name = name;
            this.type = type == null || type.isEmpty() ? "application/octet-stream" : type;
        }
    }

    static final int MAX_BAD = 20;
    static final long IDLE_MS = 15 * 60 * 1000;

    private final String pin;
    private final byte[] manifest;
    private final byte[] page;
    private final Map<String, Item> items = new HashMap<>();
    private final Listener listener;
    private final AtomicInteger bad = new AtomicInteger();
    private volatile long lastActivity = System.currentTimeMillis();
    private volatile boolean running;
    private ServerSocket socket;
    private ExecutorService pool;
    private Thread acceptThread;

    public ShareServer(String pin, String manifestJson, List<Item> files, byte[] page, Listener listener) {
        this.pin = pin;
        this.manifest = manifestJson.getBytes(StandardCharsets.UTF_8);
        this.page = page;
        for (Item i : files) items.put(i.token, i);
        this.listener = listener;
    }

    /** Starts on the first free port from `preferred` (a few tries, then any). Returns the port. */
    public synchronized int start(int preferred) throws IOException {
        IOException last = null;
        for (int p = preferred; p < preferred + 6 && socket == null; p++) {
            try {
                socket = bind(p);
            } catch (IOException e) {
                last = e;
            }
        }
        if (socket == null) {
            try {
                socket = bind(0);
            } catch (IOException e) {
                throw last != null ? last : e;
            }
        }
        socket.setSoTimeout(15000);   // wake up now and then to check the idle timer
        running = true;
        pool = Executors.newFixedThreadPool(8);
        acceptThread = new Thread(this::acceptLoop, "share-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
        return socket.getLocalPort();
    }

    private static ServerSocket bind(int port) throws IOException {
        ServerSocket s = new ServerSocket();
        s.setReuseAddress(true);
        s.bind(new InetSocketAddress(port));
        return s;
    }

    public synchronized void stop() {
        if (!running) return;
        running = false;
        try {
            socket.close();
        } catch (IOException ignored) {
        }
        pool.shutdownNow();
    }

    public boolean isRunning() {
        return running;
    }

    private void acceptLoop() {
        String why = "stopped";
        while (running) {
            try {
                Socket c = socket.accept();
                pool.execute(() -> handle(c));
            } catch (SocketTimeoutException e) {
                if (System.currentTimeMillis() - lastActivity > IDLE_MS) {
                    why = "idle";
                    break;
                }
            } catch (IOException e) {
                break;   // closed by stop()
            }
        }
        if (bad.get() >= MAX_BAD) why = "locked";
        stop();
        listener.onEvent("stopped", "", why);
    }

    // ------------------------------------------------------------------ requests
    private void handle(Socket c) {
        String ip = c.getInetAddress().getHostAddress();
        try (Socket s = c) {
            s.setSoTimeout(30000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();
            String head = readHead(in);
            if (head == null) return;
            String[] lines = head.split("\r\n");
            String[] req = lines[0].split(" ");
            if (req.length < 2) return;
            String method = req[0], target = req[1];
            Map<String, String> h = new HashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int k = lines[i].indexOf(':');
                if (k > 0) h.put(lines[i].substring(0, k).trim().toLowerCase(Locale.ROOT), lines[i].substring(k + 1).trim());
            }
            lastActivity = System.currentTimeMillis();
            String path = target, query = "";
            int q = target.indexOf('?');
            if (q >= 0) {
                path = target.substring(0, q);
                query = target.substring(q + 1);
            }
            Map<String, String> qs = parseQuery(query);
            boolean headOnly = method.equals("HEAD");

            if (method.equals("OPTIONS")) {
                send(out, 204, "No Content", null, null, false);
                return;
            }
            if (!method.equals("GET") && !headOnly) {
                send(out, 405, "Method Not Allowed", "text/plain", "Read only".getBytes(StandardCharsets.UTF_8), false);
                return;
            }
            if (path.equals("/") || path.equals("/index.html")) {
                send(out, 200, "OK", "text/html; charset=utf-8", page, headOnly);
                return;
            }
            if (path.equals("/api/hello")) {
                send(out, 200, "OK", "application/json", "{\"app\":\"studyhub-share\",\"v\":1}".getBytes(StandardCharsets.UTF_8), headOnly);
                return;
            }
            if (path.equals("/favicon.ico")) {
                send(out, 404, "Not Found", null, null, headOnly);
                return;
            }

            // everything below needs the PIN
            if (bad.get() >= MAX_BAD) {
                json(out, 403, "Forbidden", "{\"error\":\"locked: too many wrong PINs\"}", headOnly);
                return;
            }
            String given = h.get("x-share-pin");
            if (given == null) given = qs.get("k");
            if (given == null || !MessageDigest.isEqual(given.trim().getBytes(StandardCharsets.UTF_8), pin.getBytes(StandardCharsets.UTF_8))) {
                int n = bad.incrementAndGet();
                listener.onEvent("badpin", ip, String.valueOf(n));
                json(out, 401, "Unauthorized", "{\"error\":\"wrong PIN\"}", headOnly);
                if (n >= MAX_BAD) {
                    listener.onEvent("locked", ip, "");
                    stop();
                }
                return;
            }
            if (path.equals("/api/manifest")) {
                listener.onEvent("open", ip, "");
                send(out, 200, "OK", "application/json; charset=utf-8", manifest, headOnly);
                return;
            }
            if (path.startsWith("/f/")) {
                String rest = path.substring(3);
                int slash = rest.indexOf('/');
                String token = slash >= 0 ? rest.substring(0, slash) : rest;
                Item it = items.get(token);
                File f = it == null ? null : new File(it.path);
                if (f == null || !f.isFile()) {
                    json(out, 404, "Not Found", "{\"error\":\"not shared\"}", headOnly);
                    return;
                }
                sendFile(out, ip, it, f, h.get("range"), "1".equals(qs.get("dl")), headOnly);
                return;
            }
            json(out, 404, "Not Found", "{\"error\":\"not found\"}", headOnly);
        } catch (IOException ignored) {
            // the other phone went away mid-way; nothing to do
        }
    }

    private void sendFile(OutputStream out, String ip, Item it, File f, String range, boolean attachment, boolean headOnly) throws IOException {
        long size = f.length(), from = 0, to = size - 1;
        boolean partial = false;
        if (range != null && range.startsWith("bytes=") && !range.contains(",")) {
            String[] r = range.substring(6).split("-", -1);
            try {
                if (!r[0].isEmpty()) {
                    from = Long.parseLong(r[0]);
                    if (r.length > 1 && !r[1].isEmpty()) to = Math.min(Long.parseLong(r[1]), size - 1);
                } else if (r.length > 1 && !r[1].isEmpty()) {
                    from = Math.max(0, size - Long.parseLong(r[1]));
                }
                partial = true;
            } catch (NumberFormatException ignored) {
                from = 0;
                to = size - 1;
            }
            if (partial && (from > to || from >= size)) {
                StringBuilder sb = new StringBuilder("HTTP/1.1 416 Range Not Satisfiable\r\n");
                sb.append("Content-Range: bytes */").append(size).append("\r\n");
                commonHeaders(sb);
                sb.append("Content-Length: 0\r\n\r\n");
                out.write(sb.toString().getBytes(StandardCharsets.ISO_8859_1));
                return;
            }
        }
        long len = size == 0 ? 0 : to - from + 1;
        StringBuilder sb = new StringBuilder(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
        commonHeaders(sb);
        sb.append("Content-Type: ").append(it.type).append("\r\n");
        sb.append("Content-Length: ").append(len).append("\r\n");
        sb.append("Accept-Ranges: bytes\r\n");
        if (partial) sb.append("Content-Range: bytes ").append(from).append('-').append(to).append('/').append(size).append("\r\n");
        String enc = URLEncoder.encode(it.name, "UTF-8").replace("+", "%20");
        sb.append("Content-Disposition: ").append(attachment ? "attachment" : "inline").append("; filename*=UTF-8''").append(enc).append("\r\n\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.ISO_8859_1));
        if (headOnly) return;
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            raf.seek(from);
            byte[] buf = new byte[64 * 1024];
            long left = len;
            while (left > 0 && running) {
                int n = raf.read(buf, 0, (int) Math.min(buf.length, left));
                if (n < 0) break;
                out.write(buf, 0, n);
                left -= n;
                lastActivity = System.currentTimeMillis();
            }
            out.flush();
            if (left == 0 && to == size - 1) listener.onEvent("sent", ip, it.name);
        }
    }

    private static void commonHeaders(StringBuilder sb) {
        // the friend's StudyHub app runs at https://localhost and fetches cross-origin
        sb.append("Access-Control-Allow-Origin: *\r\n");
        sb.append("Access-Control-Allow-Headers: X-Share-Pin, Range\r\n");
        sb.append("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n");
        sb.append("Access-Control-Allow-Private-Network: true\r\n");
        sb.append("Access-Control-Expose-Headers: Content-Length, Content-Range\r\n");
        sb.append("Cache-Control: no-store\r\n");
        sb.append("Connection: close\r\n");
    }

    private static void json(OutputStream out, int code, String text, String body, boolean headOnly) throws IOException {
        send(out, code, text, "application/json", body.getBytes(StandardCharsets.UTF_8), headOnly);
    }

    private static void send(OutputStream out, int code, String text, String type, byte[] body, boolean headOnly) throws IOException {
        StringBuilder sb = new StringBuilder("HTTP/1.1 ").append(code).append(' ').append(text).append("\r\n");
        commonHeaders(sb);
        if (type != null) sb.append("Content-Type: ").append(type).append("\r\n");
        sb.append("Content-Length: ").append(body == null ? 0 : body.length).append("\r\n\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.ISO_8859_1));
        if (body != null && !headOnly) out.write(body);
        out.flush();
    }

    /** The request line and headers, up to the blank line (max 16 KB). */
    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int state = 0, c;
        while ((c = in.read()) != -1) {
            b.write(c);
            if (b.size() > 16384) return null;
            state = (c == '\r' && (state == 0 || state == 2)) ? state + 1
                    : (c == '\n' && (state == 1 || state == 3)) ? state + 1 : 0;
            if (state == 4) return b.toString("ISO-8859-1");
        }
        return null;
    }

    private static Map<String, String> parseQuery(String q) {
        Map<String, String> m = new HashMap<>();
        for (String part : q.split("&")) {
            if (part.isEmpty()) continue;
            int e = part.indexOf('=');
            try {
                String k = URLDecoder.decode(e < 0 ? part : part.substring(0, e), "UTF-8");
                String v = e < 0 ? "" : URLDecoder.decode(part.substring(e + 1), "UTF-8");
                m.put(k, v);
            } catch (IllegalArgumentException | java.io.UnsupportedEncodingException ignored) {
            }
        }
        return m;
    }

    // ------------------------------------------------------------------ addresses
    /** This phone's addresses friends can reach: Wi-Fi and hotspot first, VPN (e.g. Tailscale)
     * last, mobile data never. Each entry is {address, interface name}. */
    public static List<String[]> addresses() {
        List<String[]> wifi = new ArrayList<>(), other = new ArrayList<>(), vpn = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                String n = ni.getName().toLowerCase(Locale.ROOT);
                if (n.startsWith("rmnet") || n.startsWith("ccmni") || n.startsWith("dummy") || n.startsWith("r_rmnet") || n.startsWith("v4-rmnet")) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress() || a.isLinkLocalAddress()) continue;
                    String[] e = {a.getHostAddress(), ni.getName()};
                    if (n.startsWith("wlan") || n.startsWith("swlan") || n.startsWith("ap") || n.startsWith("softap") || n.startsWith("eth")) wifi.add(e);
                    else if (n.startsWith("tun") || n.startsWith("tailscale") || n.startsWith("wg")) vpn.add(e);
                    else if (a.isSiteLocalAddress()) other.add(e);
                }
            }
        } catch (IOException ignored) {
        }
        // a hotspot's own address (x.x.x.1) is the one friends who joined it need: put it first
        wifi.sort((x, y) -> Boolean.compare(!x[0].endsWith(".1"), !y[0].endsWith(".1")));
        List<String[]> all = new ArrayList<>(wifi);
        all.addAll(other);
        all.addAll(vpn);
        return all;
    }
}
