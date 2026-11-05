'use strict';
/* Reminders for deadlines and exams (CATs, main exams…), plus the notification set-up.
 *
 *  - Android app: reminders are handed to Android with the class alerts (native.js), so they
 *    arrive even when StudyHub is closed. In a browser they fire while StudyHub is open.
 *  - On first start (and whenever they're blocked) StudyHub asks for notification permission,
 *    exact alarm timing, and explains the battery setting some phones need.
 *  - Today shows a warning while notifications are off but alerts/reminders are on.
 */

Object.assign(settings, { remindDeadlines: true, remindExams: true, ...settings });

const REMIND_ASKED = 'studyhub-notif-asked';
const REMIND_FIRED = 'studyhub-reminded';
let notifState = { perm: 'unknown', exact: 'granted' };   // filled by checkNotifState()

/** Everything worth a reminder between `from` and `to`: [{ id, at, title, body, largeBody }] */
function upcomingReminders(from, to) {
  const out = [];
  const add = (id, at, title, body, largeBody) => { if (at > from && at <= to) out.push({ id, at, title, body, largeBody: largeBody || body }); };
  if (settings.remindDeadlines) {
    for (const d of data.deadlines) {
      if (d.done) continue;
      const what = [d.course, d.title].filter(Boolean).join(' · ');
      const when = fmtDue(d.due);
      add(`dl1-${d.id}`, d.due - DAY, `⏰ Due tomorrow: ${d.title}`, `${what} · ${when}`);
      add(`dl2-${d.id}`, d.due - 2 * HOUR, `⏰ Due in 2 hours: ${d.title}`, `${what} · ${when}`);
    }
  }
  if (settings.remindExams && data.exams) {
    for (const x of data.exams) {
      if (x.done) continue;
      const name = `${x.course} ${x.title || x.type}`.trim();
      const where = [fmtDue(x.start), x.venue && `📍 ${x.venue}`].filter(Boolean).join(' · ');
      const topics = x.topics ? `\n📚 ${x.topics}` : '';
      add(`ex3-${x.id}`, startOfDay(x.start) - 3 * DAY + 19 * HOUR, `📝 ${name} in 3 days`, `${where}. Time to revise.`, `${where}${topics}\nPractise with Flashcards → 📝 Practice exams.`);
      add(`ex1-${x.id}`, startOfDay(x.start) - DAY + 19 * HOUR, `📝 ${name} tomorrow`, where, `${where}${topics}`);
      add(`ex0-${x.id}`, x.start - 2 * HOUR, `📝 ${name} in 2 hours`, where, `${where}${topics}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Browser: fire reminders while the app is open (Android does it by itself)
// ---------------------------------------------------------------------
let remindTimers = [];
function firedSet() { try { return new Set(JSON.parse(localStorage.getItem(REMIND_FIRED) || '[]')); } catch { return new Set(); } }
function markFired(id) {
  const s = firedSet();
  s.add(id);
  try { localStorage.setItem(REMIND_FIRED, JSON.stringify([...s].slice(-300))); } catch { /* ignore */ }
}
function scheduleWebReminders() {
  if (NATIVE) return;
  remindTimers.forEach(clearTimeout);
  remindTimers = [];
  const now = Date.now();
  const fired = firedSet();
  // anything that came due in the last 6 h while the app was closed still shows once
  for (const r of upcomingReminders(now - 6 * HOUR, now + 36 * HOUR)) {
    if (fired.has(r.id)) continue;
    remindTimers.push(setTimeout(async () => {
      if (firedSet().has(r.id)) return;
      markFired(r.id);
      await notify(r.title, r.body, 'vibrate', r.id);
      showAlertBanner(r.title, r.largeBody, 'silent');
    }, Math.max(0, r.at - now)));
  }
}
RENDER_HOOKS.push(scheduleWebReminders);

// ---------------------------------------------------------------------
// Permission status and set-up
// ---------------------------------------------------------------------
const wantsNotifications = () => settings.remindDeadlines || settings.remindExams || data.classes.some((c) => (c.alert ?? settings.alertMode) !== 'off');

async function checkNotifState() {
  if (NATIVE) {
    notifState.perm = await NATIVE.LN.checkPermissions().then((p) => p.display).catch(() => 'denied');
    notifState.exact = await nativeExactAlarms();
  } else {
    notifState.perm = 'Notification' in window && window.isSecureContext ? Notification.permission : 'unsupported';
  }
  return notifState;
}

/** The warning row on Today. */
function notifyNudge() {
  if (!wantsNotifications()) return '';
  if (notifState.perm === 'granted' && notifState.exact === 'granted') return '';
  if (notifState.perm === 'unknown' || notifState.perm === 'unsupported') return '';
  const msg = notifState.perm !== 'granted'
    ? '<b>Notifications are off.</b> Class alerts and reminders won\'t show.'
    : '<b>Alarm timing is off.</b> Alerts may arrive late.';
  return `<button class="nudge" data-action="notif-setup" style="color:var(--red)">🔕 <span>${msg}</span>${ICON.chevron}</button>`;
}

function notifSetupSheet() {
  const s = notifState;
  const step = (ok, title, text, btn) => `
    <div class="card" style="margin-bottom:10px">
      <div class="row"><span class="grow"><b>${ok ? '✅' : '⬜'} ${title}</b></span></div>
      <div class="small muted" style="margin-top:4px">${text}</div>
      ${!ok && btn ? `<div style="margin-top:8px">${btn}</div>` : ''}
    </div>`;
  openSheet(`
    <h3>🔔 Turn on alerts & reminders</h3>
    <p class="muted small" style="margin-top:-8px">StudyHub reminds you before classes, deadlines (a day and 2 hours before) and exams (3 days, the day before, and 2 hours before).</p>
    ${step(s.perm === 'granted', 'Allow notifications', 'So alerts can appear on your lock screen.',
      s.perm === 'denied' && !NATIVE ? '<span class="small">Blocked in the browser: allow notifications for this site in its settings.</span>'
        : '<button class="btn primary block" data-action="notif-allow">Allow notifications</button>')}
    ${NATIVE ? step(s.exact === 'granted', 'Allow exact alarm timing', 'Without this Android may deliver alerts several minutes late.',
      '<button class="btn primary block" data-action="exact-alarms">Allow exact timing</button>') : ''}
    ${NATIVE ? `
      <div class="card" style="margin-bottom:10px">
        <b>🔋 If alerts still don't arrive</b>
        <div class="small muted" style="margin-top:4px">Some phones (Tecno, Infinix, itel, Xiaomi, Oppo, Samsung…) stop apps in the background to save battery. Open your phone's
          <b>Settings → Apps → StudyHub → Battery</b> and choose <b>Unrestricted</b> / <b>No restrictions</b>, and turn on <b>Auto-start</b> if you see it.</div>
      </div>` : ''}
    <div class="stack" style="margin-top:6px">
      ${s.perm === 'granted' ? '<button class="btn block" data-action="test-alert">Send a test alert</button>' : ''}
      <button class="btn block" data-action="close-sheet">${s.perm === 'granted' ? 'Done' : 'Not now'}</button>
    </div>`);
}

async function refreshNotifUI() {
  await checkNotifState();
  if (sheetOpen() && $('.sheet-panel h3')?.textContent.includes('Turn on alerts')) notifSetupSheet();
  if (state.tab === 'today' && !sheetOpen()) render();
}

/** Called once at start-up (main.js). */
async function notifStartup() {
  await checkNotifState();
  let asked = false;
  try { asked = !!localStorage.getItem(REMIND_ASKED); } catch { /* ignore */ }
  const needs = notifState.perm === 'default' || notifState.perm === 'prompt' || notifState.perm === 'prompt-with-rationale'
    || (NATIVE && notifState.perm !== 'granted');
  if (!asked && wantsNotifications() && needs && !sheetOpen()) {
    try { localStorage.setItem(REMIND_ASKED, String(Date.now())); } catch { /* ignore */ }
    notifSetupSheet();
  }
  render();
  // coming back from Android's settings screens: re-check
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshNotifUI(); });
}

Object.assign(ACTIONS, {
  'notif-setup': async () => { await checkNotifState(); notifSetupSheet(); },
  async 'notif-allow'() {
    await ensureNotifyPermission();
    await refreshNotifUI();
    if (NATIVE) nativeSyncAlerts();
  },
});
// Settings' "Allow exact timing" / "Enable notifications" buttons also refresh the set-up sheet
const _exact = ACTIONS['exact-alarms'];
ACTIONS['exact-alarms'] = async (el) => { await _exact(el); setTimeout(refreshNotifUI, 800); };
