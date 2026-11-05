'use strict';
/* Slides (.pptx) and Word (.docx) drawn on the phone itself, in the same viewer as PDFs: works
 * offline, no laptop needed. Libraries are in vendor/office and load the first time you open one:
 *   pptx-preview (slides), docx-preview + JSZip (Word), WMFJS / EMFJS (old Windows pictures —
 *   lecturers' diagrams and equations are often WMF/EMF, which browsers can't show by themselves).
 * Old binary .ppt / .doc can't be read here; those still go through the laptop (files.js). */

const OFFICE_BASE = 'vendor/office/';
const OFFICE_HERE = { pptx: 'slides', ppsx: 'slides', docx: 'doc' };
const OFFICE_W = { slides: 960 };   // slides are laid out at this width, then zoomed to fit the screen
const scriptLoads = {};

function officeExt(f) {
  return (f.ext || (f.name || '').split('.').pop() || '').toLowerCase();
}
function officeHere(f) {
  return !!OFFICE_HERE[officeExt(f)];
}

function loadScript(name) {
  if (!scriptLoads[name]) {
    scriptLoads[name] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = OFFICE_BASE + name;
      s.onload = resolve;
      s.onerror = () => { delete scriptLoads[name]; s.remove(); reject(new Error('viewer failed to load')); };
      document.head.appendChild(s);
    });
  }
  return scriptLoads[name];
}

async function openOffice(f) {
  const kind = OFFICE_HERE[officeExt(f)];
  const token = showViewer(f, kind);
  const v = $('#viewer');
  const pages = v.querySelector('.pages');
  try {
    const data = await fileBytes(f);
    if (token !== viewerToken) return;
    const n = kind === 'slides' ? await drawSlides(data, pages, token) : await drawDocx(new Blob([data]), pages, token);
    if (token !== viewerToken) return;
    const unit = kind === 'slides' ? 'slide' : 'page';
    v.querySelector('.vcount').textContent = `${n} ${unit}${n === 1 ? '' : 's'}`;
  } catch (e) {
    if (token !== viewerToken) return;
    v.querySelector('.vcount').textContent = '';
    pages.innerHTML = `<p class="vmsg">Couldn't show this file here (${esc(e.message || String(e))}).<br><br>
      <button class="btn primary" data-action="file-download" data-id="${f.id}">Open in another app</button></p>`;
  }
}

/** Fit a fixed-width layout to the viewer: CSS zoom keeps text sharp (it re-lays out, unlike transform). */
function fitZoom(box, pages, width) {
  const fit = () => {
    const avail = Math.min(pages.clientWidth - 16, 900);
    box.style.zoom = String(Math.max(0.2, avail / width));
  };
  fit();
  window.addEventListener('resize', fit);
  return () => window.removeEventListener('resize', fit);
}

async function drawSlides(data, pages, token) {
  await loadScript('pptx-preview.umd.js');
  if (token !== viewerToken) return 0;
  const box = document.createElement('div');
  box.className = 'office slides';
  pages.appendChild(box);
  const width = OFFICE_W.slides;
  const pv = window.pptxPreview.init(box, { width, mode: 'list' });
  await pv.preview(data);
  const slides = [...box.querySelectorAll('.pptx-preview-slide-wrapper')];
  if (!slides.length) throw new Error('no slides found');
  slides.forEach((s, i) => {
    s.classList.add('page');
    s.dataset.page = i + 1;
    s.insertAdjacentHTML('beforeend', `<span class="pno">${i + 1}</span>`);
  });
  try { await addEquations(data, slides, width); } catch { /* extras only: the slides still show */ }
  await fixOldPictures(box);
  const unfit = fitZoom(box, pages, width);
  viewerPages = { count: slides.length, render: (n) => snapshot(slides[n - 1], '', 2) };
  viewerCleanup = () => { unfit(); try { pv.destroy(); } catch { /* ignore */ } };
  return slides.length;
}

