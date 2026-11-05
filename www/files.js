'use strict';
/* Files library: copies of your study files (PDFs, slides, docs, photos of the board…)
 * kept on the device and auto-sorted by course and type. PDFs open in a built-in viewer (PDF.js). */

const PDFJS_BASE = 'vendor/pdfjs/';
const TEXT_EXT = ['txt', 'md', 'markdown', 'c', 'h', 'cpp', 'hpp', 'cc', 'java', 'py', 'js', 'ts', 'json', 'sh', 'bash', 'sql', 'html', 'css', 'xml', 'yml', 'yaml', 'go', 'rs', 'rb', 'php', 'kt', 'asm', 's', 'log', 'tex', 'ini', 'conf', 'csv'];
const KIND_LABEL = { pdf: 'PDF', doc: 'DOC', ppt: 'PPT', xls: 'XLS', img: 'IMG', txt: 'TXT', zip: 'ZIP', other: 'FILE' };
const KIND_NAME = { doc: 'Word', ppt: 'PowerPoint', xls: 'Spreadsheet', zip: 'Archive', other: 'These' };

const isTextFile = (f) => (f.type || '').startsWith('text/') || f.type === 'application/json' || TEXT_EXT.includes(f.ext);
function fileKind(f) {
  const e = f.ext, t = f.type || '';
  if (t.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp'].includes(e)) return 'img';
  if (e === 'pdf' || t === 'application/pdf') return 'pdf';
  if (['doc', 'docx', 'odt', 'rtf'].includes(e)) return 'doc';
  if (['ppt', 'pptx', 'odp', 'key'].includes(e)) return 'ppt';
  if (['xls', 'xlsx', 'ods'].includes(e)) return 'xls';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return 'zip';
  if (isTextFile(f)) return 'txt';
  return 'other';
}

/** Is this file's content on this device? (in the database, or on the phone in the app's private folder) */
const hasLocal = (f) => !!(f && (f.blob || f.native));

// Object URLs for thumbnails / opening, created once per file
const objectURLs = new Map();
function fileURL(f) {
  if (f.native && !f.blob && typeof vaultOn === 'function' && vaultOn()) return vaultFileUrl(f.id);
  if (!objectURLs.has(f.id)) objectURLs.set(f.id, URL.createObjectURL(f.blob));
  return objectURLs.get(f.id);
}
function dropURL(id) {
  const u = objectURLs.get(id);
  if (u) { URL.revokeObjectURL(u); objectURLs.delete(id); }
}
function dropAllURLs() {
  for (const id of [...objectURLs.keys()]) dropURL(id);
}

/** A file's bytes (key 'blob', or 'pdf' for the laptop's PDF copy of slides). If the copy in
 * memory can't be read (it came through a database connection the system has since closed),
 * read the record again through a fresh connection. Never hangs: gives up after 30 s. */
async function fileBytes(f, key = 'blob') {
  if (key === 'blob' && f.native && !f.blob) { await vaultInit(); return vaultRead(f.id); }   // phone: app's private folder
  const read = (b) => Promise.race([
    b.arrayBuffer(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 30000)),
  ]);
  try {
    return await read(f[key]);
  } catch {
    forgetDB();   // shared.js: next read opens a new connection
    const fresh = await tx('files', 'readonly', (st) => st.get(f.id));
    if (!fresh || !fresh[key]) throw new Error("this device's copy is gone; download it again (⬇)");
    try {
      return await read(fresh[key]);
    } catch {
      throw new Error("this device's copy can't be read; remove it and download it again");
    }
  }
}

