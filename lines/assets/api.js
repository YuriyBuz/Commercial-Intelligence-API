/* =====================================================================
   FOODLINE · Лінії — клієнтський API (api.js)
   • налаштування пристрою (localStorage 'fl_lines_v1');
   • транспорт: демо (LocalBackend) або Apps Script — POST text/plain JSON,
     резерв — JSONP GET (автоперемикання, якщо POST блокується; POST перевіряється знову у фоні);
   • постійна черга записів ('fl_lines_queue') з пакетною відправкою, повторами
     та списком відхилених ('fl_lines_rejected');
   • поправка годинника, кеш bootstrap ('fl_lines_boot'), оптимістичний стан ліній.
   Api.call() НІКОЛИ не відхиляє Promise: помилки — це {ok:false, error, message}.
   ===================================================================== */
var Api = (function () {
  'use strict';

  var K = { cfg: 'fl_lines_v1', queue: 'fl_lines_queue', rejected: 'fl_lines_rejected', boot: 'fl_lines_boot',
    skew: 'fl_lines_skew', admin: 'fl_lines_admin', transport: 'fl_lines_transport' };
  /* параметри (можна змінювати в тестах) */
  var opts = { timeout: 30000, writeWait: 4000, batchMax: 20, backoff: [5, 15, 30, 60, 120], jsonpMaxUrl: 7500,
    skewMaxRtt: 30000, skewStaleMs: 6 * 3600000, restampMs: 60000, probeTimeout: 10000, ackKeepMs: 5 * 60000,
    postReprobeMs: 5 * 60000, postReprobeForceMs: 20000 };
  var ACT = LinesCore.ACTIONS;
  var QUEUEABLE = { event: 1, checklist: 1, work: 1, reading: 1 };
  var PERMANENT = { BAD_REQUEST: 1, NOT_FOUND: 1, UNKNOWN_ACTION: 1, ADMIN_REQUIRED: 1 };
  var MSG = {
    NETWORK: 'Немає зв’язку з сервером',
    TIMEOUT: 'Сервер не відповів вчасно',
    BAD_RESPONSE: 'Сервер повернув незрозумілу відповідь',
    NOT_CONFIGURED: 'Пристрій ще не налаштовано',
    TOO_LARGE: 'Запис завеликий для резервного каналу зв’язку — надішлеться, щойно запрацює основний канал',
    STORAGE_FULL: 'Пам’ять браузера на пристрої заповнена — запис не збережено на планшеті. Він надішлеться, лише поки застосунок відкритий',
    HTML: 'Сервер повернув сторінку замість даних — перевірте адресу і доступ до веб-застосунку («Усі, навіть анонімні»)',
    DEV_URL: 'Це тестова адреса (/dev) — вона працює лише для редакторів проєкту. Потрібна адреса, що закінчується на /exec: Розгорнути → Керування розгортаннями.'
  };
  /* тестове розгортання Apps Script (…/dev): анонімний планшет отримує сторінку входу Google замість JSON */
  function isDevUrl(u) { return /^https:\/\/script\.google\.com\/.*\/dev\/?([?#].*)?$/i.test(String(u || '').trim()); }

  function has(o, k) { return o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k); }
  function assign(t) { for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; if (s) for (var k in s) if (has(s, k)) t[k] = s[k]; } return t; }
  function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function err(code, message, extra) { return assign({ ok: false, error: code, message: message || MSG[code] || LinesCore.ERR_MSG[code] || code, client: true }, extra); }
  function lsGet(k, def) { try { var v = window.localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function ssGet(k) { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { if (v === null) window.sessionStorage.removeItem(k); else window.sessionStorage.setItem(k, v); } catch (e) { /* пропуск */ } }
  function newId() { return LinesCore.util.uuid(); }

  /* ------------------------------ події ------------------------------ */
  var hs = {};
  function on(ev, fn) { (hs[ev] || (hs[ev] = [])).push(fn); return function () { off(ev, fn); }; }
  function off(ev, fn) { var a = hs[ev]; if (a) { var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
  function emit(ev, a, b) { (hs[ev] || []).slice().forEach(function (fn) { try { fn(a, b); } catch (e) { console.error(e); } }); }

  /* ------------------------------ налаштування пристрою ------------------------------ */
  var DEF_CFG = { mode: '', endpoint: '', token: '', device: '', pinned_line: '', theme: 'dark', operator: null };
  var cfg = assign({}, DEF_CFG, lsGet(K.cfg, {}));
  function config() { return clone(cfg); }
  function target() {
    if (cfg.mode === 'local') return 'local';
    if (cfg.mode === 'remote' && cfg.endpoint) return 'remote:' + cfg.endpoint;
    return '';
  }
  /* часткове оновлення налаштувань; зміна режиму / адреси / токена скидає транспорт, паузу й кеш */
  function saveConfig(patch) {
    var before = target(), tok = cfg.token;
    assign(cfg, patch || {});
    if (cfg.endpoint) cfg.endpoint = String(cfg.endpoint).trim();
    if (cfg.token) cfg.token = String(cfg.token).trim();
    lsSet(K.cfg, cfg);
    var changed = target() !== before;
    if (changed || cfg.token !== tok) {
      paused = null;
      net.online = null;
      backoffIdx = 0;
      nextAt = 0;
      // поправка годинника — властивість самого пристрою (сервери Google точні): при зміні адреси лишається
      if (changed) { bootMem = null; recentAcks = []; }
      emit('net', netInfo());
      emit('queue', netInfo());
      setTimeout(function () { flush(true); }, 0);
    }
    emit('config', config());
    return config();
  }

  /* ------------------------------ стан мережі ------------------------------ */
  var net = { online: null, last_ok_at: 0, last_error: null };
  var paused = null;        // {code:'BAD_TOKEN', message} — черга зупинена
  /* поправка годинника: найкращий замір {skew, rtt, at} або null — ще не визначено */
  var skewS = loadSkew();
  var skew = skewS ? skewS.skew : 0;
  var skewSavedAt = 0, lastSkewPing = 0;
  function now() { return new Date(Date.now() + (cfg.mode === 'remote' ? skew : 0)); }
  function loadSkew() {
    var v = lsGet(K.skew, null);
    if (typeof v === 'number' && isFinite(v)) return { skew: v, rtt: opts.skewMaxRtt, at: 0 };      // старий формат — число
    return v && typeof v.skew === 'number' && isFinite(v.skew) ? { skew: v.skew, rtt: +v.rtt || opts.skewMaxRtt, at: +v.at || 0 } : null;
  }
  /* замір: server.now відповідає моменту (t0+t1)/2 з точністю ±rtt/2. Повільні відповіді (Apps Script — секунди)
     теж годяться; лишаємо точніший замір, а новий беремо, якщо старий застарів або з ним не узгоджується
     (годинник пристрою перевели). Змінилася поправка — виправляємо автоматичний час записів у черзі */
  function skewSample(serverNow, t0, t1) {
    var sv = Date.parse(serverNow), rtt = t1 - t0;
    if (!serverNow || isNaN(sv) || rtt < 0 || rtt > opts.skewMaxRtt) return;
    var v = sv - (t0 + t1) / 2, b = skewS, n = Date.now();
    if (b && rtt > b.rtt && n - b.at < opts.skewStaleMs && Math.abs(v - b.skew) <= (rtt + b.rtt) / 2 + 1000) return;
    var old = skew;
    skewS = { skew: Math.round(v), rtt: rtt, at: n };
    skew = v;
    if (!b || Math.abs(v - old) > 1000 || n - skewSavedAt > 60000) { skewSavedAt = n; lsSet(K.skew, skewS); }
    if (cfg.mode === 'remote') restamp();
  }
  /* записи з автоматичним часом, поставленим з іншою поправкою (напр., планшет з неточним годинником
     записував офлайн ще до першого зв’язку), — зсунути їхній час на різницю поправок */
  function restamp() {
    var cur = Math.round(skew);
    var off = function (op) { return op.auto_ts && Math.abs(cur - (op.skew || 0)) >= opts.restampMs; };
    if (!loadQueue().some(off)) return;
    mutateQueue(function (q) {
      q.forEach(function (op) {
        if (!off(op)) return;
        var p = op.params || {}, t = Date.parse(p.ts), was = p.ts;
        if (!isNaN(t)) {
          p.ts = new Date(t + cur - (op.skew || 0)).toISOString();
          if (p.then_event && p.then_event.ts === was) p.then_event.ts = p.ts;
        }
        op.skew = cur;
      });
    });
    emit('queue', netInfo());
  }
  /* перед надсиланням записів з автоматичним часом, коли поправка ще невідома (або давня), — пінг, щоб її дізнатися */
  function learnSkew() {
    if (cfg.mode !== 'remote' || (skewS && Date.now() - skewS.at < opts.skewStaleMs) || Date.now() - lastSkewPing < 5 * 60000) return Promise.resolve();
    if (!targetQueue().some(function (op) { return op.auto_ts; })) return Promise.resolve();
    lastSkewPing = Date.now();
    // after() уже взяв замір; без зв’язку — спробувати знову з наступним надсиланням
    return call('ping', {}, { timeout: opts.probeTimeout }).then(function (r) { if (!r || r.client) lastSkewPing = 0; });
  }
  function setOnline(v, e) {
    var was = net.online;
    net.online = v;
    if (v) net.last_ok_at = Date.now();
    if (e) net.last_error = { error: e.error, message: e.message, at: Date.now() };
    if (was !== v) emit('net', netInfo());
  }
  function netInfo() {
    var q = targetQueue();
    return {
      mode: cfg.mode || '', online: cfg.mode === 'local' ? true : net.online, transport: cfg.mode === 'local' ? 'local' : transportFor(cfg.endpoint),
      paused: paused ? assign({}, paused) : null, pending: q.length, pending_other: loadQueue().length - q.length,
      rejected: loadRejected().length, flushing: !!flushing, next_retry_at: nextAt > Date.now() ? nextAt : 0,
      last_ok_at: net.last_ok_at || 0, last_error: net.last_error ? assign({}, net.last_error) : null,
      boot_at: bootMem && bootMem.target === target() ? bootMem.at : 0, skew_ms: cfg.mode === 'remote' ? Math.round(skew) : 0,
      skew_known: cfg.mode === 'remote' ? !!skewS : true, skew_rtt: cfg.mode === 'remote' && skewS ? skewS.rtt : 0,
      storage_full: !!(memQ || memRj)
    };
  }

  /* ------------------------------ транспорт ------------------------------ */
  function transportFor(endpoint) {
    var t = ssGet(K.transport);
    if (!t) return 'post';
    try { var o = JSON.parse(t); return o && o.endpoint === endpoint && o.t === 'jsonp' ? 'jsonp' : 'post'; } catch (e) { return 'post'; }
  }
  function setTransport(endpoint, t) {
    var prev = transportFor(endpoint);
    ssSet(K.transport, t === 'post' ? null : JSON.stringify({ endpoint: endpoint, t: t }));
    if (prev !== t) emit('net', netInfo());
  }
  function parseBody(text, status) {
    var s = String(text || '').trim();
    if (!s) return err('BAD_RESPONSE', MSG.BAD_RESPONSE + (status ? ' (HTTP ' + status + ')' : ''));
    if (s.charAt(0) === '<') return err('BAD_RESPONSE', MSG.HTML);
    try {
      var o = JSON.parse(s);
      if (o && typeof o === 'object' && typeof o.ok === 'boolean') return o;
    } catch (e) { /* далі */ }
    return err('BAD_RESPONSE', MSG.BAD_RESPONSE + (status && status !== 200 ? ' (HTTP ' + status + ')' : ''));
  }
  /* POST text/plain (без CORS-preflight); помилка мережі → reject(TypeError), тайм-аут → reject(AbortError) */
  function post(endpoint, body, timeout) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null;
    var p = fetch(endpoint, {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow', cache: 'no-store', credentials: 'omit', signal: ctl ? ctl.signal : undefined
    }).then(function (res) { return res.text().then(function (t) { return parseBody(t, res.status); }); });
    var guard = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        if (ctl) ctl.abort();
        var e = new Error('timeout'); e.name = 'AbortError'; reject(e);
      }, timeout || opts.timeout);
    });
    return Promise.race([p, guard]).then(function (r) { clearTimeout(timer); return r; }, function (e) { clearTimeout(timer); throw e; });
  }
  var jseq = 0;
  function jsonpUrl(endpoint, body, cb) {
    var payload = assign({}, body);
    delete payload.action; delete payload.token;
    var q = 'action=' + encodeURIComponent(body.action || '') + '&token=' + encodeURIComponent(body.token || '') +
      '&callback=' + cb + '&payload=' + encodeURIComponent(JSON.stringify(payload)) + '&_=' + Date.now().toString(36);
    return endpoint + (endpoint.indexOf('?') >= 0 ? '&' : '?') + q;
  }
  /* JSONP GET: ?action=…&token=…&payload=<JSON>&callback=… → Promise<відповідь> (не відхиляється) */
  function jsonp(endpoint, body, timeout) {
    return new Promise(function (resolve) {
      var cb = '__flj' + Date.now().toString(36) + (++jseq);
      var url = jsonpUrl(endpoint, body, cb);
      if (url.length > opts.jsonpMaxUrl) { resolve(err('TOO_LARGE')); return; }
      var s = document.createElement('script'), done = false;
      var timer = setTimeout(function () { finish(err('TIMEOUT')); }, timeout || opts.timeout);
      function finish(r) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        s.onerror = s.onload = null;
        if (s.parentNode) s.parentNode.removeChild(s);
        window[cb] = function () { /* запізніла відповідь */ };
        setTimeout(function () { try { delete window[cb]; } catch (e) { window[cb] = undefined; } }, 120000);
        resolve(r);
      }
      window[cb] = function (data) { finish(data && typeof data === 'object' && typeof data.ok === 'boolean' ? data : err('BAD_RESPONSE')); };
      s.onerror = function () { finish(err('NETWORK')); };
      s.onload = function () { setTimeout(function () { finish(err('BAD_RESPONSE', MSG.HTML)); }, 0); };
      s.async = true;
      s.src = url;
      (document.head || document.documentElement).appendChild(s);
    });
  }
  var probeCache = {};
  /* чи працює JSONP для цієї адреси (ping), кеш на 60 с */
  function probeJsonp(endpoint, token) {
    var c = probeCache[endpoint];
    if (c && Date.now() - c.at < 60000) return Promise.resolve(c.ok);
    return jsonp(endpoint, { action: 'ping', token: token, device: cfg.device }, opts.probeTimeout).then(function (r) {
      var ok = !!(r && r.ok);
      probeCache[endpoint] = { ok: ok, at: Date.now() };
      return ok;
    });
  }
  /* чи можна безпечно повторити запит іншим каналом (ідемпотентність) */
  function resendable(req) {
    var a = req.action, info = ACT[a] || {};
    if (!info.write || QUEUEABLE[a] || a === 'batch') return true;
    // решта ADMIN-записів ідемпотентні; лише save без id вставив би рядок удруге
    return a !== 'save' || !!(req.row && req.row.id);
  }
  /* резервний JSONP — не назавжди: у фоні (не частіше ніж раз на gap мс, після перезавантаження — одразу)
     перевіряємо POST пінгом; відповів сервер — повертаємося на POST і надсилаємо чергу */
  var lastPostProbe = 0, postProbing = null;
  function reprobePost(endpoint, token, gap) {
    if (postProbing || transportFor(endpoint) !== 'jsonp') return postProbing || Promise.resolve(false);
    if (lastPostProbe && Date.now() - lastPostProbe < gap) return Promise.resolve(false);
    lastPostProbe = Date.now();
    postProbing = post(endpoint, { action: 'ping', token: token, device: cfg.device }, opts.probeTimeout)
      .then(function (r) { return !!(r && !r.client); }, function () { return false; })
      .then(function (ok) {
        postProbing = null;
        if (ok && transportFor(endpoint) === 'jsonp') { setTransport(endpoint, 'post'); setTimeout(function () { flush(true); }, 0); }
        return ok;
      });
    return postProbing;
  }
  function remote(endpoint, token, req, o) {
    var body = assign({}, req, { token: token, device: req.device || cfg.device });
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(err('NETWORK'));
    if (transportFor(endpoint) === 'jsonp') {
      reprobePost(endpoint, token, opts.postReprobeMs);
      return jsonp(endpoint, body, o.timeout).then(function (r) {
        if (!r || r.error !== 'TOO_LARGE') return r;
        // запит задовгий для адреси JSONP — пробуємо основний канал (можливо, POST уже працює)
        return post(endpoint, body, o.timeout).then(function (x) {
          if (x && !x.client) setTransport(endpoint, 'post');
          return x;
        }, function () { return r; });
      });
    }
    return post(endpoint, body, o.timeout).catch(function (e) {
      if (e && e.name === 'AbortError') return err('TIMEOUT');
      // TypeError: мережа або CORS (POST міг і виконатися) — пробуємо резервний JSONP-канал
      return probeJsonp(endpoint, token).then(function (ok) {
        if (!ok) return err('NETWORK');
        setTransport(endpoint, 'jsonp');
        if (!resendable(req)) return err('NETWORK', 'Зв’язок перемкнено на резервний канал — повторіть дію');
        return jsonp(endpoint, body, o.timeout);
      });
    });
  }
  function send(req, o) {
    if (cfg.mode === 'local') {
      if (typeof LocalBackend === 'undefined') return Promise.resolve(err('NOT_CONFIGURED'));
      req.device = req.device || cfg.device;
      return LocalBackend.handle(req).then(function (r) { return r || err('BAD_RESPONSE'); },
        function (e) { return err('SERVER_ERROR', String(e && e.message || e)); });
    }
    if (cfg.mode !== 'remote' || !cfg.endpoint) return Promise.resolve(err('NOT_CONFIGURED'));
    var p = remote(cfg.endpoint, cfg.token, req, o || {});
    if (!isDevUrl(cfg.endpoint)) return p;
    // адреса /dev (налаштовано раніше): помилку зв’язку пояснюємо причиною — анонімному пристрою вона не відповість
    return p.then(function (r) {
      var online = typeof navigator === 'undefined' || navigator.onLine !== false;
      return r && r.client && online && (r.error === 'NETWORK' || r.error === 'BAD_RESPONSE') ? assign({}, r, { message: MSG.DEV_URL }) : r;
    });
  }

  /* ------------------------------ виклик дії ------------------------------ */
  function adminPin() { return ssGet(K.admin) || ''; }
  /* Api.call(action, params, {admin:true, timeout}) → Promise<відповідь>; PIN керівника додається
     автоматично до ADMIN-дій (і до будь-якої дії з {admin:true}) */
  function call(action, params, o) {
    o = o || {};
    var req = assign({}, params || {});
    delete req.admin; delete req.token;
    req.action = action;
    var info = ACT[action] || {};
    if (info.admin || o.admin) { var pin = o.pin !== undefined ? o.pin : adminPin(); if (pin) req.admin = pin; }
    var t0 = Date.now();
    return send(req, o).then(function (r) { return after(action, r, t0); });
  }
  function after(action, r, t0) {
    var t1 = Date.now();
    if (!r || typeof r !== 'object') r = err('BAD_RESPONSE');
    if (cfg.mode === 'remote') {
      var down = r.ok === false && (r.error === 'NETWORK' || r.error === 'TIMEOUT' || r.error === 'BAD_RESPONSE');
      setOnline(!down, r.ok === false ? r : null);
      if (r.now) skewSample(r.now, t0, t1);
    } else if (cfg.mode === 'local') setOnline(true);
    if (r.error === 'BAD_TOKEN') {
      if (!paused) { paused = { code: 'BAD_TOKEN', message: 'Невірний токен доступу — синхронізацію зупинено' }; emit('net', netInfo()); emit('queue', netInfo()); }
    } else if (r.ok && paused && paused.code === 'BAD_TOKEN') {
      paused = null;
      emit('net', netInfo());
      setTimeout(function () { flush(true); }, 0);
    }
    if (r.error === 'ADMIN_REQUIRED' && adminPin()) { ssSet(K.admin, null); emit('admin', { required: true }); }
    return r;
  }

  /* вхід керівника: перевіряє PIN дією admin_check і запам’ятовує його на сеанс (sessionStorage) */
  function adminLogin(pin) {
    return call('admin_check', {}, { pin: String(pin || '') }).then(function (r) {
      if (r.ok) { ssSet(K.admin, String(pin)); emit('admin', { admin: true }); }
      return r;
    });
  }
  function adminLogout() { ssSet(K.admin, null); emit('admin', { admin: false }); }
  function isAdmin() { return !!adminPin(); }

  /* перевірка підключення без збереження налаштувань (майстер) → {ok, transport, version, company, boot, error, message} */
  function testConnection(endpoint, token) {
    endpoint = String(endpoint || '').trim();
    token = String(token || '').trim();
    if (!/^https?:\/\//i.test(endpoint)) return Promise.resolve(err('BAD_REQUEST', 'Вкажіть повну адресу, що починається з https://'));
    if (isDevUrl(endpoint)) return Promise.resolve(err('BAD_REQUEST', MSG.DEV_URL));
    var body = { action: 'ping', token: token, device: cfg.device };
    var tr = 'post', t0 = Date.now();
    var ping = post(endpoint, body, 20000).catch(function (e) {
      if (e && e.name === 'AbortError') return err('TIMEOUT');
      tr = 'jsonp';
      t0 = Date.now();
      return jsonp(endpoint, body, 20000);
    });
    return ping.then(function (p) {
      if (p && p.now) skewSample(p.now, t0, Date.now());
      if (!p.ok) return p;
      var b2 = { action: 'bootstrap', token: token, device: cfg.device }, t1 = Date.now();
      var bs = tr === 'post' ? post(endpoint, b2, 30000).catch(function () { return err('NETWORK'); }) : jsonp(endpoint, b2, 30000);
      return bs.then(function (b) {
        if (b && b.now) skewSample(b.now, t1, Date.now());
        if (!b.ok) return b;
        if (tr === 'jsonp') probeCache[endpoint] = { ok: true, at: Date.now() };
        return { ok: true, transport: tr, version: p.version || b.version, company: (b.settings && b.settings.company) || p.company || '', boot: b };
      });
    }).then(function (r) {
      if (r.ok) setTransport(endpoint, r.transport);
      return r;
    });
  }

  /* ------------------------------ черга записів ------------------------------ */
  /* Черга й відхилені — у localStorage. Сховище переповнене (напр., інший застосунок того ж сайту) → звільняємо
     місце (кеш bootstrap, залишки демо-даних не в демо-режимі) і пробуємо ще раз; не вдалося — тримаємо список
     у пам’яті вкладки (memQ / memRj), попереджаємо (net.storage_full, подія error STORAGE_FULL) і надсилаємо як завжди */
  var memQ = null, memRj = null;
  function freeSpace() {
    var freed = false;
    try {
      var ls = window.localStorage;
      if (ls.getItem(K.boot) !== null) { ls.removeItem(K.boot); freed = true; }          // кеш: завантажиться знову
      var dk = (typeof LocalStore !== 'undefined' && LocalStore.KEY) || 'fl_lines_demo_v1';
      if (cfg.mode !== 'local' && ls.getItem(dk) !== null) { ls.removeItem(dk); freed = true; }
    } catch (e) { /* пропуск */ }
    return freed;
  }
  function persist(k, v) { return lsSet(k, v) || (freeSpace() && lsSet(k, v)); }
  function loadQueue() { if (memQ) return clone(memQ); var q = lsGet(K.queue, []); return Array.isArray(q) ? q : []; }
  /* → true, якщо чергу збережено на пристрої */
  function saveQueue(q) {
    var was = !!memQ;
    if (persist(K.queue, q)) { memQ = null; if (was) emit('net', netInfo()); return true; }
    memQ = clone(q);
    console.warn('Api: не вдалося зберегти чергу записів — вона лише в пам’яті вкладки');
    if (!was) emit('net', netInfo());
    return false;
  }
  function mutateQueue(fn) { var q = loadQueue(); var r = fn(q); saveQueue(q); return r; }
  function loadRejected() { if (memRj) return clone(memRj); var q = lsGet(K.rejected, []); return Array.isArray(q) ? q : []; }
  function saveRejected(list) {
    if (persist(K.rejected, list)) { memRj = null; return true; }
    memRj = clone(list);
    return false;
  }
  function targetQueue() { var t = target(); return loadQueue().filter(function (op) { return op.target === t; }); }

  var waiters = {};
  var flushing = null, backoffIdx = 0, nextAt = 0, retryTimer = null;
  var again = 0;            // запит на надсилання під час активного: 1 — звичайний, 2 — негайний (force)
  var recentAcks = [];

  /* Api.write(action, params, {wait}) — дія оператора (event | checklist | work | reading) через чергу.
     Задає id та ts (з поправкою годинника), якщо їх немає. → Promise:
       {ok:true, queued:false, op, data}  — сервер підтвердив (data — відповідь дії; data.duplicate — повтор);
       {ok:true, queued:true, op}         — збережено в черзі, надішлеться пізніше;
       {ok:false, rejected:true, op, error, message} — сервер відхилив (запис у списку відхилених);
       {ok:false, queued:true, error:'STORAGE_FULL', op, message} — сховище пристрою переповнене: запис лише
         в пам’яті вкладки (надішлеться, поки застосунок відкритий). */
  function write(action, params, o) {
    o = o || {};
    if (!QUEUEABLE[action]) return Promise.resolve(err('BAD_REQUEST', 'Дію «' + action + '» не можна ставити в чергу — використайте Api.call'));
    if (!target()) return Promise.resolve(err('NOT_CONFIGURED'));
    var p = clone(params || {});
    if (!p.id) p.id = newId();
    var autoTs = !p.ts;
    if (autoTs) p.ts = now().toISOString();
    if (action === 'checklist' && p.then_event && typeof p.then_event === 'object' && !p.then_event.id) p.then_event.id = p.id + '-e';
    var op = { op_id: newId(), action: action, params: p, target: target(), queued_at: Date.now(), tries: 0, last_error: null, line_id: p.line_id || '' };
    // час поставлено автоматично (не введено людиною) — його можна виправити, коли поправка годинника зміниться
    if (autoTs) { op.auto_ts = true; op.skew = cfg.mode === 'remote' ? Math.round(skew) : 0; }
    var q = loadQueue();
    q.push(op);
    var stored = saveQueue(q);
    emit('queue', netInfo());
    if (!stored) emit('error', { op: clone(op), error: 'STORAGE_FULL', message: MSG.STORAGE_FULL });
    return new Promise(function (resolve) {
      var w = waiters[op.op_id] = { resolve: resolve, timer: null };
      var wait = o.wait !== undefined ? o.wait : opts.writeWait;
      w.timer = setTimeout(function () {
        settle(op.op_id, stored ? { ok: true, queued: true, op: clone(op) }
          : { ok: false, queued: true, error: 'STORAGE_FULL', message: MSG.STORAGE_FULL, op: clone(op) });
      }, wait);
      flush(true);
    });
  }
  function settle(opId, res) {
    var w = waiters[opId];
    if (!w) return;
    delete waiters[opId];
    clearTimeout(w.timer);
    w.resolve(res);
  }
  function scheduleRetry() {
    var d = opts.backoff[Math.min(backoffIdx, opts.backoff.length - 1)] * 1000;
    backoffIdx++;
    nextAt = Date.now() + d;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () { flush(); }, d + 50);
  }
  function classify(r) {
    if (r && r.ok) return 'ok';
    var e = r && r.error;
    if (e === 'BAD_TOKEN') return 'pause';
    if (PERMANENT[e]) return 'reject';
    if (e === 'TOO_LARGE') return 'defer';       // не блокує чергу: чекає на основний канал
    return 'retry';
  }
  /* операція, завелика для JSONP: поки канал JSONP, її пропускаємо (решта черги йде далі) */
  function isDeferred(op) { return !!(op.last_error && op.last_error.error === 'TOO_LARGE'); }
  function opReq(op) { return assign({ op_id: op.op_id, action: op.action }, op.params); }
  /* пакети: до batchMax операцій; для JSONP — ще й з обмеженням довжини адреси */
  function nextBatch(ops) {
    var out = [];
    var jp = cfg.mode === 'remote' && transportFor(cfg.endpoint) === 'jsonp';
    for (var i = 0; i < ops.length && out.length < opts.batchMax; i++) {
      if (jp && isDeferred(ops[i])) continue;
      if (jp && out.length) {
        var probe = jsonpUrl(cfg.endpoint, { action: 'batch', token: cfg.token, device: cfg.device, ops: out.concat([ops[i]]).map(opReq) }, '__flj0000000000');
        if (probe.length > opts.jsonpMaxUrl - 64) break;
      }
      out.push(ops[i]);
    }
    return out;
  }
  /* надсилання черги (FIFO): Api.flush() — негайно, ігноруючи паузу між повторами.
     Виклик під час активного надсилання запамʼятовується: одразу після нього — ще один прохід
     (запис, доданий «на хвості» попереднього, не чекає страховочного таймера); проміс
     активного надсилання тоді завершується разом із повторним проходом. */
  function flush(force) {
    if (flushing) { again = Math.max(again, force ? 2 : 1); return flushing; }
    if (paused || !target()) return Promise.resolve(netInfo());
    if (!force && Date.now() < nextAt) return Promise.resolve(netInfo());
    if (!targetQueue().length) { backoffIdx = 0; nextAt = 0; return Promise.resolve(netInfo()); }
    // є операції, завеликі для JSONP, — перевірити, чи не запрацював POST (на «Надіслати зараз» — частіше)
    if (cfg.mode === 'remote' && targetQueue().some(isDeferred)) reprobePost(cfg.endpoint, cfg.token, force ? opts.postReprobeForceMs : opts.postReprobeMs);
    var acked = [], bootTouched = false, regroup = 0;
    flushing = learnSkew().then(function loop() {
      var ops = targetQueue();
      if (!ops.length || paused) return Promise.resolve('done');
      var batch = nextBatch(ops);
      if (!batch.length) return Promise.resolve('done');     // лишилися тільки відкладені (завеликі для JSONP)
      emit('queue', netInfo());
      return sendOps(batch).then(function (res) {
        var retry = false, stop = false, again2 = false;
        var byOp = {};
        batch.forEach(function (op) { byOp[op.op_id] = op; });
        var drop = {}, rejected = [], updates = {};
        res.forEach(function (x) {
          var op = byOp[x.op_id];
          if (!op) return;
          var k = x.kind;
          if (k === 'ok') {
            drop[op.op_id] = 1;
            acked.push({ op: op, data: x.data });
            if (applyAck(op, x.data)) bootTouched = true;
          } else if (k === 'reject') {
            drop[op.op_id] = 1;
            rejected.push(assign(clone(op), { error: x.error, message: x.message, rejected_at: Date.now() }));
          } else if (k === 'pause') {
            stop = true;
            updates[op.op_id] = { error: x.error, message: x.message };
          } else if (k === 'defer') {
            updates[op.op_id] = { error: x.error, message: x.message };     // лишається в черзі, решта йде далі
          } else if (k === 'again' && regroup < 3) {
            again2 = true;                                                // пакет переформується (канал став JSONP)
          } else {
            retry = true;
            updates[op.op_id] = { error: x.error, message: x.message };
          }
        });
        if (again2) regroup++;
        mutateQueue(function (q) {
          for (var i = q.length - 1; i >= 0; i--) {
            var op = q[i];
            if (drop[op.op_id]) q.splice(i, 1);
            else if (updates[op.op_id]) { op.tries = (op.tries || 0) + 1; op.last_error = updates[op.op_id]; op.last_try_at = Date.now(); }
          }
        });
        if (rejected.length) saveRejected(loadRejected().concat(rejected).slice(-200));
        acked.splice(0).forEach(function (a) {
          settle(a.op.op_id, { ok: true, queued: false, op: clone(a.op), data: a.data });
          emit('ack', { op: clone(a.op), data: a.data });
        });
        rejected.forEach(function (r) {
          settle(r.op_id, { ok: false, rejected: true, op: r, error: r.error, message: r.message });
          emit('error', { op: r, error: r.error, message: r.message, rejected: true });
        });
        emit('queue', netInfo());
        if (stop) return 'paused';
        if (retry) { scheduleRetry(); return 'retry'; }
        backoffIdx = 0;
        nextAt = 0;
        return loop();
      });
    }).then(function () {
      flushing = null;
      if (bootTouched) persistBoot(true);
      emit('queue', netInfo());
      return rerun();
    }, function (e) {
      flushing = null;
      console.error('Api.flush', e);
      scheduleRetry();
      emit('queue', netInfo());
      return rerun();
    });
    return flushing;
  }
  /* повторний прохід, якщо flush() викликали під час надсилання */
  function rerun() {
    var a = again;
    again = 0;
    return a ? flush(a === 2) : netInfo();
  }
  /* надсилає пакет; → [{op_id, kind:'ok'|'reject'|'retry'|'pause'|'defer'|'again', data, error, message}] */
  function sendOps(batch) {
    return call('batch', { ops: batch.map(opReq) }).then(function (r) {
      if (r && r.ok && Array.isArray(r.results)) {
        var seen = {};
        var out = r.results.map(function (x) {
          seen[x.op_id] = 1;
          var k = classify(x);
          return { op_id: x.op_id, kind: k, data: x.data, error: x.error, message: x.message };
        });
        batch.forEach(function (op) { if (!seen[op.op_id]) out.push({ op_id: op.op_id, kind: 'retry', error: 'BAD_RESPONSE', message: 'Сервер не повернув результат операції' }); });
        return out;
      }
      if (r && (r.error === 'BAD_REQUEST' || r.error === 'UNKNOWN_ACTION')) {
        // сервер не прийняв пакет цілком — надсилаємо операції поодинці
        return batch.reduce(function (pr, op) {
          return pr.then(function (acc) {
            if (acc.stop) { acc.list.push({ op_id: op.op_id, kind: 'retry', error: acc.stop.error, message: acc.stop.message }); return acc; }
            return call(op.action, op.params).then(function (x) {
              var k = classify(x);
              if (k === 'retry' || k === 'pause') acc.stop = x;
              acc.list.push({ op_id: op.op_id, kind: k, data: x.ok ? x : null, error: x.error, message: x.message });
              return acc;
            });
          });
        }, Promise.resolve({ list: [], stop: null })).then(function (acc) { return acc.list; });
      }
      var kind = classify(r);
      if (kind === 'reject') kind = 'retry';
      // пакет складено для POST, а канал тим часом став JSONP — переформувати за довжиною адреси
      if (kind === 'defer' && batch.length > 1) kind = 'again';
      return batch.map(function (op) { return { op_id: op.op_id, kind: kind, error: r.error, message: r.message }; });
    });
  }
  function queue() { return targetQueue().map(clone); }
  function pendingFor(lineId) { return targetQueue().filter(function (op) { return !lineId || op.line_id === lineId; }).map(clone); }
  function rejected() { return loadRejected().map(clone); }
  function retryRejected(opId) {
    var list = loadRejected(), moved = [];
    list = list.filter(function (r) {
      if (opId !== 'all' && r.op_id !== opId) return true;
      moved.push({ op_id: r.op_id, action: r.action, params: r.params, target: r.target || target(), queued_at: Date.now(), tries: 0, last_error: null, line_id: r.line_id || '' });
      return false;
    });
    // спершу в чергу (щоб запис не загубився, якщо місця не вистачить), потім — зі списку відхилених
    if (moved.length) mutateQueue(function (q) { moved.forEach(function (m) { q.push(m); }); });
    saveRejected(list);
    emit('queue', netInfo());
    flush(true);
    return moved.length;
  }
  function discardRejected(opId) {
    var list = loadRejected();
    var keep = opId === 'all' ? [] : list.filter(function (r) { return r.op_id !== opId; });
    saveRejected(keep);
    emit('queue', netInfo());
    return list.length - keep.length;
  }
  /* видалити операцію з черги (напр., для іншого підключення) */
  function discardQueued(opId) {
    var n = mutateQueue(function (q) {
      var before = q.length;
      for (var i = q.length - 1; i >= 0; i--) if (opId === 'other' ? q[i].target !== target() : q[i].op_id === opId) q.splice(i, 1);
      return before - q.length;
    });
    emit('queue', netInfo());
    return n;
  }
  function allQueued() { return loadQueue().map(function (op) { var o = clone(op); o.other_target = op.target !== target(); return o; }); }
  function resume() { paused = null; backoffIdx = 0; nextAt = 0; emit('net', netInfo()); return flush(true); }

  /* ------------------------------ bootstrap і кеш ------------------------------ */
  var bootMem = null, bootInflight = null, bootReqAt = 0, bootNext = null, lastAckAt = 0;
  function cachedBoot() {
    var t = target();
    if (!t) return null;
    if (!bootMem || bootMem.target !== t) {
      var c = lsGet(K.boot, null);
      bootMem = c && c.target === t && c.data ? c : null;
    }
    return bootMem ? bootMem.data : null;
  }
  function persistBoot(emitEv) {
    if (!bootMem) return;
    lsSet(K.boot, bootMem);
    if (emitEv) emit('boot', bootMem.data, { source: 'ack', at: bootMem.at });
  }
  /* свіжий bootstrap → Promise<відповідь>; успіх оновлює кеш і генерує 'boot' */
  function boot() {
    if (bootInflight) {
      if (lastAckAt <= bootReqAt) return bootInflight;
      // після початку цього запиту прийшло підтвердження запису — відповідь може бути застарілою: ще один запит слідом
      if (!bootNext) bootNext = bootInflight.then(function () { bootNext = null; return boot(); });
      return bootNext;
    }
    var reqAt = bootReqAt = Date.now(), t = target();
    bootInflight = call('bootstrap', {}).then(function (r) {
      bootInflight = null;
      if (r && r.ok && target() === t) {
        keepAcks(r, reqAt);
        bootMem = { target: t, at: Date.now(), data: r };
        lsSet(K.boot, bootMem);
        emit('boot', r, { source: 'server', at: bootMem.at });
      }
      return r;
    });
    return bootInflight;
  }
  /* підкласти готовий bootstrap (напр., отриманий майстром) як кеш поточного підключення */
  function primeBoot(data) {
    if (!data || !data.ok || !target()) return;
    bootMem = { target: target(), at: Date.now(), data: data };
    lsSet(K.boot, bootMem);
    emit('boot', data, { source: 'prime', at: bootMem.at });
  }
  /* стан лінії / строк ТО / лічильник із підтвердження → у дані bootstrap b; → чи щось змінилося */
  function mergeAck(b, data) {
    var touched = false;
    if (!b) return false;
    if (data.status && data.status.line_id && b.status && typeof b.status === 'object') { b.status[data.status.line_id] = clone(data.status); touched = true; }
    if (data.due && data.due.rule_id && Array.isArray(b.due)) {
      for (var i = 0; i < b.due.length; i++) if (b.due[i].rule_id === data.due.rule_id) { b.due[i] = clone(data.due); touched = true; }
    }
    if (data.meter && data.meter.id && Array.isArray(b.meters)) {
      b.meters.forEach(function (m) {
        if (m.id !== data.meter.id) return;
        ['value', 'value_ts', 'cur_value', 'cur_ts'].forEach(function (k) { if (has(data.meter, k)) m[k] = data.meter[k]; });
        touched = true;
      });
    }
    return touched;
  }
  /* підтверджений запис одразу оновлює кешований стан лінії / строк ТО / лічильник */
  function applyAck(op, data) {
    if (!data || typeof data !== 'object') return false;
    lastAckAt = Date.now();
    if (data.status || data.due || data.meter) {
      recentAcks.push({ status: data.status || null, due: data.due || null, meter: data.meter || null, at: lastAckAt });
    }
    return mergeAck(cachedBoot(), data);
  }
  /* bootstrap, запитаний ДО отримання підтвердження, може не містити запису — повертаємо в нього стан лінії,
     строк ТО й лічильник із таких підтверджень (інакше щойно виконане ТО знову показалося б простроченим) */
  function keepAcks(r, reqAt) {
    var lim = Date.now() - opts.ackKeepMs;
    recentAcks = recentAcks.filter(function (a) { return a.at >= lim; });
    recentAcks.forEach(function (a) {
      if (a.at <= reqAt) return;
      mergeAck(r, { status: a.status && r.status && has(r.status, a.status.line_id) ? a.status : null, due: a.due, meter: a.meter });
    });
  }

  /* ------------------------------ оптимістичний стан лінії ------------------------------ */
  /* подія черги поверх стану. Позначка — як у ядрі: «без чек-листа» лише для ЗАПУСКУ (перше «Працює» після
     «Не працює»; ctx.ran — чи працювала лінія відтоді), а не для повернення в роботу після налаштування / ремонту */
  function applyEvent(s, e, ctx) {
    var prev = s.state;
    s.state = e.state;
    s.since = e.ts;
    if (e.product) s.product = e.product;
    if (e.operator) s.operator = e.operator;
    if (e.staff_id !== undefined && e.operator) s.staff_id = e.staff_id || '';
    s.reason = e.reason || '';
    s.note = e.note || '';
    s.event_id = e.id || s.event_id;
    var isStart = e.state === 'run' && !ctx.ran;
    if (isStart && ctx.requireStart && !s.start_check_valid) s.flag = 'no_checklist';
    else s.flag = e.forced ? 'forced' : '';
    if (isStart) s.start_uncovered = s.flag === 'no_checklist';
    if (e.state === 'off') {
      s.work_since = null;
      s.start_uncovered = false;
      // чек-лист запуску чинний до завершення роботи: «Не працює» після «Працює» / «Простій»
      // (миття / налаштування / ТО без запуску → «Не працює» його не витрачають — як endsWork у ядрі)
      if (prev !== 'off' && ctx.ran) s.start_check_valid = false;
      ctx.ran = false;
    } else {
      if (prev === 'off' || !s.work_since) s.work_since = e.ts;
      if (e.state === 'run' || e.state === 'stop') ctx.ran = true;
    }
  }
  /* чи працювала лінія після останнього «Не працює» (за статусом bootstrap). Для налаштування / миття / ТО /
     ремонту точно не відомо: якщо цей стан сам почав роботу (since = work_since) — ні, інакше вважаємо, що так */
  function ranSinceOff(s) {
    if (has(s, 'ran_since_off')) return !!s.ran_since_off;
    if (s.state === 'run' || s.state === 'stop') return true;
    if (!s.state || s.state === 'off' || !s.work_since) return false;
    return Date.parse(s.work_since) < Date.parse(s.since);
  }
  /* стан лінії з кешу + незавершені операції черги (FIFO); s.pending = кількість таких операцій */
  function lineStatus(lineId, bootData) {
    var b = bootData || cachedBoot();
    var base = b && b.status && b.status[lineId];
    var s = base ? clone(base) : { line_id: lineId, state: 'off', since: null, product: '', operator: '', staff_id: '', event_id: '', reason: '', note: '', flag: '',
      cum_h: 0, starts: 0, today_h: 0, last_check: null, start_check_valid: false, long_run: false, work_since: null,
      ran_since_off: false, start_uncovered: false };
    s.as_of = b ? b.now : null;
    s.pending = 0;
    var ctx = { ran: ranSinceOff(s), requireStart: !(b && b.settings && b.settings.require_start_checklist === false) };
    targetQueue().forEach(function (op) {
      var p = op.params || {};
      if (p.line_id !== lineId) return;
      if (op.action === 'event') {
        s.pending++;
        applyEvent(s, p, ctx);
      } else if (op.action === 'checklist') {
        s.pending++;
        s.last_check = { id: p.id, ts: p.ts, occasion: p.occasion, result: null, pending: true };
        if (p.occasion === 'start') { s.start_check_valid = true; s.start_uncovered = false; }
        var te = p.then_event;
        if (te && te.state) {
          applyEvent(s, { id: te.id, ts: te.ts || p.ts, state: te.state, product: te.product || p.product, operator: p.operator,
            staff_id: p.staff_id, reason: te.reason, note: te.note, forced: !!p.forced }, ctx);
        }
      }
    });
    return s;
  }
  function dueFor(lineId, bootData) {
    var b = bootData || cachedBoot();
    return b && Array.isArray(b.due) ? b.due.filter(function (d) { return !lineId || d.line_id === lineId; }) : [];
  }

  /* ------------------------------ тригери надсилання ------------------------------ */
  if (typeof window !== 'undefined') {
    window.addEventListener('online', function () { backoffIdx = 0; flush(true); emit('net', netInfo()); });
    window.addEventListener('offline', function () { if (cfg.mode === 'remote') setOnline(false, err('NETWORK')); });
    window.addEventListener('focus', function () { if (targetQueue().length) flush(true); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && targetQueue().length) flush(true); });
    // інша вкладка змінила чергу / налаштування
    window.addEventListener('storage', function (e) {
      if (e.key === K.queue || e.key === K.rejected) emit('queue', netInfo());
      if (e.key === K.cfg) { cfg = assign({}, DEF_CFG, lsGet(K.cfg, {})); emit('config', config()); }
    });
    // страховка: таймери у фонових вкладках пригальмовують
    setInterval(function () { if (!flushing && !paused && Date.now() >= nextAt && targetQueue().length) flush(); }, 15000);
  }

  return {
    options: opts,
    on: on, off: off,
    config: config, saveConfig: saveConfig, target: target,
    call: call, write: write, flush: flush, resume: resume,
    queue: queue, allQueued: allQueued, pendingFor: pendingFor, discardQueued: discardQueued,
    rejected: rejected, retryRejected: retryRejected, discardRejected: discardRejected,
    boot: boot, cachedBoot: cachedBoot, primeBoot: primeBoot,
    lineStatus: lineStatus, dueFor: dueFor,
    net: netInfo, now: now, skew: function () { return cfg.mode === 'remote' ? skew : 0; }, newId: newId,
    adminLogin: adminLogin, adminLogout: adminLogout, isAdmin: isAdmin,
    testConnection: testConnection, isDevUrl: isDevUrl,
    isRead: function (a) { return !!ACT[a] && !ACT[a].write; },
    QUEUEABLE: QUEUEABLE
  };
})();
