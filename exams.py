"""Practice exams: Gemini writes CAT/exam-style papers from a unit's notes and marks your answers.

  * Questions come from pages sampled across the unit's notes (or one file you pick), in the
    style of that unit's Past papers if you've filed any. Three lengths: Quick, CAT, Full exam.
  * Multiple choice is marked instantly. Written answers (typed, or a photo of your working)
    are marked by Gemini against a marking scheme, with feedback on what was missing.
  * Everything lives on the laptop in sync-data/exams/<id>.json (one file per paper).

Uses the same key, model switching and free-quota handling as cardgen.py.
"""
import base64
import json
import os
import random
import re
import secrets
import threading
import time

import cardgen
from cardgen import GeminiError, _log, _norm

SIZES = {   # name: (multiple choice, short, long, minutes)
    'quick': (3, 2, 0, 15),
    'cat':   (4, 4, 2, 45),
    'exam':  (5, 6, 4, 120),
}
BUDGET = 40          # pages of notes per paper (a scanned page counts double)
WINDOW = 6           # pages read together from one place in a file
PAST_PAGES = 4       # pages of each past paper, for question style
MAX_PHOTO = 6 * 1024 * 1024

QUESTION_SCHEMA = {'type': 'ARRAY', 'items': {'type': 'OBJECT', 'properties': {
    'type': {'type': 'STRING', 'enum': ['mcq', 'short', 'long']},
    'question': {'type': 'STRING'},
    'options': {'type': 'ARRAY', 'items': {'type': 'STRING'}},
    'answer': {'type': 'STRING'},
    'points': {'type': 'ARRAY', 'items': {'type': 'STRING'}},
    'marks': {'type': 'INTEGER'},
    'topic': {'type': 'STRING'},
    'source': {'type': 'STRING'}},
    'required': ['type', 'question', 'answer', 'marks']}}

MARK_SCHEMA = {'type': 'ARRAY', 'items': {'type': 'OBJECT', 'properties': {
    'n': {'type': 'INTEGER'}, 'score': {'type': 'NUMBER'},
    'feedback': {'type': 'STRING'}, 'missed': {'type': 'ARRAY', 'items': {'type': 'STRING'}}},
    'required': ['n', 'score', 'feedback']}}

SAFE = re.compile(r'^[a-z0-9]{6,32}$')


