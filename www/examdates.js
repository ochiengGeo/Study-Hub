'use strict';
/* Exams section: upcoming CATs, main exams, practicals… with countdowns, reminders
 * (reminders.js) and shortcuts to revise: the unit's flashcards and a practice paper.
 *   exams: { id, course, type, title, start (ms), minutes, venue, topics, result, created } */

const EXAM_TYPES = ['CAT', 'Main exam', 'Practical', 'Quiz', 'Supplementary', 'Other'];
const EXAM_LENGTHS = [30, 45, 60, 90, 120, 150, 180];
Object.assign(state, { examFilter: 'upcoming' });

const examEnd = (x) => x.start + (x.minutes || 120) * MIN;
const examName = (x) => [x.course, x.title || x.type].filter(Boolean).join(' · ');
const upcomingExams = () => data.exams.filter((x) => examEnd(x) > Date.now()).sort((a, b) => a.start - b.start);
const fmtLen = (m) => (m < 60 ? `${m} min` : `${m / 60} h`.replace('.5 h', '½ h'));

function examCountdown(x) {
  const days = Math.round((startOfDay(x.start) - startOfDay()) / DAY);
  if (x.start <= Date.now()) return { text: 'Now', cls: 'urgent' };
  if (days === 0) return { text: `Today ${new Date(x.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, cls: 'urgent' };
  if (days === 1) return { text: 'Tomorrow', cls: 'urgent' };
  return { text: `in ${days} days`, cls: days <= 3 ? 'soon' : days <= 7 ? 'week' : 'later' };
}

/** A unit's deck: the AI deck for that course, or any deck holding cards for it. */
function unitDeck(course) {
  const n = normCode(course);
  const c = data.cards.find((k) => normCode(k.course) === n) || data.cards.find((k) => normCode(k.deck).startsWith(n));
  return c ? c.deck : null;
}

function examItem(x) {
  const past = examEnd(x) <= Date.now();
  const cd = examCountdown(x);
  const deck = unitDeck(x.course);
  const due = deck ? dueCards(deck).length : 0;
  return `
    <div class="item exam-item ${past ? 'done-exam' : `u-${cd.cls}`}">
      <button class="body" data-action="edit-exam" data-id="${x.id}">
        <div class="row" style="align-items:flex-start">
          <div class="grow" style="min-width:0">
            <div class="title">${esc(examName(x))}</div>
            <div class="meta">${esc(x.type)} · ${esc(fmtDue(x.start))} · ${fmtLen(x.minutes || 120)}${x.venue ? ` · 📍 ${esc(x.venue)}` : ''}</div>
            ${x.topics ? `<div class="small" style="margin-top:4px">📚 ${esc(x.topics)}</div>` : ''}
            ${past && x.result ? `<div class="small" style="margin-top:4px">🎯 ${esc(x.result)}</div>` : ''}
          </div>
          ${past ? (x.result ? '' : '<span class="muted small">Add result</span>') : `<span class="pill">${cd.text}</span>`}
        </div>
      </button>
      ${past ? '' : `<div class="actions">
        ${deck ? `<button class="btn" data-action="start-review" data-deck="${esc(deck)}" ${due ? '' : 'disabled'}>🃏 ${due ? `Revise ${due}` : 'Cards done'}</button>` : ''}
        ${aiAvailable() ? `<button class="btn" data-action="exam-practise" data-course="${esc(x.course)}">📝 Practice paper</button>` : ''}
      </div>`}
    </div>`;
}

VIEWS.exams = () => {
  const past = state.examFilter === 'past';
  const list = past
    ? data.exams.filter((x) => examEnd(x) <= Date.now()).sort((a, b) => b.start - a.start)
    : upcomingExams();
  const movable = data.deadlines.filter((d) => !d.done && /exam|cat/i.test(d.type || '') && d.due > Date.now());
  return `
    <div class="chips">
      <button class="chip ${!past ? 'active' : ''}" data-action="exam-filter" data-value="upcoming">Upcoming</button>
      <button class="chip ${past ? 'active' : ''}" data-action="exam-filter" data-value="past">Past</button>
    </div>
    ${!past && movable.length ? `<button class="card nudge-card" data-action="exam-import" style="margin-bottom:12px;width:100%;text-align:left">📥 <b>${movable.length}</b> exam${movable.length === 1 ? '' : 's'}/CAT${movable.length === 1 ? '' : 's'} are in Deadlines. <u>Move them here</u> for revision reminders.</button>` : ''}
    ${list.length ? list.map(examItem).join('')
      : `<div class="card empty"><span class="big">${past ? '🗂️' : '📝'}</span>${past ? 'No past exams yet' : 'No exams or CATs coming up.<br>Tap <b>+</b> to add one.'}<br><span class="small">You'll get reminders 3 days, 1 day and 2 hours before.</span></div>`}
    <button class="fab" data-action="new-exam" aria-label="Add exam">${ICON.plus}</button>`;
};

/** Today: the next exam within two weeks. */
function nextExamNudge() {
  const x = upcomingExams().find((e) => e.start - Date.now() < 14 * DAY);
  if (!x) return '';
  const cd = examCountdown(x);
  return `<button class="nudge" data-action="tab" data-tab="exams">📝 <span><b>${esc(examName(x))}</b> ${cd.text.startsWith('in') ? cd.text : `· ${cd.text}`}${x.venue ? ` · 📍 ${esc(x.venue)}` : ''}</span>${ICON.chevron}</button>`;
}

function examForm(x = {}) {
  const isNew = !x.id;
  const start = x.start ?? (startOfDay() + 7 * DAY + 9 * HOUR);
  const past = !isNew && examEnd(x) <= Date.now();
  openSheet(`
    <h3>${isNew ? 'New exam or CAT' : 'Edit exam'}</h3>
    <form data-form="exam">
      <input type="hidden" name="id" value="${esc(x.id || '')}">
      <label class="field"><span>Unit</span><input type="text" name="course" list="examCourses" required value="${esc(x.course || '')}" placeholder="e.g. COMP 226" ${isNew ? 'autofocus' : ''}>${datalist('examCourses', allCourses())}</label>
      <div class="row">
        <label class="field grow"><span>Type</span><select name="type">${EXAM_TYPES.map((t) => `<option ${t === (x.type || 'CAT') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="field grow"><span>Name (optional)</span><input type="text" name="title" value="${esc(x.title || '')}" placeholder="e.g. CAT 1"></label>
      </div>
      <div class="row">
        <label class="field grow"><span>Date & time</span><input type="datetime-local" name="start" required value="${toLocalInput(start)}"></label>
        <label class="field"><span>Length</span><select name="minutes">${EXAM_LENGTHS.map((m) => `<option value="${m}" ${m === (x.minutes || 120) ? 'selected' : ''}>${fmtLen(m)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Venue (optional)</span><input type="text" name="venue" value="${esc(x.venue || '')}" placeholder="e.g. LT3, Science Complex"></label>
      <label class="field"><span>Topics covered (optional)</span><textarea name="topics" rows="2" placeholder="e.g. Lectures 1–5: flags, stack, interrupts">${esc(x.topics || '')}</textarea></label>
      ${past || x.result ? `<label class="field"><span>Your result (optional)</span><input type="text" name="result" value="${esc(x.result || '')}" placeholder="e.g. 24/30"></label>` : ''}
      <div class="row">
        ${isNew ? '' : `<button type="button" class="btn danger" data-action="delete-exam" data-id="${x.id}">Delete</button>`}
        <span class="grow"></span>
        <button type="button" class="btn" data-action="close-sheet">Cancel</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`);
}

FORMS.exam = async (form) => {
  const f = Object.fromEntries(new FormData(form));
  const prev = f.id ? byId('exams', f.id) : {};
  await save('exams', {
    ...prev,
    id: f.id || uid(),
    course: f.course.trim().toUpperCase().replace(/^([A-Z]{2,4})\s*(\d{3,4})$/, '$1 $2'),
    type: f.type,
    title: f.title.trim(),
    start: new Date(f.start).getTime(),
    minutes: Number(f.minutes) || 120,
    venue: f.venue.trim(),
    topics: f.topics.trim(),
    result: (f.result ?? prev.result ?? '').trim(),
    created: prev.created || Date.now(),
  });
  closeSheet();
  if (NATIVE) nativeSyncAlerts();
  render();
  toast(f.id ? 'Saved' : '📝 Added. Reminders 3 days, 1 day and 2 hours before');
};

Object.assign(ACTIONS, {
  'exam-filter': (el) => { state.examFilter = el.dataset.value; render(); },
  'new-exam': () => examForm(),
  'edit-exam': (el) => examForm(byId('exams', el.dataset.id)),
  async 'delete-exam'(el) {
    if (!confirm('Delete this exam?')) return;
    await remove('exams', el.dataset.id);
    closeSheet(); render();
  },
  'exam-practise': (el) => {
    state.tab = 'cards'; state.review = null; state.deck = null;
    ACTIONS['exam-again']({ dataset: { course: el.dataset.course } });
  },
  async 'exam-import'() {
    const list = data.deadlines.filter((d) => !d.done && /exam|cat/i.test(d.type || '') && d.due > Date.now());
    if (!confirm(`Move ${list.length} from Deadlines to Exams?`)) return;
    for (const d of list) {
      const isCat = /cat|quiz/i.test(d.type);
      await save('exams', { id: uid(), course: d.course || '', type: isCat ? 'CAT' : 'Main exam', title: d.title, start: d.due, minutes: isCat ? 60 : 120, venue: '', topics: '', result: '', created: Date.now() });
      await remove('deadlines', d.id);
    }
    if (NATIVE) nativeSyncAlerts();
    render();
    toast(`Moved ${list.length}`);
  },
});

TITLES.exams = 'Exams';
