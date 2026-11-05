'use strict';
/* Ask AI: send a question, with photos or screenshots of notes / a question / your working,
 * and get guidance from Google Gemini.
 *
 * Route: if this phone has its own Gemini key (Settings → Ask AI), it talks to Google directly,
 * so it works anywhere with internet, laptop or not. Otherwise it goes through the laptop
 * (/sync/ask, askai.py), which uses the laptop's key. The key is kept only on this phone:
 * never synced, never in backups, never in the app download.
 *
 * Also: ✨ Ask in the PDF viewer sends the page you're looking at. */

const AI_KEY_LS = 'studyhub-gemini-key';
const AI_CHATS_LS = 'studyhub-ask-chats';
const AI_MODELS_LS = 'studyhub-ask-models';
const AI_API = 'https://generativelanguage.googleapis.com/v1beta';
const AI_MODES = {
  hint: ['💡', 'Hint me', 'Guide, don\'t solve. Work out what the question is asking and which idea, formula or method it needs, then give ONE next step or a hint and ask the student to try it. Never give the final answer unless they explicitly ask for it.'],
  explain: ['📖', 'Explain', 'Explain the idea clearly from the basics, with a short worked example, then check understanding with one quick question at the end.'],
  solve: ['🧮', 'Solve', 'Solve it step by step, saying why each step is done, give the final answer clearly, and point out the common mistakes.'],
  check: ['✅', 'Check mine', 'The student is showing their own answer or working. Say what is right, find the FIRST mistake and explain it, and say roughly what marks it would earn. Do not write out the full correct solution unless they ask.'],
};

Object.assign(state, { ask: null });   // { id, mode, course, turns: [{ role, text, images: [dataURL] }], busy }
let askDraft = { text: '', images: [] };
const aiKey = () => { try { return localStorage.getItem(AI_KEY_LS) || ''; } catch { return ''; } };
// Groq (groq.com, with a q): hosts open models on very fast chips; free plan, ~3 picture questions a minute
const AI_GROQ_LS = 'studyhub-groq-key';
const GROQ_API = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = 'qwen/qwen3.8-27b';   // reads images
const groqKey = () => { try { return localStorage.getItem(AI_GROQ_LS) || ''; } catch { return ''; } };
/** Can this device ask the AI services itself (any key here)? Otherwise it goes through the laptop. */
const aiDirect = () => !!(aiKey() || groqKey());

function askSystem(a) {
  const deck = a.course && (unitDeck(a.course) || a.course);
  return `You are a patient, encouraging university tutor${deck ? ` helping a student with the unit ${deck}` : ''}.
The student may send photos or screenshots of lecture notes, slides, past-paper questions or their own handwritten working: read them carefully, including tables, diagrams and maths.
${AI_MODES[a.mode][2]}
Keep it focused and fairly short. If a photo is unreadable, say what you can't read.
Formatting the app shows: **bold**, *italic*, \`inline code\`, \`\`\`code blocks\`\`\`, "- " and "1." lists, ### headings, | tables |, short paragraphs.
Maths: write it in LaTeX, inline as $...$ and displayed equations on their own line as $$...$$ (e.g. $\\bar{A}B + A\\bar{B}$, $$M_X(t) = \\frac{\\lambda}{\\lambda - t}$$). Never put maths inside code blocks.`;
}

/** The conversation in Gemini's format. */
function askContents(a) {
  return a.turns.map((t) => ({
    role: t.role,
    parts: [
      ...(t.images || []).map((d) => ({ inline_data: { mime_type: 'image/jpeg', data: d.split(',')[1] } })),
      ...(t.where ? [{ text: `(The picture is a part of my notes: ${t.where}.)` }] : []),
      ...(t.text ? [{ text: t.text }] : []),
    ],
  }));
}

// ---------------------------------------------------------------------
// Direct to Google (this phone's key), with the same model switching as the laptop
// ---------------------------------------------------------------------
async function aiFetch(path, body, key, timeout = 120000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(`${AI_API}/${path}`, {
      method: body ? 'POST' : 'GET', signal: ctl.signal,
      headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = json.error || {};
      const retry = (err.details || []).map((d) => parseInt(d.retryDelay, 10)).find((n) => n > 0);
      throw Object.assign(new Error(err.message || `Google answered ${res.status}`), { status: res.status, retry });
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('Google took too long to answer'), { status: 'timeout' });
    if (e instanceof TypeError) throw Object.assign(new Error('No internet connection'), { status: 'offline' });
    throw e;
  } finally { clearTimeout(timer); }
}

