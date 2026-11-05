'use strict';
/* Timetable: weekly + one-off (make-up) classes, per-day cancellations & notes,
 * attendance tracking, week grid, and export to the phone's calendar (.ics).
 *
 * Data model
 *   classes:     { id, course, title, type, repeat: 'weekly'|'once', day (0=Sun), date ('YYYY-MM-DD' for once),
 *                  start 'HH:MM', end 'HH:MM', room, lecturer, color, alert, alertMins }
 *   occurrences: { id: `${classId}@${date}`, classId, date, cancelled, reason, note, attended, alert, alertMins, fired }
 *                (only stored when something about that specific day differs)
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CLASS_TYPES = ['Lecture', 'Lab', 'Tutorial', 'Practical', 'Seminar', 'Other'];
const CLASS_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'];
const ALERT_MODES = { off: 'Off', ring: 'Ring', vibrate: 'Vibrate', silent: 'Silent' };
const ALERT_ICON = { off: '🔕', ring: '🔔', vibrate: '📳', silent: '🔅' };
const ALERT_MINUTES = [5, 10, 15, 20, 30, 45, 60];

// ---------------------------------------------------------------------
// Date helpers (local dates as 'YYYY-MM-DD' keys — DST-safe)
// ---------------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, '0');
function ymd(t = Date.now()) { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function parseYmd(key) { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
function addDays(key, n) { const d = new Date(parseYmd(key)); d.setDate(d.getDate() + n); return ymd(d); }
function atTime(key, hhmm) { const [h, m] = hhmm.split(':').map(Number); const d = new Date(parseYmd(key)); d.setHours(h, m, 0, 0); return d.getTime(); }
const dowOf = (key) => new Date(parseYmd(key)).getDay();
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const hhmm = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
function weekStartKey(key) { return addDays(key, -((dowOf(key) + 6) % 7)); } // Monday
function fmtTime(t) { const [h, m] = t.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function fmtDay(key, opts = { weekday: 'short', day: 'numeric', month: 'short' }) { return new Date(parseYmd(key)).toLocaleDateString([], opts); }
function fmtDuration(ms) {
  const m = Math.max(1, Math.round(ms / MIN));
  const h = Math.floor(m / 60);
  return h ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`;
}
const clsLabel = (c) => c.course || c.title || 'Class';
/** Inline CSS vars for a class colour: hex plus an "r, g, b" triplet (tints use rgba(), which every browser supports). */
function colorVars(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '--c:var(--accent);--c-rgb:var(--accent-rgb)';
  const n = parseInt(m[1], 16);
  return `--c:#${m[1]};--c-rgb:${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

// ---------------------------------------------------------------------
// Occurrences
// ---------------------------------------------------------------------
function occurrencesOn(key) {
  const dow = dowOf(key);
  return data.classes
    .filter((c) => (c.repeat === 'once' ? c.date === key : c.day === dow))
    .map((cls) => {
      const id = `${cls.id}@${key}`;
      const occ = data.occurrences.find((x) => x.id === id) || {};
      return {
        id, key, cls, occ,
        start: atTime(key, cls.start),
        end: atTime(key, cls.end),
        cancelled: !!occ.cancelled,
        reason: occ.reason || '',
        note: occ.note || '',
        attended: occ.attended ?? null,
        alert: occ.alert || cls.alert || 'off',
        alertMins: occ.alertMins || cls.alertMins || settings.alertMins,
      };
    })
    .sort((a, b) => a.start - b.start);
}

function getOcc(id) {
  const key = id.slice(id.lastIndexOf('@') + 1);
  return occurrencesOn(key).find((o) => o.id === id);
}

async function saveOcc(o, patch) {
  const base = data.occurrences.find((x) => x.id === o.id) || { id: o.id, classId: o.cls.id, date: o.key };
  await save('occurrences', { ...base, ...patch });
}

function occStatus(o) {
  if (o.cancelled) return 'cancelled';
  const now = Date.now();
  if (now < o.start) return 'upcoming';
  if (now < o.end) return 'now';
  return 'done';
}

/** The class happening now, or one that ended within the last hour (used to tag board photos). */
function currentOrRecentClass() {
  const now = Date.now();
  return occurrencesOn(ymd())
    .filter((o) => !o.cancelled && o.start - 15 * MIN <= now && now <= o.end + HOUR)
    .pop();
}

// ---------------------------------------------------------------------
// Small UI pieces
// ---------------------------------------------------------------------
function alertModeSeg(selected, name = 'alert') {
  return `<div class="seg">${Object.entries(ALERT_MODES).map(([k, label]) => `
    <label><input type="radio" name="${name}" value="${k}" ${k === selected ? 'checked' : ''}><span>${ALERT_ICON[k]} ${label}</span></label>`).join('')}</div>`;
}

function minutesSelect(selected, name = 'alertMins') {
  const opts = ALERT_MINUTES.includes(Number(selected)) ? ALERT_MINUTES : [...ALERT_MINUTES, Number(selected)].sort((a, b) => a - b);
  return `<label class="field"><span>Remind me</span><select name="${name}">${opts.map((m) => `<option value="${m}" ${m === Number(selected) ? 'selected' : ''}>${m} minutes before</option>`).join('')}</select></label>`;
}

function classCard(o) {
  const st = occStatus(o);
  const c = o.cls;
  const isToday = o.key === ymd();
  const unmarked = st === 'done' && o.attended === null;
  let pill = '';
  if (st === 'cancelled') pill = 'Cancelled';
  else if (st === 'now') pill = `Now · ${fmtDuration(o.end - Date.now())} left`;
  else if (st === 'done') pill = o.attended === true ? '✓ Attended' : o.attended === false ? '✗ Missed' : 'Mark attendance';
  else if (isToday) pill = `in ${fmtDuration(o.start - Date.now())}`;

  // The whole card is one tap target; cancel / alert / attendance / notes live in the class sheet.
  const alertTag = st === 'upcoming' && o.alert !== 'off' ? `${ALERT_ICON[o.alert]} ${o.alertMins}m` : '';
  const meta = [c.type, c.room && `📍 ${c.room}`, c.lecturer, c.repeat === 'once' && 'one-off', alertTag].filter(Boolean).map(esc).join(' · ');
  return `
    <button class="item class-card s-${st} ${unmarked ? 'unmarked' : ''}" style="${colorVars(c.color)}" data-action="occ-sheet" data-occ="${o.id}">
      <div class="time"><b>${fmtTime(c.start)}</b><span>${fmtTime(c.end)}</span></div>
      <div class="grow">
        <div class="row" style="align-items:flex-start">
          <div class="title grow">${esc(clsLabel(c))}${c.course && c.title ? ` <span class="sub">${esc(c.title)}</span>` : ''}</div>
          ${pill ? `<span class="pill">${esc(pill)}</span>` : ''}
        </div>
        ${meta ? `<div class="meta">${meta}</div>` : ''}
        ${o.cancelled && o.reason ? `<div class="occ-note">❌ ${esc(o.reason)}</div>` : ''}
        ${o.note ? `<div class="occ-note">📝 ${esc(o.note)}</div>` : ''}
      </div>
    </button>`;
}

/** Class cards with "free time" markers between them. */
function classListWithGaps(list) {
  let html = '';
  let prevEnd = null;
  for (const o of list) {
    if (prevEnd && !o.cancelled && o.start - prevEnd >= 30 * MIN) html += `<div class="gap">☕ Free ${fmtDuration(o.start - prevEnd)}</div>`;
    html += classCard(o);
    if (!o.cancelled) prevEnd = Math.max(prevEnd || 0, o.end);
  }
  return html;
}

function nextClassCard() {
  if (!data.classes.length) {
    return `<button class="card hero" data-action="tab" data-tab="timetable">
      <div class="hero-label">TIMETABLE</div>
      <div class="hero-title">Add your classes →</div>
      <div class="muted small">See today's classes here, cancel ones that won't happen, mark attendance and get reminders before each class.</div>
    </button>`;
  }
  const todays = occurrencesOn(ymd());
  const live = todays.filter((o) => !o.cancelled);
  const now = live.find((o) => occStatus(o) === 'now');
  const next = live.find((o) => occStatus(o) === 'upcoming');
  const o = now || next;
  if (!o) {
    // look ahead up to a week for the next class day
    let ahead = null;
    for (let i = 1; i <= 7 && !ahead; i++) ahead = occurrencesOn(addDays(ymd(), i)).find((x) => !x.cancelled) || null;
    const when = ahead ? (ahead.key === addDays(ymd(), 1) ? 'Tomorrow' : fmtDay(ahead.key, { weekday: 'long' })) : '';
    return `<div class="card hero">
      <div class="hero-label">${todays.length ? (todays.every((x) => x.cancelled) ? 'ALL CLASSES CANCELLED TODAY' : 'DONE FOR TODAY 🎉') : 'NO CLASSES TODAY'}</div>
      ${ahead ? `<div class="muted">${when}: <b style="color:var(--text)">${esc(clsLabel(ahead.cls))}</b> at ${fmtTime(ahead.cls.start)}${ahead.cls.room ? ` · ${esc(ahead.cls.room)}` : ''}</div>` : ''}
    </div>`;
  }
  const isNow = o === now;
  const after = isNow ? live.find((x) => x.start >= o.end) : null;
  return `<button class="card hero" style="${colorVars(o.cls.color)}" data-action="occ-sheet" data-occ="${o.id}">
    <div class="hero-label">${isNow ? `NOW · ${fmtDuration(o.end - Date.now())} left` : `NEXT · in ${fmtDuration(o.start - Date.now())}`}</div>
    <div class="hero-title">${esc(clsLabel(o.cls))}${o.cls.course && o.cls.title ? ` <span>${esc(o.cls.title)}</span>` : ''}</div>
    <div class="muted small">${fmtTime(o.cls.start)}–${fmtTime(o.cls.end)}${o.cls.room ? ` · 📍 ${esc(o.cls.room)}` : ''}${!isNow && o.alert !== 'off' ? ` · ${ALERT_ICON[o.alert]} ${o.alertMins}m before` : ''}</div>
    ${o.note ? `<div class="occ-note">📝 ${esc(o.note)}</div>` : ''}
    ${after ? `<div class="muted small" style="margin-top:6px">Then: ${esc(clsLabel(after.cls))} at ${fmtTime(after.cls.start)}</div>` : ''}
  </button>`;
}

function todayClassesSection() {
  if (!data.classes.length) return '';
  const list = occurrencesOn(ymd());
  return `<h2 class="section">Today's classes <button data-action="tab" data-tab="timetable">Timetable</button></h2>
    ${list.length ? classListWithGaps(list) : '<div class="card empty small">No classes today 🌤️</div>'}`;
}

// ---------------------------------------------------------------------
// Timetable tab
// ---------------------------------------------------------------------
VIEWS.timetable = () => {
  const modes = [['day', 'Day'], ['week', 'Week'], ['attendance', 'Attendance']];
  const seg = `<div class="seg">${modes.map(([k, l]) => `<button class="${state.ttMode === k ? 'on' : ''}" data-action="tt-mode" data-mode="${k}">${l}</button>`).join('')}</div>`;
  if (!data.classes.length) {
    return `${seg}<div class="card empty" style="padding:36px 16px"><span class="big">🗓️</span><b>Set up your timetable</b><br>
      Add each class once and it repeats every week, all semester. You only come back here to cancel a class or change something.<br><br>
      <button class="btn primary" data-action="new-class">＋ Add your first class</button></div>`;
  }
  const body = state.ttMode === 'week' ? weekView() : state.ttMode === 'attendance' ? attendanceView() : dayView();
  return `${seg}${body}<button class="fab" data-action="new-class" aria-label="Add class">${ICON.plus}</button>`;
};

function weekNav() {
  const ws = weekStartKey(state.ttDate);
  const label = `${fmtDay(ws, { day: 'numeric', month: 'short' })} – ${fmtDay(addDays(ws, 6), { day: 'numeric', month: 'short' })}`;
  const thisWeek = ws === weekStartKey(ymd());
  return `<div class="weeknav">
    <button class="btn" data-action="tt-shift" data-n="-7" aria-label="Previous week">‹</button>
    <div class="label">${label}<div class="muted small">${thisWeek ? 'This week' : '&nbsp;'}</div></div>
    ${state.ttDate !== ymd() ? '<button class="btn" data-action="tt-today">Today</button>' : ''}
    <button class="btn" data-action="tt-shift" data-n="7" aria-label="Next week">›</button>
  </div>`;
}

function dayView() {
  const ws = weekStartKey(state.ttDate);
  const today = ymd();
  const strip = [...Array(7)].map((_, i) => {
    const k = addDays(ws, i);
    const n = occurrencesOn(k).filter((o) => !o.cancelled).length;
    return `<button class="${k === state.ttDate ? 'sel' : ''} ${k === today ? 'today' : ''}" data-action="tt-pick" data-key="${k}">
      ${WEEKDAYS[dowOf(k)]}<b>${new Date(parseYmd(k)).getDate()}</b><span class="dots">${'<i></i>'.repeat(Math.min(n, 4))}</span></button>`;
  }).join('');
  const list = occurrencesOn(state.ttDate);
  const heading = state.ttDate === today ? 'Today' : state.ttDate === addDays(today, 1) ? 'Tomorrow' : state.ttDate === addDays(today, -1) ? 'Yesterday' : fmtDay(state.ttDate, { weekday: 'long' });
  return `${weekNav()}
    <div class="weekstrip">${strip}</div>
    <h2 class="section">${heading} · ${fmtDay(state.ttDate, { day: 'numeric', month: 'long' })}</h2>
    ${list.length ? classListWithGaps(list) : `<div class="card empty"><span class="big">🌤️</span>No classes on ${WEEKDAYS_LONG[dowOf(state.ttDate)]}</div>`}`;
}

function weekView() {
  const PX = 0.9; // pixels per minute (54px per hour)
  const ws = weekStartKey(state.ttDate);
  const today = ymd();
  let keys = [...Array(7)].map((_, i) => addDays(ws, i));
  const occ = Object.fromEntries(keys.map((k) => [k, occurrencesOn(k)]));
  keys = keys.filter((k, i) => i < 5 || occ[k].length); // show Sat/Sun only if used
  const all = keys.flatMap((k) => occ[k]);
  const lo = Math.floor(Math.min(8 * 60, ...all.map((o) => toMin(o.cls.start))) / 60) * 60;
  const hi = Math.ceil(Math.max(17 * 60, ...all.map((o) => toMin(o.cls.end))) / 60) * 60;
  const H = (hi - lo) * PX;
  const hours = [];
  for (let h = lo / 60; h <= hi / 60; h++) hours.push(h);
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();

  return `${weekNav()}
    <div class="wgrid" style="--cols:${keys.length}">
      <div></div>
      ${keys.map((k) => `<button class="whead ${k === today ? 'today' : ''}" data-action="tt-pick" data-key="${k}">${WEEKDAYS[dowOf(k)]}<b>${new Date(parseYmd(k)).getDate()}</b></button>`).join('')}
      <div class="wtimes" style="height:${H}px">${hours.map((h) => `<span style="top:${(h * 60 - lo) * PX}px">${h}</span>`).join('')}</div>
      ${keys.map((k) => `<div class="wcol ${k === today ? 'today' : ''}" style="height:${H}px">
        ${occ[k].map((o) => {
          const top = (toMin(o.cls.start) - lo) * PX;
          const h = Math.max((toMin(o.cls.end) - toMin(o.cls.start)) * PX, 24);
          return `<button class="wblock ${o.cancelled ? 'cancelled' : ''}" style="${colorVars(o.cls.color)};top:${top}px;height:${h}px" data-action="tt-pick" data-key="${k}">
            <b>${esc(clsLabel(o.cls))}</b>${o.cls.room && h > 34 ? `<span>${esc(o.cls.room)}</span>` : ''}</button>`;
        }).join('')}
        ${k === today && nowMin >= lo && nowMin <= hi ? `<div class="nowline" style="top:${(nowMin - lo) * PX}px"></div>` : ''}
      </div>`).join('')}
    </div>
    <p class="hint" style="text-align:center;margin-top:10px">Tap a class to open that day.</p>
    <button class="btn block" style="margin-top:6px" data-action="calendar-export">📅 Add timetable to phone calendar</button>`;
}

function attendanceView() {
  const byCourse = new Map();
  for (const c of data.classes) {
    const k = clsLabel(c);
    if (!byCourse.has(k)) byCourse.set(k, { color: c.color, title: c.title, att: 0, miss: 0, canc: 0, unmarked: 0 });
  }
  const today = ymd();
  for (const o of data.occurrences) {
    const c = byId('classes', o.classId);
    if (!c) continue;
    const r = byCourse.get(clsLabel(c));
    if (o.cancelled) r.canc++;
    else if (o.attended === true) r.att++;
    else if (o.attended === false) r.miss++;
  }
  // classes earlier this week that ended but weren't marked
  const ws = weekStartKey(today);
  for (let i = 0; i < 7; i++) {
    const k = addDays(ws, i);
    if (k > today) break;
    for (const o of occurrencesOn(k)) if (occStatus(o) === 'done' && o.attended === null) byCourse.get(clsLabel(o.cls)).unmarked++;
  }
  const rows = [...byCourse].sort((a, b) => a[0].localeCompare(b[0]));
  return `
    <p class="hint" style="margin:0 2px 12px">Tap a class after it ends to mark ✓ attended or ✗ missed. Below 75% turns red.</p>
    ${rows.map(([name, r]) => {
      const total = r.att + r.miss;
      const pct = total ? Math.round((r.att / total) * 100) : null;
      const color = pct === null ? 'var(--muted)' : pct < 75 ? 'var(--red)' : pct < 85 ? 'var(--orange)' : 'var(--green)';
      return `<div class="card att" style="margin-bottom:8px">
        <div class="row">
          <span class="dot" style="background:${r.color}"></span>
          <div class="grow"><b>${esc(name)}</b>${r.title && r.title !== name ? ` <span class="muted small">${esc(r.title)}</span>` : ''}</div>
          <b style="color:${color};font-size:1.2rem">${pct === null ? '—' : `${pct}%`}</b>
        </div>
        <div class="bar"><div style="width:${pct ?? 0}%;background:${color}"></div></div>
        <div class="meta" style="margin-top:6px">${total ? `${r.att} of ${total} attended` : 'Nothing marked yet'}${r.canc ? ` · ${r.canc} cancelled` : ''}${r.unmarked ? ` · <span style="color:var(--orange)">${r.unmarked} unmarked this week</span>` : ''}</div>
      </div>`;
    }).join('')}`;
}

// ---------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------
function classForm(c = {}) {
  const isNew = !c.id;
  const repeat = c.repeat || 'weekly';
  const day = c.day ?? dowOf(state.ttDate || ymd());
  const used = new Set(data.classes.map((x) => x.color));
  const color = c.color || CLASS_COLORS.find((x) => !used.has(x)) || CLASS_COLORS[0];
  openSheet(`
    <h3>${isNew ? (repeat === 'once' ? 'Make-up / extra class' : 'New class') : 'Edit class'}</h3>
    <form data-form="class">
      <input type="hidden" name="id" value="${esc(c.id || '')}">
      <div class="two">
        <label class="field"><span>Course code</span><input type="text" name="course" list="courseList" value="${esc(c.course || '')}" placeholder="CSC 311" data-action-change="class-course" ${isNew && !c.course ? 'autofocus' : ''}>${datalist('courseList', allCourses())}</label>
        <label class="field"><span>Type</span><select name="type">${CLASS_TYPES.map((t) => `<option ${t === (c.type || 'Lecture') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Course name</span><input type="text" name="title" value="${esc(c.title || '')}" placeholder="Operating Systems"></label>
      <label class="field"><span>Repeats</span>
        <select name="repeat" data-action-change="class-repeat">
          <option value="weekly" ${repeat === 'weekly' ? 'selected' : ''}>Every week</option>
          <option value="once" ${repeat === 'once' ? 'selected' : ''}>Once (make-up / extra class)</option>
        </select>
      </label>
      ${isNew
        ? `<div class="field ${repeat === 'once' ? 'hidden' : ''}" data-when="weekly"><span>Every week on (pick all the days it meets)</span>
            <div class="daypick">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label><input type="checkbox" name="days" value="${d}" ${d === day ? 'checked' : ''}><span>${WEEKDAYS[d]}</span></label>`).join('')}</div>
            <p class="hint" style="margin:8px 2px 0">Add it once. It repeats every week until you delete it.</p></div>`
        : `<label class="field ${repeat === 'once' ? 'hidden' : ''}" data-when="weekly"><span>Every week on</span>
            <select name="day">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<option value="${d}" ${d === day ? 'selected' : ''}>${WEEKDAYS_LONG[d]}</option>`).join('')}</select></label>`}
      <label class="field ${repeat !== 'once' ? 'hidden' : ''}" data-when="once"><span>Date</span><input type="date" name="date" value="${esc(c.date || state.ttDate || ymd())}"></label>
      <div class="two">
        <label class="field"><span>Starts</span><input type="time" name="start" required value="${esc(c.start || '08:00')}"></label>
        <label class="field"><span>Ends</span><input type="time" name="end" required value="${esc(c.end || '10:00')}"></label>
      </div>
      <div class="two">
        <label class="field"><span>Room / venue</span><input type="text" name="room" value="${esc(c.room || '')}" placeholder="LT 2"></label>
        <label class="field"><span>Lecturer</span><input type="text" name="lecturer" value="${esc(c.lecturer || '')}" placeholder="Dr. …"></label>
      </div>
      <div class="field"><span>Colour</span><div class="swatches">${CLASS_COLORS.map((x) => `<label><input type="radio" name="color" value="${x}" ${x === color ? 'checked' : ''}><span style="--c:${x}"></span></label>`).join('')}</div></div>
      <div class="field"><span>Alert before this class</span>${alertModeSeg(c.alert ?? settings.alertMode)}</div>
      ${minutesSelect(c.alertMins ?? settings.alertMins)}
      <div class="row">
        ${isNew ? '' : `<button type="button" class="btn danger" data-action="delete-class" data-id="${c.id}">Delete</button>`}
        <span class="grow"></span>
        <button type="button" class="btn" data-action="close-sheet">Cancel</button>
        <button class="btn primary">${isNew ? 'Add class' : 'Save'}</button>
      </div>
    </form>`);
}

