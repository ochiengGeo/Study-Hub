'use strict';
/* The phone app's own safe copy of your data (Android only; does nothing in a browser).
 *
 * The app's database lives in Android's WebView (IndexedDB). Chrome treats that as website data:
 * when the phone runs low on space (under ~2 GB free) it may delete it, without asking, while the
 * app is open. To make that harmless, the app also keeps its data in its own private folder
 * (/data/data/com.studyhub.app/files/studyhub, like any Android app's data), which Chrome can't touch:
 *
 *   files/<id>   the contents of each file (PDFs, slides…). These are kept ONLY here, not in the
 *                WebView database, so they never count against Chrome's storage and can't be evicted.
 *   data.json    a copy of every record (classes, cards, notes, the files list…), rewritten a moment
 *                after each change. If the database is found empty, it's refilled from this copy.
 */

const VAULT_DIR = 'studyhub';
let vaultBase = null;          // file:// URI of the folder, once ready
let vaultReady = null;         // Promise
let vaultLastCount = 0;        // records in the last data.json written/read
let vaultLastTombs = 0;        // deletions recorded then

function vaultOn() { return !!NATIVE && !!vaultBase; }

function vaultInit() {
  if (!NATIVE) return Promise.resolve(false);
  if (!vaultReady) {
    vaultReady = (async () => {
      try {
        await NATIVE.FS.mkdir({ path: `${VAULT_DIR}/files`, directory: 'DATA', recursive: true });
      } catch { /* already there */ }
      const r = await NATIVE.FS.getUri({ path: VAULT_DIR, directory: 'DATA' });
      vaultBase = r.uri.replace(/\/+$/, '');
      return true;
    })().catch((e) => { console.warn('vault', e); vaultReady = null; return false; });
  }
  return vaultReady;
}

// ---------------------------------------------------------------------
// File contents
// ---------------------------------------------------------------------
const vaultPath = (id) => `${VAULT_DIR}/files/${String(id).replace(/[^A-Za-z0-9_.@-]/g, '_')}`;

/** A URL the WebView can load the file from (img src, fetch). */
function vaultFileUrl(id) {
  return window.Capacitor.convertFileSrc(`${vaultBase}/files/${String(id).replace(/[^A-Za-z0-9_.@-]/g, '_')}`);
}

