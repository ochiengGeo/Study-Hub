'use strict';
/* StudyHub core: helpers, state, rendering, Today / Deadlines / Flashcards / Quick notes, settings & backup.
 * Other features: timetable.js, alerts.js, files.js. Start-up: main.js.
 * Feature files add to the shared VIEWS / ACTIONS / FORMS / CHANGE_ACTIONS / INPUT_ACTIONS / RENDER_HOOKS registries. */

// =====================================================================
// Data (in-memory copy of IndexedDB; small enough to reload after writes)
// =====================================================================
const data = Object.fromEntries(STORES.map((s) => [s, []]));
async function loadAll() {
  const all = await Promise.all(STORES.map((s) => dbAll(s)));
  STORES.forEach((s, i) => { data[s] = all[i]; });
}
async function save(store, obj) { await dbPut(store, obj); await loadAll(); }
async function remove(store, id) { await dbDel(store, id); await loadAll(); }
const byId = (store, id) => data[store].find((x) => x.id === id);

/** shared.js: the system closed the database connection and a new one is open. Reload what we
 * hold, since file contents read through the old connection may no longer be readable. */
function onDBReconnect() {
  if (typeof dropAllURLs === 'function') dropAllURLs();
  // (on the phone, withTx has already refilled the database from the private copy: vault.js)
  loadAll()
    .then(() => { if (!sheetOpen() && $('#viewer')?.classList.contains('hidden')) render(); })
    .catch(() => { /* the next action retries */ });
}

// Small per-device preferences
const settings = Object.assign(
  { alertMode: 'off', alertMins: 30 },
  (() => { try { return JSON.parse(localStorage.getItem('studyhub-settings')) || {}; } catch { return {}; } })()
);
function saveSettings() { try { localStorage.setItem('studyhub-settings', JSON.stringify(settings)); } catch { /* private mode */ } }

// =====================================================================
// Helpers
// =====================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Minimal markup: ```code blocks```, `inline code`, **bold**, # headings, - bullets. Always escapes first. */
/* Text from you or the AI → safe HTML. Understands the Markdown the AI models write (headings,
 * **bold**, *italic*, `code`, ``` blocks ```, bullet and numbered lists, > quotes, --- lines and
 * | tables |) and maths in LaTeX ($…$, $$…$$, \(…\), \[…\]), drawn with KaTeX (vendor/katex). */
function rich(text) {
  const parts = String(text ?? '').split(/```[\w+#.-]*\n?([\s\S]*?)```/g);
  return parts.map((p, i) => (i % 2 ? `<pre><code>${esc(p.replace(/\n$/, ''))}</code></pre>` : richText(p))).join('');
}

function texToHtml(tex, display) {
  if (!window.katex) return null;
  try {
    return katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, strict: 'ignore', output: 'html', trust: false });
  } catch {
    return null;
  }
}