class Exams:
    def __init__(self, gen):
        self.gen, self.hub = gen, gen.hub
        self.dir = os.path.join(self.hub.dir, 'exams')
        os.makedirs(self.dir, exist_ok=True)
        self.lock = threading.Lock()     # one Gemini job at a time (shared quota)
        # papers left half-done when the server stopped
        for e in self._all():
            if e['status'] in ('making', 'marking'):
                e['status'] = 'error' if e['status'] == 'making' else 'answered'
                e['error'] = 'The laptop server was stopped before this finished. Try again.'
                self._save(e)

    # ------------------------------------------------------------------ storage
    def _path(self, eid):
        return os.path.join(self.dir, f'{eid}.json')

    def _save(self, e):
        tmp = self._path(e['id']) + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(e, f, ensure_ascii=False)
        os.replace(tmp, self._path(e['id']))

    def get(self, eid):
        if not SAFE.match(eid or ''):
            return None
        try:
            with open(self._path(eid), encoding='utf-8') as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _all(self):
        out = []
        for n in os.listdir(self.dir):
            if n.endswith('.json'):
                e = self.get(n[:-5])
                if e:
                    out.append(e)
        return sorted(out, key=lambda e: -e['created'])

    def delete(self, eid):
        e = self.get(eid)
        if not e or e['status'] in ('making', 'marking'):
            return False
        for n in os.listdir(self.dir):
            if n.startswith(eid):
                os.remove(os.path.join(self.dir, n))
        return True

    def listing(self):
        units = self.gen.units()
        papers = self._past_papers()
        rows = [{'course': c, 'deck': u['deck'],
                 'files': [{'id': f['id'], 'name': f['name']} for f in u['files']],
                 'pastPapers': len(papers.get(c, []))} for c, u in sorted(units.items())]
        exams = [{k: e.get(k) for k in ('id', 'course', 'deck', 'size', 'created', 'status', 'error',
                                         'score', 'max', 'focus', 'minutes')} | {'questions': len(e.get('questions') or [])}
                 for e in self._all()]
        return {'ok': True, 'keyPresent': bool(self.gen.api_key()), 'units': rows, 'exams': exams,
                'sizes': {k: {'mcq': v[0], 'short': v[1], 'long': v[2], 'minutes': v[3]} for k, v in SIZES.items()}}

    def _past_papers(self):
        out = {}
        for f in self.gen._live('files'):
            if f.get('category') == 'Past papers' and f.get('course') and (cardgen.SUPPORTED.match(f.get('type') or '') or cardgen.officeconv.is_office(f)) \
                    and os.path.exists(self.hub.blob_path(f['id'])):
                out.setdefault(f['course'], []).append(f)
        return out

    # ------------------------------------------------------------------ making a paper
    def new(self, course, size='cat', file_id=None):
        unit = self.gen.units().get(course)
        if not unit:
            raise ValueError('That unit has no notes (Lecture notes or Books) on the laptop')
        if size not in SIZES:
            size = 'cat'
        files = [f for f in unit['files'] if not file_id or f['id'] == file_id] or unit['files']
        e = {'id': secrets.token_hex(6), 'course': course, 'deck': unit['deck'], 'size': size,
             'created': int(time.time() * 1000), 'status': 'making', 'error': '', 'minutes': SIZES[size][3],
             'focus': files[0]['name'] if file_id and len(files) == 1 else '', 'questions': [], 'sources': []}
        self._save(e)
        threading.Thread(target=self._make, args=(e, unit, files), daemon=True).start()
        return e

    def _windows(self, files, st):
        """Pages to read: windows spread evenly (with a random shift) across each file, each file
        getting a share of the budget by its length. A scanned page costs double."""
        info = []
        for f in files:
            n = self.gen._pages(f)
            scan = (f.get('type') or '').startswith('image/') or (self.gen._pdfish(f) and self.gen._is_scan(f, st))
            info.append((f, n, 2 if scan else 1))
        total = sum(n * cost for _, n, cost in info) or 1
        out = []
        for f, n, cost in info:
            pages = max(1, min(n, round(BUDGET * n / total)))      # this file's share, in pages
            k = -(-pages // WINDOW)                                  # how many windows
            seg = n / k
            for i in range(k):
                size = min(WINDOW, pages - i * WINDOW)
                lo, hi = int(i * seg) + 1, max(int(i * seg) + 1, int((i + 1) * seg) - size + 1)
                a = random.randint(lo, hi)
                out.append((f, a, min(n, a + size - 1)))
        return out

    def _make(self, e, unit, files):
        with self.lock:
            try:
                key = self.gen.api_key()
                if not key:
                    raise GeminiError('No Gemini API key on the laptop')
                st = self.gen.state['units'].setdefault(e['course'], {})
                parts, labels = [], []
                for f, a, b in self._windows(files, st):
                    label, p = self.gen._slice_parts(f, a, b, st)
                    labels.append(label)
                    parts += p
                for f in self._past_papers().get(e['course'], [])[:2]:
                    label, p = self.gen._slice_parts(f, 1, min(PAST_PAGES, self.gen._pages(f)), st)
                    p[0] = {'text': f'--- PAST PAPER, for question style and difficulty only: {label} ---'}
                    parts += p
                mcq, short, long_, minutes = SIZES[e['size']]
                has_past = bool(self._past_papers().get(e['course']))
                parts.append({'text': self._exam_prompt(e['deck'], labels, mcq, short, long_, minutes, has_past)})

                def valid(q):
                    t = q.get('type')
                    if t not in ('mcq', 'short', 'long') or len(str(q.get('question', ''))) < 8:
                        return False
                    if t == 'mcq':
                        opts = q.get('options') or []
                        return len(opts) == 4 and str(q.get('answer', '')).strip()[:1].upper() in 'ABCD'
                    return len(str(q.get('answer', ''))) > 3
                qs, model = self.gen._generate_with_fallback(key, parts, min_cards=max(3, (mcq + short + long_) // 2),
                                                             schema=QUESTION_SCHEMA, valid=valid)
                order = {'mcq': 0, 'short': 1, 'long': 2}
                qs.sort(key=lambda q: order[q['type']])
                for i, q in enumerate(qs, 1):
                    q['n'] = i
                    q['marks'] = max(1, min(25, int(q.get('marks') or (1 if q['type'] == 'mcq' else 4))))
                    q['options'] = [re.sub(r'^\s*[A-Da-d][.)]\s*', '', str(o)) for o in q.get('options') or []]
                    if q['type'] == 'mcq':
                        q['answer'] = str(q['answer']).strip()[:1].upper()
                e.update(questions=qs, sources=labels, model=model, status='ready', error='',
                         max=sum(q['marks'] for q in qs))
                _log(f"{e['course']}: practice paper ready ({len(qs)} questions, {model})")
            except GeminiError as err:
                e.update(status='error', error=str(err))
                _log(f"{e['course']}: practice paper failed: {err}")
            except Exception as err:
                e.update(status='error', error=f'{type(err).__name__}: {err}')
                _log(f"{e['course']}: practice paper failed: {type(err).__name__}: {err}")
            finally:
                self.gen._save()   # remembers which PDFs are scans
                self._save(e)

    @staticmethod
    def _exam_prompt(deck, labels, mcq, short, long_, minutes, has_past):
        past = ', and some past papers (marked as such) to show the style' if has_past else ''
        return f"""You are the examiner for the university unit {deck}. Above are pages from the unit's
notes ({'; '.join(labels)}){past}.

Set a {minutes}-minute practice paper with exactly {mcq} multiple-choice, {short} short-answer and
{long_} long/structured questions, testing ONLY material in these notes.
- Cover different topics; test understanding and application, not trivia. If past papers are
  given, copy their style, wording and difficulty (but not their exact questions).
- mcq: "question", 4 "options" (no A/B labels), "answer" = the correct letter A-D, 1-2 marks.
  Wrong options must be plausible.
- short: answerable in a few lines (definition, explain, compare, small calculation), 2-5 marks.
- long: structured, may have parts (a), (b), (c) with the marks for each part in brackets,
  e.g. a derivation, a worked problem, writing/tracing code, or an essay-style explain-and-
  illustrate; 6-15 marks. Put the parts and their marks in "question".
- For short and long: "answer" = a full model answer; "points" = the marking scheme, one item
  per mark-earning point, like "(1) states that ...". The points must add up to "marks".
- "topic": 2-5 words. "source": the file and pages the question is based on.
- Formatting the app understands: `inline code`, ```code blocks```, **bold**, new lines, "- " lists.
  No LaTeX: write maths in plain Unicode, e.g. ∫ x² dx = x³/3 + C, √, π, ≤, Σ, x₁.

Reply with ONLY a JSON array of the questions, no other text."""

    # ------------------------------------------------------------------ marking
    def submit(self, eid, answers):
        e = self.get(eid)
        if not e or e['status'] not in ('ready', 'answered', 'marked'):
            raise ValueError('This paper is not ready to be marked')
        clean = {}
        for q in e['questions']:
            a = answers.get(str(q['n'])) or {}
            item = {'text': str(a.get('text', ''))[:20000]}
            photo = a.get('photo')
            if isinstance(photo, str) and photo.startswith('data:image/') and len(photo) < MAX_PHOTO * 4 // 3:
                head, data = photo.split(',', 1)
                path = os.path.join(self.dir, f"{eid}-q{q['n']}.jpg")
                with open(path, 'wb') as f:
                    f.write(base64.b64decode(data))
                item['photo'] = True
            elif a.get('photo') is True and os.path.exists(os.path.join(self.dir, f"{eid}-q{q['n']}.jpg")):
                item['photo'] = True   # photo already uploaded with an earlier try
            if q['type'] == 'mcq':
                item['choice'] = str(a.get('choice', '')).strip()[:1].upper()
            clean[str(q['n'])] = item
        e.update(answers=clean, submitted=int(time.time() * 1000), status='marking', error='')
        e['elapsed'] = int(answers.get('_elapsed') or 0) if isinstance(answers.get('_elapsed'), (int, float)) else 0
        self._save(e)
        threading.Thread(target=self._mark, args=(e,), daemon=True).start()
        return e

    def _mark(self, e):
        with self.lock:
            try:
                results = {}
                written = []
                for q in e['questions']:
                    a = e['answers'].get(str(q['n']), {})
                    if q['type'] == 'mcq':
                        ok = a.get('choice') == q['answer']
                        results[q['n']] = {'n': q['n'], 'score': q['marks'] if ok else 0,
                                           'feedback': 'Correct.' if ok else f"The answer is {q['answer']}." if a.get('choice') else 'Not answered.'}
                    elif not a.get('text', '').strip() and not a.get('photo'):
                        results[q['n']] = {'n': q['n'], 'score': 0, 'feedback': 'Not answered.', 'missed': q.get('points') or []}
                    else:
                        written.append(q)
                if written:
                    key = self.gen.api_key()
                    parts = [{'text': self._mark_prompt(e['deck'])}]
                    for q in written:
                        a = e['answers'][str(q['n'])]
                        scheme = '\n'.join(f'  - {p}' for p in q.get('points') or [])
                        parts.append({'text': f"\n=== Question {q['n']} [{q['marks']} marks] ===\n{q['question']}\n"
                                              f"MODEL ANSWER:\n{q['answer']}\nMARKING SCHEME:\n{scheme or '  (use the model answer)'}\n"
                                              f"STUDENT'S ANSWER:\n{a.get('text') or '(see photo)'}"})
                        if a.get('photo'):
                            with open(os.path.join(self.dir, f"{e['id']}-q{q['n']}.jpg"), 'rb') as f:
                                parts += [{'text': f"Photo of the student's working for question {q['n']}:"},
                                          {'inline_data': {'mime_type': 'image/jpeg', 'data': base64.b64encode(f.read()).decode()}}]
                    want = {q['n'] for q in written}
                    marks, model = self.gen._generate_with_fallback(
                        key, parts, min_cards=len(written), schema=MARK_SCHEMA,
                        valid=lambda m: isinstance(m.get('n'), int) and m['n'] in want and isinstance(m.get('score'), (int, float)))
                    e['markModel'] = model
                    for m in marks:
                        q = next(x for x in written if x['n'] == m['n'])
                        results[m['n']] = {'n': m['n'], 'score': max(0, min(q['marks'], round(float(m['score']) * 2) / 2)),
                                           'feedback': str(m.get('feedback', ''))[:1500],
                                           'missed': [str(x)[:300] for x in m.get('missed') or []][:12]}
                    for q in written:   # in case one was left out of the reply
                        results.setdefault(q['n'], {'n': q['n'], 'score': 0, 'feedback': "Couldn't be marked automatically; compare with the model answer."})
                e['results'] = [results[q['n']] for q in e['questions']]
                e['score'] = sum(r['score'] for r in e['results'])
                e.update(status='marked', error='')
                _log(f"{e['course']}: paper marked {e['score']}/{e['max']}")
            except GeminiError as err:
                e.update(status='answered', error=f'Marking failed: {err}')
            except Exception as err:
                e.update(status='answered', error=f'Marking failed: {type(err).__name__}: {err}')
            finally:
                self._save(e)

    @staticmethod
    def _mark_prompt(deck):
        return f"""You are marking a student's practice paper for the university unit {deck}, as a fair
but careful examiner. For each question below you get the question, a model answer, the
marking scheme, and the student's answer (typed, and/or a photo of handwritten working).

- Award marks per the scheme. Accept correct answers in different words or a different valid
  method. Give method marks for correct working even if the final answer is wrong.
- Half marks are allowed. Never exceed the question's marks. Blank or irrelevant = 0.
- "feedback": 1-3 sentences to the student ("you"): what was right, what cost marks, and how
  to fix it. "missed": the marking points they did not get (short).
- No LaTeX: write maths in plain Unicode.

Reply with ONLY a JSON array: one item per question, {{"n": question number, "score": ..., "feedback": ..., "missed": [...]}}."""