async function aiModels(key) {
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(AI_MODELS_LS) || '{}'); } catch { /* ignore */ }
  if (!cache.list || Date.now() - cache.t > DAY) {
    const res = await aiFetch('models?pageSize=200', null, key, 20000);
    const names = (res.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.split('/')[1]);
    const ver = (n) => (n.match(/\d+/g) || []).map(Number);
    const newest = (re) => names.filter((n) => re.test(n)).sort((a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < 4; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; });
    cache = { t: Date.now(), list: [...newest(/^gemini-[\d.]+-flash$/), ...newest(/^gemini-[\d.]+-flash-lite$/), ...newest(/^gemma-\d+-\d+b-it$/)], exhausted: cache.exhausted || {} };
    try { localStorage.setItem(AI_MODELS_LS, JSON.stringify(cache)); } catch { /* ignore */ }
  }
  return cache;
}

const AI_BUSY_MS = 10 * MIN;        // skip an overloaded / silent model this long
const AI_HEDGE_MS = 15000;          // no words yet after this: ALSO ask the next model; first to answer wins
const AI_FIRST_WORDS_MS = 75000;    // give up on a model that hasn't started answering by then
const AI_STALL_MS = 45000;          // ...or that stops mid-answer for this long

/** Models to try, best bet first: the last one that answered, then the newest; busy/used-up ones skipped. */
function aiOrder(cache, now) {
  const ok = (m) => (cache.exhausted[m] || 0) <= now && ((cache.busy || {})[m] || 0) <= now;
  const list = cache.list.slice(0, 8);
  const order = [...(cache.good && list.includes(cache.good) ? [cache.good] : []), ...list.filter((m) => m !== cache.good)];
  const ready = order.filter(ok);
  // everything marked busy? try them anyway rather than give up
  return ready.length ? ready : order.filter((m) => (cache.exhausted[m] || 0) <= now);
}

/** One streamed answer from one model. onText(textSoFar) is called as it arrives.
 * `cancel` (an AbortSignal) stops it when another model won the race. */