async function vaultRead(id) {
  const r = await fetch(vaultFileUrl(id));
  if (!r.ok) throw new Error("this device's copy is gone; download it again (⬇)");
  return r.arrayBuffer();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** Save a file's contents into the private folder (in pieces, then renamed: never half-written). */
async function vaultWrite(id, blob) {
  await vaultInit();
  const path = vaultPath(id), tmp = `${path}.part`;
  const CHUNK = 3 * 1024 * 1024;   // multiple of 3: base64 pieces join cleanly
  try { await NATIVE.FS.deleteFile({ path: tmp, directory: 'DATA' }); } catch { /* none */ }
  if (!blob.size) {
    await NATIVE.FS.writeFile({ path: tmp, data: '', directory: 'DATA' });
  }
  for (let at = 0; at < blob.size; at += CHUNK) {
    const data = await blobToBase64(blob.slice(at, at + CHUNK));
    if (at === 0) await NATIVE.FS.writeFile({ path: tmp, data, directory: 'DATA' });
    else await NATIVE.FS.appendFile({ path: tmp, data, directory: 'DATA' });
  }
  try { await NATIVE.FS.deleteFile({ path, directory: 'DATA' }); } catch { /* none */ }
  await NATIVE.FS.rename({ from: tmp, to: path, directory: 'DATA', toDirectory: 'DATA' });
}

async function vaultDelete(id) {
  if (!NATIVE) return;
  await vaultInit();
  try { await NATIVE.FS.deleteFile({ path: vaultPath(id), directory: 'DATA' }); } catch { /* not there */ }
}

async function vaultHas(id) {
  try { await NATIVE.FS.stat({ path: vaultPath(id), directory: 'DATA' }); return true; } catch { return false; }
}

/** shared.js calls this before saving a file record: on the phone the contents go to the private
 * folder and the record only notes that they're there (`native: true`). */
async function beforeFilePut(rec) {
  if (!NATIVE || !rec.blob) return rec;
  if (!(await vaultInit())) return rec;   // folder unavailable: keep the old way
  await vaultWrite(rec.id, rec.blob);
  const out = { ...rec, native: true, missing: false };
  delete out.blob;
  if (typeof dropURL === 'function') dropURL(rec.id);
  return out;
}

// ---------------------------------------------------------------------
// Records: data.json
// ---------------------------------------------------------------------
let vaultSaveTimer = null;
let vaultSaving = null;

/** shared.js calls this after every database write. */
function onDBWrite() {
  if (!NATIVE) return;
  clearTimeout(vaultSaveTimer);
  vaultSaveTimer = setTimeout(() => { vaultSaveTimer = null; vaultSaveNow(); }, 1500);
}

async function vaultSaveNow({ allowEmpty = false } = {}) {
  if (!NATIVE || !(await vaultInit())) return;
  if (vaultSaving) await vaultSaving.catch(() => {});
  vaultSaving = (async () => {
    const snap = { app: 'studyhub', saved: Date.now(), stores: {} };
    let n = 0, tombs = 0;
    for (const s of [...STORES, 'tombs']) {
      const rows = await dbAll(s);
      snap.stores[s] = rows.map((r) => {
        if (s !== 'files') return r;
        const c = { ...r };
        delete c.blob;
        delete c.pdf;
        return c;
      });
      if (s !== 'tombs') n += rows.length; else tombs = rows.length;
    }
    // Never replace a good copy with one that lost records without matching deletions: that's what
    // an emptied database looks like. (Deleting things leaves "tombs", so real deletions pass.)
    // Settings → Delete all data passes allowEmpty.
    if (!allowEmpty && n < vaultLastCount && tombs - vaultLastTombs < vaultLastCount - n) {
      console.warn(`vault: not saving, ${vaultLastCount - n} records vanished`);
      return;
    }
    const path = `${VAULT_DIR}/data.json`;
    await NATIVE.FS.writeFile({ path: `${path}.tmp`, data: JSON.stringify(snap), directory: 'DATA', encoding: 'utf8' });
    try { await NATIVE.FS.deleteFile({ path, directory: 'DATA' }); } catch { /* first time */ }
    await NATIVE.FS.rename({ from: `${path}.tmp`, to: path, directory: 'DATA', toDirectory: 'DATA' });
    vaultLastCount = n;
    vaultLastTombs = tombs;
  })();
  try { await vaultSaving; } catch (e) { console.warn('vault save', e); } finally { vaultSaving = null; }
}

/** Put back any record the database lost (Chrome may delete it) from the private copy. Records you
 * deleted have a "tomb" and stay deleted. Returns how many records came back. */
async function vaultRestoreMissing() {
  if (!NATIVE || !(await vaultInit())) return 0;
  let snap;
  try {
    const r = await NATIVE.FS.readFile({ path: `${VAULT_DIR}/data.json`, directory: 'DATA', encoding: 'utf8' });
    snap = JSON.parse(r.data);
  } catch {
    return 0;   // no copy yet
  }
  const stores = snap.stores || {};
  const dbTombs = new Set((await dbAll('tombs')).map((t) => t.id));
  const tombs = new Set([...dbTombs, ...(stores.tombs || []).map((t) => t.id)]);
  let n = 0;
  for (const s of STORES) {
    const have = new Set((await dbAll(s)).map((r) => r.id));
    const back = (stores[s] || []).filter((r) => !have.has(r.id) && !tombs.has(`${s}:${r.id}`));
    if (s === 'files') {
      for (const f of back) if (f.native && !(await vaultHas(f.id))) { f.native = false; f.missing = true; }
    }
    if (back.length) {
      await withTx(s, 'readwrite', (t) => { for (const r of back) t.objectStore(s).put(r); });
      n += back.length;
    }
  }
  const lostTombs = (stores.tombs || []).filter((t) => !dbTombs.has(t.id));
  if (lostTombs.length) await withTx('tombs', 'readwrite', (t) => { for (const r of lostTombs) t.objectStore('tombs').put(r); });
  const total = STORES.reduce((a, s) => a + (stores[s] || []).length, 0);
  vaultLastCount = Math.max(vaultLastCount, total);
  vaultLastTombs = Math.max(vaultLastTombs, (stores.tombs || []).length);
  return n;
}

/** shared.js: a lost database connection was replaced; refill before anything else is written. */
async function dbAfterReopen() {
  if (!NATIVE) return;
  withTx.inCheck = true;
  try {
    const back = await vaultRestoreMissing();
    if (back) setTimeout(() => toast(`♻️ Restored ${back} items from StudyHub's saved copy`), 0);
  } finally {
    withTx.inCheck = false;
  }
}

/** Move file contents still inside the WebView database (from older versions) into the folder. */
async function vaultMigrate() {
  if (!NATIVE || !(await vaultInit())) return 0;
  let n = 0;
  for (const f of await dbAll('files')) {
    if (!f.blob) continue;
    try {
      await dbPut('files', { ...f }, true);   // beforeFilePut moves the contents out
      n++;
    } catch (e) {
      console.warn('vault migrate', f.name, e);
    }
  }
  return n;
}

/** Settings → Delete all data: clear the private copy too. */
async function vaultWipe() {
  if (!NATIVE || !(await vaultInit())) return;
  try { await NATIVE.FS.rmdir({ path: `${VAULT_DIR}/files`, directory: 'DATA', recursive: true }); } catch { /* none */ }
  try { await NATIVE.FS.mkdir({ path: `${VAULT_DIR}/files`, directory: 'DATA', recursive: true }); } catch { /* ok */ }
  await vaultSaveNow({ allowEmpty: true });
}

// Write the pending copy right away when the app goes to the background (it may be closed there).
document.addEventListener('visibilitychange', () => {
  if (document.hidden && vaultSaveTimer) { clearTimeout(vaultSaveTimer); vaultSaveTimer = null; vaultSaveNow(); }
});
