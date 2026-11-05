#!/usr/bin/env python3
"""StudyHub server: serves the app AND acts as the sync hub between your devices.

  * Serves www/ with `Cache-Control: no-cache` (phones always get the newest files).
  * /StudyHub.apk : the Android app, for installing over Wi-Fi.
  * /sync/...     : sync hub. Phone app, phone browser and laptop browser all sync here,
                    so a change made anywhere shows up everywhere. The hub's copy lives in
                    sync-data/ (also a handy backup of everything).
  * /sync/ai     : AI flashcards from your unit notes (cardgen.py, Google Gemini).
  * /sync/exams  : practice exams written and marked by Gemini (exams.py).
  * /sync/pdf/ID : slides and Word files converted to PDF (LibreOffice) for the phone's viewer.
  * /sync/ask    : Ask AI for phones without their own Gemini key (askai.py).
  * Backups      : daily snapshots of sync-data/ in ~/StudyHub-backups (backup.py).
  * Other devices need the 6-character pairing code (printed below and shown in the
    laptop's StudyHub → Sync). Requests made by the laptop's own browser don't.

Usage:  python3 serve.py [--phone] [--port 8000] [--data DIR]
"""
import argparse
import http.server
import json
import os
import re
import secrets
import socket
import sys
import tempfile
import threading
import time

import askai
import backup
import cardgen
import exams
import officeconv

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, 'www')
APK = os.path.join(HERE, 'dist', 'StudyHub.apk')
SYNC_STORES = {'deadlines', 'cards', 'notes', 'classes', 'occurrences', 'files', 'exams'}
SAFE_ID = re.compile(r'^[A-Za-z0-9_.@:-]{1,120}$')
MAX_JSON = 64 * 1024 * 1024        # one sync request
MAX_BLOB = 512 * 1024 * 1024       # one file


class SyncHub:
    """Last-writer-wins store keyed by "store:id". Every accepted change gets a new sequence
    number, so a device can ask for "everything after seq N"."""

    def __init__(self, folder):
        self.dir = folder
        self.blob_dir = os.path.join(folder, 'blobs')
        os.makedirs(self.blob_dir, exist_ok=True)
        self.lock = threading.Lock()
        self.db_path = os.path.join(folder, 'db.json')
        self.db = {'seq': 0, 'items': {}}
        if os.path.exists(self.db_path):
            with open(self.db_path, encoding='utf-8') as f:
                self.db = json.load(f)
        self.key = self._read_or_make('pairing-code', lambda: ''.join(secrets.choice('ABCDEFGHJKMNPQRSTUVWXYZ23456789') for _ in range(6)))
        self.server_id = self._read_or_make('hub-id', lambda: secrets.token_hex(8))

    def _read_or_make(self, name, make):
        p = os.path.join(self.dir, name)
        if not os.path.exists(p):
            with open(p, 'w') as f:
                f.write(make())
        with open(p) as f:
            return f.read().strip()

    def _save(self):
        fd, tmp = tempfile.mkstemp(dir=self.dir, suffix='.tmp')
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(self.db, f, ensure_ascii=False)
        os.replace(tmp, self.db_path)

    def blob_path(self, rid):
        return os.path.join(self.blob_dir, rid.replace(':', '_'))

    def merge(self, since, changes):
        with self.lock:
            accepted = 0
            items = self.db['items']
            for c in changes:
                store, rid = c.get('store'), c.get('id')
                if store not in SYNC_STORES or not isinstance(rid, str) or not SAFE_ID.match(rid):
                    continue
                upd = c.get('updated')
                if not isinstance(upd, (int, float)):
                    continue
                key = f'{store}:{rid}'
                cur = items.get(key)
                if cur and cur['updated'] >= upd:
                    continue  # hub already has this or a newer version
                self.db['seq'] += 1
                deleted = bool(c.get('deleted'))
                items[key] = {'store': store, 'id': rid, 'updated': upd, 'deleted': deleted,
                              'rec': None if deleted else c.get('rec'), 'seq': self.db['seq']}
                if deleted and store == 'files' and os.path.exists(self.blob_path(rid)):
                    os.remove(self.blob_path(rid))
                accepted += 1
            if accepted:
                self._save()
            out = [{k: v[k] for k in ('store', 'id', 'updated', 'deleted', 'rec')}
                   for v in items.values() if v['seq'] > since]
            need = [v['id'] for v in items.values()
                    if v['store'] == 'files' and not v['deleted'] and not os.path.exists(self.blob_path(v['id']))]
            return accepted, {'seq': self.db['seq'], 'changes': out, 'needBlobs': need}

    def add_local(self, store, rid, rec):
        """Add a record made on the laptop itself (AI flashcards). Never overwrites: if the id
        exists, even as a deletion, it's skipped, so a card deleted on the phone stays deleted."""
        with self.lock:
            key = f'{store}:{rid}'
            if key in self.db['items']:
                return False
            self.db['seq'] += 1
            self.db['items'][key] = {'store': store, 'id': rid, 'updated': int(time.time() * 1000),
                                     'deleted': False, 'rec': rec, 'seq': self.db['seq']}
            self._save()
            return True

    def file_record(self, rid):
        v = self.db['items'].get(f'files:{rid}')
        return None if not v or v['deleted'] else v['rec']