async function aiStream(model, body, key, onText, cancel) {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  cancel?.addEventListener('abort', stop);
  let timer = setTimeout(stop, AI_FIRST_WORDS_MS);
  let text = '';
  try {
    const res = await fetch(`${AI_API}/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))).error || {};
      const retry = (err.details || []).map((d) => parseInt(d.retryDelay, 10)).find((n) => n > 0);
      throw Object.assign(new Error(err.message || `Google answered ${res.status}`), { status: res.status, retry });
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let d;
        try { d = JSON.parse(line.slice(5)); } catch { continue; }
        const add = ((d.candidates || [])[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
        if (add) {
          text += add;
          clearTimeout(timer);
          timer = setTimeout(stop, AI_STALL_MS);
          onText?.(text);
        }
      }
    }
    return text.trim();
  } catch (e) {
    if (cancel?.aborted) throw Object.assign(new Error('cancelled'), { status: 'lost' });
    if (e.name === 'AbortError' || ctl.signal.aborted) throw Object.assign(new Error(`${model} was too slow to answer`), { status: 'timeout' });
    if (e instanceof TypeError && !text) throw Object.assign(new Error('No internet connection'), { status: 'offline' });
    throw e;
  } finally {
    clearTimeout(timer);
    cancel?.removeEventListener('abort', stop);
  }
}

/** The conversation in the OpenAI-style format Groq uses. Only the latest pictures are sent (its
 * free plan counts ~2,000 tokens per picture against 7,000 a minute); the earlier answers carry the context. */
function groqMessages(a) {
  let lastPics = -1;
  a.turns.forEach((t, i) => { if ((t.images || []).length) lastPics = i; });
  return [
    { role: 'system', content: askSystem(a) },
    ...a.turns.map((t, i) => {
      const text = [t.where ? `(The picture is a part of my notes: ${t.where}.)` : '', t.text || ''].filter(Boolean).join('\n');
      if (t.role === 'model') return { role: 'assistant', content: t.text || '' };
      if (i !== lastPics) return { role: 'user', content: text || '(picture)' };
      return { role: 'user', content: [
        ...(t.images || []).slice(0, 3).map((d) => ({ type: 'image_url', image_url: { url: d } })),
        { type: 'text', text: text || 'Help me with this.' },
      ] };
    }),
  ];
}

/** One streamed answer from Groq (same contract as aiStream). */
async function groqStream(a, key, onText, cancel) {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  cancel?.addEventListener('abort', stop);
  let timer = setTimeout(stop, AI_FIRST_WORDS_MS);
  let text = '';
  try {
    const res = await fetch(`${GROQ_API}/chat/completions`, {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODEL, stream: true, max_completion_tokens: 4096, messages: groqMessages(a) }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))).error || {};
      const wait = Number(res.headers.get('retry-after')) || parseFloat((/try again in ([\d.]+)s/i.exec(err.message || '') || [])[1]) || 0;
      throw Object.assign(new Error(err.message || `Groq answered ${res.status}`), { status: res.status, retry: wait ? Math.ceil(wait) + 1 : 0 });
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
        let d;
        try { d = JSON.parse(line.slice(5)); } catch { continue; }
        const add = (d.choices || [])[0]?.delta?.content || '';
        if (add) {
          text += add;
          clearTimeout(timer);
          timer = setTimeout(stop, AI_STALL_MS);
          onText?.(text);
        }
      }
    }
    return text.trim();
  } catch (e) {
    if (cancel?.aborted) throw Object.assign(new Error('cancelled'), { status: 'lost' });
    if (e.name === 'AbortError' || ctl.signal.aborted) throw Object.assign(new Error('Groq was too slow to answer'), { status: 'timeout' });
    if (e instanceof TypeError && !text) throw Object.assign(new Error('No internet connection'), { status: 'offline' });
    throw e;
  } finally {
    clearTimeout(timer);
    cancel?.removeEventListener('abort', stop);
  }
}

/** Ask Google directly with this phone's key. Streams the answer through onText. If a model hasn't
 * started answering after AI_HEDGE_MS, the next one is asked too (at most two at once) and the
 * first to answer is kept; overloaded / silent models are skipped for a while after. */
async function askDirect(a, key, onText) {
  const gkey = groqKey();
  let cache;
  if (key) cache = await aiModels(key);
  else { try { cache = JSON.parse(localStorage.getItem(AI_MODELS_LS) || '{}'); } catch { cache = {}; } }
  cache.list = key ? cache.list || [] : [];
  cache.exhausted = cache.exhausted || {};
  cache.busy = cache.busy || {};
  cache.noThinkLevel = cache.noThinkLevel || {};
  const now = Date.now();
  const contents = askContents(a);
  const save = () => { try { localStorage.setItem(AI_MODELS_LS, JSON.stringify(cache)); } catch { /* ignore */ } };
  // Groq first (answers in a second or two) when it isn't resting after its per-minute limit
  const GROQ = `groq:${GROQ_MODEL}`;
  const groqOk = gkey && (cache.exhausted[GROQ] || 0) <= now && (cache.busy[GROQ] || 0) <= now;
  const queue = [...(groqOk ? [GROQ] : []), ...(key ? aiOrder(cache, now) : [])];
  if (!queue.length && gkey) queue.push(GROQ);   // only Groq, and it's resting: try anyway
  const groqQueued = queue.includes(GROQ);

  const bodyFor = (model) => {
    const gemma = model.startsWith('gemma');
    const body = { contents, generationConfig: { maxOutputTokens: 8192 } };
    // A study question doesn't need long hidden "thinking": it roughly halves the wait
    if (!gemma && !cache.noThinkLevel[model]) body.generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    if (gemma) body.contents = [{ ...contents[0], parts: [{ text: askSystem(a) }, ...contents[0].parts] }, ...contents.slice(1)];
    else body.systemInstruction = { parts: [{ text: askSystem(a) }] };
    return body;
  };
  const runModel = async (model, cancel, onModelText) => {
    if (model === GROQ) return groqStream(a, gkey, onModelText, cancel);
    const body = bodyFor(model);
    try {
      return await aiStream(model, body, key, onModelText, cancel);
    } catch (e) {
      if (e.status === 400 && body.generationConfig.thinkingConfig && /think/i.test(e.message)) {
        cache.noThinkLevel[model] = true;   // this model doesn't take the setting: ask it plainly
        delete body.generationConfig.thinkingConfig;
        return aiStream(model, body, key, onModelText, cancel);
      }
      throw e;
    }
  };

  return new Promise((resolve, reject) => {
    let leader = null, running = 0, finished = false, last = null, hedge = null, groqRetried = false;
    const ctls = new Map();
    const finish = (fn) => {
      finished = true;
      clearTimeout(hedge);
      for (const c of ctls.values()) c.abort();
      save();
      fn();
    };
    const startNext = () => {
      if (finished) return;
      const model = queue.shift();
      if (!model) {
        if (!running) finish(() => reject(last || new Error('All free Gemini quotas are used up for now. Try again later.')));
        return;
      }
      running++;
      const ctl = new AbortController();
      ctls.set(model, ctl);
      clearTimeout(hedge);
      hedge = setTimeout(() => { if (!leader && running < 2) startNext(); }, AI_HEDGE_MS);
      runModel(model, ctl.signal, (t) => {
        if (finished) return;
        if (!leader) {   // first words from anyone: this model wins, stop the others
          leader = model;
          clearTimeout(hedge);
          for (const [m, c] of ctls) if (m !== model) c.abort();
        }
        if (leader === model) onText?.(t);
      }).then((text) => {
        running--;
        ctls.delete(model);
        if (finished) return;
        if (text) {
          cache.good = model;
          delete cache.busy[model];
          return finish(() => resolve({ text, model }));
        }
        last = new Error(`${model} gave no answer`);
        if (leader === model) { leader = null; onText?.(''); }
        if (!running || !leader) startNext();
      }).catch((e) => {
        running--;
        ctls.delete(model);
        if (finished || e.status === 'lost') return;   // cancelled because another model answered
        last = e;
        if (model !== GROQ && (e.status === 403 || /API key/i.test(e.message))) return finish(() => reject(new Error(`Google rejected the key: ${e.message}`)));
        if (e.status === 401 && model === GROQ) cache.busy[model] = now + DAY;   // bad Groq key: ignore it today
        else if (e.status === 429) cache.exhausted[model] = now + (e.retry || (model === GROQ ? 60 : 3600)) * 1000;
        else if ([500, 502, 503, 504, 'timeout'].includes(e.status)) cache.busy[model] = now + AI_BUSY_MS;
        else if (e.status === 404) cache.busy[model] = now + DAY;   // listed but not served to this key
        // anything else (a dropped connection…): carry on with the others; if all fail, `last` explains
        if (cache.good === model) delete cache.good;
        if (leader === model) { leader = null; onText?.(''); }
        // Groq resting for just a few seconds (its per-minute limit): ask it again then, while
        // the next model works; whichever starts answering first wins
        if (model === GROQ && e.status === 429 && e.retry && e.retry <= 20 && !groqRetried) {
          groqRetried = true;
          setTimeout(() => {
            if (finished || leader) return;
            delete cache.exhausted[GROQ];
            queue.unshift(GROQ);
            startNext();
          }, e.retry * 1000);
        }
        if (!leader) startNext();
      });
    };
    // Groq resting for only a few more seconds: bring it in when it's back (racing the others)
    const groqBack = (cache.exhausted[GROQ] || 0) - Date.now();
    if (gkey && !groqQueued && groqBack > 0 && groqBack <= 20000 && (cache.busy[GROQ] || 0) <= now) {
      groqRetried = true;
      setTimeout(() => {
        if (finished || leader) return;
        delete cache.exhausted[GROQ];
        queue.unshift(GROQ);
        startNext();
      }, groqBack);
    }
    startNext();
  });
}

async function askViaLaptop(a) {
  if (!syncBase()) throw new Error('Add your Gemini key in Settings → Ask AI, or connect to your laptop.');
  const res = await sfetch('/sync/ask', {
    method: 'POST', timeout: 180000, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system: askSystem(a), contents: askContents(a) }),
  });
  return res.json();
}

// ---------------------------------------------------------------------
// Saved chats (text only; photos stay just for the current session)
// ---------------------------------------------------------------------
function askChats() { try { return JSON.parse(localStorage.getItem(AI_CHATS_LS) || '[]'); } catch { return []; } }
function askSaveChat(a) {
  const list = askChats().filter((c) => c.id !== a.id);
  list.unshift({ id: a.id, mode: a.mode, course: a.course, t: Date.now(),
    turns: a.turns.map((t) => ({ role: t.role, text: t.text, photos: (t.images || []).length || t.photos || 0 })) });
  try { localStorage.setItem(AI_CHATS_LS, JSON.stringify(list.slice(0, 20))); } catch { /* full */ }
}

// ---------------------------------------------------------------------
// View
// ---------------------------------------------------------------------
const askNew = (extra = {}) => ({ id: uid(), mode: 'hint', course: '', turns: [], busy: false, ...extra });

VIEWS.ask = () => {
  if (!state.ask) state.ask = askNew();
  const a = state.ask;
  const route = aiDirect() ? '' : syncBase() && (syncCfg.lastOk || onHubLaptop()) ? 'via your laptop' : null;
  const courses = unique([...allCourses(), a.course]);
  const chats = askChats().filter((c) => c.id !== a.id).slice(0, 6);
  return `
    ${route === null ? `<div class="card" style="margin-bottom:12px">🔑 <b>Set up Ask AI</b><div class="small muted" style="margin-top:4px">Add a free Gemini key in <b>Settings → Ask AI</b> to use it anywhere, or connect to your laptop (☰ → Sync with laptop).</div><button class="btn block" style="margin-top:8px" data-action="settings">Open Settings</button></div>` : ''}
    <div class="seg ask-modes">${Object.entries(AI_MODES).map(([k, [ic, label]]) => `<button class="${a.mode === k ? 'on' : ''}" data-action="ask-mode" data-mode="${k}">${ic} ${label}</button>`).join('')}</div>
    <div class="row" style="margin-bottom:10px">
      <select class="grow" data-action-change="ask-course" aria-label="Unit"><option value="">Any unit</option>${courses.map((c) => `<option ${c === a.course ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      ${a.turns.length ? '<button class="btn" data-action="ask-new">＋ New</button>' : ''}
    </div>
    <div class="ask-thread">
      ${a.turns.length ? a.turns.map((t) => `
        <div class="ask-msg ${t.role}">
          ${(t.images || []).map((d) => `<img src="${d}" alt="photo">`).join('')}${!t.images?.length && t.photos ? `<div class="small muted">📷 ${t.photos} photo${t.photos === 1 ? '' : 's'}</div>` : ''}
          ${t.text ? `<div class="rich">${rich(t.text)}</div>` : ''}
          ${t.model ? `<div class="small muted" style="margin-top:6px">${esc(t.model)}</div>` : ''}
        </div>`).join('')
      : `<div class="card empty"><span class="big">✨</span>Stuck on something in your notes? Open the PDF, slides or board photo in <b>Notes &amp; files</b>, tap <b>✨ Ask</b> and draw a box around the part you need help with. Or just type a question.<br><span class="small">${AI_MODES[a.mode][0]} <b>${AI_MODES[a.mode][1]}</b>: ${{ hint: 'nudges you toward the answer without giving it away', explain: 'explains the idea with an example', solve: 'full step-by-step solution', check: 'marks your working and finds the first mistake' }[a.mode]}.</span></div>`}
      ${a.busy ? '<div class="ask-msg model rich" id="askLive"><span class="muted">Thinking…</span></div>' : ''}
      ${a.error ? `<div class="card small" style="color:var(--red)">⚠️ ${esc(a.error)}</div>` : ''}
    </div>
    <form class="card ask-compose" data-form="ask">
      ${askDraft.images.length ? `<div class="ask-thumbs">${askDraft.images.map((d, i) => `<span><img src="${d}" alt=""><button type="button" data-action="ask-unphoto" data-i="${i}" aria-label="Remove">✕</button></span>`).join('')}</div>` : ''}
      <textarea name="text" rows="3" data-action-input="ask-text" placeholder="${a.turns.length ? 'Ask a follow-up…' : 'What do you need help with? (optional with a photo)'}">${esc(askDraft.text)}</textarea>
      <div class="row" style="margin-top:8px">
        <button type="button" class="btn small" data-action="ask-from-notes">📄 Select from my notes</button>
        <span class="grow"></span>
        <button class="btn primary" ${a.busy || route === null ? 'disabled' : ''}>Ask</button>
      </div>
      ${route ? `<p class="hint" style="margin:8px 2px 0">Going ${route}. Add your own key in Settings to use Ask AI without the laptop.</p>` : ''}
    </form>
    ${chats.length && !a.turns.length ? `<h2 class="section">Recent</h2>${chats.map((c) => `
      <div class="item"><button class="body" data-action="ask-open" data-id="${c.id}">
        <div class="title">${esc((c.turns.find((t) => t.role === 'user')?.text || '📷 Photo question').slice(0, 90))}</div>
        <div class="meta">${AI_MODES[c.mode]?.[0] || ''} ${c.course ? `${esc(c.course)} · ` : ''}${timeAgo(c.t)}</div></button></div>`).join('')}` : ''}`;
};
TITLES.ask = 'Ask AI';

/** Typing in the box shouldn't be wiped by a background redraw (e.g. after a sync). */
const _holdAsk = typeof examHoldRender === 'function' ? examHoldRender : () => false;
let askForce = false;
examHoldRender = () => _holdAsk() || (!askForce && state.tab === 'ask' && document.activeElement?.matches?.('.ask-compose textarea'));

/** Show the answer even if you're typing a follow-up; your text and cursor stay put. */
function askRenderKeepingFocus() {
  const ta = document.activeElement?.matches?.('.ask-compose textarea') ? document.activeElement : null;
  const sel = ta && [ta.selectionStart, ta.selectionEnd];
  if (ta) askDraft.text = ta.value;
  askForce = true;
  try { render(); } finally { askForce = false; }
  window.scrollTo(0, document.body.scrollHeight);
  if (ta) { const n = $('.ask-compose textarea'); n?.focus(); n?.setSelectionRange(...sel); }
}

async function askSend(form) {
  const a = state.ask;
  if (a.busy) return;
  if (form?.elements.text) askDraft.text = form.elements.text.value;
  document.activeElement?.blur?.();
  const text = askDraft.text.trim();
  if (!text && !askDraft.images.length) return toast('Type your question, or select part of your notes with ✨ Ask');
  const images = askDraft.images;
  const said = text || (a.mode === 'check' ? 'Check my working.' : 'Help me with this.');
  a.turns.push({ role: 'user', text: said, images, where: images.length ? askDraft.where : '' });
  askDraft = { text: '', images: [] };
  a.busy = true;
  a.error = '';
  render();
  window.scrollTo(0, document.body.scrollHeight);
  try {
    const r = aiDirect() ? await askDirect(a, aiKey(), (t) => askLive('#askLive', t)) : await askViaLaptop(a);
    a.turns.push({ role: 'model', text: r.text, model: r.model });
    askSaveChat(a);
  } catch (e) {
    const turn = a.turns.pop();   // let them retry without retyping
    askDraft = { text: askDraft.text || text, images: [...images, ...askDraft.images].slice(0, 4), where: turn.where };
    a.error = e.why || e.message;
  } finally {
    a.busy = false;
    if (state.tab === 'ask') askRenderKeepingFocus();
  }
}

FORMS.ask = (form) => askSend(form);
Object.assign(ACTIONS, {
  'ask-mode': (el) => { state.ask.mode = el.dataset.mode; render(); },
  'ask-new': () => { state.ask = askNew({ mode: state.ask.mode, course: state.ask.course }); askDraft = { text: '', images: [] }; render(); },
  'ask-unphoto': (el) => { askDraft.images.splice(Number(el.dataset.i), 1); render(); },
  'ask-open': (el) => {
    const c = askChats().find((x) => x.id === el.dataset.id);
    if (c) state.ask = { ...askNew(), ...c, turns: c.turns.map((t) => ({ ...t, images: [] })) };
    render();
  },
  /** ✨ Ask in the PDF viewer: pick part of the page you're on. */
  'viewer-ask': () => {
    const v = $('#viewer');
    if (!viewerPages) return toast('Wait for the pages to appear first');
    const placeholders = [...v.querySelectorAll('.page')];
    const mid = window.innerHeight / 2;
    const near = placeholders.sort((x, y) => Math.abs(x.getBoundingClientRect().top + x.getBoundingClientRect().height / 2 - mid)
      - Math.abs(y.getBoundingClientRect().top + y.getBoundingClientRect().height / 2 - mid))[0];
    const f = byId('files', v.dataset.id);
    const unit = v.dataset.kind === 'slides' ? 'slide' : 'page';
    openCropper({
      start: viewerPages.current?.() || Number(near?.dataset.page) || 1,
      pages: viewerPages,
      onPick: (img, n) => askInPlace(img, f, `${f?.name || 'notes'}, ${unit} ${n}`),
    });
  },
  /** ✨ Ask on a photo (board photos, pictures in your files). */
  'image-ask': (el) => {
    const f = byId('files', el.dataset.id);
    openCropper({
      pages: { count: 1, render: () => imageCanvas(fileURL(f)) },
      onPick: (img) => askInPlace(img, f, f.name),
    });
  },
  'ask-from-notes': () => {
    go('notes');
    state.notesMode = 'files';
    render();
    toast('Open a PDF, slides or photo, then tap ✨ Ask');
  },
  // Settings → Ask AI
  async 'ai-key-save'() {
    const input = $('#aiKeyInput');
    const k = (input?.value || '').trim();
    if (!k) return toast('Paste your key first');
    const btn = $('[data-action="ai-key-save"]');
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      await aiFetch('models?pageSize=5', null, k, 20000);
      localStorage.setItem(AI_KEY_LS, k);
      localStorage.removeItem(AI_MODELS_LS);
      toast('✅ Key works. Ask AI now talks to Google directly');
    } catch (e) {
      toast(e.status === 'offline' ? 'No internet: connect and try again' : `That key didn't work: ${e.message}`);
    }
    settingsSheet();
  },
  async 'groq-key-save'() {
    const input = $('#groqKeyInput');
    const k = (input?.value || '').trim();
    if (!k) return toast('Paste your Groq key first');
    if (k.startsWith('xai-')) return toast("That's an xAI (Grok) key. StudyHub uses Groq: console.groq.com, keys start with gsk_");
    const btn = $('[data-action="groq-key-save"]');
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const r = await fetch(`${GROQ_API}/models`, { headers: { Authorization: `Bearer ${k}` } });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error || {}).message || `Groq answered ${r.status}`);
      localStorage.setItem(AI_GROQ_LS, k);
      toast('✅ Groq key works. Ask AI tries Groq first (fast), then Gemini');
    } catch (e) {
      toast(e instanceof TypeError ? 'No internet: connect and try again' : `That key didn't work: ${e.message}`);
    }
    settingsSheet();
  },
  'groq-key-remove': () => {
    if (!confirm('Remove the Groq key from this phone?')) return;
    try { localStorage.removeItem(AI_GROQ_LS); } catch { /* ignore */ }
    settingsSheet();
  },
  'ai-key-remove': () => {
    if (!confirm('Remove the Gemini key from this phone? Ask AI will then go through your laptop.')) return;
    try { localStorage.removeItem(AI_KEY_LS); } catch { /* ignore */ }
    settingsSheet();
  },
});
CHANGE_ACTIONS['ask-course'] = (el) => { state.ask.course = el.value; };
INPUT_ACTIONS['ask-text'] = (el) => { askDraft.text = el.value; };