function occSheet(o) {
  const st = occStatus(o);
  const c = o.cls;
  openSheet(`
    <h3>${esc(clsLabel(c))}${c.course && c.title ? ` <span class="muted" style="font-weight:400;font-size:1rem">${esc(c.title)}</span>` : ''}</h3>
    <p class="muted small" style="margin-top:-8px">${fmtDay(o.key, { weekday: 'long', day: 'numeric', month: 'short' })} · ${fmtTime(c.start)}–${fmtTime(c.end)}${c.room ? ` · 📍 ${esc(c.room)}` : ''}${c.lecturer ? ` · ${esc(c.lecturer)}` : ''}</p>
    ${o.cancelled ? `<div class="occ-note" style="margin-bottom:12px">❌ Cancelled${o.reason ? `: ${esc(o.reason)}` : ''}</div>` : ''}
    ${st === 'now' || st === 'done' ? `<div class="row" style="margin-bottom:14px">
        <button type="button" class="mini ${o.attended === true ? 'on good' : ''}" data-action="attend" data-v="1" data-occ="${o.id}">✓ Attended</button>
        <button type="button" class="mini ${o.attended === false ? 'on bad' : ''}" data-action="attend" data-v="0" data-occ="${o.id}">✗ Missed</button></div>` : ''}
    <form data-form="occ">
      <input type="hidden" name="occ" value="${o.id}">
      ${st === 'upcoming' ? `
        <div class="field"><span>Alert for this class</span>${alertModeSeg(o.alert)}</div>
        ${minutesSelect(o.alertMins)}
        ${c.repeat !== 'once' ? `<label class="checkline"><input type="checkbox" name="applyAll"> Use this alert for every ${WEEKDAYS_LONG[c.day]} ${esc(clsLabel(c))} class</label>` : ''}` : ''}
      <label class="field"><span>Note for this day</span><input type="text" name="note" value="${esc(o.note)}" placeholder="Room changed to LT 4, bring laptop…"></label>
      <div class="row wrap">
        ${o.cancelled
          ? `<button type="button" class="btn" data-action="restore-class" data-occ="${o.id}">↩ Restore class</button>`
          : st !== 'done' ? `<button type="button" class="btn danger" data-action="cancel-class" data-occ="${o.id}">✕ Cancel class</button>` : ''}
        <button type="button" class="btn" data-action="edit-class" data-id="${c.id}">✎ Edit class</button>
        <span class="grow"></span>
        <button class="btn primary">Save</button>
      </div>
      ${st === 'upcoming' ? (NATIVE
        ? '<p class="hint" style="margin-top:12px">Android will alert you even if StudyHub is closed or the phone is locked.</p>'
        : `<p class="hint" style="margin-top:12px">Alerts ring while StudyHub is open or running in the background. If you want reminders even when the app is fully closed, use <b>☰ → Add timetable to phone calendar</b>.</p>`) : ''}
    </form>`);
}

