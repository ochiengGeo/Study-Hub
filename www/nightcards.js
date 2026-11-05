'use strict';
/* Nightly AI flashcards made by the PHONE itself (Android app only), so new cards arrive each week
 * even without the laptop.
 *
 * Android runs runners/nightcards.js in the background about once an hour; at night (1–6 am by
 * default) it sends a unit's next pages of notes to Gemini, keeps the cards and posts a
 * notification. That runner can't open files, so this side, while you use the app:
 *   - prepares each due unit's next pages (text from PDFs / slides / Word; up to 2 pictures of
 *     scanned pages) and the prompt, and hands them over (event "prepare");
 *   - collects the finished cards when the app opens (event "collect"), adds them to that unit's
 *     deck (same ids as the laptop's, so nothing doubles up when they sync), then confirms ("ack").
 * A unit is skipped while it got AI cards (from the laptop or the phone) in the last 6 days. */

const NIGHT_LS = 'studyhub-night';           // { on, from, to }
const NIGHT_POS_LS = 'studyhub-night-pos';   // { fileId: next page }
const NIGHT_JOBS_LS = 'studyhub-night-jobs'; // { jobId: { fileId: page to continue from } }
const NIGHT_PREP_LS = 'studyhub-night-prep'; // { at, sig, units: [{course, deck, pages, pics}] }
const NIGHT_LABEL = 'com.studyhub.app.nightcards';
const NIGHT_CATEGORIES = ['Lecture notes', 'Books', 'Slides'];
const NIGHT_PER_WEEK = 12;
const NIGHT_TEXT_PAGES = 25, NIGHT_MAX_TEXT = 60000, NIGHT_PICS = 2;

const BR = NATIVE && window.Capacitor ? window.Capacitor.registerPlugin('CapacitorBackgroundRunner') : null;

const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full */ } };
const nightCfg = () => ({ on: true, from: 1, to: 6, ...lsGet(NIGHT_LS, {}) });
const nightNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
let nightState = null;   // the runner's state (per unit: lastRun, added, model, error)
let nightBusy = '';

async function nightCall(event, details = {}) {
  if (!BR) throw new Error('only in the Android app');
  return BR.dispatchEvent({ label: NIGHT_LABEL, event, details });
}

// ---------------------------------------------------------------------
// Units and their notes
// ---------------------------------------------------------------------
function nightUnits() {
  const units = new Map();
  for (const f of data.files) {
    const course = (f.course || '').trim();
    if (!course || !NIGHT_CATEGORIES.includes(f.category) || !hasLocal(f)) continue;
    const ext = (f.ext || '').toLowerCase();
    if (!(ext === 'pdf' || f.type === 'application/pdf' || ['pptx', 'docx'].includes(ext))) continue;
    const k = nightNorm(course);
    if (!units.has(k)) {
      const cls = data.classes.find((c) => nightNorm(c.course) === k && c.title);
      units.set(k, { course, deck: unitDeck(course) || (cls ? `${course} · ${cls.title}` : course), files: [] });
    }
    units.get(k).files.push(f);
  }
  for (const u of units.values()) u.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return [...units.values()];
}

/** Cards of a unit (any deck), and whether it got AI cards in the last 6 days. */
function nightUnitCards(u) {
  const k = nightNorm(u.course);
  return data.cards.filter((c) => nightNorm(c.course) === k || c.deck === u.deck);
}
const nightRecent = (u) => nightUnitCards(u).some((c) => c.source === 'ai' && (c.created || 0) > Date.now() - 6 * DAY);