function richText(src) {
  const slots = [];
  const keep = (html) => `\u0001${slots.push(html) - 1}\u0002`;
  let t = src.replace(/\r/g, '');
  // maths first (its * and _ aren't Markdown)
  t = t.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (m, a, b) => {
    const h = texToHtml(a ?? b, true);
    return h ? `\n${keep(`<div class="math-block">${h}</div>`)}\n` : m;
  });
  t = t.replace(/\\\(([\s\S]+?)\\\)/g, (m, a) => { const h = texToHtml(a, false); return h ? keep(h) : m; });
  t = t.replace(/(^|[^\\$\w])\$(?![\s$])([^$\n]+?)(?<!\s)\$(?![\w$])/g, (m, pre, a) => {
    if (/^\d+(?:[.,]\d+)?$/.test(a)) return m;   // "$5" is money, not maths
    const h = texToHtml(a, false);
    return h ? pre + keep(h) : m;
  });
  t = t.replace(/`([^`\n]+)`/g, (m, c) => keep(`<code>${esc(c)}</code>`));

  const inline = (x) => esc(x)
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*|__(?=\S)([^_\n]*?\S)__/g, (m, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>');

  const lines = t.split('\n');
  const GAP = '<div class="gap"></div>';
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push(para.join('<br>')); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (!line.trim()) { flush(); if (out.length && out[out.length - 1] !== GAP) out.push(GAP); continue; }
    // | table |
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      flush();
      const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = row(line);
      const body = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      i--;
      out.push(`<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*\u0001\d+\u0002\s*$/.test(line) && slots[Number(line.trim().slice(1, -1))].startsWith('<div')) { flush(); out.push(line.trim()); continue; }
    if ((m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line))) { flush(); out.push(`<strong class="h">${inline(m[1])}</strong>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
    if ((m = /^(\s*)[-*+•]\s+(.*)$/.exec(line))) {
      flush();
      out.push(`<div class="li" style="--lvl:${Math.min(3, Math.floor(m[1].replace(/\t/g, '    ').length / 2))}"><span class="bul">•</span><span>${inline(m[2])}</span></div>`);
      continue;
    }
    if ((m = /^(\s*)(\d{1,3}|[a-z])[.)]\s+(.*)$/.exec(line))) {
      flush();
      out.push(`<div class="li" style="--lvl:${Math.min(3, Math.floor(m[1].replace(/\t/g, '    ').length / 2))}"><span class="bul">${esc(m[2])}.</span><span>${inline(m[3])}</span></div>`);
      continue;
    }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) { flush(); out.push(`<div class="quote">${inline(m[1])}</div>`); continue; }
    para.push(inline(line));
  }
  flush();
  while (out[out.length - 1] === GAP) out.pop();
  return out.join('').replace(/\u0001(\d+)\u0002/g, (m, n) => slots[Number(n)]);
}

const startOfDay = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

function fmtDue(ms) {
  const d = new Date(ms);
  const today = startOfDay();
  const day = startOfDay(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (day === today) return `Today ${time}`;
  if (day === today + DAY) return `Tomorrow ${time}`;
  if (day === today - DAY) return `Yesterday ${time}`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }) + ` ${time}`;
}

function countdown(ms) {
  const diff = ms - Date.now();
  const a = Math.abs(diff);
  const m = Math.floor(a / MIN), h = Math.floor(a / HOUR), d = Math.floor(a / DAY);
  const s = d >= 1 ? `${d}d ${h % 24}h` : h >= 1 ? `${h}h ${m % 60}m` : `${Math.max(m, 1)}m`;
  return diff < 0 ? `${s} late` : s;
}

function urgency(ms) {
  const h = (ms - Date.now()) / HOUR;
  if (h < 0) return 'overdue';
  if (h < 24) return 'urgent';
  if (h < 72) return 'soon';
  if (h < 168) return 'week';
  return 'later';
}

function toLocalInput(ms) {
  const d = new Date(ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * MIN).toISOString().slice(0, 16);
}

function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${Math.round(b / 1024)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

const unique = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b));
const allCourses = () => unique([...data.classes.map((c) => c.course), ...data.deadlines.map((d) => d.course), ...data.files.map((f) => f.course)]);
const decks = () => unique(data.cards.map((c) => c.deck));
const courseColor = (course) => (course ? data.classes.find((c) => c.course === course)?.color : undefined);

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/** Share a file through the phone's share sheet, or fall back to a download. */
async function shareOrDownload(file, preferShare = true) {
  if (NATIVE) return nativeShareFile(file);
  if (preferShare && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const ICON = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5 10 17l9-10"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  chevron: '<svg class="chev" viewBox="0 0 24 24" style="width:18px;height:18px;color:var(--muted)"><path d="m9 6 6 6-6 6"/></svg>',
};

// =====================================================================
// Spaced repetition (SM-2 variant)   grade: 0 Again, 1 Hard, 2 Good, 3 Easy
// =====================================================================
function newCard(deck, front, back) {
  return { id: uid(), deck, front, back, created: Date.now(), due: Date.now(), interval: 0, ease: 2.5, reps: 0, lapses: 0 };
}

function nextInterval(c, g) {
  if (g === 0) return 0;
  let iv;
  if (c.reps === 0) iv = [0, 1, 2, 4][g];
  else if (c.reps === 1) iv = [0, 3, 6, 8][g];
  else {
    const ease = c.ease + [0, -0.15, 0, 0.15][g];
    iv = c.interval * [0, 1.2, ease, ease * 1.3][g];
    iv = Math.max(iv, c.interval + 1);
  }
  return Math.min(Math.round(iv), 3650);
}

function schedule(c, g) {
  const next = { ...c, lastReviewed: Date.now() };
  if (g === 0) {
    next.reps = 0;
    next.lapses = (c.lapses || 0) + 1;
    next.interval = 0;
    next.ease = Math.max(1.3, c.ease - 0.2);
    next.due = Date.now() + 10 * MIN;
    return next;
  }
  next.interval = nextInterval(c, g);
  next.ease = Math.max(1.3, c.ease + [0, -0.15, 0, 0.15][g]);
  next.reps = c.reps + 1;
  next.due = startOfDay() + next.interval * DAY + 4 * HOUR;
  return next;
}

function fmtInterval(days) {
  if (days === 0) return '10m';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${(days / 30).toFixed(1).replace(/\.0$/, '')}mo`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, '')}y`;
}

const isDue = (c) => c.due <= Date.now();
const dueCards = (deck) => data.cards.filter((c) => isDue(c) && (!deck || c.deck === deck)).sort((a, b) => a.due - b.due);

// =====================================================================
// State, registries, rendering
// =====================================================================
const state = {
  tab: 'today',
  deadlineFilter: 'upcoming',
  deck: null,
  review: null,
  inboxFilter: 'open',
  notesMode: 'files',     // files | quick
  ttMode: 'day',          // day | week | attendance
  ttDate: null,           // 'YYYY-MM-DD', set at boot
  fileFilter: 'all',
  fileSort: 'recent',
  fileQuery: '',
  collapsed: new Set(),
};

const VIEWS = {};
const ACTIONS = {};
const FORMS = {};
const CHANGE_ACTIONS = {};
const INPUT_ACTIONS = {};
const RENDER_HOOKS = [];

const TITLES = { today: 'Today', timetable: 'Timetable', deadlines: 'Deadlines', cards: 'Flashcards', notes: 'Notes' };

function render() {
  if (typeof examHoldRender === 'function' && examHoldRender()) return; // typing an exam answer
  let title = TITLES[state.tab];
  if (state.tab === 'cards' && state.exam) title = 'Practice exams';
  else if (state.tab === 'cards' && state.review) title = 'Review';
  else if (state.tab === 'cards' && state.deck) title = state.deck;
  $('#title').textContent = title;
  document.querySelectorAll('.drawer nav .dnav').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  updateBadges();

  $('#view').innerHTML = VIEWS[state.tab]();
  for (const fn of RENDER_HOOKS) { try { fn(); } catch (e) { console.error(e); } }
}

function go(tab) {
  state.tab = tab;
  if (tab !== 'cards') { state.review = null; state.deck = null; state.exam = null; }
  render();
  window.scrollTo(0, 0);
}

/** Counters in the sidebar, plus a dot on the menu button when something needs attention. */
function updateBadges() {
  const set = (id, n, cls = '') => {
    const el = $(`#nb-${id}`);
    el.textContent = n;
    el.className = `nb ${cls} ${n ? '' : 'hidden'}`;
  };
  const classesLeft = typeof occurrencesOn === 'function' ? occurrencesOn(ymd()).filter((o) => !o.cancelled && o.end > Date.now()).length : 0;
  const urgent = data.deadlines.filter((d) => !d.done && d.due - Date.now() < 2 * DAY).length;
  const due = dueCards().length;
  const open = data.notes.filter((n) => !n.archived).length;
  set('timetable', classesLeft);
  set('deadlines', urgent, 'red');
  set('cards', due, 'hot');
  set('exams', data.exams.filter((x) => x.start > Date.now() && x.start - Date.now() < 7 * DAY).length, 'red');
  set('notes', open);
  $('#menuAttn').classList.toggle('hidden', !(urgent || due));
}