function cancelSheet(o) {
  openSheet(`
    <h3>Cancel this class?</h3>
    <p class="muted small" style="margin-top:-8px">${esc(clsLabel(o.cls))} · ${fmtDay(o.key, { weekday: 'long', day: 'numeric', month: 'short' })} · ${fmtTime(o.cls.start)}</p>
    <form data-form="cancel">
      <input type="hidden" name="occ" value="${o.id}">
      <label class="field"><span>Reason (optional)</span><input type="text" name="reason" placeholder="Lecturer posted on the class group"></label>
      <div class="chips wrap">${['Lecturer absent', 'Public holiday', 'Moved online', 'Rescheduled', 'Exams week'].map((r) => `<button type="button" class="chip" data-action="reason-chip" data-value="${r}">${r}</button>`).join('')}</div>
      <label class="checkline"><input type="checkbox" name="makeup"> Add a make-up class</label>
      <div class="row end">
        <button type="button" class="btn" data-action="close-sheet">Keep class</button>
        <button class="btn primary danger-fill">Cancel class</button>
      </div>
      <p class="hint" style="margin-top:12px">Only this day is cancelled. Next week's class stays on the timetable.</p>
    </form>`);
}

function calendarSheet() {
  openSheet(`
    <h3>Add timetable to phone calendar</h3>
    <p class="muted small" style="margin-top:-8px">Your phone's calendar can remind you before every class, even when StudyHub is closed. This is the most reliable way to get alerts.</p>
    <form data-form="ics">
      <label class="field"><span>Repeat classes until (end of semester)</span><input type="date" name="until" required value="${addDays(ymd(), 7 * 15)}"></label>
      <label class="field"><span>Reminder</span><select name="mins">
        <option value="0">No reminder</option>
        ${ALERT_MINUTES.map((m) => `<option value="${m}" ${m === settings.alertMins ? 'selected' : ''}>${m} minutes before</option>`).join('')}
      </select></label>
      <button class="btn primary block">Create calendar file</button>
    </form>
    <p class="hint" style="margin-top:14px"><b>iPhone:</b> the file opens in Calendar. Tap <i>Add All</i>.<br>
      <b>Android:</b> open the downloaded <code>timetable.ics</code> and pick your Calendar app (Samsung Calendar, Etar…). With Google Calendar, import it at calendar.google.com → Settings → Import, and it syncs to your phone.<br>
      Cancelled classes are skipped. If you change your timetable, delete the old calendar events and export again.</p>`);
}

