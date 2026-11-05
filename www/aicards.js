'use strict';
/* AI flashcards. The laptop hub makes them with Google Gemini from each unit's notes
 * (files filed as Lecture notes or Books, with a unit set) — see cardgen.py. They arrive here
 * through normal sync, one deck per unit, marked source: 'ai'. This file is only the
 * Flashcards-tab UI: status, "Generate now", and following a batch until it lands. */

const aiAvailable = () => !!syncBase() && (!!syncCfg.lastOk || onHubLaptop());
const isAI = (c) => c && c.source === 'ai';
let aiStatus = null;   // last /sync/ai answer
let aiError = '';
let aiWatch = null;    // { timer, since } while a batch we asked for is running

/** The ✨ row at the top of the Flashcards tab. */
function aiPanel() {
  if (!aiAvailable()) return '';
  const n = data.cards.filter(isAI).length;
  const busy = aiWatch ? 'Making cards on the laptop…' : n ? `${n} made so far · new ones every week` : "Made every week from each unit's notes";
  return `<button class="nudge" data-action="ai-sheet">✨ <span><b>AI cards from your notes</b><br><span class="small muted">${busy}</span></span>${ICON.chevron}</button>`;
}

/** Course of an AI deck (for its ✨ More button), or '' for your own decks. */
const deckCourse = (deck) => data.cards.find((c) => c.deck === deck && isAI(c) && c.course)?.course || '';

async function aiFetchStatus() {
  try {
    aiStatus = await (await sfetch('/sync/ai')).json();
    aiError = '';
  } catch (e) {
    aiError = e.code === undefined && /404/.test(e.message) ? 'The laptop is running an older StudyHub. Restart ./run.sh phone.' : e.message;
  }
}

const aiDay = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

function aiUnitRow(u) {
  const s = aiStatus;
  const busy = s.running === u.course;
  const queued = s.queued.includes(u.course);
  const soon = u.nextRun <= Date.now() + 2 * MIN;
  return `
    <div class="card ai-unit">
      <div class="row" style="align-items:flex-start;gap:10px">
        <div class="grow" style="min-width:0">
          <b>${esc(u.deck)}</b>
          <div class="small muted">${u.files.length} note file${u.files.length === 1 ? '' : 's'} · ${u.aiCards} AI card${u.aiCards === 1 ? '' : 's'}</div>
          <div class="small" style="margin-top:4px">
            ${busy ? '⏳ Reading notes and writing cards…'
              : queued ? '⏳ Waiting its turn…'
              : u.error ? `<span style="color:var(--red)">⚠️ ${esc(u.error)}</span><br><span class="muted">Tries again ${soon ? 'soon' : aiDay(u.nextRun)}</span>`
              : u.lastRun ? `<span class="muted">Last batch ${timeAgo(u.lastRun)} (+${u.lastAdded}${u.model ? `, ${esc(u.model)}` : ''}) · next ${soon ? 'soon' : aiDay(u.nextRun)}</span>`
              : '<span class="muted">First batch coming soon</span>'}
          </div>
        </div>
        <button class="btn small" data-action="ai-generate" data-course="${esc(u.course)}" ${busy || queued || !s.keyPresent ? 'disabled' : ''}>✨ More</button>
      </div>
      <details class="small muted" style="margin-top:6px"><summary>Notes used</summary>${u.files.map((n) => `<div>📄 ${esc(n)}</div>`).join('')}</details>
    </div>`;
}

async function aiSheet(refetch = true) {
  if (refetch) {
    openSheet('<h3>✨ AI flashcards</h3><div id="aiPanel"><p class="muted">Asking the laptop…</p></div>');
    await aiFetchStatus();
    if (!$('#aiPanel')) return; // sheet closed meanwhile
  }
  const s = aiStatus;
  const body = aiError ? `<div class="card"><div class="small">⚠️ ${esc(aiError)}</div></div>`
    : `
      <p class="muted small" style="margin-top:-8px">Every week your laptop sends the next pages of each unit's notes to Google's AI (Gemini, or the open Gemma models when Gemini's free daily limit is used up) and adds up to ${s.perWeek} new cards to that unit's deck. They reach this device at the next sync, marked 🤖. Delete any bad ones while reviewing; they won't come back.</p>
      ${s.keyPresent ? '' : `<div class="card" style="margin-bottom:12px"><div class="small">🔑 <b>No Gemini API key on the laptop.</b><br>Get one at aistudio.google.com → Get API key, then on the laptop save it in<br><code>sync-data/gemini-key</code><br>No restart needed.</div></div>`}
      ${s.units.length ? s.units.map(aiUnitRow).join('') : `<div class="card empty"><span class="big">📚</span>No unit notes yet.<br><span class="small">Add notes under Notes → Files, and in each file's ⋯ Details set the unit (e.g. COMP 226) and the type <b>Lecture notes</b> or <b>Books</b>.</span></div>`}
      ${s.units.length > 1 ? `<button class="btn primary block" data-action="ai-generate" ${s.running || s.queued.length || !s.keyPresent ? 'disabled' : ''}>✨ New cards for every unit now</button>` : ''}
      <p class="hint" style="margin-top:12px">Only files filed as <b>Lecture notes</b> or <b>Books</b> with a unit set are used. Scanned PDFs and photos work too.${s.model ? ` Model: ${esc(s.model)}.` : ''}</p>`;
  const el = $('#aiPanel');
  if (el) el.innerHTML = body;
}

/** Ask the laptop for a batch now, then follow it until the cards have synced here. */
async function aiGenerate(course) {
  try {
    const res = await sfetch('/sync/ai/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ course: course || null }),
    });
    aiStatus = await res.json();
  } catch (e) {
    return toast(/409/.test(e.message) ? 'No Gemini key on the laptop yet' : e.message);
  }
  toast(course ? `✨ Making cards for ${course}… this can take a few minutes; you can leave this screen` : '✨ Making cards for every unit…');
  if (!aiWatch) aiWatch = { since: Date.now() };
  clearTimeout(aiWatch.timer);
  aiTick();
  if ($('#aiPanel')) aiSheet(false);
  render();
}

async function aiTick() {
  await aiFetchStatus();
  if ($('#aiPanel')) aiSheet(false);
  if (!aiError && (aiStatus.running || aiStatus.queued.length)) {
    aiWatch.timer = setTimeout(aiTick, 5000);
    return;
  }
  const since = aiWatch.since;
  aiWatch = null;
  if (aiError) return render();
  await syncNow();
  const added = aiStatus.history.filter((h) => h.t >= since).reduce((n, h) => n + h.added, 0);
  const failed = aiStatus.units.filter((u) => u.error);
  if (added) toast(`✨ ${added} new AI card${added === 1 ? '' : 's'} ready`);
  else if (failed.length) toast(`⚠️ ${failed[0].course}: ${failed[0].error}`);
  else toast('No new cards this time: the notes may be fully covered');
  if ($('#aiPanel')) aiSheet(false);
  render();
}

Object.assign(ACTIONS, {
  'ai-sheet': () => aiSheet(),
  'ai-generate': (el) => aiGenerate(el.dataset.course || ''),
});