// ---------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------
function filesView() {
  const n = data.files.length;
  const cats = FILE_CATEGORIES.filter((c) => data.files.some((f) => f.category === c));
  const starred = data.files.filter((f) => f.starred).length;
  const chip = (value, label) => `<button class="chip ${state.fileFilter === value ? 'active' : ''}" data-action="file-filter" data-value="${esc(value)}">${label}</button>`;
  return `
    ${notesSeg()}
    <div class="row" style="margin-bottom:12px">
      <button class="btn primary grow" data-action="pick-files">＋ Add files</button>
      <button class="btn grow" data-action="pick-photo">📷 Board photo</button>
    </div>
    ${n ? `
      <div class="toolbar">
        <input type="search" placeholder="Search ${n} file${n === 1 ? '' : 's'}…" value="${esc(state.fileQuery)}" data-action-input="file-search" aria-label="Search files">
        <select data-action-change="file-sort" aria-label="Sort">
          ${[['recent', 'Newest'], ['name', 'Name'], ['size', 'Largest'], ['opened', 'Last opened']].map(([v, l]) => `<option value="${v}" ${state.fileSort === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="chips">
        ${chip('all', `All ${n}`)}
        ${starred ? chip('starred', `★ Starred ${starred}`) : ''}
        ${cats.map((c) => chip(c, `${c} ${data.files.filter((f) => f.category === c).length}`)).join('')}
      </div>` : ''}
    <div id="fileList">${fileListHTML()}</div>
    <p class="hint" id="storageInfo" style="text-align:center;margin-top:16px"></p>`;
}

function fileListHTML() {
  if (!data.files.length) {
    return `<div class="card empty" style="padding:30px 16px"><span class="big">📚</span><b>Keep your study files here</b><br>
      Add PDFs, slides, Word docs and photos from your phone. StudyHub reads the file name and sorts each file by course (e.g. <code>CSC311_lec4.pdf</code> → CSC 311) and type.<br><br>
      <span class="small">Once the app is installed on Android, you can also tap <b>Share → StudyHub</b> in WhatsApp, Files or Drive.</span></div>`;
  }
  const q = state.fileQuery.trim().toLowerCase();
  const list = data.files.filter((f) =>
    (state.fileFilter === 'all' || (state.fileFilter === 'starred' ? f.starred : f.category === state.fileFilter)) &&
    (!q || `${f.name} ${f.course} ${f.category}`.toLowerCase().includes(q)));
  const sorters = {
    recent: (a, b) => b.added - a.added,
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    size: (a, b) => b.size - a.size,
    opened: (a, b) => (b.opened || 0) - (a.opened || 0),
  };
  list.sort(sorters[state.fileSort] || sorters.recent);
  if (!list.length) return '<div class="card empty">No files match</div>';

  const groups = new Map();
  for (const f of list) {
    const k = f.course || 'Unsorted';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === 'Unsorted' ? 1 : b === 'Unsorted' ? -1 : a.localeCompare(b)));
  return keys.map((k) => {
    const fs = groups.get(k);
    const collapsed = state.collapsed.has(k) && !q;
    const size = fs.reduce((s, f) => s + f.size, 0);
    return `<section class="fgroup ${collapsed ? 'collapsed' : ''}">
      <button class="fgroup-head" data-action="toggle-group" data-course="${esc(k)}">
        ${ICON.chevron}<span class="dot" style="background:${courseColor(k) || 'var(--muted)'}"></span><b>${esc(k)}</b>
        <span class="count">${fs.length} · ${fmtSize(size)}</span>
      </button>
      ${collapsed ? '' : groupGetButton(k, fs) + fs.map(fileRow).join('')}
    </section>`;
  }).join('');
}

// ---------------------------------------------------------------------
// Files from the other device: kept on the laptop, downloaded here only when you ask (⬇)
// ---------------------------------------------------------------------
const downloading = new Map();   // file id → fraction done

function dlLabel(f) {
  const p = downloading.get(f.id);
  return p === undefined ? 'Not downloaded' : `Downloading… ${Math.round(p * 100)}%`;
}

function groupGetButton(course, fs) {
  const missing = fs.filter((f) => !hasLocal(f));
  if (!missing.length) return '';
  const busy = missing.some((f) => downloading.has(f.id));
  return `<button class="fgroup-get" data-action="file-get-group" data-course="${esc(course)}" ${busy ? 'disabled' : ''}>
    ⬇ ${busy ? 'Downloading…' : `Download ${missing.length === 1 ? 'the 1 file' : `all ${missing.length}`} not on this device (${fmtSize(missing.reduce((n, f) => n + (f.size || 0), 0))})`}</button>`;
}

/** Download a file from the laptop onto this device. Returns true when it's here. */
async function getFile(f, { quiet = false } = {}) {
  if (hasLocal(f)) return true;
  if (downloading.has(f.id)) return false;
  if (typeof syncBase !== 'function' || !syncBase() || (!syncCfg.key && !onHubLaptop())) {
    toast('This file is on your laptop. Connect to it first (☰ → Sync with laptop).');
    return false;
  }
  downloading.set(f.id, 0);
  refreshFileList();
  let ok = false;
  try {
    await syncDownload(f, (p) => {
      downloading.set(f.id, p);
      const el = document.querySelector(`[data-dl="${f.id}"]`);
      if (el) el.textContent = dlLabel(f);
    });
    ok = true;
    if (!quiet) toast(`✅ ${f.name} is on this device now`);
  } catch (e) {
    toast(e.status === 404 ? `The laptop doesn't have "${f.name}" yet: sync on the device that has it first.`
      : `Couldn't download ${f.name}: ${e.message}`);
  } finally {
    downloading.delete(f.id);
    refreshFileList();
  }
  return ok;
}