/** Pages of one file: [{ text, pic? (lazy) }] */
async function nightPages(f) {
  const ext = (f.ext || '').toLowerCase();
  const bytes = await fileBytes(f);
  if (ext === 'pptx' || ext === 'docx') {
    await loadScript('jszip.min.js');
    const zip = await window.JSZip.loadAsync(bytes);
    const xmlText = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'g'))].map((m) => m[1]).join(' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    if (ext === 'pptx') {
      const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
      const out = [];
      for (const n of names) out.push({ text: xmlText(await zip.file(n).async('string'), 'a:t') });
      return out;
    }
    const doc = await zip.file('word/document.xml')?.async('string') || '';
    const paras = doc.split('</w:p>').map((p) => xmlText(p, 'w:t')).filter((t) => t.trim());
    const out = [];
    let cur = '';
    for (const p of paras) { cur += `${p}\n`; if (cur.length > 3000) { out.push({ text: cur }); cur = ''; } }
    if (cur.trim()) out.push({ text: cur });
    return out;
  }
  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({ data: new Uint8Array(bytes) }).promise;
  const out = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const tc = await (await pdf.getPage(n)).getTextContent();
    const text = tc.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
    out.push({
      text,
      scanned: text.split(' ').filter(Boolean).length < 40,
      pic: async () => (await renderPageCanvas(pdf, n, 900)).toDataURL('image/jpeg', 0.6).split(',')[1],
    });
  }
  out.done = () => pdf.destroy();
  return out;
}

/** The next slice of a unit's notes, continuing where the last batch stopped. */
async function nightSlice(u, pos) {
  const parts = [], labels = [], advance = {};
  let pages = 0, chars = 0, pics = 0;
  const all = u.files.map((f) => f.id);
  if (all.every((id) => pos[id] === 'done')) all.forEach((id) => { pos[id] = 0; });   // all read: start a new pass
  for (const f of u.files) {
    if (pages >= NIGHT_TEXT_PAGES || chars >= NIGHT_MAX_TEXT) break;
    if (pos[f.id] === 'done') continue;
    let list;
    try { list = await nightPages(f); } catch (e) { console.warn('night: read', f.name, e); continue; }
    let i = Number(pos[f.id]) || 0;
    const start = i;
    while (i < list.length && pages < NIGHT_TEXT_PAGES && chars < NIGHT_MAX_TEXT) {
      const p = list[i];
      if (p.scanned && p.pic) {
        if (pics >= NIGHT_PICS) break;
        parts.push({ text: `--- ${f.name}, page ${i + 1} (scanned) ---` }, { inline_data: { mime_type: 'image/jpeg', data: await p.pic() } });
        pics++;
      } else if (p.text.trim()) {
        const t = p.text.slice(0, NIGHT_MAX_TEXT - chars);
        parts.push({ text: `--- ${f.name}, ${f.ext === 'pptx' ? 'slide' : 'page'} ${i + 1} ---\n${t}` });
        chars += t.length;
      }
      pages++;
      i++;
    }
    list.done?.();
    if (i > start) labels.push(`${f.name} ${f.ext === 'pptx' ? 'slides' : 'pages'} ${start + 1}–${i}`);
    advance[f.id] = i >= list.length ? 'done' : i;
  }
  return { parts, labels, advance, pages, pics };
}

function nightPrompt(u, labels) {
  const have = nightUnitCards(u).slice(-150).map((c) => `- ${String(c.front || '').slice(0, 160)}`).join('\n') || '(none yet)';
  return `You are making flashcards for a university student revising the unit ${u.deck}.
Above is part of the unit's notes (${labels.join('; ')}).

Write ${NIGHT_PER_WEEK} new flashcards based ONLY on these pages. Write fewer only if the pages
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
- Formatting the app understands: \`inline code\`, \`\`\`code blocks\`\`\`, **bold**, new lines, and
  maths in LaTeX: inline $...$ or displayed $$...$$, e.g. $\\int x^2\\,dx = \\frac{x^3}{3} + C$.
  In the JSON, escape backslashes as usual (\\\\frac).
- Do not repeat or rephrase any of these questions the student already has:
${have}

Reply with ONLY a JSON array, no other text. Each item: {"front": ..., "back": ...,
"topic": 2-5 words, "file": the file name and pages it came from}.`;
}