// ---------- Sidebar ----------
const drawerOpen = () => $('#drawer').classList.contains('open');
function openDrawer() { $('#drawer').classList.add('open'); pushModal(); }
function hideDrawer() { $('#drawer').classList.remove('open'); }
function closeDrawer() {
  if (!drawerOpen()) return;
  if (history.state?.modal) history.back();
  else hideDrawer();
}

// ---------- Back button (Android app): one step back at a time; exit only from Today ----------
let backExitAt = 0;
function appBack() {
  if (typeof cropperOpen === 'function' && cropperOpen()) return closeCropper();
  if (typeof askPanelOpen === 'function' && askPanelOpen()) return closeAskPanel();
  if (!$('#viewer').classList.contains('hidden')) return closeViewer();
  if (sheetOpen()) return closeSheet();
  if (drawerOpen()) return closeDrawer();
  if (state.tab === 'cards') {
    if (state.exam?.id) return ACTIONS['exam-back']();          // paper → list of papers (answers are kept)
    if (state.exam) return ACTIONS['exam-close']();             // list of papers → Flashcards
    if (state.review) { state.review = null; return render(); }
    if (state.deck) { state.deck = null; return render(); }
  }
  if (state.tab !== 'today') return go('today');
  if (Date.now() - backExitAt < 2000) return NATIVE?.App.minimizeApp().catch(() => NATIVE.App.exitApp());
  backExitAt = Date.now();
  toast('Press back again to exit');
}

// ---------- Modal history: lets the phone's Back button close the sidebar / sheets / viewer ----------
function pushModal() { if (!history.state?.modal) history.pushState({ modal: true }, ''); }
window.addEventListener('popstate', () => {
  if (typeof cropperOpen === 'function' && cropperOpen()) { closeCropper(); pushModal(); return; }
  if (typeof askPanelOpen === 'function' && askPanelOpen()) { closeAskPanel(); pushModal(); return; }
  if (!$('#viewer').classList.contains('hidden')) hideViewer();
  else if (sheetOpen()) hideSheet();
  else if (drawerOpen()) hideDrawer();
});

// =====================================================================
// Views: Today, Deadlines, Flashcards, Quick notes
// =====================================================================
function deadlineItem(d) {
  const u = d.done ? 'done' : `u-${urgency(d.due)}`;
  const pill = d.done ? 'done' : countdown(d.due);
  const color = courseColor(d.course);
  const meta = [d.course, d.type, fmtDue(d.due)].filter(Boolean).map(esc).join(' · ');
  return `
    <div class="item ${u} ${d.done ? 'done' : ''}">
      <button class="check" data-action="toggle-deadline" data-id="${d.id}" aria-label="Mark done">${ICON.check}</button>
      <button class="body" data-action="edit-deadline" data-id="${d.id}">
        <div class="title">${esc(d.title)}</div>
        <div class="meta">${color ? `<span class="dot" style="background:${color}"></span>` : ''}${meta}</div>
      </button>
      <span class="pill">${esc(pill)}</span>
    </div>`;
}

VIEWS.today = () => {
  const now = new Date();
  const dateLine = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const hour = now.getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const due = dueCards().length;
  const openNotes = data.notes.filter((n) => !n.archived).length;
  const horizon = Date.now() + 7 * DAY;
  const upcoming = data.deadlines.filter((d) => !d.done && d.due <= horizon).sort((a, b) => a.due - b.due);
  const later = data.deadlines.filter((d) => !d.done && d.due > horizon).length;

  return `
    <p class="date-line">${greet} · ${esc(dateLine)}</p>
    ${nextClassCard()}

    <form class="capture" data-form="capture">
      <input type="text" name="text" placeholder="Quick capture… (idea, command, todo)" autocomplete="off" enterkeyhint="done">
      <button class="btn primary" aria-label="Save">${ICON.plus}</button>
    </form>

    ${due || openNotes || notifyNudge() || nextExamNudge() ? `<div class="nudges">
      ${notifyNudge()}
      ${nextExamNudge()}
      ${due ? `<button class="nudge" data-action="start-review">🃏 <span><b>${due}</b> flashcard${due === 1 ? '' : 's'} to review</span>${ICON.chevron}</button>` : ''}
      ${openNotes ? `<button class="nudge" data-action="tab" data-tab="notes" data-mode="quick">✏️ <span><b>${openNotes}</b> quick note${openNotes === 1 ? '' : 's'} to sort</span>${ICON.chevron}</button>` : ''}
    </div>` : ''}

    ${todayClassesSection()}

    <h2 class="section">Due this week <button data-action="tab" data-tab="deadlines">See all</button></h2>
    ${upcoming.length
      ? upcoming.map(deadlineItem).join('')
      : `<div class="card empty"><span class="big">🎉</span>Nothing due in the next 7 days${later ? `<br><span class="small">${later} later</span>` : ''}</div>`}
  `;
};

VIEWS.deadlines = () => {
  const done = state.deadlineFilter === 'done';
  const list = data.deadlines
    .filter((d) => !!d.done === done)
    .sort((a, b) => (done ? b.due - a.due : a.due - b.due));
  return `
    <div class="chips">
      <button class="chip ${!done ? 'active' : ''}" data-action="deadline-filter" data-value="upcoming">Upcoming</button>
      <button class="chip ${done ? 'active' : ''}" data-action="deadline-filter" data-value="done">Done</button>
    </div>
    ${list.length
      ? list.map(deadlineItem).join('')
      : `<div class="card empty"><span class="big">${done ? '📭' : '🗓️'}</span>${done ? 'Nothing completed yet' : 'No upcoming deadlines.<br>Tap <b>+</b> to add one.'}</div>`}
    <button class="fab" data-action="new-deadline" aria-label="Add deadline">${ICON.plus}</button>
  `;
};

