/* =====================================================================
   FOODLINE · Лінії — локальний (демо) режим (local-store.js)
   LocalStore   — MemoryStore ядра, збережений у localStorage ('fl_lines_demo_v1'),
                  із відкладеним записом і захистом від переповнення сховища.
   LocalBackend — «сервер» у браузері: ядро (createApp) над LocalStore,
                  PIN керівника 1234; листи (_notify) лише журналюються як 'preview'.
   Дані демо-режиму живуть ЛИШЕ на цьому пристрої.
   ===================================================================== */
var LocalStore = (function () {
  'use strict';

  var KEY = 'fl_lines_demo_v1';
  var SAVE_DELAY = 400;
  var Mem = LinesCore.MemoryStore;
  var SCHEMA = LinesCore.SCHEMA;
  var ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

  /* JSON зберігає дати рядками — повертаємо Date у колонки типу date (як після seedDemo) */
  function revive(data) {
    Object.keys(data).forEach(function (t) {
      var sc = SCHEMA[t];
      if (!sc || !Array.isArray(data[t])) return;
      var dcols = sc.cols.filter(function (c) { return c.base === 'date'; }).map(function (c) { return c.k; });
      if (!dcols.length) return;
      data[t].forEach(function (r) {
        for (var i = 0; i < dcols.length; i++) {
          var v = r[dcols[i]];
          if (typeof v === 'string' && ISO_RE.test(v)) { var d = new Date(v); if (!isNaN(d.getTime())) r[dcols[i]] = d; }
        }
      });
    });
    return data;
  }

  function LocalStore(key) {
    this.key = key || KEY;
    var saved = null;
    try {
      var raw = window.localStorage.getItem(this.key);
      if (raw) saved = JSON.parse(raw);
    } catch (e) { saved = null; }
    Mem.call(this, saved && saved.data && typeof saved.data === 'object' ? saved.data : null);
    revive(this.data);
    this.savedAt = saved && saved.saved ? saved.saved : null;
    this.createdAt = saved && saved.created ? saved.created : null;
    this.lastError = null;
    this.onError = null;           // fn(error) — викликається, якщо зберегти не вдалося
    this._timer = null;
    this._dirty = false;
  }
  LocalStore.prototype = Object.create(Mem.prototype);
  LocalStore.prototype.constructor = LocalStore;
  LocalStore.KEY = KEY;

  ['insert', 'update', 'replace'].forEach(function (m) {
    LocalStore.prototype[m] = function () {
      var r = Mem.prototype[m].apply(this, arguments);
      this._touch();
      return r;
    };
  });
  LocalStore.prototype._touch = function () {
    var self = this;
    this._dirty = true;
    clearTimeout(this._timer);
    this._timer = setTimeout(function () { self.save(); }, SAVE_DELAY);
  };
  LocalStore.prototype.isEmpty = function () {
    return !(this.data.lines && this.data.lines.length) && !(this.data.settings && this.data.settings.length);
  };
  LocalStore.prototype._write = function () {
    var now = new Date().toISOString();
    if (!this.createdAt) this.createdAt = now;
    window.localStorage.setItem(this.key, JSON.stringify({ v: 1, created: this.createdAt, saved: now, data: this.data }));
    this.savedAt = now;
  };
  /* негайний запис; за переповнення — прибираємо найстаріші записи журналів і пробуємо ще */
  LocalStore.prototype.save = function () {
    clearTimeout(this._timer);
    this._timer = null;
    if (!this._dirty) return true;
    var keepDays = [120, 60, 30, 14];
    for (var i = 0; i <= keepDays.length; i++) {
      try {
        this._write();
        this._dirty = false;
        this.lastError = null;
        return true;
      } catch (e) {
        if (!isQuota(e) || i === keepDays.length) { this._fail(e); return false; }
        this.prune(keepDays[i]);
      }
    }
    return false;
  };
  LocalStore.prototype.saveNow = LocalStore.prototype.save;
  LocalStore.prototype._fail = function (e) {
    this.lastError = e;
    if (typeof this.onError === 'function') { try { this.onError(e); } catch (x) { /* пропуск */ } }
  };
  /* видаляє рядки журналів, старші за days днів (повідомлення й відповіді чек-листів — теж) */
  LocalStore.prototype.prune = function (days) {
    var bound = Date.now() - days * 86400000, n = 0;
    LinesCore.LOG_TABLES.concat(['notices']).forEach(function (t) {
      var rows = this.data[t] || [];
      var keep = rows.filter(function (r) {
        var d = r.ts instanceof Date ? r.ts : new Date(r.ts);
        return isNaN(d.getTime()) || d.getTime() >= bound;
      });
      n += rows.length - keep.length;
      this.data[t] = keep;
    }, this);
    return n;
  };
  LocalStore.prototype.clear = function () {
    var self = this;
    clearTimeout(this._timer);
    this._timer = null;
    LinesCore.TABLES.forEach(function (t) { self.data[t] = []; });
    this._dirty = false;
    this.createdAt = null;
    this.savedAt = null;
    try { window.localStorage.removeItem(this.key); } catch (e) { /* пропуск */ }
  };
  /* приблизний розмір збережених даних, символів */
  LocalStore.prototype.size = function () {
    try { var s = window.localStorage.getItem(this.key); return s ? s.length : 0; } catch (e) { return 0; }
  };
  function isQuota(e) {
    return e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
  }

  return LocalStore;
})();

