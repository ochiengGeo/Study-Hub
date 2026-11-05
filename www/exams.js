'use strict';
/* Practice exams (Flashcards tab → 📝 Practice exams). The laptop (exams.py) has Gemini set a
 * paper from a unit's notes, then marks the answers. This file is the phone side: choosing a
 * unit, sitting the paper (answers are kept on this device until you submit, so you can leave
 * and come back), and reading the marked script. Needs the laptop (same Wi-Fi or Tailscale). */

const EX_SIZE = { quick: 'Quick', cat: 'CAT', exam: 'Full exam' };
let exList = null;       // /sync/exams
let exPaper = null;      // the paper on screen
let exError = '';
let exPoll = null;
let exTick = null;
const exPhotos = {};     // `${id}:${n}` -> data URL (kept in memory; text answers are saved)

const exKey = (id) => `studyhub-exam-${id}`;
function exDraft(id) {
  try { return JSON.parse(localStorage.getItem(exKey(id))) || { answers: {} }; } catch { return { answers: {} }; }
}
function exSaveDraft(id, d) { try { localStorage.setItem(exKey(id), JSON.stringify(d)); } catch { /* full: kept in memory */ } }

/** Row under ✨ AI cards on the Flashcards tab. */
function examPanel() {
  if (!aiAvailable()) return '';
  return `<button class="nudge" data-action="exam-home">📝 <span><b>Practice exams</b><br><span class="small muted">A paper set from your notes, marked with feedback</span></span>${ICON.chevron}</button>`;
}

// ---------------------------------------------------------------------
// Talking to the laptop
// ---------------------------------------------------------------------
async function exFetchList() {
  try { exList = await (await sfetch('/sync/exams')).json(); exError = ''; }
  catch (e) { exError = /404/.test(e.message) ? 'The laptop is running an older StudyHub. Restart ./run.sh phone.' : e.message; }
}
async function exFetchPaper(id) {
  try {
    exPaper = await (await sfetch(`/sync/exams/${id}`)).json();
    exError = '';
    if (exPaper.status === 'ready') { try { localStorage.setItem(`${exKey(id)}-paper`, JSON.stringify(exPaper)); } catch { /* ignore */ } }
  } catch (e) {
    // offline: a paper you already opened can still be answered (submit needs the laptop)
    try { exPaper = JSON.parse(localStorage.getItem(`${exKey(id)}-paper`)); } catch { exPaper = null; }
    exError = exPaper ? '' : e.message;
    if (exPaper) toast("Can't reach the laptop. You can keep answering and submit later.");
  }
}

/** While something is being written or marked, check every few seconds. */
function exSchedulePoll() {
  clearTimeout(exPoll);
  const busy = (s) => s === 'making' || s === 'marking';
  const waiting = state.exam && (state.exam.id ? busy(exPaper?.status) : exList?.exams.some((x) => busy(x.status)));
  if (!waiting) return;
  exPoll = setTimeout(async () => {
    if (!state.exam || state.tab !== 'cards') return;
    const was = exPaper?.status;
    if (state.exam.id) await exFetchPaper(state.exam.id); else await exFetchList();
    if (state.exam?.id && was === 'marking' && exPaper?.status === 'marked') toast(`📝 Marked: ${exPaper.score}/${exPaper.max}`);
    if (state.exam?.id && was === 'making' && exPaper?.status === 'ready') toast('📝 Your paper is ready');
    render();
  }, 5000);
}

// ---------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------
function examView() {
  const v = state.exam.id ? exPaperView() : exHomeView();
  setTimeout(exSchedulePoll, 0);
  return v;
}

function exStatus(x) {
  const pct = x.max ? Math.round((x.score / x.max) * 100) : 0;
  return {
    making: '⏳ Being written…',
    ready: exDraft(x.id).started ? '✏️ In progress' : '▶ Ready to start',
    marking: '⏳ Being marked…',
    answered: `⚠️ ${esc(x.error || 'Not marked yet')}`,
    marked: `<b>${x.score}/${x.max}</b> · ${pct}% · ${exGrade(pct)}`,
    error: `⚠️ ${esc(x.error || 'Failed')}`,
  }[x.status] || esc(x.status);
}