VIEWS.cards = () => {
  if (state.exam) return examView();
  if (state.review) return reviewView();
  if (state.deck) return deckView(state.deck);

  const all = decks();
  const totalDue = dueCards().length;
  return `
    <button class="btn primary block" data-action="start-review" ${totalDue ? '' : 'disabled'}>
      ${totalDue ? `Review all due (${totalDue})` : 'No cards due — nice work'}
    </button>
    ${aiAvailable() || (typeof nightPanel === 'function' && nightPanel()) ? `<div class="nudges">${aiAvailable() ? aiPanel() : ''}${typeof nightPanel === 'function' ? nightPanel() : ''}${aiAvailable() ? examPanel() : ''}</div>` : ''}
    <h2 class="section">Decks</h2>
    ${all.length
      ? all.map((deck) => {
          const cs = data.cards.filter((c) => c.deck === deck);
          const d = cs.filter(isDue).length;
          const ai = cs.filter(isAI).length;
          return `
            <div class="item">
              <button class="body deck" data-action="open-deck" data-deck="${esc(deck)}">
                <div class="grow"><div class="title">${esc(deck)}</div><div class="meta">${cs.length} card${cs.length === 1 ? '' : 's'}${ai ? ` · 🤖 ${ai === cs.length ? 'AI' : `${ai} AI`}` : ''}</div></div>
                ${d ? `<span class="due-count">${d} due</span>` : '<span class="muted small">✓</span>'}
                ${ICON.chevron}
              </button>
            </div>`;
        }).join('')
      : `<div class="card empty"><span class="big">🃏</span>No flashcards yet.<br>Tap <b>+</b> to make your first card.<br><span class="small">Tip: wrap code in \`\`\` for code blocks.</span></div>`}
    <button class="fab" data-action="new-card" aria-label="Add card">${ICON.plus}</button>
  `;
};

function notesSeg() {
  const open = data.notes.filter((n) => !n.archived).length;
  return `<div class="seg">
    <button class="${state.notesMode === 'files' ? 'on' : ''}" data-action="notes-mode" data-mode="files">📁 Files${data.files.length ? ` (${data.files.length})` : ''}</button>
    <button class="${state.notesMode === 'quick' ? 'on' : ''}" data-action="notes-mode" data-mode="quick">✏️ Quick notes${open ? ` (${open})` : ''}</button>
  </div>`;
}

VIEWS.notes = () => (state.notesMode === 'files' ? filesView() : quickNotesView());

function quickNotesView() {
  const archived = state.inboxFilter === 'archived';
  const list = data.notes.filter((n) => !!n.archived === archived).sort((a, b) => b.created - a.created);
  return `
    ${notesSeg()}
    <form class="card" data-form="capture">
      <textarea name="text" class="mono" placeholder="Capture anything: a command, an idea, something the lecturer said…" rows="3"></textarea>
      <div class="row end" style="margin-top:8px"><button class="btn primary">Save note</button></div>
    </form>
    <div class="chips" style="margin-top:14px">
      <button class="chip ${!archived ? 'active' : ''}" data-action="inbox-filter" data-value="open">To sort</button>
      <button class="chip ${archived ? 'active' : ''}" data-action="inbox-filter" data-value="archived">Archived</button>
    </div>
    ${list.length
      ? list.map((n) => `
        <div class="item note">
          <div class="text rich">${rich(n.text)}</div>
          <div class="meta">${timeAgo(n.created)}</div>
          <div class="actions">
            ${archived
              ? `<button class="btn" data-action="unarchive-note" data-id="${n.id}">Restore</button>`
              : `<button class="btn" data-action="note-to-card" data-id="${n.id}">→ Card</button>
                 <button class="btn" data-action="note-to-deadline" data-id="${n.id}">→ Deadline</button>
                 <button class="btn" data-action="archive-note" data-id="${n.id}">✓ Archive</button>`}
            <button class="btn danger" data-action="delete-note" data-id="${n.id}">Delete</button>
          </div>
        </div>`).join('')
      : `<div class="card empty"><span class="big">${archived ? '🗄️' : '✨'}</span>${archived ? 'Nothing archived' : 'All sorted'}</div>`}
  `;
}

function deckView(deck) {
  const cs = data.cards.filter((c) => c.deck === deck).sort((a, b) => a.due - b.due);
  const d = cs.filter(isDue).length;
  const course = aiAvailable() ? deckCourse(deck) : '';
  return `
    <div class="row" style="margin-bottom:12px">
      <button class="btn" data-action="close-deck">← Decks</button>
      <button class="btn primary grow" data-action="start-review" data-deck="${esc(deck)}" ${d ? '' : 'disabled'}>${d ? `Review ${d} due` : 'Nothing due'}</button>
      ${typeof NEARBY !== 'undefined' && NEARBY ? `<button class="btn" data-action="share-deck" data-deck="${esc(deck)}" title="Send this deck to friends nearby" aria-label="Share deck nearby">📡</button>` : ''}
      ${course ? `<button class="btn" data-action="ai-generate" data-course="${esc(course)}" ${aiWatch ? 'disabled' : ''} title="Ask the laptop for more AI cards from this unit's notes">✨ More</button>` : ''}
    </div>
    ${cs.map((c) => `
      <div class="item">
        <button class="body" data-action="edit-card" data-id="${c.id}">
          <div class="title rich">${rich(c.front)}</div>
          <div class="meta">${isAI(c) ? '🤖 ' : ''}${isDue(c) ? 'due now' : `next in ${fmtInterval(Math.max(1, Math.round((c.due - Date.now()) / DAY)))}`} · ${c.reps ? `${c.reps} streak` : 'new'}${c.lapses ? ` · ${c.lapses} lapse${c.lapses > 1 ? 's' : ''}` : ''}</div>
        </button>
      </div>`).join('') || '<div class="card empty">Empty deck</div>'}
    <button class="fab" data-action="new-card" data-deck="${esc(deck)}" aria-label="Add card">${ICON.plus}</button>
  `;
}

function reviewView() {
  const r = state.review;
  const card = data.cards.find((c) => c.id === r.queue[0]);
  if (!card) {
    return `
      <div class="card empty" style="padding:40px 16px">
        <span class="big">✅</span>
        <b>Session complete</b><br>${r.done} review${r.done === 1 ? '' : 's'} done.
        <div style="margin-top:18px"><button class="btn primary" data-action="end-review">Back to decks</button></div>
      </div>`;
  }
  const pct = Math.round((r.done / Math.max(r.done + r.queue.length, 1)) * 100);
  return `
    <div class="review-top">
      <button class="btn" data-action="end-review">✕ End</button>
      <span class="muted small">${r.queue.length} left</span>
    </div>
    <div class="progress"><div style="width:${pct}%"></div></div>
    <div class="card flash">
      <div class="deck-tag">${esc(card.deck)}${isAI(card) ? ` · <span title="Made by AI from ${esc(card.from || 'your notes')}">🤖 AI${card.topic ? ` · ${esc(card.topic)}` : ''}</span>` : ''}</div>
      <div class="rich">${rich(card.front)}</div>
      ${r.shown ? `<hr><div class="rich">${rich(card.back)}</div>` : ''}
    </div>
    ${r.shown
      ? `<div class="grades">
          ${['Again', 'Hard', 'Good', 'Easy'].map((label, g) => `
            <button class="btn g${g}" data-action="grade" data-grade="${g}">${label}<small>${fmtInterval(nextInterval(card, g))}</small></button>`).join('')}
        </div>`
      : `<button class="btn primary block" style="margin-top:14px;padding:14px" data-action="show-answer">Show answer</button>`}
    <div class="row end" style="margin-top:10px">
      ${isAI(card) ? `<button class="btn small danger" data-action="delete-card" data-id="${card.id}" title="Wrong or useless? Delete it; it won't come back">🗑 Bad card</button>` : ''}
      <button class="btn small" data-action="edit-card" data-id="${card.id}">Edit card</button>
    </div>
  `;
}

// =====================================================================
// Bottom sheet
// =====================================================================
function openSheet(html) {
  const sheet = $('#sheet');
  sheet.querySelector('.sheet-panel').innerHTML = html;
  sheet.querySelector('.sheet-panel').scrollTop = 0;
  sheet.classList.remove('hidden');
  pushModal();
  const first = sheet.querySelector('[autofocus]');
  if (first) setTimeout(() => first.focus(), 50);
}
function hideSheet() { $('#sheet').classList.add('hidden'); }
function closeSheet() {
  if (!sheetOpen()) return;
  if (history.state?.modal) history.back(); // popstate handler hides it
  else hideSheet();
}
const sheetOpen = () => !$('#sheet').classList.contains('hidden');

function datalist(id, items) {
  return `<datalist id="${id}">${items.map((i) => `<option value="${esc(i)}">`).join('')}</datalist>`;
}

function deadlineForm(d = {}, fromNote) {
  const isNew = !d.id;
  const due = d.due ?? (startOfDay() + DAY + 23 * HOUR + 59 * MIN);
  const types = ['Assignment', 'Lab', 'Exam', 'CAT / Quiz', 'Project', 'Other'];
  openSheet(`
    <h3>${isNew ? 'New deadline' : 'Edit deadline'}</h3>
    <form data-form="deadline">
      <input type="hidden" name="id" value="${esc(d.id || '')}">
      <input type="hidden" name="fromNote" value="${esc(fromNote || '')}">
      <label class="field"><span>What</span><input type="text" name="title" required value="${esc(d.title || '')}" placeholder="e.g. OS Lab 3: process scheduling" ${isNew ? 'autofocus' : ''}></label>
      <label class="field"><span>Course</span><input type="text" name="course" list="courseList" value="${esc(d.course || '')}" placeholder="e.g. CSC 311">${datalist('courseList', allCourses())}</label>
      <label class="field"><span>Type</span>
        <select name="type">${types.map((t) => `<option ${t === (d.type || 'Assignment') ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </label>
      <label class="field"><span>Due</span><input type="datetime-local" name="due" required value="${toLocalInput(due)}"></label>
      <div class="row">
        ${isNew ? '' : `<button type="button" class="btn danger" data-action="delete-deadline" data-id="${d.id}">Delete</button>`}
        <span class="grow"></span>
        <button type="button" class="btn" data-action="close-sheet">Cancel</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`);
}