// ---------------------------------------------------------------------
// Ask in place: select part of a page → a panel slides up over it with the answer.
// The page stays open underneath; follow-ups happen in the panel.
// ---------------------------------------------------------------------
let askPanel = null;   // { chat, error, min }
const askPanelOpen = () => !!askPanel;
const askRequest = (a, onText) => (aiDirect() ? askDirect(a, aiKey(), onText) : askViaLaptop(a));

/** Show an answer as it streams in (the box is replaced by the finished answer afterwards). */
let askLiveAt = 0;
function askLive(sel, text) {
  const el = document.querySelector(sel);
  if (!el) return;
  if (!text) {   // (re)starting, e.g. the next model took over
    el.innerHTML = sel === '#apLive' ? '<div class="ap-thinking"><span></span><span></span><span></span> Thinking…</div>' : '<span class="muted">Thinking…</span>';
    return;
  }
  const now = Date.now();
  if (now - askLiveAt < 120) return;   // redraw at most ~8 times a second
  askLiveAt = now;
  el.innerHTML = rich(text);
  if (sel === '#apLive') { const body = el.closest('.ap-body'); if (body) body.scrollTop = body.scrollHeight; }
}
const AP_CHIPS = [
  ['Simpler', 'Explain that more simply, as if I am seeing it for the first time.'],
  ['Give an example', 'Give me a short worked example of this.'],
  ['Step by step', 'Go through it step by step, saying why each step is done.'],
  ['Quiz me', 'Ask me one quick question to check I understood. Wait for my answer.'],
];