function exGrade(pct) { return pct >= 70 ? 'A' : pct >= 60 ? 'B' : pct >= 50 ? 'C' : pct >= 40 ? 'D' : 'E'; }

function exHomeView() {
  const top = '<div class="row" style="margin-bottom:12px"><button class="btn" data-action="exam-close">← Flashcards</button></div>';
  if (!exList) return `${top}<div class="card empty">${exError ? `⚠️ ${esc(exError)}` : 'Asking the laptop…'}</div>`;
  const L = exList;
  const unit = L.units.find((u) => u.course === state.exam.unit) || L.units[0];
  if (unit) state.exam.unit = unit.course;
  const sz = state.exam.size || 'cat';
  const form = !L.units.length
    ? `<div class="card empty"><span class="big">📚</span>No unit notes on the laptop yet.<br><span class="small">File notes as <b>Lecture notes</b> or <b>Books</b> with a unit set (Notes → Files → ⋯ Details).</span></div>`
    : `<form class="card" data-form="exam-new">
        <h3 style="margin-top:0">New practice paper</h3>
        <label class="field"><span>Unit</span><select name="course" data-action-change="exam-unit">${L.units.map((u) => `<option value="${esc(u.course)}" ${u === unit ? 'selected' : ''}>${esc(u.deck)}</option>`).join('')}</select></label>
        <label class="field"><span>From</span><select name="fileId"><option value="">All notes for this unit</option>${unit.files.map((f) => `<option value="${esc(f.id)}">Only ${esc(f.name)}</option>`).join('')}</select></label>
        <div class="seg">${Object.entries(L.sizes).map(([k, s]) => `
          <label><input type="radio" name="size" value="${k}" ${k === sz ? 'checked' : ''}><span>${EX_SIZE[k]}<br><small class="muted">${s.mcq + s.short + s.long} Qs · ${s.minutes < 60 ? `${s.minutes} min` : `${s.minutes / 60} h`}</small></span></label>`).join('')}
        </div>
        ${unit.pastPapers ? `<p class="hint" style="margin:0 2px 12px">Questions will follow the style of your ${unit.pastPapers} past paper${unit.pastPapers === 1 ? '' : 's'} for this unit.</p>`
          : '<p class="hint" style="margin:0 2px 12px">Tip: file past papers for this unit as <b>Past papers</b> and questions will follow their style.</p>'}
        ${L.keyPresent ? '' : '<p class="small" style="color:var(--red)">🔑 No Gemini API key on the laptop.</p>'}
        <button class="btn primary block" ${L.keyPresent ? '' : 'disabled'}>📝 Set the paper</button>
      </form>`;
  return `${top}${form}
    <h2 class="section">Your papers</h2>
    ${L.exams.length ? L.exams.map((x) => `
      <div class="item">
        <button class="body" data-action="exam-open" data-id="${x.id}">
          <div class="title">${esc(x.deck)}</div>
          <div class="meta">${EX_SIZE[x.size] || ''}${x.focus ? ` · ${esc(x.focus)}` : ''} · ${timeAgo(x.created)}</div>
          <div class="small" style="margin-top:3px">${exStatus(x)}</div>
        </button>
      </div>`).join('') : '<div class="card empty">No papers yet.</div>'}`;
}

function exTimerText(p, d) {
  const used = Math.floor((Date.now() - d.started) / 1000);
  const lim = (p.minutes || 45) * 60;
  const mm = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return `<span style="${used > lim ? 'color:var(--red)' : ''}">⏱ ${mm(used)} / ${mm(lim)}</span>`;
}