async function drawDocx(blob, pages, token) {
  await loadScript('jszip.min.js');
  await loadScript('docx-preview.min.js');
  if (token !== viewerToken) return 0;
  const box = document.createElement('div');
  box.className = 'office doc';
  const styles = document.createElement('div');
  pages.append(styles, box);
  await window.docx.renderAsync(blob, box, styles, {
    className: 'docx', inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false,
    useBase64URL: true,   // pictures as data: URLs, so ✨ Ask snapshots include them
    renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
  });
  const secs = [...box.querySelectorAll('section.docx')];
  if (!secs.length) throw new Error('no pages found');
  secs.forEach((s, i) => { s.dataset.page = i + 1; });
  await fixOldPictures(box);
  const width = Math.max(...secs.map((s) => parseFloat(getComputedStyle(s).width) || 0)) || 816;
  const unfit = fitZoom(box, pages, width + 16);
  const css = [...styles.querySelectorAll('style')].map((st) => st.textContent).join('\n');
  // docx-preview only breaks pages where the file says so, so a section can be very long:
  // count it (and picture it for ✨ Ask) as A4-shaped pages
  const parts = [];
  for (const sec of secs) {
    const cs = getComputedStyle(sec);
    const w = parseFloat(cs.width) || 816, h = parseFloat(cs.height) || w * 1.414;
    const n = Math.max(1, Math.round(h / (w * 1.414)));
    for (let i = 0; i < n; i++) parts.push({ sec, from: i / n, to: (i + 1) / n });
  }
  secs.forEach((sec) => { sec.dataset.page = parts.findIndex((q) => q.sec === sec) + 1; });
  const shots = new Map();
  viewerPages = {
    count: parts.length,
    current() {   // the page in the middle of the screen
      const mid = window.innerHeight / 2;
      for (let i = 0; i < parts.length; i++) {
        const r = parts[i].sec.getBoundingClientRect();
        const y0 = r.top + r.height * parts[i].from, y1 = r.top + r.height * parts[i].to;
        if (mid >= y0 && mid < y1) return i + 1;
      }
      return 1;
    },
    async render(n) {
      const q = parts[n - 1];
      if (!shots.has(q.sec)) shots.set(q.sec, snapshot(q.sec, css, 2));
      const whole = await shots.get(q.sec);
      if (q.from === 0 && q.to === 1) return whole;
      const y0 = Math.floor(whole.height * q.from), y1 = Math.ceil(whole.height * q.to);
      const c = Object.assign(document.createElement('canvas'), { width: whole.width, height: y1 - y0 });
      c.getContext('2d').drawImage(whole, 0, y0, whole.width, y1 - y0, 0, 0, whole.width, y1 - y0);
      return c;
    },
  };
  viewerCleanup = () => { unfit(); };
  return parts.length;
}

// ---------------------------------------------------------------------
// Equations and other embedded objects (Equation Editor 3.0 etc.)
// pptx-preview skips <p:oleObj>; PowerPoint keeps a preview picture of each one (usually WMF),
// linked from the frame itself or from the slide's old VML drawing. Put that picture where the
// object sits, following the transforms of any groups it is inside.
// ---------------------------------------------------------------------
const MIME = { wmf: 'image/x-wmf', emf: 'image/x-emf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml' };

function zipPath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

async function zipRels(zip, path) {
  const relsPath = path.replace(/([^/]+)$/, '_rels/$1.rels');
  const xml = await zip.file(relsPath)?.async('string');
  const out = {};
  if (xml) {
    for (const r of new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('Relationship')) {
      out[r.getAttribute('Id')] = { target: zipPath(path, r.getAttribute('Target')), type: r.getAttribute('Type') || '' };
    }
  }
  return out;
}

const kids = (el, name) => [...el.children].filter((c) => c.localName === name);
const kid = (el, name) => kids(el, name)[0];
function xfrmOf(el) {   // <a:xfrm>/<p:xfrm> → numbers (EMU, or a group's child units)
  const x = el && (kid(el, 'xfrm') || kid(kid(el, 'spPr') || kid(el, 'grpSpPr') || el, 'xfrm'));
  if (!x) return null;
  const num = (n, a) => Number(kid(x, n)?.getAttribute(a) || 0);
  return { x: num('off', 'x'), y: num('off', 'y'), w: num('ext', 'cx'), h: num('ext', 'cy'),
    cx: num('chOff', 'x'), cy: num('chOff', 'y'), cw: num('chExt', 'cx'), ch: num('chExt', 'cy') };
}