// ---------------------------------------------------------------------
// Prepare (while the app is open) and collect (when it opens)
// ---------------------------------------------------------------------
async function nightModels() {
  const key = aiKey();
  if (!key) return [];
  try {
    const cache = await aiModels(key);
    return (cache.list || []).filter((m) => m.startsWith('gemini-'));   // JSON mode needs Gemini (not Gemma)
  } catch {
    return [];
  }
}

/** Hand the runner the settings and each due unit's next pages. Cheap to call: it skips the
 * work when nothing changed in the last few hours. */
async function nightPrepare({ force = false } = {}) {
  if (!BR || nightBusy) return;
  const cfg = nightCfg();
  const units = nightUnits();
  const sig = JSON.stringify([cfg, !!aiKey(), units.map((u) => [u.course, u.files.map((f) => f.id)]), units.map(nightRecent)]);
  const prev = lsGet(NIGHT_PREP_LS, {});
  if (!force && prev.sig === sig && Date.now() - (prev.at || 0) < 6 * HOUR) return;
  nightBusy = 'Preparing your notes…';
  try {
    const pos = lsGet(NIGHT_POS_LS, {});
    const jobsMeta = {};
    const jobs = [];
    const summary = [];
    for (const u of cfg.on && aiKey() ? units : []) {
      if (nightRecent(u)) { summary.push({ course: u.course, deck: u.deck, recent: true }); continue; }
      const s = await nightSlice(u, { ...pos });
      if (!s.parts.length) { summary.push({ course: u.course, deck: u.deck, empty: true }); continue; }
      const id = `${nightNorm(u.course)}-${Date.now().toString(36)}`;
      jobs.push({ id, course: u.course, deck: u.deck, labels: s.labels, parts: s.parts, prompt: nightPrompt(u, s.labels) });
      jobsMeta[id] = s.advance;
      summary.push({ course: u.course, deck: u.deck, pages: s.pages, pics: s.pics, labels: s.labels });
    }
    // keep what's handed over modest (Android stores it as app preferences)
    let size = JSON.stringify(jobs).length;
    for (const j of jobs) {
      if (size < 1.5e6) break;
      const before = JSON.stringify(j).length;
      j.parts = j.parts.filter((p) => !p.inline_data);
      size -= before - JSON.stringify(j).length;
    }
    const keep = lsGet(NIGHT_JOBS_LS, {});
    lsSet(NIGHT_JOBS_LS, { ...keep, ...jobsMeta });
    const r = await nightCall('prepare', {
      cfg: { on: cfg.on, from: cfg.from, to: cfg.to, key: aiKey(), models: await nightModels() },
      jobs,
    });
    nightState = r?.state || nightState;
    lsSet(NIGHT_PREP_LS, { at: Date.now(), sig, units: summary });
  } catch (e) {
    console.warn('night prepare', e);
  } finally {
    nightBusy = '';
  }
}