function cardForm(c = {}, fromNote) {
  const isNew = !c.id;
  const deck = c.deck || state.deck || state.lastDeck || '';
  openSheet(`
    <h3>${isNew ? 'New flashcard' : 'Edit flashcard'}</h3>
    <form data-form="card">
      <input type="hidden" name="id" value="${esc(c.id || '')}">
      <input type="hidden" name="fromNote" value="${esc(fromNote || '')}">
      <label class="field"><span>Deck</span><input type="text" name="deck" list="deckList" required value="${esc(deck)}" placeholder="e.g. Data Structures">${datalist('deckList', decks())}</label>
      <label class="field"><span>Front (question)</span><textarea name="front" class="mono" required ${isNew && deck ? 'autofocus' : ''} placeholder="What is the time complexity of heapify?">${esc(c.front || '')}</textarea></label>
      <label class="field"><span>Back (answer)</span><textarea name="back" class="mono" required placeholder="O(n) — bottom-up build">${esc(c.back || '')}</textarea></label>
      <p class="hint">Use \`inline code\`, \`\`\`code blocks\`\`\` and **bold**.</p>
      <div class="row">
        ${isNew ? '' : `<button type="button" class="btn danger" data-action="delete-card" data-id="${c.id}">Delete</button>`}
        <span class="grow"></span>
        <button type="button" class="btn" data-action="close-sheet">Cancel</button>
        <button class="btn primary">${isNew ? 'Add' : 'Save'}</button>
      </div>
      ${isNew && !fromNote ? '<p class="hint" style="margin-top:10px;text-align:right">After adding, the form stays open for the next card.</p>' : ''}
    </form>`);
}