function exPaperView() {
  const top = (extra = '') => `<div class="row" style="margin-bottom:12px"><button class="btn" data-action="exam-back">← Papers</button><span class="grow"></span>${extra}</div>`;
  const p = exPaper;
  if (!p || p.id !== state.exam.id) return `${top()}<div class="card empty">${exError ? `⚠️ ${esc(exError)}` : 'Loading…'}</div>`;
  const head = `<div class="small muted" style="margin:-4px 2px 12px">${esc(p.deck)} · ${EX_SIZE[p.size]} · ${p.questions.length} questions · ${p.max || ''} marks</div>`;
  if (p.status === 'making') return `${top()}<div class="card empty"><span class="big">⏳</span>Gemini is writing your paper from the notes.<br><span class="small">Usually 1–5 minutes. You can leave this screen.</span></div>`;
  if (p.status === 'error') return `${top(`<button class="btn danger" data-action="exam-delete" data-id="${p.id}">Delete</button>`)}<div class="card">⚠️ ${esc(p.error)}</div>`;
  if (p.status === 'marking') return `${top()}${head}<div class="card empty"><span class="big">⏳</span>Marking your answers…<br><span class="small">Usually under a minute or two.</span></div>`;
  if (p.status === 'marked') return exResultsView(p, top, head);

  // sitting the paper (ready, or answered but marking failed)
  const d = exDraft(p.id);
  if (!d.started) { d.started = Date.now(); exSaveDraft(p.id, d); }
  clearInterval(exTick);
  exTick = setInterval(() => {
    const el = $('#exTimer');
    if (!el || !state.exam?.id) { clearInterval(exTick); return; }
    el.innerHTML = exTimerText(p, exDraft(p.id));
  }, 1000);
  const qs = p.questions.map((q) => {
    const a = d.answers[q.n] || {};
    const photo = exPhotos[`${p.id}:${q.n}`];
    const input = q.type === 'mcq'
      ? q.options.map((o, i) => {
          const L = 'ABCD'[i];
          return `<label class="ex-opt"><input type="radio" name="q${q.n}" value="${L}" data-action-change="exam-choice" data-n="${q.n}" ${a.choice === L ? 'checked' : ''}><span><b>${L}</b> ${rich(o)}</span></label>`;
        }).join('')
      : `<textarea class="ex-text" rows="${q.type === 'long' ? 8 : 4}" data-action-input="exam-text" data-n="${q.n}" placeholder="Your answer…">${esc(a.text || '')}</textarea>
         <div class="row" style="margin-top:6px">
           <label class="btn small">📷 ${photo ? 'Change photo' : 'Photo of working'}<input type="file" accept="image/*" capture="environment" hidden data-action-change="exam-photo" data-n="${q.n}"></label>
           ${photo ? `<img class="ex-thumb" src="${photo}" alt="your working"><button class="btn small" data-action="exam-unphoto" data-n="${q.n}">✕</button>` : ''}
         </div>`;
    return `<div class="card ex-q">
      <div class="small muted">Question ${q.n} · ${q.marks} mark${q.marks === 1 ? '' : 's'}${q.topic ? ` · ${esc(q.topic)}` : ''}</div>
      <div class="rich" style="margin:6px 0 10px">${rich(q.question)}</div>
      ${input}
    </div>`;
  }).join('');
  return `${top(`<b id="exTimer" class="small">${exTimerText(p, d)}</b>`)}${head}
    ${p.status === 'answered' && p.error ? `<div class="card" style="margin-bottom:12px">⚠️ ${esc(p.error)}</div>` : ''}
    ${qs}
    <button class="btn primary block" style="padding:14px;margin-top:6px" data-action="exam-submit">Submit for marking</button>
    <p class="hint" style="margin-top:10px;text-align:center">Answers are saved on this phone as you go${Object.keys(exPhotos).some((k) => k.startsWith(p.id)) ? ' (photos only until you close the app)' : ''}.</p>`;
}

