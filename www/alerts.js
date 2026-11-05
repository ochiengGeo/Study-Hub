'use strict';
/* Class alerts: ring / vibrate / silent, N minutes before a class.
 *
 * How it works: while StudyHub is open (or recently backgrounded) we keep timers for today's
 * and tomorrow's alerts, and re-check every 30 s. When an alert is due we show a system
 * notification (via the service worker), plus an in-app banner, a ring tone and/or vibration.
 * A web app cannot wake itself while it is fully closed, so the calendar export
 * (timetable.js → buildICS) is the backup for that case.
 */

const VIBE = [400, 150, 400, 150, 800];
let audioCtx = null;
let alertTimers = [];
const firing = new Set(); // guards against double-firing while a save is in flight
let ringLoop = null;

// Browsers only allow sound after the user has touched the page, so unlock audio on the first tap.
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no audio */ }
}
document.addEventListener('pointerdown', unlockAudio, { passive: true });

function ringOnce() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t0 = audioCtx.currentTime;
  for (let i = 0; i < 6; i++) {
    const t = t0 + i * 0.32;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = i % 2 ? 660 : 880;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.3);
  }
}

async function ensureNotifyPermission() {
  if (NATIVE) return nativeNotifyPermission();
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'default') {
    try { return await Notification.requestPermission(); } catch { return Notification.permission; }
  }
  return Notification.permission;
}

async function notify(title, body, mode, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const opts = {
    body, tag, renotify: true,
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    requireInteraction: mode === 'ring',
    data: { url: './' },
  };
  if (mode === 'silent') opts.silent = true; else opts.vibrate = VIBE;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) { await reg.showNotification(title, opts); return true; }
    new Notification(title, opts);
    return true;
  } catch {
    try { new Notification(title, { body }); return true; } catch { return false; }
  }
}

function showAlertBanner(title, body, mode) {
  const el = $('#alertBanner');
  el.innerHTML = `<div class="ab-icon">${ALERT_ICON[mode] || '🔔'}</div>
    <div class="grow"><b>${esc(title)}</b><div class="small muted">${esc(body).replace(/\n/g, '<br>')}</div></div>
    <button class="btn primary" data-action="dismiss-alert">OK</button>`;
  el.classList.remove('hidden');
  clearInterval(ringLoop);
  if (mode === 'ring') {
    let n = 0;
    ringOnce();
    ringLoop = setInterval(() => { if (++n >= 5) clearInterval(ringLoop); ringOnce(); navigator.vibrate?.(VIBE); }, 3500);
  }
}

async function fireAlert(o, { test = false } = {}) {
  if (firing.has(o.id)) return;
  firing.add(o.id);
  try {
    const mins = Math.max(0, Math.round((o.start - Date.now()) / MIN));
    const title = `${clsLabel(o.cls)} ${mins > 0 ? `in ${mins} min` : 'is starting'}`;
    const body = [
      [o.cls.course && o.cls.title ? o.cls.title : '', `${fmtTime(o.cls.start)}–${fmtTime(o.cls.end)}`, o.cls.room && `📍 ${o.cls.room}`].filter(Boolean).join(' · '),
      o.note && `📝 ${o.note}`,
    ].filter(Boolean).join('\n');
    if (!test) await saveOcc(o, { fired: true });
    if (NATIVE) {
      // Android already rings/vibrates via the scheduled notification; just show it in the app too.
      showAlertBanner(title, body, 'silent');
    } else {
      if (o.alert === 'ring' || o.alert === 'vibrate') navigator.vibrate?.(VIBE);
      await notify(title, body, o.alert, o.id);
      showAlertBanner(title, body, o.alert);
    }
    if (!test && !sheetOpen()) render();
  } finally {
    firing.delete(o.id);
  }
}

function scheduleAlerts() {
  alertTimers.forEach(clearTimeout);
  alertTimers = [];
  const now = Date.now();
  for (const key of [ymd(now), ymd(now + DAY)]) {
    for (const o of occurrencesOn(key)) {
      if (o.cancelled || o.alert === 'off' || o.occ.fired || now >= o.start) continue;
      const delay = o.start - o.alertMins * MIN - now;
      if (delay <= 0) fireAlert(o);
      else if (delay < 36 * HOUR) {
        alertTimers.push(setTimeout(() => {
          const fresh = getOcc(o.id);
          if (fresh && !fresh.cancelled && fresh.alert !== 'off' && !fresh.occ.fired) fireAlert(fresh);
        }, delay));
      }
    }
  }
}

RENDER_HOOKS.push(scheduleAlerts);
RENDER_HOOKS.push(() => nativeSyncAlerts());
setInterval(scheduleAlerts, 30_000); // timers can be throttled in the background; this catches up

Object.assign(ACTIONS, {
  'dismiss-alert': () => { $('#alertBanner').classList.add('hidden'); clearInterval(ringLoop); },
  async 'test-alert'() {
    if (NATIVE) {
      const mode = settings.alertMode === 'off' ? 'ring' : settings.alertMode;
      if ((await nativeNotifyPermission()) !== 'granted') return toast('Allow notifications first (Settings → Allow notifications)');
      await NATIVE.LN.schedule({ notifications: [{
        id: 2147480000, title: 'Test alert: CSC 101 in 30 min', body: 'This is what a class alert looks like · 📍 Your room',
        channelId: NATIVE_CHANNELS[mode].id, schedule: { at: new Date(Date.now() + 10000), allowWhileIdle: true },
      }] });
      closeSheet();
      return toast(`Test ${ALERT_MODES[mode].toLowerCase()} alert in 10 s. Try locking your phone or closing the app`);
    }
    unlockAudio();
    const permP = ensureNotifyPermission();
    closeSheet();
    const mode = settings.alertMode === 'off' ? 'ring' : settings.alertMode;
    toast(`Test ${ALERT_MODES[mode].toLowerCase()} alert in 5 seconds…`);
    setTimeout(async () => {
      await permP;
      const start = Date.now() + 30 * MIN;
      fireAlert({
        id: `test-${Date.now()}`, key: ymd(), start, end: start + HOUR, alert: mode, alertMins: 30, note: 'This is what a class alert looks like',
        cls: { course: 'Test alert', title: 'StudyHub', start: hhmm(start), end: hhmm(start + HOUR), room: 'Your room' },
      }, { test: true });
    }, 5000);
  },
});