// ---------------------------------------------------------------------
// Calendar export (.ics, RFC 5545)
// ---------------------------------------------------------------------
function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1'); }
function icsDate(ms) { const d = new Date(ms); return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}00`; }
function icsFold(line) { const out = []; while (line.length > 73) { out.push(line.slice(0, 73)); line = ` ${line.slice(73)}`; } out.push(line); return out.join('\r\n'); }

function buildICS(untilKey, mins) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const today = ymd();
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//StudyHub//Timetable//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Timetable'];
  let n = 0;
  for (const c of data.classes) {
    let first;
    if (c.repeat === 'once') {
      if (c.date < today || byId('occurrences', `${c.id}@${c.date}`)?.cancelled) continue;
      first = c.date;
    } else {
      first = addDays(today, (c.day - dowOf(today) + 7) % 7);
      if (first > untilKey) continue;
    }
    const summary = `${clsLabel(c)}${c.course && c.title ? ` – ${c.title}` : ''}${c.type ? ` (${c.type})` : ''}`;
    L.push('BEGIN:VEVENT', `UID:${c.id}@studyhub`, `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(atTime(first, c.start))}`, `DTEND:${icsDate(atTime(first, c.end))}`, `SUMMARY:${icsEscape(summary)}`);
    if (c.room) L.push(`LOCATION:${icsEscape(c.room)}`);
    if (c.lecturer) L.push(`DESCRIPTION:${icsEscape(`Lecturer: ${c.lecturer}`)}`);
    if (c.repeat !== 'once') {
      L.push(`RRULE:FREQ=WEEKLY;UNTIL=${untilKey.replace(/-/g, '')}T235959`);
      const ex = data.occurrences.filter((o) => o.classId === c.id && o.cancelled && o.date >= first).map((o) => icsDate(atTime(o.date, c.start)));
      if (ex.length) L.push(`EXDATE:${ex.join(',')}`);
    }
    if (mins > 0) L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(summary)}`, `TRIGGER:-PT${mins}M`, 'END:VALARM');
    L.push('END:VEVENT');
    n++;
  }
  L.push('END:VCALENDAR');
  return { text: L.map(icsFold).join('\r\n') + '\r\n', count: n };
}