var LocalBackend = (function () {
  'use strict';

  var ADMIN_PIN = '1234';
  var JOB_EVERY = 3600000;
  var store = null, app = null, ready = null, jobTimer = null, lastSeed = null;

  function createAppFor(s) { return LinesCore.createApp(s, {}); }

  /* ініціалізація (ліниво): завантаження збережених даних або засівання демо; → Promise<{seeded, summary}> */
  function init() {
    if (ready) return ready;
    ready = new Promise(function (resolve, reject) {
      // пауза, щоб інтерфейс встиг показати індикатор (засівання займає до секунди)
      setTimeout(function () {
        try {
          store = new LocalStore();
          var seeded = false;
          if (store.isEmpty()) { lastSeed = LinesCore.seedDemo(store, {}, { now: new Date() }); store.save(); seeded = true; }
          app = createAppFor(store);
          runJobs();
          if (!jobTimer) jobTimer = setInterval(runJobs, JOB_EVERY);
          bindSave();
          resolve({ seeded: seeded, summary: seeded ? lastSeed : null });
        } catch (e) {
          ready = null;
          reject(e);
        }
      }, 30);
    });
    return ready;
  }
  var saveBound = false;
  function bindSave() {
    if (saveBound) return;
    saveBound = true;
    var flush = function () { if (store) store.save(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
  }

  /* _notify із відповіді (і з результатів batch) → журнал «Сповіщення» зі статусом 'preview' */
  function popNotify(res) {
    var out = [];
    if (!res || typeof res !== 'object') return out;
    if (Array.isArray(res._notify)) out = out.concat(res._notify);
    delete res._notify;
    if (Array.isArray(res.results)) {
      res.results.forEach(function (r) {
        if (r && r.data && Array.isArray(r.data._notify)) out = out.concat(r.data._notify);
        if (r && r.data) delete r.data._notify;
      });
    }
    return out;
  }
  function logPreview(list) {
    if (!list.length) return;
    try {
      app.logNotices(list.map(function (n) {
        return { kind: n.kind, key: n.key, to: n.to, subject: n.subject, status: 'preview',
          error: 'Демо-режим: лист не надсилається' };
      }));
    } catch (e) { console.warn('LocalBackend: не вдалося записати сповіщення', e); }
  }
  /* «щогодинна» перевірка строків ТО, як у Server.gs (листи — лише в журнал) */
  function runJobs() {
    if (!app || !store) return;
    try {
      var keys = new Set();
      store.all('notices').forEach(function (r) { var n = LinesCore.norm('notices', r); if (n.key) keys.add(n.key); });
      logPreview(app.dueAlerts(new Date(), keys));
    } catch (e) { console.warn('LocalBackend: перевірка строків ТО', e); }
  }

  /* запит до «сервера» → Promise<відповідь ядра> (ніколи не відхиляється) */
  function handle(req) {
    return init().then(function () {
      var r = {};
      Object.keys(req || {}).forEach(function (k) { r[k] = req[k]; });
      var ctx = { admin: r.admin !== undefined && String(r.admin) === ADMIN_PIN, device: String(r.device || '') };
      delete r.admin;
      delete r.token;
      var info = LinesCore.ACTIONS[r.action] || {};
      var res = info.write ? store.lock(function () { return app.handle(r, ctx); }) : app.handle(r, ctx);
      logPreview(popNotify(res));
      return res;
    }, function (e) {
      return { ok: false, error: 'SERVER_ERROR', message: 'Не вдалося підготувати демо-дані: ' + String(e && e.message || e) };
    });
  }

  /* скинути демо: стерти все й засіяти заново (now = поточний час) → Promise<summary> */
  function resetDemo() {
    return init().then(function () {
      store.clear();
      lastSeed = LinesCore.seedDemo(store, {}, { now: new Date() });
      store._dirty = true;
      store.save();
      app = createAppFor(store);
      runJobs();
      return lastSeed;
    });
  }

  function info() {
    return {
      ready: !!app, admin_pin: ADMIN_PIN, key: LocalStore.KEY,
      created: store ? store.createdAt : null, saved: store ? store.savedAt : null,
      size: store ? store.size() : 0, error: store && store.lastError ? String(store.lastError.message || store.lastError) : null
    };
  }

  return {
    ADMIN_PIN: ADMIN_PIN,
    init: init,
    handle: handle,
    resetDemo: resetDemo,
    info: info,
    runJobs: runJobs,
    get store() { return store; },
    get app() { return app; }
  };
})();
