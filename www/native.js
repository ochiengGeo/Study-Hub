'use strict';
/* Bridge to Android features when StudyHub runs as the installed app (Capacitor).
 * In a normal browser NATIVE is null and none of this runs; the web versions are used instead.
 *
 *  - Class alerts are handed to Android's alarm system, so they ring / vibrate even when the
 *    app is closed, the phone is locked, or after a restart.
 *  - Sharing and "open in another app" go through Android's share sheet / file viewer
 *    (an Android WebView has no Web Share API and ignores download links).
 */

const NATIVE = (() => {
  const C = window.Capacitor;
  if (!C || typeof C.isNativePlatform !== 'function' || !C.isNativePlatform()) return null;
  if (typeof C.registerPlugin !== 'function') { console.error('Capacitor core missing: running in browser mode'); return null; }
  return {
    LN: C.registerPlugin('LocalNotifications'),
    FS: C.registerPlugin('Filesystem'),
    Share: C.registerPlugin('Share'),
    Viewer: C.registerPlugin('FileViewer'),
    App: C.registerPlugin('App'),
    Bars: (window.capacitorExports && window.capacitorExports.SystemBars) || C.Plugins.SystemBars, // built into Capacitor core
  };
})();

// One Android notification channel per alert style. Channels can't be changed after creation,
// so a new behaviour needs a new channel id.
const NATIVE_CHANNELS = {
  ring: { id: 'class-ring', name: 'Class alerts: ring', description: 'Rings and vibrates before a class', importance: 5, sound: 'ring.wav', vibration: true, visibility: 1 },
  // Android plays the default sound when a channel has none, so 'vibrate' uses a silent clip.
  vibrate: { id: 'class-vibrate-v2', name: 'Class alerts: vibrate', description: 'Vibrates only', importance: 4, sound: 'silence.wav', vibration: true, visibility: 1 },
  silent: { id: 'class-silent', name: 'Class alerts: silent', description: 'Shows quietly in the notification shade', importance: 2, vibration: false, visibility: 1 },
};
// Deadline and exam reminders: one channel, normal importance (sound + heads-up).
const NATIVE_REMINDER_CHANNEL = { id: 'reminders', name: 'Deadline & exam reminders', description: 'Before a deadline, CAT or exam', importance: 4, vibration: true, visibility: 1 };
const NATIVE_HORIZON_DAYS = 14; // schedule this far ahead; refreshed every time the app opens
const NATIVE_MAX = 60; // Android keeps at most ~500 alarms per app; stay well below

async function nativeSetup() {
  if (!NATIVE) return;
  // Android's Back button: step back inside StudyHub instead of closing it (appBack in app.js)
  try { await NATIVE.App.addListener('backButton', () => appBack()); } catch (e) { console.warn('back button', e); }
  try {
    for (const ch of [...Object.values(NATIVE_CHANNELS), NATIVE_REMINDER_CHANNEL]) await NATIVE.LN.createChannel(ch);
    await NATIVE.LN.deleteChannel({ id: 'class-vibrate' }).catch(() => {}); // replaced by class-vibrate-v2
  } catch (e) { console.warn('channels', e); }
}

async function nativeNotifyPermission() {
  try {
    let p = await NATIVE.LN.checkPermissions();
    if (p.display !== 'granted') p = await NATIVE.LN.requestPermissions();
    return p.display === 'granted' ? 'granted' : 'denied';
  } catch { return 'denied'; }
}

async function nativeExactAlarms() {
  try { return (await NATIVE.LN.checkExactNotificationSetting()).exact_alarm; } catch { return 'granted'; }
}

/** Stable 31-bit integer id for an occurrence id string (Android needs int ids). */
function nativeNotifId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h & 0x7fffffff) || 1;
}

let nativeSyncTimer = null;
let nativeLastSig = '';
/** Re-plan all upcoming class alerts with Android. Cheap to call often; it debounces and skips if nothing changed. */
function nativeSyncAlerts() {
  if (!NATIVE) return;
  clearTimeout(nativeSyncTimer);
  nativeSyncTimer = setTimeout(nativeDoSync, 700);
}

