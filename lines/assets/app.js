/* =====================================================================
   FOODLINE · Лінії — оболонка застосунку (app.js)
   Запуск, маршрутизатор (#/…), верхня панель, майстер і налаштування пристрою,
   оператор зміни, вхід керівника, опитування сервера, головний екран «Лінії».
   Екрани оператора (operator.js) і керівництва (manager.js) лише реєструють
   маршрути через App.route(...). Повний опис — docs/client-api.md.
   ===================================================================== */
var App = (function () {
  'use strict';

  var VERSION = '1.0.0';
  var OPERATOR_TTL = 14 * 3600 * 1000;
  var esc = UI.esc, icon = UI.icon, fmt = UI.fmt;
  var L = LinesCore.LABELS;

  /* ------------------------------ події ------------------------------ */
  var hs = {};
  function on(ev, fn) { (hs[ev] || (hs[ev] = [])).push(fn); return function () { off(ev, fn); }; }
  function off(ev, fn) { var a = hs[ev]; if (a) { var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
  function emit(ev, a, b) { (hs[ev] || []).slice().forEach(function (fn) { try { fn(a, b); } catch (e) { console.error(e); } }); }

  function $(id) { return document.getElementById(id); }
  function assign(t) { for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k]; } return t; }

  /* ------------------------------ дані (bootstrap) ------------------------------ */
  var state = null, idx = emptyIdx(), bootError = null;
  function emptyIdx() { return { line: {}, unit: {}, item: {}, meter: {}, rule: {}, staff: {} }; }
  function setState(data) {
    state = data;
    idx = emptyIdx();
    [['lines', 'line'], ['units', 'unit'], ['items', 'item'], ['meters', 'meter'], ['rules', 'rule'], ['staff', 'staff']].forEach(function (p) {
      (data[p[0]] || []).forEach(function (r) { idx[p[1]][r.id] = r; });
    });
    fmt.setTz(data.settings && data.settings.tz);
  }
  function line(id) { return idx.line[id] || null; }
  function unit(id) { return idx.unit[id] || null; }
  function item(id) { return idx.item[id] || null; }
  function meter(id) { return idx.meter[id] || null; }
  function rule(id) { return idx.rule[id] || null; }
  function staff(id) { return idx.staff[id] || null; }
  function lines() { return state ? (state.lines || []).filter(function (l) { return l.active !== false; }) : []; }
  function byLine(list, lineId) { return (list || []).filter(function (r) { return r.line_id === lineId && r.active !== false; }); }
  function unitsOf(lineId) { return state ? byLine(state.units, lineId) : []; }
  function metersOf(lineId) { return state ? byLine(state.meters, lineId) : []; }
  function rulesOf(lineId) { return state ? byLine(state.rules, lineId) : []; }
  /* пункти чек-листа лінії для occasion (start|changeover|end), як їх оцінює ядро */
  function itemsFor(lineId, occasion) {
    if (!state) return [];
    return byLine(state.items, lineId).filter(function (it) {
      if (occasion && (it.occasions || []).indexOf(occasion) < 0) return false;
      if (it.unit_id) { var u = idx.unit[it.unit_id]; if (!u || u.active === false) return false; }
      return true;
    });
  }
  /* персонал, що може працювати на лінії (line_ids порожній = усі лінії) */
  function staffFor(lineId) {
    if (!state) return [];
    return (state.staff || []).filter(function (s) {
      return s.active !== false && (!lineId || !s.line_ids || !s.line_ids.length || s.line_ids.indexOf(lineId) >= 0);
    });
  }
  function lineStatus(lineId) { return Api.lineStatus(lineId, state); }
  function dueFor(lineId) { return Api.dueFor(lineId, state); }
  function now() { return Api.now(); }
  /* години роботи сьогодні (день заводу) з урахуванням часу після bootstrap (для живого відображення).
     today_h із bootstrap, порахованого вчора (планшет офлайн після півночі), — це вже не «сьогодні». */
  function liveTodayHours(s) {
    if (!s) return 0;
    var t = now().getTime(), today = fmt.dayKey(new Date(t));
    var asOf = tms(s.as_of), sameDay = !isNaN(asOf) && fmt.dayKey(new Date(asOf)) === today;
    var h = sameDay ? (s.today_h || 0) : 0;
    if (s.state === 'run') {
      var since = tms(s.since), from = NaN;
      if (sameDay) from = isNaN(since) ? asOf : Math.max(asOf, since);
      else if (!isNaN(since)) { var d0 = fmt.dayStart(today); from = Math.max(since, d0 ? d0.getTime() : since); }
      if (!isNaN(from) && t > from) h += (t - from) / 3600000;
    }
    return h;
  }
  /* лінія працює без чек-листа запуску — одне правило для плитки, екрана лінії й таблиці керівника:
     запуск цієї роботи позначено «без чек-листа» (або про нього нічого не відомо, а робота почалася недавно —
     у межах checklist_valid_hours) і відтоді чинного чек-листа запуску не пройдено. Звичайна довга зміна
     після чек-листа — НЕ порушення (для неї є попередження long_run). */
  function checkMissing(s) {
    if (!s || (s.state !== 'run' && s.state !== 'stop') || s.start_check_valid) return false;
    var S = (state && state.settings) || {}, validMs = (S.checklist_valid_hours || 12) * 3600000;
    var ws = tms(s.work_since), lc = s.last_check;
    // чек-лист запуску пройдено вже в цій роботі (зокрема пізній) — навіть якщо його строк минув
    if (lc && lc.occasion === 'start' && !isNaN(ws) && tms(lc.ts) >= ws) return false;
    if (s.flag === 'no_checklist') return true;
    // поточна подія й почала цю роботу, і сервер не позначив її — запуск був із чинним чек-листом
    if (!isNaN(ws) && tms(s.since) === ws) return false;
    if (S.require_start_checklist === false || isNaN(ws)) return false;
    return now().getTime() - ws < validMs;
  }
  function mode() { return Api.config().mode || ''; }
  function tms(v) { var d = UI.toDate(v); return d ? d.getTime() : NaN; }

  /* ------------------------------ тема ------------------------------ */
  function applyTheme(t) {
    t = t === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name=theme-color]');
    if (m) m.setAttribute('content', t === 'light' ? '#FFFFFF' : '#12100E');
    return t;
  }
  function setTheme(t) {
    t = applyTheme(t);
    Api.saveConfig({ theme: t });
    emit('theme', t);
  }
  function theme() { return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }

  /* ------------------------------ маршрутизатор ------------------------------ */
  var routes = [], current = null, seq = 0, dirty = false, lastHash = '', viewEl = null, started = false;
  var waitingText = '';
  /* історія: кожен запис позначено номером (history.state.fl) — так відрізняємо «назад» / «вперед» / новий
     перехід. navHash[i] — хеш запису i, відомий у цьому сеансі; histBase — номер запису, з якого сеанс почався. */
  var histIdx = 0, histBase = 0, navHash = [], leaving = false;
  function stateIdx() { var s = history.state; return s && typeof s === 'object' && typeof s.fl === 'number' ? s.fl : null; }
  function stamp(i) {
    var s = history.state && typeof history.state === 'object' ? history.state : {};
    try { history.replaceState(assign({}, s, { fl: i }), ''); } catch (e) { /* пропуск */ }
  }
  function compile(pattern) {
    var keys = [];
    var src = String(pattern || '/').replace(/\/+$/, '') || '/';
    var reSrc = src.replace(/[.+*?^${}()|[\]\\]/g, '\\$&').replace(/\/:([A-Za-z_]\w*)/g, function (_, k) { keys.push(k); return '/([^/]+)'; });
    return { re: new RegExp('^' + reSrc + '/?$'), keys: keys, src: src };
  }
  /* App.route('/line/:id/check/:occasion', handler(params, host, ctx), {boot:false, rerender:false, title}).
     handler може повернути (або Promise з) {onBoot(state, meta), dispose()}. Пізніша реєстрація того ж шаблону замінює попередню. */
  function route(pattern, handler, o) {
    var c = compile(pattern);
    routes = routes.filter(function (r) { return r.src !== c.src; });
    routes.push({ pattern: pattern, src: c.src, re: c.re, keys: c.keys, handler: handler, opts: o || {} });
    if (started && current && !current.m && current.loc && c.re.test(current.loc.path)) render('route');
  }
  function dec(s) { try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (e) { return s; } }
  function parse(hash) {
    var h = String(hash === undefined ? location.hash : hash).replace(/^#/, '');
    if (!h) h = '/';
    if (h.charAt(0) !== '/') h = '/' + h;
    var qi = h.indexOf('?'), path = qi >= 0 ? h.slice(0, qi) : h, query = {};
    if (qi >= 0) h.slice(qi + 1).split('&').forEach(function (kv) { if (!kv) return; var p = kv.split('='); query[dec(p[0])] = dec(p.slice(1).join('=')); });
    return { hash: '#' + h, path: path, query: query };
  }
  /* збіг із найменшою кількістю параметрів (статичний '/m/equipment' важливіший за '/m/:view') */
  function match(path) {
    var best = null;
    for (var i = 0; i < routes.length; i++) {
      var m = routes[i].re.exec(path);
      if (!m || (best && best.r.keys.length < routes[i].keys.length)) continue;
      var params = {};
      routes[i].keys.forEach(function (k, j) { params[k] = dec(m[j + 1]); });
      best = { r: routes[i], params: params };
    }
    return best;
  }
  function disposeCurrent() {
    if (current && current.ctrl && typeof current.ctrl.dispose === 'function') {
      try { current.ctrl.dispose(); } catch (e) { console.error(e); }
    }
  }
  function render(reason) {
    if (!viewEl) return;
    var loc = parse();
    if (!Api.config().mode && loc.path !== '/setup') {
      history.replaceState(history.state, '', '#/setup');
      loc = parse();
    }
    var m = match(loc.path);
    disposeCurrent();
    var token = ++seq;
    dirty = false;
    staleView = false;
    // кожен показ екрана отримує НОВИЙ елемент host: обробники подій на ньому зникають разом зі старим екраном
    var host = document.createElement('div');
    host.className = 'page';
    viewEl.innerHTML = '';
    viewEl.appendChild(host);
    document.body.setAttribute('data-route', m ? m.r.src : '404');
    var ctx = { hash: loc.hash, path: loc.path, query: loc.query, pattern: m ? m.r.pattern : null, params: m ? m.params : {},
      reason: reason, host: host, alive: function () { return token === seq; } };
    var cur = current = { loc: loc, m: m, ctx: ctx, ctrl: null, waiting: false };
    lastHash = loc.hash;
    updateChrome();
    // новий екран під пальцем: другий дотик подвійного тапу не повинен натиснути кнопку на ньому
    if (reason === 'nav') { window.scrollTo(0, 0); UI.armTapGuard(); }
    if (!m) { renderNotFound(host, loc); emit('route', ctx); return; }
    if (m.r.opts.boot !== false && !state) { cur.waiting = true; renderWaiting(host); emit('route', ctx); return; }
    if (m.r.opts.title) setTitle(m.r.opts.title);
    var params = assign({}, loc.query, m.params);
    var res;
    try { res = m.r.handler(params, host, ctx); } catch (e) { console.error(e); if (ctx.alive()) renderCrash(host, e); return; }
    // обробник міг сам перейти деінде (App.go) — тоді цей показ уже неактуальний
    if (res && typeof res.then === 'function') {
      res.then(function (c) { if (ctx.alive()) cur.ctrl = c || null; }, function (e) { console.error(e); if (ctx.alive()) renderCrash(host, e); });
    } else if (ctx.alive()) cur.ctrl = res || null;
    if (ctx.alive()) emit('route', ctx);
  }
  /* перехід: App.go('#/line/L1') або App.go('/line/L1', {replace:true}). Завжди скидає «брудний» стан. */
  function go(hash, o) {
    o = o || {};
    hash = String(hash || '#/');
    if (hash.charAt(0) !== '#') hash = '#' + (hash.charAt(0) === '/' ? '' : '/') + hash;
    dirty = false;
    if (o.replace) {
      history.replaceState(history.state, '', hash);
      navHash[histIdx] = hash;
      render('nav');
    } else if (location.hash === hash) render('nav');
    else location.hash = hash;
  }
  /* назад у межах застосунку; якщо історії цього сеансу немає — на fallback (типово '#/') */
  function back(fallback) {
    if (histIdx > histBase) history.back();
    else go(fallback || '#/', { replace: true });
  }
  /* назад саме на hash: якщо попередній запис історії — він, крок назад; інакше перехід із заміною запису */
  function backTo(hash) {
    hash = String(hash || '#/');
    if (histIdx > histBase && navHash[histIdx - 1] === hash) history.back();
    else go(hash, { replace: true });
  }
  /* хеш попереднього запису історії цього сеансу або '' */
  function prevHash() { return histIdx > histBase ? navHash[histIdx - 1] || '' : ''; }
  function onHashChange() {
    var h = location.hash || '#/';
    var idx = stateIdx();
    if (h === lastHash) { if (idx !== null) histIdx = idx; return; }
    if (dirty && lastHash) {
      // брудний екран: скасовуємо сам перехід, НЕ переписуючи інших записів історії
      var target = h, step = idx === null ? null : idx - histIdx;
      if (step === null) history.back();              // новий запис (посилання): повернутися; запис «уперед» лишиться зайвим
      else if (step) history.go(-step);               // «Назад» / «Вперед» браузера: зробити крок у зворотний бік
      else history.replaceState(history.state, '', lastHash);
      if (leaving) return;                            // питання вже на екрані
      leaving = true;
      UI.confirm({ title: 'Покинути екран?', text: 'Введені дані ще не збережено — їх буде втрачено.', ok: 'Покинути', cancel: 'Залишитися', danger: true })
        .then(function (yes) {
          leaving = false;
          if (!yes) return;
          dirty = false;
          if (step) history.go(step);                 // повторити той самий крок історії
          else location.hash = target;
        });
      return;
    }
    if (idx === null) {                               // новий запис історії: позначаємо, «уперед» більше немає
      idx = histIdx + 1;
      stamp(idx);
      navHash.length = idx;
    }
    histIdx = idx;
    navHash[idx] = h;
    render('nav');
  }
  function setDirty(b) { dirty = !!b; }
  function isDirty() { return dirty; }
  function setTitle(t) { document.title = (t ? t + ' · ' : '') + 'Foodline · Лінії'; }
  function currentCtx() { return current ? current.ctx : null; }
  function currentLineId() {
    if (!current || !current.m) return '';
    var p = current.m.params || {};
    return p.id && /^\/line\//.test(current.m.r.src) ? p.id : (current.loc.query.line || '');
  }

  function renderWaiting(host) {
    if (bootError && !state) {
      host.innerHTML = UI.emptyState({ icon: 'cloudOff', title: 'Не вдалося завантажити дані',
        text: (bootError.message || 'Немає зв’язку з сервером') + '. Збережених на пристрої даних ще немає.' }) +
        '<div class="btn-row" style="justify-content:center"><button type="button" class="btn primary" data-action="retry-boot">' + icon('refresh') +
        '<span>Спробувати ще раз</span></button><a class="btn" href="#/device">' + icon('tablet') + '<span>Налаштування пристрою</span></a></div>';
    } else host.innerHTML = UI.spinner(waitingText || 'Завантаження даних…');
  }
  function renderNotFound(host, loc) {
    setTitle('Не знайдено');
    host.innerHTML = UI.emptyState({ icon: 'alert', title: 'Сторінку не знайдено', text: 'Адреси «' + loc.path + '» у застосунку немає.',
      action: { label: 'До списку ліній', href: '#/' } });
  }
  function renderCrash(host, e) {
    host.innerHTML = UI.emptyState({ icon: 'alert', title: 'На цьому екрані сталася помилка', text: String(e && e.message || e),
      action: { label: 'До списку ліній', href: '#/' } });
  }

  /* нові дані bootstrap: оновити стан, панель і поточний екран (якщо він не «брудний») */
  function onBoot(data, meta) {
    bootError = null;
    setState(data);
    updateChrome();
    emit('boot', data, meta);
    if (!current) return;
    if (current.waiting) { render('boot'); return; }
    if (current.ctrl && typeof current.ctrl.onBoot === 'function') {
      try { current.ctrl.onBoot(data, meta); } catch (e) { console.error(e); }
      return;
    }
    if (dirty || !current.m || current.m.r.opts.rerender === false) return;
    // під відкритим вікном екран не перемальовуємо — зробимо це, щойно вікна закриються
    if (UI.isModalOpen()) { staleView = true; return; }
    rerenderKeepScroll();
  }
  var staleView = false;
  /* кількість записів у черзі змінилася → оптимістичний стан ліній теж: оновити екран, як після bootstrap */
  var lastPending = -1;
  function onQueueChange(n) {
    if (!n || n.pending === lastPending) return;
    lastPending = n.pending;
    if (!state || !current || current.waiting || !current.m) return;
    var c = current.ctrl;
    if (c && typeof c.onQueue === 'function') { try { c.onQueue(n); } catch (e) { console.error(e); } return; }
    if (c && typeof c.onBoot === 'function') { try { c.onBoot(state, { source: 'queue' }); } catch (e) { console.error(e); } return; }
    if (dirty || current.m.r.opts.rerender === false || current.m.r.opts.boot === false) return;
    if (UI.isModalOpen()) { staleView = true; return; }
    rerenderKeepScroll();
  }
  function rerenderKeepScroll() {
    var y = window.scrollY;
    render('boot');
    window.scrollTo(0, y);
  }

  /* ------------------------------ верхня панель ------------------------------ */
  function netView(n) {
    if (!n.mode) return { cls: '', text: '', title: '' };
    if (n.mode === 'local') return { cls: 'n-demo', text: 'Демо', title: 'Демо-режим: дані лише на цьому пристрої' };
    if (n.paused) return { cls: 'n-bad', text: 'Невірний токен', title: n.paused.message };
    if (n.online === false) return { cls: 'n-bad', text: 'Офлайн', title: 'Немає зв’язку з сервером — записи чекають у черзі' };
    if (n.pending) return { cls: 'n-warn', text: n.flushing ? 'Надсилання' : 'У черзі', title: 'Записів у черзі: ' + n.pending };
    if (n.online === null) return { cls: '', text: 'Зв’язок…', title: 'Перевірка зв’язку' };
    return { cls: 'n-ok', text: 'Онлайн', title: 'Зв’язок із сервером є' };
  }
  function updateChrome() {
    var c = Api.config();
    document.body.classList.toggle('no-config', !c.mode);
    var n = Api.net(), v = netView(n), b = $('tbNet');
    if (b) {
      b.className = 'tb-btn tb-net ' + v.cls;
      b.title = v.title;
      b.setAttribute('aria-label', 'Синхронізація: ' + v.text + (n.pending ? ', у черзі ' + n.pending : ''));
      b.innerHTML = '<i class="ndot" aria-hidden="true"></i><span class="lbl">' + esc(v.text) + '</span>' +
        (n.pending && n.mode === 'remote' ? '<span class="cnt">' + n.pending + '</span>' : '') +
        (n.rejected ? '<span class="rej" title="Відхилено сервером">!' + n.rejected + '</span>' : '');
    }
    var op = operator(), ob = $('tbOp');
    if (ob) {
      ob.className = 'tb-btn tb-op ' + (op ? 'set' : 'none');
      ob.innerHTML = icon('user', 20) + '<span class="lbl">' + esc(op ? op.name : 'Хто на зміні?') + '</span>';
      ob.title = op ? 'Оператор: ' + op.name + ' — змінити' : 'Вибрати оператора';
      ob.setAttribute('aria-label', ob.title);
    }
    renderBanners(n);
    tickClock(true);
  }
  var lastClock = '';
  function tickClock(force) {
    var el = $('tbClock');
    if (!el) return;
    var d = now(), t = fmt.time(d);
    if (!force && t === lastClock) return;
    lastClock = t;
    el.innerHTML = '<b>' + esc(t) + '</b><span>' + esc(fmt.weekday(d) + ', ' + fmt.dayMonth(d)) + '</span>';
    el.setAttribute('aria-label', 'Час ' + t);
  }
  var storeError = null;
  function renderBanners(n) {
    var host = $('banners');
    if (!host) return;
    var h = '';
    if (n.paused && n.paused.code === 'BAD_TOKEN') {
      h += '<div class="banner err">' + icon('alert') + '<span class="b-msg"><b>Невірний токен доступу.</b> Записи зберігаються на пристрої, але не надсилаються.</span>' +
        '<a class="btn sm" href="#/device">Налаштування пристрою</a></div>';
    }
    if (n.rejected) {
      h += '<div class="banner warn">' + icon('alert') + '<span class="b-msg">Сервер відхилив ' + n.rejected + ' ' +
        fmt.plural(n.rejected, ['запис', 'записи', 'записів']) + '. Перегляньте й виправте або видаліть.</span>' +
        '<button type="button" class="btn sm" data-action="show-queue">Переглянути</button></div>';
    }
    if (n.storage_full) {
      h += '<div class="banner err">' + icon('alert') + '<span class="b-msg"><b>Пам’ять браузера заповнена.</b> Записи, ще не надіслані на сервер (' + n.pending +
        '), зберігаються лише до закриття застосунку — не закривайте й не оновлюйте його, доки їх не надіслано. Звільніть місце: налаштування браузера → дані сайтів.</span>' +
        '<button type="button" class="btn sm" data-action="show-queue">Черга</button></div>';
    }
    if (storeError) {
      h += '<div class="banner err">' + icon('alert') + '<span class="b-msg">Не вдалося зберегти демо-дані на пристрої: ' + esc(storeError) + '</span></div>';
    }
    if (host.innerHTML !== h) host.innerHTML = h;
  }
  function openMainMenu(btn) {
    var light = theme() === 'light';
    UI.menu(btn, [
      { label: 'Лінії', icon: 'grid', href: '#/' },
      { label: 'Керівництво', icon: 'shield', href: '#/m', sub: Api.isAdmin() ? 'вхід виконано' : 'потрібен PIN керівника' },
      { label: 'Пристрій', icon: 'tablet', href: '#/device', sub: 'підключення, черга, тема' },
      { sep: true },
      { label: light ? 'Темна тема' : 'Світла тема', icon: light ? 'moon' : 'sun', onClick: function () { setTheme(light ? 'dark' : 'light'); } },
      { label: 'Оновити', icon: 'refresh', sub: 'дані й застосунок', onClick: manualRefresh },
      installEvt ? { label: 'Встановити застосунок', icon: 'download', onClick: install } : null,
      Api.isAdmin() ? { label: 'Вийти з режиму керівника', icon: 'logout', onClick: adminLogout } : null
    ], { className: 'main-menu' });
  }
  function manualRefresh() {
    checkSwUpdate();
    Api.flush(true);
    return refresh().then(function (r) {
      if (r.ok) UI.toast('Дані оновлено', { tone: 'ok', ms: 2000 });
      else UI.toast(r.message || 'Не вдалося оновити дані', { tone: 'err' });
      return r;
    });
  }

  /* ------------------------------ оператор зміни ------------------------------ */
  function operator() {
    var o = Api.config().operator;
    if (!o || !o.name) return null;
    if (o.since && Date.now() - Date.parse(o.since) > OPERATOR_TTL) {
      Api.saveConfig({ operator: null });
      setTimeout(function () { emit('operator', null); updateChrome(); }, 0);
      return null;
    }
    return o;
  }
  function setOperator(o) {
    Api.saveConfig({ operator: o || null });
    updateChrome();
    emit('operator', o || null);
  }
  function canWork(op, lineId) {
    if (!op) return false;
    if (!op.staff_id) return true;                   // «інша людина»
    if (!state) return true;
    var s = idx.staff[op.staff_id];
    if (!s || s.active === false) return false;
    return !lineId || !s.line_ids || !s.line_ids.length || s.line_ids.indexOf(lineId) >= 0;
  }
  /* оператор для запису на лінії: чинний і допущений до лінії — одразу; інакше вікно вибору. → Promise<{staff_id,name,role,since}|null> */
  function requireOperator(lineId) {
    var op = operator();
    if (op && canWork(op, lineId)) return Promise.resolve(op);
    return chooseOperator(lineId);
  }
  function initials(name) {
    return String(name || '').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase() || '?';
  }
  /* вікно вибору оператора (завжди показується). → Promise<оператор|null> */
  function chooseOperator(lineId) {
    if (!state) return Promise.resolve(null);
    var cur = operator(), ln = lineId ? line(lineId) : null;
    var all = (state.staff || []).filter(function (s) { return s.active !== false; });
    var own = all.filter(function (s) { return s.line_ids && s.line_ids.length && (!lineId || s.line_ids.indexOf(lineId) >= 0); });
    var common = all.filter(function (s) { return !s.line_ids || !s.line_ids.length; });
    function btn(s) {
      var on = cur && cur.staff_id === s.id;
      return '<button type="button" class="op-btn' + (on ? ' on' : '') + '" data-staff="' + esc(s.id) + '">' +
        '<span class="op-av" aria-hidden="true">' + esc(initials(s.name)) + '</span><span class="op-tx"><b>' + esc(s.name) + '</b><small>' +
        esc(UI.label('role', s.role)) + (s.pin_hash ? ' · PIN' : '') + '</small></span>' + (s.pin_hash ? icon('lock', 18, 'op-lock') : '') + '</button>';
    }
    var body = '<div class="op-pick">' + (ln ? '<p class="op-line">Лінія: <b>' + esc(ln.name) + '</b></p>' : '') +
      (own.length ? '<div class="op-grid">' + own.map(btn).join('') + '</div>' : '') +
      (common.length ? '<div class="section-title">' + (own.length ? 'Наладчики, механіки та інші' : 'Персонал') + '</div><div class="op-grid">' + common.map(btn).join('') + '</div>' : '') +
      (!own.length && !common.length ? '<p class="muted">Список персоналу порожній. Керівник може додати людей у розділі «Персонал».</p>' : '') +
      '<button type="button" class="op-other" data-other>' + icon('plus', 22) + '<span>Інша людина <small>(немає у списку)</small></span></button></div>';
    var m = UI.modal({
      title: 'Хто працює' + (ln ? ' на лінії' : '') + '?', size: 'lg', className: 'modal-operator', body: body,
      actions: [cur ? { label: 'Завершити зміну', icon: 'logout', tone: 'ghost', value: '__out' } : null, { label: 'Скасувати', tone: 'ghost', value: null }]
    });
    UI.delegate(m.body, 'click', '[data-staff]', function (e, b) {
      var s = staff(b.getAttribute('data-staff'));
      if (!s) return;
      var done = function () { var o = { staff_id: s.id, name: s.name, role: s.role, since: new Date().toISOString() }; setOperator(o); m.close(o); };
      if (!s.pin_hash) { done(); return; }
      UI.keypad({ title: s.name, text: 'Введіть свій PIN', mode: 'pin', minLength: 4, maxLength: 8, submitLabel: 'Увійти',
        onSubmit: function (pin) { return LinesCore.pinHash(s.id, pin) === s.pin_hash ? true : 'Невірний PIN'; } })
        .then(function (v) { if (v !== null) done(); });
    });
    UI.delegate(m.body, 'click', '[data-other]', function () {
      UI.prompt({ title: 'Інша людина', label: 'Прізвище та ім’я', placeholder: 'Напр., Петренко Іван', required: true, maxLength: 120, ok: 'Продовжити' })
        .then(function (name) {
          if (!name) return;
          var o = { staff_id: '', name: name, role: '', since: new Date().toISOString() };
          setOperator(o);
          m.close(o);
        });
    });
    return m.result.then(function (v) {
      if (v === '__out') { signOut(); return null; }
      if (v) UI.toast('На зміні: ' + v.name, { tone: 'ok', ms: 2200 });
      return v || null;
    });
  }
  function signOut() {
    if (!Api.config().operator) return;
    setOperator(null);
    UI.toast('Зміну завершено — оператора не вибрано', { tone: 'info', ms: 2500 });
  }

  /* ------------------------------ керівник ------------------------------ */
  /* PIN-вхід до розділу керівництва; запам’ятовується до закриття вкладки. → Promise<boolean> */
  function requireAdmin(o) {
    o = o || {};
    if (Api.isAdmin()) return Promise.resolve(true);
    var local = mode() === 'local';
    return UI.keypad({
      title: o.title || 'Вхід для керівництва', text: o.text || 'Введіть PIN керівника', mode: 'pin', minLength: 4, maxLength: 8,
      hint: local ? 'Демо-режим: PIN керівника — ' + LocalBackend.ADMIN_PIN : '', submitLabel: 'Увійти',
      onSubmit: function (pin) {
        return Api.adminLogin(pin).then(function (r) {
          if (r.ok) return true;
          if (r.error === 'ADMIN_REQUIRED') return 'Невірний PIN керівника';
          if (r.error === 'NETWORK' || r.error === 'TIMEOUT') return 'Немає зв’язку з сервером — вхід неможливий';
          return r.message || 'Не вдалося перевірити PIN';
        });
      }
    }).then(function (v) {
      if (v === null) return false;
      updateChrome();
      emit('admin', true);
      return true;
    });
  }
  function adminLogout() {
    Api.adminLogout();
    emit('admin', false);
    UI.toast('Вихід із режиму керівника', { tone: 'info', ms: 2200 });
    if (current && current.m && /^\/m(\/|$)/.test(current.m.r.src)) go('#/', { replace: true });
  }

  /* ------------------------------ черга синхронізації ------------------------------ */
  /* опис операції черги для людей: {title, sub} */
  function describeOp(op) {
    var p = (op && op.params) || {}, ln = line(p.line_id);
    var where = ln ? ln.name : (p.line_id || '');
    switch (op && op.action) {
      case 'event':
        return { title: 'Стан лінії → ' + UI.stateLabel(p.state) + (p.reason ? ' (' + p.reason + ')' : ''), sub: where };
      case 'checklist':
        return { title: 'Чек-лист: ' + UI.label('occasion', p.occasion) + (p.then_event && p.then_event.state ? ' → ' + UI.stateLabel(p.then_event.state) : ''), sub: where };
      case 'work':
        return { title: 'Робота: ' + (p.title || UI.label('work_type', p.work_type)), sub: where };
      case 'reading': {
        var mt = meter(p.meter_id), ml = mt ? line(mt.line_id) : null;
        return { title: 'Показник: ' + (mt ? mt.name : p.meter_id) + ' = ' + fmt.num(UI.num(p.value), 2) + (mt && mt.unit_label ? ' ' + mt.unit_label : ''), sub: where || (ml ? ml.name : '') };
      }
      default: return { title: String(op && op.action || 'Операція'), sub: where };
    }
  }
  function netSummary(n) {
    if (n.mode === 'local') return { cls: 'info', icon: 'tablet', text: 'Демо-режим: записи зберігаються на цьому пристрої одразу, мережа не потрібна.' };
    if (n.paused) return { cls: 'err', icon: 'alert', text: 'Невірний токен доступу — синхронізацію зупинено. Перевірте токен у налаштуваннях підключення.' };
    if (n.online === false) {
      return { cls: 'warn', icon: 'cloudOff', text: 'Немає зв’язку з сервером. Записи збережено на пристрої — їх буде надіслано автоматично' +
        (n.next_retry_at ? ' (наступна спроба о ' + fmt.time(new Date(n.next_retry_at)) + ')' : '') + '.' };
    }
    var tr = n.transport === 'jsonp' ? ' · резервний канал (JSONP)' : '';
    return { cls: 'ok', icon: 'cloud', text: 'Зв’язок є' + (n.last_ok_at ? ' · останній обмін о ' + fmt.time(new Date(n.last_ok_at)) : '') + tr + '.' };
  }
  function queueHtml() {
    var n = Api.net(), q = Api.allQueued(), rj = Api.rejected(), s = netSummary(n);
    var h = '<div class="box ' + s.cls + '">' + icon(s.icon) + esc(s.text) + '</div>';
    h += '<div class="section-title">У черзі · ' + q.length + '</div>';
    if (!q.length) h += '<div class="list"><div class="list-empty">Усі записи надіслано</div></div>';
    else {
      h += '<div class="list">' + q.map(function (op) {
        var d = describeOp(op);
        // запис, що не надсилається (завеликий для резервного каналу або багато невдалих спроб), можна видалити
        var stuck = !op.other_target && !!op.last_error && (op.last_error.error === 'TOO_LARGE' || (op.tries || 0) >= 3);
        return '<div class="list-item"><div class="li-main"><div class="li-t">' + esc(d.title) + '</div><div class="li-s">' + esc(d.sub) +
          (d.sub ? ' · ' : '') + 'записано ' + esc(fmt.dt(op.params && op.params.ts || op.queued_at)) + (op.tries ? ' · спроб: ' + op.tries : '') +
          (op.other_target ? ' · <b>для іншого підключення</b>' : '') + '</div>' +
          (op.last_error ? '<div class="li-err">' + esc(op.last_error.message || op.last_error.error) + '</div>' : '') + '</div>' +
          (op.other_target || stuck ? '<button type="button" class="btn sm' + (stuck ? ' ghost' : '') + '" data-q="drop" data-id="' + esc(op.op_id) + '"' +
            (stuck ? ' data-cur="1"' : '') + '>Видалити</button>' : '') + '</div>';
      }).join('') + '</div>';
    }
    if (rj.length) {
      h += '<div class="section-title">Відхилено сервером · ' + rj.length + '</div><div class="list">' + rj.slice().reverse().map(function (op) {
        var d = describeOp(op);
        return '<div class="list-item"><div class="li-main"><div class="li-t">' + esc(d.title) + '</div><div class="li-s">' + esc(d.sub) + (d.sub ? ' · ' : '') +
          esc(fmt.dt(op.params && op.params.ts || op.queued_at)) + '</div><div class="li-err">' + esc(op.message || op.error) + '</div></div>' +
          '<div class="btn-row"><button type="button" class="btn sm" data-q="retry" data-id="' + esc(op.op_id) + '">Повторити</button>' +
          '<button type="button" class="btn sm ghost" data-q="discard" data-id="' + esc(op.op_id) + '">Видалити</button></div></div>';
      }).join('') + '</div>' +
        '<div class="btn-row end" style="margin-top:10px"><button type="button" class="btn sm ghost" data-q="discard-all">Видалити всі відхилені</button></div>';
    }
    return h;
  }
  function bindQueue(root) {
    UI.delegate(root, 'click', '[data-q]', function (e, b) {
      var a = b.getAttribute('data-q'), id = b.getAttribute('data-id');
      if (a === 'retry') Api.retryRejected(id);
      else if (a === 'discard') UI.confirm({ title: 'Видалити запис?', text: 'Відхилений запис буде видалено з пристрою без збереження.', ok: 'Видалити', danger: true })
        .then(function (y) { if (y) Api.discardRejected(id); });
      else if (a === 'discard-all') UI.confirm({ title: 'Видалити всі відхилені?', text: 'Усі відхилені записи буде видалено з пристрою.', ok: 'Видалити', danger: true })
        .then(function (y) { if (y) Api.discardRejected('all'); });
      else if (a === 'drop') UI.confirm({ title: 'Видалити запис із черги?', ok: 'Видалити', danger: true,
        text: b.getAttribute('data-cur') ? 'Запис ще не надіслано на сервер — після видалення його буде втрачено. Якщо він потрібен, запишіть його знову (коротше).'
          : 'Запис призначений для іншого підключення й не буде надісланий.' })
        .then(function (y) { if (y) Api.discardQueued(id); });
    });
  }
  /* вікно «Синхронізація»: стан зв’язку, черга, відхилені записи */
  function showQueue() {
    var box = UI.el('div', { class: 'queue-view' });
    box.innerHTML = queueHtml();
    bindQueue(box);
    var m = UI.modal({ title: 'Синхронізація', body: box, size: 'md',
      actions: [{ label: 'Закрити', tone: mode() === 'remote' ? 'ghost' : 'primary', value: null },
        mode() === 'remote' ? { label: 'Надіслати зараз', icon: 'upload', tone: 'primary', onClick: function () { return Api.flush(true).then(function () { return false; }); } } : null] });
    var offQ = Api.on('queue', function () { box.innerHTML = queueHtml(); });
    var offN = Api.on('net', function () { box.innerHTML = queueHtml(); });
    m.result.then(function () { offQ(); offN(); });
    return m;
  }

  /* ------------------------------ оновлення даних ------------------------------ */
  var lastAttempt = 0, pollTimer = null, ackTimer = null;
  /* App.refresh() — надіслати чергу й завантажити свіжий bootstrap → Promise<відповідь> */
  function refresh(o) {
    o = o || {};
    lastAttempt = Date.now();
    if (!o.noFlush) Api.flush();
    return Api.boot().then(function (r) {
      if (!r.ok) {
        bootError = r;
        if (current && current.waiting) render('boot');
        updateChrome();
      }
      return r;
    });
  }
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (document.visibilityState === 'hidden' || !Api.target()) return;
      var sec = (state && state.settings && state.settings.refresh_sec) || 90;
      if (Date.now() - lastAttempt >= sec * 1000) refresh({ noFlush: true });
    }, 5000);
  }
  function onAck() {
    clearTimeout(ackTimer);
    ackTimer = setTimeout(function () { refresh({ noFlush: true }); }, 2000);
  }

  /* ------------------------------ сервіс-воркер ------------------------------ */
  var swWaiting = null, wantReload = false, swReg = null, installEvt = null;
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    var h = location.hostname;
    if (location.protocol !== 'https:' && h !== 'localhost' && h !== '127.0.0.1') return;
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      swReg = reg;
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', function () { if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w); });
      });
    }).catch(function (e) { console.warn('Service worker:', e && e.message || e); });
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (wantReload) { wantReload = false; location.reload(); } });
  }
  function offerUpdate(w) {
    swWaiting = w;
    UI.toast('Доступна нова версія застосунку', { tone: 'info', ms: 0, action: { label: 'Оновити', onClick: applyUpdate } });
  }
  function applyUpdate() {
    if (dirty) { UI.toast('Спершу збережіть або скасуйте введені дані', { tone: 'warn' }); return; }
    if (swWaiting) { wantReload = true; swWaiting.postMessage({ type: 'skipWaiting' }); setTimeout(function () { location.reload(); }, 3000); }
    else location.reload();
  }
  function checkSwUpdate() { if (swReg) swReg.update().catch(function () { /* офлайн */ }); }
  function install() {
    if (!installEvt) return;
    installEvt.prompt();
    installEvt = null;
  }
  function swState() {
    if (!('serviceWorker' in navigator)) return 'не підтримується';
    if (swWaiting) return 'є оновлення';
    if (navigator.serviceWorker.controller) return 'активний (працює офлайн)';
    return swReg ? 'встановлюється' : 'вимкнено';
  }

  /* =====================================================================
     ЕКРАНИ ОБОЛОНКИ: головний (#/), майстер (#/setup), пристрій (#/device)
     ===================================================================== */

  /* ---------- #/ — лінії ---------- */
  function homeView(params, host) {
    setTitle('Лінії');
    var list = lines();
    var S = state.settings || {};
    var n = Api.net();
    var fresh = n.boot_at ? fmt.time(new Date(n.boot_at)) : '';
    var sub = esc(S.company || '') + (fresh ? ' · дані на ' + esc(fresh) + (n.online === false ? ' <span class="c-bad">(офлайн)</span>' : '') : '');
    if (!list.length) {
      host.innerHTML = UI.pageHead({ title: 'Лінії', sub: sub }) + UI.emptyState({ icon: 'grid', title: 'Ліній ще немає',
        text: 'Керівник додає лінії, агрегати, чек-листи й регламент ТО в розділі «Керівництво → Обладнання». Потрібен PIN керівника.',
        action: { label: 'Відкрити керівництво', href: '#/m/equipment' } });
      return;
    }
    var st = {}, byState = {}, dueN = 0, soonN = 0;
    list.forEach(function (l) {
      var s = st[l.id] = lineStatus(l.id);
      byState[s.state] = (byState[s.state] || 0) + 1;
    });
    (state.due || []).forEach(function (d) { if (!line(d.line_id)) return; if (d.status === 'due') dueN++; else if (d.status === 'soon') soonN++; });
    var sum = UI.STATES.filter(function (s) { return byState[s]; }).map(function (s) {
      return '<span class="sum-chip st-' + s + '"><i></i>' + esc(UI.stateLabel(s)) + ' <b>' + byState[s] + '</b></span>';
    }).join('') + (dueN ? '<span class="sum-chip due">' + icon('alert', 18) + 'ТО прострочено <b>' + dueN + '</b></span>' : '') +
      (soonN ? '<span class="sum-chip soon">ТО скоро <b>' + soonN + '</b></span>' : '');
    host.innerHTML = UI.pageHead({ title: 'Лінії', sub: sub, actions: '<div class="home-sum">' + sum + '</div>' }) +
      '<div class="ltiles">' + list.map(function (l) { return lineTile(l, st[l.id]); }).join('') + '</div>';
  }
  function lineTile(l, s) {
    var due = dueFor(l.id), nd = 0, ns = 0;
    due.forEach(function (d) { if (d.status === 'due') nd++; else if (d.status === 'soon') ns++; });
    var S = state.settings || {};
    var kind = [l.kind, l.area].filter(Boolean).join(' · ');
    var badges = [];
    if (nd) badges.push(UI.badge('ТО: ' + nd + ' ' + fmt.plural(nd, ['прострочене', 'прострочені', 'прострочених']), 'due', { icon: 'alert' }));
    if (ns) badges.push(UI.badge('ТО скоро: ' + ns, 'soon', { icon: 'clock' }));
    if (checkMissing(s)) badges.push(UI.badge('без чек-листа', 'bad', { icon: 'checklist' }));
    if (s.long_run) badges.push(UI.badge('понад ' + fmt.num(S.long_run_hours || 16) + ' год без завершення', 'soon'));
    var lc = s.last_check, chk = '<dd class="none">—</dd>';
    if (lc && lc.ts) {
      chk = '<dd>' + esc(UI.label('occasion', lc.occasion)) + ' · ' + esc(fmt.dt(lc.ts)) + ' · ' +
        (lc.result ? '<span class="res r-' + esc(lc.result) + '">' + esc(UI.label('check_result', lc.result).toLowerCase()) + '</span>' : '<span class="dim">надсилається</span>') + '</dd>';
    }
    if (s.pending) badges.push(UI.badge('очікує синхронізації', 'info', { icon: 'refresh' }));
    var reason = (s.state === 'stop' || s.state === 'repair' || s.state === 'maint' || s.state === 'setup') ? [s.reason, s.note].filter(Boolean).join(' — ') : '';
    var today = liveTodayHours(s);
    return '<a class="ltile st-' + esc(s.state) + (s.pending ? ' is-pending' : '') + '" href="#/line/' + encodeURIComponent(l.id) + '" data-line="' + esc(l.id) + '">' +
      '<div class="lt-head"><div class="lt-name">' + (kind ? '<div class="lt-kind">' + esc(kind) + '</div>' : '') + '<h2>' + esc(l.name) + '</h2></div>' +
      '<span class="lt-go">' + icon('next', 26) + '</span></div>' +
      '<div class="lt-status">' + UI.statusPill(s.state, { size: 'lg', pending: !!s.pending }) +
      (s.since ? '<span class="lt-dur" title="Тривалість поточного стану">' + icon('clock', 20) + UI.timer(s.since) + '</span>' : '') +
      (reason ? '<span class="lt-reason">' + esc(reason) + '</span>' : '') + '</div>' +
      '<dl class="lt-meta">' +
      '<dt>Продукт</dt>' + (s.product ? '<dd>' + esc(s.product) + '</dd>' : '<dd class="none">—</dd>') +
      '<dt>Оператор</dt>' + (s.operator ? '<dd>' + esc(s.operator) + '</dd>' : '<dd class="none">—</dd>') +
      '<dt>Сьогодні</dt><dd>' + (today > 0.004 ? esc(fmt.hm(today)) + ' роботи' : '<span class="dim">не працювала</span>') + '</dd>' +
      '<dt>Чек-лист</dt>' + chk +
      '</dl>' + (badges.length ? '<div class="badges">' + badges.join('') + '</div>' : '') + '</a>';
  }

  /* ---------- #/setup — майстер налаштування пристрою ---------- */
  /* налаштований пристрій змінює підключення лише керівник (PIN). Якщо сервер недоступний або токен уже
     невірний, PIN перевірити неможливо — тоді можна продовжити без входу (чинний токен майстер не показує). */
  var setupOpen = false;
  function setupGate(host, onOpen) {
    function draw() {
      var n = Api.net(), down = n.mode === 'remote' && (n.online === false || !!n.paused);
      host.innerHTML = '<div class="wiz"><section class="wiz-card"><h1>Налаштування пристрою</h1>' +
        '<p class="lead">Змінювати підключення цього планшета може лише керівництво — потрібен PIN керівника.</p>' +
        (down ? '<div class="box warn">' + icon('cloudOff') + (n.paused ? 'Сервер не приймає токен цього пристрою' : 'Немає зв’язку з сервером') +
          ', тому PIN перевірити неможливо. Підключення можна змінити й без входу — чинний токен при цьому не показується.</div>' : '') +
        '<div class="wiz-foot"><button type="button" class="btn ghost" data-g="back">' + icon('back') + '<span>Назад</span></button>' +
        '<div class="btn-row">' + (down ? '<button type="button" class="btn" data-g="skip">' + icon('edit') + '<span>Змінити без входу</span></button>' : '') +
        '<button type="button" class="btn primary lg" data-g="login">' + icon('lock') + '<span>Увійти як керівник</span></button></div></div></section></div>';
    }
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-g]');
      if (!b) return;
      var a = b.getAttribute('data-g');
      if (a === 'back') back('#/device');
      else if (a === 'skip') onOpen();
      else requireAdmin({ text: 'Підключення планшета змінює лише керівництво' }).then(function (ok) {
        if (!current || !current.ctx || current.ctx.host !== host) return;
        if (ok) onOpen(); else draw();
      });
    });
    draw();
  }
  function setupView(params, host) {
    setTitle('Налаштування пристрою');
    var c0 = Api.config();
    if (c0.mode && !Api.isAdmin() && !setupOpen) {
      setupGate(host, function () { setupOpen = true; render('refresh'); });
      return;
    }
    setupOpen = false;
    return setupWizard(host);
  }
  function setupWizard(host) {
    var c = Api.config();
    // чинний токен у поле НЕ підставляємо: порожнє поле = «залишити поточний» (лише для тієї самої адреси)
    var keepTok = c.mode === 'remote' && !!c.token;
    var d = { step: 1, mode: c.mode || '', endpoint: c.endpoint || '', token: '', device: c.device || '',
      pinned_line: c.pinned_line || '', theme: theme(), boot: null, test: null, busy: false, demo: null };
    if (c.mode && state) d.boot = state;
    var first = !c.mode;
    /* токен для перевірки / збереження: введений або чинний (та сама адреса) */
    function tokenToUse() { return d.token || (keepTok && d.endpoint === c.endpoint ? c.token : ''); }
    var STEPS = ['Режим', 'Підключення', 'Пристрій'];

    function stepsHtml() {
      return '<ol class="wiz-steps" aria-label="Кроки">' + STEPS.map(function (t, i) {
        var n = i + 1;
        return '<li class="' + (n === d.step ? 'on' : n < d.step ? 'done' : '') + '"' + (n === d.step ? ' aria-current="step"' : '') + '><b>' +
          (n < d.step ? icon('check', 16) : n) + '</b><span>' + esc(t) + '</span></li>';
      }).join('') + '</ol>';
    }
    function foot(backLabel, nextLabel, nextOk) {
      return '<div class="wiz-foot">' + (backLabel ? '<button type="button" class="btn ghost" data-w="back">' + icon('back') + '<span>' + esc(backLabel) + '</span></button>' : '<span></span>') +
        '<button type="button" class="btn primary lg" data-w="next"' + (nextOk ? '' : ' disabled') + '><span>' + esc(nextLabel) + '</span>' + icon('next') + '</button></div>';
    }
    function step1() {
      var other = Api.allQueued().length;
      return '<h1>Налаштування пристрою</h1><p class="lead">Звідки цей планшет братиме дані? Налаштовується один раз; змінити можна пізніше в меню «Пристрій».</p>' +
        '<div class="modes" role="radiogroup" aria-label="Режим роботи">' +
        modeCard('remote', 'cloud', 'Google-таблиця підприємства', 'Спільні дані для всіх планшетів і керівництва. Потрібні адреса веб-застосунку Apps Script і токен доступу.') +
        modeCard('local', 'tablet', 'Демо на цьому пристрої', 'Спробувати застосунок на готових даних соусного заводу. Дані залишаються лише в цьому браузері. PIN керівника — 1234.') +
        '</div>' + (other ? '<div class="box warn" style="margin-top:16px">' + icon('alert') + 'На пристрої є ' + other + ' ' +
        fmt.plural(other, ['ненадісланий запис', 'ненадіслані записи', 'ненадісланих записів']) + ' попереднього підключення. Вони надішлються, коли пристрій знову підключиться до того ж сервера.</div>' : '') +
        foot(first ? '' : 'Скасувати', 'Далі', !!d.mode);
    }
    function modeCard(m, ic, t, text) {
      var on = d.mode === m;
      return '<button type="button" class="modecard' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on + '" data-mode="' + m + '">' +
        '<span class="mc-ic">' + icon(ic, 28) + '</span><h3>' + esc(t) + '</h3><p>' + esc(text) + '</p></button>';
    }
    function step2remote() {
      var t = d.test, res = '';
      if (d.busy) res = UI.spinner('Перевіряємо зв’язок…');
      else if (t && t.ok) {
        var nl = (t.boot.lines || []).length;
        res = '<div class="box ok">' + icon('check') + '<b>Зв’язок є.</b> ' + esc(t.company || 'Сервер') + ' · ' + nl + ' ' + fmt.plural(nl, ['лінія', 'лінії', 'ліній']) +
          ' · версія сервера ' + esc(t.version || '—') + (t.transport === 'jsonp' ? ' · резервний канал (JSONP)' : '') + '</div>';
      } else if (t) res = '<div class="box err">' + icon('alert') + esc(t.message || 'Не вдалося підключитися') + '</div>';
      return '<h1>Підключення до таблиці</h1><p class="lead">Адресу веб-застосунку й токен показує меню таблиці <b>«Облік ліній → Показати токен і PIN»</b>.</p>' +
        UI.field.url({ name: 'endpoint', label: 'Адреса веб-застосунку (/exec)', value: d.endpoint, required: true, placeholder: 'https://script.google.com/macros/s/…/exec', attrs: { spellcheck: 'false', autocapitalize: 'off' } }) +
        UI.field.password({ name: 'token', label: 'Токен доступу', value: d.token, required: !keepTok, autocomplete: 'off',
          placeholder: keepTok ? 'залишити поточний токен' : '24 символи', hint: keepTok ? 'Порожнє поле — залишити чинний токен (для тієї самої адреси).' : '',
          attrs: { spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' } }) +
        '<label class="check wiz-show"><input type="checkbox" data-w="show-token"><span>Показати введене</span></label>' +
        '<div class="btn-row" style="margin-bottom:14px"><button type="button" class="btn" data-w="test"' + (d.busy ? ' disabled' : '') + '>' + icon('wifi') + '<span>Перевірити зв’язок</span></button></div>' +
        '<div class="conn-result" aria-live="polite">' + res + '</div>' + foot('Назад', 'Далі', !!(t && t.ok) && !d.busy);
    }
    function step2local() {
      var r = '';
      if (d.busy) r = UI.spinner('Готуємо демо-дані…');
      else if (d.demo && d.demo.error) r = '<div class="box err">' + icon('alert') + esc(d.demo.error) + '</div>';
      else if (d.boot) {
        var nl = (d.boot.lines || []).length;
        r = '<div class="box ok">' + icon('check') + '<b>Демо-дані готові:</b> ' + nl + ' ' + fmt.plural(nl, ['лінія', 'лінії', 'ліній']) +
          (d.demo && d.demo.seeded ? ', історія за 35 днів' : (d.demo && d.demo.created ? ', збережено ' + esc(fmt.dt(d.demo.created)) : '')) +
          '. PIN керівника — <b class="mono">' + esc(LocalBackend.ADMIN_PIN) + '</b>.</div>' +
          (d.demo && !d.demo.seeded ? '<div class="btn-row" style="margin-top:12px"><button type="button" class="btn sm" data-w="reseed">' + icon('refresh', 18) + '<span>Почати з нових демо-даних</span></button></div>' : '');
      }
      return '<h1>Демо на цьому пристрої</h1><p class="lead">Готові лінії, чек-листи, регламент ТО й історія за останні тижні — щоб спробувати все без підключення.</p>' +
        '<div class="box warn">' + icon('alert') + '<b>Дані залишаються лише на цьому пристрої.</b> Вони не потрапляють у Google-таблицю, не бачать інші планшети, і зникнуть, якщо очистити дані браузера.</div>' +
        '<div class="conn-result" style="margin-top:16px" aria-live="polite">' + r + '</div>' + foot('Назад', 'Далі', !!d.boot && !d.busy);
    }
    function step3() {
      var ls = (d.boot && d.boot.lines || []).filter(function (l) { return l.active !== false; });
      return '<h1>Цей пристрій</h1><p class="lead">Назва допомагає розрізняти записи з різних планшетів; закріплений планшет одразу відкриває свою лінію.</p>' +
        '<div class="form-grid">' +
        UI.field.text({ name: 'device', label: 'Назва пристрою', value: d.device, required: true, placeholder: 'Напр., Планшет лінії 1', maxLength: 60 }) +
        UI.field.select({ name: 'pinned_line', label: 'Закріпити за лінією', value: d.pinned_line,
          options: [{ value: '', label: 'Не закріплювати — усі лінії' }].concat(ls.map(function (l) { return { value: l.id, label: l.name }; })) }) +
        '</div><div class="field"><div class="field-label">Тема оформлення</div>' +
        UI.segmented({ name: 'theme', value: d.theme, options: [{ value: 'dark', label: 'Темна', icon: 'moon' }, { value: 'light', label: 'Світла (яскравий цех)', icon: 'sun' }] }) +
        '</div>' + foot('Назад', 'Почати роботу', true);
    }
    function draw() {
      var b = d.step === 1 ? step1() : d.step === 2 ? (d.mode === 'local' ? step2local() : step2remote()) : step3();
      host.innerHTML = '<div class="wiz">' + stepsHtml() + '<section class="wiz-card">' + b + '</section></div>';
      var f = host.querySelector('.wiz-card input');
      if (f && d.step !== 1 && !d.busy) setTimeout(function () { try { f.focus({ preventScroll: true }); } catch (e) { /* пропуск */ } }, 0);
    }
    function readInputs() {
      var v = UI.readForm(host);
      if (v.endpoint !== undefined) { if (v.endpoint !== d.endpoint || v.token !== d.token) d.test = null; d.endpoint = v.endpoint; d.token = v.token; }
      if (v.device !== undefined) { d.device = v.device; d.pinned_line = v.pinned_line || ''; }
    }
    function test() {
      readInputs();
      var errs = {};
      if (!/^https?:\/\/\S+$/i.test(d.endpoint)) errs.endpoint = 'Вкажіть повну адресу (https://…/exec)';
      // тестове розгортання (/dev) відповідає лише редакторам проєкту — анонімний планшет отримає сторінку входу Google
      else if (Api.isDevUrl(d.endpoint)) errs.endpoint = 'Це тестова адреса (/dev) — вона працює лише для редакторів проєкту. Потрібна адреса, що закінчується на /exec: Розгорнути → Керування розгортаннями.';
      if (!tokenToUse()) errs.token = keepTok ? 'Для нової адреси вкажіть токен' : 'Вкажіть токен';
      if (UI.setErrors(host, errs)) return;
      d.busy = true; d.test = null; draw();
      Api.testConnection(d.endpoint, tokenToUse()).then(function (r) {
        d.busy = false;
        if (r.ok) { d.test = r; d.boot = r.boot; }
        else {
          var msg = r.error === 'BAD_TOKEN' ? 'Сервер відповів, але токен невірний. Перевірте токен у таблиці.' :
            r.error === 'NETWORK' ? 'Немає зв’язку за цією адресою. Перевірте адресу, інтернет і налаштування доступу веб-застосунку.' : (r.message || 'Помилка підключення');
          d.test = { ok: false, message: msg };
        }
        if (current && current.ctx && current.ctx.path === '/setup') draw();
      });
    }
    function prepareDemo(reseed) {
      d.busy = true; d.demo = null; draw();
      var p = LocalBackend.init().then(function (r) {
        if (reseed) return LocalBackend.resetDemo().then(function () { return { seeded: true }; });
        return r;
      });
      p.then(function (r) {
        return LocalBackend.handle({ action: 'bootstrap', device: d.device || 'Демо' }).then(function (b) {
          d.busy = false;
          if (!b.ok) { d.demo = { error: b.message }; draw(); return; }
          d.boot = b;
          d.demo = { seeded: !!(r && r.seeded), created: LocalBackend.info().created };
          draw();
        });
      }, function (e) { d.busy = false; d.demo = { error: 'Не вдалося підготувати демо-дані: ' + (e && e.message || e) }; draw(); });
    }
    function finish() {
      readInputs();
      var errs = {};
      if (!d.device) errs.device = 'Вкажіть назву пристрою';
      if (UI.setErrors(host, errs)) return;
      var before = Api.target();
      var cfgPatch = { mode: d.mode, device: d.device, pinned_line: d.pinned_line, theme: d.theme };
      if (d.mode === 'remote') { cfgPatch.endpoint = d.endpoint; cfgPatch.token = tokenToUse(); }
      Api.saveConfig(cfgPatch);
      if (Api.target() !== before) Api.saveConfig({ operator: null });
      applyTheme(d.theme);
      if (d.boot && Api.target() !== before) Api.primeBoot(d.boot);
      startServices();
      UI.toast(first ? 'Пристрій налаштовано' : 'Налаштування збережено', { tone: 'ok' });
      go(d.pinned_line ? '#/line/' + encodeURIComponent(d.pinned_line) : '#/', { replace: true });
    }
    host.addEventListener('click', function (e) {
      if (e.target.closest('[data-w="show-token"]')) {
        var ti = host.querySelector('input[name=token]');
        if (ti) ti.type = e.target.closest('[data-w="show-token"]').checked ? 'text' : 'password';
        return;
      }
      var mc = e.target.closest('[data-mode]');
      if (mc) {
        if (d.mode !== mc.getAttribute('data-mode')) { d.mode = mc.getAttribute('data-mode'); d.boot = null; d.test = null; d.demo = null; }
        draw();
        return;
      }
      var b = e.target.closest('[data-w]');
      if (!b || b.disabled) return;
      var a = b.getAttribute('data-w');
      if (a === 'test') test();
      else if (a === 'reseed') {
        UI.confirm({ title: 'Почати з нових демо-даних?', text: 'Усі зміни в демо-даних на цьому пристрої буде стерто.', ok: 'Стерти й створити заново', danger: true })
          .then(function (y) { if (y) prepareDemo(true); });
      } else if (a === 'back') {
        if (d.step === 1) { back('#/'); return; }
        readInputs(); d.step--; draw();
      } else if (a === 'next') {
        readInputs();
        if (d.step === 1) {
          d.step = 2;
          if (d.mode === 'local' && !d.boot) prepareDemo(false); else draw();
        } else if (d.step === 2) { d.step = 3; draw(); }
        else finish();
      }
    });
    host.addEventListener('change', function (e) {
      if (e.detail && e.detail.name === 'theme') { d.theme = e.detail.value; applyTheme(d.theme); }
    });
    host.addEventListener('input', function (e) {
      if (e.target && (e.target.name === 'endpoint' || e.target.name === 'token') && d.test) {
        d.test = null;
        var r = host.querySelector('.conn-result'); if (r) r.innerHTML = '';
        var nb = host.querySelector('[data-w=next]'); if (nb) nb.disabled = true;
      }
    });
    host.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.name === 'token') { e.preventDefault(); test(); }
    });
    draw();
    return { dispose: function () { applyTheme(Api.config().theme); } };
  }

  /* ---------- #/device — налаштування пристрою ---------- */
  function deviceView(params, host) {
    setTitle('Пристрій');
    var c = Api.config();
    var ls = lines();
    if (c.pinned_line && !line(c.pinned_line)) ls = ls.concat([{ id: c.pinned_line, name: c.pinned_line + ' (не знайдено)' }]);
    function connHtml() {
      var n = Api.net(), cc = Api.config();
      if (cc.mode === 'local') {
        var li = LocalBackend.info();
        return UI.kv([['Режим', 'Демо на цьому пристрої'], ['PIN керівника', '<b class="mono">' + esc(LocalBackend.ADMIN_PIN) + '</b>'],
          ['Дані створено', li.created ? esc(fmt.datetime(li.created)) : '—'], ['Обсяг', li.size ? esc(fmt.num(li.size / 1024, 0)) + ' КБ' : '—']]) +
          '<div class="box warn" style="margin-top:14px">' + icon('alert') + 'Дані демо-режиму зберігаються лише в цьому браузері.</div>' +
          '<div class="btn-row" style="margin-top:14px"><button type="button" class="btn" data-d="reset">' + icon('refresh') + '<span>Скинути демо-дані</span></button>' +
          '<a class="btn" href="#/setup">' + icon('cloud') + '<span>Підключити таблицю</span></a></div>';
      }
      var ep = cc.endpoint || '', tok = cc.token || '';
      var shortEp = ep.length > 58 ? ep.slice(0, 40) + '…' + ep.slice(-14) : ep;
      return UI.kv([['Режим', 'Google-таблиця (Apps Script)'], ['Адреса', '<span class="mono small" title="' + esc(ep) + '">' + esc(shortEp) + '</span>'],
        ['Токен', '<span class="mono">' + (tok ? '••••' + esc(tok.slice(-4)) : '—') + '</span>'],
        ['Канал', n.transport === 'jsonp' ? 'резервний (JSONP GET)' : 'основний (POST)'],
        ['Останній обмін', n.last_ok_at ? esc(fmt.dt(new Date(n.last_ok_at))) : '—'],
        ['Годинник', clockText(n)]]) +
        (Api.isDevUrl(ep) ? '<div class="box err" style="margin-top:12px">' + icon('alert') + '<b>Це тестова адреса (/dev)</b> — вона працює лише для редакторів проєкту. ' +
          'Вкажіть адресу, що закінчується на <b>/exec</b> (Розгорнути → Керування розгортаннями): «Змінити підключення».</div>' : '') +
        '<div class="conn-result" style="margin-top:12px" aria-live="polite"></div>' +
        '<div class="btn-row" style="margin-top:12px"><button type="button" class="btn" data-d="ping">' + icon('wifi') + '<span>Перевірити зв’язок</span></button>' +
        '<a class="btn" href="#/setup">' + icon('edit') + '<span>Змінити підключення</span></a></div>';
    }
    /* годинник пристрою порівняно з сервером: «невідомо», доки не було жодного заміру */
    function clockText(n) {
      if (!n.skew_known) return '<span class="dim">ще не звірено із сервером</span>';
      var tol = Math.max(1500, (n.skew_rtt || 0) / 2);
      if (Math.abs(n.skew_ms) < tol) return 'збігається із сервером';
      return 'поправка ' + (n.skew_ms > 0 ? '+' : '−') + esc(fmt.duration(Math.round(Math.abs(n.skew_ms) / 1000) * 1000, { seconds: true })) +
        (n.skew_rtt > 3000 ? ' <span class="dim">(±' + Math.round(n.skew_rtt / 2000) + ' с)</span>' : '');
    }
    function aboutHtml() {
      var S = state && state.settings || {};
      return UI.kv([['Застосунок', 'v' + esc(VERSION) + ' · ядро v' + esc(LinesCore.VERSION)], ['Сервер', state ? 'v' + esc(state.version || '—') : '—'],
        ['Підприємство', esc(S.company || '—')], ['Часовий пояс', esc(S.tz || '—')],
        ['Офлайн-режим', esc(swState())], ['Керівник', Api.isAdmin() ? 'вхід виконано' : 'не виконано']]) +
        '<div class="btn-row" style="margin-top:14px"><button type="button" class="btn" data-d="update">' + icon('download') + '<span>Оновити застосунок</span></button>' +
        (Api.isAdmin() ? '<button type="button" class="btn ghost" data-d="admin-out">' + icon('logout') + '<span>Вийти з режиму керівника</span></button>' : '') + '</div>';
    }
    host.innerHTML = UI.pageHead({ title: 'Налаштування пристрою', kicker: 'Пристрій', back: '#/' }) +
      '<div class="dev-grid">' +
      '<section class="card"><div class="card-head">' + icon('tablet', 20) + 'Цей пристрій</div><div class="card-body" id="devForm">' +
      UI.field.text({ name: 'device', label: 'Назва пристрою', value: c.device, required: true, maxLength: 60, placeholder: 'Напр., Планшет лінії 1' }) +
      UI.field.select({ name: 'pinned_line', label: 'Закріпити за лінією', value: c.pinned_line || '', hint: 'Закріплений планшет одразу відкриває екран своєї лінії.',
        options: [{ value: '', label: 'Не закріплювати — усі лінії' }].concat(ls.map(function (l) { return { value: l.id, label: l.name }; })) }) +
      '<div class="field"><div class="field-label">Тема оформлення</div>' +
      UI.segmented({ name: 'theme', value: theme(), options: [{ value: 'dark', label: 'Темна', icon: 'moon' }, { value: 'light', label: 'Світла', icon: 'sun' }] }) + '</div>' +
      '<div class="form-actions"><button type="button" class="btn primary" data-d="save">' + icon('check') + '<span>Зберегти</span></button></div>' +
      '</div></section>' +
      '<section class="card"><div class="card-head">' + icon('cloud', 20) + 'Підключення</div><div class="card-body" id="devConn">' + connHtml() + '</div></section>' +
      '<section class="card"><div class="card-head">' + icon('upload', 20) + 'Синхронізація</div><div class="card-body" id="devQueue"></div>' +
      (c.mode === 'remote' ? '<div class="card-body" style="padding-top:0"><button type="button" class="btn" data-d="flush">' + icon('upload') + '<span>Надіслати зараз</span></button></div>' : '') + '</section>' +
      '<section class="card"><div class="card-head">' + icon('info', 20) + 'Про застосунок</div><div class="card-body" id="devAbout">' + aboutHtml() + '</div></section>' +
      '</div>';
    var qEl = $('devQueue');
    function drawQueue() { qEl.innerHTML = queueHtml(); }
    drawQueue();
    bindQueue(qEl);
    var offQ = Api.on('queue', drawQueue), offN = Api.on('net', function () { drawQueue(); });
    host.addEventListener('change', function (e) { if (e.detail && e.detail.name === 'theme') setTheme(e.detail.value); });
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-d]');
      if (!b) return;
      var a = b.getAttribute('data-d');
      if (a === 'save') {
        var f = $('devForm'), v = UI.readForm(f);
        if (!v.device) { UI.setErrors(f, { device: 'Вкажіть назву пристрою' }); return; }
        UI.clearErrors(f);
        Api.saveConfig({ device: v.device, pinned_line: v.pinned_line || '' });
        UI.toast('Налаштування пристрою збережено', { tone: 'ok' });
      } else if (a === 'flush') {
        Api.flush(true).then(function (n) { if (!n.pending) UI.toast('Черга порожня', { tone: 'ok', ms: 2000 }); });
      } else if (a === 'ping') {
        var out = host.querySelector('#devConn .conn-result');
        out.innerHTML = UI.spinner('Перевіряємо…');
        Api.call('ping', {}).then(function (r) {
          if (!r.ok) { out.innerHTML = '<div class="box err">' + icon('alert') + esc(r.message) + '</div>'; return; }
          return Api.boot().then(function (b) {
            out.innerHTML = b.ok ? '<div class="box ok">' + icon('check') + 'Зв’язок є · ' + esc(b.settings && b.settings.company || '') + ' · сервер v' + esc(r.version || b.version) + '</div>'
              : '<div class="box err">' + icon('alert') + esc(b.message) + '</div>';
          });
        });
      } else if (a === 'reset') {
        UI.confirm({ title: 'Скинути демо-дані?', text: 'Усі записи, зроблені в демо-режимі на цьому пристрої, буде стерто, а демо-дані створено заново на поточну дату.', ok: 'Скинути', danger: true })
          .then(function (y) {
            if (!y) return;
            var ld = UI.modal({ title: 'Скидання демо-даних', body: UI.spinner('Створюємо демо-дані заново…'), locked: true, size: 'sm' });
            LocalBackend.resetDemo().then(function () { return refresh(); }).then(function () {
              ld.close();
              UI.toast('Демо-дані створено заново', { tone: 'ok' });
              if (current && current.ctx.path === '/device') render('refresh');
            }, function (e2) { ld.close(); UI.toast('Не вдалося: ' + (e2 && e2.message || e2), { tone: 'err' }); });
          });
      } else if (a === 'update') {
        if (swWaiting) applyUpdate();
        else { checkSwUpdate(); UI.toast('Перевіряємо оновлення…', { tone: 'info', ms: 2500 }); setTimeout(function () { if (!swWaiting) location.reload(); }, 2500); }
      } else if (a === 'admin-out') {
        adminLogout();
        $('devAbout').innerHTML = aboutHtml();
      }
    });
    return {
      onBoot: function () { var ab = $('devAbout'); if (ab) ab.innerHTML = aboutHtml(); },
      dispose: function () { offQ(); offN(); }
    };
  }

  /* ------------------------------ запуск ------------------------------ */
  var servicesOn = false;
  function startServices() {
    document.body.classList.remove('no-config');
    var c = Api.config();
    var ready = c.mode === 'local' ? LocalBackend.init() : Promise.resolve();
    return ready.then(function () {
      if (c.mode === 'local' && LocalBackend.store) {
        LocalBackend.store.onError = function (e) { storeError = String(e && e.message || e); updateChrome(); };
      }
      if (!servicesOn) {
        servicesOn = true;
        startPolling();
      }
      return refresh();
    }, function (e) {
      bootError = { ok: false, error: 'SERVER_ERROR', message: 'Не вдалося підготувати демо-дані: ' + (e && e.message || e) };
      if (current && current.waiting) render('boot');
    });
  }
  function bindChrome() {
    var nb = $('tbNet'), ob = $('tbOp'), mb = $('tbMenu');
    if (nb) nb.addEventListener('click', showQueue);
    if (ob) ob.addEventListener('click', function () { chooseOperator(currentLineId() || null); });
    if (mb) mb.addEventListener('click', function () { openMainMenu(mb); });
    document.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-back], [data-action="show-queue"], [data-action="retry-boot"]') : null;
      if (!t) return;
      if (t.hasAttribute('data-back')) { e.preventDefault(); back(t.getAttribute('href') || '#/'); }
      else if (t.getAttribute('data-action') === 'show-queue') showQueue();
      else if (t.getAttribute('data-action') === 'retry-boot') { bootError = null; render('boot'); refresh(); }
    });
    // форми з [data-track-dirty] автоматично позначають екран «брудним»
    var mark = function (e) { if (viewEl && viewEl.contains(e.target) && e.target.closest && e.target.closest('[data-track-dirty]')) dirty = true; };
    document.addEventListener('input', mark);
    document.addEventListener('change', mark);
  }
  function start() {
    if (started) return;
    started = true;
    viewEl = $('view');
    UI.now = function () { return Api.now(); };
    applyTheme(Api.config().theme);
    bindChrome();
    Api.on('boot', onBoot);
    Api.on('queue', function (n) { updateChrome(); emit('queue', n); onQueueChange(n); });
    Api.on('net', function (n) { updateChrome(); emit('net', n); });
    Api.on('ack', onAck);
    Api.on('error', function (e) {
      if (e && e.rejected) UI.toast('Сервер відхилив запис: ' + (e.message || e.error), { tone: 'err', action: { label: 'Деталі', onClick: showQueue } });
      else if (e && e.error === 'STORAGE_FULL') UI.toast(e.message, { tone: 'err', ms: 10000, action: { label: 'Деталі', onClick: showQueue } });
    });
    Api.on('admin', function (e) {
      if (!e || !e.required) return;
      if (current && current.m && /^\/m(\/|$)/.test(current.m.r.src)) {
        UI.toast('Потрібно знову ввести PIN керівника', { tone: 'warn' });
        requireAdmin().then(function (ok) { if (ok) render('refresh'); else go('#/', { replace: true }); });
      }
    });
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && Api.target() && Date.now() - lastAttempt > 20000) refresh();
    });
    window.addEventListener('online', function () { if (Api.target()) refresh({ noFlush: true }); });
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvt = e; });
    var ticks = 0;
    setInterval(function () {
      tickClock();
      UI.tick(document.body);
      if (staleView && !dirty && !UI.isModalOpen() && current && current.m && !current.ctrl) rerenderKeepScroll();
      if (++ticks % 60 === 0) { var had = !!Api.config().operator; if (had && !operator()) updateChrome(); }
    }, 1000);
    registerSW();

    // номер поточного запису історії (після перезавантаження сторінки зберігається в history.state)
    var i0 = stateIdx();
    if (i0 === null) { i0 = 0; stamp(0); }
    histIdx = histBase = i0;
    var c = Api.config();
    if (!c.mode) {
      document.body.classList.add('no-config');
      if (parse().path !== '/setup') history.replaceState(history.state, '', '#/setup');
      navHash[histIdx] = location.hash;
      render('nav');
      return;
    }
    var cached = Api.cachedBoot();
    if (cached) setState(cached);
    var h = location.hash;
    if (c.pinned_line && (!h || h === '#' || h === '#/')) history.replaceState(history.state, '', '#/line/' + encodeURIComponent(c.pinned_line));
    navHash[histIdx] = location.hash || '#/';
    if (c.mode === 'local' && !cached) waitingText = 'Готуємо демо-дані…';
    render('nav');
    startServices();
  }

  route('/', homeView);
  route('/setup', setupView, { boot: false, rerender: false });
  route('/device', deviceView, { boot: false });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else setTimeout(start, 0);

  return {
    VERSION: VERSION,
    get state() { return state; },
    get idx() { return idx; },
    on: on, off: off,
    /* маршрутизація */
    route: route, go: go, back: back, backTo: backTo, prevHash: prevHash, current: currentCtx, rerender: function () { render('refresh'); },
    setDirty: setDirty, isDirty: isDirty, setTitle: setTitle, currentLineId: currentLineId,
    /* пристрій */
    config: function () { return Api.config(); }, mode: mode, setTheme: setTheme, theme: theme,
    /* довідники */
    line: line, unit: unit, item: item, meter: meter, rule: rule, staff: staff,
    lines: lines, unitsOf: unitsOf, itemsFor: itemsFor, metersOf: metersOf, rulesOf: rulesOf, staffFor: staffFor,
    /* стан */
    lineStatus: lineStatus, dueFor: dueFor, now: now, liveTodayHours: liveTodayHours, checkMissing: checkMissing,
    /* люди */
    operator: operator, requireOperator: requireOperator, chooseOperator: chooseOperator, signOut: signOut,
    requireAdmin: requireAdmin, isAdmin: function () { return Api.isAdmin(); }, adminLogout: adminLogout,
    /* дані і черга */
    refresh: refresh, showQueue: showQueue, describeOp: describeOp,
    start: start
  };
})();