// ---------------------------------------------------------------------
// Actions & forms
// ---------------------------------------------------------------------
Object.assign(ACTIONS, {
  'tt-mode': (el) => { state.ttMode = el.dataset.mode; render(); },
  'tt-shift': (el) => { state.ttDate = addDays(state.ttDate, Number(el.dataset.n)); render(); },
  'tt-today': () => { state.ttDate = ymd(); render(); },
  'tt-pick': (el) => { state.ttDate = el.dataset.key; state.ttMode = 'day'; render(); },
  'new-class': () => classForm(),
  'edit-class': (el) => classForm(byId('classes', el.dataset.id)),
  'occ-sheet': (el) => { const o = getOcc(el.dataset.occ); if (o) occSheet(o); },
  'cancel-class': (el) => { const o = getOcc(el.dataset.occ); if (o) cancelSheet(o); },
  'reason-chip': (el) => { el.closest('form').elements.reason.value = el.dataset.value; },
  'calendar-export': () => { hideDrawer(); calendarSheet(); },
  async 'restore-class'(el) {
    const o = getOcc(el.dataset.occ);
    await saveOcc(o, { cancelled: false, reason: '', fired: false });
    closeSheet(); render();
    toast('Class restored');
  },
  async attend(el) {
    const o = getOcc(el.dataset.occ);
    const v = el.dataset.v === '1';
    await saveOcc(o, { attended: o.attended === v ? null : v });
    if (sheetOpen()) occSheet(getOcc(o.id));
    render();
  },
  async 'delete-class'(el) {
    const c = byId('classes', el.dataset.id);
    if (!confirm(`Delete ${clsLabel(c)}${c.repeat === 'once' ? '' : ` on ${WEEKDAYS_LONG[c.day]}s`}? Its attendance history goes too.`)) return;
    for (const o of data.occurrences.filter((x) => x.classId === c.id)) await dbDel('occurrences', o.id);
    await remove('classes', c.id);
    closeSheet(); render();
    toast('Class deleted');
  },
});