function askInPlace(img, f, where) {
  const chat = askNew({ mode: 'explain', course: f?.course || '' });
  chat.turns.push({ role: 'user', text: 'Explain this part of my notes: what it means and why. If it is a question or exercise, explain how to approach it.', images: [img], where, auto: true });
  askPanel = { chat, error: '', min: false };
  apBuild();
  apRun();
}

function apBuild() {
  let el = $('#askPanel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'askPanel';
    el.className = 'ask-panel';
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div class="ap-head" data-action="ap-min">
      <span class="ap-grip"></span>
      <b>✨ Ask AI</b><span class="grow"></span>
      <button class="btn small" data-action="ap-full">Continue in Ask AI</button>
      <button class="btn small" data-action="ap-close" aria-label="Close">✕</button>
    </div>
    <div class="ap-body"></div>
    <div class="ap-foot">
      <div class="ap-chips">${AP_CHIPS.map(([label], i) => `<button class="chip" data-action="ap-chip" data-i="${i}">${label}</button>`).join('')}</div>
      <form class="row" data-form="ap-ask">
        <input type="text" name="text" class="grow" autocomplete="off" enterkeyhint="send" placeholder="Ask a follow-up…">
        <button class="btn primary">Send</button>
      </form>
    </div>`;
  el.classList.remove('min');
  requestAnimationFrame(() => el.classList.add('open'));
}

/** Redraw the conversation only, so a follow-up you're typing is never disturbed. */
function apDraw() {
  const p = askPanel;
  const el = $('#askPanel');
  if (!p || !el) return;
  const c = p.chat;
  el.classList.toggle('min', p.min);
  el.querySelector('.ap-body').innerHTML = c.turns.map((t) => t.role === 'user'
    ? `<div class="ap-q">${(t.images || []).map((d) => `<img src="${d}" alt="your selection">`).join('')}${t.auto ? '' : `<div class="ask-msg user">${rich(t.text)}</div>`}</div>`
    : `<div class="ap-a rich">${rich(t.text)}</div>`).join('')
    + (c.busy ? '<div class="ap-a rich" id="apLive"><div class="ap-thinking"><span></span><span></span><span></span> Thinking…</div></div>' : '')
    + (p.error ? `<div class="ap-err">⚠️ ${esc(p.error)} <button class="btn small" data-action="ap-retry">Try again</button></div>` : '');
  el.querySelectorAll('.ap-foot button').forEach((b) => { b.disabled = c.busy; });
  const body = el.querySelector('.ap-body');
  body.scrollTop = body.scrollHeight;
}

async function apRun() {
  const p = askPanel;
  p.chat.busy = true;
  p.error = '';
  apDraw();
  try {
    const r = await askRequest(p.chat, (t) => askLive('#apLive', t));
    p.chat.turns.push({ role: 'model', text: r.text, model: r.model });
    askSaveChat(p.chat);
  } catch (e) {
    p.error = e.why || e.message;   // the question stays; "Try again" resends it
  } finally {
    p.chat.busy = false;
    if (askPanel === p) apDraw();
  }
}

function apFollow(text) {
  const p = askPanel;
  if (!p || p.chat.busy || !text.trim()) return;
  p.chat.turns.push({ role: 'user', text: text.trim() });
  p.min = false;
  apRun();
}

function closeAskPanel() {
  askPanel = null;
  const el = $('#askPanel');
  if (el) { el.classList.remove('open'); setTimeout(() => { if (!askPanel) el.innerHTML = ''; }, 250); }
}

FORMS['ap-ask'] = (form) => { const t = form.elements.text.value; form.elements.text.value = ''; form.elements.text.blur(); apFollow(t); };
Object.assign(ACTIONS, {
  'ap-close': () => closeAskPanel(),
  'ap-retry': () => apRun(),
  'ap-chip': (el) => apFollow(AP_CHIPS[Number(el.dataset.i)][1]),
  'ap-min': (el, e) => {
    if (e?.target.closest('button')) return;   // the buttons in the header do their own thing
    askPanel.min = !askPanel.min;
    apDraw();
  },
  'ap-full': () => {
    const chat = askPanel.chat;
    closeAskPanel();
    if (!$('#viewer').classList.contains('hidden')) closeViewer();
    if (sheetOpen()) closeSheet();
    state.ask = chat;
    askDraft = { text: '', images: [] };
    go('ask');
  },
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && askPanelOpen() && !cropperOpen()) { e.stopImmediatePropagation(); closeAskPanel(); } }, true);

function imageCanvas(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 2400 / Math.max(img.width, img.height));
      const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c);
    };
    img.onerror = () => reject(new Error("Couldn't load the picture"));
    img.src = src;
  });
}

/** Settings section (inserted by settingsSheet). */
function askSettingsSection() {
  const k = aiKey();
  return `
    <h4 class="sub">Ask AI</h4>
    <div class="card" style="margin-bottom:16px">
      ${k ? `<div class="row"><span class="grow">Gemini key on this phone</span><span class="muted small">•••• ${esc(k.slice(-4))} ✓</span></div>
        <p class="hint" style="margin:6px 2px 10px">Ask AI talks to Google directly, so it works anywhere with internet.</p>
        <button class="btn block danger" data-action="ai-key-remove">Remove key</button>`
      : `<p class="small muted" style="margin-top:0">Without a key here, Ask AI goes through your laptop. With one, it works anywhere with internet. Get a free key at <b>aistudio.google.com → Get API key</b> (the same one your laptop uses is fine).</p>
        <label class="field"><span>Gemini API key</span><input type="password" id="aiKeyInput" autocomplete="off" placeholder="Paste your key"></label>
        <button class="btn block" data-action="ai-key-save">Save and check key</button>
        <p class="hint" style="margin:10px 2px 0">Kept only on this phone: not synced, not in backups.</p>`}
    </div>
    <div class="card" style="margin-bottom:16px">
      ${groqKey() ? `<div class="row"><span class="grow">Groq key on this phone</span><span class="muted small">•••• ${esc(groqKey().slice(-4))} ✓</span></div>
        <p class="hint" style="margin:6px 2px 10px">Asked first: answers in a second or two. Free plan: about 3 picture questions a minute; beyond that Gemini answers.</p>
        <button class="btn block danger" data-action="groq-key-remove">Remove Groq key</button>`
      : `<p class="small muted" style="margin-top:0"><b>Faster answers (optional):</b> a free key from <b>console.groq.com → API Keys</b> (Groq with a <b>q</b>; keys start with <code>gsk_</code>). It's tried first and answers in a second or two; Gemini takes over when it's busy.</p>
        <label class="field"><span>Groq API key</span><input type="password" id="groqKeyInput" autocomplete="off" placeholder="gsk_…"></label>
        <button class="btn block" data-action="groq-key-save">Save and check key</button>`}
    </div>`;
}
