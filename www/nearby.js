'use strict';
/* Share nearby: send study files and flashcard decks straight to friends' phones, no laptop needed.
 *
 * SENDING (Android app only): you pick files / decks / whole units. The phone starts a small
 * read-only web server (NearbySharePlugin + ShareServer.java) and shows a QR code, its address and
 * a 4-digit PIN. It runs while you share, keeps the screen on, and stops when you tap Stop, after
 * 15 minutes with no requests, or after 20 wrong PINs.
 *
 * RECEIVING (app or browser): scan the QR code or type the address + PIN, tick what you want,
 * download. Files land sorted by unit and type; decks arrive as new cards on your own schedule.
 * Received things are your own copies (new ids): they sync to your laptop like anything you add.
 * Friends without StudyHub can open the same address in any browser (www/share-page.html).
 *
 * Works on a shared Wi-Fi, or with no router at all: the sender turns on their hotspot and friends join it.
 */

const SHARE_PORT = 8765;
const NEARBY = NATIVE && window.Capacitor.registerPlugin ? window.Capacitor.registerPlugin('NearbyShare') : null;
let shareSession = null;   // { pin, port, addresses, url, from, files, decks, log, started }
let shareSel = null;       // what's ticked on the "choose what to share" screen
let recv = null;           // { base, pin, m, pick:Set, busy }

const deckUnit = (deck) => deckCourse(deck) || guessCourse(deck, allCourses());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function loadScriptOnce(src, globalName) {
  if (window[globalName]) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement('script'), { src, onload: resolve, onerror: () => reject(new Error(`couldn't load ${src}`)) });
    document.head.appendChild(s);
  });
}

// =====================================================================
// SENDING
// =====================================================================
function shareUnits() {
  const units = new Map();   // course → { files:[], decks:[] }
  const get = (k) => { if (!units.has(k)) units.set(k, { files: [], decks: [] }); return units.get(k); };
  for (const f of data.files) if (f.course && hasLocal(f)) get(f.course).files.push(f);
  for (const d of decks()) { const u = deckUnit(d); if (u) get(u).decks.push(d); }
  return new Map([...units].sort((a, b) => a[0].localeCompare(b[0])));
}

/** Everything ticked, with whole units expanded into their files and decks. */
function shareResolve(sel) {
  const units = shareUnits();
  const files = new Set(sel.files), dks = new Set(sel.decks);
  for (const u of sel.units) {
    const x = units.get(u);
    if (!x) continue;
    x.files.forEach((f) => files.add(f.id));
    x.decks.forEach((d) => dks.add(d));
  }
  const fl = [...files].map((id) => byId('files', id)).filter((f) => f && hasLocal(f));
  return { files: fl, decks: [...dks].filter((d) => data.cards.some((c) => c.deck === d)), units: [...sel.units] };
}

function shareSummary() {
  const r = shareResolve(shareSel);
  const cards = data.cards.filter((c) => r.decks.includes(c.deck)).length;
  const bits = [];
  if (r.files.length) bits.push(`${plural(r.files.length, 'file')} (${fmtSize(r.files.reduce((n, f) => n + (f.size || 0), 0))})`);
  if (r.decks.length) bits.push(`${plural(r.decks.length, 'deck')} (${plural(cards, 'card')})`);
  return { r, text: bits.length ? bits.join(' + ') : 'Nothing picked yet' };
}

