"""AI flashcards from your unit notes, made on the laptop with Google Gemini.

Run by serve.py: once a week per unit (catching up whenever the laptop has been off),
or straight away when you tap ✨ Generate in the app. New cards go into the sync hub,
so the phone gets them on its next sync, like anything else.

  * Unit notes = synced files filed as "Lecture notes" or "Books" that have a unit
    (course) set, e.g. COMP 226. PDFs, images and text files; scanned PDFs work too.
  * Each unit gets its own deck, "COMP 226 · Assembly Language Programming".
  * Card ids come from the question text, so a card is never added twice, and a card
    you deleted on the phone never comes back.
  * Gemini is told which questions the unit already has, so each week covers new ground.

The API key is read from sync-data/gemini-key, which holds the key or the path of a
file holding it (or from the GEMINI_API_KEY environment variable). It stays on the laptop and is never sent to the phone.
State and history: sync-data/cardgen.json.
"""
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

import officeconv

API = 'https://generativelanguage.googleapis.com'
DEFAULT_MODEL = 'gemini-3.8-flash'   # Google retired 2.5 for new keys; see _ask for fallbacks
NOTE_CATEGORIES = {'Lecture notes', 'Books', 'Slides'}   # slides/Word files are read as PDFs (officeconv.py)
CARDS_PER_WEEK = 12          # new cards per unit per batch
WEEK = 7 * 24 * 3600
RETRY_AFTER_ERROR = 3600     # a unit that failed is tried again after an hour
RETRY_AFTER_BUSY = 20 * 60   # ...or after 20 min if Gemini was only overloaded
# Each batch reads the NEXT slice of the unit's notes, not the whole lot: a 258-page book sent
# every time burned through the free daily quota after two units. Slices keep a request small
# (~5-20k tokens) and walk through the notes week by week, starting over once all are covered.
TEXT_PAGES = 25              # pages per batch from PDFs with real text (sent as plain text)
SCAN_PAGES = 12              # pages per batch from scanned PDFs (sent as page images)
MAX_TEXT = 60_000            # characters of text per batch
UNIT_GAP = 90                # seconds between units in the weekly run (per-minute limits)
SUPPORTED = re.compile(r'^(application/pdf|image/(png|jpeg|webp|heic|heif)|text/.+)$')


def _norm(s):
    return re.sub(r'[^a-z0-9]', '', str(s or '').lower())


def _read(path):
    try:
        with open(path, encoding='utf-8') as f:
            return f.read().strip()
    except OSError:
        return ''


def _pick_key(text):
    """The key from a file that may hold just the key, or several labelled lines."""
    if not text:
        return ''
    m = re.search(r'AIza[0-9A-Za-z_-]{35}', text)          # classic Google API key
    if m:
        return m.group(0)
    # other services' keys can share the file: never mistake them for the Gemini key
    lines = [l.strip() for l in text.splitlines()
             if l.strip() and not re.search(r'gsk_|xai-|sk-|groq|openrouter|grok', l, re.I)]
    if not lines:
        return ''
    gem = [l for l in lines if 'gemini' in l.lower()] or lines
    tok = re.split(r'[\s:=]+', gem[0].strip().strip('"\''))
    return max(tok, key=len).strip('"\'') if tok else ''


def _run_tool(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=300).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ''


CARD_SCHEMA = {'type': 'ARRAY', 'items': {'type': 'OBJECT', 'properties': {
    'front': {'type': 'STRING'}, 'back': {'type': 'STRING'},
    'topic': {'type': 'STRING'}, 'file': {'type': 'STRING'}}, 'required': ['front', 'back']}}


def _log(msg):
    sys.stderr.write(f'✨ {msg}\n')


class GeminiError(Exception):
    def __init__(self, msg, code=None, retry=None):
        super().__init__(msg)
        self.code, self.retry = code, retry


