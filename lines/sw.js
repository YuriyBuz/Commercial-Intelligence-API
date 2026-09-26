/* =====================================================================
   FOODLINE · Лінії — сервіс-воркер (sw.js)
   • власні файли застосунку: спершу мережа, кеш — запасний варіант (офлайн);
   • шрифти Google: спершу кеш (вони версіоновані в URL);
   • НІКОЛИ не кешуємо дані: script.google.com / googleusercontent.com, запити з
     action= / callback= (API, JSONP), службові адреси емулятора /__* та будь-які не-GET (POST) запити;
   • нова версія чекає, доки користувач не натисне «Оновити» (повідомлення skipWaiting);
   • встановлення вдається лише з ПОВНИМ кешем оболонки (без мережі посеред оновлення нова версія
     не встановиться — лишається попередня з повним кешем); старі кеші видаляються лише тоді,
     коли кеш нової версії повний.
   Кеші мають префікс 'fl-lines-' — чужі кеші того ж домену не чіпаємо.
   ===================================================================== */
'use strict';

var VERSION = 'v3';
var PREFIX = 'fl-lines-';
var SHELL = PREFIX + 'shell-' + VERSION;
var FONTS = PREFIX + 'fonts-v1';

var SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/styles.css?v=3',
  './assets/operator.css?v=3',
  './assets/manager.css?v=3',
  './assets/core.js?v=3',
  './assets/local-store.js?v=3',
  './assets/api.js?v=3',
  './assets/ui.js?v=3',
  './assets/app.js?v=3',
  './assets/operator.js?v=3',
  './assets/manager.js?v=3',
  './assets/icons/icon.svg',
  './assets/icons/favicon-32.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/maskable-512.png',
  './assets/icons/apple-touch-icon.png'
];

/* без іконок застосунок працює — їх відсутність не зриває встановлення; решта файлів обовʼязкові */
function optional(u) { return u.indexOf('/icons/') >= 0; }
function required() { return SHELL_FILES.filter(function (u) { return !optional(u); }); }
/* обовʼязкові файли, яких немає в кеші c → Promise<[url]> */
function missing(c) {
  return Promise.all(required().map(function (u) {
    return c.match(new Request(u)).then(function (hit) { return hit ? null : u; });
  })).then(function (l) { return l.filter(Boolean); });
}

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) {
    return Promise.all(SHELL_FILES.map(function (u) {
      return c.add(new Request(u, { cache: 'reload' })).catch(function (err) {
        if (optional(u)) return;                     // іконка — не критично
        throw err;                                   // інакше встановлення не вдається: працює попередня версія
      });
    }));
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) {
    // кеш могли частково витіснити між встановленням і активацією — докачуємо, поки є мережа
    return missing(c).then(function (m) {
      if (!m.length) return [];
      return Promise.all(m.map(function (u) { return c.add(new Request(u, { cache: 'reload' })).catch(function () { /* офлайн */ }); }))
        .then(function () { return missing(c); });
    });
  }).then(function (still) {
    if (still.length) return;                        // новий кеш неповний — старі не чіпаємо (запасний варіант офлайн)
    return caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k.indexOf(PREFIX) === 0 && k !== SHELL && k !== FONTS;
      }).map(function (k) { return caches.delete(k); }));
    });
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('message', function (e) {
  var d = e.data;
  if (d === 'skipWaiting' || (d && d.type === 'skipWaiting')) self.skipWaiting();
});

function isApiHost(h) {
  return /(^|\.)script\.google\.com$/.test(h) || /(^|\.)script\.googleusercontent\.com$/.test(h) || /googleusercontent\.com$/.test(h);
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (x) { return; }
  if (isApiHost(url.hostname)) return;

  // шрифти: спершу кеш
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(function (c) {
      return c.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
          return res;
        }).catch(function () { return Response.error(); });
      });
    }));
    return;
  }

  // лише власні файли в межах застосунку; API-емулятор (action= / callback=) — повз кеш
  if (url.origin !== self.location.origin) return;
  if (req.url.indexOf(self.registration.scope) !== 0) return;
  if (url.searchParams.has('action') || url.searchParams.has('callback')) return;
  if (req.url.slice(self.registration.scope.length).indexOf('__') === 0) return;   // службові адреси емулятора (/__control, /__sheets…) — повз кеш

  // спершу мережа, кеш — запасний варіант
  e.respondWith(fetch(req).then(function (res) {
    if (res && res.ok && res.type === 'basic') {
      var copy = res.clone();
      caches.open(SHELL).then(function (c) { c.put(req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(req).then(function (hit) {
      if (hit) return hit;
      if (req.mode === 'navigate') {
        return caches.match('./index.html').then(function (h) { return h || caches.match('./'); });
      }
      return Response.error();
    });
  }));
});
