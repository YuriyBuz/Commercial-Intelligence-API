/* =====================================================================
   FOODLINE · Лінії — розділ керівництва (manager.js)
   Маршрути: #/m → #/m/overview; #/m/<розділ>; #/m/equipment/<лінія>.
   Розділи: огляд, ТО і ППР, журнал, чек-листи, обладнання, персонал,
   налаштування. Доступ — лише після App.requireAdmin() (PIN керівника).
   Дії керівника — Api.call (потрібен зв'язок); запис роботи — Api.write.
   Контракт глобалів App / Api / UI — docs/client-api.md. Стилі — manager.css.
   ===================================================================== */
(function () {
  'use strict';

  var esc = UI.esc, icon = UI.icon, fmt = UI.fmt, U = LinesCore.util, LBL = LinesCore.LABELS;
  var DAY = 86400000;

  var VIEWS = [
    { id: 'overview', label: 'Огляд', icon: 'chart' },
    { id: 'maintenance', label: 'ТО і ППР', icon: 'wrench' },
    { id: 'journal', label: 'Журнал', icon: 'list' },
    { id: 'checks', label: 'Чек-листи', icon: 'checklist' },
    { id: 'equipment', label: 'Обладнання', icon: 'box' },
    { id: 'staff', label: 'Персонал', icon: 'users' },
    { id: 'settings', label: 'Налаштування', icon: 'settings' }
  ];
  var ALIAS = { maint: 'maintenance', plan: 'maintenance', history: 'journal' };

  /* ------------------------------ дрібні помічники ------------------------------ */
  function has(o, k) { return o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k); }
  function lbl(set, code) { return code ? UI.label(set, code) : ''; }
  function nf(n, dec) { return fmt.num(n, dec === undefined ? 2 : dec); }
  function todayKey() { return fmt.dayKey(App.now()); }
  function keyAdd(k, n) { return U.keyAdd(k, n); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isKey(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
  function findIn(list, id) { list = list || []; for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function adminRows(t) { return (cache.admin && cache.admin[t]) || []; }
  function lineAny(id) { return App.line(id) || findIn(adminRows('lines'), id); }
  function unitAny(id) { return id ? (App.unit(id) || findIn(adminRows('units'), id)) : null; }
  function meterAny(id) { return id ? (App.meter(id) || findIn(adminRows('meters'), id)) : null; }
  function ruleAny(id) { return id ? (App.rule(id) || findIn(adminRows('rules'), id)) : null; }
  function lineName(id) { var l = lineAny(id); return l ? l.name : (id || '—'); }
  function unitName(id) { var u = unitAny(id); return u ? u.name : (id || ''); }
  function bySort(a, b) { return ((a.sort || 0) - (b.sort || 0)) || String(a.name || a.title || a.text || '').localeCompare(String(b.name || b.title || b.text || ''), 'uk'); }
  function dueTone(st) { return st === 'due' ? 'due' : st === 'soon' ? 'soon' : st === 'ok' ? 'ok' : 'muted'; }
  function dueBadge(st) { return UI.badge(lbl('due_status', st) || 'Без інтервалу', dueTone(st), { icon: st === 'due' ? 'alert' : st === 'soon' ? 'clock' : '' }); }
  function resultBadge(r) {
    if (!r) return UI.badge('надсилається', 'info');
    return UI.badge(lbl('check_result', r), r === 'ok' ? 'ok' : r === 'remarks' ? 'soon' : 'bad', { icon: r === 'ok' ? 'check' : 'alert' });
  }
  function csvDate() { return todayKey(); }
  function debounce(fn, ms) { var t = null; return function () { var a = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, a); }, ms); }; }
  function selectHtml(name, value, options, o) {
    o = o || {};
    return '<select class="inp' + (o.cls ? ' ' + o.cls : '') + '" name="' + esc(name) + '"' + (o.label ? ' aria-label="' + esc(o.label) + '"' : '') + (o.disabled ? ' disabled' : '') + '>' +
      options.map(function (op) { return '<option value="' + esc(op.value) + '"' + (String(op.value) === String(value || '') ? ' selected' : '') + '>' + esc(op.label) + '</option>'; }).join('') + '</select>';
  }
  function lineOptions(all) {
    var ls = App.lines().slice();
    return [{ value: '', label: all || 'Усі лінії' }].concat(ls.map(function (l) { return { value: l.id, label: l.name }; }));
  }
  function unitOptions(lineId, all) {
    var us = lineId ? App.unitsOf(lineId) : [];
    return [{ value: '', label: all || 'Усі агрегати' }].concat(us.map(function (u) { return { value: u.id, label: u.name }; }));
  }

  /* текст помилки дії для людей */
  function errText(r, read) {
    if (!r) return 'Невідома помилка';
    if (r.error === 'NETWORK' || r.error === 'TIMEOUT') {
      return read ? 'Немає зв’язку з сервером — дані не завантажено. Перевірте мережу й спробуйте ще раз.' :
        'Немає зв’язку з сервером — зміни не збережено. Дії керівника виконуються лише онлайн: перевірте мережу й спробуйте ще раз.';
    }
    if (r.error === 'ADMIN_REQUIRED') return 'Потрібно знову ввести PIN керівника.';
    if (r.error === 'LOCKED') return 'Сервер зайнятий іншим записом — спробуйте ще раз за кілька секунд.';
    if (r.error === 'RATE_LIMIT') return 'Забагато невдалих спроб входу. Зачекайте кілька хвилин.';
    return r.message || r.error || 'Помилка';
  }
  function errBox(r, retry) {
    return '<div class="box err m-err">' + icon('alert') + '<span>' + esc(errText(r, true)) + '</span>' +
      (retry ? '<button type="button" class="btn sm" data-m="' + esc(retry) + '">' + icon('refresh', 18) + '<span>Спробувати ще раз</span></button>' : '') + '</div>';
  }
  function safeUrl(u) { u = String(u || '').trim(); return /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : ''; }
  function isOffline() { var n = Api.net(); return n.mode === 'remote' && n.online === false; }

  /* ------------------------------ кеш даних розділу ------------------------------ */
  var cache = { gen: 0, admin: null, adminAt: 0, adminGen: -1, dash: {}, plan: null, planKey: '', planAt: 0, rep: null, works: null };
  var inflight = {};
  function once(key, fn) {
    if (inflight[key]) return inflight[key];
    var p = inflight[key] = fn().then(function (r) { delete inflight[key]; return r; });
    return p;
  }
  /* повний bootstrap керівника: вимкнені рядки, email, config_issues */
  /* cache.gen зростає після кожної зміни даних: відповідь, запитана раніше, не вважається свіжою */
  function loadAdmin(force) {
    if (!force && cache.admin && cache.adminGen === cache.gen && Date.now() - cache.adminAt < 60000) return Promise.resolve(cache.admin);
    var g = cache.gen;
    return once('admin' + g, function () {
      return Api.call('bootstrap', {}, { admin: true }).then(function (r) {
        if (r.ok && g >= cache.adminGen) { cache.admin = r; cache.adminAt = Date.now(); cache.adminGen = g; }
        return r;
      });
    });
  }
  function getDash(days, maxAge) {
    var c = cache.dash[days], g = cache.gen;
    if (c && c.gen === g && Date.now() - c.at < (maxAge === undefined ? 30000 : maxAge)) return Promise.resolve(c.r);
    return once('dash' + days + ':' + g, function () {
      return Api.call('dashboard', { days: days }).then(function (r) { if (r.ok && g === cache.gen) cache.dash[days] = { r: r, at: Date.now(), gen: g }; return r; });
    });
  }
  /* 12 місяців плану від початку поточного місяця */
  function planRange() {
    var t = todayKey(), y = +t.slice(0, 4), m = +t.slice(5, 7), months = [];
    for (var i = 0; i < 12; i++) {
      var mm = (m - 1 + i) % 12 + 1, yy = y + Math.floor((m - 1 + i) / 12);
      months.push({ y: yy, m: mm, key: yy + '-' + pad2(mm) });
    }
    var ny = y + Math.floor((m - 1 + 12) / 12), nm = (m - 1 + 12) % 12 + 1;
    return { from: t.slice(0, 8) + '01', to: keyAdd(ny + '-' + pad2(nm) + '-01', -1), months: months };
  }
  function getPlan(force) {
    var pr = planRange(), g = cache.gen;
    if (!force && cache.plan && cache.planKey === pr.from + ':' + g && Date.now() - cache.planAt < 120000) return Promise.resolve(cache.plan);
    return once('plan' + g, function () {
      return Api.call('plan', { from: pr.from, to: pr.to }).then(function (r) {
        if (r.ok && g === cache.gen) { cache.plan = r; cache.planKey = pr.from + ':' + g; cache.planAt = Date.now(); }
        return r;
      });
    });
  }
  /* дані змінилися: скинути кеш і оновити стан застосунку */
  function touched() {
    cache.gen++; cache.adminAt = 0; cache.dash = {}; cache.planAt = 0; cache.rep = null; cache.works = null;
    return App.refresh();
  }
  /* збереження рядка довідника → Promise<row>; помилка → Error з текстом для людей */
  function saveRow(table, row) {
    return Api.call('save', { table: table, row: row }).then(function (r) {
      if (!r.ok) throw new Error(errText(r));
      touched();
      return r.row;
    });
  }
  function removeRow(table, id) {
    return Api.call('remove', { table: table, id: id }).then(function (r) {
      if (!r.ok) throw new Error(errText(r));
      touched();
      return true;
    });
  }

  /* ------------------------------ каркас розділу ------------------------------ */
  function viewMeta(id) { return VIEWS.filter(function (v) { return v.id === id; })[0] || VIEWS[0]; }
  function navHtml(cur) {
    return VIEWS.map(function (v) {
      var on = v.id === cur;
      return '<a class="m-nav-a' + (on ? ' on' : '') + '" href="#/m/' + v.id + '"' + (on ? ' aria-current="page"' : '') + '>' + icon(v.icon, 20) + '<span>' + esc(v.label) + '</span></a>';
    }).join('') + '<span class="m-nav-sep" aria-hidden="true"></span>' +
      '<a class="m-nav-a m-nav-x" href="#/">' + icon('grid', 20) + '<span>До ліній</span></a>' +
      '<button type="button" class="m-nav-a m-nav-x" data-m-logout>' + icon('logout', 20) + '<span>Вийти</span></button>';
  }
  function offHtml() {
    return '<div class="m-off box warn no-print"' + (isOffline() ? '' : ' hidden') + ' role="status">' + icon('cloudOff') +
      '<span><b>Немає зв’язку з сервером.</b> Показано останні отримані дані. Збереження змін у розділі керівництва можливе лише онлайн.</span></div>';
  }
  /* shell(host, 'overview', {title, sub, actions, back, kicker}) → {body, head, setHead(o)} */
  function shell(host, viewId, o) {
    o = o || {};
    var v = viewMeta(viewId);
    App.setTitle('Керівництво · ' + (o.docTitle || o.title || v.label));
    host.classList.add('m-page');
    host.innerHTML = '<div class="m-shell"><nav class="m-nav no-print" aria-label="Розділи керівництва">' + navHtml(viewId) + '</nav>' +
      '<div class="m-main">' + offHtml() + '<div class="m-head"></div><div class="m-body"></div></div></div>';
    var s = {
      host: host, head: host.querySelector('.m-head'), body: host.querySelector('.m-body'),
      setHead: function (h) {
        s.head.innerHTML = UI.pageHead({ title: h.title || v.label, kicker: h.kicker === undefined ? 'Керівництво' : h.kicker, sub: h.sub, actions: h.actions, back: h.back });
      }
    };
    s.setHead(o);
    var nav = host.querySelector('.m-nav'), a = nav.querySelector('.on');
    if (a) setTimeout(function () { if (nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, a.offsetLeft - (nav.clientWidth - a.offsetWidth) / 2); }, 0);
    return s;
  }
  function actBtn(action, label, ic, o) {
    o = o || {};
    return '<button type="button" class="btn' + (o.tone ? ' ' + o.tone : '') + (o.sm !== false ? ' sm' : '') + '" data-m="' + esc(action) + '"' +
      (o.title ? ' title="' + esc(o.title) + '"' : '') + '>' + (ic ? icon(ic, 18) : '') + '<span>' + esc(label) + '</span></button>';
  }
  function freshSub(at) { var S = App.state && App.state.settings || {}; return esc(S.company || '') + (at ? ' · дані на ' + esc(fmt.time(new Date(at))) : ''); }

  App.on('net', function () { UI.qsa('.m-off').forEach(function (b) { b.hidden = !isOffline(); }); });
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-m-logout]') : null;
    if (b) { e.preventDefault(); App.adminLogout(); }
  });

  /* адаптивна таблиця (на вузьких екранах — картки): cols [{label, short, cls, html(row)}] */
  function rtable(cols, rows, o) {
    o = o || {};
    var h = '<div class="m-tw' + (o.cls ? ' ' + o.cls : '') + '"><table class="tbl m-rt">' + (o.caption ? '<caption>' + esc(o.caption) + '</caption>' : '') +
      '<thead><tr>' + cols.map(function (c) { return '<th scope="col" class="' + (c.cls || '') + '">' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>';
    if (!rows.length) h += '<tr class="tbl-empty"><td colspan="' + cols.length + '">' + esc(o.empty || 'Немає даних') + '</td></tr>';
    rows.forEach(function (r, i) {
      var a = o.attrs ? (o.attrs(r, i) || {}) : {};
      h += '<tr' + UI.attrs(a) + '>' + cols.map(function (c) {
        var v = c.html(r, i);
        return '<td class="' + (c.cls || '') + (v === '' || v === null || v === undefined ? ' m-empty' : '') + '" data-l="' + esc(c.short || c.label) + '">' + (v === null || v === undefined ? '' : v) + '</td>';
      }).join('') + '</tr>';
    });
    return h + '</tbody></table></div>';
  }
  /* клік / Enter по елементу з data-open (рядок таблиці, картка) */
  function bindRows(root, fn) {
    UI.delegate(root, 'click', '[data-open]', function (e, el) {
      var inner = e.target.closest('a, button, input, select, textarea, label');
      if (inner && inner !== el && el.contains(inner)) return;
      fn(el.getAttribute('data-open'), e, el);
    });
    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var tr = e.target && e.target.closest ? e.target.closest('tr[data-open]') : null;
      if (tr && e.target === tr) { e.preventDefault(); fn(tr.getAttribute('data-open'), e, tr); }
    });
  }

  /* ------------------------------ контроль чек-листів (матриця) ------------------------------ */
  var CST = {
    ok: { label: 'Виконано', glyph: '✓', text: 'усі запуски з чек-листом' },
    warn: { label: 'Із зауваженнями', glyph: '!', text: 'зауваження в чек-листі або запуск попри них' },
    miss: { label: 'Без чек-листа', glyph: '✕', text: 'запуск або завершення без чек-листа' },
    cont: { label: 'Робота без запуску', glyph: '→', text: 'лінія працювала з попередньої доби' },
    idle: { label: 'Не працювала', glyph: '', text: 'роботи не було' }
  };
  /* «Н/З» (не застосовується) у чек-листах: сума за списком / текст для рядка */
  function naSum(list) { var n = 0; (list || []).forEach(function (c) { n += +c.na || 0; }); return n; }
  function naText(c) { return c && +c.na > 0 ? 'Н/З: ' + c.na : ''; }
  function cellTitle(l, x) {
    var m = CST[x.status] || CST.idle;
    var s = l.name + ' · ' + fmt.dayLabel(x.day) + ' — ' + m.label + '.';
    if (x.starts) s += ' Запусків: ' + x.starts + ' (з чек-листом ' + x.covered + ').';
    if (x.uncovered) s += ' Без чек-листа: ' + x.uncovered + '.';
    if (x.forced) s += ' Запуск попри зауваження: ' + x.forced + '.';
    if (x.checks && x.checks.length) s += ' Чек-листів: ' + x.checks.length + '.';
    var na = naSum(x.checks);
    if (na) s += ' Відповідей «Н/З»: ' + na + '.';
    if (x.run_h) s += ' Робота: ' + fmt.hm(x.run_h) + '.';
    return s;
  }
  function matrixLegend() {
    return '<div class="m-mx-leg">' + ['ok', 'warn', 'miss', 'cont', 'idle'].map(function (k) {
      return '<span><i class="m-cell c-' + k + '" aria-hidden="true">' + CST[k].glyph + '</i><b>' + esc(CST[k].label) + '</b> — ' + esc(CST[k].text) + '</span>';
    }).join('') + '</div>';
  }
  function matrixHtml(d, lines) {
    var days = d.days || [], comp = d.compliance || {}, pct = d.compliance_pct || {}, tk = todayKey();
    if (!lines.length) return UI.emptyState({ icon: 'grid', title: 'Ліній немає' });
    var head = '<tr><th scope="col" class="m-mx-n">Лінія</th>' + days.map(function (k) {
      var wd = U.keyDow(k);
      return '<th scope="col" class="' + (wd === 0 || wd === 6 ? 'we' : '') + (k === tk ? ' today' : '') + '"><span>' + esc(fmt.dayLabel(k).split(' ')[0]) + '</span><b>' + esc(k.slice(8)) + '</b></th>';
    }).join('') + '<th scope="col" class="m-mx-p" title="Частка запусків із чек-листом">Із чек-листом</th></tr>';
    var body = lines.map(function (l) {
      var by = {};
      (comp[l.id] || []).forEach(function (x) { by[x.day] = x; });
      var pc = pct[l.id];
      return '<tr><th scope="row" class="m-mx-n"><span>' + esc(l.name) + '</span></th>' + days.map(function (k) {
        var x = by[k];
        if (!x) return '<td></td>';
        var t = cellTitle(l, x);
        return '<td><button type="button" class="m-cell c-' + esc(x.status) + '" data-cell="' + esc(l.id + '|' + k) + '" title="' + esc(t) + '" aria-label="' + esc(t) + '">' + (CST[x.status] ? CST[x.status].glyph : '') + '</button></td>';
      }).join('') + '<td class="m-mx-p">' + (pc === null || pc === undefined ? '<span class="dim">—</span>' : '<b class="' + (pc >= 95 ? 'c-ok' : pc >= 80 ? 'c-warn' : 'c-bad') + '">' + esc(fmt.pct(pc)) + '</b>') + '</td></tr>';
    }).join('');
    return '<div class="m-mx-wrap"><table class="m-mx"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' + matrixLegend();
  }
  function findCell(d, lineId, key) {
    var arr = (d.compliance || {})[lineId] || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].day === key) return arr[i];
    return null;
  }
  /* клітинка матриці → подробиці дня */
  function openDay(lineId, key, x, onChange) {
    var l = lineAny(lineId) || { name: lineId }, m = CST[x.status] || CST.idle;
    var tone = x.status === 'ok' ? 'ok' : x.status === 'warn' ? 'soon' : x.status === 'miss' ? 'due' : x.status === 'cont' ? 'info' : 'muted';
    var chk = (x.checks || []).slice().sort(function (a, b) { return Date.parse(a.ts) - Date.parse(b.ts); });
    var body = '<div class="m-day-st">' + UI.badge(m.label, tone) + '<span class="muted">' + esc(m.text) + '</span></div>' +
      UI.kv([
        ['Запусків', esc(String(x.starts || 0))],
        ['З чек-листом', esc(String(x.covered || 0))],
        x.uncovered ? ['Без чек-листа', '<b class="c-bad">' + esc(String(x.uncovered)) + '</b> (запуск чи завершення)'] : null,
        x.forced ? ['Попри зауваження', '<b class="c-warn">' + esc(String(x.forced)) + '</b>'] : null,
        ['Робота', esc(x.run_h ? fmt.hm(x.run_h) : 'не працювала')]
      ]) +
      '<div class="section-title">Чек-листи за день · ' + chk.length + '</div>' +
      (chk.length ? '<div class="list">' + chk.map(function (c) {
        return '<button type="button" class="list-item m-li-btn" data-chk="' + esc(c.id) + '" data-ts="' + esc(c.ts) + '"><div class="li-main"><div class="li-t">' +
          esc(lbl('occasion', c.occasion)) + ' · ' + esc(fmt.time(c.ts)) + '</div>' + (naText(c) ? '<div class="li-s">' + esc(naText(c)) + '</div>' : '') + '</div>' +
          resultBadge(c.result) + icon('next', 20, 'dim') + '</button>';
      }).join('') + '</div>' : '<div class="list"><div class="list-empty">Чек-листів цього дня не було</div></div>');
    var md = UI.modal({
      title: l.name + ' · ' + fmt.dayLabel(key), size: 'md', className: 'm-modal', body: body,
      actions: [{ label: 'Журнал за день', icon: 'list', tone: 'ghost', value: 'journal' }, { label: 'Закрити', tone: 'primary', value: null }]
    });
    UI.delegate(md.body, 'click', '[data-chk]', function (e, b) { openCheck(b.getAttribute('data-chk'), b.getAttribute('data-ts'), onChange); });
    md.result.then(function (v) { if (v === 'journal') App.go('#/m/journal?line=' + encodeURIComponent(lineId) + '&from=' + key + '&to=' + key); });
  }

  /* ------------------------------ записи журналу: подробиці й анулювання ------------------------------ */
  var VOID_TEXT = {
    events: 'Мотогодини, запуски й поточний стан лінії буде перераховано.',
    checks: 'Разом із чек-листом буде анульовано всі його відповіді; позначки запусків «без чек-листа» перераховуються.',
    works: 'Строк ТО за регламентом буде перераховано; показник лічильника, внесений із цією роботою, теж буде анульовано.',
    readings: 'Поточне значення лічильника буде перераховано.'
  };
  function voidFlow(table, row, parent, onDone) {
    var body = '<p class="modal-text">Запис залишиться в журналі закресленим і не враховуватиметься в розрахунках. ' + esc(VOID_TEXT[table] || '') + '</p>' +
      UI.field.textarea({ name: 'void_note', label: 'Причина анулювання', required: true, rows: 3, maxLength: 500, placeholder: 'Напр., помилково записано не на ту лінію' });
    var md = UI.modal({
      title: 'Анулювати запис?', size: 'sm', className: 'm-modal', body: body,
      actions: [{ label: 'Скасувати', tone: 'ghost', value: null }, { label: 'Анулювати', icon: 'trash', tone: 'danger', onClick: function (mm) {
        var note = mm.body.querySelector('[name="void_note"]').value.trim();
        if (!note) { UI.setErrors(mm.body, { void_note: 'Вкажіть причину — її побачать у журналі й таблиці' }); return false; }
        // ts запису — сервер шукає його вікном навколо цього часу, а не читанням усього журналу
        return Api.call('void', { table: table, id: row.id, ts: row.ts || undefined, note: note }).then(function (r) {
          if (!r.ok) throw new Error(errText(r));
          return true;
        });
      } }]
    });
    md.body.addEventListener('input', function () { UI.clearErrors(md.body); });
    return md.result.then(function (ok) {
      if (!ok) return false;
      UI.toast('Запис анульовано', { tone: 'ok' });
      touched();
      if (parent) parent.close('void');
      if (onDone) onDone();
      return true;
    });
  }
  function normText(a) {
    var u = a.unit_label ? ' ' + a.unit_label : '';
    if (a.min !== null && a.min !== undefined && a.max !== null && a.max !== undefined) return nf(a.min) + '–' + nf(a.max) + u;
    if (a.min !== null && a.min !== undefined) return '≥ ' + nf(a.min) + u;
    if (a.max !== null && a.max !== undefined) return '≤ ' + nf(a.max) + u;
    return '';
  }
  function answersHtml(ans) {
    if (!ans.length) return '<div class="list"><div class="list-empty">Відповідей немає</div></div>';
    var secs = [], by = {};
    ans.forEach(function (a) { var s = a.section || 'Без розділу'; if (!by[s]) { by[s] = []; secs.push(s); } by[s].push(a); });
    return secs.map(function (s) {
      return '<div class="m-ans-sec"><div class="section-title">' + esc(s) + '</div><div class="m-ans">' + by[s].map(function (a) {
        var st = a.ok === true ? 'ok' : a.ok === false ? 'bad' : 'na';
        var val = a.value === '' || a.value === null || a.value === undefined ? '<span class="dim">не заповнено</span>' :
          esc(a.value) + (a.type === 'number' && a.unit_label ? ' ' + esc(a.unit_label) : '');
        var nt = a.type === 'number' ? normText(a) : '';
        // «Н/З» без пояснення на обовʼязковому пункті або на критичному — перевірку не підтверджено (зауваження)
        var naBad = a.type === 'check' && a.ok === false && a.value === LBL.check_value.na;
        var naCrit = naBad && (a.note || (App.item(a.item_id) || {}).critical);
        return '<div class="m-an a-' + st + '"><span class="m-an-mk" aria-hidden="true">' + (st === 'ok' ? '✓' : st === 'bad' ? '✕' : '–') + '</span>' +
          '<div class="m-an-t">' + esc(a.text) + (nt ? '<small>норма: ' + esc(nt) + '</small>' : '') +
          (naBad ? '<small class="c-bad">' + (naCrit ? '«Н/З» не підтверджує критичний пункт' : '«Н/З» без пояснення — перевірку пропущено') + '</small>' : '') +
          (a.note ? '<em>' + esc(a.note) + '</em>' : '') + '</div>' +
          '<div class="m-an-v">' + val + '<span class="sr">' + (st === 'ok' ? ' (в нормі)' : st === 'bad' ? ' (зауваження)' : '') + '</span></div></div>';
      }).join('') + '</div></div>';
    }).join('');
  }
  /* чек-лист з відповідями (+ анулювання) */
  function openCheck(id, ts, onDone) {
    var md = UI.modal({ title: 'Чек-лист', size: 'lg', className: 'm-modal', body: UI.spinner('Завантаження відповідей…'),
      actions: [{ label: 'Закрити', tone: 'primary', value: null }] });
    Api.call('check_detail', { id: id, ts: ts || undefined }).then(function (r) {
      if (!r.ok) { md.body.innerHTML = errBox(r); return; }
      var c = r.check;
      md.setTitle('Чек-лист: ' + lbl('occasion', c.occasion) + ' · ' + lineName(c.line_id));
      var dur = c.started && c.ts ? Date.parse(c.ts) - Date.parse(c.started) : null;
      md.body.innerHTML = (c.void ? '<div class="box err m-voidbox">' + icon('alert') + '<span><b>Анульовано.</b> ' + esc(c.void_note || '') + '</span></div>' : '') +
        '<div class="m-chk-head">' + resultBadge(c.result) +
        '<span>' + esc(fmt.datetime(c.ts)) + '</span>' + (c.operator ? '<span>' + icon('user', 16) + esc(c.operator) + '</span>' : '') +
        (c.product ? '<span>' + icon('box', 16) + esc(c.product) + '</span>' : '') + '</div>' +
        '<div class="m-chk-nums">' +
        [['Пунктів', c.total], ['Зауважень', c.failed, 1], ['Поза нормою', c.out_of_range, 1], ['Не заповнено', c.missing, 1]].concat(+c.na > 0 ? [['Н/З', c.na]] : []).map(function (x) {
          return '<span class="' + (x[2] && x[1] > 0 ? 'bad' : '') + '"><b>' + esc(String(x[1] || 0)) + '</b>' + esc(x[0]) + '</span>';
        }).join('') + (dur !== null && dur >= 0 ? '<span><b>' + esc(fmt.duration(dur)) + '</b>тривалість</span>' : '') + '</div>' +
        (c.comment ? '<div class="box m-comment">' + icon('info') + '<span>' + esc(c.comment) + '</span></div>' : '') +
        answersHtml(r.answers || []) +
        '<p class="dim small m-meta">Пристрій: ' + esc(c.device || '—') + ' · записано ' + esc(fmt.datetime(c.created)) + ' · ID ' + esc(c.id) + '</p>';
      if (!c.void && md.foot) {
        var b = UI.el('button', { type: 'button', class: 'btn ghost m-danger-t m-foot-left', html: icon('trash', 20) + '<span>Анулювати</span>' });
        b.addEventListener('click', function () { voidFlow('checks', c, md, onDone); });
        md.foot.insertBefore(b, md.foot.firstChild);
      }
    });
    return md.result;
  }
  function recTitle(kind, r) {
    if (kind === 'events') return 'Стан лінії: ' + lbl('state', r.state);
    if (kind === 'works') return (lbl('work_type', r.work_type) || 'Робота') + (r.title ? ': ' + r.title : '');
    if (kind === 'readings') { var m = meterAny(r.meter_id); return 'Показник: ' + (m ? m.name : r.meter_id); }
    return 'Запис';
  }
  function recPairs(kind, r) {
    var p = [], add = function (k, v) { if (v !== '' && v !== null && v !== undefined) p.push([k, v]); };
    var t = function (s) { return s ? esc(s) : ''; };
    if (kind === 'events') {
      add('Час', t(fmt.datetime(r.ts)));
      add('Лінія', t(lineName(r.line_id)));
      add('Стан', UI.statusPill(r.state, { size: 'sm' }));
      add('Попередній стан', t(lbl('state', r.prev_state)));
      add('Причина', t(r.reason));
      add('Продукт / формат', t(r.product));
      add('Оператор', t(r.operator));
      add('Примітка', t(r.note));
      if (r.flag) add('Позначка', UI.badge(lbl('flag', r.flag), r.flag === 'forced' ? 'soon' : 'bad'));
      add('Мотогодини лінії', r.cum_h !== null && r.cum_h !== undefined ? esc(nf(r.cum_h, 1)) : '');
      add('Запусків усього', r.starts !== null && r.starts !== undefined ? esc(String(r.starts)) : '');
      add('Повʼязаний запис', t(r.ref_id));
    } else if (kind === 'works') {
      var rl = ruleAny(r.rule_id);
      add('Завершено', t(fmt.datetime(r.ts)));
      add('Розпочато', r.started ? t(fmt.datetime(r.started)) : '');
      add('Лінія', t(lineName(r.line_id)));
      add('Агрегат', t(unitName(r.unit_id)));
      add('Вид', t(lbl('work_type', r.work_type)));
      add('За регламентом', rl ? t(rl.title) : t(r.rule_id));
      add('Що зроблено', t(r.title));
      add('Опис', t(r.description));
      add('Причина / несправність', t(r.cause));
      add('Замінені деталі', t(r.parts));
      add('Параметри налаштування', t(r.params));
      add('Продукт / формат', t(r.product));
      add('Виконавець', t(r.performer));
      add('Тривалість', r.duration_min ? esc(nf(r.duration_min, 0)) + ' хв' : '');
      add('Простій', r.downtime_min ? esc(nf(r.downtime_min, 0)) + ' хв' : '');
      add('Мотогодини лінії', r.hours_at !== null && r.hours_at !== undefined ? esc(nf(r.hours_at, 1)) : '');
      add('Лічильник', r.meter_at !== null && r.meter_at !== undefined ? esc(nf(r.meter_at)) : '');
      add('Статус', t(lbl('work_status', r.status)));
    } else if (kind === 'readings') {
      var m = meterAny(r.meter_id);
      add('Час', t(fmt.datetime(r.ts)));
      add('Лічильник', m ? t(m.name) : t(r.meter_id));
      add('Лінія', t(lineName(r.line_id)));
      add('Агрегат', t(unitName(r.unit_id)));
      add('Значення', esc(nf(r.value)) + (m && m.unit_label ? ' ' + esc(m.unit_label) : ''));
      add('Тип обліку', t(lbl('meter_mode', r.mode)));
      add('Оператор', t(r.operator));
      add('Примітка', t(r.note));
    }
    add('Пристрій', t(r.device));
    add('Записано', r.created ? t(fmt.datetime(r.created)) : '');
    add('ID', '<span class="mono small">' + esc(r.id) + '</span>');
    return p;
  }
  function openRecord(kind, r, onDone) {
    if (kind === 'checks') return openCheck(r.id, r.ts, onDone);
    var body = (r.void ? '<div class="box err m-voidbox">' + icon('alert') + '<span><b>Анульовано.</b> ' + esc(r.void_note || '') + '</span></div>' : '') + UI.kv(recPairs(kind, r));
    var md = UI.modal({
      title: recTitle(kind, r), size: 'md', className: 'm-modal', body: body,
      actions: [r.void ? null : { label: 'Анулювати', icon: 'trash', tone: 'ghost', className: 'm-danger-t m-foot-left', onClick: function (mm) { voidFlow(kind, r, mm, onDone); return false; } },
        { label: 'Закрити', tone: 'primary', value: null }]
    });
    return md.result;
  }

  /* ------------------------------ запис виконаної роботи (ТО за регламентом) ------------------------------ */
  function markDone(d, onDone) {
    var rule = ruleAny(d.rule_id);
    var o = { line_id: d.line_id, rule_id: d.rule_id, unit_id: d.unit_id || (rule && rule.unit_id) || '', work_type: d.work_type || (rule && rule.work_type) || 'to',
      title: d.title || (rule && rule.title) || '' };
    // форма роботи з екрана оператора (якщо є) — та сама, що на планшеті; виконавця вказують у формі
    var op = window.Operator;
    if (op && typeof op.openWorkForm === 'function' && App.line(o.line_id) && App.rule(o.rule_id)) {
      try {
        var res = op.openWorkForm({ line_id: o.line_id, mode: 'rule', rule_id: o.rule_id, heading: 'Позначити виконаним', requireOperator: false, operator: App.operator() || null });
        Promise.resolve(res).then(function (v) {
          if (!v) return;
          UI.toast('Роботу «' + o.title + '» позначено виконаною', { tone: 'ok' });
          Promise.all(v.writes || []).then(function () { touched(); if (onDone) onDone(v); });
        });
        return;
      } catch (e) { console.error(e); }
    }
    workForm(o, onDone);
  }
  /* компактна форма керівника (якщо екран оператора не надав власної) */
  function workForm(o, onDone) {
    var rule = ruleAny(o.rule_id), meter = rule && rule.meter_id ? meterAny(rule.meter_id) : null;
    var names = App.staffFor(o.line_id).map(function (s) { return s.name; });
    var now = App.now();
    var body = '<div class="m-form-ctx">' + icon('wrench', 20) + '<span><b>' + esc(o.title || 'Робота') + '</b><br>' + esc(lineName(o.line_id)) + (o.unit_id ? ' · ' + esc(unitName(o.unit_id)) : '') + '</span></div>' +
      '<div class="form-grid">' +
      UI.field.datetime({ name: 'ts', label: 'Коли виконано', value: now, required: true }) +
      UI.field.text({ name: 'performer', label: 'Виконавець', required: true, datalist: names, placeholder: 'Прізвище та ім’я', maxLength: 120 }) +
      UI.field.select({ name: 'work_type', label: 'Вид роботи', value: o.work_type, options: UI.options('work_type') }) +
      UI.field.text({ name: 'title', label: 'Що зроблено', value: o.title, required: true, maxLength: 300 }) +
      UI.field.textarea({ name: 'description', label: 'Опис, зауваження', className: 'span-2', rows: 3, maxLength: 4000 }) +
      UI.field.text({ name: 'parts', label: 'Замінені деталі', placeholder: rule && rule.part ? rule.part : 'Якщо замінювали', className: 'span-2', maxLength: 500 }) +
      UI.field.number({ name: 'duration_min', label: 'Тривалість', unit: 'хв' }) +
      UI.field.number({ name: 'downtime_min', label: 'Простій лінії', unit: 'хв' }) +
      (meter ? UI.field.number({ name: 'meter_value', label: meter.name + ' — показник', unit: meter.unit_label || '', className: 'span-2',
        hint: meter.value !== null && meter.value !== undefined ? 'Останній показник: ' + nf(meter.value) + ' ' + (meter.unit_label || '') + (meter.value_ts ? ' (' + fmt.dt(meter.value_ts) + ')' : '') : 'Показника ще немає' }) : '') +
      '</div>';
    var md = UI.modal({
      title: 'Позначити виконаним', size: 'md', className: 'm-modal', body: body,
      actions: [{ label: 'Скасувати', tone: 'ghost', value: null }, { label: 'Записати роботу', icon: 'check', tone: 'primary', onClick: function (mm) {
        var v = UI.readForm(mm.body), errs = {}, n = App.now().getTime();
        var ts = v.ts ? Date.parse(v.ts) : NaN;
        if (isNaN(ts)) errs.ts = 'Вкажіть дату й час';
        else if (ts > n + 120000) errs.ts = 'Час не може бути в майбутньому';
        else if (ts < n - 366 * DAY) errs.ts = 'Не давніше ніж рік тому';
        if (!v.performer) errs.performer = 'Хто виконував роботу?';
        if (!v.title) errs.title = 'Опишіть коротко, що зроблено';
        numErrs(mm.body, v, errs, { duration_min: { min: 0 }, downtime_min: { min: 0 }, meter_value: { min: 0 } });
        if (UI.setErrors(mm.body, errs)) return false;
        var st = App.staffFor(o.line_id).filter(function (s) { return s.name === v.performer; })[0];
        var p = { line_id: o.line_id, unit_id: o.unit_id || '', rule_id: o.rule_id || '', work_type: v.work_type, title: v.title, description: v.description,
          parts: v.parts, performer: v.performer, staff_id: st ? st.id : '', ts: new Date(ts).toISOString(), status: 'done',
          duration_min: v.duration_min, downtime_min: v.downtime_min };
        if (v.duration_min > 0) p.started = new Date(ts - v.duration_min * 60000).toISOString();
        if (meter && v.meter_value !== null && v.meter_value !== undefined) p.meter_value = v.meter_value;
        return Api.write('work', p, { wait: 6000 }).then(function (r) {
          // пам’ять пристрою переповнена: запис прийнято в чергу вкладки й надішлеться — це не відмова
          // (попередження показує App); повторне «Записати» створило б дубль
          if (!r.ok && !memQueued(r)) {
            if (r.op) Api.discardRejected(r.op.op_id);
            throw new Error(r.message || 'Сервер відхилив запис');
          }
          if (memQueued(r)) UI.toast('Роботу прийнято, але пам’ять пристрою заповнена — не закривайте застосунок, доки запис не надішлеться', { tone: 'warn', ms: 8000 });
          else if (r.queued) UI.toast('Роботу збережено на пристрої — надішлеться автоматично, щойно буде зв’язок', { tone: 'info' });
          else {
            var nd = r.data && r.data.due;
            UI.toast('Роботу записано' + (nd ? ' · строк ТО: ' + (lbl('due_status', nd.status) || '').toLowerCase() : ''), { tone: 'ok' });
          }
          touched();
          return true;
        });
      } }]
    });
    md.result.then(function (v) { if (v && onDone) onDone(v); });
  }
  /* Api.write: запис у черзі лише в пам’яті вкладки (сховище пристрою переповнене) — надішлеться, це не відмова */
  function memQueued(r) { return !!(r && !r.ok && r.queued && r.error === 'STORAGE_FULL'); }
  /* перевірка числових полів: сирий текст не число / межі */
  function numErrs(root, v, errs, spec) {
    Object.keys(spec).forEach(function (k) {
      var inp = root.querySelector('[name="' + k + '"]');
      if (!inp || errs[k]) return;
      var raw = String(inp.value || '').trim(), s = spec[k];
      if (!raw) { if (s.required) errs[k] = 'Заповніть поле'; return; }
      var n = v[k];
      if (n === null || n === undefined || isNaN(n)) { errs[k] = 'Введіть число'; return; }
      if (s.int && Math.round(n) !== n) errs[k] = 'Ціле число';
      else if (s.min !== undefined && n < s.min) errs[k] = s.min === 0 ? 'Не може бути відʼємним' : 'Не менше ' + nf(s.min);
      else if (s.gt !== undefined && n <= s.gt) errs[k] = 'Має бути більше ' + nf(s.gt);
      else if (s.max !== undefined && n > s.max) errs[k] = 'Не більше ' + nf(s.max);
    });
    return errs;
  }

  /* ------------------------------ спільні блоки ------------------------------ */
  var MON_SHORT = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];
  var MON_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
  function card(title, body, o) {
    o = o || {};
    return '<section class="card m-card' + (o.cls ? ' ' + o.cls : '') + '"' + (o.id ? ' id="' + esc(o.id) + '"' : '') + '><div class="card-head">' + (o.icon ? icon(o.icon, 20) : '') +
      '<span class="m-ch-t">' + esc(title) + '</span>' + (o.hint ? '<span class="hint">' + esc(o.hint) + '</span>' : '') + (o.act ? '<span class="m-ch-act">' + o.act + '</span>' : '') +
      '</div><div class="card-body' + (o.flush ? ' flush' : '') + '">' + body + '</div></section>';
  }
  function kpi(o) {
    var tag = o.href ? 'a' : 'div';
    return '<' + tag + ' class="m-kpi k-' + (o.tone || 'neutral') + '"' + (o.href ? ' href="' + esc(o.href) + '"' : '') + '>' +
      '<span class="m-kpi-l">' + (o.icon ? icon(o.icon, 18) : '') + '<span>' + esc(o.label) + '</span></span>' +
      '<b class="m-kpi-v">' + o.value + '</b>' + (o.sub ? '<span class="m-kpi-s">' + o.sub + '</span>' : '') + '</' + tag + '>';
  }
  function issuesBox(issues) {
    if (!issues || !issues.length) return '';
    var why = {
      no_id: 'рядок без ID — застосунок його пропускає; задайте унікальний ID або видаліть порожній рядок',
      duplicate: 'повторений ID — діє лише перший рядок з цим ID; задайте іншому рядку унікальний ID',
      bad_pin: 'PIN некоректний (має бути 4–8 цифр) — вхід за PIN не працює; введіть PIN у стовпець «PIN» ще раз (формат «Звичайний текст», напр. 0427) або задайте його в розділі «Персонал»'
    };
    return '<div class="box err m-issues" role="alert">' + icon('alert') + '<div><b>У Google-таблиці є рядки довідників, які потребують виправлення (' + issues.length + ').</b>' +
      '<ul>' + issues.slice(0, 12).map(function (x) {
        return '<li>Аркуш «' + esc(x.sheet) + '»: ' + (x.id ? 'ID <span class="mono">' + esc(x.id) + '</span>' : '') + (x.name ? ' «' + esc(x.name) + '»' : '') + ' — ' + esc(why[x.problem] || 'помилка в рядку (' + x.problem + ')') + '</li>';
      }).join('') + (issues.length > 12 ? '<li>… та ще ' + (issues.length - 12) + '</li>' : '') + '</ul>' +
      '<p class="small">Відкрийте Google-таблицю й виправте ці рядки — після оновлення даних повідомлення зникне.</p></div></div>';
  }
  /* ID людей із некоректним PIN у таблиці (config_issues bad_pin) */
  function badPinIds(issues) {
    var o = {};
    (issues || []).forEach(function (x) { if (x.problem === 'bad_pin' && x.id) o[x.id] = 1; });
    return o;
  }

  /* ================================= ОГЛЯД ================================= */
  function repairsSince(fromKey, force) {
    var c = cache.rep;
    if (!force && c && c.from === fromKey && Date.now() - c.at < 30000) return Promise.resolve(c);
    return once('rep' + cache.gen, function () {
      return Api.call('history', { from: fromKey, types: ['events'], q: 'ремонт', include_void: false, limit: 2000 }).then(function (r) {
        if (!r.ok) return { ok: false };
        var n = r.events.filter(function (e) { return e.state === 'repair' && !e.void && App.line(e.line_id); }).length;
        cache.rep = { ok: true, from: fromKey, at: Date.now(), count: n };
        return cache.rep;
      });
    });
  }
  /* період показників огляду: 7 / 14 / 30 / 62 дні до сьогодні або свій (з … по …, не довше 62 днів) */
  var OV_DAYS = [7, 14, 30, 62], OV_MAX = 62;
  var oState = { period: '14', from: '', to: '' };
  function daysText(n) { return n + ' ' + fmt.plural(n, ['день', 'дні', 'днів']); }
  function keyShort(k) { return k.slice(8, 10) + '.' + k.slice(5, 7) + (k.slice(0, 4) === todayKey().slice(0, 4) ? '' : '.' + k.slice(0, 4)); }
  function keyDate(k) { return k.slice(8, 10) + '.' + k.slice(5, 7) + '.' + k.slice(0, 4); }
  function ovRange() {
    var tk = todayKey();
    if (oState.period === 'custom' && isKey(oState.from) && isKey(oState.to)) {
      var to = oState.to > tk ? tk : oState.to, from = oState.from > to ? to : oState.from, cut = false;
      if (U.keyDiff(from, to) + 1 > OV_MAX) { from = keyAdd(to, -(OV_MAX - 1)); cut = true; }
      return { custom: true, from: from, to: to, days: U.keyDiff(from, to) + 1, cut: cut };
    }
    var n = OV_DAYS.indexOf(+oState.period) >= 0 ? +oState.period : 14;
    return { custom: false, from: keyAdd(tk, -(n - 1)), to: tk, days: n };
  }
  function rangeText(rg) {
    if (!rg.custom) return daysText(rg.days);
    return rg.from === rg.to ? keyShort(rg.from) : keyShort(rg.from) + ' – ' + keyShort(rg.to);
  }
  /* поточний (back=0) або попередній (back=1) календарний місяць */
  function monthRange(back) {
    var tk = todayKey(), first = tk.slice(0, 8) + '01';
    if (!back) return { from: first, to: tk };
    var last = keyAdd(first, -1);
    return { from: last.slice(0, 8) + '01', to: last };
  }
  /* показники за період: до сьогодні — dashboard {days}; минулий період — {from, to}.
     Сервер, який не знає from/to, повертає останні дні — такі дані не видаємо за інший період. */
  function getDashRange(rg, maxAge) {
    if (rg.to === todayKey()) return getDash(rg.days, maxAge);
    var key = rg.from + ':' + rg.to, c = cache.dash[key], g = cache.gen;
    if (c && c.gen === g && Date.now() - c.at < (maxAge === undefined ? 30000 : maxAge)) return Promise.resolve(c.r);
    return once('dash' + key + ':' + g, function () {
      return Api.call('dashboard', { days: rg.days, from: rg.from, to: rg.to }).then(function (r) {
        if (r.ok && (!r.days || r.days[0] !== rg.from || r.days[r.days.length - 1] !== rg.to)) {
          return { ok: false, error: 'RANGE', message: 'Сервер не підтримує показники за минулий період — оновіть серверну частину (Apps Script) до поточної версії застосунку. Періоди, що закінчуються сьогодні, доступні й зараз.' };
        }
        if (r.ok && g === cache.gen) cache.dash[key] = { r: r, at: Date.now(), gen: g };
        return r;
      });
    });
  }
  function dashAt(rg) { var c = cache.dash[rg.to === todayKey() ? rg.days : rg.from + ':' + rg.to]; return c ? c.at : Date.now(); }
  /* роботи за період: простій лінії за записами робіт і зведення за агрегатами */
  function worksIn(rg, force) {
    var key = rg.from + ':' + rg.to, c = cache.works, g = cache.gen;
    if (!force && c && c.key === key && c.gen === g && Date.now() - c.at < 30000) return Promise.resolve(c.r);
    return once('works' + key + ':' + g, function () {
      return Api.call('history', { from: rg.from, to: rg.to, types: ['works'], include_void: false, limit: 5000 }).then(function (r) {
        if (r.ok && g === cache.gen) cache.works = { key: key, gen: g, at: Date.now(), r: r };
        return r;
      });
    });
  }
  /* зведення робіт по лініях і агрегатах: кількість за видами, простій лінії («Простій лінії, хв» у записі роботи) */
  function worksAgg(works) {
    var line = {}, unit = {}, units = [], order = {};
    App.lines().forEach(function (l, i) { order[l.id] = i; });
    (works || []).forEach(function (w) {
      if (w.void || !App.line(w.line_id)) return;
      var dm = +w.downtime_min > 0 ? +w.downtime_min : 0, uk = w.line_id + '|' + (w.unit_id || '');
      var L = line[w.line_id] || (line[w.line_id] = { n: 0, types: {}, down: 0, downN: 0 });
      var u = unit[uk];
      if (!u) { u = unit[uk] = { line_id: w.line_id, unit_id: w.unit_id || '', n: 0, types: {}, down: 0, downN: 0, last: null }; units.push(u); }
      [L, u].forEach(function (a) { a.n++; a.types[w.work_type] = (a.types[w.work_type] || 0) + 1; a.down += dm; if (dm) a.downN++; });
      if (!u.last || Date.parse(w.ts) > Date.parse(u.last)) u.last = w.ts;
    });
    units.sort(function (a, b) { return (b.down - a.down) || (b.n - a.n) || (order[a.line_id] - order[b.line_id]) || unitName(a.unit_id).localeCompare(unitName(b.unit_id), 'uk'); });
    return { line: line, units: units };
  }
  var NO_WORKS = { n: 0, types: {}, down: 0, downN: 0 };
  function typesText(types) {
    var ks = Object.keys(LBL.work_type).filter(function (k) { return types[k]; });
    Object.keys(types).forEach(function (k) { if (!LBL.work_type[k]) ks.push(k); });
    return ks.map(function (k) { return (LBL.work_type[k] || k) + ' ' + types[k]; }).join(' · ');
  }
  /* хвилини простою → «45 хв», «3 год 20 хв» (без переходу в доби — це сума простоїв) */
  function minText(m) {
    m = Math.round(m || 0);
    if (m < 60) return m + ' хв';
    return Math.floor(m / 60) + ' год' + (m % 60 ? ' ' + (m % 60) + ' хв' : '');
  }
  function overviewView(p, host, ctx) {
    if (p.days && OV_DAYS.indexOf(+p.days) >= 0) oState.period = String(+p.days);
    if (isKey(p.from) && isKey(p.to)) { oState.period = 'custom'; oState.from = p.from; oState.to = p.to; }
    var sh = shell(host, 'overview', { title: 'Огляд' });
    sh.body.innerHTML = '<div class="m-ov-now"></div><div class="m-filters m-ovp no-print"></div><div class="m-ov-per" aria-live="polite"></div>';
    var nowEl = sh.body.querySelector('.m-ov-now'), barEl = sh.body.querySelector('.m-ovp'), perEl = sh.body.querySelector('.m-ov-per');
    var st = { d: null, k: null, err: null, rep: null, w: null, wErr: null, rg: null, at: 0, showAll: false, unitsAll: false, seq: 0 };
    function head() {
      sh.setHead({ title: 'Огляд', sub: freshSub(st.at), actions: actBtn('csv', 'CSV', 'download', { title: 'Звіт по лініях і агрегатах за вибраний період — для Excel' }) + actBtn('refresh', 'Оновити', 'refresh') });
    }
    /* дані за останні 7 днів для KPI: з показників періоду, якщо він їх охоплює */
    function kpiData() { var rg = st.rg; return rg && st.d && rg.to === todayKey() && rg.days >= 7 ? st.d : st.k; }
    function kpis() {
      var lines = App.lines(), by = {}, run = 0;
      lines.forEach(function (l) { var s = App.lineStatus(l.id); by[s.state] = (by[s.state] || 0) + 1; if (s.state === 'run') run++; });
      var other = UI.STATES.filter(function (s) { return s !== 'run' && by[s]; }).map(function (s) { return by[s] + ' — ' + UI.stateLabel(s).toLowerCase(); }).join(', ');
      var due = 0, soon = 0;
      ((App.state && App.state.due) || []).forEach(function (x) { if (!App.line(x.line_id)) return; if (x.status === 'due') due++; else if (x.status === 'soon') soon++; });
      var h = kpi({ label: 'Працюють зараз', icon: 'play', value: run + '<small> з ' + lines.length + '</small>', sub: esc(other || (lines.length ? 'усі лінії в роботі' : 'ліній немає')), tone: run ? 'ok' : 'neutral' }) +
        kpi({ label: 'Прострочено ТО', icon: 'alert', value: String(due), sub: due ? 'потрібно виконати' : 'усе вчасно', tone: due ? 'bad' : 'ok', href: '#/m/maintenance?tab=due&status=due' }) +
        kpi({ label: 'Скоро ТО', icon: 'clock', value: String(soon), sub: soon ? 'наближається строк' : 'найближчим часом немає', tone: soon ? 'warn' : 'ok', href: '#/m/maintenance?tab=due&status=soon' });
      var d = kpiData();
      if (d) {
        var keys = d.days.slice(-7), set = {}, starts = 0, cov = 0, stopH = 0, repH = 0;
        keys.forEach(function (k) { set[k] = 1; });
        lines.forEach(function (l) {
          (d.compliance[l.id] || []).forEach(function (x) { if (set[x.day]) { starts += x.starts; cov += x.covered; } });
          (d.daily[l.id] || []).forEach(function (x) { if (set[x.day]) { stopH += x.hours.stop || 0; repH += x.hours.repair || 0; } });
        });
        var pc = starts ? cov / starts * 100 : null;
        h += kpi({ label: 'Чек-листи запуску · 7 дн.', icon: 'checklist', value: pc === null ? '—' : nf(pc, 0) + '<small> %</small>',
          sub: starts ? cov + ' з ' + starts + ' ' + fmt.plural(starts, ['запуску', 'запусків', 'запусків']) + ' із чек-листом' : 'запусків не було',
          tone: pc === null ? 'neutral' : pc >= 95 ? 'ok' : pc >= 80 ? 'warn' : 'bad', href: '#/m/checks' });
        h += kpi({ label: 'Простої · 7 дн.', icon: 'pause', value: nf(stopH, stopH < 10 ? 1 : 0) + '<small> год</small>', sub: 'ремонт: ' + esc(fmt.hours(repH)), tone: 'neutral', href: '#/m/journal?types=events&q=' + encodeURIComponent('простій') });
      } else {
        h += kpi({ label: 'Чек-листи запуску · 7 дн.', icon: 'checklist', value: '…', tone: 'neutral' }) + kpi({ label: 'Простої · 7 дн.', icon: 'pause', value: '…', tone: 'neutral' });
      }
      var rn = st.rep && st.rep.ok ? st.rep.count : null;
      h += kpi({ label: 'Ремонти · 7 дн.', icon: 'wrench', value: rn === null ? '…' : String(rn), sub: rn === null ? '' : rn ? 'переходів у стан «Ремонт»' : 'аварійних зупинок не було',
        tone: rn ? 'warn' : rn === 0 ? 'ok' : 'neutral', href: '#/m/journal?types=events&q=' + encodeURIComponent('ремонт') });
      return '<div class="m-kpis">' + h + '</div>';
    }
    function statusTable() {
      var S = (App.state && App.state.settings) || {};
      var rows = App.lines().map(function (l) { return { l: l, s: App.lineStatus(l.id), due: App.dueFor(l.id) }; });
      return rtable([
        { label: 'Лінія', cls: 'm-rt-main', html: function (r) { return '<b>' + esc(r.l.name) + '</b>' + (r.l.kind ? '<small class="dim">' + esc(r.l.kind) + '</small>' : ''); } },
        { label: 'Стан', cls: 'm-span', html: function (r) {
          var rs = (r.s.state === 'stop' || r.s.state === 'repair' || r.s.state === 'maint' || r.s.state === 'setup') ? r.s.reason : '';
          var t = App.liveTodayHours(r.s);
          return UI.statusPill(r.s.state, { size: 'sm', since: r.s.since, pending: !!r.s.pending }) + (rs ? '<small class="muted">' + esc(rs) + '</small>' : '') +
            '<small class="dim">сьогодні ' + (t > 0.004 ? 'в роботі ' + esc(fmt.hm(t)) : 'не працювала') + '</small>';
        } },
        { label: 'Продукт · оператор', html: function (r) { return (r.s.product ? esc(r.s.product) : '') + (r.s.operator ? '<small class="muted">' + icon('user', 14) + ' ' + esc(r.s.operator) + '</small>' : ''); } },
        { label: 'Останній чек-лист', html: function (r) {
          var c = r.s.last_check;
          if (!c || !c.ts) return '';
          return esc(lbl('occasion', c.occasion)) + ' · ' + esc(fmt.dt(c.ts)) + ' ' + resultBadge(c.result);
        } },
        { label: 'ТО', cls: 'm-st-to', html: function (r) {
          var nd = 0, ns = 0;
          r.due.forEach(function (d) { if (d.status === 'due') nd++; else if (d.status === 'soon') ns++; });
          var b = [];
          if (nd) b.push(UI.badge('прострочено ' + nd, 'due', { icon: 'alert' }));
          if (ns) b.push(UI.badge('скоро ' + ns, 'soon'));
          // те саме правило, що й на плитці та екрані лінії: пізній чек-лист закриває питання,
          // довга зміна після чек-листа — не порушення (для неї окрема позначка long_run)
          if (App.checkMissing(r.s)) b.push(UI.badge('без чек-листа', 'bad', { icon: 'checklist' }));
          if (r.s.long_run) b.push(UI.badge('понад ' + fmt.num(S.long_run_hours || 16) + ' год без завершення', 'soon', { icon: 'clock' }));
          return b.length ? '<div class="badges">' + b.join('') + '</div>' : '<span class="c-ok small">у нормі</span>';
        } }
      ], rows, { cls: 'm-wide', empty: 'Ліній немає — додайте їх у розділі «Обладнання»', attrs: function (r) { return { 'data-open': r.l.id, class: 'clickable', tabindex: '0', title: 'Відкрити лінію' }; } });
    }
    function hoursHtml(d, lines, rg) {
      var WS = UI.STATES.filter(function (s) { return s !== 'off'; });
      return '<div class="m-hss">' + lines.map(function (l) {
        var s = d.stats[l.id];
        if (!s) return '';
        var h = s.hours || {}, work = 0;
        WS.forEach(function (x) { work += h[x] || 0; });
        var parts = WS.map(function (x) { return { value: h[x] || 0, color: UI.stateColor(x), label: UI.stateLabel(x), valueText: fmt.hours(h[x] || 0) }; });
        var cols = (d.daily[l.id] || []).map(function (dd) {
          var hh = dd.hours || {}, segs = '', t = [];
          WS.forEach(function (x) {
            if (!(hh[x] > 0.01)) return;
            segs += '<i style="height:' + Math.min(100, hh[x] / 24 * 100).toFixed(1) + '%;background:' + UI.stateColor(x) + '"></i>';
            t.push(UI.stateLabel(x).toLowerCase() + ' ' + fmt.hm(hh[x]));
          });
          return '<span class="m-dc-c" title="' + esc(fmt.dayLabel(dd.day) + ': ' + (t.length ? t.join(', ') : 'не працювала')) + '">' + segs + '</span>';
        }).join('');
        return '<div class="m-hs"><div class="m-hs-h"><b>' + esc(l.name) + '</b><span class="num">робота ' + esc(fmt.hours(h.run || 0)) + '</span></div>' +
          UI.stackBar(parts, { height: 16 }) +
          '<div class="m-dc' + (cols && d.days.length > 31 ? ' m-dc-dense' : '') + '" aria-hidden="true">' + cols + '</div>' +
          '<div class="m-hs-f">' + WS.filter(function (x) { return x !== 'run' && h[x] > 0.01; }).map(function (x) {
            return '<span><i style="background:' + UI.stateColor(x) + '"></i>' + esc(UI.stateLabel(x)) + ' ' + esc(fmt.hours(h[x])) + '</span>';
          }).join('') + '<span class="dim">не працювала ' + esc(fmt.hours(h.off || 0)) + '</span></div></div>';
      }).join('') + '</div>' + UI.stateLegend(WS) + '<p class="dim small m-note">Стовпчики — доби (висота = 24 год), смуга — сумарно за ' + esc(rg.custom ? 'період ' + rangeText(rg) : rangeText(rg)) + ' без часу, коли лінія не працювала.</p>';
    }
    function stopsHtml(d, lines) {
      var agg = {}, per = {}, tot = 0;
      lines.forEach(function (l) {
        var sb = (d.stats[l.id] || {}).stops_by_reason || {};
        Object.keys(sb).forEach(function (k) { if (!(sb[k] > 0)) return; agg[k] = (agg[k] || 0) + sb[k]; tot += sb[k]; (per[k] = per[k] || []).push(l.name + ': ' + fmt.hm(sb[k])); });
      });
      var items = Object.keys(agg).filter(function (k) { return agg[k] > 0.005; }).sort(function (a, b) { return agg[b] - agg[a]; }).map(function (k) {
        return { label: k, value: agg[k], color: 'var(--st-stop)', valueText: fmt.hm(agg[k]), title: per[k].join('\n') };
      });
      return UI.bars(items, { empty: 'Простоїв за період не було' }) + (items.length ? '<p class="m-total">Разом простоїв: <b>' + esc(fmt.hm(tot)) + '</b></p>' : '');
    }
    /* звіт по лініях: робота, простої, ремонти (переходи в «Ремонт» і години), роботи за видами, простій за записами робіт */
    function reportRows(d, lines) {
      var wa = st.w, tot = { total: true, h: {}, s: { starts: 0, repairs: 0, repair_h: 0 }, w: wa ? { n: 0, types: {}, down: 0, downN: 0 } : null };
      var rows = lines.filter(function (l) { return d.stats[l.id]; }).map(function (l) {
        var s = d.stats[l.id], h = s.hours || {}, w = wa ? wa.line[l.id] || NO_WORKS : null;
        UI.STATES.forEach(function (x) { tot.h[x] = (tot.h[x] || 0) + (h[x] || 0); });
        tot.s.starts += s.starts || 0; tot.s.repairs += s.repairs || 0; tot.s.repair_h += s.repair_h || 0;
        if (w) {
          tot.w.n += w.n; tot.w.down += w.down; tot.w.downN += w.downN;
          Object.keys(w.types).forEach(function (k) { tot.w.types[k] = (tot.w.types[k] || 0) + w.types[k]; });
        }
        return { l: l, h: h, s: s, w: w };
      });
      if (rows.length > 1) rows.push(tot);
      return rows;
    }
    function reportHtml(d, lines) {
      var rows = reportRows(d, lines), pend = !st.w && !st.wErr;
      var wCell = function (r, fn) { return r.w ? fn(r.w) : pend ? '<span class="dim">…</span>' : '<span class="dim">—</span>'; };
      var h = st.wErr ? '<div class="box warn m-rep-note">' + icon('alert') + '<span>Роботи за період не завантажено: ' + esc(errText(st.wErr, true)) + '</span></div>' : '';
      if (st.w && st.w.truncated) h += '<div class="box warn m-rep-note">' + icon('alert') + '<span>Робіт за період понад 5000 — враховано лише останні. Виберіть коротший період.</span></div>';
      return h + rtable([
        { label: 'Лінія', cls: 'm-rt-main', html: function (r) { return r.total ? '<b>Усі лінії</b>' : '<b>' + esc(r.l.name) + '</b>'; } },
        { label: 'Робота', html: function (r) { return '<b class="num">' + esc(fmt.hours(r.h.run || 0)) + '</b><small class="dim">' + esc('запусків: ' + (r.s.starts || 0)) + '</small>'; } },
        { label: 'Простої', html: function (r) { return '<span class="num">' + esc(fmt.hours(r.h.stop || 0)) + '</span>'; } },
        { label: 'Ремонти', html: function (r) {
          var n = r.s.repairs || 0, rh = r.s.repair_h || 0;
          return '<b class="num' + (n ? ' c-warn' : '') + '">' + n + '</b>' + (rh > 0.004 ? '<small class="dim">' + esc(fmt.hours(rh)) + ' у ремонті</small>' : '');
        } },
        { label: 'Роботи', cls: 'm-rep-w', html: function (r) {
          return wCell(r, function (w) { return '<b class="num">' + w.n + '</b>' + (w.n ? '<small class="dim">' + esc(typesText(w.types)) + '</small>' : ''); });
        } },
        { label: 'Простій за роботами', html: function (r) {
          return wCell(r, function (w) {
            return w.down > 0 ? '<b class="num">' + esc(minText(w.down)) + '</b><small class="dim">' + esc(w.downN + ' ' + fmt.plural(w.downN, ['запис', 'записи', 'записів']) + ' з простоєм') + '</small>' : '<span class="dim">—</span>';
          });
        } }
      ], rows, { cls: 'm-rep m-wide', empty: 'Ліній немає', attrs: function (r) {
        return r.total ? { class: 'm-tot' } : { 'data-open': 'L|' + r.l.id, class: 'clickable', tabindex: '0', title: 'Журнал лінії за період' };
      } }) + '<p class="dim small m-note">Ремонти — переходи лінії в стан «Ремонт» і час у ньому. Роботи — записи налаштувань, ремонтів, ТО і ППР; простій за роботами — сума поля «Простій лінії, хв» у цих записах.</p>';
    }
    function unitsHtml() {
      if (st.wErr) return '<div class="list"><div class="list-empty">Роботи за період не завантажено</div></div>';
      if (!st.w) return UI.spinner('Завантаження робіт…');
      var list = st.w.units, show = st.unitsAll ? list : list.slice(0, 10);
      if (!list.length) return '<div class="list"><div class="list-empty">За період робіт не записано</div></div>';
      return rtable([
        { label: 'Агрегат', cls: 'm-rt-main', html: function (u) {
          return '<b>' + esc(u.unit_id ? unitName(u.unit_id) : 'Лінія загалом (без агрегата)') + '</b><small class="dim">' + esc(lineName(u.line_id)) + '</small>';
        } },
        { label: 'Роботи', cls: 'm-rep-w', html: function (u) { return '<b class="num">' + u.n + '</b><small class="dim">' + esc(typesText(u.types)) + '</small>'; } },
        { label: 'Простій за роботами', html: function (u) { return u.down > 0 ? '<b class="num">' + esc(minText(u.down)) + '</b>' : '<span class="dim">—</span>'; } },
        { label: 'Остання робота', html: function (u) { return u.last ? '<span class="num">' + esc(fmt.dt(u.last)) + '</span>' : ''; } }
      ], show, { cls: 'm-rep m-rep-u', attrs: function (u) { return { 'data-open': 'U|' + u.line_id + '|' + u.unit_id, class: 'clickable', tabindex: '0', title: 'Роботи в журналі' }; } }) +
        (list.length > show.length ? '<div class="btn-row m-more"><button type="button" class="btn sm ghost" data-m="units-all">Показати всі (' + list.length + ')</button></div>' : '');
    }
    function issuesHtml(list) {
      if (!list.length) return '<div class="list"><div class="list-empty">За період зауважень у чек-листах і ремонтів не було</div></div>';
      var show = st.showAll ? list : list.slice(0, 8);
      return '<div class="list m-iss">' + show.map(function (it, i) {
        return '<button type="button" class="list-item m-li-btn" data-iss="' + i + '"><span class="m-iss-ic k-' + esc(it.kind) + '">' + icon(it.kind === 'repair' ? 'wrench' : 'alert', 20) + '</span>' +
          '<div class="li-main"><div class="li-t">' + esc(it.text) + (it.value ? ' — <span class="m-iss-v">' + esc(it.value) + '</span>' : '') + '</div>' +
          '<div class="li-s">' + esc([lineName(it.line_id), it.kind === 'answer' ? lbl('occasion', it.occasion) : '', it.operator, fmt.dt(it.ts)].filter(Boolean).join(' · ')) + '</div>' +
          (it.note ? '<div class="li-s m-iss-n">' + esc(it.note) + '</div>' : '') + '</div>' + icon('next', 20, 'dim') + '</button>';
      }).join('') + '</div>' + (list.length > show.length ? '<div class="btn-row m-more"><button type="button" class="btn sm ghost" data-m="more">Показати всі (' + list.length + ')</button></div>' : '');
    }
    /* перемикач періоду: окремий блок, не перемальовується разом із даними (щоб не збивати введення дат) */
    function drawBar() {
      var rg = ovRange(), tk = todayKey(), cust = oState.period === 'custom';
      barEl.innerHTML = '<div class="m-frow"><div class="m-fl"><span>Показники за період</span>' + UI.segmented({ name: 'ov_period', value: oState.period, size: 'sm', label: 'Період показників',
        options: OV_DAYS.map(function (n) { return { value: String(n), label: daysText(n) }; }).concat([{ value: 'custom', label: 'Свій' }]) }) + '</div>' +
        (cust ? '<label class="m-fl"><span>З</span><input class="inp" type="date" name="ov_from" value="' + esc(rg.from) + '" max="' + esc(tk) + '"></label>' +
          '<label class="m-fl"><span>По</span><input class="inp" type="date" name="ov_to" value="' + esc(rg.to) + '" max="' + esc(tk) + '"></label>' +
          '<div class="m-fl"><span>Швидкий вибір</span><div class="m-ovp-q">' + actBtn('month-0', 'Цей місяць', '', { tone: 'ghost' }) + actBtn('month-1', 'Минулий місяць', '', { tone: 'ghost' }) + '</div></div>' : '') +
        '</div><p class="dim small m-fhint m-ovp-h"' + (cust && rg.cut ? '' : ' hidden') + '>Період — не довше ' + OV_MAX + ' днів: показано ' + esc(rangeText(rg)) + '.</p>';
    }
    function syncHint() {
      var rg = ovRange(), el = barEl.querySelector('.m-ovp-h');
      if (!el) return;
      el.hidden = !(oState.period === 'custom' && rg.cut);
      el.textContent = 'Період — не довше ' + OV_MAX + ' днів: показано ' + rangeText(rg) + '.';
    }
    function drawNow() {
      nowEl.innerHTML = kpis() + (cache.admin ? issuesBox(cache.admin.config_issues) : '') +
        card('Стан ліній', statusTable(), { icon: 'grid', hint: 'рядок — відкрити лінію', flush: true, cls: 'm-card-tbl' });
    }
    function drawPer() {
      var lines = App.lines(), d = st.d, rg = st.rg || ovRange(), pt = rangeText(rg);
      if (st.err) { perEl.innerHTML = errBox(st.err, 'retry'); return; }
      if (!d) { perEl.innerHTML = UI.spinner('Завантаження показників…'); return; }
      var iss = d.issues || [];
      perEl.innerHTML = card('Щоденні перевірки · ' + pt, matrixHtml(d, lines), { icon: 'checklist', hint: 'клітинка — подробиці дня' }) +
        card('Роботи, ремонти й простої · ' + pt, reportHtml(d, lines), { icon: 'wrench', hint: 'рядок — записи в журналі', flush: true, cls: 'm-card-tbl m-card-rep' }) +
        '<div class="m-grid2">' + card('Години за станами · ' + pt, hoursHtml(d, lines, rg), { icon: 'activity' }) +
        card('Причини простоїв · ' + pt, stopsHtml(d, lines), { icon: 'pause' }) + '</div>' +
        card('Агрегати: роботи й простій · ' + pt, unitsHtml(), { icon: 'box', hint: 'рядок — роботи в журналі', flush: true, cls: 'm-card-tbl' }) +
        card('Зауваження та ремонти · ' + pt, issuesHtml(iss), { icon: 'alert', flush: true, hint: iss.length >= 30 ? 'останні 30' : '' });
    }
    function draw() {
      if (!ctx.alive()) return;
      head();
      drawNow();
      drawPer();
    }
    function load(force) {
      var seq = ++st.seq, rg = ovRange(), tk = todayKey(), same = st.rg && st.rg.from === rg.from && st.rg.to === rg.to;
      if (!same) { st.d = null; st.w = null; st.err = null; st.wErr = null; st.showAll = false; st.unitsAll = false; }
      st.rg = rg;
      var pd = getDashRange(rg, force ? 0 : 30000), pr = repairsSince(keyAdd(tk, -6), force);
      var pk = rg.to === tk && rg.days >= 7 ? null : getDash(7, force ? 0 : 30000);
      var pw = worksIn(rg, force);
      loadAdmin(false).then(function (a) { if (ctx.alive() && a.ok && a.config_issues && a.config_issues.length && !sh.body.querySelector('.m-issues')) drawNow(); });
      if (!same) drawPer();
      pw.then(function (r) {
        if (!ctx.alive() || seq !== st.seq) return;
        if (r.ok) { st.w = worksAgg(r.works); st.w.truncated = !!(r.truncated && r.truncated.works); st.wErr = null; } else { st.w = null; st.wErr = r; }
        if (st.d) drawPer();
      });
      return Promise.all([pd, pr, pk]).then(function (res) {
        if (!ctx.alive() || seq !== st.seq) return;
        if (res[0].ok) { st.d = res[0]; st.err = null; st.at = dashAt(rg); } else { st.d = null; st.err = res[0]; }
        st.rep = res[1];
        st.k = res[2] && res[2].ok ? res[2] : null;
        draw();
      });
    }
    /* звіт по лініях і агрегатах за період — CSV для Excel */
    function exportCsv() {
      var d = st.d, rg = st.rg, wa = st.w;
      if (!d || !rg) { UI.toast(st.err ? 'Немає показників для вивантаження' : 'Показники ще завантажуються', { tone: 'info' }); return; }
      var rows = [];
      App.lines().forEach(function (l) {
        var s = d.stats[l.id];
        if (!s) return;
        var cov = 0;
        (d.compliance[l.id] || []).forEach(function (x) { cov += x.covered; });
        rows.push({ line: l.name, unit: '', s: s, cov: cov, w: wa ? wa.line[l.id] || NO_WORKS : null });
        if (wa) wa.units.filter(function (u) { return u.line_id === l.id; }).forEach(function (u) {
          rows.push({ line: l.name, unit: u.unit_id ? unitName(u.unit_id) : 'без агрегата', s: null, w: u });
        });
      });
      var WT = Object.keys(LBL.work_type), r2 = function (v) { return Math.round((v || 0) * 100) / 100; };
      var cols = [
        { label: 'Лінія', csv: function (r) { return r.line; } },
        { label: 'Агрегат', csv: function (r) { return r.unit; } },
        { label: 'Період з', csv: function () { return keyDate(rg.from); } },
        { label: 'Період по', csv: function () { return keyDate(rg.to); } }
      ].concat(UI.STATES.map(function (x) {
        return { label: UI.stateLabel(x) + ', год', csv: function (r) { return r.s ? r2((r.s.hours || {})[x]) : ''; } };
      })).concat([
        { label: 'Запусків', csv: function (r) { return r.s ? r.s.starts || 0 : ''; } },
        { label: 'Запусків із чек-листом', csv: function (r) { return r.s ? r.cov : ''; } },
        { label: 'Ремонтів (переходів у «Ремонт»)', csv: function (r) { return r.s ? r.s.repairs || 0 : ''; } },
        { label: 'Робіт усього', csv: function (r) { return r.w ? r.w.n : ''; } }
      ]).concat(WT.map(function (k) {
        return { label: 'Робіт: ' + LBL.work_type[k], csv: function (r) { return r.w ? r.w.types[k] || 0 : ''; } };
      })).concat([
        { label: 'Простій за роботами, хв', csv: function (r) { return r.w ? Math.round(r.w.down) : ''; } }
      ]);
      UI.csv('zvit-linii-' + rg.from + '_' + rg.to + '.csv', cols, rows);
      if (!wa) UI.toast('Роботи за період ще не завантажено — стовпці робіт порожні', { tone: 'info' });
    }
    host.addEventListener('change', function (e) {
      var t = e.target, dn = e.detail && e.detail.name;
      if (dn === 'ov_period') {
        oState.period = e.detail.value || '14';
        if (oState.period === 'custom' && !(isKey(oState.from) && isKey(oState.to))) { var m0 = monthRange(0); oState.from = m0.from; oState.to = m0.to; }
        drawBar(); load(false);
        return;
      }
      if (t && (t.name === 'ov_from' || t.name === 'ov_to')) {
        if (!isKey(t.value)) return;
        oState[t.name === 'ov_from' ? 'from' : 'to'] = t.value;
        syncHint(); load(false);
      }
    });
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-m], [data-cell], [data-iss]');
      if (!b) return;
      if (b.hasAttribute('data-cell')) {
        var pc = b.getAttribute('data-cell').split('|'), x = st.d && findCell(st.d, pc[0], pc[1]);
        if (x) openDay(pc[0], pc[1], x, function () { load(true); });
        return;
      }
      if (b.hasAttribute('data-iss')) {
        var it = st.d && st.d.issues[+b.getAttribute('data-iss')];
        if (!it) return;
        if (it.check_id) openCheck(it.check_id, it.ts, function () { load(true); });
        else if (it.work_id) openById('works', it.work_id, it.ts, it.line_id, function () { load(true); });
        else if (it.event_id) openById('events', it.event_id, it.ts, it.line_id, function () { load(true); });
        return;
      }
      var a = b.getAttribute('data-m');
      if (a === 'refresh') { App.refresh(); load(true); }
      else if (a === 'retry') { st.err = null; st.rg = null; load(true); }
      else if (a === 'more') { st.showAll = true; drawPer(); }
      else if (a === 'units-all') { st.unitsAll = true; drawPer(); }
      else if (a === 'csv') exportCsv();
      else if (a === 'month-0' || a === 'month-1') {
        var m = monthRange(a === 'month-1' ? 1 : 0);
        oState.from = m.from; oState.to = m.to;
        drawBar(); load(false);
      }
    });
    bindRows(nowEl, function (id) { App.go('#/line/' + encodeURIComponent(id)); });
    /* рядок звіту → журнал за той самий період: лінія (стани й роботи) або агрегат (роботи) */
    bindRows(perEl, function (v) {
      var pv = String(v).split('|'), rg = st.rg;
      if (!rg) return;
      var q = '&from=' + rg.from + '&to=' + rg.to;
      if (pv[0] === 'L') App.go('#/m/journal?line=' + encodeURIComponent(pv[1]) + '&types=events,works' + q);
      else if (pv[0] === 'U') App.go('#/m/journal?line=' + encodeURIComponent(pv[1]) + (pv[2] ? '&unit=' + encodeURIComponent(pv[2]) : '') + '&types=works' + q);
    });
    head();
    drawBar();
    drawNow();
    load(false);
    return {
      onBoot: function (state, meta) { if (meta && meta.source === 'queue') { head(); drawNow(); } else load(false); },
      onQueue: function () { drawNow(); }
    };
  }
  /* запис журналу за id (з вікна ±1 доба) → подробиці */
  function openById(kind, id, ts, lineId, onDone) {
    var k = fmt.dayKey(ts);
    return Api.call('history', { from: keyAdd(k, -1), to: keyAdd(k, 1), line_id: lineId || undefined, types: [kind], limit: 5000 }).then(function (r) {
      if (!r.ok) { UI.alert({ title: 'Не вдалося відкрити запис', text: errText(r, true) }); return; }
      var row = findIn(r[kind], id);
      if (!row) { UI.alert({ title: 'Запис не знайдено', text: 'Можливо, його вже змінено або видалено з таблиці.' }); return; }
      openRecord(kind, row, onDone);
    });
  }

  /* ================================= ТО І ППР ================================= */
  var mState = { tab: 'due', line: '', unit: '', status: '', range: 30 };
  function critRow(c) {
    var name = { days: 'Календар', hours: 'Мотогодини', meter: 'Лічильник' }[c.kind] || c.kind;
    var u = c.kind === 'days' ? 'дн.' : c.kind === 'hours' ? 'мотогод' : (c.unit_label || 'од.');
    var s = c.pct >= 1 ? 'due' : c.pct >= 0.9 ? 'soon' : 'ok';
    var when = c.due_date ? (c.left <= 0 ? 'строк настав ' : 'строк ') + fmt.date(c.due_date) +
      (c.forecast ? ' — прогноз за середнім ' + nf(c.avg, 1) + ' ' + (c.kind === 'hours' ? 'год' : u) + ' на добу' : '') : 'немає даних про напрацювання для прогнозу';
    return '<div class="m-crit"><div class="m-crit-h"><b>' + esc(name) + '</b><span class="num">' + esc(nf(c.used, c.kind === 'days' ? 1 : 0)) + ' з ' + esc(nf(c.interval)) + ' ' + esc(u) +
      ' · ' + esc(fmt.frac(c.pct)) + '</span></div>' + UI.progress(c.pct, s) + '<div class="dim small">' + esc(when) + '</div></div>';
  }
  function dueWhen(d) {
    if (d.status === 'none') return 'інтервал не задано';
    if (!d.due_date) return 'строк невідомий — немає даних про напрацювання';
    return (d.status === 'due' ? 'строк настав ' : 'строк ') + fmt.date(d.due_date) + (d.forecast ? ' (прогноз)' : '');
  }
  function dueCard(d) {
    var u = d.unit_id ? unitName(d.unit_id) : '';
    return '<article class="m-due s-' + esc(d.status) + '">' +
      '<div class="m-due-top"><div class="m-due-tt"><h3>' + esc(d.title) + '</h3><div class="m-due-where">' + esc([lineName(d.line_id), u, d.part].filter(Boolean).join(' · ')) + '</div></div>' +
      dueBadge(d.status) + '</div>' +
      '<div class="m-due-prog">' + UI.progress(d.pct, d.status, { className: 'lg', label: 'Використано інтервалу' }) + '<span class="num">' + esc(d.pct === null ? '—' : fmt.frac(d.pct)) + '</span></div>' +
      '<div class="m-due-sum"><span>' + esc(d.summary) + '</span><span class="dim">' + esc(dueWhen(d)) + '</span></div>' +
      '<div class="m-due-foot"><span class="dim small">' + esc(lbl('work_type', d.work_type)) + (d.last_date ? ' · востаннє ' + esc(fmt.date(d.last_date)) : ' · у журналі ще не виконувалось') + '</span>' +
      '<span class="m-due-act"><button type="button" class="btn sm ghost" data-due-info="' + esc(d.rule_id) + '">' + icon('info', 18) + '<span>Деталі</span></button>' +
      '<button type="button" class="btn sm ' + (d.status === 'due' ? 'primary' : '') + '" data-due-done="' + esc(d.rule_id) + '">' + icon('check', 18) + '<span>Позначити виконаним</span></button></span></div></article>';
  }
  function dueInfo(d, onDone) {
    var r = ruleAny(d.rule_id) || {};
    var body = '<div class="m-due-st">' + dueBadge(d.status) + '<span>' + esc(d.summary) + '</span></div>' +
      (d.criteria || []).map(critRow).join('') +
      UI.kv([
        ['Лінія', esc(lineName(d.line_id))],
        d.unit_id ? ['Агрегат', esc(unitName(d.unit_id))] : null,
        d.part ? ['Деталь / вузол', esc(d.part)] : null,
        ['Вид роботи', esc(lbl('work_type', d.work_type))],
        ['Строк', esc(dueWhen(d).replace(/^строк /, ''))],
        ['Відлік від', esc(fmt.date(d.ref_date)) + (d.ref_work_id ? ' (остання робота в журналі)' : ' (початок обліку)')],
        ['Останнє виконання', d.last_date ? esc(fmt.datetime(d.last_date)) : '<span class="dim">у журналі ще немає</span>'],
        r.instructions ? ['Інструкція', '<div class="m-instr">' + esc(r.instructions) + '</div>'] : null
      ]);
    var md = UI.modal({
      title: d.title, size: 'md', className: 'm-modal', body: body,
      actions: [{ label: 'Регламент', icon: 'edit', tone: 'ghost', value: 'rule', className: 'm-foot-left' },
        { label: 'Позначити виконаним', icon: 'check', tone: 'primary', value: 'done' }]
    });
    md.result.then(function (v) {
      if (v === 'done') markDone(d, onDone);
      else if (v === 'rule') App.go('#/m/equipment/' + encodeURIComponent(d.line_id) + '?tab=rules&rule=' + encodeURIComponent(d.rule_id));
    });
  }
  function weekLabel(mon) {
    var sun = keyAdd(mon, 6), m1 = +mon.slice(5, 7), m2 = +sun.slice(5, 7);
    return m1 === m2 ? (+mon.slice(8)) + '–' + (+sun.slice(8)) + ' ' + MON_GEN[m2 - 1] : (+mon.slice(8)) + ' ' + MON_GEN[m1 - 1] + ' – ' + (+sun.slice(8)) + ' ' + MON_GEN[m2 - 1];
  }
  function monday(k) { return keyAdd(k, -((U.keyDow(k) + 6) % 7)); }
  function basisLabel(it) {
    return it.basis === 'hours' ? 'прогноз за мотогодинами' : it.basis === 'meter' ? 'прогноз за лічильником' : 'календарний строк';
  }
  function planRowHtml(it) {
    var u = it.unit_id ? unitName(it.unit_id) : '';
    var st = it.overdue ? 'due' : it.n === 1 ? it.status : 'ok';
    return '<div class="m-pl-row s-' + esc(st) + '"><span class="m-pl-d"><b>' + esc(it.day.slice(8) + '.' + it.day.slice(5, 7)) + '</b><small>' + esc(fmt.dayLabel(it.day).split(' ')[0]) + '</small></span>' +
      '<div class="m-pl-m"><b>' + esc(it.title) + '</b><small>' + esc([lineName(it.line_id), u, it.part].filter(Boolean).join(' · ')) + '</small></div>' +
      '<div class="m-pl-b">' + (it.overdue ? UI.badge('прострочено', 'due', { icon: 'alert' }) : it.n === 1 && it.status === 'soon' ? UI.badge('скоро', 'soon') : '') +
      UI.badge(lbl('work_type', it.work_type), 'muted') + '<span class="m-basis' + (it.forecast ? ' fc' : '') + '">' + esc(basisLabel(it)) + '</span></div>' +
      '<button type="button" class="btn sm ghost icon" data-plan-rule="' + esc(it.rule_id) + '" aria-label="Деталі регламенту" title="Деталі">' + icon('info', 20) + '</button></div>';
  }
  function yearHtml(plan) {
    var pr = planRange(), months = pr.months;
    var rules = (plan.rules || []).filter(function (r) { return App.line(r.line_id) && (!mState.line || r.line_id === mState.line) && (!mState.unit || r.unit_id === mState.unit); });
    if (!rules.length) return UI.emptyState({ icon: 'calendar', title: 'Немає робіт для графіка', text: 'Регламент ТО і ППР для вибраних ліній не задано або в правил немає інтервалів.' });
    var byRule = {};
    (plan.items || []).forEach(function (it) { (byRule[it.rule_id] = byRule[it.rule_id] || []).push(it); });
    var head = '<tr><th scope="col" class="m-yr-r">Робота</th>' + months.map(function (mo, i) {
      return '<th scope="col" class="' + (i === 0 ? 'cur' : '') + '" title="' + esc(fmt.monthName(mo.m) + ' ' + mo.y) + '"><b>' + esc(MON_SHORT[mo.m - 1]) + '</b>' + (i === 0 || mo.m === 1 ? '<small>' + mo.y + '</small>' : '') + '</th>';
    }).join('') + '</tr>';
    var body = '';
    App.lines().forEach(function (l) {
      var lr = rules.filter(function (r) { return r.line_id === l.id; });
      if (!lr.length) return;
      body += '<tr class="m-yr-line"><th colspan="13" scope="rowgroup">' + esc(l.name) + '</th></tr>';
      var groups = [{ id: '', name: 'Лінія загалом' }].concat(App.unitsOf(l.id).map(function (u) { return { id: u.id, name: u.name }; }));
      var seen = {};
      groups.forEach(function (g) { seen[g.id] = 1; });
      lr.forEach(function (r) { if (!seen[r.unit_id]) { seen[r.unit_id] = 1; groups.push({ id: r.unit_id, name: unitName(r.unit_id) }); } });
      groups.forEach(function (g) {
        var gr = lr.filter(function (r) { return (r.unit_id || '') === g.id; });
        if (!gr.length) return;
        body += '<tr class="m-yr-unit"><th colspan="13" scope="rowgroup">' + esc(g.name) + '</th></tr>';
        gr.forEach(function (r) {
          var its = byRule[r.rule_id] || [];
          var per = r.period_days ? (r.basis === 'days' ? 'кожні ' + nf(r.period_days, 1) + ' дн.' : '≈ кожні ' + nf(r.period_days, r.period_days < 10 ? 1 : 0) + ' дн. · ' + (r.basis === 'hours' ? 'за мотогодинами' : 'за лічильником')) : '';
          body += '<tr><th scope="row" class="m-yr-r"><button type="button" class="m-yr-rb" data-plan-rule="' + esc(r.rule_id) + '"><b>' + esc(r.title) + '</b>' +
            (r.status === 'due' || r.status === 'soon' ? '<span class="m-yr-st s-' + esc(r.status) + '">' + esc(r.status === 'due' ? 'прострочено' : 'скоро') + '</span>' : '') +
            '<small>' + esc(per || lbl('work_type', r.work_type)) + '</small></button></th>';
          if (!its.length) body += '<td colspan="12" class="m-yr-note">' + esc(r.note || 'У цьому році робіт не заплановано') + '</td>';
          else {
            months.forEach(function (mo) {
              var mi = its.filter(function (it) { return it.day.slice(0, 7) === mo.key; });
              if (!mi.length) { body += '<td class="m-yc"></td>'; return; }
              var over = mi.some(function (it) { return it.overdue; }), fc = mi.every(function (it) { return it.forecast; });
              var txt = mi.length <= 3 ? mi.map(function (it) { return +it.day.slice(8); }).join(', ') : mi.length + '×';
              var t = mi.map(function (it) { return fmt.dayLabel(it.day) + (it.overdue ? ' — прострочено' : '') + (it.forecast ? ' (прогноз)' : ''); }).join('\n');
              body += '<td class="m-yc has' + (over ? ' over' : '') + (fc ? ' fc' : '') + '" title="' + esc(r.title + '\n' + t) + '"><span>' + esc(txt) + '</span></td>';
            });
          }
          body += '</tr>';
        });
      });
    });
    return '<div class="m-yr-wrap"><table class="m-yr"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="m-yr-leg"><span><i class="m-yc-sw"></i>Календарний строк</span><span><i class="m-yc-sw fc"></i>Прогноз за напрацюванням</span>' +
      '<span><i class="m-yc-sw over"></i>Прострочено</span><span class="dim">Числа — дні місяця; «8×» — кількість робіт за місяць.</span></div>';
  }
  function maintView(p, host, ctx) {
    if (p.tab && /^(due|plan|year)$/.test(p.tab)) mState.tab = p.tab;
    if (has(p, 'status')) mState.status = /^(due|soon|ok|none)$/.test(p.status) ? p.status : '';
    if (has(p, 'line')) { mState.line = p.line || ''; mState.unit = ''; }
    if (mState.line && !App.line(mState.line)) { mState.line = ''; mState.unit = ''; }
    var sh = shell(host, 'maintenance', { title: 'ТО і ППР', actions: actBtn('csv', 'CSV', 'download', { title: 'Завантажити таблицю для Excel' }) + actBtn('print', 'Друк', 'printer') });
    var st = { plan: null, err: null, loading: false };
    host.classList.add('m-printable');
    sh.body.innerHTML = '<div class="m-print-head"></div><div class="m-bar no-print"></div><div class="m-filters no-print"></div><div class="m-mt"></div>';
    var barEl = sh.body.querySelector('.m-bar'), fEl = sh.body.querySelector('.m-filters'), cEl = sh.body.querySelector('.m-mt'), phEl = sh.body.querySelector('.m-print-head');
    function drawBar() {
      barEl.innerHTML = UI.segmented({ name: 'mtab', value: mState.tab, label: 'Подання', options: [
        { value: 'due', label: 'Строки ТО', icon: 'gauge' }, { value: 'plan', label: 'План робіт', icon: 'list' }, { value: 'year', label: 'Річний графік', icon: 'calendar' }] });
    }
    function drawFilters() {
      fEl.innerHTML = '<div class="m-frow"><label class="m-fl"><span>Лінія</span>' + selectHtml('f_line', mState.line, lineOptions()) + '</label>' +
        '<label class="m-fl"><span>Агрегат</span>' + selectHtml('f_unit', mState.unit, unitOptions(mState.line), { disabled: !mState.line }) + '</label>' +
        (mState.tab === 'plan' ? '<div class="m-fl"><span>Період</span>' + UI.segmented({ name: 'f_range', value: String(mState.range), size: 'sm', options: [{ value: '30', label: '30 днів' }, { value: '90', label: '90 днів' }] }) + '</div>' : '') + '</div>';
    }
    function dueList() {
      return ((App.state && App.state.due) || []).filter(function (d) {
        return App.line(d.line_id) && (!mState.line || d.line_id === mState.line) && (!mState.unit || d.unit_id === mState.unit);
      });
    }
    function drawDue() {
      var all = dueList(), cnt = { due: 0, soon: 0, ok: 0, none: 0 };
      all.forEach(function (d) { cnt[d.status] = (cnt[d.status] || 0) + 1; });
      var list = all.filter(function (d) { return !mState.status || d.status === mState.status; });
      var opts = [{ value: '', label: 'Усі', count: all.length }, { value: 'due', label: 'Потрібно виконати', count: cnt.due }, { value: 'soon', label: 'Скоро', count: cnt.soon }, { value: 'ok', label: 'У нормі', count: cnt.ok }];
      if (cnt.none) opts.push({ value: 'none', label: 'Без інтервалу', count: cnt.none });
      cEl.innerHTML = '<div class="m-chips no-print">' + UI.chips({ name: 'f_status', value: mState.status, options: opts, size: 'sm', label: 'Статус' }) + '</div>' +
        (list.length ? '<div class="m-dues">' + list.map(dueCard).join('') + '</div>' :
          UI.emptyState({ icon: 'check', title: all.length ? 'Немає робіт із таким статусом' : 'Регламент ТО не задано', text: all.length ? 'Змініть фільтр.' : 'Додайте роботи в розділі «Обладнання → лінія → Регламент ТО і ППР».' }));
    }
    function planFiltered() {
      return ((st.plan && st.plan.items) || []).filter(function (it) {
        return App.line(it.line_id) && (!mState.line || it.line_id === mState.line) && (!mState.unit || it.unit_id === mState.unit);
      });
    }
    function drawPlanList() {
      var tk = todayKey(), end = keyAdd(tk, mState.range - 1), items = planFiltered();
      var over = items.filter(function (it) { return it.overdue; });
      var up = items.filter(function (it) { return !it.overdue && it.day >= tk && it.day <= end; });
      var weeks = [], by = {};
      up.forEach(function (it) { var w = monday(it.day); if (!by[w]) { by[w] = []; weeks.push(w); } by[w].push(it); });
      var thisW = monday(tk), nextW = keyAdd(thisW, 7);
      var noData = ((st.plan && st.plan.rules) || []).filter(function (r) { return r.note && App.line(r.line_id) && (!mState.line || r.line_id === mState.line) && (!mState.unit || r.unit_id === mState.unit); });
      var h = '<p class="m-pl-sum">' + esc(up.length + ' ' + fmt.plural(up.length, ['робота', 'роботи', 'робіт']) + ' на ' + mState.range + ' днів') +
        (over.length ? ' · <b class="c-bad">' + esc(over.length + ' ' + fmt.plural(over.length, ['прострочена', 'прострочені', 'прострочених'])) + '</b>' : '') + '</p>';
      if (over.length) h += '<section class="m-pl-wk over"><h3>' + icon('alert', 20) + 'Прострочено — виконати якнайшвидше</h3>' + over.map(planRowHtml).join('') + '</section>';
      weeks.forEach(function (w) {
        h += '<section class="m-pl-wk"><h3>' + esc(weekLabel(w)) + (w === thisW ? '<span>цей тиждень</span>' : w === nextW ? '<span>наступний тиждень</span>' : '') + '</h3>' + by[w].map(planRowHtml).join('') + '</section>';
      });
      if (!over.length && !up.length) h += UI.emptyState({ icon: 'calendar', title: 'Робіт не заплановано', text: 'За вибраний період планових робіт немає.' });
      if (noData.length) h += '<div class="box info m-pl-nodata">' + icon('info') + '<span><b>Без прогнозу:</b> ' + esc(noData.map(function (r) { return r.title + ' (' + lineName(r.line_id) + ')'; }).join('; ')) + ' — немає даних про напрацювання. Строк зʼявиться, щойно лінія попрацює кілька днів.</span></div>';
      cEl.innerHTML = h;
    }
    function drawPrintHead() {
      var S = App.state && App.state.settings || {};
      var t = mState.tab === 'due' ? 'Строки ТО і ППР' : mState.tab === 'plan' ? 'План ТО і ППР на ' + mState.range + ' днів' : 'Річний графік ППР';
      var pr = planRange();
      phEl.innerHTML = '<h2>' + esc(t) + '</h2><p>' + esc(S.company || '') + (mState.line ? ' · ' + esc(lineName(mState.line)) : ' · усі лінії') + (mState.unit ? ' · ' + esc(unitName(mState.unit)) : '') +
        (mState.tab === 'year' ? ' · ' + esc(fmt.monthName(pr.months[0].m) + ' ' + pr.months[0].y + ' – ' + fmt.monthName(pr.months[11].m) + ' ' + pr.months[11].y) : '') +
        ' · сформовано ' + esc(fmt.datetime(App.now())) + '</p>';
    }
    function drawContent() {
      if (!ctx.alive()) return;
      drawPrintHead();
      if (mState.tab === 'due') { drawDue(); return; }
      if (!st.plan) {
        cEl.innerHTML = st.err ? errBox(st.err, 'retry') : UI.spinner('Формуємо план…');
        if (!st.err) loadPlan(false);
        return;
      }
      if (mState.tab === 'plan') drawPlanList();
      else cEl.innerHTML = yearHtml(st.plan);
    }
    function loadPlan(force) {
      if (st.loading) return;
      st.loading = true;
      getPlan(force).then(function (r) {
        st.loading = false;
        if (!ctx.alive()) return;
        if (r.ok) { st.plan = r; st.err = null; } else st.err = r;
        if (mState.tab !== 'due') drawContent();
      });
    }
    function exportCsv() {
      if (mState.tab === 'due') {
        UI.csv('stroky-to-' + csvDate() + '.csv', [
          { label: 'Лінія', csv: function (d) { return lineName(d.line_id); } }, { label: 'Агрегат', csv: function (d) { return unitName(d.unit_id); } },
          { label: 'Робота', key: 'title' }, { label: 'Вид', csv: function (d) { return lbl('work_type', d.work_type); } }, { label: 'Деталь / вузол', key: 'part' },
          { label: 'Статус', csv: function (d) { return lbl('due_status', d.status); } }, { label: 'Використано, %', csv: function (d) { return d.pct === null ? '' : Math.round(d.pct * 100); } },
          { label: 'Строк', csv: function (d) { return d.due_date ? fmt.date(d.due_date) : ''; } }, { label: 'Прогноз', csv: function (d) { return d.forecast ? 'так' : 'ні'; } },
          { label: 'Стан', key: 'summary' }, { label: 'Останнє виконання', csv: function (d) { return d.last_date ? fmt.date(d.last_date) : ''; } }
        ], dueList().filter(function (d) { return !mState.status || d.status === mState.status; }));
        return;
      }
      if (!st.plan) { UI.toast('План ще завантажується', { tone: 'info' }); return; }
      var items = planFiltered(), tk = todayKey();
      if (mState.tab === 'plan') { var end = keyAdd(tk, mState.range - 1); items = items.filter(function (it) { return it.overdue || (it.day >= tk && it.day <= end); }); }
      UI.csv((mState.tab === 'plan' ? 'plan-ppr-' : 'grafik-ppr-') + csvDate() + '.csv', [
        { label: 'Дата', csv: function (it) { return it.day.slice(8) + '.' + it.day.slice(5, 7) + '.' + it.day.slice(0, 4); } },
        { label: 'Лінія', csv: function (it) { return lineName(it.line_id); } }, { label: 'Агрегат', csv: function (it) { return unitName(it.unit_id); } },
        { label: 'Робота', key: 'title' }, { label: 'Вид', csv: function (it) { return lbl('work_type', it.work_type); } }, { label: 'Деталь / вузол', key: 'part' },
        { label: 'Підстава', csv: basisLabel }, { label: 'Прострочено', csv: function (it) { return it.overdue ? 'так' : ''; } }
      ], items);
    }
    function redraw() { drawBar(); drawFilters(); drawContent(); }
    host.addEventListener('change', function (e) {
      var t = e.target, dn = e.detail && e.detail.name;
      if (dn === 'mtab') { mState.tab = e.detail.value; drawFilters(); drawContent(); return; }
      if (dn === 'f_status') { mState.status = e.detail.value || ''; drawDue(); return; }
      if (dn === 'f_range') { mState.range = +e.detail.value || 30; drawContent(); return; }
      if (t && t.name === 'f_line') { mState.line = t.value; mState.unit = ''; drawFilters(); drawContent(); }
      else if (t && t.name === 'f_unit') { mState.unit = t.value; drawContent(); }
    });
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-m], [data-due-info], [data-due-done], [data-plan-rule]');
      if (!b) return;
      var dueOf = function (id) { return findDue(id); };
      if (b.hasAttribute('data-due-info')) { var d1 = dueOf(b.getAttribute('data-due-info')); if (d1) dueInfo(d1); return; }
      if (b.hasAttribute('data-due-done')) { var d2 = dueOf(b.getAttribute('data-due-done')); if (d2) markDone(d2); return; }
      if (b.hasAttribute('data-plan-rule')) {
        var d3 = dueOf(b.getAttribute('data-plan-rule'));
        if (d3) dueInfo(d3); else UI.toast('Регламент не знайдено серед активних', { tone: 'warn' });
        return;
      }
      var a = b.getAttribute('data-m');
      if (a === 'csv') exportCsv();
      else if (a === 'print') { drawPrintHead(); window.print(); }
      else if (a === 'retry') { st.err = null; drawContent(); }
    });
    redraw();
    if (mState.tab !== 'due') loadPlan(false);
    return {
      onBoot: function (state, meta) {
        if (mState.tab === 'due') { if (!(meta && meta.source === 'queue')) drawDue(); return; }
        if (meta && meta.source !== 'queue' && Date.now() - cache.planAt > 120000) { st.plan = null; drawContent(); }
      },
      onQueue: function () {}
    };
  }
  function findDue(ruleId) {
    var l = (App.state && App.state.due) || [];
    for (var i = 0; i < l.length; i++) if (l[i].rule_id === ruleId) return l[i];
    var a = (cache.admin && cache.admin.due) || [];
    for (var j = 0; j < a.length; j++) if (a[j].rule_id === ruleId) return a[j];
    return null;
  }

  /* ================================= ЖУРНАЛ ================================= */
  var JTYPES = [
    { value: 'events', label: 'Стан ліній', icon: 'activity' }, { value: 'checks', label: 'Чек-листи', icon: 'checklist' },
    { value: 'works', label: 'Роботи', icon: 'wrench' }, { value: 'readings', label: 'Лічильники', icon: 'gauge' }
  ];
  var KIND = { events: { label: 'Стан', icon: 'activity' }, checks: { label: 'Чек-лист', icon: 'checklist' }, works: { label: 'Робота', icon: 'wrench' }, readings: { label: 'Показник', icon: 'gauge' } };
  function jDefaults() { return { period: '7', from: '', to: '', line: '', unit: '', types: JTYPES.map(function (t) { return t.value; }), work_type: '', q: '', hideVoid: false }; }
  var jState = jDefaults();
  function jRange() {
    var tk = todayKey();
    switch (jState.period) {
      case 'today': return { from: tk, to: tk };
      case '7': return { from: keyAdd(tk, -6), to: tk };
      case '30': return { from: keyAdd(tk, -29), to: tk };
      case '90': return { from: keyAdd(tk, -89), to: tk };
      default: {
        var f = isKey(jState.from) ? jState.from : keyAdd(tk, -6), t = isKey(jState.to) ? jState.to : tk;
        return f <= t ? { from: f, to: t } : { from: t, to: f };
      }
    }
  }
  function jEntry(x) {
    var r = x.r;
    switch (x.kind) {
      case 'events':
        return { main: UI.statusPill(r.state, { size: 'sm' }) + (r.reason ? ' <b>' + esc(r.reason) + '</b>' : '') +
          (r.flag ? ' ' + UI.badge(lbl('flag', r.flag), r.flag === 'forced' ? 'soon' : 'bad') : ''),
          sub: [r.prev_state ? 'було: ' + lbl('state', r.prev_state).toLowerCase() : '', r.product, r.note].filter(Boolean).join(' · '), who: r.operator };
      case 'checks':
        return { main: '<b>' + esc(lbl('occasion', r.occasion)) + '</b> ' + resultBadge(r.result),
          sub: [r.total + ' ' + fmt.plural(r.total || 0, ['пункт', 'пункти', 'пунктів']), r.failed ? 'зауважень: ' + r.failed : '', r.out_of_range ? 'поза нормою: ' + r.out_of_range : '',
            r.missing ? 'не заповнено: ' + r.missing : '', naText(r), r.product, r.comment].filter(Boolean).join(' · '), who: r.operator };
      case 'works':
        return { main: '<b>' + esc(r.title || lbl('work_type', r.work_type)) + '</b> ' + UI.badge(lbl('work_type', r.work_type), r.work_type === 'repair' ? 'bad' : 'muted') +
          (r.rule_id ? ' ' + UI.badge('за регламентом', 'info') : ''),
          sub: [r.unit_id ? unitName(r.unit_id) : '', r.cause, r.description, r.parts ? 'деталі: ' + r.parts : '', r.duration_min ? nf(r.duration_min, 0) + ' хв' : ''].filter(Boolean).join(' · '), who: r.performer };
      default: {
        var m = meterAny(r.meter_id);
        return { main: '<b>' + esc(m ? m.name : r.meter_id) + '</b> = <span class="num">' + esc(nf(r.value)) + (m && m.unit_label ? ' ' + esc(m.unit_label) : '') + '</span>',
          sub: [lbl('meter_mode', r.mode), r.note].filter(Boolean).join(' · '), who: r.operator };
      }
    }
  }
  function journalView(p, host, ctx) {
    var keys = ['line', 'unit', 'from', 'to', 'types', 'q', 'work_type', 'period'];
    if (keys.some(function (k) { return has(p, k); })) {
      jState = jDefaults();
      if (p.line && App.line(p.line)) jState.line = p.line;
      if (p.unit) jState.unit = p.unit;
      if (isKey(p.from) || isKey(p.to)) { jState.period = 'custom'; jState.from = isKey(p.from) ? p.from : ''; jState.to = isKey(p.to) ? p.to : ''; }
      if (p.period && /^(today|7|30|90)$/.test(p.period)) jState.period = p.period;
      if (p.types) { var ts = p.types.split(',').filter(function (t) { return KIND[t]; }); if (ts.length) jState.types = ts; }
      if (p.q) jState.q = p.q;
      if (p.work_type && LBL.work_type[p.work_type]) { jState.work_type = p.work_type; jState.types = ['works']; }
    }
    var sh = shell(host, 'journal', { title: 'Журнал', actions: actBtn('csv', 'CSV', 'download', { title: 'Завантажити показані записи для Excel' }) + actBtn('refresh', 'Оновити', 'refresh') });
    sh.body.innerHTML = '<div class="m-filters m-jf no-print"></div><div class="m-jres" aria-live="polite"></div>';
    var fEl = sh.body.querySelector('.m-jf'), rEl = sh.body.querySelector('.m-jres');
    var st = { r: null, rows: [], err: null, seq: 0, show: 150 };
    function drawFilters() {
      var rg = jRange();
      fEl.innerHTML = '<div class="m-frow"><div class="m-fl"><span>Період</span>' + UI.segmented({ name: 'f_period', value: jState.period, size: 'sm', options: [
        { value: 'today', label: 'Сьогодні' }, { value: '7', label: '7 днів' }, { value: '30', label: '30 днів' }, { value: '90', label: '90 днів' }, { value: 'custom', label: 'Свій' }] }) + '</div>' +
        (jState.period === 'custom' ? '<label class="m-fl"><span>З</span><input class="inp" type="date" name="f_from" value="' + esc(rg.from) + '" max="' + esc(todayKey()) + '"></label>' +
          '<label class="m-fl"><span>По</span><input class="inp" type="date" name="f_to" value="' + esc(rg.to) + '" max="' + esc(todayKey()) + '"></label>' : '') + '</div>' +
        '<div class="m-frow"><label class="m-fl"><span>Лінія</span>' + selectHtml('f_line', jState.line, lineOptions()) + '</label>' +
        '<label class="m-fl"><span>Агрегат</span>' + selectHtml('f_unit', jState.unit, unitOptions(jState.line), { disabled: !jState.line }) + '</label>' +
        '<label class="m-fl"><span>Вид робіт</span>' + selectHtml('f_wt', jState.work_type, [{ value: '', label: 'Усі види' }].concat(UI.options('work_type'))) + '</label>' +
        '<label class="m-fl m-fl-q"><span>Пошук</span><span class="m-q">' + icon('search', 18) + '<input class="inp" type="search" name="f_q" value="' + esc(jState.q) + '" placeholder="Причина, продукт, оператор, деталь…" autocomplete="off"></span></label></div>' +
        '<div class="m-frow">' + UI.chips({ name: 'f_types', multi: true, value: jState.types, size: 'sm', label: 'Типи записів', options: JTYPES }) +
        '<label class="check m-fl-chk"><input type="checkbox" name="f_hidevoid"' + (jState.hideVoid ? ' checked' : '') + '><span>Приховати анульовані</span></label></div>' +
        (jState.unit ? '<p class="dim small m-fhint">За агрегатом відбираються лише роботи й показники лічильників.</p>' : '');
    }
    function load() {
      var seq = ++st.seq, rg = jRange();
      rEl.innerHTML = UI.spinner('Завантаження журналу…');
      Api.call('history', { from: rg.from, to: rg.to, line_id: jState.line || undefined, unit_id: jState.unit || undefined, types: jState.types,
        work_type: jState.work_type || undefined, q: jState.q || undefined, include_void: !jState.hideVoid, limit: 500 }).then(function (r) {
        if (!ctx.alive() || seq !== st.seq) return;
        if (!r.ok) { st.err = r; st.r = null; rEl.innerHTML = errBox(r, 'retry'); return; }
        st.err = null; st.r = r; st.show = 150;
        var rows = [];
        JTYPES.forEach(function (t) { (r[t.value] || []).forEach(function (x) { rows.push({ kind: t.value, r: x, t: Date.parse(x.ts) }); }); });
        rows.sort(function (a, b) { return b.t - a.t; });
        st.rows = rows;
        drawRows();
      });
    }
    function drawRows() {
      var rows = st.rows, rg = jRange(), tr = st.r && st.r.truncated || {};
      var cut = JTYPES.filter(function (t) { return tr[t.value]; }).map(function (t) { return t.label.toLowerCase(); });
      var cnt = {};
      rows.forEach(function (x) { cnt[x.kind] = (cnt[x.kind] || 0) + 1; });
      var shown = rows.slice(0, st.show);
      var h = '<div class="m-jsum"><span>' + esc(rg.from === rg.to ? fmt.dayLabel(rg.from) : fmt.dayLabel(rg.from) + ' – ' + fmt.dayLabel(rg.to)) + '</span>' +
        '<b>' + rows.length + ' ' + fmt.plural(rows.length, ['запис', 'записи', 'записів']) + '</b>' +
        JTYPES.filter(function (t) { return cnt[t.value]; }).map(function (t) { return '<span class="dim">' + esc(t.label.toLowerCase()) + ': ' + cnt[t.value] + '</span>'; }).join('') + '</div>' +
        (cut.length ? '<div class="box warn m-jcut">' + icon('alert') + '<span>Показано лише останні 500 записів типу «' + esc(cut.join('», «')) + '». Звузьте період або фільтри.</span></div>' : '');
      h += rtable([
        { label: 'Час', cls: 'm-jt', html: function (x) { return '<b class="num">' + esc(fmt.time(x.r.ts)) + '</b><small>' + esc(fmt.dayLabel(fmt.dayKey(x.r.ts))) + '</small>'; } },
        { label: 'Лінія', html: function (x) { return esc(lineName(x.r.line_id)); } },
        { label: 'Тип', cls: 'm-jk', html: function (x) { var k = KIND[x.kind]; return '<span class="m-kind k-' + x.kind + '">' + icon(k.icon, 16) + esc(k.label) + '</span>' + (x.r.void ? ' ' + UI.badge('анульовано', 'bad') : ''); } },
        { label: 'Запис', cls: 'm-rt-main m-je', html: function (x) { var e = jEntry(x); return '<div class="m-je-m">' + e.main + '</div>' + (e.sub ? '<div class="m-je-s">' + esc(e.sub) + '</div>' : '') + (x.r.void && x.r.void_note ? '<div class="m-je-s c-bad">Анульовано: ' + esc(x.r.void_note) + '</div>' : ''); } },
        { label: 'Хто', html: function (x) { return esc(jEntry(x).who || ''); } }
      ], shown, { cls: 'm-jtbl', empty: 'За вибраними умовами записів немає', attrs: function (x, i) { return { 'data-open': String(i), class: 'clickable' + (x.r.void ? ' is-void' : ''), tabindex: '0' }; } });
      if (rows.length > shown.length) h += '<div class="btn-row m-more"><button type="button" class="btn sm" data-m="more">Показати ще ' + Math.min(150, rows.length - shown.length) + ' з ' + (rows.length - shown.length) + '</button></div>';
      rEl.innerHTML = h;
    }
    function exportCsv() {
      if (!st.rows.length) { UI.toast('Немає записів для вивантаження', { tone: 'info' }); return; }
      UI.csv('zhurnal-' + csvDate() + '.csv', [
        { label: 'Час', csv: function (x) { return fmt.datetime(x.r.ts); } },
        { label: 'Лінія', csv: function (x) { return lineName(x.r.line_id); } },
        { label: 'Агрегат', csv: function (x) { return unitName(x.r.unit_id); } },
        { label: 'Тип', csv: function (x) { return KIND[x.kind].label; } },
        { label: 'Запис', csv: function (x) {
          var r = x.r;
          if (x.kind === 'events') return lbl('state', r.state) + (r.reason ? ': ' + r.reason : '');
          if (x.kind === 'checks') return lbl('occasion', r.occasion) + ' — ' + lbl('check_result', r.result);
          if (x.kind === 'works') return lbl('work_type', r.work_type) + ': ' + (r.title || '');
          var m = meterAny(r.meter_id); return (m ? m.name : r.meter_id) + ' = ' + nf(r.value);
        } },
        { label: 'Деталі', csv: function (x) { return jEntry(x).sub; } },
        { label: 'Хто', csv: function (x) { return jEntry(x).who || ''; } },
        { label: 'Позначка', csv: function (x) { return x.r.flag ? lbl('flag', x.r.flag) : ''; } },
        { label: 'Анульовано', csv: function (x) { return x.r.void ? 'так' : ''; } },
        { label: 'Причина анулювання', csv: function (x) { return x.r.void_note || ''; } },
        { label: 'Пристрій', csv: function (x) { return x.r.device || ''; } },
        { label: 'ID', csv: function (x) { return x.r.id; } }
      ], st.rows);
    }
    var qLoad = debounce(function () { if (ctx.alive()) load(); }, 450);
    host.addEventListener('change', function (e) {
      var t = e.target, dn = e.detail && e.detail.name;
      if (dn === 'f_period') { jState.period = e.detail.value; if (jState.period === 'custom' && !jState.from) { var r0 = jRange(); jState.from = r0.from; jState.to = r0.to; } drawFilters(); load(); return; }
      if (dn === 'f_types') {
        var v = e.detail.values || [];
        if (!v.length) { v = JTYPES.map(function (x) { return x.value; }); UI.setChipValue(fEl, 'f_types', v); }
        jState.types = v;
        if (jState.work_type && (v.length !== 1 || v[0] !== 'works')) { jState.work_type = ''; drawFilters(); }
        load(); return;
      }
      if (!t || !t.name) return;
      if (t.name === 'f_from' || t.name === 'f_to') {
        if (!isKey(t.value)) return;
        jState[t.name === 'f_from' ? 'from' : 'to'] = t.value; load();
      } else if (t.name === 'f_line') { jState.line = t.value; jState.unit = ''; drawFilters(); load(); }
      else if (t.name === 'f_unit') { jState.unit = t.value; drawFilters(); load(); }
      else if (t.name === 'f_wt') { jState.work_type = t.value; if (t.value) jState.types = ['works']; drawFilters(); load(); }
      else if (t.name === 'f_hidevoid') { jState.hideVoid = t.checked; load(); }
    });
    host.addEventListener('input', function (e) { if (e.target && e.target.name === 'f_q') { jState.q = e.target.value.trim(); qLoad(); } });
    host.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target && e.target.name === 'f_q') { e.preventDefault(); jState.q = e.target.value.trim(); load(); } });
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-m]');
      if (!b) return;
      var a = b.getAttribute('data-m');
      if (a === 'refresh' || a === 'retry') load();
      else if (a === 'csv') exportCsv();
      else if (a === 'more') { st.show += 150; drawRows(); }
    });
    bindRows(rEl, function (i) { var x = st.rows[+i]; if (x) openRecord(x.kind, x.r, function () { load(); }); });
    drawFilters();
    load();
    return { onBoot: function () {}, onQueue: function () {} };
  }

  /* ================================= ЧЕК-ЛИСТИ ================================= */
  var cState = { days: 14, line: '', occ: '', res: '', show: 40 };
  function checksView(p, host, ctx) {
    if (p.line && App.line(p.line)) cState.line = p.line;
    var sh = shell(host, 'checks', { title: 'Чек-листи', actions: actBtn('refresh', 'Оновити', 'refresh') });
    sh.body.innerHTML = '<div class="m-filters no-print"></div><div class="m-cres"></div>';
    var fEl = sh.body.querySelector('.m-filters'), cEl = sh.body.querySelector('.m-cres');
    var st = { d: null, h: null, err: null, seq: 0 };
    function drawFilters() {
      fEl.innerHTML = '<div class="m-frow"><div class="m-fl"><span>Період</span>' + UI.segmented({ name: 'f_days', value: String(cState.days), size: 'sm', options: [
        { value: '7', label: '7 днів' }, { value: '14', label: '14 днів' }, { value: '30', label: '30 днів' }] }) + '</div>' +
        '<label class="m-fl"><span>Лінія</span>' + selectHtml('f_line', cState.line, lineOptions()) + '</label></div>';
    }
    function load(force) {
      var seq = ++st.seq, from = keyAdd(todayKey(), -(cState.days - 1));
      cEl.innerHTML = UI.spinner('Завантаження…');
      Promise.all([getDash(cState.days, force ? 0 : 30000),
        Api.call('history', { from: from, types: ['checks'], line_id: cState.line || undefined, limit: 1000 })]).then(function (res) {
        if (!ctx.alive() || seq !== st.seq) return;
        if (!res[0].ok || !res[1].ok) { st.err = res[0].ok ? res[1] : res[0]; cEl.innerHTML = errBox(st.err, 'retry'); return; }
        st.d = res[0]; st.h = res[1]; st.err = null;
        draw();
      });
    }
    function lines() { return App.lines().filter(function (l) { return !cState.line || l.id === cState.line; }); }
    function summary() {
      var d = st.d;
      return '<div class="m-cs-grid">' + lines().map(function (l) {
        var s = d.stats[l.id] || {}, pc = d.compliance_pct[l.id], starts = 0, cov = 0;
        (d.compliance[l.id] || []).forEach(function (x) { starts += x.starts; cov += x.covered; });
        var parts = [{ value: s.checks_ok || 0, color: 'var(--ok)', label: 'Норма', valueText: String(s.checks_ok || 0) },
          { value: s.checks_remarks || 0, color: 'var(--warn)', label: 'Із зауваженнями', valueText: String(s.checks_remarks || 0) },
          { value: s.checks_fail || 0, color: 'var(--bad)', label: 'Не пройдено', valueText: String(s.checks_fail || 0) }];
        return '<div class="m-cs"><div class="m-cs-n">' + esc(l.name) + '</div>' +
          '<div class="m-cs-v"><b class="' + (pc === null || pc === undefined ? '' : pc >= 95 ? 'c-ok' : pc >= 80 ? 'c-warn' : 'c-bad') + '">' + esc(pc === null || pc === undefined ? '—' : fmt.pct(pc)) + '</b>' +
          '<span>' + esc(starts ? cov + ' з ' + starts + ' ' + fmt.plural(starts, ['запуску', 'запусків', 'запусків']) + ' із чек-листом' : 'запусків не було') + '</span></div>' +
          UI.stackBar(parts, { height: 12 }) +
          '<div class="m-cs-l"><span><i style="background:var(--ok)"></i>норма ' + (s.checks_ok || 0) + '</span><span><i style="background:var(--warn)"></i>із зауваженнями ' + (s.checks_remarks || 0) + '</span>' +
          '<span><i style="background:var(--bad)"></i>не пройдено ' + (s.checks_fail || 0) + '</span>' + (s.out_of_range ? '<span>поза нормою: ' + s.out_of_range + '</span>' : '') +
          (s.checks_na ? '<span title="Відповідей «Не застосовується»">Н/З: ' + s.checks_na + '</span>' : '') + '</div></div>';
      }).join('') + '</div>';
    }
    function listHtml() {
      var list = (st.h.checks || []).filter(function (c) {
        return App.line(c.line_id) && (!cState.occ || c.occasion === cState.occ) && (!cState.res || (cState.res === 'bad' ? c.result === 'remarks' || c.result === 'fail' : c.result === cState.res));
      });
      return '<div class="m-frow m-cl-f">' + UI.chips({ name: 'f_occ', value: cState.occ, size: 'sm', label: 'Коли', options: [{ value: '', label: 'Усі' }].concat(UI.options('occasion')) }) +
        UI.chips({ name: 'f_res', value: cState.res, size: 'sm', label: 'Результат', options: [{ value: '', label: 'Будь-який результат' }, { value: 'bad', label: 'Із зауваженнями або не пройдено' }, { value: 'fail', label: 'Не пройдено' }] }) + '</div>' +
        rtable([
          { label: 'Час', cls: 'm-jt', html: function (c) { return '<b class="num">' + esc(fmt.time(c.ts)) + '</b><small>' + esc(fmt.dayLabel(fmt.dayKey(c.ts))) + '</small>'; } },
          { label: 'Лінія', html: function (c) { return esc(lineName(c.line_id)); } },
          { label: 'Коли', cls: 'm-rt-main', html: function (c) { return '<b>' + esc(lbl('occasion', c.occasion)) + '</b> ' + resultBadge(c.result) + (c.void ? ' ' + UI.badge('анульовано', 'bad') : ''); } },
          { label: 'Підсумок', html: function (c) {
            var bad = [c.failed ? 'зауважень: ' + c.failed : '', c.out_of_range ? 'поза нормою: ' + c.out_of_range : '', c.missing ? 'не заповнено: ' + c.missing : ''].filter(Boolean);
            return esc((c.total || 0) + ' ' + fmt.plural(c.total || 0, ['пункт', 'пункти', 'пунктів'])) + (bad.length ? '<small class="c-bad">' + esc(bad.join(' · ')) + '</small>' : '<small class="dim">без зауважень</small>') +
              (naText(c) ? '<small class="dim m-na">' + esc(naText(c)) + '</small>' : '');
          } },
          { label: 'Оператор · продукт', html: function (c) { return esc(c.operator || '') + (c.product ? '<small class="dim">' + esc(c.product) + '</small>' : ''); } }
        ], list.slice(0, cState.show), { cls: 'm-jtbl2', empty: 'Чек-листів за умовами немає', attrs: function (c) { return { 'data-open': c.id, class: 'clickable' + (c.void ? ' is-void' : ''), tabindex: '0' }; } }) +
        (list.length > cState.show ? '<div class="btn-row m-more"><button type="button" class="btn sm" data-m="more">Показати ще ' + Math.min(40, list.length - cState.show) + ' з ' + (list.length - cState.show) + '</button></div>' : '');
    }
    function draw() {
      if (!ctx.alive() || !st.d) return;
      cEl.innerHTML = summary() +
        card('Контроль щоденних перевірок · ' + cState.days + ' ' + fmt.plural(cState.days, ['день', 'дні', 'днів']), matrixHtml(st.d, lines()), { icon: 'grid', hint: 'клітинка — подробиці дня' }) +
        card('Останні чек-листи', listHtml(), { icon: 'checklist', hint: 'рядок — відповіді', cls: 'm-card-list' });
    }
    function drawList() { var c = cEl.querySelector('.m-card-list .card-body'); if (c && st.h) c.innerHTML = listHtml(); }
    host.addEventListener('change', function (e) {
      var t = e.target, dn = e.detail && e.detail.name;
      if (dn === 'f_days') { cState.days = +e.detail.value || 14; load(); return; }
      if (dn === 'f_occ') { cState.occ = e.detail.value || ''; cState.show = 40; drawList(); return; }
      if (dn === 'f_res') { cState.res = e.detail.value || ''; cState.show = 40; drawList(); return; }
      if (t && t.name === 'f_line') { cState.line = t.value; load(); }
    });
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-m], [data-cell]');
      if (!b) return;
      if (b.hasAttribute('data-cell')) {
        var pc = b.getAttribute('data-cell').split('|'), x = st.d && findCell(st.d, pc[0], pc[1]);
        if (x) openDay(pc[0], pc[1], x, function () { load(true); });
        return;
      }
      var a = b.getAttribute('data-m');
      if (a === 'refresh' || a === 'retry') load(true);
      else if (a === 'more') { cState.show += 40; drawList(); }
    });
    bindRows(cEl, function (id) {
      var c = st.h && findIn(st.h.checks, id);
      if (c) openCheck(c.id, c.ts, function () { load(true); });
    });
    drawFilters();
    load(false);
    return { onBoot: function () {}, onQueue: function () {} };
  }

  /* ================================= ОБЛАДНАННЯ ================================= */
  var LINE_KINDS = ['Фасувальна', 'Етикетувальна', 'Пакувальна', 'Змішувальна', 'Варильна'];
  var UNIT_KINDS = ['Дозатор', 'Фасувальний автомат', 'Закупорювач', 'Конвеєр', 'Компресор', 'Етикетувальник', 'Каплеструменевий принтер', 'Термотунель', 'Насос', 'Змішувач'];
  var UNIT_LABELS = ['°C', 'бар', 'г', 'кг', 'мм', 'шт', '%', 'хв', 'л', 'м'];
  function countOf(list, lineId) { return (list || []).filter(function (x) { return x.line_id === lineId && x.active; }).length; }
  function offToggle(n, on) {
    return n ? '<label class="check m-fl-chk"><input type="checkbox" data-m-off' + (on ? ' checked' : '') + '><span>Показати вимкнені (' + n + ')</span></label>' : '';
  }
  function datalistOf(list) { var seen = {}, out = []; list.forEach(function (x) { x = String(x || '').trim(); if (x && !seen[x]) { seen[x] = 1; out.push(x); } }); return out; }
  /* модальна форма довідника: {title, body, isNew, size, submit(v, m) → Promise, validate(v, m) → errs, remove:{label, onClick}} */
  function formModal(o) {
    var acts = [];
    if (o.extra) acts.push(o.extra);
    acts.push({ label: 'Скасувати', tone: 'ghost', value: null });
    acts.push({ label: o.ok || 'Зберегти', icon: 'check', tone: 'primary', onClick: function (mm) {
      var v = UI.readForm(mm.body), errs = o.validate ? (o.validate(v, mm) || {}) : {};
      if (UI.setErrors(mm.body, errs)) return false;
      return o.submit(v, mm);
    } });
    var md = UI.modal({ title: o.title, size: o.size || 'md', className: 'm-modal m-formm', body: '<form class="m-form" novalidate autocomplete="off">' + o.body + '</form>', actions: acts });
    var form = md.body.querySelector('form');
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    form.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); md.button(acts.length - 1).click(); }
    });
    if (o.onOpen) o.onOpen(md);
    return md;
  }
  function deactivate(table, row, what, after) {
    return UI.confirm({ title: 'Вимкнути ' + what + '?', danger: true, ok: 'Вимкнути',
      text: '«' + (row.name || row.title || row.text) + '» зникне з планшетів і розрахунків. Історія збережеться; увімкнути знову можна тут же (позначка «Активний»).' }).then(function (y) {
      if (!y) return false;
      return removeRow(table, row.id).then(function () { UI.toast('Вимкнено', { tone: 'ok' }); if (after) after(); return true; },
        function (e) { UI.alert({ title: 'Не вдалося вимкнути', text: e.message }); return false; });
    });
  }
  function activeField(row) { return row ? UI.field.check({ name: 'active', label: 'Активний (показувати на планшетах)', value: row.active !== false, className: 'span-2' }) : ''; }
  function sortField(row) { return UI.field.number({ name: 'sort', label: 'Порядок', value: row ? row.sort : null, hint: 'Менше число — вище в списку' }); }

  function lineForm(l, onSaved) {
    var isNew = !l;
    var areas = datalistOf(adminRows('lines').map(function (x) { return x.area; }));
    var body = '<div class="form-grid">' +
      UI.field.text({ name: 'name', label: 'Назва лінії', value: l ? l.name : '', required: true, className: 'span-2', maxLength: 200, placeholder: 'Напр., Лінія фасування №4 (банка)' }) +
      UI.field.text({ name: 'kind', label: 'Тип', value: l ? l.kind : '', datalist: LINE_KINDS, maxLength: 100 }) +
      UI.field.text({ name: 'area', label: 'Дільниця / цех', value: l ? l.area : '', datalist: areas, maxLength: 100 }) +
      UI.field.textarea({ name: 'description', label: 'Опис', value: l ? l.description : '', className: 'span-2', rows: 2, maxLength: 2000 }) +
      sortField(l) + (l ? '' : '<div></div>') + activeField(l) + '</div>';
    formModal({
      title: isNew ? 'Нова лінія' : 'Лінія: ' + l.name, body: body,
      extra: !isNew && l.active ? { label: 'Вимкнути лінію', icon: 'power', tone: 'ghost', className: 'm-danger-t m-foot-left', onClick: function (mm) {
        mm.close(null); deactivate('lines', l, 'лінію', onSaved); return false;
      } } : null,
      validate: function (v, mm) {
        var e = {};
        if (!v.name) e.name = 'Вкажіть назву лінії';
        numErrs(mm.body, v, e, { sort: {} });
        return e;
      },
      submit: function (v) {
        var row = { id: isNew ? Api.newId() : l.id, name: v.name, kind: v.kind, area: v.area, description: v.description };
        if (v.sort !== null) row.sort = v.sort;
        if (!isNew) row.active = !!v.active;
        return saveRow('lines', row).then(function (r) {
          UI.toast(isNew ? 'Лінію додано. Додайте агрегати, чек-лист і регламент ТО.' : 'Лінію збережено', { tone: 'ok' });
          if (onSaved) onSaved(r, isNew);
          return true;
        });
      }
    });
  }
  function equipmentView(p, host, ctx) {
    var sh = shell(host, 'equipment', { title: 'Обладнання', actions: actBtn('add-line', 'Додати лінію', 'plus', { tone: 'primary' }) });
    var st = { a: cache.admin, err: null };
    function lineCard(l) {
      var a = st.a, s = l.active ? App.lineStatus(l.id) : null, due = l.active ? App.dueFor(l.id) : [];
      var nd = due.filter(function (d) { return d.status === 'due'; }).length, ns = due.filter(function (d) { return d.status === 'soon'; }).length;
      var n = function (k, forms, list) { var c = countOf(list, l.id); return '<span><b>' + c + '</b>' + esc(fmt.plural(c, forms)) + '</span>'; };
      return '<a class="m-lcard' + (l.active ? '' : ' off') + '" href="#/m/equipment/' + encodeURIComponent(l.id) + '">' +
        '<div class="m-lc-h"><div class="m-lc-tt">' + ((l.kind || l.area) ? '<div class="m-lc-k">' + esc([l.kind, l.area].filter(Boolean).join(' · ')) + '</div>' : '') + '<h3>' + esc(l.name) + '</h3></div>' +
        (s ? UI.statusPill(s.state, { size: 'sm' }) : UI.badge('вимкнена', 'muted')) + '</div>' +
        '<div class="m-lc-n">' + n('u', ['агрегат', 'агрегати', 'агрегатів'], a.units) + n('i', ['пункт чек-листа', 'пункти чек-листа', 'пунктів чек-листа'], a.items) +
        n('m', ['лічильник', 'лічильники', 'лічильників'], a.meters) + n('r', ['робота ТО', 'роботи ТО', 'робіт ТО'], a.rules) + '</div>' +
        ((nd || ns) ? '<div class="badges">' + (nd ? UI.badge('ТО прострочено: ' + nd, 'due', { icon: 'alert' }) : '') + (ns ? UI.badge('скоро: ' + ns, 'soon') : '') + '</div>' : '') +
        '<span class="m-lc-go">' + icon('next', 22) + '</span></a>';
    }
    function draw() {
      if (!ctx.alive()) return;
      var a = st.a;
      if (!a) { sh.body.innerHTML = st.err ? errBox(st.err, 'retry') : UI.spinner('Завантаження довідників…'); return; }
      var ls = a.lines.slice().sort(bySort), act = ls.filter(function (l) { return l.active; }), off = ls.filter(function (l) { return !l.active; });
      var h = issuesBox(a.config_issues);
      if (!act.length) h += UI.emptyState({ icon: 'box', title: 'Ліній ще немає', text: 'Додайте першу лінію, потім — її агрегати, чек-лист запуску, лічильники й регламент ТО.', action: { label: 'Додати лінію', action: 'add-line' } });
      else h += '<div class="m-lgrid">' + act.map(lineCard).join('') + '</div>';
      if (off.length) h += '<div class="section-title">Вимкнені лінії · ' + off.length + '</div><div class="m-lgrid">' + off.map(lineCard).join('') + '</div>';
      h += '<p class="dim small m-note">' + icon('info', 16) + ' Довідники зберігаються в Google-таблиці (аркуші «Лінії», «Агрегати», «Чек-листи і параметри», «Лічильники», «Регламент ТО і ППР», «Персонал»). Їх можна змінювати тут або прямо в таблиці.</p>';
      sh.body.innerHTML = h;
    }
    function load(force) {
      loadAdmin(force).then(function (r) {
        if (!ctx.alive()) return;
        if (r.ok) { st.a = r; st.err = null; } else if (!st.a) st.err = r;
        draw();
      });
    }
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-m], [data-action]');
      if (!b) return;
      var a = b.getAttribute('data-m') || b.getAttribute('data-action');
      if (a === 'add-line') lineForm(null, function (row, isNew) { if (isNew && row) App.go('#/m/equipment/' + encodeURIComponent(row.id)); else load(true); });
      else if (a === 'retry') { st.err = null; draw(); load(true); }
    });
    draw();
    load(false);
    return { onBoot: function (s, meta) { if (!(meta && meta.source === 'queue')) load(false); }, onQueue: function () {} };
  }

  /* ---------- сторінка лінії: агрегати, чек-лист, лічильники, регламент ---------- */
  var EQ_TABS = { units: 'Агрегати', items: 'Чек-лист і параметри', meters: 'Лічильники', rules: 'Регламент ТО і ППР' };
  var eqState = {};
  function lineAdminView(p, host, ctx) {
    var id = p.line;
    var es = eqState[id] || (eqState[id] = { tab: 'units', occ: 'start', off: false });
    if (p.tab && EQ_TABS[p.tab]) es.tab = p.tab;
    var focusRule = p.rule || '', scrolled = false;
    var sh = shell(host, 'equipment', { title: lineName(id), kicker: 'Обладнання', back: '#/m/equipment', docTitle: 'Обладнання' });
    var st = { a: cache.admin, err: null };
    function L() { return st.a ? findIn(st.a.lines, id) : null; }
    function rowsOf(t, all) { return (st.a[t] || []).filter(function (x) { return x.line_id === id && (all || es.off || x.active); }).sort(bySort); }
    function offCount(t) { return (st.a[t] || []).filter(function (x) { return x.line_id === id && !x.active; }).length; }
    function draw() {
      if (!ctx.alive()) return;
      if (!st.a) { sh.body.innerHTML = st.err ? errBox(st.err, 'retry') : UI.spinner('Завантаження…'); return; }
      var l = L();
      if (!l) {
        sh.setHead({ title: 'Лінію не знайдено', back: '#/m/equipment' });
        sh.body.innerHTML = UI.emptyState({ icon: 'alert', title: 'Такої лінії немає', text: 'Можливо, її ID змінили в таблиці.', action: { label: 'До переліку ліній', href: '#/m/equipment' } });
        return;
      }
      App.setTitle('Обладнання · ' + l.name);
      sh.setHead({ title: l.name, kicker: 'Обладнання', back: '#/m/equipment', sub: esc([l.kind, l.area].filter(Boolean).join(' · ')) + (l.active ? '' : ' ' + UI.badge('вимкнена', 'muted')),
        actions: actBtn('edit-line', 'Редагувати', 'edit') + (l.active ? '<a class="btn sm" href="#/line/' + encodeURIComponent(l.id) + '">' + icon('tablet', 18) + '<span>Екран лінії</span></a>' : actBtn('on-line', 'Увімкнути', 'power', { tone: 'primary' })) });
      var cnt = { units: countOf(st.a.units, id), items: countOf(st.a.items, id), meters: countOf(st.a.meters, id), rules: countOf(st.a.rules, id) };
      var h = (l.active ? '' : '<div class="box warn">' + icon('alert') + 'Лінію вимкнено — її немає на планшетах і в звітах. Увімкніть, щоб повернути.</div>') +
        (l.description ? '<p class="muted m-desc">' + esc(l.description) + '</p>' : '') +
        '<div class="m-bar m-eqtabs">' + UI.segmented({ name: 'eqtab', value: es.tab, label: 'Розділи лінії', options: Object.keys(EQ_TABS).map(function (k) { return { value: k, label: EQ_TABS[k], count: cnt[k] }; }) }) + '</div>' +
        '<div class="m-eqc"></div>';
      sh.body.innerHTML = h;
      drawTab();
    }
    function drawTab() {
      var el = sh.body.querySelector('.m-eqc'), l = L();
      if (!el || !l) return;
      el.innerHTML = es.tab === 'items' ? itemsTab(l) : es.tab === 'meters' ? metersTab(l) : es.tab === 'rules' ? rulesTab(l) : unitsTab(l);
      if (focusRule && es.tab === 'rules') {
        var fr = el.querySelector('.m-rule.focus');
        if (fr && !scrolled) { scrolled = true; setTimeout(function () { fr.scrollIntoView({ block: 'center' }); }, 30); }
      }
    }
    function toolbar(btns, offT) { return '<div class="m-tb">' + btns + '<span class="grow"></span>' + (offT || '') + '</div>'; }

    /* агрегати */
    function unitsTab(l) {
      var us = rowsOf('units');
      return toolbar(actBtn('add-unit', 'Додати агрегат', 'plus', { tone: 'primary' }), offToggle(offCount('units'), es.off)) +
        rtable([
          { label: 'Агрегат', cls: 'm-rt-main', html: function (u) { return '<b>' + esc(u.name) + '</b>' + (u.kind ? '<small class="dim">' + esc(u.kind) + '</small>' : '') + (u.active ? '' : ' ' + UI.badge('вимкнено', 'muted')); } },
          { label: 'Модель / серійний №', html: function (u) { return esc([u.model, u.serial ? '№ ' + u.serial : ''].filter(Boolean).join(' · ')); } },
          { label: 'Виробник', html: function (u) { return esc([u.maker, u.year ? u.year + ' р.' : ''].filter(Boolean).join(', ')); } },
          { label: 'Введено', html: function (u) { return u.installed ? esc(fmt.date(u.installed)) : ''; } },
          { label: 'Напрацювання', cls: 'num', html: function (u) { return u.hours !== null && u.hours !== undefined ? esc(nf(u.hours, 0)) + ' мотогод' : ''; } }
        ], rowsOf('units'), { empty: 'Агрегатів ще немає. Додайте основні вузли лінії: дозатор, закупорювач, конвеєр…', attrs: function (u) { return { 'data-open': 'unit:' + u.id, class: 'clickable' + (u.active ? '' : ' m-off-row'), tabindex: '0' }; } }) +
        (us.length ? '<p class="dim small m-note">Напрацювання агрегату = мотогодини до початку обліку + мотогодини лінії відтоді, як агрегат додано.</p>' : '');
    }
    function unitForm(u) {
      var isNew = !u;
      var body = '<div class="form-grid">' +
        UI.field.text({ name: 'name', label: 'Назва агрегату', value: u ? u.name : '', required: true, className: 'span-2', maxLength: 200, placeholder: 'Напр., Поршневий дозатор 4-головий' }) +
        UI.field.text({ name: 'kind', label: 'Тип', value: u ? u.kind : '', datalist: UNIT_KINDS, maxLength: 100 }) +
        UI.field.text({ name: 'model', label: 'Модель', value: u ? u.model : '', maxLength: 100 }) +
        UI.field.text({ name: 'serial', label: 'Серійний номер', value: u ? u.serial : '', maxLength: 100 }) +
        UI.field.text({ name: 'maker', label: 'Виробник', value: u ? u.maker : '', maxLength: 100 }) +
        UI.field.number({ name: 'year', label: 'Рік випуску', value: u ? u.year : null, attrs: { inputmode: 'numeric' } }) +
        UI.field.date({ name: 'installed', label: 'Введено в експлуатацію', value: u && u.installed ? fmt.dayKey(u.installed) : '', attrs: { max: todayKey() } }) +
        UI.field.number({ name: 'hours_offset', label: 'Мотогодини до початку обліку', value: u ? u.hours_offset : null, unit: 'мотогод', className: 'span-2',
          hint: 'Скільки агрегат уже напрацював до того, як його почали вести в застосунку (з лічильника або паспорта).' }) +
        UI.field.textarea({ name: 'notes', label: 'Примітки', value: u ? u.notes : '', className: 'span-2', rows: 2, maxLength: 2000 }) +
        sortField(u) + '<div></div>' + activeField(u) + '</div>';
      formModal({
        title: isNew ? 'Новий агрегат' : 'Агрегат: ' + u.name, body: body,
        extra: !isNew && u.active ? { label: 'Вимкнути', icon: 'power', tone: 'ghost', className: 'm-danger-t m-foot-left', onClick: function (mm) { mm.close(null); deactivate('units', u, 'агрегат', reload); return false; } } : null,
        validate: function (v, mm) {
          var e = {};
          if (!v.name) e.name = 'Вкажіть назву';
          numErrs(mm.body, v, e, { year: { int: true, min: 1900, max: 2100 }, hours_offset: { min: 0 }, sort: {} });
          if (v.installed && v.installed > todayKey()) e.installed = 'Дата не може бути в майбутньому';
          return e;
        },
        submit: function (v) {
          var row = { id: isNew ? Api.newId() : u.id, line_id: id, name: v.name, kind: v.kind, model: v.model, serial: v.serial, maker: v.maker,
            year: v.year, installed: v.installed || '', hours_offset: v.hours_offset, notes: v.notes };
          if (v.sort !== null) row.sort = v.sort;
          if (!isNew) row.active = !!v.active;
          return saveRow('units', row).then(function () { UI.toast(isNew ? 'Агрегат додано' : 'Агрегат збережено', { tone: 'ok' }); reload(); return true; });
        }
      });
    }

    /* чек-лист і параметри */
    function itemMeta(it, showOcc) {
      var b = [UI.badge(lbl('item_type', it.type), 'muted')];
      if (it.type === 'number') {
        var nt = normText(it);
        if (nt) b.push('<span class="m-im">норма ' + esc(nt) + '</span>');
        if (it.target !== null && it.target !== undefined) b.push('<span class="m-im">ціль ' + esc(nf(it.target)) + (it.unit_label ? ' ' + esc(it.unit_label) : '') + '</span>');
        if (!nt && it.unit_label) b.push('<span class="m-im">' + esc(it.unit_label) + '</span>');
      }
      if (it.type === 'select') b.push('<span class="m-opts">' + (it.options || []).map(function (o) { var bad = o.charAt(0) === '!'; return '<span class="' + (bad ? 'bad' : '') + '">' + esc(bad ? o.slice(1) : o) + '</span>'; }).join('') + '</span>');
      if (it.unit_id) b.push('<span class="m-im">' + icon('box', 14) + esc(unitName(it.unit_id)) + '</span>');
      if (showOcc) b.push('<span class="m-im">' + esc((it.occasions || []).map(function (o) { return lbl('occasion', o); }).join(', ')) + '</span>');
      if (it.critical) b.push(UI.badge('критичний', 'bad'));
      if (!it.required) b.push(UI.badge('необовʼязковий', 'muted'));
      if (!it.active) b.push(UI.badge('вимкнено', 'muted'));
      return b.join('');
    }
    function itemsTab(l) {
      var all = rowsOf('items'), cnt = { '': 0 };
      rowsOf('items', true).forEach(function (it) { if (!it.active) return; cnt[''] ++; (it.occasions || []).forEach(function (o) { cnt[o] = (cnt[o] || 0) + 1; }); });
      var list = all.filter(function (it) { return !es.occ || (it.occasions || []).indexOf(es.occ) >= 0; });
      var secs = [], by = {};
      list.forEach(function (it) { var s = it.section || 'Без розділу'; if (!by[s]) { by[s] = []; secs.push(s); } by[s].push(it); });
      var h = toolbar(actBtn('add-item', 'Додати пункт', 'plus', { tone: 'primary' }) + actBtn('copy-items', 'Скопіювати з іншої лінії', 'copy'), offToggle(offCount('items'), es.off)) +
        '<div class="m-occ">' + UI.segmented({ name: 'eqocc', value: es.occ, size: 'sm', label: 'Коли', options: [
          { value: 'start', label: 'Запуск', count: cnt.start || 0 }, { value: 'changeover', label: 'Переналаштування', count: cnt.changeover || 0 },
          { value: 'end', label: 'Завершення', count: cnt.end || 0 }, { value: '', label: 'Усі пункти', count: cnt[''] }] }) + '</div>';
      if (!list.length) {
        return h + UI.emptyState({ icon: 'checklist', title: 'Пунктів немає', text: es.occ ? 'Для цього етапу пунктів ще немає. Додайте огляд вузлів, змащування, миття, налаштування й параметри з нормами.' : 'Чек-лист лінії порожній.' });
      }
      return h + secs.map(function (s) {
        return '<section class="m-isec"><h4>' + esc(s) + '<span>' + by[s].length + '</span></h4>' + by[s].map(function (it) {
          return '<button type="button" class="m-item' + (it.active ? '' : ' off') + '" data-open="item:' + esc(it.id) + '"><span class="m-item-sort num" title="Порядок">' + esc(it.sort === null || it.sort === undefined ? '' : nf(it.sort)) + '</span>' +
            '<span class="m-item-main"><span class="m-item-t">' + esc(it.text) + '</span><span class="m-item-meta">' + itemMeta(it, !es.occ) + '</span>' +
            (it.hint ? '<span class="m-item-hint">' + icon('info', 14) + esc(it.hint) + '</span>' : '') + '</span>' + icon('edit', 20, 'm-item-ed') + '</button>';
        }).join('') + '</section>';
      }).join('') + '<p class="dim small m-note">Порядок пунктів — поле «Порядок» (менше число — вище). Пункт із кількома етапами показується на кожному з них.</p>';
    }
    function itemForm(it) {
      var isNew = !it, v0 = it || { occasions: [es.occ || 'start'], type: 'check', required: true, critical: false, options: [] };
      var secs = datalistOf(rowsOf('items', true).map(function (x) { return x.section; }));
      var units = rowsOf('units', true).filter(function (u) { return u.active || (it && it.unit_id === u.id); });
      var body = '<div class="form-grid">' +
        UI.field.chips({ name: 'occasions', label: 'Коли перевіряти', multi: true, value: v0.occasions, required: true, className: 'span-2', options: UI.options('occasion') }) +
        UI.field.text({ name: 'section', label: 'Розділ', value: v0.section || '', datalist: secs, placeholder: 'Напр., Огляд вузлів', maxLength: 100 }) +
        UI.field.select({ name: 'unit_id', label: 'Агрегат', value: v0.unit_id || '', options: [{ value: '', label: 'Лінія загалом' }].concat(units.map(function (u) { return { value: u.id, label: u.name }; })) }) +
        UI.field.textarea({ name: 'text', label: 'Пункт / параметр', value: v0.text || '', required: true, className: 'span-2', rows: 2, maxLength: 500, placeholder: 'Напр., Тиск стисненого повітря' }) +
        UI.field.chips({ name: 'type', label: 'Тип відповіді', value: v0.type || 'check', className: 'span-2', options: [
          { value: 'check', label: 'Відмітка (норма / зауваження)' }, { value: 'number', label: 'Число з нормою' }, { value: 'select', label: 'Вибір варіанта' }, { value: 'text', label: 'Текст' }] }) +
        '<div class="span-2 form-grid m-sub" data-show="number">' +
        UI.field.text({ name: 'unit_label', label: 'Одиниця виміру', value: v0.unit_label || '', datalist: UNIT_LABELS, maxLength: 20, placeholder: 'бар, °C, г…' }) +
        UI.field.number({ name: 'target', label: 'Норма (ціль)', value: v0.target }) +
        UI.field.number({ name: 'min', label: 'Мінімум', value: v0.min, hint: 'Менше — «поза нормою»' }) +
        UI.field.number({ name: 'max', label: 'Максимум', value: v0.max, hint: 'Більше — «поза нормою»' }) + '</div>' +
        '<div class="span-2 m-sub" data-show="select">' +
        UI.field.textarea({ name: 'options', label: 'Варіанти', value: (v0.options || []).join('\n'), rows: 4, maxLength: 1000,
          hint: 'Кожен варіант з нового рядка. Поганий результат позначте «!» на початку, напр. «!Нечітке».' }) + '</div>' +
        UI.field.check({ name: 'required', label: 'Обовʼязковий пункт', value: v0.required !== false, hint: 'Без відповіді чек-лист не можна завершити' }) +
        UI.field.check({ name: 'critical', label: 'Критичний пункт', value: !!v0.critical, hint: 'Зауваження або значення поза нормою — чек-лист «Не пройдено»' }) +
        UI.field.text({ name: 'hint', label: 'Підказка для оператора', value: v0.hint || '', className: 'span-2', maxLength: 500, placeholder: 'Як перевірити, на що звернути увагу' }) +
        sortField(it) + '<div></div>' + activeField(it) + '</div>';
      function sync(root) {
        var t = UI.chipValue(root, 'type') || 'check';
        UI.qsa('[data-show]', root).forEach(function (el) { el.hidden = el.getAttribute('data-show') !== t; });
      }
      formModal({
        title: isNew ? 'Новий пункт чек-листа' : 'Пункт чек-листа', size: 'lg', body: body,
        onOpen: function (md) { sync(md.body); md.body.addEventListener('change', function (e) { if (e.detail && e.detail.name === 'type') sync(md.body); }); },
        extra: !isNew && it.active ? { label: 'Вимкнути', icon: 'power', tone: 'ghost', className: 'm-danger-t m-foot-left', onClick: function (mm) { mm.close(null); deactivate('items', it, 'пункт', reload); return false; } } : null,
        validate: function (v, mm) {
          var e = {};
          if (!v.occasions || !v.occasions.length) e.occasions = 'Оберіть хоча б один етап';
          if (!v.text) e.text = 'Сформулюйте пункт';
          numErrs(mm.body, v, e, v.type === 'number' ? { min: {}, max: {}, target: {}, sort: {} } : { sort: {} });
          if (v.type === 'number' && !e.min && !e.max && v.min !== null && v.max !== null && v.min > v.max) e.max = 'Максимум менший за мінімум';
          if (v.type === 'number' && !e.target && v.target !== null && ((v.min !== null && v.target < v.min) || (v.max !== null && v.target > v.max))) e.target = 'Норма поза межами мін–макс';
          if (v.type === 'select') {
            var ops = parseOptions(v.options);
            if (ops.length < 2) e.options = 'Потрібно щонайменше два варіанти';
            else if (!ops.some(function (o) { return o.charAt(0) !== '!'; })) e.options = 'Хоча б один варіант має бути «добрим» (без «!»)';
          }
          return e;
        },
        submit: function (v) {
          var row = { id: isNew ? Api.newId() : it.id, line_id: id, occasions: v.occasions, section: v.section, unit_id: v.unit_id || '', text: v.text, type: v.type || 'check',
            unit_label: v.type === 'number' ? v.unit_label : '', min: v.type === 'number' ? v.min : null, max: v.type === 'number' ? v.max : null,
            target: v.type === 'number' ? v.target : null, options: v.type === 'select' ? parseOptions(v.options) : [],
            required: !!v.required, critical: !!v.critical, hint: v.hint };
          if (v.sort !== null) row.sort = v.sort;
          if (!isNew) row.active = !!v.active;
          return saveRow('items', row).then(function () { UI.toast(isNew ? 'Пункт додано' : 'Пункт збережено', { tone: 'ok' }); reload(); return true; });
        }
      });
    }
    function parseOptions(s) { return String(s || '').split(/\r?\n|;/).map(function (x) { return x.trim(); }).filter(Boolean); }
    function copyItems() {
      var others = st.a.lines.filter(function (x) { return x.id !== id && x.active; }).sort(bySort);
      if (!others.length) { UI.alert({ title: 'Немає з чого копіювати', text: 'Інших активних ліній немає.' }); return; }
      var src = others[0].id;
      var body = '<div class="field"><label for="m_cp_src">З лінії</label>' + selectHtml('src', src, others.map(function (x) { return { value: x.id, label: x.name }; })).replace('<select ', '<select id="m_cp_src" ') + '</div>' +
        '<div class="m-cp-bar"><button type="button" class="btn sm ghost" data-cp="all">Вибрати всі</button><button type="button" class="btn sm ghost" data-cp="none">Зняти всі</button><span class="m-cp-n dim"></span></div>' +
        '<div class="m-cp-list"></div><p class="dim small">Агрегати зіставляються за назвою: якщо на цій лінії немає агрегату з такою самою назвою, пункт буде «для лінії загалом». Скопійовані пункти можна одразу відредагувати.</p>';
      var md = UI.modal({ title: 'Скопіювати пункти чек-листа', size: 'lg', className: 'm-modal', body: body, actions: [{ label: 'Скасувати', tone: 'ghost', value: null },
        { label: 'Скопіювати', icon: 'copy', tone: 'primary', onClick: function (mm) { return doCopy(mm); } }] });
      var listEl = md.body.querySelector('.m-cp-list'), nEl = md.body.querySelector('.m-cp-n');
      function srcItems() { return st.a.items.filter(function (x) { return x.line_id === src && x.active; }).sort(bySort); }
      function count() { var n = UI.qsa('input[data-cp-id]:checked', listEl).length; nEl.textContent = 'вибрано ' + n; return n; }
      var have = {};
      rowsOf('items', true).forEach(function (x) { if (x.active) have[String(x.text).trim().toLowerCase()] = 1; });
      function drawList() {
        var its = srcItems(), secs = [], by = {};
        its.forEach(function (x) { var s = x.section || 'Без розділу'; if (!by[s]) { by[s] = []; secs.push(s); } by[s].push(x); });
        listEl.innerHTML = its.length ? secs.map(function (s) {
          return '<div class="m-cp-sec"><div class="section-title">' + esc(s) + '</div>' + by[s].map(function (x) {
            var dup = has(have, String(x.text).trim().toLowerCase());
            return '<label class="check m-cp-it"><input type="checkbox" data-cp-id="' + esc(x.id) + '"' + (dup ? '' : ' checked') + '><span>' + esc(x.text) +
              ' <small class="dim">' + esc((x.occasions || []).map(function (o) { return lbl('occasion', o); }).join(', ') + ' · ' + lbl('item_type', x.type)) +
              (dup ? ' · <b class="c-warn">такий пункт уже є на цій лінії</b>' : '') + '</small></span></label>';
          }).join('') + '</div>';
        }).join('') : '<div class="list-empty">На цій лінії пунктів немає</div>';
        count();
      }
      md.body.addEventListener('change', function (e) { if (e.target && e.target.name === 'src') { src = e.target.value; drawList(); } else count(); });
      UI.delegate(md.body, 'click', '[data-cp]', function (e, b) { var on = b.getAttribute('data-cp') === 'all'; UI.qsa('input[data-cp-id]', listEl).forEach(function (c) { c.checked = on; }); count(); });
      function doCopy(mm) {
        var ids = UI.qsa('input[data-cp-id]:checked', listEl).map(function (c) { return c.getAttribute('data-cp-id'); });
        if (!ids.length) { mm.setError('Виберіть пункти для копіювання'); return false; }
        var unitsByName = {};
        rowsOf('units', true).forEach(function (u) { if (u.active) unitsByName[String(u.name).trim().toLowerCase()] = u.id; });
        var maxSort = 0;
        rowsOf('items', true).forEach(function (x) { if (x.sort > maxSort) maxSort = x.sort; });
        var base = Math.ceil(maxSort / 10) * 10;
        var ops = srcItems().filter(function (x) { return ids.indexOf(x.id) >= 0; }).map(function (x, i) {
          var su = x.unit_id ? findIn(st.a.units, x.unit_id) : null;
          return { op_id: 'cp' + i, action: 'save', table: 'items', row: { id: Api.newId(), line_id: id, unit_id: su ? (unitsByName[String(su.name).trim().toLowerCase()] || '') : '',
            occasions: x.occasions, section: x.section, text: x.text, type: x.type, unit_label: x.unit_label, min: x.min, max: x.max, target: x.target,
            options: x.options, required: x.required, critical: x.critical, hint: x.hint, sort: base + (x.sort || (i + 1) * 10) } };
        });
        var chunks = [];
        for (var i = 0; i < ops.length; i += 50) chunks.push(ops.slice(i, i + 50));
        var ok = 0, fails = [];
        return chunks.reduce(function (pr, ch) {
          return pr.then(function () {
            return Api.call('batch', { ops: ch }, { admin: true }).then(function (r) {
              if (!r.ok) { fails.push(errText(r)); return; }
              r.results.forEach(function (x) { if (x.ok) ok++; else fails.push(x.message || x.error); });
            });
          });
        }, Promise.resolve()).then(function () {
          if (ok) { touched(); reload(); }
          if (fails.length && !ok) throw new Error(fails[0]);
          UI.toast('Скопійовано ' + ok + ' ' + fmt.plural(ok, ['пункт', 'пункти', 'пунктів']) + (fails.length ? '; не вдалося: ' + fails.length + ' (' + fails[0] + ')' : ''), { tone: fails.length ? 'warn' : 'ok' });
          return true;
        });
      }
      drawList();
    }

    /* лічильники */
    function metersTab(l) {
      var ms = rowsOf('meters');
      return toolbar(actBtn('add-meter', 'Додати лічильник', 'plus', { tone: 'primary' }), offToggle(offCount('meters'), es.off)) +
        '<p class="dim small m-note">Мотогодини лінії рахуються автоматично з журналу стану — окремий лічильник для них не потрібен. Тут — інші лічильники: цикли, вироблені одиниці, етикетки.</p>' +
        rtable([
          { label: 'Лічильник', cls: 'm-rt-main', html: function (m) { return '<b>' + esc(m.name) + '</b>' + (m.unit_id ? '<small class="dim">' + esc(unitName(m.unit_id)) + '</small>' : '') + (m.active ? '' : ' ' + UI.badge('вимкнено', 'muted')); } },
          { label: 'Облік', html: function (m) { return esc(lbl('meter_mode', m.mode)) + (m.ask_on_end ? '<small class="dim">питати при завершенні</small>' : ''); } },
          { label: 'Показник', cls: 'num', html: function (m) { return m.value !== null && m.value !== undefined ? '<b>' + esc(nf(m.value)) + '</b> ' + esc(m.unit_label || '') + (m.value_ts ? '<small class="dim">' + esc(fmt.dt(m.value_ts)) + '</small>' : '') : '<span class="dim">ще немає</span>'; } },
          { label: 'У середньому', cls: 'num', html: function (m) { return m.avg_per_day ? esc(nf(m.avg_per_day, 0)) + ' ' + esc(m.unit_label || '') + '/добу' : ''; } },
          { label: '', cls: 'm-act', html: function (m) { return m.active ? '<button type="button" class="btn sm" data-m="reading" data-id="' + esc(m.id) + '">' + icon('edit', 16) + '<span>Показник</span></button>' : ''; } }
        ], ms, { empty: 'Лічильників немає', attrs: function (m) { return { 'data-open': 'meter:' + m.id, class: 'clickable' + (m.active ? '' : ' m-off-row'), tabindex: '0' }; } });
    }
    function meterForm(m) {
      var isNew = !m, units = rowsOf('units', true).filter(function (u) { return u.active || (m && m.unit_id === u.id); });
      var body = '<div class="form-grid">' +
        UI.field.text({ name: 'name', label: 'Назва', value: m ? m.name : '', required: true, className: 'span-2', maxLength: 200, placeholder: 'Напр., Цикли дозатора' }) +
        UI.field.select({ name: 'unit_id', label: 'Агрегат', value: m ? m.unit_id : '', options: [{ value: '', label: 'Лінія загалом' }].concat(units.map(function (u) { return { value: u.id, label: u.name }; })) }) +
        UI.field.text({ name: 'unit_label', label: 'Одиниця', value: m ? m.unit_label : '', datalist: ['шт', 'цикл.', 'м', 'кг', 'л', 'уп.'], maxLength: 20 }) +
        UI.field.chips({ name: 'mode', label: 'Як вносять показник', value: m ? m.mode : 'abs', className: 'span-2', options: [{ value: 'abs', label: 'Показник табло (лише зростає)' }, { value: 'inc', label: 'Приріст за зміну' }] }) +
        '<p class="span-2 dim small m-formhint">«Показник табло» — число з лічильника агрегату, як є. «Приріст за зміну» — скільки додалося за зміну (напр., вироблено штук); застосунок сам підсумовує.</p>' +
        UI.field.check({ name: 'ask_on_end', label: 'Питати при завершенні роботи', value: m ? !!m.ask_on_end : false, className: 'span-2', hint: 'Оператор внесе показник у чек-листі завершення' }) +
        sortField(m) + '<div></div>' + activeField(m) + '</div>';
      formModal({
        title: isNew ? 'Новий лічильник' : 'Лічильник: ' + m.name, body: body,
        extra: !isNew && m.active ? { label: 'Вимкнути', icon: 'power', tone: 'ghost', className: 'm-danger-t m-foot-left', onClick: function (mm) { mm.close(null); deactivate('meters', m, 'лічильник', reload); return false; } } : null,
        validate: function (v, mm) { var e = {}; if (!v.name) e.name = 'Вкажіть назву'; numErrs(mm.body, v, e, { sort: {} }); return e; },
        submit: function (v) {
          var row = { id: isNew ? Api.newId() : m.id, line_id: id, name: v.name, unit_id: v.unit_id || '', unit_label: v.unit_label, mode: v.mode || 'abs', ask_on_end: !!v.ask_on_end };
          if (v.sort !== null) row.sort = v.sort;
          if (!isNew) row.active = !!v.active;
          return saveRow('meters', row).then(function () { UI.toast(isNew ? 'Лічильник додано' : 'Лічильник збережено', { tone: 'ok' }); reload(); return true; });
        }
      });
    }
    function readingEntry(m) {
      UI.keypad({ title: m.name, mode: 'decimal', unit: m.unit_label || '', submitLabel: 'Записати',
        text: m.mode === 'inc' ? 'Скільки додалося (приріст)' : 'Поточний показник на табло' + (m.value !== null && m.value !== undefined ? ' (останній: ' + nf(m.value) + ')' : ''),
        onSubmit: function (s) { var n = UI.num(s); return n === null || n < 0 ? 'Введіть невідʼємне число' : true; }
      }).then(function (s) {
        if (s === null) return;
        Api.write('reading', { meter_id: m.id, value: UI.num(s), mode: m.mode, operator: 'Керівник', note: 'Внесено в розділі керівництва' }, { wait: 5000 }).then(function (r) {
          if (!r.ok && !memQueued(r)) { if (r.op) Api.discardRejected(r.op.op_id); UI.alert({ title: 'Показник не записано', text: r.message || 'Сервер відхилив запис' }); return; }
          if (memQueued(r)) UI.toast('Показник прийнято, але пам’ять пристрою заповнена — не закривайте застосунок, доки запис не надішлеться', { tone: 'warn', ms: 8000 });
          else UI.toast(r.queued ? 'Показник збережено на пристрої — надішлеться автоматично' : 'Показник записано', { tone: r.queued ? 'info' : 'ok' });
          touched();
          reload();
        });
      });
    }

    /* регламент ТО і ППР */
    function intervalsText(r) {
      var a = [], m = r.meter_id ? meterAny(r.meter_id) || findIn(st.a.meters, r.meter_id) : null;
      if (r.interval_days > 0) a.push(nf(r.interval_days) + ' дн.');
      if (r.interval_hours > 0) a.push(nf(r.interval_hours) + ' мотогод');
      if (r.interval_meter > 0) a.push(nf(r.interval_meter) + ' ' + (m && m.unit_label ? m.unit_label : 'од.') + (m ? ' («' + m.name + '»)' : ''));
      if (!a.length) return 'інтервал не задано';
      return 'кожні ' + a.join(' або ') + (a.length > 1 ? ' — що настане раніше' : '');
    }
    function rulesTab(l) {
      var rs = rowsOf('rules'), S = App.state && App.state.settings || {};
      return toolbar(actBtn('add-rule', 'Додати роботу', 'plus', { tone: 'primary' }), offToggle(offCount('rules'), es.off)) +
        (rs.length ? '<div class="m-rules">' + rs.map(function (r) {
          var d = r.active ? findDue(r.id) : null;
          var warn = [r.warn_days !== null && r.warn_days !== undefined ? 'за ' + nf(r.warn_days) + ' дн.' : '', r.warn_pct ? 'з ' + nf(r.warn_pct) + ' %' : ''].filter(Boolean).join(' / ');
          return '<article class="m-rule' + (r.active ? '' : ' off') + (d ? ' s-' + esc(d.status) : '') + (r.id === focusRule ? ' focus' : '') + '" data-rule="' + esc(r.id) + '">' +
            '<div class="m-rule-h"><div class="m-rule-tt"><h4>' + esc(r.title) + '</h4><div class="m-due-where">' + esc([lbl('work_type', r.work_type), r.unit_id ? unitName(r.unit_id) : 'лінія загалом', r.part].filter(Boolean).join(' · ')) + '</div></div>' +
            (d ? dueBadge(d.status) : r.active ? '' : UI.badge('вимкнено', 'muted')) + '</div>' +
            '<div class="m-rule-i">' + icon('calendar', 16) + esc(intervalsText(r)) + '</div>' +
            (d && d.status !== 'none' ? '<div class="m-due-prog">' + UI.progress(d.pct, d.status) + '<span class="num">' + esc(fmt.frac(d.pct)) + '</span></div><div class="m-due-sum"><span>' + esc(d.summary) + '</span><span class="dim">' + esc(dueWhen(d)) + '</span></div>' : '') +
            '<div class="m-rule-f dim small">' + esc(r.last_date ? 'Востаннє: ' + fmt.date(r.last_date) : 'Відлік від ' + (r.base_date ? fmt.date(r.base_date) : '—') + ' (у журналі ще не виконувалась)') +
            (warn ? ' · попереджати ' + esc(warn) : ' · попереджати як у налаштуваннях (' + esc(nf(S.warn_days)) + ' дн. / ' + esc(nf(S.warn_pct)) + ' %)') +
            (r.notify ? ' · листи: ' + esc(r.notify) : '') + '</div>' +
            '<div class="m-rule-a"><button type="button" class="btn sm ghost" data-m="edit-rule" data-id="' + esc(r.id) + '">' + icon('edit', 18) + '<span>Змінити</span></button>' +
            (d ? '<button type="button" class="btn sm" data-m="done-rule" data-id="' + esc(r.id) + '">' + icon('check', 18) + '<span>Позначити виконаним</span></button>' : '') + '</div></article>';
        }).join('') + '</div>' : UI.emptyState({ icon: 'wrench', title: 'Регламент не задано', text: 'Додайте роботи ТО і ППР з інтервалами: за календарем, мотогодинами або лічильником.' }));
    }
    function ruleForm(r) {
      var isNew = !r, canHelp = isNew || !r.last_date, S = App.state && App.state.settings || {};
      var ms = rowsOf('meters', true).filter(function (m) { return m.active || (r && r.meter_id === m.id); });
      var units = rowsOf('units', true).filter(function (u) { return u.active || (r && r.unit_id === u.id); });
      var body = '<div class="form-grid">' +
        UI.field.text({ name: 'title', label: 'Робота', value: r ? r.title : '', required: true, className: 'span-2', maxLength: 200, placeholder: 'Напр., Заміна фільтра компресора' }) +
        UI.field.select({ name: 'work_type', label: 'Вид', value: r ? r.work_type : 'to', options: UI.options('work_type') }) +
        UI.field.select({ name: 'unit_id', label: 'Агрегат', value: r ? r.unit_id : '', options: [{ value: '', label: 'Лінія загалом' }].concat(units.map(function (u) { return { value: u.id, label: u.name }; })) }) +
        UI.field.text({ name: 'part', label: 'Деталь / вузол', value: r ? r.part : '', className: 'span-2', maxLength: 200 }) +
        '<fieldset class="span-2 m-fs"><legend>Інтервал — що настане раніше</legend><div class="form-grid">' +
        UI.field.number({ name: 'interval_days', label: 'За календарем', value: r ? r.interval_days : null, unit: 'дн.' }) +
        UI.field.number({ name: 'interval_hours', label: 'За мотогодинами лінії', value: r ? r.interval_hours : null, unit: 'мотогод' }) +
        UI.field.select({ name: 'meter_id', label: 'За лічильником', value: r ? r.meter_id : '', options: [{ value: '', label: 'Без лічильника' }].concat(ms.map(function (m) { return { value: m.id, label: m.name + (m.unit_label ? ', ' + m.unit_label : '') }; })),
          hint: ms.length ? '' : 'Лічильників на лінії немає — додайте їх на вкладці «Лічильники»' }) +
        UI.field.number({ name: 'interval_meter', label: 'Інтервал за лічильником', value: r ? r.interval_meter : null }) +
        '</div></fieldset>' +
        UI.field.number({ name: 'warn_days', label: 'Попереджати за', value: r ? r.warn_days : null, unit: 'дн.', hint: 'Порожньо — як у налаштуваннях (' + nf(S.warn_days) + ' дн.)' }) +
        UI.field.number({ name: 'warn_pct', label: 'Попереджати з', value: r ? r.warn_pct : null, unit: '%', hint: 'Порожньо — ' + nf(S.warn_pct) + ' % інтервалу' }) +
        UI.field.text({ name: 'notify', label: 'Email для сповіщень', value: r ? r.notify : '', className: 'span-2', maxLength: 500, placeholder: 'mechanic@zavod.ua', hint: 'Додатково до керівництва й механіків / електриків лінії з розділу «Персонал»; кілька — через кому' }) +
        UI.field.textarea({ name: 'instructions', label: 'Інструкція', value: r ? r.instructions : '', className: 'span-2', rows: 3, maxLength: 4000, placeholder: 'Що зробити, які матеріали, на що звернути увагу' }) +
        (canHelp ? '<fieldset class="span-2 m-fs"><legend>' + (isNew ? 'Відлік першого строку' : 'Змінити відлік') + '</legend>' +
          '<p class="dim small">Вкажіть, коли роботу виконували востаннє, — напрацювання відтоді застосунок порахує з журналу. ' +
          '«Напрацювання відтоді» / «За лічильником відтоді» заповнюйте лише для дати до початку обліку (загальне напрацювання з того часу). ' +
          (isNew ? 'Якщо поля порожні, відлік почнеться з сьогодні.' : 'Порожні поля — відлік не змінюється.') + '</p><div class="form-grid">' +
          UI.field.date({ name: 'last_done_date', label: 'Востаннє виконано', attrs: { max: todayKey() } }) +
          UI.field.number({ name: 'used_hours', label: 'Напрацювання відтоді', unit: 'мотогод', hint: 'Лише для дати до початку обліку; порожньо — з журналу' }) +
          UI.field.number({ name: 'used_meter', label: 'За лічильником відтоді', hint: 'Якщо задано лічильник; порожньо — з журналу' }) + '</div></fieldset>'
          : '<div class="span-2 box info m-formhint">' + icon('info') + 'Відлік веде журнал робіт: востаннє виконано ' + esc(fmt.date(r.last_date)) + '. Щоб задати нове виконання, запишіть роботу («Позначити виконаним»).</div>') +
        sortField(r) + '<div></div>' + activeField(r) + '</div>';
      formModal({
        title: isNew ? 'Нова робота ТО / ППР' : 'Регламент: ' + r.title, size: 'lg', body: body,
        extra: !isNew && r.active ? { label: 'Вимкнути', icon: 'power', tone: 'ghost', className: 'm-danger-t m-foot-left', onClick: function (mm) { mm.close(null); deactivate('rules', r, 'роботу регламенту', reload); return false; } } : null,
        validate: function (v, mm) {
          var e = {};
          if (!v.title) e.title = 'Вкажіть назву роботи';
          numErrs(mm.body, v, e, { interval_days: { min: 0 }, interval_hours: { min: 0 }, interval_meter: { min: 0 }, warn_days: { min: 0 }, warn_pct: { min: 1, max: 100 },
            used_hours: { min: 0 }, used_meter: { min: 0 }, sort: {} });
          if (!e.interval_meter && v.interval_meter > 0 && !v.meter_id) e.meter_id = 'Оберіть лічильник';
          if (!e.interval_days && !e.interval_hours && !e.interval_meter && !(v.interval_days > 0) && !(v.interval_hours > 0) && !(v.interval_meter > 0 && v.meter_id)) {
            e.interval_days = 'Задайте хоча б один інтервал: дні, мотогодини або лічильник';
          }
          var bad = String(v.notify || '').split(/[,;\s]+/).filter(function (x) { return x && !U.isEmail(x); });
          if (bad.length) e.notify = 'Невірний email: ' + bad[0];
          if (v.last_done_date && v.last_done_date > todayKey()) e.last_done_date = 'Дата не може бути в майбутньому';
          return e;
        },
        submit: function (v) {
          var row = { id: isNew ? Api.newId() : r.id, line_id: id, title: v.title, work_type: v.work_type, unit_id: v.unit_id || '', part: v.part,
            interval_days: v.interval_days, interval_hours: v.interval_hours, meter_id: v.meter_id || '', interval_meter: v.meter_id ? v.interval_meter : null,
            warn_days: v.warn_days, warn_pct: v.warn_pct, notify: v.notify, instructions: v.instructions };
          if (v.sort !== null) row.sort = v.sort;
          if (!isNew) row.active = !!v.active;
          if (canHelp) {
            if (v.last_done_date) row.last_done_date = v.last_done_date;
            if (v.used_hours !== null && v.used_hours !== undefined) row.used_hours = v.used_hours;
            if (v.meter_id && v.used_meter !== null && v.used_meter !== undefined) row.used_meter = v.used_meter;
          }
          return saveRow('rules', row).then(function () { UI.toast(isNew ? 'Роботу додано до регламенту' : 'Регламент збережено', { tone: 'ok' }); reload(); return true; });
        }
      });
    }

    function load(force) {
      loadAdmin(force).then(function (r) {
        if (!ctx.alive()) return;
        if (r.ok) { st.a = r; st.err = null; } else if (!st.a) st.err = r;
        draw();
      });
    }
    function reload() { load(true); }
    function rowById(t, rid) { return st.a ? findIn(st.a[t], rid) : null; }
    host.addEventListener('change', function (e) {
      var dn = e.detail && e.detail.name;
      if (dn === 'eqtab') { es.tab = e.detail.value; drawTab(); return; }
      if (dn === 'eqocc') { es.occ = e.detail.value; drawTab(); return; }
      if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-m-off')) { es.off = e.target.checked; drawTab(); }
    });
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-m], [data-action]');
      if (!b) return;
      var a = b.getAttribute('data-m') || b.getAttribute('data-action'), rid = b.getAttribute('data-id'), l = L();
      if (a === 'retry') { st.err = null; draw(); load(true); return; }
      if (!l) return;
      if (a === 'edit-line') lineForm(l, reload);
      else if (a === 'on-line') saveRow('lines', { id: l.id, active: true }).then(function () { UI.toast('Лінію увімкнено', { tone: 'ok' }); reload(); }, function (er) { UI.alert({ title: 'Не вдалося', text: er.message }); });
      else if (a === 'add-unit') unitForm(null);
      else if (a === 'add-item') itemForm(null);
      else if (a === 'copy-items') copyItems();
      else if (a === 'add-meter') meterForm(null);
      else if (a === 'reading') { var m = rowById('meters', rid); if (m) readingEntry(m); }
      else if (a === 'add-rule') ruleForm(null);
      else if (a === 'edit-rule') { var r = rowById('rules', rid); if (r) ruleForm(r); }
      else if (a === 'done-rule') { var d = findDue(rid); if (d) markDone(d, reload); }
    });
    bindRows(host, function (key) {
      var i = key.indexOf(':'), t = key.slice(0, i), rid = key.slice(i + 1);
      if (t === 'unit') { var u = rowById('units', rid); if (u) unitForm(u); }
      else if (t === 'item') { var it = rowById('items', rid); if (it) itemForm(it); }
      else if (t === 'meter') { var m = rowById('meters', rid); if (m) meterForm(m); }
    });
    draw();
    load(false);
    return { onBoot: function (s, meta) { if (!(meta && meta.source === 'queue')) load(false); }, onQueue: function () {} };
  }

  /* ================================= ПЕРСОНАЛ ================================= */
  var staffOff = false;
  /* хто з «Персонал» отримує листи (ядро: MAIL_ROLES; потрібні email і активність) */
  var MAIL_ROLES_TEXT = 'Керівник — усі листи (щоденний звіт, строки ТО, ремонти, зауваження в чек-листах); Механік / Електрик — строки ТО і ремонти; ' +
    'Контроль якості — зауваження в чек-листах; Оператор / Наладчик — листів не отримують. Вибрані «Лінії» обмежують листи про події цими лініями';
  function mailHint(role, hasLines) {
    var what = { manager: 'всі листи: щоденний звіт, строки ТО, ремонти, зауваження в чек-листах', mechanic: 'листи про строки ТО і ремонти',
      electrician: 'листи про строки ТО і ремонти', qa: 'листи про зауваження в чек-листах' }[role];
    if (!what) return (lbl('role', role) || 'Ця посада') + ' — листів не отримує (листи — керівникам, механікам, електрикам і контролю якості).';
    return 'Отримуватиме ' + what + (hasLines ? (role === 'manager' ? ' (про події — лише вибраних ліній, звіт — повний)' : ' — лише вибраних ліній') : ' — про всі лінії') + '.';
  }
  function staffView(p, host, ctx) {
    var sh = shell(host, 'staff', { title: 'Персонал', actions: actBtn('add-staff', 'Додати людину', 'plus', { tone: 'primary' }) });
    var st = { a: cache.admin, err: null };
    function linesText(s) {
      if (!s.line_ids || !s.line_ids.length) return '<span class="dim">усі лінії</span>';
      return esc(s.line_ids.map(lineName).join(', '));
    }
    function draw() {
      if (!ctx.alive()) return;
      if (!st.a) { sh.body.innerHTML = st.err ? errBox(st.err, 'retry') : UI.spinner('Завантаження…'); return; }
      var all = st.a.staff.slice().sort(bySort), off = all.filter(function (s) { return !s.active; }).length;
      var list = all.filter(function (s) { return staffOff || s.active; }), badPin = badPinIds(st.a.config_issues);
      sh.body.innerHTML = '<div class="m-tb"><span class="muted">' + all.filter(function (s) { return s.active; }).length + ' активних</span><span class="grow"></span>' + offToggle(off, staffOff) + '</div>' +
        rtable([
          { label: 'ПІБ', cls: 'm-rt-main', html: function (s) { return '<b>' + esc(s.name) + '</b>' + (s.active ? '' : ' ' + UI.badge('вимкнено', 'muted')); } },
          { label: 'Посада', html: function (s) { return esc(lbl('role', s.role)); } },
          { label: 'Лінії', html: linesText },
          { label: 'Email', html: function (s) { return s.email ? '<span class="m-mail">' + esc(s.email) + '</span>' : ''; } },
          { label: 'PIN', html: function (s) {
            if (badPin[s.id]) return UI.badge('PIN некоректний', 'bad', { icon: 'alert' }) + '<small class="dim">вхід за PIN не працює</small>';
            return s.has_pin ? '<span class="m-pin">' + icon('lock', 16) + 'є</span>' : '<span class="dim">без PIN</span>';
          } }
        ], list, { empty: 'Людей ще немає', attrs: function (s) { return { 'data-open': s.id, class: 'clickable' + (s.active ? '' : ' m-off-row'), tabindex: '0' }; } }) +
        '<p class="dim small m-note">Оператор обирає себе на планшеті перед записом. Якщо задано PIN — його треба ввести. «Лінії» обмежують, на яких планшетах людина в списку; порожньо — усі лінії.</p>' +
        '<p class="dim small m-note">' + icon('send', 16) + ' Листи отримують активні люди з email — за посадою: ' + esc(MAIL_ROLES_TEXT) + '.</p>';
    }
    function staffForm(s) {
      var isNew = !s, ls = (st.a.lines || []).filter(function (l) { return l.active || (s && s.line_ids.indexOf(l.id) >= 0); }).sort(bySort);
      var pinBad = !!(s && badPinIds(st.a.config_issues)[s.id]);
      var body = '<div class="form-grid">' +
        UI.field.text({ name: 'name', label: 'Прізвище та імʼя', value: s ? s.name : '', required: true, className: 'span-2', maxLength: 120 }) +
        UI.field.select({ name: 'role', label: 'Посада', value: s ? s.role : 'operator', options: UI.options('role') }) +
        UI.field.email({ name: 'email', label: 'Email', value: s ? s.email : '', maxLength: 200, placeholder: 'необовʼязково',
          hint: mailHint(s ? s.role : 'operator', !!(s && s.line_ids.length)) }) +
        UI.field.chips({ name: 'line_ids', label: 'Лінії', multi: true, value: s ? s.line_ids : [], className: 'span-2', options: ls.map(function (l) { return { value: l.id, label: l.name }; }),
          hint: 'Не вибрано жодної — усі лінії (і на планшетах, і в листах)' }) +
        UI.field.password({ name: 'pin', label: s && s.has_pin ? 'Новий PIN' : 'PIN', maxLength: 8, inputmode: 'numeric', attrs: { autocomplete: 'new-password', pattern: '[0-9]*' },
          placeholder: s && s.has_pin && !pinBad ? 'не змінювати' : 'без PIN',
          hint: pinBad ? 'PIN у Google-таблиці некоректний, вхід за ним не працює — введіть новий (4–8 цифр) або приберіть PIN.' : '4–8 цифр. Оператор вводить його на планшеті.' }) +
        (s && s.has_pin ? UI.field.check({ name: 'clear_pin', label: 'Прибрати PIN', value: false, className: 'm-chk-al' }) : '<div></div>') +
        sortField(s) + '<div></div>' + activeField(s) + '</div>';
      formModal({
        title: isNew ? 'Нова людина' : s.name, body: body,
        onOpen: function (md) {
          // підказка «хто отримує листи» — за вибраною посадою й лініями
          var upd = function () {
            var v = UI.readForm(md.body), h = md.body.querySelector('[data-field="email"] .field-hint');
            if (h) h.textContent = mailHint(v.role, !!(v.line_ids && v.line_ids.length));
          };
          md.body.addEventListener('change', upd);
        },
        extra: !isNew && s.active ? { label: 'Вимкнути', icon: 'power', tone: 'ghost', className: 'm-danger-t m-foot-left', onClick: function (mm) { mm.close(null); deactivate('staff', s, 'людину', function () { load(true); }); return false; } } : null,
        validate: function (v, mm) {
          var e = {};
          if (!v.name) e.name = 'Вкажіть ПІБ';
          if (v.email && !U.isEmail(v.email)) e.email = 'Невірний email';
          if (v.pin && !/^\d{4,8}$/.test(v.pin)) e.pin = 'PIN — від 4 до 8 цифр';
          if (v.pin && v.clear_pin) e.pin = 'Або новий PIN, або «Прибрати PIN»';
          numErrs(mm.body, v, e, { sort: {} });
          return e;
        },
        submit: function (v) {
          var row = { id: isNew ? Api.newId() : s.id, name: v.name, role: v.role, email: v.email, line_ids: v.line_ids || [] };
          if (v.sort !== null) row.sort = v.sort;
          if (!isNew) row.active = !!v.active;
          if (v.pin) row.pin = v.pin;
          if (v.clear_pin) row.clear_pin = true;
          return saveRow('staff', row).then(function () { UI.toast(isNew ? 'Людину додано' : 'Збережено', { tone: 'ok' }); load(true); return true; });
        }
      });
    }
    function load(force) {
      loadAdmin(force).then(function (r) {
        if (!ctx.alive()) return;
        if (r.ok) { st.a = r; st.err = null; } else if (!st.a) st.err = r;
        draw();
      });
    }
    host.addEventListener('change', function (e) { if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-m-off')) { staffOff = e.target.checked; draw(); } });
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-m]');
      if (!b) return;
      var a = b.getAttribute('data-m');
      if (a === 'add-staff') { if (st.a) staffForm(null); }
      else if (a === 'retry') { st.err = null; draw(); load(true); }
    });
    bindRows(host, function (sid) { var s = st.a && findIn(st.a.staff, sid); if (s) staffForm(s); });
    draw();
    load(false);
    return { onBoot: function (s, meta) { if (!(meta && meta.source === 'queue')) load(false); }, onQueue: function () {} };
  }

  /* ================================= НАЛАШТУВАННЯ ================================= */
  var SGROUPS = [
    { title: 'Підприємство', icon: 'home', keys: ['company', 'tz', 'app_url'] },
    { title: 'Звіти й сповіщення', icon: 'send', keys: ['manager_emails', 'digest_hour', 'digest_mode', 'instant_due', 'instant_checklist', 'instant_repair'] },
    { title: 'ТО і план ППР', icon: 'wrench', keys: ['warn_days', 'warn_pct', 'avg_window_days', 'plan_horizon_days'] },
    { title: 'Чек-листи й робота ліній', icon: 'checklist', keys: ['require_start_checklist', 'require_end_checklist', 'checklist_valid_hours', 'long_run_hours'] },
    { title: 'Планшети', icon: 'tablet', keys: ['stop_reasons', 'products', 'refresh_sec'] }
  ];
  var SLABEL = {
    company: 'Назва підприємства', tz: 'Часовий пояс', app_url: 'Адреса застосунку', manager_emails: 'Email керівництва', digest_hour: 'Година щоденного звіту',
    digest_mode: 'Коли надсилати звіт', instant_due: 'Лист, коли настав строк ТО', instant_checklist: 'Лист про зауваження в чек-листі', instant_repair: 'Лист про ремонт / аварійну зупинку',
    warn_days: 'Попереджати про ТО за', warn_pct: 'Попереджати з', avg_window_days: 'Середнє напрацювання — за', plan_horizon_days: 'Горизонт плану ППР',
    require_start_checklist: 'Вимагати чек-лист перед запуском', require_end_checklist: 'Вимагати чек-лист при завершенні', checklist_valid_hours: 'Чек-лист запуску чинний',
    long_run_hours: 'Попереджати про роботу без завершення після', stop_reasons: 'Причини простою', products: 'Продукти / формати', refresh_sec: 'Оновлення даних на планшетах'
  };
  var SUNIT = { digest_hour: 'год', warn_days: 'дн.', warn_pct: '%', avg_window_days: 'дн.', plan_horizon_days: 'дн.', checklist_valid_hours: 'год', long_run_hours: 'год', refresh_sec: 'с' };
  var TZS = ['Europe/Kyiv', 'Europe/Warsaw', 'Europe/Bucharest', 'Europe/Berlin', 'Europe/London', 'UTC'];
  function settingField(m, val) {
    var name = 's_' + m.key, lab = SLABEL[m.key] || m.key, hint = m.note || '';
    switch (m.type) {
      case 'bool': return UI.field.check({ name: name, label: lab, value: !!val, hint: hint, className: 'span-2' });
      case 'num':
        return UI.field.number({ name: name, label: lab, value: val, unit: SUNIT[m.key] || '', hint: hint + (m.min !== undefined && hint.indexOf(nf(m.min) + '–') < 0 ? '. Допустимо: ' + nf(m.min) + '–' + nf(m.max) + '.' : '') });
      case 'choice':
        return UI.field.select({ name: name, label: lab, value: val, hint: m.key === 'digest_mode' ? 'Щоденний звіт на email керівництва' : hint, options: (m.values || []).map(function (x) { return { value: x, label: x === 'always' ? 'Щодня' : x === 'if_any' ? 'Лише коли є що повідомити' : x }; }) });
      case 'list':
        return UI.field.textarea({ name: name, label: lab, value: (val || []).join('\n'), rows: 5, className: 'span-2', hint: 'Кожен пункт з нового рядка.', maxLength: 4000 });
      case 'emails':
        if (m.key === 'manager_emails') hint += '. Можна з нового рядка. Керівники з email у розділі «Персонал» отримують листи й без цього поля; механіки, електрики й контроль якості — листи за своєю посадою.';
        else hint += '. Можна з нового рядка.';
        return UI.field.textarea({ name: name, label: lab, value: (val || []).join(', '), rows: 2, className: 'span-2', hint: hint, maxLength: 2000, placeholder: 'director@zavod.ua, engineer@zavod.ua' });
      case 'tz':
        return UI.field.text({ name: name, label: lab, value: val, hint: hint, datalist: TZS, maxLength: 60 });
      default:
        return UI.field.text({ name: name, label: lab, value: val, hint: hint, maxLength: 500, className: m.key === 'app_url' ? 'span-2' : '', placeholder: m.key === 'app_url' ? 'https://…/lines/' : '' });
    }
  }
  function settingValue(m, raw) {
    switch (m.type) {
      case 'bool': return !!raw;
      case 'list': return String(raw || '').split(/\r?\n|;/).map(function (x) { return x.trim(); }).filter(Boolean);
      case 'emails': return String(raw || '').split(/[,;\s]+/).map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
      default: return raw;
    }
  }
  function settingsView(p, host, ctx) {
    var sh = shell(host, 'settings', { title: 'Налаштування', actions: actBtn('save', 'Зберегти', 'check', { tone: 'primary' }) });
    var st = { a: cache.admin, err: null, notices: null, digest: null };
    var META = LinesCore.SETTINGS_META.filter(function (m) { return !m.service; });
    function cur() { return (st.a && st.a.settings) || {}; }
    function formHtml() {
      var S = cur(), used = {};
      var groups = SGROUPS.map(function (g) { return { title: g.title, icon: g.icon, metas: g.keys.map(function (k) { used[k] = 1; return META.filter(function (m) { return m.key === k; })[0]; }).filter(Boolean) }; });
      var rest = META.filter(function (m) { return !used[m.key]; });
      if (rest.length) groups.push({ title: 'Інше', icon: 'sliders', metas: rest });
      return '<div class="m-set" data-track-dirty>' + groups.map(function (g) {
        return card(g.title, '<div class="form-grid">' + g.metas.map(function (m) { return settingField(m, has(S, m.key) ? S[m.key] : m.def); }).join('') + '</div>', { icon: g.icon });
      }).join('') + '<div class="form-actions m-set-act"><button type="button" class="btn primary" data-m="save">' + icon('check') + '<span>Зберегти налаштування</span></button></div></div>';
    }
    function connHtml() {
      var c = Api.config(), n = Api.net(), S = cur(), ep = c.endpoint || '';
      var shortEp = ep.length > 60 ? ep.slice(0, 42) + '…' + ep.slice(-14) : ep;
      return UI.kv([
        ['Режим', c.mode === 'local' ? 'Демо на цьому пристрої' : 'Google-таблиця (Apps Script)'],
        c.mode === 'remote' ? ['Сервер', '<span class="mono small" title="' + esc(ep) + '">' + esc(shortEp) + '</span>'] : null,
        ['Google-таблиця', safeUrl(S.sheet_url) ? '<a href="' + esc(safeUrl(S.sheet_url)) + '" target="_blank" rel="noopener noreferrer">' + icon('external', 16) + ' Відкрити таблицю</a>' :
          '<span class="dim">' + (c.mode === 'local' ? 'у демо-режимі таблиці немає' : 'посилання зʼявиться після «Початкового налаштування» в таблиці') + '</span>'],
        ['Адреса застосунку', safeUrl(S.app_url) ? '<a href="' + esc(safeUrl(S.app_url)) + '" target="_blank" rel="noopener noreferrer">' + esc(S.app_url) + '</a>' : S.app_url ? esc(S.app_url) : '<span class="dim">не задано (потрібна для посилань у листах)</span>'],
        ['Цей пристрій', esc(c.device || '—')],
        ['Версії', 'застосунок ' + esc(App.VERSION) + ' · ядро ' + esc(LinesCore.VERSION) + (App.state && App.state.version ? ' · сервер ' + esc(App.state.version) : '')],
        c.mode === 'remote' ? ['Останній обмін', n.last_ok_at ? esc(fmt.dt(new Date(n.last_ok_at))) : '—'] : null
      ]) + '<div class="btn-row m-cbtn"><a class="btn sm" href="#/device">' + icon('tablet', 18) + '<span>Налаштування пристрою</span></a></div>';
    }
    function serviceHtml() {
      return '<div class="m-svc">' +
        '<div class="m-svc-i"><div><b>Перерахувати мотогодини й строки</b><p class="dim small">Якщо журнали правили прямо в таблиці: перерахунок станів ліній, мотогодин, лічильників і строків ТО з журналів.</p></div>' + actBtn('recompute', 'Перерахувати', 'refresh') + '</div>' +
        (App.mode() === 'local' ? '<div class="m-svc-i"><div><b>Скинути демо-дані</b><p class="dim small">Стерти всі записи демо-режиму на цьому пристрої й створити демо-дані заново на сьогодні.</p></div>' + actBtn('reset-demo', 'Скинути', 'trash', { tone: 'danger' }) + '</div>' : '') +
        '<div class="m-svc-i"><div><b>Вийти з режиму керівника</b><p class="dim small">На цьому пристрої знову знадобиться PIN керівника.</p></div><button type="button" class="btn sm" data-m-logout>' + icon('logout', 18) + '<span>Вийти</span></button></div></div>';
    }
    function noticesHtml() {
      var n = st.notices;
      if (!n) return UI.spinner('Завантаження…');
      if (!n.ok) return errBox(n, 'notices');
      var TONE = { sent: ['надіслано', 'ok'], error: ['помилка', 'bad'], preview: ['демо: не надсилалось', 'info'] };
      return rtable([
        { label: 'Час', cls: 'm-jt', html: function (x) { return '<b class="num">' + esc(fmt.time(x.ts)) + '</b><small>' + esc(fmt.dayLabel(fmt.dayKey(x.ts))) + '</small>'; } },
        { label: 'Тип', html: function (x) { return esc(lbl('notice_kind', x.kind) || x.kind); } },
        { label: 'Тема', cls: 'm-rt-main', html: function (x) { return esc(x.subject || ''); } },
        { label: 'Кому', html: function (x) { return x.to ? '<span class="m-mail">' + esc(x.to) + '</span>' : '<span class="dim">нікому</span>'; } },
        { label: 'Статус', html: function (x) { var t = TONE[x.status] || [x.status, 'muted']; return UI.badge(t[0], t[1]) + (x.error ? '<small class="dim">' + esc(x.error) + '</small>' : ''); } }
      ], n.notices || [], { empty: 'Сповіщень ще не було' });
    }
    function digestHtml() {
      var d = st.digest;
      if (!d) return '<p class="dim">Щоденний звіт формується о ' + esc(String(cur().digest_hour)) + ':00 і надсилається на «Email керівництва» та керівникам з email у розділі «Персонал».</p>' + actBtn('digest', 'Показати звіт зараз', 'eye');
      if (d.loading) return UI.spinner('Формуємо звіт…');
      if (!d.ok) return errBox(d, 'digest');
      var to = (d.to || []).join(', '), c = d.counts || {};
      return '<div class="m-dg-meta">' + UI.kv([
        ['Тема', esc(d.subject)],
        ['Кому', to ? '<span class="m-mail">' + esc(to) + '</span>' : '<span class="c-warn">нікому: немає ні «Email керівництва», ні керівників з email у розділі «Персонал» — звіт не надсилатиметься</span>'],
        ['Зміст', d.has_content ? 'є що повідомити: прострочено ТО ' + (c.due || 0) + ', скоро ' + (c.soon || 0) + ', зауважень ' + (c.failed || 0) + ', ремонтів ' + (c.repairs || 0) :
          'нічого термінового' + (cur().digest_mode === 'if_any' ? ' — за режимом «лише коли є що повідомити» звіт не надсилатиметься' : '')]
      ]) + '</div><iframe class="m-dg-frame" sandbox="" title="Попередній перегляд щоденного звіту" referrerpolicy="no-referrer"></iframe>' +
        '<div class="btn-row m-cbtn">' + actBtn('digest', 'Оновити', 'refresh') + '</div>';
    }
    function draw() {
      if (!ctx.alive()) return;
      if (!st.a) { sh.body.innerHTML = st.err ? errBox(st.err, 'retry') : UI.spinner('Завантаження налаштувань…'); return; }
      sh.body.innerHTML = '<div class="m-set-grid"><div class="m-set-main">' + formHtml() + '</div><div class="m-set-side">' +
        card('Підключення', '<div class="m-conn">' + connHtml() + '</div>', { icon: 'cloud' }) +
        card('Обслуговування', serviceHtml(), { icon: 'tool' }) + '</div></div>' +
        card('Щоденний звіт — попередній перегляд', '<div class="m-dg">' + digestHtml() + '</div>', { icon: 'file' }) +
        card('Журнал сповіщень', '<div class="m-nt">' + noticesHtml() + '</div>', { icon: 'send', hint: 'останні 100', act: actBtn('notices', 'Оновити', 'refresh') });
      fillFrame();
    }
    function fillFrame() {
      var f = sh.body.querySelector('.m-dg-frame');
      if (f && st.digest && st.digest.ok) f.srcdoc = st.digest.html || '';
    }
    function part(sel, html) { var el = sh.body.querySelector(sel); if (el) el.innerHTML = html; }
    function loadNotices() {
      st.notices = null; part('.m-nt', noticesHtml());
      Api.call('notices', { limit: 100 }).then(function (r) { if (!ctx.alive()) return; st.notices = r; part('.m-nt', noticesHtml()); });
    }
    function loadDigest() {
      st.digest = { loading: true }; part('.m-dg', digestHtml());
      Api.call('digest_preview', {}).then(function (r) { if (!ctx.alive()) return; st.digest = r; part('.m-dg', digestHtml()); fillFrame(); });
    }
    function save() {
      var root = sh.body.querySelector('.m-set');
      if (!root) return;
      var v = UI.readForm(root), S = cur(), vals = {}, errs = {};
      META.forEach(function (m) {
        var k = 's_' + m.key;
        if (!has(v, k)) return;
        if (m.type === 'num') {
          var sp = {}; sp[k] = { required: true, min: m.min, max: m.max, int: !!m.int };
          numErrs(root, v, errs, sp);
          if (errs[k]) return;
        }
        var nv = settingValue(m, v[k]);
        if (m.type === 'emails') { var bad = nv.filter(function (x) { return !U.isEmail(x); }); if (bad.length) { errs[k] = 'Невірний email: ' + bad[0]; return; } }
        if (m.key === 'company' && !nv) { errs[k] = 'Вкажіть назву'; return; }
        if (m.type === 'tz' && !nv) { errs[k] = 'Вкажіть часовий пояс, напр. Europe/Kyiv'; return; }
        if (JSON.stringify(nv) !== JSON.stringify(has(S, m.key) ? S[m.key] : m.def)) vals[m.key] = nv;
      });
      if (UI.setErrors(root, errs)) { UI.toast('Виправте позначені поля', { tone: 'warn' }); return; }
      if (!Object.keys(vals).length) { App.setDirty(false); UI.toast('Змін немає', { tone: 'info', ms: 2000 }); return; }
      var btns = UI.qsa('[data-m="save"]', host);
      btns.forEach(function (b) { b.disabled = true; });
      Api.call('settings_save', { values: vals }).then(function (r) {
        btns.forEach(function (b) { b.disabled = false; });
        if (!r.ok) { UI.alert({ title: 'Налаштування не збережено', text: errText(r) }); return; }
        if (st.a) st.a.settings = r.settings;
        App.setDirty(false);
        UI.toast('Налаштування збережено', { tone: 'ok' });
        touched();
        if (ctx.alive()) { draw(); loadDigest(); }
      });
    }
    function load(force) {
      loadAdmin(force).then(function (r) {
        if (!ctx.alive()) return;
        if (r.ok) { st.a = r; st.err = null; } else if (!st.a) st.err = r;
        draw();
        if (r.ok && !st.digest) loadDigest();
      });
    }
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-m]');
      if (!b) return;
      var a = b.getAttribute('data-m');
      if (a === 'save') save();
      else if (a === 'retry') { st.err = null; draw(); load(true); }
      else if (a === 'notices') loadNotices();
      else if (a === 'digest') loadDigest();
      else if (a === 'recompute') {
        UI.confirm({ title: 'Перерахувати все?', text: 'Стани ліній, мотогодини, лічильники й строки ТО буде перераховано з журналів. Це може тривати до хвилини.', ok: 'Перерахувати' }).then(function (y) {
          if (!y) return;
          var md = UI.modal({ title: 'Перерахунок', body: UI.spinner('Перераховуємо…'), locked: true, size: 'sm' });
          Api.call('recompute', {}).then(function (r) {
            md.close();
            if (!r.ok) { UI.alert({ title: 'Не вдалося перерахувати', text: errText(r) }); return; }
            UI.toast('Перераховано: ліній ' + (r.lines || 0) + ', робіт регламенту ' + (r.rules || 0) + ', лічильників ' + (r.meters || 0), { tone: 'ok' });
            touched();
          });
        });
      } else if (a === 'reset-demo') {
        if (typeof LocalBackend === 'undefined' || App.mode() !== 'local') return;
        UI.confirm({ title: 'Скинути демо-дані?', text: 'Усі записи демо-режиму на цьому пристрої буде стерто, а демо-дані створено заново на сьогодні.', ok: 'Скинути', danger: true }).then(function (y) {
          if (!y) return;
          var md = UI.modal({ title: 'Скидання демо-даних', body: UI.spinner('Створюємо демо-дані заново…'), locked: true, size: 'sm' });
          LocalBackend.resetDemo().then(function () {
            cache.gen++; cache.admin = null; cache.adminAt = 0; cache.dash = {}; cache.planAt = 0; cache.rep = null; cache.works = null;
            return App.refresh();
          }).then(function () {
            md.close();
            UI.toast('Демо-дані створено заново', { tone: 'ok' });
            if (ctx.alive()) { st.a = null; st.digest = null; draw(); load(true); loadNotices(); }
          }, function (er) { md.close(); UI.alert({ title: 'Не вдалося скинути', text: String(er && er.message || er) }); });
        });
      }
    });
    draw();
    load(false);
    loadNotices();
    return { onBoot: function () { var c = sh.body.querySelector('.m-conn'); if (c) c.innerHTML = connHtml(); }, onQueue: function () {} };
  }

  /* ================================= МАРШРУТИ ================================= */
  var VIEW_FN = { overview: overviewView, maintenance: maintView, journal: journalView, checks: checksView, equipment: equipmentView, staff: staffView, settings: settingsView };
  /* доступ лише з PIN керівника */
  function gated(host, ctx, fn) {
    if (Api.isAdmin()) return fn();
    host.innerHTML = UI.spinner('Потрібен PIN керівника…');
    return App.requireAdmin().then(function (ok) {
      if (!ctx.alive()) return null;
      if (!ok) { App.go('#/', { replace: true }); return null; }
      return fn();
    });
  }
  App.route('/m', function () { App.go('#/m/overview', { replace: true }); });
  App.route('/m/:view', function (p, host, ctx) {
    var id = ALIAS[p.view] || p.view;
    if (!VIEW_FN[id]) { App.go('#/m/overview', { replace: true }); return null; }
    return gated(host, ctx, function () { return VIEW_FN[id](p, host, ctx); });
  });
  App.route('/m/equipment/:line', function (p, host, ctx) {
    return gated(host, ctx, function () { return lineAdminView(p, host, ctx); });
  });

  /* для інших екранів і тестів */
  window.Manager = { markDone: markDone, openCheck: openCheck, openRecord: openRecord, refreshCache: function () { cache.gen++; cache.adminAt = 0; cache.dash = {}; cache.planAt = 0; cache.rep = null; cache.works = null; } };
})();
