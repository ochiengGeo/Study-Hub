'use strict';
/* Shared by the page AND the service worker (sw.js importScripts this):
 * the IndexedDB wrapper plus the helpers that auto-sort incoming files. */

// ---------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------
const DB_NAME = 'studyhub';
const DB_VERSION = 4; // v2 added: classes, occurrences, files · v3: tombs (deletions, for sync) · v4: exams
const STORES = ['deadlines', 'cards', 'notes', 'classes', 'occurrences', 'files', 'exams'];
let dbPromise;

/* The browser can close our database connection by itself (Android's WebView does it, e.g.
 * after freeing memory/storage). Using a closed connection fails with "The database connection
 * is closing" every time until the app restarts, so: forget a closed connection, open a new one,
 * retry once, and tell the page to reload what it holds (file contents read through the old
 * connection can stop being readable). */
function openDB() {
  if (!dbPromise) {
    const p = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        for (const s of [...STORES, 'tombs']) {
          if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // If a newer version of the app opens the DB, let it upgrade.
        db.onversionchange = () => { db.close(); forgetDB(p); };
        // Closed by the browser, not by us
        db.onclose = () => { forgetDB(p); noteDBClosed('closed by the system'); };
        resolve(db);
      };
      req.onerror = () => { forgetDB(p); reject(req.error); };
      req.onblocked = () => { if (typeof onDBBlocked === 'function') onDBBlocked(); };
    });
    dbPromise = p;
  }
  return dbPromise;
}

function forgetDB(p) {
  if (!p || dbPromise === p) dbPromise = null;
}

let dbReconnectPending = false;
let dbLost = false;            // the connection was lost: check the new database before using it
let dbChecking = null;
function noteDBClosed(why) {
  dbLost = true;
  try {   // a small trail, to see when and why it happens (☰ → Settings shows nothing; for debugging)
    const log = JSON.parse(localStorage.getItem('studyhub-dbclosed') || '[]').slice(-9);
    log.push({ at: new Date().toISOString(), why, sync: typeof syncState !== 'undefined' ? syncState : '', hidden: typeof document !== 'undefined' && document.hidden });
    localStorage.setItem('studyhub-dbclosed', JSON.stringify(log));
  } catch { /* no localStorage in the service worker */ }
  if (dbReconnectPending) return;
  dbReconnectPending = true;
  setTimeout(() => {   // let the page reload its data through a fresh connection
    dbReconnectPending = false;
    if (typeof onDBReconnect === 'function') onDBReconnect();
  }, 0);
}

const isClosingError = (e) => e && (e.name === 'InvalidStateError' || /connection is clos/i.test(e.message || ''));

