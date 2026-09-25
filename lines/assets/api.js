/* =====================================================================
   FOODLINE · Лінії — клієнтський API (api.js)
   • налаштування пристрою (localStorage 'fl_lines_v1');
   • транспорт: демо (LocalBackend) або Apps Script — POST text/plain JSON,
     резерв — JSONP GET (автоперемикання на весь сеанс, якщо POST блокується);
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
    skewMaxRtt: 3000, probeTimeout: 10000, ackKeepMs: 5 * 60000 };
  var ACT = LinesCore.ACTIONS;
  var QUEUEABLE = { event: 1, checklist: 1, work: 1, reading: 1 };
  var PERMANENT = { BAD_REQUEST: 1, NOT_FOUND: 1, UNKNOWN_ACTION: 1, ADMIN_REQUIRED: 1 };
  var MSG = {
    NETWORK: 'Немає зв’язку з сервером',
    TIMEOUT: 'Сервер не відповів вчасно',
    BAD_RESPONSE: 'Сервер повернув незрозумілу відповідь',
    NOT_CONFIGURED: 'Пристрій ще не налаштовано',
    TOO_LARGE: 'Запис завеликий для резервного каналу зв’язку',
    HTML: 'Сервер повернув сторінку замість даних — перевірте адресу і доступ до веб-застосунку («Усі, навіть анонімні»)'
  };

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
      if (changed) { bootMem = null; recentAcks = []; skew = cfg.mode === 'local' ? 0 : skew; }
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
  var skew = +(lsGet(K.skew, 0)) || 0;
  var skewSavedAt = 0;
  function now() { return new Date(Date.now() + (cfg.mode === 'remote' ? skew : 0)); }
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
      boot_at: bootMem && bootMem.target === target() ? bootMem.at : 0, skew_ms: cfg.mode === 'remote' ? Math.round(skew) : 0
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
  function remote(endpoint, token, req, o) {
    var body = assign({}, req, { token: token, device: req.device || cfg.device });
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(err('NETWORK'));
    if (transportFor(endpoint) === 'jsonp') return jsonp(endpoint, body, o.timeout);
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
    return remote(cfg.endpoint, cfg.token, req, o || {});
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
      if (r.now && t1 - t0 < opts.skewMaxRtt) {
        var sv = Date.parse(r.now);
        if (!isNaN(sv)) {
          skew = sv - (t0 + t1) / 2;
          if (Date.now() - skewSavedAt > 60000) { skewSavedAt = Date.now(); lsSet(K.skew, Math.round(skew)); }
        }
      }
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
    var body = { action: 'ping', token: token, device: cfg.device };
    var tr = 'post';
    var ping = post(endpoint, body, 20000).catch(function (e) {
      if (e && e.name === 'AbortError') return err('TIMEOUT');
      tr = 'jsonp';
      return jsonp(endpoint, body, 20000);
    });
    return ping.then(function (p) {
      if (!p.ok) return p;
      var b2 = { action: 'bootstrap', token: token, device: cfg.device };
      var bs = tr === 'post' ? post(endpoint, b2, 30000).catch(function () { return err('NETWORK'); }) : jsonp(endpoint, b2, 30000);
      return bs.then(function (b) {
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
  function loadQueue() { var q = lsGet(K.queue, []); return Array.isArray(q) ? q : []; }
  function saveQueue(q) {
    if (!lsSet(K.queue, q)) console.warn('Api: не вдалося зберегти чергу записів');
  }
  function mutateQueue(fn) { var q = loadQueue(); var r = fn(q); saveQueue(q); return r; }
  function loadRejected() { var q = lsGet(K.rejected, []); return Array.isArray(q) ? q : []; }
  function targetQueue() { var t = target(); return loadQueue().filter(function (op) { return op.target === t; }); }

  var waiters = {};
  var flushing = null, backoffIdx = 0, nextAt = 0, retryTimer = null;
  var recentAcks = [];

  /* Api.write(action, params, {wait}) — дія оператора (event | checklist | work | reading) через чергу.
     Задає id та ts (з поправкою годинника), якщо їх немає. → Promise:
       {ok:true, queued:false, op, data}  — сервер підтвердив (data — відповідь дії; data.duplicate — повтор);
       {ok:true, queued:true, op}         — збережено в черзі, надішлеться пізніше;
       {ok:false, rejected:true, op, error, message} — сервер відхилив (запис у списку відхилених). */
  function write(action, params, o) {
    o = o || {};
    if (!QUEUEABLE[action]) return Promise.resolve(err('BAD_REQUEST', 'Дію «' + action + '» не можна ставити в чергу — використайте Api.call'));
    if (!target()) return Promise.resolve(err('NOT_CONFIGURED'));
    var p = clone(params || {});
    if (!p.id) p.id = newId();
    if (!p.ts) p.ts = now().toISOString();
    if (action === 'checklist' && p.then_event && typeof p.then_event === 'object' && !p.then_event.id) p.then_event.id = p.id + '-e';
    var op = { op_id: newId(), action: action, params: p, target: target(), queued_at: Date.now(), tries: 0, last_error: null, line_id: p.line_id || '' };
    mutateQueue(function (q) { q.push(op); });
    emit('queue', netInfo());
    return new Promise(function (resolve) {
      var w = waiters[op.op_id] = { resolve: resolve, timer: null };
      var wait = o.wait !== undefined ? o.wait : opts.writeWait;
      w.timer = setTimeout(function () { settle(op.op_id, { ok: true, queued: true, op: clone(op) }); }, wait);
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
    return 'retry';
  }
  function opReq(op) { return assign({ op_id: op.op_id, action: op.action }, op.params); }
  /* пакети: до batchMax операцій; для JSONP — ще й з обмеженням довжини адреси */
  function nextBatch(ops) {
    var out = [];
    var jp = cfg.mode === 'remote' && transportFor(cfg.endpoint) === 'jsonp';
    for (var i = 0; i < ops.length && out.length < opts.batchMax; i++) {
      if (jp && out.length) {
        var probe = jsonpUrl(cfg.endpoint, { action: 'batch', token: cfg.token, device: cfg.device, ops: out.concat([ops[i]]).map(opReq) }, '__flj0000000000');
        if (probe.length > opts.jsonpMaxUrl) break;
      }
      out.push(ops[i]);
    }
    return out;
  }
  /* надсилання черги (FIFO): Api.flush() — негайно, ігноруючи паузу між повторами */
  function flush(force) {
    if (flushing) return flushing;
    if (paused || !target()) return Promise.resolve(netInfo());
    if (!force && Date.now() < nextAt) return Promise.resolve(netInfo());
    if (!targetQueue().length) { backoffIdx = 0; nextAt = 0; return Promise.resolve(netInfo()); }
    var acked = [], bootTouched = false;
    flushing = (function loop() {
      var ops = targetQueue();
      if (!ops.length || paused) return Promise.resolve('done');
      var batch = nextBatch(ops);
      emit('queue', netInfo());
      return sendOps(batch).then(function (res) {
        var retry = false, stop = false;
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
          } else {
            retry = true;
            updates[op.op_id] = { error: x.error, message: x.message };
          }
        });
        mutateQueue(function (q) {
          for (var i = q.length - 1; i >= 0; i--) {
            var op = q[i];
            if (drop[op.op_id]) q.splice(i, 1);
            else if (updates[op.op_id]) { op.tries = (op.tries || 0) + 1; op.last_error = updates[op.op_id]; op.last_try_at = Date.now(); }
          }
        });
        if (rejected.length) {
          var rj = loadRejected().concat(rejected);
          lsSet(K.rejected, rj.slice(-200));
        }
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
    })().then(function () {
      flushing = null;
      if (bootTouched) persistBoot(true);
      emit('queue', netInfo());
      return netInfo();
    }, function (e) {
      flushing = null;
      console.error('Api.flush', e);
      scheduleRetry();
      emit('queue', netInfo());
      return netInfo();
    });
    return flushing;
  }
  /* надсилає пакет; → [{op_id, kind:'ok'|'reject'|'retry'|'pause', data, error, message}] */
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
      return batch.map(function (op) { return { op_id: op.op_id, kind: kind === 'reject' ? 'retry' : kind, error: r.error, message: r.message }; });
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
    lsSet(K.rejected, list);
    if (moved.length) mutateQueue(function (q) { moved.forEach(function (m) { q.push(m); }); });
    emit('queue', netInfo());
    flush(true);
    return moved.length;
  }
  function discardRejected(opId) {
    var list = loadRejected();
    var keep = opId === 'all' ? [] : list.filter(function (r) { return r.op_id !== opId; });
    lsSet(K.rejected, keep);
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
  var bootMem = null, bootInflight = null;
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
    if (bootInflight) return bootInflight;
    var reqAt = Date.now(), t = target();
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
  /* підтверджений запис одразу оновлює кешований стан лінії / строк ТО / лічильник */
  function applyAck(op, data) {
    if (!data || typeof data !== 'object') return false;
    var b = cachedBoot(), touched = false;
    if (data.status && data.status.line_id) {
      recentAcks.push({ line_id: data.status.line_id, status: data.status, at: Date.now() });
      if (b && b.status) { b.status[data.status.line_id] = data.status; touched = true; }
    }
    if (b && data.due && data.due.rule_id && Array.isArray(b.due)) {
      for (var i = 0; i < b.due.length; i++) if (b.due[i].rule_id === data.due.rule_id) { b.due[i] = data.due; touched = true; }
    }
    if (b && data.meter && data.meter.id && Array.isArray(b.meters)) {
      b.meters.forEach(function (m) {
        if (m.id !== data.meter.id) return;
        ['value', 'value_ts', 'cur_value', 'cur_ts'].forEach(function (k) { if (has(data.meter, k)) m[k] = data.meter[k]; });
        touched = true;
      });
    }
    return touched;
  }
  /* bootstrap, запитаний ДО отримання підтвердження, може не містити запису — зберігаємо стан із підтвердження */
  function keepAcks(r, reqAt) {
    var lim = Date.now() - opts.ackKeepMs;
    recentAcks = recentAcks.filter(function (a) { return a.at >= lim; });
    recentAcks.forEach(function (a) { if (a.at > reqAt && r.status && has(r.status, a.line_id)) r.status[a.line_id] = a.status; });
  }

  /* ------------------------------ оптимістичний стан лінії ------------------------------ */
  function applyEvent(s, e) {
    var prev = s.state;
    s.state = e.state;
    s.since = e.ts;
    if (e.product) s.product = e.product;
    if (e.operator) s.operator = e.operator;
    if (e.staff_id !== undefined && e.operator) s.staff_id = e.staff_id || '';
    s.reason = e.reason || '';
    s.note = e.note || '';
    s.event_id = e.id || s.event_id;
    if (e.state === 'run' && prev !== 'run' && prev !== 'stop' && !s.start_check_valid) s.flag = 'no_checklist';
    else s.flag = e.forced ? 'forced' : '';
    if (e.state === 'off') s.work_since = null;
    else if (prev === 'off' || !s.work_since) s.work_since = e.ts;
  }
  /* стан лінії з кешу + незавершені операції черги (FIFO); s.pending = кількість таких операцій */
  function lineStatus(lineId, bootData) {
    var b = bootData || cachedBoot();
    var base = b && b.status && b.status[lineId];
    var s = base ? clone(base) : { line_id: lineId, state: 'off', since: null, product: '', operator: '', staff_id: '', event_id: '', reason: '', note: '', flag: '',
      cum_h: 0, starts: 0, today_h: 0, last_check: null, start_check_valid: false, long_run: false, work_since: null };
    s.as_of = b ? b.now : null;
    s.pending = 0;
    targetQueue().forEach(function (op) {
      var p = op.params || {};
      if (p.line_id !== lineId) return;
      if (op.action === 'event') {
        s.pending++;
        applyEvent(s, p);
      } else if (op.action === 'checklist') {
        s.pending++;
        s.last_check = { id: p.id, ts: p.ts, occasion: p.occasion, result: null, pending: true };
        if (p.occasion === 'start') s.start_check_valid = true;
        var te = p.then_event;
        if (te && te.state) {
          applyEvent(s, { id: te.id, ts: te.ts || p.ts, state: te.state, product: te.product || p.product, operator: p.operator,
            staff_id: p.staff_id, reason: te.reason, note: te.note, forced: !!p.forced });
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
    testConnection: testConnection,
    isRead: function (a) { return !!ACT[a] && !ACT[a].write; },
    QUEUEABLE: QUEUEABLE
  };
})();
