/* IETF Atlas Service Worker — 应用外壳 + 数据快照离线可用 */
const VERSION = 'v17';
const SHELL = `atlas-shell-${VERSION}`;
const DATA = `atlas-data-${VERSION}`;
const ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './assets/style.css', './assets/app.js', './assets/auth.js', './assets/db.js', './assets/data.js',
  './assets/kg.js', './assets/view-graph.js', './assets/add-dialog.js',
  './assets/mine.js', './assets/view-lib.js', './assets/view-misc.js', './assets/recover.js',
  './assets/relations.js', './assets/llm.js', './assets/offline.js',
  './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => !k.endsWith(VERSION)).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // 实时回源接口不进缓存，始终走网络
  if (new URL(req.url).pathname.startsWith('/api/')) return;

  // 数据快照：网络优先，失败回退缓存
  if (req.url.includes('/data/')) {
    e.respondWith(
      fetch(req).then(r => {
        const copy = r.clone();
        caches.open(DATA).then(c => c.put(req, copy));
        return r;
      }).catch(() => caches.match(req))
    );
    return;
  }
  // 外壳：网络优先（部署后立刻拿到新代码，不用等下次访问），断网回退缓存
  e.respondWith(
    fetch(req).then(r => {
      if (r && r.ok) {
        const copy = r.clone();
        caches.open(SHELL).then(c => c.put(req, copy));
      }
      return r;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