/** Run fn(transaction) on a working connection; if the connection turns out to be closed, reopen once. */
async function withTx(stores, mode, fn) {
  // After a lost connection the new database may be empty (Chrome evicted it): let the app refill
  // it (vault.js) BEFORE anything is written, or a small write would hide that it was emptied.
  if (dbLost && typeof dbAfterReopen === 'function') {
    if (!dbChecking) {
      dbLost = false;
      dbChecking = Promise.resolve().then(dbAfterReopen).catch(() => {}).finally(() => { dbChecking = null; });
    }
    if (!withTx.inCheck) await dbChecking;
  }
  for (let attempt = 0; ; attempt++) {
    const p = openDB();
    const db = await p;
    let t;
    try {
      t = db.transaction(stores, mode);
    } catch (e) {
      if (attempt === 0 && isClosingError(e)) {
        forgetDB(p);
        noteDBClosed('found closed');
        continue;
      }
      throw e;
    }
    return new Promise((resolve, reject) => {
      const req = fn(t);
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
}

function tx(store, mode, fn) {
  return withTx(store, mode, (t) => fn(t.objectStore(store)));
}
const dbAll = (s) => tx(s, 'readonly', (st) => st.getAll());
/* Every write is stamped with `updated` so devices can tell which copy is newer when syncing.
 * keepStamp = true when storing a record that came from another device (keep its time). */
async function dbPut(s, obj, keepStamp = false) {
  if (!keepStamp) obj.updated = Date.now();
  // Android app: a file's contents go to the app's private folder, not this database (vault.js)
  if (s === 'files' && obj.blob && typeof beforeFilePut === 'function') obj = await beforeFilePut(obj);
  const r = await tx(s, 'readwrite', (st) => st.put(obj));
  if (typeof onDBWrite === 'function') onDBWrite();
  if (!keepStamp && typeof onLocalChange === 'function') onLocalChange();
  return r;
}
/* Deleting leaves a "tomb" so the deletion can be synced to other devices too. */
async function dbDel(s, id, when = Date.now(), local = true) {
  await withTx([s, 'tombs'], 'readwrite', (t) => {
    t.objectStore(s).delete(id);
    t.objectStore('tombs').put({ id: `${s}:${id}`, store: s, rid: id, updated: when });
  });
  if (s === 'files' && typeof vaultDelete === 'function') vaultDelete(id).catch(() => {});
  if (typeof onDBWrite === 'function') onDBWrite();
  if (local && typeof onLocalChange === 'function') onLocalChange();
}
const dbClear = (s) => tx(s, 'readwrite', (st) => st.clear());

const uid = () => (self.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ---------------------------------------------------------------------
// File auto-sorting
// ---------------------------------------------------------------------
const FILE_CATEGORIES = ['Lecture notes', 'Slides', 'Past papers', 'Assignments', 'Labs', 'Board photos', 'Books', 'Other'];

function fileExt(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function guessCategory(name, type = '') {
  const n = (name || '').toLowerCase();
  if (/past|exam|\bcat\b|cat[\s_-]?\d|midterm|mid-sem|final|quiz|test|revision/.test(n)) return 'Past papers';
  if (/assign|homework|\bhw\d|problem[\s_-]?set|pset|coursework/.test(n)) return 'Assignments';
  if (/\blab|practical|tutorial|worksheet/.test(n)) return 'Labs';
  if (/\.(pptx?|odp|key)$/.test(n) || /slide/.test(n)) return 'Slides';
  if (type.startsWith('image/')) return 'Board photos';
  if (/book|textbook|edition|handbook/.test(n)) return 'Books';
  if (/lec|lecture|notes?|week|topic|unit|chapter|module|handout/.test(n)) return 'Lecture notes';
  return 'Other';
}

const normCode = (s) => String(s || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
const NOT_COURSES = new Set(['IMG', 'DSC', 'VID', 'PXL', 'SCAN', 'PAGE', 'WEEK', 'PART', 'UNIT', 'LEC', 'CHAP', 'DOC', 'FILE', 'SCR', 'PIC', 'PHOTO', 'WA', 'VER', 'REV', 'NO', 'Q', 'LAB', 'CAT', 'HW']);

/** Find the course a file belongs to: first a course you already use, then anything shaped like "CSC 311". */
function guessCourse(name, known = []) {
  const n = normCode(name);
  const hit = [...new Set(known.filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .find((k) => normCode(k).length >= 3 && n.includes(normCode(k)));
  if (hit) return hit;
  for (const m of String(name || '').matchAll(/(?:^|[^a-z])([a-z]{2,4})[\s_-]?(\d{3,4})(?!\d)/gi)) {
    if (!NOT_COURSES.has(m[1].toUpperCase())) return `${m[1].toUpperCase()} ${m[2]}`;
  }
  return '';
}

function makeFileRecord(file, knownCourses, extra = {}) {
  const name = file.name || 'file';
  return {
    id: uid(),
    name,
    type: file.type || '',
    size: file.size || 0,
    ext: fileExt(name),
    added: Date.now(),
    modified: file.lastModified || Date.now(),
    course: guessCourse(name, knownCourses),
    category: guessCategory(name, file.type || ''),
    starred: false,
    blob: file,
    ...extra,
  };
}
