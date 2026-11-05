"""Ask AI, laptop route: the phone sends a conversation (text + photos/screenshots) and the
laptop asks Gemini, using its key and the same model switching / free-quota handling as
cardgen.py. The phone uses this only when it has no Gemini key of its own (askai.js)."""
import json
import re
import time
import urllib.error
import urllib.request

from cardgen import API, GeminiError, _log

MAX_TURNS = 30
MAX_IMAGES = 8


def _clean(contents):
    """Keep only what Gemini needs: roles, text, and a few images per request."""
    out, images = [], 0
    for c in (contents or [])[-MAX_TURNS:]:
        role = 'model' if c.get('role') == 'model' else 'user'
        parts = []
        for p in c.get('parts') or []:
            if isinstance(p.get('text'), str) and p['text'].strip():
                parts.append({'text': p['text'][:20000]})
            d = p.get('inline_data') or {}
            if images < MAX_IMAGES and re.match(r'^image/(jpeg|png|webp)$', str(d.get('mime_type', ''))) and isinstance(d.get('data'), str):
                parts.append({'inline_data': {'mime_type': d['mime_type'], 'data': d['data']}})
                images += 1
        if parts:
            out.append({'role': role, 'parts': parts})
    if not out or out[-1]['role'] != 'user':
        raise GeminiError('Nothing to ask')
    return out


BUSY_FOR = 600          # skip an overloaded / silent model for 10 minutes
CALL_TIMEOUT = 45       # Ask AI is interactive: don't wait minutes on a stuck model
_busy = {}              # model -> time it may be tried again
_good = {'model': None} # the last model that answered: tried first
_no_think_level = set() # models that refuse thinkingConfig.thinkingLevel


def _order(models, now, ex):
    ok = [m for m in models if ex.get(m, 0) <= now and _busy.get(m, 0) <= now]
    if not ok:   # all marked busy: try them anyway
        ok = [m for m in models if ex.get(m, 0) <= now]
    g = _good['model']
    return ([g] if g in ok else []) + [m for m in ok if m != g]


GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
GROQ_MODEL = 'qwen/qwen3.8-27b'   # reads images; answers in a second or two


def _groq(key, system, contents):
    """Ask Groq (groq.com) first. Only the latest pictures go along: its free plan counts ~2,000
    tokens per picture against 7,000 a minute. Raises GeminiError (429 with a retry time when resting)."""
    last_pics = max((i for i, c in enumerate(contents) if any('inline_data' in p for p in c['parts'])), default=-1)
    msgs = [{'role': 'system', 'content': system}]
    for i, c in enumerate(contents):
        text = '\n'.join(p['text'] for p in c['parts'] if 'text' in p)
        if c['role'] == 'model':
            msgs.append({'role': 'assistant', 'content': text})
        elif i != last_pics:
            msgs.append({'role': 'user', 'content': text or '(picture)'})
        else:
            pics = [p['inline_data'] for p in c['parts'] if 'inline_data' in p][:3]
            msgs.append({'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': f"data:{d['mime_type']};base64,{d['data']}"}} for d in pics]
                         + [{'type': 'text', 'text': text or 'Help me with this.'}]})
    req = urllib.request.Request(GROQ_URL, json.dumps({'model': GROQ_MODEL, 'max_completion_tokens': 4096, 'messages': msgs}).encode(),
                                 {'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'User-Agent': 'StudyHub/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=CALL_TIMEOUT) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')
        m = re.search(r'try again in ([\d.]+)s', body)
        wait = float(e.headers.get('retry-after') or (m.group(1) if m else 0) or 0)
        raise GeminiError(f'Groq: HTTP {e.code}', e.code, int(wait) + 1 if wait else None) from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise GeminiError(f'Groq: {e}', 'timeout') from None
    text = ((d.get('choices') or [{}])[0].get('message') or {}).get('content', '').strip()
    if not text:
        raise GeminiError('Groq gave no answer', 'weak')
    return text


def ask(gen, system, contents):
    key = gen.api_key()
    gkey = gen.groq_key() if hasattr(gen, 'groq_key') else ''
    if not key and not gkey:
        raise GeminiError('No Gemini API key on the laptop', 409)
    contents = _clean(contents)
    # Groq first: answers in a second or two, unless it's resting after its per-minute limit
    groq = 'groq:' + GROQ_MODEL
    if gkey and _busy.get(groq, 0) <= time.time():
        try:
            try:
                return {'text': _groq(gkey, system, contents), 'model': GROQ_MODEL + ' (Groq)'}
            except GeminiError as e:
                if e.code != 429 or not e.retry or e.retry > 20:
                    raise
                time.sleep(e.retry)   # resting a few seconds: still quicker than a busy Gemini
                return {'text': _groq(gkey, system, contents), 'model': GROQ_MODEL + ' (Groq)'}
        except GeminiError as e:
            rest = e.retry or (86400 if e.code in (401, 403) else 60 if e.code == 429 else BUSY_FOR)
            _busy[groq] = time.time() + rest
            _log(f'Groq unavailable for Ask AI ({e}); using Gemini')
            if not key:
                raise
    if not key:
        raise GeminiError('Groq is resting for a moment and there is no Gemini key on the laptop. Try again shortly.', 429)
    now = time.time()
    ex = gen.state.setdefault('exhausted', {})
    last = None
    for model in _order(gen._models(key)[:8], now, ex):
        body = {'contents': contents, 'generationConfig': {'maxOutputTokens': 8192}}
        if model.startswith('gemma'):   # no system instructions: put them in the first message
            first = dict(contents[0], parts=[{'text': system}] + contents[0]['parts'])
            body['contents'] = [first] + contents[1:]
        else:
            body['systemInstruction'] = {'parts': [{'text': system}]}
            if model not in _no_think_level:   # short hidden "thinking": roughly halves the wait
                body['generationConfig']['thinkingConfig'] = {'thinkingLevel': 'low'}
        for attempt in range(2):
            try:
                res, _ = gen._call(key, 'POST', f'{API}/v1beta/models/{model}:generateContent', body, timeout=CALL_TIMEOUT)
                cand = (res.get('candidates') or [{}])[0]
                text = ''.join(p.get('text', '') for p in (cand.get('content') or {}).get('parts', []) if not p.get('thought')).strip()
                if not text:
                    raise GeminiError(f"{model} gave no answer ({cand.get('finishReason') or 'empty'})", 'weak')
                _good['model'] = model
                _busy.pop(model, None)
                return {'text': text, 'model': model}
            except GeminiError as e:
                last = e
                if e.code == 400 and 'thinkingConfig' in body['generationConfig'] and 'think' in str(e).lower():
                    _no_think_level.add(model)   # this model doesn't take the setting: ask it plainly
                    del body['generationConfig']['thinkingConfig']
                    continue
                break
        if last.code == 429:
            ex[model] = now + (last.retry or 3600)
            _log(f'{model}: free quota used up (Ask AI)')
        elif last.code in (500, 502, 503, 504, 'timeout'):
            _busy[model] = now + BUSY_FOR
        elif last.code not in (404, 'weak', 400):
            raise last
        if _good['model'] == model:
            _good['model'] = None
    gen._save()
    raise last or GeminiError('All free Gemini/Gemma quotas are used up for now. Try again later.', 429)
