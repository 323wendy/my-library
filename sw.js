/* 나만의 서재 — 오프라인 캐시 (앱 껍데기만 저장, books.json은 항상 새로 확인) */
const CACHE = 'shelf-v5';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './core.js',
  './sync.js',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(SHELL.map((url) => cache.add(url).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 공용 서재 데이터는 네트워크 우선 (GitHub에 새 책을 올리면 바로 보이도록)
  if (url.pathname.endsWith('/books.json')) {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./books.json', copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('./books.json'))
    );
    return;
  }

  // 나머지(표지 이미지 포함)는 캐시 우선
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response && response.ok && url.pathname.match(/\.(?:css|js|png|jpg|jpeg|svg|webmanifest|html)$/)) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      });
    })
  );
});