function exResultsView(p, top, head) {
  const pct = p.max ? Math.round((p.score / p.max) * 100) : 0;
  const weak = p.questions.filter((q) => (p.results[q.n - 1]?.score || 0) < q.marks * 0.6);
  const added = exDraft(p.id).cardsAdded;
  const mins = p.elapsed ? Math.round(p.elapsed / 60) : null;
  const items = p.questions.map((q) => {
    const r = p.results[q.n - 1] || { score: 0, feedback: '' };
    const a = (p.answers || {})[q.n] || {};
    const mark = r.score >= q.marks ? 'full' : r.score > 0 ? 'part' : 'none';
    const yours = q.type === 'mcq'
      ? (a.choice ? `<b>${a.choice}</b> ${rich(q.options['ABCD'.indexOf(a.choice)] || '')}` : '<span class="muted">(no answer)</span>')
      : `${a.text ? rich(a.text) : ''}${a.photo ? '<div class="small muted">📷 photo of working sent</div>' : ''}${!a.text && !a.photo ? '<span class="muted">(no answer)</span>' : ''}`;
    const model = q.type === 'mcq' ? `<b>${q.answer}</b> ${rich(q.options['ABCD'.indexOf(q.answer)] || '')}` : rich(q.answer);
    return `<div class="card ex-q ex-${mark}">
      <div class="row"><span class="small muted grow">Question ${q.n}${q.topic ? ` · ${esc(q.topic)}` : ''}</span><b class="ex-mark">${r.score}/${q.marks}</b></div>
      <div class="rich" style="margin:6px 0 10px">${rich(q.question)}</div>
      <div class="small muted">Your answer</div><div class="rich ex-yours">${yours}</div>
      ${r.feedback ? `<div class="ex-feedback">${rich(r.feedback)}</div>` : ''}
      ${r.missed?.length ? `<div class="small" style="margin-top:6px"><span class="muted">Missed:</span>${r.missed.map((m) => `<div>• ${esc(m)}</div>`).join('')}</div>` : ''}
      <details style="margin-top:8px"><summary class="small">Model answer${q.points?.length ? ' & marking scheme' : ''}</summary>
        <div class="rich" style="margin-top:6px">${model}</div>
        ${q.points?.length ? `<div class="small muted" style="margin-top:6px">${q.points.map((x) => `<div>• ${esc(x)}</div>`).join('')}</div>` : ''}
        ${q.source ? `<div class="small muted" style="margin-top:6px">📄 ${esc(q.source)}</div>` : ''}
      </details>
    </div>`;
  }).join('');
  return `${top(`<button class="btn danger small" data-action="exam-delete" data-id="${p.id}">Delete</button>`)}${head}
    <div class="card ex-score">
      <div class="ex-big">${p.score}<small>/${p.max}</small></div>
      <div><b>${pct}% · Grade ${exGrade(pct)}</b><br><span class="small muted">${mins ? `${mins} min · ` : ''}${weak.length} question${weak.length === 1 ? '' : 's'} below 60%</span></div>
    </div>
    ${weak.length ? `<button class="btn primary block" style="margin:12px 0" data-action="exam-cards" ${added ? 'disabled' : ''}>${added ? '✓ Added to flashcards' : `🃏 Turn the ${weak.length} weak question${weak.length === 1 ? '' : 's'} into flashcards`}</button>` : ''}
    ${items}
    <button class="btn block" style="margin-top:6px" data-action="exam-again" data-course="${esc(p.course)}">📝 Another paper for this unit</button>`;
}

/** Don't redraw the paper under your fingers while you're typing an answer (e.g. after a sync). */
function examHoldRender() {
  return state.tab === 'cards' && !!state.exam?.id && document.activeElement?.classList?.contains('ex-text');
}

// ---------------------------------------------------------------------
// Photos: shrink before sending (phone photos are 3-10 MB)
// ---------------------------------------------------------------------
function exShrink(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read that photo")); };
    img.src = url;
  });
}