function shareSheet(pre = {}) {
  hideDrawer();
  if (shareSession) return shareLiveSheet();
  if (!NEARBY) {
    return openSheet(`
      <h3>📡 Share nearby</h3>
      <div class="card empty">Sending works from the <b>StudyHub Android app</b>: the phone becomes a little server your friends download from. A browser can't do that.<br><br>
        <span class="small">You can still <b>receive</b> here.</span></div>
      <button class="btn primary block" style="margin-top:12px" data-action="receive">📥 Receive from a friend</button>`);
  }
  shareSel = { units: new Set(pre.units || []), decks: new Set(pre.decks || []), files: new Set(pre.files || []) };
  const units = shareUnits();
  const allDecks = decks();
  const local = data.files.filter(hasLocal);
  const notHere = data.files.length - local.length;
  const box = (kind, key, label, meta, on) => `
    <label class="share-pick"><input type="checkbox" data-action-change="share-pick" data-kind="${kind}" data-key="${esc(key)}" ${on ? 'checked' : ''}>
      <span class="grow"><span class="t">${label}</span><span class="m">${meta}</span></span></label>`;
  const byCourse = new Map();
  for (const f of local) {
    const k = f.course || 'Unsorted';
    if (!byCourse.has(k)) byCourse.set(k, []);
    byCourse.get(k).push(f);
  }
  const preCourses = new Set(local.filter((f) => shareSel.files.has(f.id)).map((f) => f.course || 'Unsorted'));
  openSheet(`
    <h3>📡 Share nearby</h3>
    <p class="muted small" style="margin-top:-8px">Friends on the same Wi-Fi, or on your hotspot, download straight from this phone. No laptop or internet needed.</p>
    <label class="field"><span>Your name (friends see it)</span><input type="text" maxlength="40" placeholder="e.g. George" value="${esc(settings.shareName || '')}" data-action-input="share-name"></label>

    ${units.size ? `<div class="dsep share-sep">Whole units</div>
      ${[...units].map(([u, x]) => box('units', u, `<span class="dot" style="background:${courseColor(u) || 'var(--muted)'}"></span>${esc(u)}`,
        [x.files.length && plural(x.files.length, 'file'), x.decks.length && plural(x.decks.length, 'deck'), x.files.length && fmtSize(x.files.reduce((n, f) => n + (f.size || 0), 0))].filter(Boolean).join(' · '),
        shareSel.units.has(u))).join('')}` : ''}

    ${allDecks.length ? `<div class="dsep share-sep">Flashcard decks</div>
      ${allDecks.map((d) => box('decks', d, esc(d), plural(data.cards.filter((c) => c.deck === d).length, 'card'), shareSel.decks.has(d))).join('')}` : ''}

    ${local.length ? `<div class="dsep share-sep">Single files</div>
      ${[...byCourse].sort((a, b) => (a[0] === 'Unsorted' ? 1 : b[0] === 'Unsorted' ? -1 : a[0].localeCompare(b[0]))).map(([k, fs]) => `
        <details class="share-group" ${preCourses.has(k) ? 'open' : ''}><summary><b>${esc(k)}</b> <span class="muted small">${fs.length}</span></summary>
          ${fs.map((f) => box('files', f.id, esc(f.name), `${esc(f.category)} · ${fmtSize(f.size)}`, shareSel.files.has(f.id))).join('')}
        </details>`).join('')}
      ${notHere ? `<p class="hint" style="margin-top:6px">${plural(notHere, 'file')} on the laptop only (⬇ them first to share them).</p>` : ''}` : ''}

    ${!units.size && !allDecks.length && !local.length ? '<div class="card empty">Nothing to share yet. Add files or flashcards first.</div>' : ''}

    <div class="share-foot">
      <div class="small" id="shareSummary">${esc(shareSummary().text)}</div>
      <button class="btn primary block" data-action="share-start" id="shareStartBtn" ${shareSummary().r.files.length || shareSummary().r.decks.length ? '' : 'disabled'}>📡 Start sharing</button>
    </div>`);
}

function updateShareSummary() {
  const s = shareSummary();
  const el = $('#shareSummary');
  if (el) el.textContent = s.text;
  const b = $('#shareStartBtn');
  if (b) b.disabled = !(s.r.files.length || s.r.decks.length);
}

/** Where the plugin reads a file from: the app's private folder, or a temporary copy in the cache. */
async function shareFileUri(f) {
  if (f.native && !f.blob) {
    await vaultInit();
    if (!(await vaultHas(f.id))) throw new Error('missing');
    return `${vaultBase}/files/${String(f.id).replace(/[^A-Za-z0-9_.@-]/g, '_')}`;
  }
  // older record still holding its contents in the database: write them out once
  const path = `nearby/${String(f.id).replace(/[^A-Za-z0-9_.@-]/g, '_')}`;
  const blob = new Blob([await fileBytes(f)]);
  const CHUNK = 3 * 1024 * 1024;
  if (!blob.size) await NATIVE.FS.writeFile({ path, data: '', directory: 'CACHE', recursive: true });
  for (let at = 0; at < blob.size; at += CHUNK) {
    const d = await blobToBase64(blob.slice(at, at + CHUNK));
    if (at === 0) await NATIVE.FS.writeFile({ path, data: d, directory: 'CACHE', recursive: true });
    else await NATIVE.FS.appendFile({ path, data: d, directory: 'CACHE' });
  }
  return (await NATIVE.FS.getUri({ path, directory: 'CACHE' })).uri;
}

const randomToken = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');

