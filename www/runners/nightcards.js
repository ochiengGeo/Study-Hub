/* StudyHub nightly flashcards: Android's background runner (@capacitor/background-runner).
 *
 * This file does NOT run in the app's page: Android starts it about once an hour (even with the
 * app closed) in a small JavaScript engine with fetch, timers, a key-value store (CapacitorKV)
 * and notifications. It can't open your files, so the app prepares the work while you use it
 * (nightcards.js: each unit's next pages of notes + the prompt) and this only:
 *   1. checks it's night, there's internet, and a unit is due (a week since its last batch),
 *   2. sends that unit's pages to Gemini and keeps the cards it writes,
 *   3. posts "new flashcards" in the notification panel.
 * The app adds the cards to your decks the next time it opens (and sync takes them to the laptop).
 *
 * KV keys:  cfg (settings + key + models)  jobs (prepared units)  results (cards waiting for the app)
 *           state (per unit: last run, cards added, model, error; per model: resting until)
 */

const API = 'https://generativelanguage.googleapis.com/v1beta';
const WEEK = 7 * 24 * 3600 * 1000;
const PER_RUN = 3;                       // units per wake-up (Android allows ~10 minutes)
const BUDGET_MS = 7 * 60 * 1000;
const CARD_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: { front: { type: 'STRING' }, back: { type: 'STRING' }, topic: { type: 'STRING' }, file: { type: 'STRING' } },
    required: ['front', 'back'],
  },
};

function kvGet(k, dflt) {
  try {
    const r = CapacitorKV.get(k);
    const v = r && r.value;
    return v ? JSON.parse(v) : dflt;
  } catch (e) {
    return dflt;
  }
}
function kvSet(k, v) { CapacitorKV.set(k, JSON.stringify(v)); }