async function addEquations(data, slides, width) {
  await loadScript('jszip.min.js');
  const zip = await window.JSZip.loadAsync(data);
  const parse = async (p) => new DOMParser().parseFromString(await zip.file(p).async('string'), 'application/xml');
  const pres = await parse('ppt/presentation.xml');
  const slideW = Number(pres.getElementsByTagNameNS('*', 'sldSz')[0]?.getAttribute('cx')) || 9144000;
  const presRels = await zipRels(zip, 'ppt/presentation.xml');
  const ids = [...pres.getElementsByTagNameNS('*', 'sldId')];
  const k = width / slideW;   // EMU → px on our slides

  for (let i = 0; i < ids.length && i < slides.length; i++) {
    const rid = ids[i].getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || ids[i].getAttribute('r:id');
    const path = presRels[rid]?.target;
    if (!path || !zip.file(path)) continue;
    const xml = await zip.file(path).async('string');
    if (!xml.includes('oleObj')) continue;
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const rels = await zipRels(zip, path);
    // VML shapes (o:spid → image) from the slide's legacy drawing
    const vml = {};
    for (const r of Object.values(rels)) {
      if (!/vmlDrawing/.test(r.type) || !zip.file(r.target)) continue;
      const text = await zip.file(r.target).async('string');
      const vrels = await zipRels(zip, r.target);
      for (const m of text.matchAll(/<v:shape\b[^>]*\bid="([^"]+)"[\s\S]*?<\/v:shape>/g)) {
        const rel = /<v:imagedata\b[^>]*\bo:relid="([^"]+)"/.exec(m[0]) || /<v:imagedata\b[^>]*\br:id="([^"]+)"/.exec(m[0]);
        if (rel && vrels[rel[1]]) vml[m[1]] = vrels[rel[1]].target;
      }
    }
    const have = new Set([...slides[i].querySelectorAll('img')].map((im) => im.src.slice(im.src.indexOf(',') + 1, im.src.indexOf(',') + 200)));
    const found = [];
    const walk = (node, map) => {
      for (const el of node.children) {
        const n = el.localName;
        if (n === 'grpSp') {
          const g = xfrmOf(kid(el, 'grpSpPr'));
          const sx = g && g.cw ? g.w / g.cw : 1, sy = g && g.ch ? g.h / g.ch : 1;
          walk(el, g ? (p) => map({ x: g.x + (p.x - g.cx) * sx, y: g.y + (p.y - g.cy) * sy, w: p.w * sx, h: p.h * sy }) : map);
        } else if (n === 'AlternateContent') {
          const choice = kid(el, 'Choice') || kid(el, 'Fallback');
          if (choice) walk(choice, map);
        } else if (n === 'graphicFrame') {
          const ole = el.getElementsByTagNameNS('*', 'oleObj')[0];
          const box = xfrmOf(el);
          if (!ole || !box) continue;
          let media = null;
          const blip = ole.getElementsByTagNameNS('*', 'blip')[0];
          const embed = blip && (blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed') || blip.getAttribute('r:embed'));
          if (embed && rels[embed]) media = rels[embed].target;
          else media = vml[ole.getAttribute('spid')];
          if (media) found.push({ media, ...map(box) });
        }
      }
    };
    const tree = doc.getElementsByTagNameNS('*', 'spTree')[0];
    if (tree) walk(tree, (p) => p);
    for (const o of found) {
      const file = zip.file(o.media);
      if (!file) continue;
      const b64 = await file.async('base64');
      if (have.has(b64.slice(0, 199))) continue;   // the renderer did show this one
      const img = document.createElement('img');
      img.className = 'ole';
      img.alt = '';
      img.src = `data:${MIME[o.media.split('.').pop().toLowerCase()] || 'image/png'};base64,${b64}`;
      img.style.cssText = `position:absolute;left:${o.x * k}px;top:${o.y * k}px;width:${o.w * k}px;height:${o.h * k}px;z-index:3`;
      slides[i].appendChild(img);
    }
  }
}

// ---------------------------------------------------------------------
// WMF / EMF pictures → SVG
// ---------------------------------------------------------------------
async function fixOldPictures(root) {
  const imgs = [...root.querySelectorAll('img')].filter((i) => /^data:image\/(x-)?(wmf|emf|x-msmetafile)/i.test(i.src));
  if (!imgs.length) return;
  try {
    await Promise.all([loadScript('WMFJS.bundle.min.js'), loadScript('EMFJS.bundle.min.js')]);
  } catch { return; }
  const done = new Map();   // the same picture is often reused on many slides
  for (const img of imgs) {
    const src = img.src;
    if (!done.has(src)) done.set(src, metafileToSvg(src));
    const svg = done.get(src);
    if (svg) img.src = svg;
    else img.style.visibility = 'hidden';   // no broken-image icon
  }
}

