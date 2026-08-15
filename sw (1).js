/**
 * Foodline · Комерційний пульт — сервіс-воркер.
 *
 * Стратегія навмисно консервативна: для власних файлів спершу мережа,
 * кеш — лише запасний варіант, коли зв'язку немає. Так оновлення ніколи
 * не «застрягає» у кеші (класична біда GitHub Pages).
 * Шрифти та бібліотеку графіків кешуємо надовго — вони версіоновані в URL.
 */

const VERSION = 'v5';
const SHELL = 'fl-shell-' + VERSION;
const VENDOR = 'fl-vendor-' + VERSION;

const SHELL_FILES = [
  './',
  './index.html',
  './assets/styles.css',
  './assets/app.js',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL)
      .then(c => c.addAll(SHELL_FILES).catch(() => { }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL && k !== VENDOR).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
  if (e.data === 'clearCache') {
    caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
  }
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Дані з Apps Script ніколи не кешуємо — вони приходять через JSONP і мають бути свіжими
  if (url.hostname.indexOf('script.google') >= 0 || url.hostname.indexOf('googleusercontent') >= 0) return;

  // Шрифти та Chart.js: спершу кеш, потім мережа
  if (url.origin !== self.location.origin) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(VENDOR).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // Власні файли: спершу мережа, кеш — запасний варіант
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() =>
      caches.match(req).then(hit => hit || caches.match('./index.html'))
    )
  );
});