function isNight(cfg, d) {
  const h = d.getHours();
  const from = cfg.from ?? 1, to = cfg.to ?? 6;
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

async function gemini(cfg, state, job) {
  const now = Date.now();
  state.models = state.models || {};
  let best = null, last = 'no model available';
  for (const model of cfg.models || []) {
    if ((state.models[model] || 0) > now) continue;
    const body = {
      contents: [{ role: 'user', parts: [...job.parts, { text: job.prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: CARD_SCHEMA, maxOutputTokens: 16000 },
    };
    let res, json;
    try {
      res = await fetch(`${API}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key },
        body: JSON.stringify(body),
      });
      json = await res.json();
    } catch (e) {
      last = `no connection (${e && e.message})`;
      break;
    }
    if (!res.ok) {
      const msg = ((json && json.error) || {}).message || `HTTP ${res.status}`;
      last = `${model}: ${msg.slice(0, 120)}`;
      if (res.status === 429) state.models[model] = now + 3 * 3600 * 1000;          // free daily limit
      else if (res.status === 404) state.models[model] = now + 7 * 24 * 3600 * 1000; // not for this key
      else if (res.status >= 500) state.models[model] = now + 20 * 60 * 1000;      // busy
      else if (res.status === 400 || res.status === 403) break;                    // bad key / request
      continue;
    }
    const text = (((json.candidates || [])[0] || {}).content || { parts: [] }).parts
      .filter((p) => !p.thought).map((p) => p.text || '').join('');
    let cards = [];
    try { cards = JSON.parse(text); } catch (e) { cards = []; }
    cards = (Array.isArray(cards) ? cards : [])
      .filter((c) => c && typeof c.front === 'string' && typeof c.back === 'string' && c.front.trim() && c.back.trim())
      .slice(0, 20);
    if (!best || cards.length > best.cards.length) best = { cards, model };
    if (cards.length >= 3) return best;   // a good batch
    last = `${model}: only ${cards.length} usable cards`;
  }
  if (best && best.cards.length) return best;
  throw new Error(last);
}

/** Do due units. force: ignore the night window and the weekly wait (the app's "Run now"). */
async function work(force, only) {
  const cfg = kvGet('cfg', {});
  const out = { ran: [], skipped: '' };
  if (!cfg.on && !force) { out.skipped = 'off'; return out; }
  if (!cfg.key) { out.skipped = 'no Gemini key on this phone'; return out; }
  if (!force && !isNight(cfg, new Date())) { out.skipped = 'not night'; return out; }
  try {
    const net = CapacitorDevice.getNetworkStatus();
    if (net && net.connected === false) { out.skipped = 'offline'; return out; }
  } catch (e) { /* unknown: just try */ }

  const jobs = kvGet('jobs', []);
  const state = kvGet('state', {});
  state.units = state.units || {};
  const results = kvGet('results', []);
  const waiting = new Set(results.map((r) => r.jobId));
  const started = Date.now();
  const due = jobs.filter((j) => (!only || j.course === only) && !waiting.has(j.id)
    && (force || Date.now() - ((state.units[j.course] || {}).lastRun || 0) > WEEK - 6 * 3600 * 1000));

  for (const job of due.slice(0, force ? 6 : PER_RUN)) {
    if (Date.now() - started > BUDGET_MS) break;
    const u = state.units[job.course] = state.units[job.course] || {};
    try {
      const r = await gemini(cfg, state, job);
      results.push({ jobId: job.id, course: job.course, deck: job.deck, labels: job.labels, cards: r.cards, model: r.model, at: Date.now() });
      Object.assign(u, { lastRun: Date.now(), added: r.cards.length, model: r.model, error: '' });
      out.ran.push({ course: job.course, deck: job.deck, added: r.cards.length });
    } catch (e) {
      Object.assign(u, { error: String((e && e.message) || e).slice(0, 200), triedAt: Date.now() });
      out.ran.push({ course: job.course, deck: job.deck, added: 0, error: u.error });
    }
    kvSet('results', results);
    kvSet('state', state);
  }

  const made = out.ran.filter((r) => r.added);
  if (made.length && !force) {
    const total = made.reduce((n, r) => n + r.added, 0);
    const list = made.map((r) => `${r.deck} (+${r.added})`).join('\n');
    try {
      CapacitorNotifications.schedule([{
        id: 734001,
        title: `🃏 ${total} new flashcards ready`,
        body: made.map((r) => r.course).join(', ') + ' · open StudyHub to review',
        largeBody: `${list}\n\nOpen StudyHub to add them to your decks.`,
        channelId: 'reminders',
        autoCancel: true,
        smallIcon: 'ic_stat_studyhub',
      }]);
    } catch (e) { console.warn('notify failed', e); }
  }
  return out;
}

// Android wakes us about once an hour
addEventListener('nightCards', async (resolve, reject) => {
  try { await work(false); resolve(); } catch (e) { console.error(e); resolve(); }
});

// The app hands over settings and the prepared units
addEventListener('prepare', (resolve, reject, args) => {
  try {
    if (args && args.cfg) kvSet('cfg', args.cfg);
    if (args && args.jobs) kvSet('jobs', args.jobs);
    resolve({ ok: true, state: kvGet('state', {}), waiting: kvGet('results', []).length });
  } catch (e) { reject(e); }
});

// The app collects the cards made since it last looked
addEventListener('collect', (resolve, reject) => {
  try { resolve({ results: kvGet('results', []), state: kvGet('state', {}) }); } catch (e) { reject(e); }
});

// ...and confirms they're saved, so they can be forgotten here
addEventListener('ack', (resolve, reject, args) => {
  try {
    const done = new Set((args && args.jobIds) || []);
    kvSet('results', kvGet('results', []).filter((r) => !done.has(r.jobId)));
    resolve({ ok: true });
  } catch (e) { reject(e); }
});

// "Run now" in the app (testing, or not wanting to wait for the night)
addEventListener('runNow', async (resolve, reject, args) => {
  try { resolve(await work(true, args && args.course)); } catch (e) { reject(e); }
});