async function fillStorage(sel) {
  const el = $(sel);
  if (!el || !navigator.storage?.estimate) return;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    el.textContent = `${fmtSize(usage)} used · about ${fmtSize(quota)} available to StudyHub`;
  } catch { /* ignore */ }
}

function settingsSheet() {
  if (NATIVE) { setTimeout(fillNativeStatus, 0); }
  const perm = NATIVE ? 'native' : 'Notification' in window ? Notification.permission : 'unsupported';
  const permText = { native: '<span id="nativeStatus">Checking…</span>', granted: 'On ✓', denied: 'Blocked in browser settings', default: 'Not enabled yet', unsupported: 'Not supported here' }[perm];
  openSheet(`
    <h3>Settings</h3>
    ${window.isSecureContext || NATIVE ? '' : `<div class="occ-note" style="margin-bottom:14px">⚠️ Opened over plain <b>http://</b> from another device, so the browser turns off notifications, offline mode and Share → StudyHub. Everything else works. Hosting it on HTTPS (GitHub Pages) turns these on.</div>`}
    <h4 class="sub">Alerts & reminders</h4>
    <div class="card" style="margin-bottom:16px">
      <div class="row" style="margin-bottom:10px"><span class="grow">Notifications</span><span class="muted small">${permText}</span></div>
      <button class="btn block" style="margin-bottom:10px" data-action="notif-setup">🔔 Check notification set-up</button>
      <label class="checkline"><input type="checkbox" data-action-change="remind-toggle" data-key="remindDeadlines" ${settings.remindDeadlines ? 'checked' : ''}> Remind me before deadlines (1 day and 2 hours before)</label>
      <label class="checkline"><input type="checkbox" data-action-change="remind-toggle" data-key="remindExams" ${settings.remindExams ? 'checked' : ''}> Remind me before exams & CATs (3 days, 1 day, 2 hours)</label>
      ${perm === 'default' ? '<button class="btn block" style="margin-bottom:10px" data-action="enable-notifs">Enable notifications</button>' : ''}
      ${NATIVE ? '<div id="nativeFix"></div><p class="hint" style="margin:0 2px 12px">Alerts are handled by Android, so they ring even when StudyHub is closed or the phone is locked.</p>' : ''}
      <form data-form="alert-defaults">
        <div class="field"><span>Default alert for new classes</span>${alertModeSeg(settings.alertMode)}</div>
        ${minutesSelect(settings.alertMins)}
        <button class="btn block">Save default</button>
      </form>
      <div class="stack" style="margin-top:8px">
        <button class="btn block" data-action="test-alert">Test an alert (fires in 5 s)</button>
        <button class="btn block" data-action="calendar-export">📅 Add timetable to phone calendar</button>
      </div>
    </div>
    ${typeof askSettingsSection === 'function' ? askSettingsSection() : ''}
    <h4 class="sub">Data</h4>
    <p class="muted small" style="margin-top:0">${data.classes.length} classes · ${data.deadlines.length} deadlines · ${data.cards.length} cards · ${data.notes.length} notes · ${data.files.length} files<br>
      Everything is stored only on this device. <span id="storageLine"></span></p>
    <div class="stack">
      <button class="btn block" data-action="export">⬇️ Export backup (JSON)</button>
      <button class="btn block" data-action="pick-backup">⬆️ Import backup</button>
      <button class="btn block danger" data-action="wipe">Delete all data</button>
      <button class="btn block" data-action="close-sheet">Close</button>
    </div>
    <p class="hint" style="margin-top:14px">Backups hold your timetable, deadlines, cards and notes. Files aren't included because they're copies of files you already have.</p>`);
  fillStorage('#storageLine');
}

// =====================================================================
// Themes
// =====================================================================
const THEMES = [
  ['auto', 'Auto', 'Follows your phone'],
  ['light', 'Light', ''],
  ['dark', 'Dark', ''],
  ['black', 'Black', 'Best for OLED at night'],
  ['sepia', 'Sepia', 'Warm, for reading'],
];
const ACCENTS = { indigo: '#6366f1', blue: '#3b82f6', teal: '#0d9488', green: '#16a34a', orange: '#ea580c', rose: '#e11d48', purple: '#9333ea' };
// preview colours for the tiles: [background, surface, text]
const THEME_PREVIEW = { light: ['#f4f5fa', '#ffffff', '#151a2c'], dark: ['#0b1020', '#1c2440', '#e6e9f2'], black: ['#000000', '#1a1a1f', '#ececf1'], sepia: ['#f3ead7', '#fbf6ea', '#3b2f1e'] };

const theme = (() => { try { return { mode: 'auto', accent: 'indigo', ...JSON.parse(localStorage.getItem('studyhub-theme') || '{}') }; } catch { return { mode: 'auto', accent: 'indigo' }; } })();

function applyTheme() {
  const root = document.documentElement;
  if (theme.mode === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme.mode);
  if (theme.accent === 'indigo') root.removeAttribute('data-accent'); else root.setAttribute('data-accent', theme.accent);
  try { localStorage.setItem('studyhub-theme', JSON.stringify(theme)); } catch { /* ignore */ }
  // colour the phone's status bar to match
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', bg || '#0b1020');
  if (typeof onThemeApplied === 'function') onThemeApplied(bg);
}

function themeSheet() {
  const sys = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  openSheet(`
    <h3>Theme</h3>
    <h4 class="sub">Appearance</h4>
    <div class="theme-grid">
      ${THEMES.map(([k, label, note]) => {
        const [bg, surf, text] = THEME_PREVIEW[k === 'auto' ? sys : k];
        return `<button class="theme-tile ${theme.mode === k ? 'on' : ''}" data-action="set-theme" data-mode="${k}" title="${esc(note)}">
          <div class="tp" style="background:${bg}"><i class="a" style="background:${ACCENTS[theme.accent]}"></i><i class="s" style="background:${surf}"></i><i style="background:${text};opacity:.5;width:60%;height:5px"></i></div>
          <b>${label}${k === 'auto' ? ' ◐' : ''}</b>
        </button>`;
      }).join('')}
    </div>
    <h4 class="sub">Accent colour</h4>
    <div class="accents">
      ${Object.entries(ACCENTS).map(([k, c]) => `<button class="${theme.accent === k ? 'on' : ''}" style="--sw:${c}" data-action="set-accent" data-accent="${k}" aria-label="${k}"></button>`).join('')}
    </div>
    <p class="hint" style="margin-top:12px">Class colours stay as you set them. Changes apply straight away.</p>
    <button class="btn block" data-action="close-sheet" style="margin-top:6px">Done</button>`);
}

Object.assign(ACTIONS, {
  theme: () => { hideDrawer(); themeSheet(); },
  'set-theme': (el) => { theme.mode = el.dataset.mode; applyTheme(); themeSheet(); },
  'set-accent': (el) => { theme.accent = el.dataset.accent; applyTheme(); themeSheet(); },
});
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (theme.mode === 'auto') applyTheme(); });

/** Android app: show notification + exact-alarm status in Settings, with buttons to fix them. */
async function fillNativeStatus() {
  const el = $('#nativeStatus');
  if (!el) return;
  const perm = await NATIVE.LN.checkPermissions().then((p) => p.display).catch(() => 'denied');
  const exact = await nativeExactAlarms();
  el.textContent = perm !== 'granted' ? 'Notifications off' : exact !== 'granted' ? 'On (timing may drift)' : 'On ✓';
  const fix = $('#nativeFix');
  if (!fix) return;
  fix.innerHTML = (perm !== 'granted' ? '<button class="btn block" style="margin-bottom:8px" data-action="enable-notifs">Allow notifications</button>' : '')
    + (perm === 'granted' && exact !== 'granted' ? '<button class="btn block" style="margin-bottom:8px" data-action="exact-alarms">Allow exact alarm timing</button>' : '');
}
CHANGE_ACTIONS['remind-toggle'] = (el) => { settings[el.dataset.key] = el.checked; saveSettings(); if (NATIVE) nativeSyncAlerts(); render(); };
ACTIONS['exact-alarms'] = async () => { try { await NATIVE.LN.changeExactNotificationSetting(); } catch { /* ignore */ } fillNativeStatus(); };

// =====================================================================
// Actions
// =====================================================================
function startReview(deck) {
  const queue = dueCards(deck).map((c) => c.id);
  if (!queue.length) return toast('Nothing due');
  state.tab = 'cards';
  state.review = { queue, done: 0, shown: false, deck };
  render();
  window.scrollTo(0, 0);
}

Object.assign(ACTIONS, {
  tab: (el) => { if (el.dataset.mode) state.notesMode = el.dataset.mode; closeDrawer(); go(el.dataset.tab); },
  menu: () => openDrawer(),
  'menu-close': () => closeDrawer(),
  // From the sidebar straight into a form. The sheet takes over the sidebar's Back-button entry.
  'quick-add': (el) => {
    hideDrawer();
    const what = el.dataset.what;
    if (what === 'class') { state.tab = 'timetable'; render(); classForm(); }
    else if (what === 'deadline') { state.tab = 'deadlines'; render(); deadlineForm(); }
    else if (what === 'exam') { state.tab = 'exams'; render(); examForm(); }
    else if (what === 'card') { state.tab = 'cards'; state.review = null; state.deck = null; render(); cardForm(); }
  },
  settings: () => { hideDrawer(); settingsSheet(); },
  'close-sheet': () => closeSheet(),
  'notes-mode': (el) => { state.notesMode = el.dataset.mode; render(); },

  // Deadlines
  'deadline-filter': (el) => { state.deadlineFilter = el.dataset.value; render(); },
  'new-deadline': () => deadlineForm(),
  'edit-deadline': (el) => deadlineForm(byId('deadlines', el.dataset.id)),
  async 'toggle-deadline'(el) {
    const d = byId('deadlines', el.dataset.id);
    await save('deadlines', { ...d, done: !d.done, doneAt: d.done ? null : Date.now() });
    render();
    if (!d.done) toast('Done ✓');
  },
  async 'delete-deadline'(el) {
    if (!confirm('Delete this deadline?')) return;
    await remove('deadlines', el.dataset.id);
    closeSheet(); render();
  },

  // Cards
  'new-card': (el) => cardForm({ deck: el.dataset.deck }),
  'edit-card': (el) => cardForm(byId('cards', el.dataset.id)),
  'open-deck': (el) => { state.deck = el.dataset.deck; render(); window.scrollTo(0, 0); },
  'close-deck': () => { state.deck = null; render(); },
  'start-review': (el) => startReview(el.dataset.deck),
  'end-review': () => { state.review = null; render(); },
  'show-answer': () => { state.review.shown = true; render(); },
  async grade(el) {
    const r = state.review;
    const g = Number(el.dataset.grade);
    const card = byId('cards', r.queue[0]);
    await save('cards', schedule(card, g));
    r.queue.shift();
    r.done++;
    if (g === 0) r.queue.push(card.id);
    r.shown = false;
    render();
  },
  async 'delete-card'(el) {
    if (!confirm('Delete this card?')) return;
    await remove('cards', el.dataset.id);
    if (state.review) state.review.queue = state.review.queue.filter((id) => id !== el.dataset.id);
    if (state.deck && !data.cards.some((c) => c.deck === state.deck)) state.deck = null;
    closeSheet(); render();
  },

  // Quick notes
  'inbox-filter': (el) => { state.inboxFilter = el.dataset.value; render(); },
  async 'archive-note'(el) { await save('notes', { ...byId('notes', el.dataset.id), archived: true }); render(); toast('Archived'); },
  async 'unarchive-note'(el) { await save('notes', { ...byId('notes', el.dataset.id), archived: false }); render(); },
  async 'delete-note'(el) {
    if (!confirm('Delete this note?')) return;
    await remove('notes', el.dataset.id); render();
  },
  'note-to-card': (el) => cardForm({ front: byId('notes', el.dataset.id).text }, el.dataset.id),
  'note-to-deadline': (el) => deadlineForm({ title: byId('notes', el.dataset.id).text.split('\n')[0].slice(0, 120) }, el.dataset.id),

  // Settings / backup
  'enable-notifs': async () => { await ensureNotifyPermission(); settingsSheet(); },
  async export() {
    const { files, ...rest } = data;
    const payload = JSON.stringify({ app: 'studyhub', version: 2, exported: new Date().toISOString(), ...rest }, null, 2);
    const name = `studyhub-backup-${new Date().toISOString().slice(0, 10)}.json`;
    await shareOrDownload(new File([payload], name, { type: 'application/json' }));
  },
  async wipe() {
    if (!confirm('Delete ALL classes, deadlines, cards, notes and files on this device? This cannot be undone.')) return;
    if (!confirm('Really sure? Consider exporting a backup first.')) return;
    await Promise.all([...STORES, 'tombs'].map(dbClear));
    if (typeof vaultWipe === 'function') await vaultWipe();
    if (typeof syncResetLocal === 'function') syncResetLocal(); // next sync pulls everything back from the laptop
    await loadAll();
    closeSheet(); go('today'); toast('All data deleted');
  },
});

$('#pickBackup').addEventListener('change', (e) => CHANGE_ACTIONS.import(e.target));
ACTIONS['pick-backup'] = () => $('#pickBackup').click();
CHANGE_ACTIONS.import = async (input) => {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    if (json.app !== 'studyhub') throw new Error('Not a StudyHub backup');
    let n = 0;
    for (const s of STORES.filter((x) => x !== 'files')) {
      for (const obj of json[s] || []) {
        if (obj && typeof obj.id === 'string') { await dbPut(s, obj); n++; }
      }
    }
    await loadAll();
    closeSheet(); render();
    toast(`Imported ${n} items`);
  } catch (e) {
    alert(`Import failed: ${e.message}`);
  }
};

// ---------- Forms ----------
Object.assign(FORMS, {
  async capture(form) {
    const text = form.elements.text.value.trim();
    if (!text) return;
    await save('notes', { id: uid(), text, created: Date.now(), archived: false });
    form.reset();
    render();
    toast('Saved to quick notes');
  },

  async deadline(form) {
    const f = Object.fromEntries(new FormData(form));
    const prev = f.id ? byId('deadlines', f.id) : {};
    await save('deadlines', {
      ...prev,
      id: f.id || uid(),
      title: f.title.trim(),
      course: f.course.trim(),
      type: f.type,
      due: new Date(f.due).getTime(),
      done: prev.done || false,
      created: prev.created || Date.now(),
    });
    if (f.fromNote) await save('notes', { ...byId('notes', f.fromNote), archived: true });
    closeSheet(); render();
    toast(f.id ? 'Saved' : 'Deadline added');
  },

  async card(form) {
    const f = Object.fromEntries(new FormData(form));
    const deck = f.deck.trim();
    state.lastDeck = deck;
    if (f.id) {
      await save('cards', { ...byId('cards', f.id), deck, front: f.front.trim(), back: f.back.trim() });
      closeSheet();
      toast('Saved');
    } else {
      await save('cards', newCard(deck, f.front.trim(), f.back.trim()));
      if (f.fromNote) {
        await save('notes', { ...byId('notes', f.fromNote), archived: true });
        closeSheet();
      } else {
        form.elements.front.value = '';
        form.elements.back.value = '';
        form.elements.front.focus();
      }
      toast('Card added');
    }
    render();
  },

  'alert-defaults'(form) {
    const f = Object.fromEntries(new FormData(form));
    settings.alertMode = f.alert;
    settings.alertMins = Number(f.alertMins);
    saveSettings();
    if (f.alert !== 'off') ensureNotifyPermission();
    toast('Default alert saved');
  },
});

// =====================================================================
// Event delegation
// =====================================================================
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) {
    e.preventDefault();
    Promise.resolve(fn(el, e)).catch((err) => { console.error(err); toast(`Error: ${err.message}`); });
  }
});
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  Promise.resolve(FORMS[form.dataset.form]?.(form)).catch((err) => { console.error(err); toast(`Error: ${err.message}`); });
});
document.addEventListener('change', (e) => {
  const fn = CHANGE_ACTIONS[e.target.dataset.actionChange];
  if (fn) Promise.resolve(fn(e.target, e)).catch((err) => { console.error(err); toast(`Error: ${err.message}`); });
});
document.addEventListener('input', (e) => {
  const fn = INPUT_ACTIONS[e.target.dataset.actionInput];
  if (fn) fn(e.target, e);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#viewer').classList.contains('hidden')) closeViewer();
    else if (sheetOpen()) closeSheet();
    else if (drawerOpen()) closeDrawer();
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.form) e.target.form.requestSubmit();
  if (state.review && !sheetOpen() && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
    if (e.key === ' ' && !state.review.shown) { e.preventDefault(); ACTIONS['show-answer'](); }
    else if (state.review.shown && ['1', '2', '3', '4'].includes(e.key)) {
      ACTIONS.grade({ dataset: { grade: String(Number(e.key) - 1) } });
    }
  }
});

// Keep countdowns / "Now" badges fresh (not on Notes, so typing in search isn't interrupted).
setInterval(() => { if (!sheetOpen() && !state.review && state.tab !== 'notes') render(); }, MIN);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !sheetOpen()) render(); });