function fileRow(f) {
  const k = fileKind(f);
  if (!hasLocal(f)) {
    // known from sync; the contents stay on the laptop until you download them
    const busy = downloading.has(f.id);
    return `<div class="frow pending">
      <button class="ficon k-${k}" data-action="file-get" data-id="${f.id}" aria-label="Download" ${busy ? 'disabled' : ''}>${busy ? '⏳' : '⬇'}</button>
      <button class="body" data-action="open-file" data-id="${f.id}"><div class="fname">${esc(f.name)}</div>
        <div class="meta">${esc(f.category)} · ${fmtSize(f.size)} · <span data-dl="${f.id}">${dlLabel(f)}</span></div></button>
      <button class="btn small getbtn" data-action="file-get" data-id="${f.id}" ${busy ? 'disabled' : ''}>⬇ Get</button>
      <button class="icon-btn" data-action="file-details" data-id="${f.id}" aria-label="Details"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>
    </div>`;
  }
  return `<div class="frow">
    <button class="ficon k-${k}" data-action="open-file" data-id="${f.id}" aria-label="Open">${k === 'img' ? `<img src="${fileURL(f)}" alt="" loading="lazy" decoding="async">` : KIND_LABEL[k]}</button>
    <button class="body" data-action="open-file" data-id="${f.id}">
      <div class="fname">${esc(f.name)}</div>
      <div class="meta">${esc(f.category)} · ${fmtSize(f.size)} · ${timeAgo(f.added)}</div>
    </button>
    <button class="star ${f.starred ? 'on' : ''}" data-action="star-file" data-id="${f.id}" aria-label="${f.starred ? 'Unstar' : 'Star'}">★</button>
    <button class="icon-btn" data-action="file-details" data-id="${f.id}" aria-label="Details"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>
  </div>`;
}

function refreshFileList() {
  const el = $('#fileList');
  if (el) el.innerHTML = fileListHTML();
  else render();
}

RENDER_HOOKS.push(() => { if (state.tab === 'notes' && state.notesMode === 'files') fillStorage('#storageInfo'); });