async function shareStart(btn) {
  const { r } = shareSummary();
  if (!r.files.length && !r.decks.length) return;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Getting ready…'; }
  try {
    const files = [], mfiles = [], tokenOf = new Map();
    let skipped = 0;
    for (const f of r.files) {
      let uri;
      try { uri = await shareFileUri(f); } catch { skipped++; continue; }
      const t = randomToken();
      tokenOf.set(f.id, t);
      files.push({ token: t, uri, name: f.name, type: f.type || '' });
      mfiles.push({ t, name: f.name, size: f.size || 0, type: f.type || '', ext: f.ext || fileExt(f.name), course: f.course || '', category: f.category || '' });
    }
    const mdecks = r.decks.map((d) => ({
      name: d,
      course: deckUnit(d),
      cards: data.cards.filter((c) => c.deck === d).map((c) => ({ front: c.front, back: c.back, ...(c.topic ? { topic: c.topic } : {}) })),
    }));
    const units = shareUnits();
    const munits = r.units.map((u) => ({ course: u, files: (units.get(u)?.files || []).map((f) => tokenOf.get(f.id)).filter(Boolean), decks: units.get(u)?.decks || [] }));
    const from = (settings.shareName || '').trim() || 'A StudyHub friend';
    const manifest = { app: 'studyhub-share', v: 1, from, at: Date.now(), files: mfiles, decks: mdecks, units: munits };
    const pin = randomPin();
    const res = await NEARBY.start({ pin, manifest: JSON.stringify(manifest), files });
    const addresses = res.addresses || [];
    const main = addresses[0]?.address;
    shareSession = {
      pin, port: res.port, addresses, from, files: mfiles, decks: mdecks, log: [], started: Date.now(),
      host: `${main}:${res.port}`, url: `http://${main}:${res.port}/#k=${pin}`,
    };
    if (skipped) toast(`${plural(skipped, 'file')} couldn't be read on this phone and ${skipped === 1 ? 'was' : 'were'} left out`);
    updateShareNav();
    shareLiveSheet();
  } catch (e) {
    toast(e.code === 'NO_NETWORK' || /Wi-Fi|hotspot/.test(e.message) ? '📶 Turn on Wi-Fi or your hotspot first, then try again.' : `Couldn't start sharing: ${e.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '📡 Start sharing'; }
  }
}

async function qrSvg(text) {
  await loadScriptOnce('vendor/qr/qrcode.min.js', 'qrcode');
  const q = window.qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function shareLogHTML() {
  const s = shareSession;
  if (!s || !s.log.length) return '<div class="muted small">Waiting for friends…</div>';
  return s.log.slice(-30).reverse().map((l) => `<div class="share-log-row"><span class="muted">${new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> ${esc(l.text)}</div>`).join('');
}

async function shareLiveSheet() {
  const s = shareSession;
  if (!s) return shareSheet();
  const cards = s.decks.reduce((n, d) => n + d.cards.length, 0);
  const gotBy = new Set(s.log.filter((l) => l.type === 'sent' || l.type === 'open').map((l) => l.ip));
  openSheet(`
    <h3>📡 Sharing now</h3>
    <div class="share-live">
      <div class="share-qr" id="shareQr"></div>
      <div class="pair">
        <div class="pair-row"><span>Address</span><b>${esc(s.host)}</b></div>
        <div class="pair-row"><span>PIN</span><b class="code">${esc(s.pin)}</b></div>
      </div>
    </div>
    <p class="hint" style="margin:10px 2px">Friends: <b>StudyHub → ☰ → Receive from a friend</b> → Scan. No app? Scan with the phone camera, or open <b>http://${esc(s.host)}</b> in any browser and enter the PIN.
      They must be on the same Wi-Fi as you, or joined to your hotspot.</p>
    ${s.addresses.length > 1 ? `<p class="hint">Not connecting? Try another address of this phone: ${s.addresses.slice(1).map((a) => `<b>${esc(a.address)}:${s.port}</b> (${esc(a.iface)})`).join(', ')}</p>` : ''}
    <div class="card" style="margin-bottom:12px">
      <div class="small"><b>From ${esc(s.from)}:</b> ${[s.files.length && plural(s.files.length, 'file'), s.decks.length && `${plural(s.decks.length, 'deck')} (${plural(cards, 'card')})`].filter(Boolean).join(' + ')}${gotBy.size ? ` · ${plural(gotBy.size, 'friend')} connected` : ''}</div>
      <div class="share-log" id="shareLog">${shareLogHTML()}</div>
    </div>
    <p class="hint">Keep this screen open while friends download; it stays awake. Sharing stops by itself after 15 minutes with nobody downloading.</p>
    <div class="row">
      <button class="btn grow" data-action="share-hide">Hide</button>
      <button class="btn danger grow" data-action="share-stop">■ Stop sharing</button>
    </div>`);
  try { $('#shareQr').innerHTML = await qrSvg(s.url); } catch { $('#shareQr').innerHTML = '<div class="muted small">QR code unavailable: type the address</div>'; }
}

async function shareStop(quiet = false) {
  try { await NEARBY?.stop(); } catch { /* already stopped */ }
  const s = shareSession;
  shareSession = null;
  try { await NATIVE.FS.rmdir({ path: 'nearby', directory: 'CACHE', recursive: true }); } catch { /* none */ }
  updateShareNav();
  if (!quiet && s) {
    const sent = s.log.filter((l) => l.type === 'sent').length;
    toast(`📡 Stopped sharing${sent ? ` · ${plural(sent, 'file')} sent` : ''}`);
  }
}

function onShareEvent(ev) {
  const s = shareSession;
  if (!s) return;
  const who = ev.ip || 'someone';
  const text = {
    open: `📲 ${who} opened the list`,
    sent: `✅ ${who} got ${ev.detail}`,
    badpin: `⚠️ Wrong PIN from ${who}`,
    locked: '🔒 Too many wrong PINs: sharing stopped',
  }[ev.type];
  if (ev.type === 'stopped') {
    const why = ev.detail;
    shareStop(true);
    toast(why === 'idle' ? '📡 Sharing stopped: nobody downloaded for 15 minutes' : why === 'locked' ? '🔒 Sharing stopped: too many wrong PINs' : '📡 Sharing stopped');
    if (sheetOpen() && $('#shareLog')) closeSheet();
    return;
  }
  // "opened the list" repeats every time a friend refreshes: log it once per friend
  if (ev.type === 'open' && s.log.some((l) => l.type === 'open' && l.ip === ev.ip)) return;
  // a resumed download finishes twice: count it once
  if (ev.type === 'sent' && s.log.some((l) => l.type === 'sent' && l.ip === ev.ip && l.detail === ev.detail && Date.now() - l.at < 10 * MIN)) return;
  if (text) s.log.push({ at: Date.now(), type: ev.type, ip: ev.ip, detail: ev.detail, text });
  const el = $('#shareLog');
  if (el) el.innerHTML = shareLogHTML();
}

function updateShareNav() {
  const el = $('#shareNav');
  if (el) el.innerHTML = shareSession ? '📡 <b>Sharing now</b> · tap to see' : '📡 Share nearby';
}

if (NEARBY) NEARBY.addListener('share', onShareEvent).catch?.(() => {});

// =====================================================================
// RECEIVING
// =====================================================================
/** "http://IP:PORT/#k=PIN", "studyhub://receive?a=IP:PORT&k=PIN" or just "IP:PORT" → { base, pin } */
function parseShareText(text) {
  text = String(text || '').trim();
  let host = '', pin = '';
  const deep = /^studyhub:\/\/receive\?(.*)$/i.exec(text);
  if (deep) {
    const p = new URLSearchParams(deep[1]);
    host = p.get('a') || '';
    pin = p.get('k') || '';
  } else {
    const m = /^(?:https?:\/\/)?([^/#?\s]+)[^#]*(?:#k=(\d{4}))?/i.exec(text);
    if (!m) return null;
    host = m[1];
    pin = m[2] || '';
  }
  if (!/^[\w.-]+(:\d{1,5})?$/.test(host)) return null;
  if (!/:\d+$/.test(host)) host += `:${SHARE_PORT}`;
  return { base: `http://${host}`, host, pin };
}

async function nfetch(base, path, { pin, timeout = 8000, headers = {}, signal } = {}) {
  const ctl = new AbortController();
  const timer = timeout ? setTimeout(() => ctl.abort(), timeout) : null;
  if (signal) signal.addEventListener('abort', () => ctl.abort());
  try {
    const r = await fetch(base + path, { headers: { ...headers, 'X-Share-Pin': pin }, signal: ctl.signal, cache: 'no-store' });
    if (r.status === 401) throw Object.assign(new Error('Wrong PIN'), { code: 401 });
    if (r.status === 403) throw Object.assign(new Error('That share is locked (too many wrong PINs). Ask your friend to start again.'), { code: 403 });
    if (!r.ok && r.status !== 206) throw new Error(`Your friend's phone answered ${r.status}`);
    return r;
  } catch (e) {
    if (e.code) throw e;
    if (e.name === 'AbortError') throw new Error("Your friend's phone didn't answer. Same Wi-Fi or hotspot? Is their Share screen still open?");
    if (!NATIVE && location.protocol === 'https:') throw new Error("This web version can't reach a phone over plain Wi-Fi. Use the StudyHub app, or open the address in a browser tab.");
    throw new Error("Can't reach your friend's phone. Same Wi-Fi or joined their hotspot? Is their Share screen still open?");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function receiveSheet(pre = {}) {
  hideDrawer();
  if (recv?.busy) return receiveListSheet();
  openSheet(`
    <h3>📥 Receive from a friend</h3>
    <p class="muted small" style="margin-top:-8px">Your friend opens <b>☰ → Share nearby</b> in their StudyHub. Be on the same Wi-Fi, or join their hotspot.</p>
    <button class="btn primary block" data-action="receive-scan">📷 Scan their QR code</button>
    <div class="dsep share-sep" style="text-align:center">or type it in</div>
    <form data-form="receive-connect">
      <div class="two">
        <label class="field"><span>Address</span><input type="text" name="address" inputmode="url" autocomplete="off" placeholder="192.168.43.1:8765" value="${esc(pre.host || settings.lastShareHost || '')}" required></label>
        <label class="field"><span>PIN</span><input type="text" name="pin" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="4 digits" value="${esc(pre.pin || '')}" style="letter-spacing:.25em;font-weight:700" required></label>
      </div>
      ${pre.error ? `<p class="small" style="color:var(--red);margin:-4px 2px 12px">⚠️ ${esc(pre.error)}</p>` : ''}
      <button class="btn block">Connect</button>
    </form>`);
}

async function receiveConnect(p) {
  const { base, host, pin } = p;
  if (!pin) return receiveSheet({ host, error: 'Enter the 4-digit PIN shown on their phone' });
  openSheet(`<h3>📥 Receive from a friend</h3><div class="card empty">⏳ Connecting to ${esc(host)}…</div>`);
  try {
    const m = await (await nfetch(base, '/api/manifest', { pin })).json();
    if (m.app !== 'studyhub-share') throw new Error("That isn't a StudyHub share");
    settings.lastShareHost = host;
    saveSettings();
    recv = { base, host, pin, m, pick: new Set(), busy: false };
    for (const f of m.files || []) if (!recvHaveFile(f)) recv.pick.add(`f:${f.t}`);
    for (const d of m.decks || []) if (recvNewCards(d).length) recv.pick.add(`d:${d.name}`);
    receiveListSheet();
  } catch (e) {
    receiveSheet({ host, pin: e.code === 401 ? '' : pin, error: e.message });
  }
}

const recvHaveFile = (f) => data.files.some((x) => x.name === f.name && (x.size || 0) === (f.size || 0));
function recvNewCards(d) {
  const have = new Set(data.cards.filter((c) => c.deck === d.name).map((c) => `${c.front}\u0000${c.back}`));
  return (d.cards || []).filter((c) => c && typeof c.front === 'string' && typeof c.back === 'string' && !have.has(`${c.front}\u0000${c.back}`));
}

/** Files and decks grouped by unit (the same unit shows as one group, like a bundle). */
function recvGroups() {
  const m = recv.m;
  const g = new Map();
  const get = (k) => { if (!g.has(k)) g.set(k, { files: [], decks: [] }); return g.get(k); };
  for (const f of m.files || []) get(f.course || 'Other files').files.push(f);
  for (const d of m.decks || []) get(d.course || 'Other decks').decks.push(d);
  const order = (k) => (k.startsWith('Other ') ? 1 : 0);
  return [...g].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]));
}

function recvSummary() {
  const m = recv.m;
  const fs = (m.files || []).filter((f) => recv.pick.has(`f:${f.t}`));
  const ds = (m.decks || []).filter((d) => recv.pick.has(`d:${d.name}`));
  const cards = ds.reduce((n, d) => n + recvNewCards(d).length, 0);
  const bytes = fs.reduce((n, f) => n + (f.size || 0), 0);
  return { fs, ds, cards, bytes, text: [fs.length && `${plural(fs.length, 'file')} (${fmtSize(bytes)})`, ds.length && `${plural(cards, 'new card')}`].filter(Boolean).join(' + ') };
}

function receiveListSheet() {
  const m = recv.m;
  const units = new Set((m.units || []).map((u) => u.course));
  const s = recvSummary();
  const row = (key, label, meta, have) => `
    <label class="share-pick ${have ? 'have' : ''}"><input type="checkbox" data-action-change="recv-pick" data-key="${esc(key)}" ${recv.pick.has(key) ? 'checked' : ''} ${recv.busy ? 'disabled' : ''}>
      <span class="grow"><span class="t">${label}</span><span class="m">${meta}</span></span></label>`;
  openSheet(`
    <h3>📥 From ${esc(m.from || 'a friend')}</h3>
    <p class="muted small" style="margin-top:-8px">${[(m.files || []).length && plural(m.files.length, 'file'), (m.decks || []).length && plural(m.decks.length, 'flashcard deck')].filter(Boolean).join(' · ') || 'Nothing shared'} · tick what you want</p>
    ${recvGroups().map(([k, x]) => {
      const keys = [...x.files.map((f) => `f:${f.t}`), ...x.decks.map((d) => `d:${d.name}`)];
      const all = keys.every((key) => recv.pick.has(key));
      return `<section class="share-group recv">
        <label class="share-unit"><input type="checkbox" data-action-change="recv-group" data-keys="${esc(JSON.stringify(keys))}" ${all ? 'checked' : ''} ${recv.busy ? 'disabled' : ''}>
          <span class="dot" style="background:${courseColor(k) || 'var(--muted)'}"></span><b>${esc(k)}</b>${units.has(k) ? '<span class="pill">whole unit</span>' : ''}</label>
        ${x.files.map((f) => {
          const have = recvHaveFile(f);
          return row(`f:${f.t}`, esc(f.name), `${esc(f.category || 'File')} · ${fmtSize(f.size || 0)}${have ? ' · already in your library' : ''}`, have);
        }).join('')}
        ${x.decks.map((d) => {
          const n = recvNewCards(d).length;
          return row(`d:${d.name}`, `🃏 ${esc(d.name)}`, `${plural((d.cards || []).length, 'card')}${n < (d.cards || []).length ? ` · ${n ? `${n} new to you` : 'you have them all'}` : ''}`, !n);
        }).join('')}
      </section>`;
    }).join('')}
    <div class="share-foot">
      <div id="recvProgress" class="${recv.busy ? '' : 'hidden'}"><div class="progress"><div id="recvBar" style="width:0%"></div></div><div class="small" id="recvStatus"></div></div>
      <button class="btn primary block" data-action="receive-go" id="recvGo" ${s.fs.length || s.cards ? '' : 'disabled'} ${recv.busy ? 'disabled' : ''}>⬇ ${s.text ? `Get ${esc(s.text)}` : 'Pick something to get'}</button>
    </div>`);
}

function updateRecvButton() {
  const s = recvSummary();
  const b = $('#recvGo');
  if (!b) return;
  b.disabled = recv.busy || !(s.fs.length || s.cards);
  b.textContent = `⬇ ${s.text ? `Get ${s.text}` : 'Pick something to get'}`;
}

/** One file, with resume: if the connection drops, carry on from where it stopped (HTTP Range). */
async function recvFetchFile(f, onBytes) {
  const chunks = [];
  let got = 0;
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    let stall = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await nfetch(recv.base, `/f/${f.t}`, { pin: recv.pin, timeout: 0, signal: ctl.signal, headers: got ? { Range: `bytes=${got}-` } : {} });
      if (got && r.status !== 206) { chunks.length = 0; got = 0; }   // the phone sent it all again
      if (r.body && r.body.getReader) {
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          clearTimeout(stall);
          stall = setTimeout(() => ctl.abort(), 20000);
          chunks.push(value);
          got += value.length;
          onBytes(got);
        }
      } else {
        const b = new Uint8Array(await r.arrayBuffer());
        chunks.push(b);
        got += b.length;
        onBytes(got);
      }
      if (!f.size || got >= f.size) return new Blob(chunks, { type: f.type || '' });
      throw new Error('cut off');
    } catch (e) {
      if (e.code === 401 || e.code === 403 || attempt >= 4) throw new Error(e.message === 'cut off' || e.name === 'AbortError' ? 'the connection kept dropping' : e.message);
      await sleep(1500);
    } finally {
      clearTimeout(stall);
    }
  }
}

