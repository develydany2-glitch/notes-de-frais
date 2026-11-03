// Service worker : met l'application en cache pour qu'elle s'ouvre sans réseau.
// Changer VERSION à chaque mise à jour du code pour que les appareils la récupèrent.
const VERSION = 'v1.3.0';
const CACHE = `notes-de-frais-${VERSION}`;
const ASSETS = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './app.js', './db.js', './sync.js', './ics.js', './ocr.js',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png', './icon-maskable-512.png',
  './tesseract.min.js', './worker.min.js'
];
// Gros fichiers du lecteur de tickets : gardés d'une version à l'autre
const OCR_CACHE = 'notes-de-frais-lecteur-1';
const OCR_FILES = /tesseract-core-.*\.wasm\.js$|fra\.traineddata\.gz$/;

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', ev => {
  ev.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('notes-de-frais-') && k !== CACHE && k !== OCR_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', ev => { if (ev.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', ev => {
  const req = ev.request;
  const url = new URL(req.url);
  // Les appels à la base cloud ne passent jamais par le cache
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Pages : réseau d'abord (version à jour), cache si hors ligne
  if (req.mode === 'navigate') {
    ev.respondWith(fetch(req).then(r => {
      const copy = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return r;
    }).catch(() => caches.match('./index.html')));
    return;
  }
  // Fichiers de l'app : cache d'abord, instantané même sans réseau
  ev.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const r = await fetch(req);
    if (r.ok) {
      const name = OCR_FILES.test(url.pathname) ? OCR_CACHE : CACHE;
      const copy = r.clone();
      caches.open(name).then(c => c.put(req, copy));
    }
    return r;
  })());
});