// ---------------------------------------------------------------------
// Adding files
// ---------------------------------------------------------------------
async function addFiles(list, { photo = false } = {}) {
  if (!list.length) return;
  const known = allCourses();
  const cur = photo ? currentOrRecentClass() : null;
  let added = 0, skipped = 0;
  const where = new Set();
  for (const file of list) {
    if (!photo && data.files.some((x) => x.name === file.name && x.size === file.size)) { skipped++; continue; }
    const rec = makeFileRecord(file, known);
    if (photo) {
      const stamp = new Date().toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      rec.category = 'Board photos';
      rec.course = cur ? cur.cls.course || cur.cls.title : rec.course;
      rec.name = `Board${rec.course ? ` – ${rec.course}` : ''} – ${stamp}.${fileExt(file.name) || 'jpg'}`;
    }
    try {
      await dbPut('files', rec);
    } catch (e) {
      toast(e.name === 'QuotaExceededError' ? 'Phone storage for StudyHub is full' : `Couldn't save ${file.name}`);
      break;
    }
    added++;
    where.add(rec.course || 'Unsorted');
  }
  await loadAll();
  // make sure the new files are visible: clear search/filters, newest first, open their groups
  state.tab = 'notes';
  state.notesMode = 'files';
  state.fileQuery = '';
  state.fileFilter = 'all';
  state.fileSort = 'recent';
  where.forEach((k) => state.collapsed.delete(k));
  render();
  if (added) toast(`Added ${added} file${added === 1 ? '' : 's'} → ${[...where].slice(0, 3).join(', ')}${skipped ? ` (${skipped} already here)` : ''}`);
  else if (skipped) toast('Those files are already in your library');
}