async function receiveGo() {
  if (!recv || recv.busy) return;
  const { fs, ds, bytes } = recvSummary();
  const m = recv.m;
  recv.busy = true;
  receiveListSheet();
  const status = (t, frac) => {
    const st = $('#recvStatus'), bar = $('#recvBar');
    if (st) st.textContent = t;
    if (bar && frac !== undefined) bar.style.width = `${Math.round(frac * 100)}%`;
  };
  let doneBytes = 0, gotFiles = 0, gotCards = 0;
  const failed = [];
  const where = new Set();
  const known = allCourses();
  for (let i = 0; i < fs.length; i++) {
    const f = fs[i];
    if (recvHaveFile(f)) continue;
    try {
      const blob = await recvFetchFile(f, (n) => status(`${f.name} (${i + 1} of ${fs.length}) · ${fmtSize(n)} of ${fmtSize(f.size || n)}`, bytes ? (doneBytes + n) / bytes : 0));
      const file = new File([blob], f.name, { type: f.type || blob.type || '' });
      const rec = makeFileRecord(file, known, {
        ...(f.course ? { course: String(f.course).slice(0, 60) } : {}),
        ...(FILE_CATEGORIES.includes(f.category) ? { category: f.category } : {}),
        from: String(m.from || '').slice(0, 40),
      });
      await dbPut('files', rec);
      gotFiles++;
      where.add(rec.course || 'Unsorted');
    } catch (e) {
      failed.push(`${f.name}: ${e.message}`);
      if (/Wrong PIN|locked|Can't reach|didn't answer/.test(e.message)) break;   // the share is gone: stop trying
    }
    doneBytes += f.size || 0;
  }
  status('Adding flashcards…', 1);
  for (const d of ds) {
    for (const c of recvNewCards(d)) {
      // a fresh card on your own schedule (no AI marker: it isn't from your laptop's generator)
      await dbPut('cards', { ...newCard(String(d.name).slice(0, 120), c.front.slice(0, 20000), c.back.slice(0, 20000)), ...(c.topic ? { topic: String(c.topic).slice(0, 80) } : {}), from: String(m.from || '').slice(0, 40) });
      gotCards++;
    }
  }
  await loadAll();
  recv.busy = false;
  where.forEach((k) => state.collapsed.delete(k));
  const parts = [gotFiles && plural(gotFiles, 'file'), gotCards && plural(gotCards, 'card')].filter(Boolean);
  openSheet(`
    <h3>${failed.length && !parts.length ? '⚠️ Nothing arrived' : '✅ Received'}</h3>
    <div class="card">${parts.length ? `Got <b>${parts.join(' and ')}</b> from ${esc(m.from || 'your friend')}.` : 'Nothing new was added.'}
      ${failed.length ? `<div class="small" style="color:var(--red);margin-top:8px">${plural(failed.length, 'file')} didn't arrive: ${esc(failed.slice(0, 3).join('; '))}${failed.length > 3 ? '…' : ''}</div>` : ''}</div>
    <div class="row" style="margin-top:12px">
      ${gotFiles ? '<button class="btn primary grow" data-action="recv-open-files">📁 Open Files</button>' : ''}
      ${gotCards ? '<button class="btn grow" data-action="recv-open-cards">🃏 Flashcards</button>' : ''}
      ${failed.length ? '<button class="btn grow" data-action="recv-back">Try again</button>' : ''}
      <button class="btn grow" data-action="sheet-close">Done</button>
    </div>`);
  render();
  if (parts.length) toast(`📥 Got ${parts.join(' and ')} from ${m.from || 'your friend'}`);
}

// ---------- QR scanner: Android's built-in detector when there is one, else jsQR ----------
async function receiveScan() {
  if (!navigator.mediaDevices?.getUserMedia) return toast("The camera isn't available here: type the address and PIN instead");
  openSheet(`
    <h3>📷 Scan the QR code</h3>
    <div class="qr-scan"><video id="qrVideo" playsinline muted></video><div class="qr-frame"></div></div>
    <p class="hint" style="margin-top:10px">Point at the code on your friend's Share screen.</p>
    <button class="btn block" data-action="receive">Type it in instead</button>`);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch {
    toast('Camera blocked. Allow it for StudyHub, or type the address and PIN.');
    return receiveSheet();
  }
  const v = $('#qrVideo');
  const stop = () => stream.getTracks().forEach((t) => t.stop());
  if (!v) return stop();
  v.srcObject = stream;
  try { await v.play(); } catch { /* starts anyway on most phones */ }
  let detector = null;
  try {
    if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) detector = new BarcodeDetector({ formats: ['qr_code'] });
  } catch { detector = null; }
  if (!detector) {
    try { await loadScriptOnce('vendor/qr/jsQR.js', 'jsQR'); } catch { stop(); toast("Couldn't start the scanner: type it in instead"); return receiveSheet(); }
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  for (;;) {
    await sleep(180);
    if (!document.body.contains(v) || !sheetOpen()) return stop();   // the sheet was closed or changed
    if (v.readyState < 2 || !v.videoWidth) continue;
    let text = null;
    if (detector) {
      try { text = (await detector.detect(v))[0]?.rawValue || null; } catch { detector = null; await loadScriptOnce('vendor/qr/jsQR.js', 'jsQR').catch(() => {}); }
    } else if (window.jsQR) {
      const w = Math.min(640, v.videoWidth), h = Math.round(v.videoHeight * w / v.videoWidth);
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(v, 0, 0, w, h);
      text = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data || null;
    }
    const p = text && parseShareText(text);
    if (p && p.pin) {   // only a StudyHub share code carries a PIN; ignore other QR codes in view
      stop();
      if (navigator.vibrate) navigator.vibrate(40);
      return receiveConnect(p);
    }
  }
}

/** Opened through studyhub://receive?a=…&k=… (the "Open in StudyHub" button on the download page). */
function handleShareLink(url) {
  if (!/^studyhub:\/\/receive/i.test(url || '')) return false;
  const p = parseShareText(url);
  if (p) setTimeout(() => receiveConnect(p), 300);
  return !!p;
}

async function nearbyStartup() {
  if (!NATIVE) return;
  try { await NATIVE.App.addListener('appUrlOpen', (e) => handleShareLink(e.url)); } catch { /* old app */ }
  try {
    const l = await NATIVE.App.getLaunchUrl();
    if (l && l.url) handleShareLink(l.url);
  } catch { /* none */ }
  // sharing survives a page reload of the app (it's native); pick it back up
  try {
    const st = await NEARBY?.status();
    if (st && st.running) await NEARBY.stop();   // the details (PIN, list) were lost with the page: start fresh
  } catch { /* plugin missing in an old APK */ }
}

// =====================================================================
// Wiring
// =====================================================================
Object.assign(ACTIONS, {
  'share-nearby': () => shareSheet(),
  'share-file': (el) => shareSheet({ files: [el.dataset.id] }),
  'share-deck': (el) => shareSheet({ decks: [el.dataset.deck] }),
  'share-start': (el) => shareStart(el),
  'share-stop': async () => { await shareStop(); closeSheet(); },
  'share-hide': () => { closeSheet(); toast('📡 Still sharing. ☰ → Sharing now to see it or stop'); },
  receive: () => receiveSheet(),
  'receive-scan': () => receiveScan(),
  'receive-go': () => receiveGo(),
  'recv-back': () => receiveConnect(recv),
  'recv-open-files': () => { closeSheet(); state.notesMode = 'files'; go('notes'); },
  'recv-open-cards': () => { closeSheet(); go('cards'); },
  'sheet-close': () => closeSheet(),
});

CHANGE_ACTIONS['share-pick'] = (el) => {
  const set = shareSel[el.dataset.kind];
  if (el.checked) set.add(el.dataset.key); else set.delete(el.dataset.key);
  updateShareSummary();
};
CHANGE_ACTIONS['recv-pick'] = (el) => {
  if (el.checked) recv.pick.add(el.dataset.key); else recv.pick.delete(el.dataset.key);
  updateRecvButton();
};
CHANGE_ACTIONS['recv-group'] = (el) => {
  for (const k of JSON.parse(el.dataset.keys)) {
    if (el.checked) recv.pick.add(k); else recv.pick.delete(k);
    const box = [...document.querySelectorAll('[data-action-change="recv-pick"]')].find((b) => b.dataset.key === k);
    if (box) box.checked = el.checked;
  }
  updateRecvButton();
};
INPUT_ACTIONS['share-name'] = (el) => { settings.shareName = el.value.trim(); saveSettings(); };

FORMS['receive-connect'] = (form) => {
  const f = Object.fromEntries(new FormData(form));
  const p = parseShareText(f.address);
  if (!p) return receiveSheet({ host: f.address, pin: f.pin, error: 'That address looks wrong. It looks like 192.168.43.1:8765' });
  p.pin = String(f.pin || '').trim();
  return receiveConnect(p);
};

RENDER_HOOKS.push(updateShareNav);