class CardGen:
    def __init__(self, hub):
        self.hub = hub
        self.path = os.path.join(hub.dir, 'cardgen.json')
        self.lock = threading.Lock()          # one batch at a time
        self.wake = threading.Event()
        self.queue = []                       # units asked for from the app
        self.current = None
        self.last_model = None
        self.state = {'model': DEFAULT_MODEL, 'units': {}, 'history': [], 'exhausted': {}}
        if os.path.exists(self.path):
            try:
                with open(self.path, encoding='utf-8') as f:
                    self.state.update(json.load(f))
            except (OSError, ValueError):
                pass

    # ------------------------------------------------------------------ state
    def _save(self):
        tmp = self.path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(self.state, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)

    def key_text(self):
        """The key file's text (sync-data/gemini-key, or the file it points to)."""
        text = _read(os.path.join(self.hub.dir, 'gemini-key'))
        if text.startswith(('/', '~')):
            text = _read(os.path.expanduser(text.splitlines()[0].strip()))
        return text

    def groq_key(self):
        """GROQ_API_KEY, else a gsk_… key in the same key file (optional: faster Ask AI)."""
        k = os.environ.get('GROQ_API_KEY', '').strip()
        if k:
            return k
        m = re.search(r'gsk_[A-Za-z0-9]{20,}', self.key_text())
        return m.group(0) if m else ''

    def api_key(self):
        """GEMINI_API_KEY, else sync-data/gemini-key, which holds either the key itself or the
        path of a file that does (so the key can live outside the project, e.g. ~/confidKeys/)."""
        k = os.environ.get('GEMINI_API_KEY', '').strip()
        if k:
            return k
        text = _read(os.path.join(self.hub.dir, 'gemini-key'))
        if text.startswith(('/', '~')):
            text = _read(os.path.expanduser(text.splitlines()[0].strip()))
        return _pick_key(text)

    # ------------------------------------------------------------------ what's in the hub
    def _live(self, store):
        with self.hub.lock:  # the hub's dict changes while phones sync
            return [v['rec'] for v in self.hub.db['items'].values()
                    if v['store'] == store and not v['deleted'] and v.get('rec')]

    def units(self):
        """{course: {'deck': ..., 'files': [file records]}} for every unit that has notes."""
        titles = {}
        for c in self._live('classes'):
            if c.get('course') and c.get('title'):
                titles.setdefault(_norm(c['course']), c['title'])
        out = {}
        for f in self._live('files'):
            course = (f.get('course') or '').strip()
            if not course or f.get('category') not in NOTE_CATEGORIES:
                continue
            if not (SUPPORTED.match(f.get('type') or '') or officeconv.is_office(f)) or not os.path.exists(self.hub.blob_path(f['id'])):
                continue
            u = out.setdefault(course, {'files': []})
            u['files'].append(f)
        for course, u in out.items():
            t = titles.get(_norm(course))
            u['deck'] = f'{course} · {t}' if t else course
        return out

    def _unit_cards(self, course, deck):
        return [c for c in self._live('cards')
                if _norm(c.get('course')) == _norm(course) or c.get('deck') == deck]

    def status(self):
        units = self.units()
        now = time.time()
        rows = []
        for course in sorted(units):
            u, st = units[course], self.state['units'].get(course, {})
            last = st.get('lastRun', 0)
            cards = self._unit_cards(course, u['deck'])
            rows.append({
                'course': course, 'deck': u['deck'],
                'files': [f['name'] for f in u['files']],
                'aiCards': sum(1 for c in cards if c.get('source') == 'ai'),
                'lastRun': int(last * 1000) or None,
                'lastAdded': st.get('lastAdded', 0),
                'nextRun': int(max(last + WEEK, st.get('retryAt', 0), now) * 1000),
                'error': st.get('error') or '',
                'model': st.get('model') or '',
            })
        return {'ok': True, 'keyPresent': bool(self.api_key()), 'model': self.state.get('model'),
                'running': self.current, 'queued': list(self.queue), 'units': rows,
                'perWeek': CARDS_PER_WEEK, 'history': self.state['history'][-10:]}

    # ------------------------------------------------------------------ scheduling
    def request(self, course=None):
        """From the app: generate now for one unit (or all units)."""
        targets = [course] if course else sorted(self.units())
        for c in targets:
            if c and c not in self.queue and c != self.current:
                self.queue.append(c)
        self.wake.set()

    def start(self):
        threading.Thread(target=self._loop, name='cardgen', daemon=True).start()

    def _due_units(self):
        now = time.time()
        due = []
        for course in sorted(self.units()):
            st = self.state['units'].get(course, {})
            if now >= st.get('lastRun', 0) + WEEK and now >= st.get('retryAt', 0):
                due.append(course)
        return due

    def _loop(self):
        time.sleep(20)  # let the server start and phones sync first
        while True:
            try:
                if self.api_key():
                    # units asked for in the app first, then any whose week is up.
                    # _run moves lastRun/retryAt forward, so each unit runs once per pass.
                    while True:
                        course = self.queue[0] if self.queue else next(iter(self._due_units()), None)
                        if not course:
                            break
                        self._run(course)
                        if not self.queue:
                            self.wake.wait(UNIT_GAP)
                            self.wake.clear()
                else:
                    self.queue.clear()
            except Exception as e:  # never let the background thread die
                _log(f'scheduler error: {e}')
            self.wake.wait(3600)   # check again hourly, or when the app asks
            self.wake.clear()

    # ------------------------------------------------------------------ one unit
    def _run(self, course):
        with self.lock:
            if course in self.queue:
                self.queue.remove(course)
            unit = self.units().get(course)
            if not unit:
                return
            self.current = course
            st = self.state['units'].setdefault(course, {})
            try:
                added = self._generate(course, unit, st)
                st.update(lastRun=time.time(), lastAdded=added, error='', retryAt=0, model=self.last_model)
                self.state['history'].append({'t': int(time.time() * 1000), 'course': course, 'added': added})
                self.state['history'] = self.state['history'][-50:]
                _log(f'{course}: {added} new card{"" if added == 1 else "s"}')
            except GeminiError as e:
                busy = e.code in (500, 502, 503, 504, 'timeout')
                wait = e.retry or (RETRY_AFTER_BUSY if busy else RETRY_AFTER_ERROR)
                st.update(error=str(e), retryAt=time.time() + min(wait, 6 * 3600))
                _log(f'{course}: {e}')
            except Exception as e:
                st.update(error=f'{type(e).__name__}: {e}', retryAt=time.time() + RETRY_AFTER_ERROR)
                _log(f'{course}: {type(e).__name__}: {e}')
            finally:
                self.current = None
                self._save()

    # ------------------------------------------------------------------ slices of notes
    @staticmethod
    def _pdfish(f):
        return f.get('type') == 'application/pdf' or officeconv.is_office(f)

    def _as_pdf(self, f):
        """The file as a PDF on disk: itself, or a LibreOffice conversion of slides / Word files."""
        if f.get('type') == 'application/pdf':
            return self.hub.blob_path(f['id'])
        try:
            return officeconv.pdf_for(self.hub, f)
        except RuntimeError as e:
            raise GeminiError(f"{f['name']}: {e}") from None

    def _pages(self, f):
        if not self._pdfish(f):
            return 1
        out = _run_tool(['pdfinfo', self._as_pdf(f)])
        m = re.search(r'^Pages:\s+(\d+)', out, re.M)
        return int(m.group(1)) if m else 1

    def _is_scan(self, f, st):
        """PDF pages that are only pictures (phone scans, handwritten notes)."""
        kinds = st.setdefault('scan', {})
        if f['id'] not in kinds:
            text = _run_tool(['pdftotext', '-l', '6', self._as_pdf(f), '-'])
            kinds[f['id']] = len(text.split()) < 6 * 40
        return kinds[f['id']]

    def _pick_slices(self, unit, st):
        """The next unread pages, from the least-covered notes first: [(file, first, last, pages)]."""
        pos = st.setdefault('pos', {})
        info = [(f, self._pages(f)) for f in unit['files']]
        if all(pos.get(f['id'], 1) > n for f, n in info):
            pos.clear()   # every page covered: start a fresh pass (new questions, since old ones are listed)
        info.sort(key=lambda x: (pos.get(x[0]['id'], 1) / x[1], -(x[0].get('added') or 0)))
        out, budget = [], None
        for f, n in info:
            a = pos.get(f['id'], 1)
            if a > n:
                continue
            step = SCAN_PAGES if self._pdfish(f) and self._is_scan(f, st) else TEXT_PAGES
            budget = step if budget is None else budget
            if budget <= 0 or (out and step != out[0][3]):
                break
            b = min(n, a + budget - 1)
            out.append((f, a, b, step))
            budget -= b - a + 1
        return out

    def _slice_parts(self, f, a, b, st):
        path, mime = self.hub.blob_path(f['id']), f.get('type') or ''
        if self._pdfish(f):
            path, mime = self._as_pdf(f), 'application/pdf'
        unit = 'slides' if (f.get('ext') or '').lower() in officeconv.SLIDE_EXT else 'pages'
        label = f"{f['name']}, {unit} {a}-{b}" if mime == 'application/pdf' else f['name']
        if mime.startswith('image/'):
            with open(path, 'rb') as fh:
                return label, [{'text': f'--- {label} ---'}, {'inline_data': {'mime_type': mime, 'data': base64.b64encode(fh.read()).decode()}}]
        if mime.startswith('text/'):
            return label, [{'text': f'--- {label} ---\n{_read(path)[:MAX_TEXT]}'}]
        if not self._is_scan(f, st):
            text = _run_tool(['pdftotext', '-f', str(a), '-l', str(b), path, '-'])
            return label, [{'text': f'--- {label} ---\n{re.sub(r"[ \t]+", " ", text)[:MAX_TEXT]}'}]
        parts = [{'text': f'--- {label} (scanned pages) ---'}]
        with tempfile.TemporaryDirectory() as d:
            _run_tool(['pdftoppm', '-r', '100', '-jpeg', '-jpegopt', 'quality=70', '-f', str(a), '-l', str(b), path, os.path.join(d, 'p')])
            for name in sorted(os.listdir(d)):
                with open(os.path.join(d, name), 'rb') as fh:
                    parts.append({'inline_data': {'mime_type': 'image/jpeg', 'data': base64.b64encode(fh.read()).decode()}})
        return label, parts

    def _generate(self, course, unit, st):
        key = self.api_key()
        slices = self._pick_slices(unit, st)
        if not slices:
            return 0
        parts, labels = [], []
        for f, a, b, _ in slices:
            label, p = self._slice_parts(f, a, b, st)
            labels.append(label)
            parts += p
        existing = [c.get('front', '') for c in self._unit_cards(course, unit['deck'])]
        parts.append({'text': self._prompt(course, unit['deck'], labels, existing)})
        cards = self._ask(key, parts)

        added, now = 0, int(time.time() * 1000)
        seen = {_norm(q) for q in existing}
        for c in cards:
            front, back = str(c.get('front', '')).strip(), str(c.get('back', '')).strip()
            if not front or not back or _norm(front) in seen:
                continue
            seen.add(_norm(front))
            rid = 'ai-' + hashlib.sha1(f'{_norm(course)}|{_norm(front)}'.encode()).hexdigest()[:24]
            rec = {'id': rid, 'deck': unit['deck'], 'front': front, 'back': back,
                   'created': now, 'due': now, 'interval': 0, 'ease': 2.5, 'reps': 0, 'lapses': 0,
                   'source': 'ai', 'course': course, 'topic': str(c.get('topic', ''))[:80],
                   'from': str(c.get('file', '') or labels[0])[:120]}
            if self.hub.add_local('cards', rid, rec):
                added += 1
        for f, a, b, _ in slices:   # only move on once the batch has worked
            st['pos'][f['id']] = b + 1
        return added

    def _prompt(self, course, deck, labels, existing):
        have = '\n'.join(f'- {q[:160]}' for q in existing[-150:]) or '(none yet)'
        names = '; '.join(labels)
        return f"""You are making flashcards for a university student revising the unit {deck}.
Above is part of the unit's notes ({names}).

Write {CARDS_PER_WEEK} new flashcards based ONLY on these pages. Write fewer only if the pages
are nearly empty or are just a cover, contents list or preface.
- Some pages may be photos of HANDWRITTEN notes: read them carefully, including the maths,
  tables and worked examples; they are as important as typed notes.
- Each card tests one idea: a definition, how something works, a comparison, a step in a
  procedure, a formula and when to use it, or a short worked example (give the problem on
  the front, the method and answer on the back).
- Only technical content that could be examined. Skip prefaces, course admin, study advice,
  the author's opinions and history, page numbers and the course outline.
- Spread the cards across the different topics on these pages.
- Front: a clear question, at most 2 sentences. Back: the answer, short (1-4 lines);
  use "- " lines for lists.
- Formatting the app understands: `inline code`, ```code blocks```, **bold**, new lines, and
  maths in LaTeX: inline $...$ or displayed $$...$$, e.g. $\\int x^2\\,dx = \\frac{x^3}{3} + C$.
  In the JSON, escape backslashes as usual (\\\\frac).
- Do not repeat or rephrase any of these questions the student already has:
{have}

Reply with ONLY a JSON array, no other text. Each item: {{"front": ..., "back": ...,
"topic": 2-5 words, "file": the file name and pages it came from}}."""

    # ------------------------------------------------------------------ Gemini REST
    def _call(self, key, method, url, body=None, headers=None, timeout=180):
        h = {'x-goog-api-key': key, **(headers or {})}
        data = body
        if body is not None and not isinstance(body, (bytes, bytearray)):
            data = json.dumps(body).encode()
            h.setdefault('Content-Type', 'application/json')
        req = urllib.request.Request(url, data=data, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read() or b'{}'), dict(r.headers)
        except urllib.error.HTTPError as e:
            text = e.read().decode('utf-8', 'replace')
            try:
                err = json.loads(text).get('error', {})
            except ValueError:
                err = {'message': text[:200]}
            msg = err.get('message') or f'HTTP {e.code}'
            retry = None
            for d in err.get('details') or []:
                m = re.match(r'(\d+)', str(d.get('retryDelay', '')))
                if m:
                    retry = int(m.group(1)) + 5
            if e.code in (401, 403) or 'API key' in msg:
                msg = f'Gemini rejected the API key ({msg}). Check sync-data/gemini-key.'
            elif e.code in (500, 502, 503, 504):
                msg = f'Gemini is overloaded right now; will retry soon. ({msg[:120]})'
            elif e.code == 429:
                msg = f'Gemini usage limit reached; will retry later. ({msg[:160]})'
            raise GeminiError(msg, e.code, retry) from None
        except urllib.error.URLError as e:
            if 'timed out' in str(e.reason):   # a slow connection, worth retrying
                raise GeminiError('The connection to Gemini timed out', 'timeout') from None
            raise GeminiError(f"Can't reach Gemini (no internet?): {e.reason}") from None
        except (TimeoutError, OSError) as e:
            raise GeminiError(f'Gemini took too long to answer ({type(e).__name__})', 'timeout') from None

    def _ask(self, key, parts):
        cards, model = self._generate_with_fallback(key, parts)
        self.last_model = model
        return cards

    @staticmethod
    def _parse(res, model, valid=None):
        try:
            cand = res['candidates'][0]
            text = ''.join(p.get('text', '') for p in cand['content']['parts'] if not p.get('thought'))
            m = re.search(r'\[.*\]', text, re.S)   # Gemma has no JSON mode: take the array out of the text
            cards = json.loads(m.group(0) if m else text)
        except (KeyError, IndexError, ValueError):
            why = (res.get('promptFeedback') or {}).get('blockReason') or (res.get('candidates') or [{}])[0].get('finishReason')
            raise GeminiError(f'{model} gave no usable answer ({why or "empty reply"})', 'weak')
        if not isinstance(cards, list):
            raise GeminiError(f'{model} answered in an unexpected format', 'weak')
        ok = valid or (lambda c: 3 < len(str(c.get('front', ''))) < 600
                       and 0 < len(str(c.get('back', ''))) < 2000 and len(str(c.get('topic', ''))) < 120)
        return [c for c in cards if isinstance(c, dict) and ok(c)]

    def _models(self, key):
        """Models to try, in order. Each has its OWN free daily quota, so when one runs out the
        next one carries on: your chosen Gemini Flash, other Flash versions (newest first),
        Flash-Lite, then Google's open-weights Gemma models."""
        res, _ = self._call(key, 'GET', f'{API}/v1beta/models?pageSize=200')
        names = [m['name'].split('/', 1)[1] for m in res.get('models', [])
                 if 'generateContent' in m.get('supportedGenerationMethods', [])]
        ver = lambda n: [int(x) for x in re.findall(r'\d+', n)]
        newest = lambda pat: sorted((n for n in names if re.fullmatch(pat, n)), key=ver, reverse=True)
        order = [self.state.get('model') or DEFAULT_MODEL]
        order += newest(r'gemini-[\d.]+-flash') + newest(r'gemini-[\d.]+-flash-lite') + newest(r'gemma-\d+-\d+b-it')
        seen, out = set(), []
        for n in order:
            if n not in seen and (n in names or n == order[0]):
                seen.add(n)
                out.append(n)
        return out

    def _generate_with_fallback(self, key, parts, min_cards=3, schema=CARD_SCHEMA, valid=None):
        """Go down the model list. Out of quota (429): mark that model used up until Google says
        it resets, and move on at once. Overloaded (503): retry twice, then move on.
        Retired (404): move on, and stop using it."""
        now = time.time()
        ex = self.state.setdefault('exhausted', {})
        for m in [m for m, t in ex.items() if t <= now]:
            del ex[m]
        last, best, weak = None, ([], None), 0
        for model in self._models(key)[:8]:
            if weak >= 2:
                break   # two models found little here: the pages are probably thin, take the best
            if model in ex:
                continue
            gemma = model.startswith('gemma')
            # Default temperature: Gemini 3 models loop on repeated words when it's lowered.
            body = {'contents': [{'role': 'user', 'parts': parts}], 'generationConfig': {'maxOutputTokens': 24000}}
            if not gemma:
                body['generationConfig'].update(responseMimeType='application/json', responseSchema=schema)
            for attempt in range(3):
                try:
                    res, _ = self._call(key, 'POST', f'{API}/v1beta/models/{model}:generateContent', body)
                    cards = self._parse(res, model, valid)
                    if len(cards) < min_cards:   # a garbled or looping answer: let the next model try
                        if len(cards) > len(best[0]):
                            best = (cards, model)
                        raise GeminiError(f'{model} returned only {len(cards)} usable item(s)', 'weak')
                    if model != (self.state.get('model') or DEFAULT_MODEL):
                        _log(f'used {model} (the usual model was unavailable)')
                    return cards, model
                except GeminiError as e:
                    last = e
                    if e.code not in (500, 502, 503, 504, 'timeout') or attempt == 2:
                        break
                    _log(f'{model} busy, retrying in {20 * (attempt + 1)} s')
                    time.sleep(20 * (attempt + 1))
            if last.code == 'weak':
                weak += 1
            if last.code == 429:
                ex[model] = now + (last.retry or 3600)
                _log(f'{model}: free quota used up, until {time.strftime("%a %H:%M", time.localtime(ex[model]))}')
            elif last.code == 404:
                ex[model] = now + 30 * 24 * 3600
                if model == self.state.get('model'):
                    self.state['model'] = DEFAULT_MODEL if model != DEFAULT_MODEL else None
            elif last.code not in (500, 502, 503, 504, 'timeout', 'weak', 400):
                raise last   # bad key, no internet: no point trying other models
        if best[0]:
            return best
        if last and last.code == 429 or not last:
            soon = min(ex.values(), default=now + 3600)
            raise GeminiError('All free Gemini/Gemma quotas are used up for now; will retry when they reset.', 429, int(soon - now) + 60)
        raise last