HUB = None  # set in main()
GEN = None  # cardgen.CardGen, set in main()
BACKUP = None  # backup.AutoBackup, set in main()
EXAMS = None  # exams.Exams, set in main()


class Handler(http.server.SimpleHTTPRequestHandler):
    root = ROOT
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.json': 'application/json',
        '.webmanifest': 'application/manifest+json',
        '.svg': 'image/svg+xml',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=self.root, **kwargs)

    # ---------- helpers ----------
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        if self.path.startswith('/sync'):
            # the Android app runs at https://localhost and talks to this server cross-origin
            self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin') or '*')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Sync-Key')
            self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, OPTIONS')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Vary', 'Origin')
        super().end_headers()

    def is_own_laptop(self):
        """The laptop's own browser on this server's page: trusted without the code.
        A request from another website (even on this laptop) carries a foreign Origin and isn't."""
        if self.client_address[0] not in ('127.0.0.1', '::1'):
            return False
        origin = self.headers.get('Origin')
        port = self.server.server_address[1]
        return origin in (None, f'http://localhost:{port}', f'http://127.0.0.1:{port}')

    def authorised(self):
        return self.is_own_laptop() or secrets.compare_digest(
            (self.headers.get('X-Sync-Key') or '').strip().upper(), HUB.key)

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def blob_id(self):
        rid = self.path.split('?')[0][len('/sync/blob/'):]
        rid = re.sub(r'%([0-9A-Fa-f]{2})', lambda m: chr(int(m.group(1), 16)), rid)
        return rid if SAFE_ID.match(rid) and '..' not in rid else None

    # ---------- routes ----------
    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_HEAD(self):
        # "does the laptop have this file's contents?" (asked before a device removes its own copy)
        if self.path.startswith('/sync/blob/'):
            if not self.authorised():
                self.send_response(401)
                self.end_headers()
                return
            rid = self.blob_id()
            p = rid and HUB.file_record(rid) is not None and HUB.blob_path(rid)
            if not p or not os.path.exists(p):
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header('Content-Length', str(os.path.getsize(p)))
            self.end_headers()
            return
        super().do_HEAD()

    def do_GET(self):
        path = self.path.split('?')[0]
        if path.lower() in ('/studyhub.apk', '/apk'):
            return self.send_apk()
        if path == '/sync/info':
            if not self.authorised():
                return self.send_json({'error': 'wrong pairing code'}, 401)
            port = self.server.server_address[1]
            ip = lan_ip()
            info = {'ok': True, 'hubId': HUB.server_id, 'name': socket.gethostname(),
                    'address': f'{ip}:{port}' if ip else None,
                    'reachableFromPhone': self.server.server_address[0] == '0.0.0.0',
                    'stores': sorted(SYNC_STORES), 'seq': HUB.db['seq']}
            if self.is_own_laptop():
                info['code'] = HUB.key
                info['backup'] = BACKUP.status()
            return self.send_json(info)
        if path == '/sync/exams' or path.startswith('/sync/exams/'):
            if not self.authorised():
                return self.send_json({'error': 'wrong pairing code'}, 401)
            if path == '/sync/exams':
                return self.send_json(EXAMS.listing())
            e = EXAMS.get(path.rsplit('/', 1)[1])
            if not e:
                return self.send_json({'error': 'not found'}, 404)
            if e['status'] != 'marked':   # no peeking at the model answers before marking
                e['questions'] = [{k: v for k, v in q.items() if k not in ('answer', 'points')} for q in e['questions']]
            return self.send_json(e)
        if path == '/sync/ai':
            if not self.authorised():
                return self.send_json({'error': 'wrong pairing code'}, 401)
            return self.send_json(GEN.status())
        if path.startswith('/sync/pdf/'):
            # a slide deck / Word file as PDF, for the in-app viewer
            if not self.authorised():
                return self.send_json({'error': 'wrong pairing code'}, 401)
            rid = path[len('/sync/pdf/'):]
            rec = HUB.file_record(rid) if SAFE_ID.match(rid) else None
            if not rec or not officeconv.is_office(rec):
                return self.send_json({'error': 'not a slides or Word file on the laptop'}, 404)
            try:
                pdf = officeconv.pdf_for(HUB, rec)
            except RuntimeError as e:
                return self.send_json({'error': str(e)}, 409)
            self.send_response(200)
            self.send_header('Content-Type', 'application/pdf')
            self.send_header('Content-Length', str(os.path.getsize(pdf)))
            self.end_headers()
            with open(pdf, 'rb') as f:
                while chunk := f.read(1 << 16):
                    self.wfile.write(chunk)
            return
        if path.startswith('/sync/blob/'):
            if not self.authorised():
                return self.send_json({'error': 'wrong pairing code'}, 401)
            rid = self.blob_id()
            p = rid and HUB.blob_path(rid)
            if not p or not os.path.exists(p):
                return self.send_json({'error': 'not found'}, 404)
            rec = HUB.file_record(rid) or {}
            self.send_response(200)
            self.send_header('Content-Type', rec.get('type') or 'application/octet-stream')
            self.send_header('Content-Length', str(os.path.getsize(p)))
            self.end_headers()
            with open(p, 'rb') as f:
                while chunk := f.read(1 << 16):
                    self.wfile.write(chunk)
            return
        super().do_GET()

    def do_POST(self):
        if self.path == '/sync':
            if not self.authorised():
                return self.send_json({'error': 'wrong pairing code'}, 401)
            n = int(self.headers.get('Content-Length', 0))
            if n > MAX_JSON:
                return self.send_json({'error': 'too large'}, 413)
            try:
                body = json.loads(self.rfile.read(n) or b'{}')
                accepted, result = HUB.merge(int(body.get('since', 0)), body.get('changes') or [])
            except (ValueError, TypeError, AttributeError) as e:
                return self.send_json({'error': f'bad request: {e}'}, 400)
            if accepted or len(result['changes']):
                sys.stderr.write(f"🔄 {self.client_address[0]} synced: {accepted} in, {len(result['changes'])} out\n")
            return self.send_json(result)
        if self.path == '/sync/ai/generate':
            if not self.authorised():
                return self.send_json({'error': 'wrong pairing code'}, 401)
            try:
                body = json.loads(self.rfile.read(min(int(self.headers.get('Content-Length', 0)), 10000)) or b'{}')
            except ValueError:
                body = {}
            if not GEN.api_key():
                return self.send_json({'error': 'No Gemini API key on the laptop (sync-data/gemini-key)'}, 409)
            GEN.request(body.get('course') or None)
            return self.send_json(GEN.status())
        if self.path == '/sync/ask':
            if not self.authorised():
                return self.send_json({'error': 'wrong pairing code'}, 401)
            n = int(self.headers.get('Content-Length', 0))
            if n > MAX_JSON:
                return self.send_json({'error': 'too large'}, 413)
            try:
                body = json.loads(self.rfile.read(n) or b'{}')
                return self.send_json(askai.ask(GEN, str(body.get('system', ''))[:4000], body.get('contents')))
            except ValueError:
                return self.send_json({'error': 'bad request'}, 400)
            except cardgen.GeminiError as e:
                return self.send_json({'error': str(e)}, 409 if e.code == 409 else 502)
        if self.path.startswith('/sync/exams/'):
            if not self.authorised():
                return self.send_json({'error': 'wrong pairing code'}, 401)
            n = int(self.headers.get('Content-Length', 0))
            if n > MAX_JSON:
                return self.send_json({'error': 'too large'}, 413)
            try:
                body = json.loads(self.rfile.read(n) or b'{}')
            except ValueError:
                return self.send_json({'error': 'bad request'}, 400)
            bits = self.path.split('?')[0].split('/')[3:]   # ['new'] or [id, 'submit'|'delete']
            try:
                if bits == ['new']:
                    if not GEN.api_key():
                        return self.send_json({'error': 'No Gemini API key on the laptop'}, 409)
                    return self.send_json(EXAMS.new(str(body.get('course', '')), str(body.get('size', 'cat')), body.get('fileId') or None))
                if len(bits) == 2 and bits[1] == 'submit':
                    e = EXAMS.submit(bits[0], body.get('answers') or {})
                    return self.send_json({'ok': True, 'status': e['status']})
                if len(bits) == 2 and bits[1] == 'delete':
                    return self.send_json({'ok': EXAMS.delete(bits[0])})
            except ValueError as e:
                return self.send_json({'error': str(e)}, 400)
            return self.send_json({'error': 'not found'}, 404)
        if self.path == '/__diag':
            return self.diag()
        self.send_error(405)

    def do_PUT(self):
        if not self.path.startswith('/sync/blob/'):
            return self.send_error(405)
        if not self.authorised():
            return self.send_json({'error': 'wrong pairing code'}, 401)
        rid = self.blob_id()
        n = int(self.headers.get('Content-Length', 0))
        if not rid or HUB.file_record(rid) is None:
            return self.send_json({'error': 'unknown file'}, 404)
        if n > MAX_BLOB:
            return self.send_json({'error': 'file too large'}, 413)
        fd, tmp = tempfile.mkstemp(dir=HUB.blob_dir, suffix='.part')
        with os.fdopen(fd, 'wb') as f:
            left = n
            while left > 0:
                chunk = self.rfile.read(min(left, 1 << 16))
                if not chunk:
                    break
                f.write(chunk)
                left -= len(chunk)
        if left:
            os.remove(tmp)
            return self.send_json({'error': 'upload interrupted'}, 400)
        os.replace(tmp, HUB.blob_path(rid))
        self.send_json({'ok': True})

    def send_apk(self):
        if not os.path.exists(APK):
            return self.send_error(404, 'No APK built yet: run ./build-android.sh')
        self.send_response(200)
        self.send_header('Content-Type', 'application/vnd.android.package-archive')
        self.send_header('Content-Disposition', 'attachment; filename="StudyHub.apk"')
        self.send_header('Content-Length', str(os.path.getsize(APK)))
        self.end_headers()
        with open(APK, 'rb') as f:
            while chunk := f.read(1 << 16):
                self.wfile.write(chunk)

    def diag(self):
        # Error / browser reports from the safety net in index.html
        try:
            n = min(int(self.headers.get('Content-Length', 0)), 20000)
            d = json.loads(self.rfile.read(n) or b'{}')
        except (ValueError, OSError):
            d = {}
        self.send_response(204)
        self.end_headers()
        who = self.client_address[0]
        if d.get('kind') == 'hello':
            sys.stderr.write(f"\n📱 {who} opened StudyHub  [{d.get('screen')}]\n   browser: {d.get('ua')}\n   support: {d.get('msg')}\n")
        else:
            sys.stderr.write(f"\n❌ {who} {d.get('kind', 'error').upper()}: {d.get('msg')}\n   browser: {d.get('ua')}\n")

    def log_message(self, fmt, *args):
        # one short line per page request; sync traffic is summarised in do_POST instead
        if len(args) >= 2 and isinstance(args[0], str) and args[0].startswith(('GET', 'HEAD')) and ' /sync' not in args[0]:
            sys.stderr.write(f"{self.client_address[0]:<15} {args[0].split(' HTTP')[0]} {args[1]}\n")


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError, TimeoutError)):
            return  # phone browsers close spare connections; nothing is wrong
        super().handle_error(request, client_address)


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))  # no packet is sent; just picks the outgoing interface
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def main():
    global HUB, GEN, BACKUP, EXAMS
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--phone', action='store_true', help='also reachable from other devices on your Wi-Fi')
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--data', default=os.path.join(HERE, 'sync-data'), help='where the sync hub keeps its copy')
    ap.add_argument('--root', default=ROOT, help=argparse.SUPPRESS)  # for tests
    args = ap.parse_args()
    Handler.root = args.root

    HUB = SyncHub(args.data)
    GEN = cardgen.CardGen(HUB)
    GEN.start()
    EXAMS = exams.Exams(GEN)
    BACKUP = backup.AutoBackup(HUB)
    BACKUP.start()
    host = '0.0.0.0' if args.phone else '127.0.0.1'
    try:
        httpd = Server((host, args.port), Handler)
    except OSError as e:
        sys.exit(f"Port {args.port} is busy ({e.strerror}). Is StudyHub already running? Try --port 8001")

    ip = lan_ip()
    print(f"StudyHub on this laptop:  http://localhost:{args.port}/")
    if args.phone:
        print(f"StudyHub on your phone:   http://{ip or '<laptop-ip>'}:{args.port}/   (same Wi-Fi)")
        if os.path.exists(APK):
            print(f"Android app download:     http://{ip or '<laptop-ip>'}:{args.port}/StudyHub.apk")
        print(f"\n🔄 Sync: in the phone app, ☰ → Sync with laptop, enter")
        print(f"     address  {ip or '<laptop-ip>'}:{args.port}")
        print(f"     code     {HUB.key}")
    else:
        print("   (Sync with your phone needs:  ./run.sh phone)")
    print(f"\n✨ AI flashcards: {'on (Gemini), weekly per unit' if GEN.api_key() else 'off (no key in sync-data/gemini-key)'}")
    print(f"💾 Backups: daily snapshots in {backup.DEST}  (python3 backup.py to list)")
    print("\nCtrl+C to stop.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == '__main__':
    main()