/** "Symbol" font letters → the Unicode characters they draw. */
const SYMBOL_FONT = (() => {
  const m = {};
  const greek = 'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ', greekLow = 'αβχδεφγηιϕκλμνοπθρστυϖωξψζ';
  for (let i = 0; i < 26; i++) { m[String.fromCharCode(65 + i)] = greek[i]; m[String.fromCharCode(97 + i)] = greekLow[i]; }
  const hi = { 0xA2: '′', 0xA3: '≤', 0xA5: '∞', 0xAB: '↔', 0xAC: '←', 0xAD: '↑', 0xAE: '→', 0xAF: '↓', 0xB0: '°', 0xB1: '±',
    0xB2: '″', 0xB3: '≥', 0xB4: '×', 0xB5: '∝', 0xB6: '∂', 0xB7: '•', 0xB8: '÷', 0xB9: '≠', 0xBA: '≡', 0xBB: '≈', 0xBC: '…',
    0xC4: '⊗', 0xC5: '⊕', 0xC6: '∅', 0xC7: '∩', 0xC8: '∪', 0xC9: '⊃', 0xCA: '⊇', 0xCB: '⊄', 0xCC: '⊂', 0xCD: '⊆', 0xCE: '∈',
    0xCF: '∉', 0xD0: '∠', 0xD1: '∇', 0xD5: '∏', 0xD6: '√', 0xD7: '⋅', 0xD8: '¬', 0xD9: '∧', 0xDA: '∨', 0xDB: '⇔', 0xDC: '⇐',
    0xDD: '⇑', 0xDE: '⇒', 0xDF: '⇓', 0xE0: '◊', 0xE1: '〈', 0xE5: '∑', 0xF1: '〉', 0xF2: '∫', 0x22: '∀', 0x24: '∃', 0x27: '∋',
    0x2D: '−', 0x40: '≅', 0x5E: '⊥', 0x60: '‾', 0x7E: '∼' };
  for (const [k, v] of Object.entries(hi)) m[String.fromCharCode(Number(k))] = v;
  return m;
})();

function metafileToSvg(dataUrl) {
  try {
    const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const dv = new DataView(buf.buffer);
    let svg;
    if (dv.getUint32(0, true) === 0x9AC6CDD7) {   // WMF with a placeable header: its size in logical units
      const w = dv.getInt16(10, true) - dv.getInt16(6, true), h = dv.getInt16(12, true) - dv.getInt16(8, true);
      svg = new window.WMFJS.Renderer(buf.buffer).render({ width: `${w}px`, height: `${h}px`, xExt: w, yExt: h, mapMode: 8 });
    } else if (dv.getUint16(0, true) <= 2 && dv.getUint16(2, true) === 9) {   // WMF without that header (Equation Editor): size from SETWINDOWEXT
      let w = 0, h = 0;
      for (let o = 18; o + 6 <= buf.length;) {
        const words = dv.getUint32(o, true), fn = dv.getUint16(o + 4, true);
        if (fn === 0x020C) { h = Math.abs(dv.getInt16(o + 6, true)); w = Math.abs(dv.getInt16(o + 8, true)); break; }
        if (!words || fn === 0) break;
        o += words * 2;
      }
      if (!w || !h) return null;
      svg = new window.WMFJS.Renderer(buf.buffer).render({ width: `${w}px`, height: `${h}px`, xExt: w, yExt: h, mapMode: 8 });
    } else if (dv.getUint32(0, true) === 1 && dv.getUint32(40, true) === 0x464D4520) {   // EMF (" EMF" signature)
      const w = dv.getInt32(16, true) - dv.getInt32(8, true) + 1, h = dv.getInt32(20, true) - dv.getInt32(12, true) + 1;
      svg = new window.EMFJS.Renderer(buf.buffer).render({ width: `${w}px`, height: `${h}px`, wExt: w, hExt: h, xExt: w, yExt: h, mapMode: 8 });
    } else {
      return null;   // a WMF without a placeable header: no size to draw it at
    }
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    for (const t of svg.querySelectorAll('text')) {   // Equation Editor writes maths in the old "Symbol" font
      if (!/symbol/i.test(t.getAttribute('font-family') || '')) continue;
      t.textContent = [...t.textContent].map((c) => SYMBOL_FONT[c] || c).join('');
      t.setAttribute('font-family', 'serif');
    }
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// A slide / page as a picture, for ✨ Ask (drawn through SVG <foreignObject>)
// ---------------------------------------------------------------------
async function snapshot(el, css, scale) {
  const cs = getComputedStyle(el);   // layout size, unaffected by the zoom used to fit the screen
  const w = Math.round(parseFloat(cs.width)) || el.offsetWidth, h = Math.round(parseFloat(cs.height)) || el.offsetHeight;
  const clone = el.cloneNode(true);
  clone.querySelectorAll('.pno').forEach((x) => x.remove());
  clone.style.margin = '0';
  clone.style.boxShadow = 'none';
  const host = el.closest('.office');
  const wrapClass = host?.firstElementChild?.className || '';   // docx-preview's CSS hangs off its wrapper class
  const html = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}">
    <foreignObject x="0" y="0" width="${w}" height="${h}">
      <div xmlns="http://www.w3.org/1999/xhtml" class="${esc(wrapClass)}" style="margin:0;padding:0;background:#fff;width:${w}px;height:${h}px;font-family:sans-serif">
        <style>${(css || '').replace(/<\/style/gi, '')}</style>${html}
      </div>
    </foreignObject></svg>`;
  const img = new Image();
  img.decoding = 'sync';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("Couldn't take a picture of this slide"));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(w * scale), height: Math.round(h * scale) });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}