/** Card id shared with the laptop (cardgen.py): 'ai-' + sha1(course|front)[:24] */
async function nightCardId(course, front) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${nightNorm(course)}|${nightNorm(front)}`));
  return `ai-${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24)}`;
}

/** Add the cards the runner made since the app last looked. Returns how many were new. */
async function nightCollect({ quiet = false } = {}) {
  if (!BR) return 0;
  let r;
  try { r = await nightCall('collect'); } catch (e) { console.warn('night collect', e); return 0; }
  nightState = r?.state || nightState;
  const results = r?.results || [];
  if (!results.length) return 0;
  const tombs = new Set((await dbAll('tombs')).map((t) => t.id));
  const pos = lsGet(NIGHT_POS_LS, {});
  const meta = lsGet(NIGHT_JOBS_LS, {});
  let added = 0;
  const decks = new Set();
  for (const res of results) {
    for (const c of res.cards || []) {
      const front = String(c.front).trim(), back = String(c.back).trim();
      const id = await nightCardId(res.course, front);
      if (byId('cards', id) || tombs.has(`cards:${id}`)) continue;   // already have it, or you deleted it
      const now = Date.now();
      await dbPut('cards', {
        id, deck: res.deck, front, back, created: now, due: now, interval: 0, ease: 2.5, reps: 0, lapses: 0,
        source: 'ai', course: res.course, topic: String(c.topic || '').slice(0, 80),
        from: String(c.file || (res.labels || [])[0] || '').slice(0, 120), madeBy: 'phone',
      });
      added++;
      decks.add(res.deck);
    }
    Object.assign(pos, meta[res.jobId] || {});   // next batch continues after these pages
    delete meta[res.jobId];
  }
  lsSet(NIGHT_POS_LS, pos);
  lsSet(NIGHT_JOBS_LS, meta);
  await nightCall('ack', { jobIds: results.map((x) => x.jobId) }).catch(() => {});
  await loadAll();
  if (added && !quiet) toast(`🃏 ${added} new flashcard${added === 1 ? '' : 's'}: ${[...decks].join(', ')}`);
  lsSet(NIGHT_PREP_LS, { ...lsGet(NIGHT_PREP_LS, {}), at: 0 });   // prepare the next pages
  setTimeout(() => nightPrepare(), 3000);
  return added;
}

// ---------------------------------------------------------------------
// UI: a row in the Flashcards tab and its sheet
// ---------------------------------------------------------------------
function nightPanel() {
  if (!BR) return '';
  const cfg = nightCfg();
  const sub = !aiKey() ? 'Needs a Gemini key (Settings → Ask AI)' : !cfg.on ? 'Off' : `Every week, at night (${cfg.from}–${cfg.to} am) · from your downloaded notes`;
  return `<button class="nudge" data-action="night-sheet">🌙 <span><b>Nightly cards on this phone</b><br><span class="small muted">${esc(sub)}</span></span>${ICON.chevron}</button>`;
}

async function nightSheet() {
  openSheet('<h3>🌙 Nightly flashcards</h3><div id="nightPanel"><p class="muted">Loading…</p></div>');
  try { nightState = (await nightCall('collect'))?.state || nightState; } catch { /* runner not ready */ }
  nightDraw();
}

function nightDraw() {
  const el = $('#nightPanel');
  if (!el) return;
  const cfg = nightCfg();
  const prep = lsGet(NIGHT_PREP_LS, {});
  const st = (nightState && nightState.units) || {};
  const units = nightUnits();
  const missing = data.files.filter((f) => f.course && NIGHT_CATEGORIES.includes(f.category) && !hasLocal(f));
  const row = (u) => {
    const p = (prep.units || []).find((x) => nightNorm(x.course) === nightNorm(u.course)) || {};
    const s = st[u.course] || {};
    const n = nightUnitCards(u).filter((c) => c.source === 'ai').length;
    return `<div class="card ai-unit"><b>${esc(u.deck)}</b>
      <div class="small muted">${u.files.length} note file${u.files.length === 1 ? '' : 's'} on this phone · ${n} AI card${n === 1 ? '' : 's'}</div>
      <div class="small" style="margin-top:4px">
        ${s.error ? `<span style="color:var(--red)">⚠️ ${esc(s.error)}</span><br>` : ''}
        ${s.lastRun ? `<span class="muted">Last batch ${timeAgo(s.lastRun)} (+${s.added}${s.model ? `, ${esc(s.model)}` : ''})</span><br>` : ''}
        ${p.recent ? '<span class="muted">Got new AI cards this week: next batch next week</span>'
          : p.pages ? `<span class="muted">Ready for tonight: ${esc((p.labels || []).join('; '))}${p.pics ? ` (${p.pics} scanned page${p.pics === 1 ? '' : 's'})` : ''}</span>`
          : p.empty ? '<span class="muted">No readable text found in these notes</span>'
          : '<span class="muted">Not prepared yet</span>'}
      </div></div>`;
  };
  el.innerHTML = `
    <p class="muted small" style="margin-top:-8px">Once a week, at night while you're not using the phone, StudyHub sends each unit's next pages of notes to Google's Gemini and adds up to ${NIGHT_PER_WEEK} new cards to that unit's deck. You get a notification when they're ready. A unit is skipped in a week it already got AI cards (e.g. from the laptop).</p>
    ${aiKey() ? '' : '<div class="card" style="margin-bottom:12px"><div class="small">🔑 <b>Add your Gemini key first</b> in Settings → Ask AI.</div></div>'}
    <label class="checkline"><input type="checkbox" data-action-change="night-on" ${cfg.on ? 'checked' : ''}> Make new cards every week at night</label>
    <label class="field"><span>Night window</span><select data-action-change="night-window">
      ${[[0, 5], [1, 6], [2, 7], [23, 5]].map(([a, b]) => `<option value="${a}-${b}" ${cfg.from === a && cfg.to === b ? 'selected' : ''}>${a === 0 ? 12 : a > 12 ? a - 12 : a} ${a >= 12 ? 'pm' : 'am'} – ${b} am</option>`).join('')}
    </select></label>
    ${units.length ? units.map(row).join('') : '<div class="card empty">No unit notes on this phone yet.<br><span class="small">Download notes (⬇ in Files) filed as Lecture notes, Books or Slides with a unit set.</span></div>'}
    ${missing.length ? `<p class="hint">${missing.length} note file${missing.length === 1 ? ' is' : 's are'} only on the laptop: download ${missing.length === 1 ? 'it' : 'them'} (⬇ in Files) to include ${missing.length === 1 ? 'it' : 'them'}.</p>` : ''}
    <div class="row wrap" style="margin-top:10px">
      <button class="btn" data-action="night-prepare" ${nightBusy ? 'disabled' : ''}>${nightBusy ? '⏳ Preparing…' : '↻ Prepare again'}</button>
      <button class="btn primary grow" data-action="night-run" ${!aiKey() || nightBusy ? 'disabled' : ''}>✨ Make this week's cards now</button>
    </div>
    <p class="hint" style="margin-top:12px">Android decides the exact time, and on Samsung phones "Sleeping apps" / battery saving can stop it: if cards never arrive, set StudyHub's battery use to <b>Unrestricted</b> (Settings → Apps → StudyHub → Battery).</p>`;
}

