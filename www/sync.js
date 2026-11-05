'use strict';
/* Sync with the laptop hub (serve.py /sync).
 *
 * Every record carries `updated` (set on each save); deletions leave a tomb. A sync:
 *   1. sends records/tombs changed here since the last sync,
 *   2. receives everything the hub got from other devices since then (newer `updated` wins),
 *   3. uploads files the hub is missing. Files from the other device are NOT downloaded here
 *      automatically: they show with a ⬇ button and download when you tap it (files.js).
 * Runs on the ⟳ button, when the app opens or comes back to the front, every few minutes,
 * and a few seconds after you change something.
 */

const SYNC_LS = 'studyhub-sync';
const syncCfg = (() => {
  try { return { auto: true, ...JSON.parse(localStorage.getItem(SYNC_LS) || '{}') }; } catch { return { auto: true }; }
})();
function saveSyncCfg() { try { localStorage.setItem(SYNC_LS, JSON.stringify(syncCfg)); } catch { /* ignore */ } }
function syncResetLocal() { syncCfg.lastSeq = 0; syncCfg.lastPush = 0; saveSyncCfg(); }

let syncState = 'idle'; // idle | syncing | ok | error
let syncRun = null;

/** Where the hub is: the address you entered, or (in a browser opened from the laptop server) this page's own server. */
function syncBase() {
  if (syncCfg.url) return syncCfg.url;
  if (!NATIVE && /^https?:$/.test(location.protocol) && location.port) return location.origin;
  return null;
}
/** Running in the laptop's own browser, i.e. this device IS the hub machine. */
const onHubLaptop = () => !NATIVE && !syncCfg.url && ['localhost', '127.0.0.1'].includes(location.hostname);