// ---------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------
Object.assign(ACTIONS, {
  async 'exam-home'() {
    state.exam = { unit: state.exam?.unit };
    exList = null;
    render(); window.scrollTo(0, 0);
    await exFetchList();
    if (state.exam && !state.exam.id) render();
  },
  'exam-close': () => { state.exam = null; clearTimeout(exPoll); render(); },
  async 'exam-back'() {
    clearInterval(exTick);
    state.exam = { unit: state.exam?.unit };
    render(); window.scrollTo(0, 0);
    await exFetchList();
    if (state.exam && !state.exam.id) render();
  },
  async 'exam-open'(el) {
    state.exam = { ...state.exam, id: el.dataset.id };
    exPaper = null;
    render(); window.scrollTo(0, 0);
    await exFetchPaper(el.dataset.id);
    if (state.exam?.id === el.dataset.id) render();
  },
  'exam-again': (el) => { state.exam = { unit: el.dataset.course }; ACTIONS['exam-home'](); },
  'exam-unphoto': (el) => { delete exPhotos[`${state.exam.id}:${el.dataset.n}`]; render(); },
  async 'exam-submit'() {
    const p = exPaper;
    const d = exDraft(p.id);
    const empty = p.questions.filter((q) => {
      const a = d.answers[q.n] || {};
      return q.type === 'mcq' ? !a.choice : !(a.text || '').trim() && !exPhotos[`${p.id}:${q.n}`];
    }).length;
    if (!confirm(empty ? `${empty} question${empty === 1 ? ' is' : 's are'} unanswered. Submit anyway?` : 'Submit your answers for marking?')) return;
    const answers = { _elapsed: Math.round((Date.now() - d.started) / 1000) };
    for (const q of p.questions) {
      const a = d.answers[q.n] || {};
      answers[q.n] = { text: a.text || '', choice: a.choice || '', photo: exPhotos[`${p.id}:${q.n}`] || (a.photoSent ? true : undefined) };
    }
    try {
      await sfetch(`/sync/exams/${p.id}/submit`, { method: 'POST', timeout: 180000, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) });
    } catch (e) { return toast(`Couldn't submit: ${e.message}`); }
    for (const q of p.questions) if (exPhotos[`${p.id}:${q.n}`]) (d.answers[q.n] ||= {}).photoSent = true;
    exSaveDraft(p.id, d);
    clearInterval(exTick);
    exPaper = { ...p, status: 'marking' };
    toast('📝 Submitted. Marking…');
    render(); window.scrollTo(0, 0);
  },
  async 'exam-delete'(el) {
    if (!confirm('Delete this paper?')) return;
    try { await sfetch(`/sync/exams/${el.dataset.id}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) { return toast(e.message); }
    try { localStorage.removeItem(exKey(el.dataset.id)); localStorage.removeItem(`${exKey(el.dataset.id)}-paper`); } catch { /* ignore */ }
    ACTIONS['exam-back']();
  },
  async 'exam-cards'() {
    const p = exPaper;
    let n = 0;
    for (const q of p.questions) {
      const r = p.results[q.n - 1];
      if ((r?.score || 0) >= q.marks * 0.6) continue;
      const front = q.type === 'mcq' ? `${q.question}\n${q.options.map((o, i) => `- ${'ABCD'[i]}) ${o}`).join('\n')}` : q.question;
      const back = q.type === 'mcq' ? `**${q.answer})** ${q.options['ABCD'.indexOf(q.answer)] || ''}` : q.answer;
      await save('cards', { ...newCard(p.deck, front, back), source: 'ai', course: p.course, topic: q.topic || '', from: 'Practice paper' });
      n++;
    }
    const d = exDraft(p.id);
    d.cardsAdded = true;
    exSaveDraft(p.id, d);
    toast(`🃏 ${n} card${n === 1 ? '' : 's'} added to ${p.deck}`);
    render();
  },
});

CHANGE_ACTIONS['exam-unit'] = (el) => { state.exam.unit = el.value; const f = el.form; state.exam.size = f.size.value; render(); };
CHANGE_ACTIONS['exam-choice'] = (el) => {
  const d = exDraft(state.exam.id);
  (d.answers[el.dataset.n] ||= {}).choice = el.value;
  exSaveDraft(state.exam.id, d);
};
INPUT_ACTIONS['exam-text'] = (el) => {
  const d = exDraft(state.exam.id);
  (d.answers[el.dataset.n] ||= {}).text = el.value;
  exSaveDraft(state.exam.id, d);
};
CHANGE_ACTIONS['exam-photo'] = async (el) => {
  const file = el.files[0];
  if (!file) return;
  exPhotos[`${state.exam.id}:${el.dataset.n}`] = await exShrink(file);
  render();
};

FORMS['exam-new'] = async (form) => {
  const f = Object.fromEntries(new FormData(form));
  const btn = form.querySelector('.btn.primary');
  btn.disabled = true;
  btn.textContent = 'Asking the laptop…';
  state.exam.size = f.size;
  try {
    const res = await sfetch('/sync/exams/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ course: f.course, size: f.size, fileId: f.fileId || null }) });
    const e = await res.json();
    toast('📝 Writing your paper… usually 1–5 minutes');
    state.exam = { unit: f.course, size: f.size, id: e.id };
    exPaper = e;
    render(); window.scrollTo(0, 0);
  } catch (e) {
    toast(/409/.test(e.message) ? 'No Gemini key on the laptop yet' : e.message);
    btn.disabled = false;
    btn.textContent = '📝 Set the paper';
  }
};