async function nativeDoSync() {
  const now = Date.now();
  const items = [];   // { id (string), at, title, body, largeBody, channel, extra }
  for (let i = 0; i < NATIVE_HORIZON_DAYS; i++) {
    for (const o of occurrencesOn(addDays(ymd(), i))) {
      if (o.cancelled || o.alert === 'off') continue;
      const at = o.start - o.alertMins * MIN;
      if (at <= now + 5000) continue;
      const where = [`${fmtTime(o.cls.start)}–${fmtTime(o.cls.end)}`, o.cls.room && `📍 ${o.cls.room}`].filter(Boolean).join(' · ');
      items.push({
        id: o.id, at,
        title: `${clsLabel(o.cls)} in ${o.alertMins} min`,
        body: [o.cls.course && o.cls.title ? o.cls.title : '', where].filter(Boolean).join(' · '),
        largeBody: [o.cls.course && o.cls.title ? o.cls.title : '', where, o.note && `📝 ${o.note}`].filter(Boolean).join('\n'),
        channel: NATIVE_CHANNELS[o.alert].id, extra: { occ: o.id },
      });
    }
  }
  // deadline and exam reminders (reminders.js)
  if (typeof upcomingReminders === 'function') {
    for (const r of upcomingReminders(now + 5000, now + NATIVE_HORIZON_DAYS * DAY)) items.push({ ...r, channel: NATIVE_REMINDER_CHANNEL.id });
  }
  items.sort((a, b) => a.at - b.at);
  items.splice(NATIVE_MAX);
  const sig = JSON.stringify(items.map((n) => [n.id, n.at, n.title, n.body, n.largeBody, n.channel]));
  if (sig === nativeLastSig) return;
  try {
    const pending = (await NATIVE.LN.getPending()).notifications || [];
    if (pending.length) await NATIVE.LN.cancel({ notifications: pending.map((n) => ({ id: n.id })) });
    if (items.length) {
      await NATIVE.LN.schedule({
        notifications: items.map((n) => ({
          id: nativeNotifId(n.id), title: n.title, body: n.body, largeBody: n.largeBody || n.body,
          channelId: n.channel, schedule: { at: new Date(n.at), allowWhileIdle: true }, extra: n.extra || {},
        })),
      });
    }
    nativeLastSig = sig;
  } catch (e) {
    console.warn('alert sync failed', e);
  }
}

/** Write a File to the app's cache folder and return its native path/uri. */
async function nativeWriteCache(file) {
  const base64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  const safe = file.name.replace(/[\\/:*?"<>|]+/g, '_');
  const res = await NATIVE.FS.writeFile({ path: `share/${safe}`, data: base64, directory: 'CACHE', recursive: true });
  return res.uri;
}

async function nativeShareFile(file) {
  const uri = await nativeWriteCache(file);
  try { await NATIVE.Share.share({ title: file.name, files: [uri], dialogTitle: `Share ${file.name}` }); }
  catch (e) { if (!/cancel/i.test(String(e && e.message))) throw e; }
}

async function nativeOpenFile(file) {
  const uri = await nativeWriteCache(file);
  try {
    await NATIVE.Viewer.openDocumentFromLocalPath({ path: uri.replace(/^file:\/\//, '') });
  } catch {
    // no app installed that opens this type: fall back to the share sheet
    await NATIVE.Share.share({ title: file.name, files: [uri], dialogTitle: `Open ${file.name} with…` });
  }
}

/** Light or dark status-bar icons to match the chosen theme. */
function onThemeApplied(bg) {
  if (!NATIVE) return;
  const m = /^#?([0-9a-f]{6})$/i.exec(bg || '');
  let light = false;
  if (m) {
    const n = parseInt(m[1], 16);
    light = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 150;
  }
  NATIVE.Bars.setStyle({ style: light ? 'LIGHT' : 'DARK' }).catch(() => {});
}
