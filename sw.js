// Service worker : met l'application en cache pour qu'elle s'ouvre sans réseau.
// Changer VERSION à chaque mise à jour du code pour que les appareils la récupèrent.
const VERSION = 'v1.9.0';
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
  // cache: 'reload' = toujours la dernière version publiée, jamais une copie gardée par le navigateur.
  // Chaque fichier est mis en cache séparément : un fichier manquant sur GitHub ne bloque plus la mise à jour.
  ev.waitUntil(caches.open(CACHE).then(c => Promise.all(ASSETS.map(u =>
    c.add(new Request(u, { cache: 'reload' })).catch(() => console.warn('Fichier absent, non mis en cache :', u))
  ))));
  // Version de rattrapage : s'active tout de suite pour débloquer les iPhone restés sur une ancienne version
  self.skipWaiting();
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
  // Page : toujours celle de cette version (cohérente avec ses styles et scripts en cache).
  // Les nouvelles versions arrivent par la mise à jour du service worker (bandeau « Mettre à jour »).
  if (req.mode === 'navigate') {
    ev.respondWith(caches.match('./index.html').then(hit => hit || fetch(req)));
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