function normaliseAddress(s) {
  s = String(s || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  if (!/:\d+$/.test(s.replace(/^https?:\/\//i, ''))) s += ':8000';
  return s;
}

async function sfetch(path, { timeout = 8000, base = syncBase(), key = syncCfg.key, ...opts } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(base + path, { ...opts, signal: ctl.signal, headers: { ...(opts.headers || {}), ...(key ? { 'X-Sync-Key': key } : {}) } });
    if (res.status === 401) throw Object.assign(new Error('Wrong pairing code'), { code: 401 });
    if (!res.ok) {
      let why = '';
      try { why = (await res.json()).error || ''; } catch { /* not JSON */ }
      throw Object.assign(new Error(`Hub answered ${res.status}${why ? `: ${why}` : ''}`), { status: res.status, why });
    }
    return res;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error("Laptop didn't answer. Is ./run.sh phone running, on the same Wi-Fi?");
    if (e instanceof TypeError) throw new Error("Can't reach the laptop. Same Wi-Fi? Is ./run.sh phone running?");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function syncNow(opts = {}) {
  if (syncRun && (!opts.manual || syncRun.manual)) return syncRun;
  // nothing running, or 🔄 tapped while an automatic sync runs: (then) do this one
  const run = (syncRun ? syncRun.catch(() => {}) : Promise.resolve())
    .then(() => doSync(opts))
    .finally(() => { if (syncRun === run) syncRun = null; updateSyncUI(); });
  run.manual = !!opts.manual;
  syncRun = run;
  return run;
}

async function doSync({ manual = false } = {}) {
  if (!syncBase()) { if (manual) syncSheet(); return; }
  syncState = 'syncing';
  updateSyncUI();
  try {
    const info = await (await sfetch('/sync/info')).json();
    if (info.hubId !== syncCfg.hubId) { syncCfg.hubId = info.hubId; syncCfg.lastSeq = 0; syncCfg.lastPush = 0; } // a different hub: start fresh
    // The hub only keeps kinds of records it knows. When it learns a new kind (after a StudyHub
    // update on the laptop), send everything once more so nothing made in between is lost.
    const hubStores = info.stores || ['deadlines', 'cards', 'notes', 'classes', 'occurrences', 'files'];
    if (syncCfg.hubStores && hubStores.some((s) => !syncCfg.hubStores.includes(s))) syncCfg.lastPush = 0;
    syncCfg.hubStores = hubStores;
    // A full sync compares everything both ways instead of "changes since last time". It runs on
    // the 🔄 button, a few times a day, and whenever the hub looks restored/reset, so the two sides
    // always end up matching even if an earlier sync was cut short.
    const full = manual || !syncCfg.lastFull || Date.now() - syncCfg.lastFull > 6 * 3600 * 1000
      || (typeof info.seq === 'number' && info.seq < (syncCfg.lastSeq || 0));

    // 1. what changed here since last time
    await loadAll();
    const since = full ? 0 : syncCfg.lastPush || 0;
    const startedAt = Date.now();
    const changes = [];
    for (const s of STORES.filter((x) => hubStores.includes(x))) {
      for (const r of data[s]) {
        if ((r.updated || 1) <= since) continue;
        const rec = { ...r };
        if (s === 'files') { delete rec.blob; delete rec.missing; delete rec.pdf; delete rec.native; }
        changes.push({ store: s, id: r.id, updated: r.updated || 1, rec });
      }
    }
    for (const t of await dbAll('tombs')) if (t.updated > since) changes.push({ store: t.store, id: t.rid, updated: t.updated, deleted: true });

    // 2. exchange with the hub
    const res = await sfetch('/sync', {
      method: 'POST', timeout: 60000,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since: full ? 0 : syncCfg.lastSeq || 0, changes }),
    });
    const out = await res.json();
    const received = await applyRemote(out.changes || []);
    await loadAll();
    // records are in: remember that now, so a problem with one file below doesn't redo all this
    syncCfg.lastSeq = out.seq;
    syncCfg.lastPush = startedAt;
    if (full) syncCfg.lastFull = Date.now();
    saveSyncCfg();

    // 3. file contents, one at a time: a file that fails is reported and skipped, never blocks the rest
    let up = 0;
    const problems = [];
    for (const id of out.needBlobs || []) {
      const f = byId('files', id);
      if (!f || !hasLocal(f)) continue;
      try {
        await syncUpload(f);
        up++;
      } catch (e) {
        if (!(e.message || '').startsWith("Can't reach") && !(e.message || '').startsWith("Laptop didn't")) problems.push(`${f.name}: ${e.message}`);
        else throw e;   // the laptop is gone: stop here, the next sync carries on
      }
    }
    const notHere = data.files.filter((x) => !hasLocal(x)).length;   // on the laptop, downloaded only when you ask

    syncCfg.lastOk = Date.now();
    syncCfg.lastError = problems.length ? `${problems.length} file${problems.length === 1 ? '' : 's'} didn't move: ${problems.join('; ')}` : '';
    syncCfg.lastResult = { sent: changes.length, received, up, notHere, failed: problems.length };
    saveSyncCfg();
    syncState = 'ok';
    await loadAll();
    if (!sheetOpen() || manual) render();
    if (manual || received) {
      const parts = [];
      if (changes.length) parts.push(`${changes.length} sent`);
      if (received) parts.push(`${received} received`);
      if (up) parts.push(`${up} file${up === 1 ? '' : 's'} sent to the laptop`);
      if (problems.length) toast(`⚠️ Synced, but ${problems.length} file${problems.length === 1 ? '' : 's'} didn't move: ${problems[0]}${problems.length > 1 ? ' (+ more under ☰ → Sync)' : ''}`);
      else {
        const newFiles = (out.changes || []).filter((c) => c.store === 'files' && !c.deleted && !hasLocal(byId('files', c.id))).length;
        if (newFiles) parts.push(`${newFiles} new file${newFiles === 1 ? '' : 's'} to download (⬇ in Files)`);
        toast(parts.length ? `🔄 Synced: ${parts.join(', ')}` : '🔄 Already up to date');
      }
    }
    if (sheetOpen() && $('#syncPanel')) syncSheet();
  } catch (e) {
    syncState = 'error';
    syncCfg.lastError = e.message;
    saveSyncCfg();
    if (manual) toast(`Sync failed: ${e.message}`);
    if (sheetOpen() && $('#syncPanel')) syncSheet();
  }
}

/** Send one file's contents to the laptop. */
async function syncUpload(f) {
  let body;
  try {
    body = await fileBytes(f);   // read it here first: a broken copy fails with a clear message
  } catch (e) {
    throw new Error(e.message || "this device's copy can't be read; delete it here and add it again");
  }
  await sfetch(`/sync/blob/${encodeURIComponent(f.id)}`, { method: 'PUT', body, timeout: 600000 });
}

/** Fetch one file's contents from the laptop and keep them on this device.
 * onProgress(fraction 0..1) is called as it arrives. */
async function syncDownload(f, onProgress) {
  const r = await sfetch(`/sync/blob/${encodeURIComponent(f.id)}`, { timeout: 600000 });
  let b;
  try {
    const total = Number(r.headers.get('Content-Length')) || f.size || 0;
    if (onProgress && r.body && total) {
      const reader = r.body.getReader();
      const chunks = [];
      let got = 0, last = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (got - last > total / 50) { last = got; onProgress(Math.min(1, got / total)); }
      }
      b = new Blob(chunks);
    } else {
      b = await r.blob();
    }
  } catch {
    throw new Error('the download was cut off');
  }
  if (f.size && b.size !== f.size) throw new Error(`only ${fmtSize(b.size)} of ${fmtSize(f.size)} arrived`);
  const cur = byId('files', f.id) || f;
  await dbPut('files', { ...cur, blob: new Blob([b], { type: f.type || b.type }), missing: false }, true);
  await loadAll();
}

/** Does the laptop have this file's contents? true / false, or null if it can't be asked right now. */
async function hubHasFile(f) {
  if (!syncBase()) return null;
  try {
    await sfetch(`/sync/blob/${encodeURIComponent(f.id)}`, { method: 'HEAD', timeout: 8000 });
    return true;
  } catch (e) {
    return e.status === 404 ? false : null;
  }
}

/** Apply hub changes: newer `updated` wins; returns how many were applied. */
async function applyRemote(changes) {
  const tombs = new Map((await dbAll('tombs')).map((t) => [t.id, t]));
  let n = 0;
  for (const c of changes) {
    if (!STORES.includes(c.store)) continue;
    const local = data[c.store].find((r) => r.id === c.id);
    const tomb = tombs.get(`${c.store}:${c.id}`);
    const localUpdated = Math.max(local ? local.updated || 1 : 0, tomb ? tomb.updated : 0);
    if (c.updated <= localUpdated) continue;
    if (c.deleted) {
      if (!local) continue;
      if (c.store === 'files') dropURL(c.id);
      await dbDel(c.store, c.id, c.updated, false);
    } else {
      const rec = { ...c.rec, updated: c.updated };
      if (c.store === 'files') {
        if (local && local.blob) rec.blob = local.blob;
        if (local && local.native) rec.native = true;   // phone: contents in the app's private folder
        if (!hasLocal(rec)) rec.missing = true;
        if (local && local.pdf) rec.pdf = local.pdf;   // keep the converted copy of slides
      }
      await dbPut(c.store, rec, true);
    }
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------
// Automatic sync
// ---------------------------------------------------------------------
let syncSoon = null;
/** Called by dbPut/dbDel (shared.js) after every local change. */
function onLocalChange() {
  if (!syncCfg.auto || !syncBase() || !syncCfg.lastOk) return; // only once a first sync has worked
  clearTimeout(syncSoon);
  syncSoon = setTimeout(() => syncNow(), 4000);
}
setInterval(() => { if (syncCfg.auto && !document.hidden && syncBase() && syncCfg.lastOk) syncNow(); }, 3 * MIN);
document.addEventListener('visibilitychange', () => { if (!document.hidden && syncCfg.auto && syncBase() && syncCfg.lastOk) syncNow(); });

// ---------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------
function updateSyncUI() {
  const btn = $('#syncBtn');
  if (!btn) return;
  btn.classList.toggle('spinning', syncState === 'syncing');
  const dot = $('#syncDot');
  const configured = !!syncBase() && !!syncCfg.lastOk;
  dot.className = `sync-dot ${!configured ? 'hidden' : syncCfg.lastError ? 'bad' : 'good'}`;
  btn.title = syncCfg.lastOk ? `Last synced ${timeAgo(syncCfg.lastOk)}${syncCfg.lastError ? ` · ${syncCfg.lastError}` : ''}` : 'Sync with laptop';
}

function syncStatusLine() {
  if (syncState === 'syncing') return '<span class="muted">Syncing…</span>';
  if (!syncCfg.lastOk) return syncCfg.lastError ? `⚠️ ${esc(syncCfg.lastError)}` : '<span class="muted">Not synced yet</span>';
  const r = syncCfg.lastResult || {};
  const files = data.files.filter((f) => !hasLocal(f)).length;
  return `${syncCfg.lastError ? `⚠️ ${esc(syncCfg.lastError)}<br><span class="muted">` : '✅ <span>'}Last synced ${timeAgo(syncCfg.lastOk)}${r.sent || r.received ? ` · ${r.sent || 0} sent, ${r.received || 0} received` : ''}${files ? ` · ${files} file${files === 1 ? '' : 's'} on the laptop only (⬇ in Files to download)` : ''}</span>`;
}

function syncSheet() {
  const hub = onHubLaptop();
  const base = syncBase();
  const needsAddress = NATIVE || !!syncCfg.url;
  openSheet(`
    <h3>Sync with laptop</h3>
    <div id="syncPanel">
    ${hub ? `
      <p class="muted small" style="margin-top:-8px">This laptop is the sync hub. Your phone app sends its changes here and gets everything from here.</p>
      <div class="card pair" id="pairBox"><span class="muted small">Loading…</span></div>
      <div class="card" style="margin:12px 0"><div class="small">${syncStatusLine()}</div></div>
      <button class="btn primary block" data-action="sync-now">🔄 Sync this browser now</button>
    ` : base && syncCfg.lastOk ? `
      <div class="card" style="margin-bottom:12px">
        <div class="small muted">Connected to</div><b>${esc(base.replace(/^https?:\/\//, ''))}</b>
        <div class="small" style="margin-top:8px">${syncStatusLine()}</div>
      </div>
      <button class="btn primary block" data-action="sync-now">🔄 Sync now</button>
      <label class="checkline" style="margin-top:14px"><input type="checkbox" data-action-change="sync-auto" ${syncCfg.auto ? 'checked' : ''}> Sync automatically (on open, after changes, every 3 min)</label>
      <button class="btn block danger" data-action="sync-forget">Disconnect</button>
    ` : `
      <p class="muted small" style="margin-top:-8px">On your laptop run <code>./run.sh phone</code>. It prints the address and pairing code; they're also on the laptop under ☰ → Sync with laptop.</p>
      <form data-form="sync-connect">
        ${needsAddress || !base ? `<label class="field"><span>Laptop address</span><input type="text" name="url" inputmode="url" autocomplete="off" placeholder="192.168.1.19:8000" value="${esc((syncCfg.url || syncCfg.draftUrl || '').replace(/^https?:\/\//, ''))}" required></label>` : ''}
        <label class="field"><span>Pairing code</span><input type="text" name="key" autocomplete="off" autocapitalize="characters" maxlength="6" placeholder="6 letters/numbers" value="${esc(syncCfg.key || syncCfg.draftKey || '')}" style="text-transform:uppercase;letter-spacing:.2em;font-weight:700" required></label>
        ${syncCfg.lastError ? `<p class="small" style="color:var(--red);margin:-4px 2px 12px">⚠️ ${esc(syncCfg.lastError)}</p>` : ''}
        <button class="btn primary block">Connect &amp; sync</button>
      </form>
      <p class="hint" style="margin-top:12px">The first sync merges both sides. Nothing is deleted. Your phone and laptop must be on the same Wi-Fi.</p>
    `}
    </div>`);
  if (hub) fillPairBox();
}

async function fillPairBox() {
  const box = $('#pairBox');
  try {
    const info = await (await sfetch('/sync/info')).json();
    box.innerHTML = info.reachableFromPhone ? `
      <div class="small muted">On your phone: ☰ → Sync with laptop, then enter</div>
      <div class="pair-row"><span>Address</span><b>${esc(info.address || '—')}</b></div>
      <div class="pair-row"><span>Code</span><b class="code">${esc(info.code)}</b></div>
      ${info.backup ? `<div class="small muted" style="margin-top:6px">💾 ${info.backup.error ? `⚠️ Backup failed: ${esc(info.backup.error)}` : info.backup.latest ? `Last backup ${esc(info.backup.latest.replace('_', ' '))} · ${info.backup.count} kept in <code>${esc(info.backup.dir)}</code>` : 'First backup in a moment'}</div>` : ''}` : `
      <div class="small">⚠️ The server is only listening on this laptop. Stop it and start it with<br><code>./run.sh phone</code><br>so your phone can reach it. Your pairing code is <b>${esc(info.code)}</b>.</div>`;
  } catch (e) {
    box.innerHTML = `<div class="small">⚠️ ${esc(e.message)}</div>`;
  }
}

Object.assign(ACTIONS, {
  sync: () => {
    hideDrawer();
    if (syncBase() && syncCfg.lastOk) return syncNow({ manual: true });
    syncSheet();
  },
  'sync-settings': () => { hideDrawer(); syncSheet(); },
  'sync-now': () => syncNow({ manual: true }),
  'sync-forget': () => {
    if (!confirm('Disconnect from the laptop? Your data stays on this device.')) return;
    for (const k of ['url', 'key', 'lastOk', 'lastSeq', 'lastPush', 'lastFull', 'lastError', 'hubId', 'lastResult']) delete syncCfg[k];
    saveSyncCfg();
    syncState = 'idle';
    updateSyncUI();
    syncSheet();
  },
});

CHANGE_ACTIONS['sync-auto'] = (el) => { syncCfg.auto = el.checked; saveSyncCfg(); };

FORMS['sync-connect'] = async (form) => {
  const f = Object.fromEntries(new FormData(form));
  const url = f.url !== undefined ? normaliseAddress(f.url) : '';
  const key = (f.key || '').trim().toUpperCase();
  const base = url || syncBase();
  const btn = form.querySelector('.btn.primary');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    await sfetch('/sync/info', { base, key }); // check address + code before saving
    if (url) syncCfg.url = url;
    syncCfg.key = key;
    delete syncCfg.draftUrl;
    delete syncCfg.draftKey;
    syncCfg.lastError = '';
    saveSyncCfg();
    await syncNow({ manual: true });
  } catch (e) {
    // keep what was typed so a retry only needs the bit that was wrong
    syncCfg.draftUrl = url;
    syncCfg.draftKey = key;
    syncCfg.lastError = e.message;
    saveSyncCfg();
    syncSheet();
    toast(e.message);
  }
};

RENDER_HOOKS.push(updateSyncUI);
