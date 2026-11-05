'use strict';
/* Pick a part of a page to ask about. Shows the page full-screen with a box you drag and
 * resize (corner handles); "Ask about this part" hands back that part as a JPEG.
 * Used by ✨ Ask in the PDF viewer (PDFs, converted slides) and on photos (askai.js). */

let cropState = null;   // { pages, n, onPick, img, box: {x,y,w,h} in 0..1 of the image }
const cropperOpen = () => !!cropState;

/**
 * pages: { count, render(n) → Promise<canvas> } (n from 1) · start: first page shown
 * onPick(dataURL, n): called with the chosen part
 */
async function openCropper({ pages, start = 1, title = '', onPick }) {
  let el = $('#cropper');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cropper';
    el.className = 'cropper';
    document.body.appendChild(el);
  }
  cropState = { pages, n: start, onPick, box: { x: 0.08, y: 0.25, w: 0.84, h: 0.3 }, title };
  el.classList.remove('hidden');
  await cropShowPage();
}

async function cropShowPage() {
  const s = cropState;
  const el = $('#cropper');
  el.innerHTML = `
    <div class="cbar">
      <button data-action="crop-cancel" aria-label="Cancel">✕</button>
      <div class="grow" style="min-width:0"><b>Select the part you need help with</b><div class="small" style="opacity:.75">Drag the box · pull a corner to resize</div></div>
    </div>
    <div class="cstage"><div class="cwrap"><span class="cload">Loading page ${s.n}…</span></div></div>
    <div class="cbar bottom">
      ${s.pages.count > 1 ? `<button data-action="crop-page" data-d="-1" ${s.n <= 1 ? 'disabled' : ''}>‹</button><span class="small">Page ${s.n} / ${s.pages.count}</span><button data-action="crop-page" data-d="1" ${s.n >= s.pages.count ? 'disabled' : ''}>›</button>` : ''}
      <span class="grow"></span>
      <button data-action="crop-all">Whole page</button>
      <button class="primary" data-action="crop-use">✨ Ask about this part</button>
    </div>`;
  const canvas = await s.pages.render(s.n);
  if (cropState !== s) return;
  s.canvas = canvas;
  const wrap = el.querySelector('.cwrap');
  wrap.innerHTML = `<img alt="" src="${canvas.toDataURL('image/jpeg', 0.9)}"><div class="cbox"><i data-c="nw"></i><i data-c="ne"></i><i data-c="sw"></i><i data-c="se"></i></div>`;
  cropDraw();
  cropBindDrag(wrap);
}

function cropDraw() {
  const b = cropState.box;
  const box = $('#cropper .cbox');
  if (!box) return;
  Object.assign(box.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
}

function cropBindDrag(wrap) {
  const img = wrap.querySelector('img');
  const box = wrap.querySelector('.cbox');
  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const r = img.getBoundingClientRect();
    drag = { corner: e.target.dataset.c || null, x0: e.clientX, y0: e.clientY, b0: { ...cropState.box }, w: r.width, h: r.height };
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.x0) / drag.w, dy = (e.clientY - drag.y0) / drag.h;
    const min = 0.06;
    let { x, y, w, h } = drag.b0;
    if (!drag.corner) {               // move
      x = Math.min(Math.max(0, x + dx), 1 - w);
      y = Math.min(Math.max(0, y + dy), 1 - h);
    } else {                          // resize from a corner
      if (drag.corner.includes('w')) { const nx = Math.min(Math.max(0, x + dx), x + w - min); w += x - nx; x = nx; }
      if (drag.corner.includes('e')) w = Math.min(Math.max(min, w + dx), 1 - x);
      if (drag.corner.includes('n')) { const ny = Math.min(Math.max(0, y + dy), y + h - min); h += y - ny; y = ny; }
      if (drag.corner.includes('s')) h = Math.min(Math.max(min, h + dy), 1 - y);
    }
    cropState.box = { x, y, w, h };
    cropDraw();
  });
  const end = () => { drag = null; };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

function closeCropper() {
  cropState = null;
  $('#cropper')?.classList.add('hidden');
  if ($('#cropper')) $('#cropper').innerHTML = '';
}

function cropResult(whole) {
  const s = cropState;
  const c = s.canvas;
  const b = whole ? { x: 0, y: 0, w: 1, h: 1 } : s.box;
  const sx = Math.round(b.x * c.width), sy = Math.round(b.y * c.height);
  const sw = Math.max(1, Math.round(b.w * c.width)), sh = Math.max(1, Math.round(b.h * c.height));
  const k = Math.min(1, 1600 / Math.max(sw, sh));
  const out = Object.assign(document.createElement('canvas'), { width: Math.round(sw * k), height: Math.round(sh * k) });
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(c, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.85);
}

Object.assign(ACTIONS, {
  'crop-cancel': () => closeCropper(),
  'crop-page': (el) => {
    const s = cropState;
    s.n = Math.min(Math.max(1, s.n + Number(el.dataset.d)), s.pages.count);
    cropShowPage();
  },
  'crop-all': () => { const s = cropState, d = cropResult(true); closeCropper(); s.onPick(d, s.n); },
  'crop-use': () => { const s = cropState, d = cropResult(false); closeCropper(); s.onPick(d, s.n); },
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cropperOpen()) { e.stopImmediatePropagation(); closeCropper(); } }, true);