Object.assign(ACTIONS, {
  'night-sheet': () => nightSheet(),
  async 'night-prepare'() { await nightPrepare({ force: true }); nightDraw(); toast('Ready for tonight'); },
  async 'night-run'(el) {
    el.disabled = true;
    el.textContent = '⏳ Preparing notes…';
    await nightPrepare({ force: true });
    el.textContent = '⏳ Gemini is writing cards…';
    try {
      const r = await nightCall('runNow', {});
      const n = await nightCollect({ quiet: true });
      const errs = (r?.ran || []).filter((x) => x.error);
      toast(n ? `🃏 ${n} new flashcards added` : errs.length ? `⚠️ ${errs[0].deck}: ${errs[0].error}` : r?.skipped ? `Nothing to do (${r.skipped})` : 'Nothing new: every unit already got cards this week');
    } catch (e) {
      toast(`Couldn't make cards: ${e.message || e}`);
    }
    nightSheet();
  },
});
Object.assign(CHANGE_ACTIONS, {
  'night-on': (el) => { lsSet(NIGHT_LS, { ...nightCfg(), on: el.checked }); nightPrepare({ force: true }); render(); },
  'night-window': (el) => { const [from, to] = el.value.split('-').map(Number); lsSet(NIGHT_LS, { ...nightCfg(), from, to }); nightPrepare({ force: true }); },
});

// Collect when the app opens or comes back; prepare a little later (reading PDFs takes a moment)
if (BR) {
  setTimeout(() => { nightCollect().finally(() => setTimeout(() => nightPrepare(), 4000)); }, 2500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) nightCollect(); });
}
