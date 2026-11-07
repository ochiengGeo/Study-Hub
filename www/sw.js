// Service worker: offline support, Android "Share → StudyHub", and notification taps.
// Bump CACHE when you change files.
importScripts('shared.js');

const CACHE = 'studyhub-v25';
const ASSETS = [
  './', 'index.html', 'style.css',
  'shared.js', 'native.js', 'vault.js', 'app.js', 'timetable.js', 'alerts.js', 'files.js', 'office.js', 'examdates.js', 'reminders.js', 'sync.js', 'nearby.js', 'aicards.js', 'exams.js', 'crop.js', 'askai.js', 'nightcards.js', 'main.js',
  'manifest.json', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/capacitor.js', 'vendor/katex/katex.min.js', 'vendor/katex/katex.min.css', 'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js',
  'vendor/office/pptx-preview.umd.js', 'vendor/office/docx-preview.min.js', 'vendor/office/jszip.min.js',
  'vendor/office/WMFJS.bundle.min.js', 'vendor/office/EMFJS.bundle.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(handleShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;

  // Network first (so updates show up straight away), cache when offline / slow.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([fetch(e.request), timeout(4000)]);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      if (e.request.mode === 'navigate') return cache.match('./');
      return Response.error();
    }
  })());
});

// Files / text shared into StudyHub from other apps (Android, installed app only).
async function handleShare(request) {
  const back = (q) => Response.redirect(new URL(`./?${q}`, self.registration.scope).href, 303);
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((f) => f && typeof f !== 'string' && f.size);
    const [classes, deadlines, existing] = await Promise.all([dbAll('classes'), dbAll('deadlines'), dbAll('files')]);
    const known = [...classes.map((c) => c.course), ...deadlines.map((d) => d.course)];
    let n = 0;
    for (const f of files) {
      if (existing.some((x) => x.name === f.name && x.size === f.size)) continue;
      await dbPut('files', makeFileRecord(f, known));
      n++;
    }
    const text = ['title', 'text', 'url'].map((k) => form.get(k)).filter((v) => typeof v === 'string' && v.trim()).join('\n');
    let note = 0;
    if (text && !files.length) {
      await dbPut('notes', { id: uid(), text, created: Date.now(), archived: false });
      note = 1;
    }
    return back(`shared=${n}&note=${note}`);
  } catch {
    return back('shared=error');
  }
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) if ('focus' in c) return c.focus();
    return clients.openWindow('./');
  })());
});
