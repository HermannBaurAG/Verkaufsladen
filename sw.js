// Offline-Speicher: alle Programmdateien beim ersten Laden ablegen, danach ohne Internet starten.
// Nach jeder Änderung an den Programmdateien VERSION erhöhen, damit das Tablet die neue Fassung holt.
const VERSION = 'la-0.2-5';
const DATEIEN = [
  './', 'index.html', 'style.css', 'app.js', 'erkennung.js', 'xlsx-lesen.js', 'manifest.webmanifest',
  'cd/hb-design.css', 'cd/HB-Logo-weiss.png', 'cd/HB-Favicon-32.png', 'cd/HB-Favicon.png', 'cd/app-symbol-192.png', 'cd/app-symbol-512.png',
  'lib/tesseract.min.js', 'lib/worker.min.js', 'lib/tesseract-core-simd-lstm.wasm.js', 'lib/eng.traineddata.gz',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(DATEIEN)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