Object.assign(CHANGE_ACTIONS, {
  'class-repeat': (el) => {
    const form = el.form;
    form.querySelector('[data-when=weekly]').classList.toggle('hidden', el.value !== 'weekly');
    form.querySelector('[data-when=once]').classList.toggle('hidden', el.value !== 'once');
  },
  // Picking a course you already have fills in its name, lecturer and colour.
  'class-course': (el) => {
    const form = el.form;
    if (form.elements.id.value) return;
    const match = data.classes.find((c) => c.course && c.course.toLowerCase() === el.value.trim().toLowerCase());
    if (!match) return;
    if (!form.elements.title.value) form.elements.title.value = match.title || '';
    if (!form.elements.lecturer.value) form.elements.lecturer.value = match.lecturer || '';
    const sw = form.querySelector(`input[name=color][value="${match.color}"]`);
    if (sw) sw.checked = true;
  },
});

Object.assign(FORMS, {
  async class(form) {
    const fd = new FormData(form);
    const f = Object.fromEntries(fd);
    const days = f.id ? [Number(f.day)] : fd.getAll('days').map(Number);
    if (f.repeat !== 'once' && !days.length) return toast('Pick at least one day');
    if (!f.course.trim() && !f.title.trim()) return toast('Add a course code or a name');
    if (f.end <= f.start) return toast('End time must be after the start time');
    if (f.repeat === 'once' && !f.date) return toast('Pick a date for the one-off class');
    const permP = f.alert !== 'off' ? ensureNotifyPermission() : null; // must run inside the tap
    const prev = f.id ? byId('classes', f.id) : {};
    const base = {
      ...prev,
      course: f.course.trim(),
      title: f.title.trim(),
      type: f.type,
      repeat: f.repeat,
      day: f.repeat === 'once' ? dowOf(f.date) : days[0],
      date: f.repeat === 'once' ? f.date : null,
      start: f.start,
      end: f.end,
      room: f.room.trim(),
      lecturer: f.lecturer.trim(),
      color: f.color || CLASS_COLORS[0],
      alert: f.alert || 'off',
      alertMins: Number(f.alertMins) || 30,
      created: prev.created || Date.now(),
    };
    // one record per weekday it meets (a one-off class is a single record)
    const saved = (f.repeat === 'once' ? [base.day] : days).map((d, i) => ({ ...base, id: i === 0 && f.id ? f.id : uid(), day: d }));
    for (const cls of saved) await dbPut('classes', cls);
    // keep one colour per course
    for (const other of data.classes.filter((x) => !saved.some((c) => c.id === x.id) && x.course && x.course === base.course && x.color !== base.color)) {
      await dbPut('classes', { ...other, color: base.color });
    }
    await loadAll();
    let clash = null;
    for (const cls of saved) {
      const others = cls.repeat === 'once' ? occurrencesOn(cls.date).map((o) => o.cls) : data.classes.filter((x) => x.repeat !== 'once' && x.day === cls.day);
      clash = clash || others.find((x) => !saved.some((c) => c.id === x.id) && x.start < cls.end && cls.start < x.end);
    }
    if (base.repeat === 'once') state.ttDate = base.date;
    closeSheet(); render();
    const perm = permP ? await permP : null;
    const when = base.repeat === 'once' ? fmtDay(base.date) : `every ${saved.map((c) => WEEKDAYS[c.day]).join(' & ')}`;
    toast(clash ? `⚠️ Saved, but it overlaps ${clsLabel(clash)}` : perm === 'denied' ? 'Saved (notifications blocked: alerts only show in-app)' : `${f.id ? 'Saved' : 'Added'}: ${clsLabel(base)} ${when}`);
  },

  async occ(form) {
    const f = Object.fromEntries(new FormData(form));
    const o = getOcc(f.occ);
    if (!o) return closeSheet();
    const permP = f.alert && f.alert !== 'off' ? ensureNotifyPermission() : null;
    const patch = { note: f.note.trim() };
    if (f.alert) {
      patch.alert = f.alert;
      patch.alertMins = Number(f.alertMins);
      if (f.alert !== o.alert || patch.alertMins !== o.alertMins) patch.fired = false;
    }
    await saveOcc(o, patch);
    if (f.applyAll) await save('classes', { ...o.cls, alert: f.alert, alertMins: Number(f.alertMins) });
    closeSheet(); render();
    const perm = permP ? await permP : null;
    if (perm === 'denied') toast('Saved. Notifications are blocked, so the alert only shows in-app');
    else if (f.alert && f.alert !== 'off') toast(`${ALERT_ICON[f.alert]} Alert set for ${f.alertMins} min before`);
    else toast('Saved');
  },

  async cancel(form) {
    const f = Object.fromEntries(new FormData(form));
    const o = getOcc(f.occ);
    await saveOcc(o, { cancelled: true, reason: f.reason.trim() });
    render();
    toast(`${clsLabel(o.cls)} cancelled for ${fmtDay(o.key, { weekday: 'long' })}`);
    if (f.makeup) {
      const { id, created, day, ...rest } = o.cls;
      classForm({ ...rest, repeat: 'once', date: addDays(o.key, 1) });
    } else closeSheet();
  },

  async ics(form) {
    const f = Object.fromEntries(new FormData(form));
    const { text, count } = buildICS(f.until, Number(f.mins));
    if (!count) return toast('No upcoming classes to export');
    await shareOrDownload(new File([text], 'timetable.ics', { type: 'text/calendar' }), false);
    closeSheet();
    toast(`Exported ${count} class${count === 1 ? '' : 'es'}`);
  },
});