// ---------------------------------------------------------------------
// Opening files
// ---------------------------------------------------------------------
async function openFile(id) {
  const f = byId('files', id);
  if (!f) return;
  if (!hasLocal(f)) {
    // on the laptop only: download it, then open it
    if (await getFile(f, { quiet: true })) return openFile(id);
    return;
  }
  dbPut('files', { ...f, opened: Date.now() }, true).then(loadAll); // "last opened" is local; don't count as an edit // remember for "Last opened" sort
  const k = fileKind(f);
  if (k === 'pdf') return openPdf(f);
  if (k === 'img') {
    return openSheet(`<h3 class="clip">${esc(f.name)}</h3><img class="preview" src="${fileURL(f)}" alt="">
      <button class="btn primary block" style="margin-top:10px" data-action="image-ask" data-id="${f.id}">✨ Ask AI about part of this</button>${fileActions(f)}`);
  }
  if (isTextFile(f) && k !== 'xls') {
    const text = new TextDecoder().decode((await fileBytes(f)).slice(0, 300_000));
    const prose = ['md', 'markdown', 'txt'].includes(f.ext);
    return openSheet(`<h3 class="clip">${esc(f.name)}</h3>
      <div class="textview rich">${prose ? rich(text) : `<pre><code>${esc(text)}</code></pre>`}</div>${fileActions(f)}`);
  }
  if ((k === 'ppt' || k === 'doc') && f.pdf) return openPdf(f, 'pdf');   // the laptop's exact PDF copy, if it made one
  if (officeHere(f)) return openOffice(f);   // .pptx / .docx: drawn on this device (office.js), no laptop needed
  const canView = (k === 'ppt' || k === 'doc') && typeof syncBase === 'function' && syncBase() && (syncCfg.lastOk || onHubLaptop());
  openSheet(`<h3 class="clip">${esc(f.name)}</h3>
    <div class="card empty"><div class="ficon k-${k}" style="margin:0 auto 10px">${KIND_LABEL[k]}</div>
      ${canView ? `Your laptop can turn this into pages you can read right here (once; then it works offline).`
        : (k === 'ppt' || k === 'doc') ? `Old-style .${esc(f.ext)} files can't be drawn on the phone. Open it in another app, or connect to your laptop (☰ → Sync with laptop) to read it inside StudyHub.`
        : `${KIND_NAME[k] || 'These'} files open in their own app (Word, PowerPoint, WPS, Google Docs…).`}
      <br><span class="small">${fmtSize(f.size)} · ${esc(f.category)}</span></div>
    ${canView ? `<button class="btn primary block" style="margin-top:12px" data-action="file-view-pdf" data-id="${f.id}">📖 View in StudyHub</button>` : ''}
    ${fileActions(f, !canView)}`);
}

/** Slides / Word: ask the laptop for a PDF copy (LibreOffice), keep it on this device, show it. */
async function viewAsPdf(f, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Converting on the laptop…'; }
  try {
    const res = await sfetch(`/sync/pdf/${encodeURIComponent(f.id)}`, { timeout: 300000 });
    const pdf = await res.blob();
    await dbPut('files', { ...byId('files', f.id), pdf: new Blob([pdf], { type: 'application/pdf' }) }, true); // local only, not synced
    await loadAll();
    openPdf(byId('files', f.id), 'pdf');
  } catch (e) {
    let msg = e.message;
    if (/404|409/.test(msg)) msg = "The laptop doesn't have this file yet. Sync (🔄) first, then try again.";
    toast(msg);
    if (btn) { btn.disabled = false; btn.textContent = '📖 View in StudyHub'; }
  }
}

function fileActions(f, primaryOpen = false) {
  return `<div class="row wrap" style="margin-top:12px">
    <button class="btn ${primaryOpen ? 'primary' : ''}" data-action="file-download" data-id="${f.id}">↗ Open in another app</button>
    <button class="btn" data-action="file-share" data-id="${f.id}">Share</button>
    <span class="grow"></span>
    <button class="btn" data-action="file-details" data-id="${f.id}">Details</button>
  </div>`;
}

async function downloadFile(f) {
  let bytes;
  try { bytes = await fileBytes(f); } catch (e) { return toast(`Can't open it: ${e.message}`); }
  if (NATIVE) return nativeOpenFile(new File([bytes], f.name, { type: f.type || 'application/octet-stream' }));
  const a = Object.assign(document.createElement('a'), { href: fileURL(f), download: f.name });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function fileSheet(f) {
  openSheet(`
    <h3>File details</h3>
    <form data-form="file">
      <input type="hidden" name="id" value="${f.id}">
      <label class="field"><span>Name</span><input type="text" name="name" required value="${esc(f.name)}"></label>
      <div class="two">
        <label class="field"><span>Course</span><input type="text" name="course" list="courseList" value="${esc(f.course)}" placeholder="Unsorted">${datalist('courseList', allCourses())}</label>
        <label class="field"><span>Type</span><select name="category">${FILE_CATEGORIES.map((c) => `<option ${c === f.category ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      </div>
      <label class="checkline"><input type="checkbox" name="starred" ${f.starred ? 'checked' : ''}> ★ Starred (important for exams)</label>
      <p class="muted small">${fmtSize(f.size)} · ${esc(f.type || f.ext || 'file')} · added ${new Date(f.added).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</p>
      <p class="small" style="margin:-4px 2px 12px">${hasLocal(f)
        ? `On this device. <button type="button" class="linkbtn" data-action="file-unload" data-id="${f.id}">Remove download</button> to free ${fmtSize(f.size)} here (it stays on the laptop).`
        : `On the laptop only. <button type="button" class="linkbtn" data-action="file-get" data-id="${f.id}">⬇ Download it</button>`}</p>
      <div class="row wrap">
        <button type="button" class="btn danger" data-action="delete-file" data-id="${f.id}">Delete</button>
        <button type="button" class="btn" data-action="open-file" data-id="${f.id}">Open</button>
        <span class="grow"></span>
        <button class="btn primary">Save</button>
      </div>
    </form>`);
}

// ---------------------------------------------------------------------
// PDF viewer (PDF.js, lazy-loaded, pages rendered as you scroll)
// ---------------------------------------------------------------------
let pdfjsPromise = null;
let viewerToken = 0;
let viewerCleanup = null;
/** What's on screen, for ✨ Ask (crop.js): { count, render(n) → Promise<canvas> } with pages from 1. */
let viewerPages = null;

/** Page n of a PDF.js document as a canvas about `width` pixels wide. */
async function renderPageCanvas(doc, n, width = 1800) {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.floor(vp.width), height: Math.floor(vp.height) });
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  return canvas;
}

function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${PDFJS_BASE}pdf.min.js`;
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.min.js`; resolve(window.pdfjsLib); };
      s.onerror = () => { pdfjsPromise = null; reject(new Error('viewer failed to load')); };
      document.head.appendChild(s);
    });
  }
  return pdfjsPromise;
}

/** Show the (empty) viewer for file f. Returns its token: stale if another file opened meanwhile. */
function showViewer(f, kind = 'pdf') {
  const token = ++viewerToken;
  const v = $('#viewer');
  if (sheetOpen()) hideSheet(); // reuse its history entry
  v.dataset.id = f.id;
  v.dataset.kind = kind;
  v.querySelector('.vtitle').textContent = f.name;
  v.querySelector('.vcount').textContent = 'Loading…';
  v.querySelector('.pages').innerHTML = '';
  v.classList.remove('hidden');
  document.body.classList.add('noscroll');
  pushModal();
  return token;
}

async function openPdf(f, key = 'blob') {
  const token = showViewer(f);
  const v = $('#viewer');
  const pages = v.querySelector('.pages');
  try {
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: new Uint8Array(await fileBytes(f, key)) }).promise;
    if (token !== viewerToken) { doc.destroy(); return; }
    const vp1 = (await doc.getPage(1)).getViewport({ scale: 1 });
    v.querySelector('.vcount').textContent = `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`;
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        renderPdfPage(doc, Number(en.target.dataset.page), en.target, token).catch(() => {});
      }
    }, { root: pages, rootMargin: '800px 0px' });
    for (let i = 1; i <= doc.numPages; i++) {
      const ph = document.createElement('div');
      ph.className = 'page';
      ph.dataset.page = i;
      ph.style.aspectRatio = `${vp1.width} / ${vp1.height}`;
      pages.appendChild(ph);
      io.observe(ph);
    }
    viewerPages = { count: doc.numPages, render: (n) => renderPageCanvas(doc, n, 1800) };
    viewerCleanup = () => { io.disconnect(); doc.destroy(); };
  } catch (e) {
    if (token !== viewerToken) return;
    v.querySelector('.vcount').textContent = '';
    pages.innerHTML = `<p class="vmsg">Couldn't show this PDF here (${esc(e.message)}).<br><br>
      <button class="btn primary" data-action="file-download" data-id="${f.id}">Open in another app</button></p>`;
  }
}

async function renderPdfPage(doc, n, el, token) {
  const page = await doc.getPage(n);
  if (token !== viewerToken) return;
  const width = el.clientWidth || window.innerWidth;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const vp = page.getViewport({ scale: (width / page.getViewport({ scale: 1 }).width) * dpr });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  if (token !== viewerToken) return;
  el.appendChild(canvas);
  el.insertAdjacentHTML('beforeend', `<span class="pno">${n}</span>`);
}

function hideViewer() {
  viewerToken++;
  if (typeof closeAskPanel === 'function') closeAskPanel();
  viewerPages = null;
  if (viewerCleanup) { try { viewerCleanup(); } catch { /* ignore */ } viewerCleanup = null; }
  const v = $('#viewer');
  v.classList.add('hidden');
  v.querySelector('.pages').innerHTML = '';
  document.body.classList.remove('noscroll');
}
function closeViewer() {
  if (history.state?.modal) history.back();
  else hideViewer();
}

// ---------------------------------------------------------------------
// Actions & forms
// ---------------------------------------------------------------------
Object.assign(ACTIONS, {
  'file-filter': (el) => { state.fileFilter = el.dataset.value; render(); },
  'toggle-group': (el) => {
    const k = el.dataset.course;
    state.collapsed.has(k) ? state.collapsed.delete(k) : state.collapsed.add(k);
    refreshFileList();
  },
  'open-file': (el) => openFile(el.dataset.id),
  'file-view-pdf': (el) => viewAsPdf(byId('files', el.dataset.id), el),
  'file-details': (el) => fileSheet(byId('files', el.dataset.id)),
  async 'file-get'(el) {
    const f = byId('files', el.dataset.id);
    if (!f) return;
    if (sheetOpen()) closeSheet();
    await getFile(f);
  },
  async 'file-get-group'(el) {
    const list = data.files.filter((f) => (f.course || 'Unsorted') === el.dataset.course && !hasLocal(f));
    let n = 0;
    for (const f of list) if (await getFile(byId('files', f.id) || f, { quiet: true })) n++;
    toast(n === list.length ? `✅ ${n} file${n === 1 ? '' : 's'} downloaded` : `Downloaded ${n} of ${list.length}`);
  },
  /** Free space here: drop this device's copy, keep the file on the laptop (never the only copy). */
  async 'file-unload'(el) {
    const f = byId('files', el.dataset.id);
    if (!f || !hasLocal(f)) return;
    const has = await hubHasFile(f);
    if (has !== true) {
      return toast(has === false
        ? "The laptop doesn't have this file yet, so this is the only copy. Sync (🔄) first, then try again."
        : "Can't reach the laptop to check it has a copy, so the file stays here. Try again when connected.");
    }
    if (!confirm(`Remove "${f.name}" from this ${NATIVE ? 'phone' : 'browser'}? It stays on the laptop and you can download it again any time.`)) return;
    dropURL(f.id);
    const rec = { ...f, missing: true };
    delete rec.blob;
    delete rec.pdf;
    if (rec.native) { rec.native = false; if (typeof vaultDelete === 'function') await vaultDelete(f.id); }
    await dbPut('files', rec, true);   // local only: not a change to sync
    await loadAll();
    closeSheet();
    render();
    toast(`Removed from this device · still on the laptop`);
  },
  'file-download': (el) => downloadFile(byId('files', el.dataset.id)),
  async 'file-share'(el) {
    const f = byId('files', el.dataset.id);
    let bytes;
    try { bytes = await fileBytes(f); } catch (e) { return toast(`Can't share it: ${e.message}`); }
    return shareOrDownload(new File([bytes], f.name, { type: f.type || 'application/octet-stream' }));
  },
  async 'star-file'(el) {
    const f = byId('files', el.dataset.id);
    await save('files', { ...f, starred: !f.starred });
    refreshFileList();
  },
  async 'delete-file'(el) {
    const f = byId('files', el.dataset.id);
    if (!confirm(`Delete "${f.name}" from StudyHub? (The original on your phone isn't touched.)`)) return;
    dropURL(f.id);
    await remove('files', f.id);
    closeSheet(); render();
    toast('File deleted');
  },
  'close-viewer': () => closeViewer(),
  'viewer-share': () => ACTIONS['file-share']({ dataset: { id: $('#viewer').dataset.id } }),
  'viewer-open': () => downloadFile(byId('files', $('#viewer').dataset.id)),
});

Object.assign(CHANGE_ACTIONS, {
  'file-sort': (el) => { state.fileSort = el.value; refreshFileList(); },
});

// The pickers are static elements in index.html (see the note there).
function bindPicker(sel, opts) {
  const input = $(sel);
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    toast(files.length === 1 ? `Adding ${files[0].name}…` : `Adding ${files.length} files…`);
    addFiles(files, opts).catch((e) => toast(`Couldn't add: ${e.message}`));
  });
}
bindPicker('#pickFiles', {});
bindPicker('#pickPhoto', { photo: true });

Object.assign(ACTIONS, {
  'pick-files': () => $('#pickFiles').click(),
  'pick-photo': () => { if (drawerOpen()) closeDrawer(); $('#pickPhoto').click(); },
});

INPUT_ACTIONS['file-search'] = (el) => { state.fileQuery = el.value; refreshFileList(); };

FORMS.file = async (form) => {
  const f = Object.fromEntries(new FormData(form));
  const prev = byId('files', f.id);
  const name = f.name.trim() || prev.name;
  await save('files', { ...prev, name, ext: fileExt(name) || prev.ext, course: f.course.trim(), category: f.category, starred: !!f.starred });
  closeSheet(); render();
  toast('Saved');
};
