/* =====================================================================
   FOODLINE · Лінії — екрани оператора (operator.js)
   Планшет біля лінії:
     #/line/:id                  — екран лінії: стан, дії, ТО, сьогодні
     #/line/:id/check/:occasion  — чек-лист start | changeover | end
     #/line/:id/work             — запис роботи (?rule=R1&type=to&unit=U1&mode=repair)
     #/line/:id/history          — історія лінії за 14 днів
   Усі записи — Api.write (офлайн-черга) після App.requireOperator.
   Глобал Operator — форми для повторного використання (напр., у розділі керівництва):
     Operator.openWorkForm(opts), Operator.openReadings(lineId), Operator.showCheck(id, ts),
     Operator.showWork(work), Operator.showDue(ruleId), Operator.stripHtml(segs, fromMs, toMs, o).
   ===================================================================== */
var Operator = (function () {
  'use strict';

  var esc = UI.esc, icon = UI.icon, fmt = UI.fmt;
  var MIN = 60000, DAY = 86400000;
  var OCC_TITLE = { start: 'Чек-лист запуску', changeover: 'Чек-лист переналаштування', end: 'Чек-лист завершення' };
  var OCC_OF = { start: 'запуску', changeover: 'переналаштування', end: 'завершення' };
  var DEF_REASONS = ['Немає сировини / тари', 'Очікування', 'Перерва', 'Мікрозупинка / застрягання', 'Налагодження', 'Інше'];
  var CHECK_V = { ok: 'Норма', fail: 'Зауваження', na: 'Н/З' };
  var RESULT_TONE = { ok: 'ok', remarks: 'soon', fail: 'due' };
  var DUE_ORDER = { due: 0, soon: 1, ok: 2, none: 3 };
  var RP_KEY = 'fl_lines_op_products';

  /* ------------------------------ дрібні помічники ------------------------------ */
  function S() { return (App.state && App.state.settings) || {}; }
  function now() { return App.now(); }
  function nowMs() { return App.now().getTime(); }
  function tms(v) { var d = UI.toDate(v); return d ? d.getTime() : NaN; }
  function nz(v) { return v !== null && v !== undefined && String(v).trim() !== ''; }
  function lineHref(id, sub) { return '#/line/' + encodeURIComponent(id) + (sub || ''); }
  function lsGet(k, d) { try { var v = window.localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* пропуск */ } }
  function bySort(list) {
    return list.map(function (x, i) { return { x: x, i: i }; }).sort(function (a, b) {
      var sa = typeof a.x.sort === 'number' ? a.x.sort : 1e9, sb = typeof b.x.sort === 'number' ? b.x.sort : 1e9;
      return sa - sb || a.i - b.i;
    }).map(function (o) { return o.x; });
  }
  /* число для показу: до 3 знаків після коми, великі — цілими */
  function numText(n, unit) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return fmt.num(n, Math.abs(n) >= 1000 ? 0 : 3) + (unit ? ' ' + unit : '');
  }
  function rangeText(it) {
    var u = it.unit_label ? ' ' + it.unit_label : '';
    var lo = it.min !== null && it.min !== undefined, hi = it.max !== null && it.max !== undefined;
    if (lo && hi) return fmt.num(it.min, 3) + ' – ' + fmt.num(it.max, 3) + u;
    if (lo) return 'не менше ' + fmt.num(it.min, 3) + u;
    if (hi) return 'не більше ' + fmt.num(it.max, 3) + u;
    return '';
  }
  function minutesSince(v) { var t = tms(v); return isNaN(t) ? null : Math.max(0, Math.round((nowMs() - t) / MIN)); }
  function staffIdByName(name) {
    var n = String(name || '').trim().toLowerCase();
    if (!n || !App.state) return '';
    var hit = (App.state.staff || []).filter(function (s) { return String(s.name || '').trim().toLowerCase() === n; })[0];
    return hit ? hit.id : '';
  }
  function staffNames() { return App.state ? (App.state.staff || []).filter(function (s) { return s.active !== false; }).map(function (s) { return s.name; }) : []; }
  function unitName(id) { var u = App.unit(id); return u ? u.name : ''; }
  function optsOf(it) { return Array.isArray(it.options) ? it.options : (it.options ? String(it.options).split(';').map(function (x) { return x.trim(); }).filter(Boolean) : []); }

  /* ------------------------------ час заводу ------------------------------ */
  function tzName() { return fmt.tz() || S().tz || 'Europe/Kyiv'; }
  function dayStart(key) {
    var U = LinesCore.util, d = null;
    try { d = U.dayStart(key, tzName()); } catch (e) { try { d = U.dayStart(key, 'Europe/Kiev'); } catch (e2) { d = null; } }
    return d && !isNaN(d.getTime()) ? d.getTime() : Date.parse(key + 'T00:00:00Z');
  }
  function keyAdd(k, n) { return LinesCore.util.keyAdd(k, n); }
  function todayKey() { return fmt.dayKey(now()); }

  /* ------------------------------ продукти (підказки) ------------------------------ */
  function recentProducts() {
    var out = [], seen = {};
    function add(p) { p = String(p || '').trim(); var k = p.toLowerCase(); if (!p || seen[k]) return; seen[k] = 1; out.push(p); }
    (lsGet(RP_KEY, []) || []).forEach(add);
    (Array.isArray(S().products) ? S().products : []).forEach(add);
    App.lines().forEach(function (l) { add(App.lineStatus(l.id).product); });
    return out.slice(0, 40);
  }
  function rememberProduct(p) {
    p = String(p || '').trim();
    if (!p) return;
    var list = (lsGet(RP_KEY, []) || []).filter(function (x) { return String(x).toLowerCase() !== p.toLowerCase(); });
    list.unshift(p);
    lsSet(RP_KEY, list.slice(0, 12));
  }

  /* ------------------------------ записи ------------------------------ */
  function opFields(op) { return { operator: op.name, staff_id: op.staff_id || '' }; }
  function offline() { var n = Api.net(); return n.mode === 'remote' && (n.online === false || !!n.paused); }
  function savedToast(msg, tone) {
    UI.toast(msg + (offline() ? '. Немає зв’язку — запис у черзі, надішлеться автоматично' : ''), { tone: tone || 'ok', ms: offline() ? 4500 : 3000 });
  }
  function write(action, params) {
    var p = Api.write(action, params);
    p.then(function (r) { if (r && r.ok) markStale(params.line_id); });
    // обхід гонки в Api.flush: запис, зроблений у «хвості» попереднього надсилання, інакше чекає до 15 с
    setTimeout(function () { if (Api.queue().length) Api.flush(true); }, 80);
    return p;
  }
  function writeEvent(lineId, op, fields) {
    var p = { line_id: lineId };
    var o = opFields(op);
    Object.keys(o).forEach(function (k) { p[k] = o[k]; });
    Object.keys(fields || {}).forEach(function (k) { if (fields[k] !== undefined) p[k] = fields[k]; });
    return write('event', p);
  }

  /* ------------------------------ дані лінії (дія `line`) ------------------------------ */
  var cache = {};
  function cached(id, days) { var c = cache[id + ':' + days]; return c && c.data ? c : null; }
  function loadLine(id, days, maxAge) {
    var k = id + ':' + days, c = cache[k] || (cache[k] = { data: null, at: 0, err: null, p: null });
    if (c.p) return c.p;
    if (c.data && maxAge !== undefined && Date.now() - c.at < maxAge) return Promise.resolve(c.data);
    c.p = Api.call('line', { line_id: id, days: days }, { timeout: 20000 }).then(function (r) {
      c.p = null;
      if (r && r.ok) { c.data = r; c.at = Date.now(); c.err = null; } else c.err = r || { ok: false, message: 'Немає відповіді' };
      return r;
    });
    return c.p;
  }
  function markStale(lineId) { Object.keys(cache).forEach(function (k) { if (k.split(':')[0] === lineId) cache[k].at = 0; }); }
  Api.on('ack', function (a) {
    var op = a && a.op;
    if (op) markStale(op.line_id || (op.params && op.params.line_id) || '');
  });

  /* події черги цієї лінії (FIFO): явні події та then_event чек-листів */
  function pendingEvents(lineId) {
    var out = [];
    Api.pendingFor(lineId).forEach(function (op) {
      var p = op.params || {};
      if (op.action === 'event') out.push({ id: p.id, state: p.state, ts: p.ts, reason: p.reason, product: p.product });
      else if (op.action === 'checklist' && p.then_event && p.then_event.state) {
        out.push({ id: p.then_event.id, state: p.then_event.state, ts: p.then_event.ts || p.ts, reason: p.then_event.reason, product: p.then_event.product || p.product });
      }
    });
    return out;
  }
  /* роботи з черги, прив’язані до регламенту → {rule_id: op} */
  function pendingRuleWorks(lineId) {
    var out = {};
    Api.pendingFor(lineId).forEach(function (op) { if (op.action === 'work' && op.params && op.params.rule_id) out[op.params.rule_id] = op; });
    return out;
  }
  function ranFromEvents(evsDesc) {
    for (var i = 0; i < evsDesc.length; i++) {
      var e = evsDesc[i];
      if (!e || e.void) continue;
      if (e.state === 'run' || e.state === 'stop') return true;
      if (e.state === 'off') return false;
    }
    return null;
  }
  function withTimeout(p, ms) {
    return new Promise(function (resolve) {
      var t = setTimeout(function () { resolve(null); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function () { clearTimeout(t); resolve(null); });
    });
  }
  /* чи працювала лінія після останнього «Не працює» → Promise<true|false|null (невідомо)> */
  function ranSinceOff(lineId) {
    var s = App.lineStatus(lineId);
    if (s.state === 'run' || s.state === 'stop') return Promise.resolve(true);
    if (s.state === 'off') return Promise.resolve(false);
    var r = ranFromEvents(pendingEvents(lineId).reverse());
    if (r !== null) return Promise.resolve(r);
    var base = App.state && App.state.status && App.state.status[lineId];
    var need = base && base.event_id;
    var judge = function (d) {
      if (!d || !d.ok) return null;
      if (need && !(d.events || []).some(function (e) { return e.id === need; })) return undefined;   // дані застарілі
      return ranFromEvents(d.events || []);
    };
    var c = cached(lineId, 2), v = c ? judge(c.data) : undefined;
    if (v !== undefined) return Promise.resolve(v);
    return withTimeout(loadLine(lineId, 2, 0), 6000).then(function (d) { var x = judge(d); return x === undefined ? null : x; });
  }
  function lastStartFailed(s) { return !!(s.last_check && s.last_check.occasion === 'start' && s.last_check.result === 'fail'); }
  function startValid(s) { return !!s.start_check_valid && !lastStartFailed(s); }
  /* чи потрібен чек-лист запуску перед переходом у «Працює» → Promise<boolean> */
  function needStartCheck(lineId) {
    var s = App.lineStatus(lineId);
    if (s.state === 'run' || s.state === 'stop') return Promise.resolve(false);
    if (S().require_start_checklist === false || startValid(s)) return Promise.resolve(false);
    if (s.state === 'off') return Promise.resolve(true);
    return ranSinceOff(lineId).then(function (ran) { return ran !== true; });
  }

  /* ------------------------------ стрічка часу (timeline) ------------------------------ */
  /* сегменти з відповіді `line` + події з черги → [{state, from, to (мс), reason, product, pending}] */
  function segsWithPending(timeline, lineId) {
    var n = nowMs();
    var out = (timeline || []).map(function (x) { return { state: x.state, from: tms(x.from), to: tms(x.to), reason: x.reason, product: x.product }; })
      .filter(function (x) { return !isNaN(x.from) && !isNaN(x.to); });
    if (out.length) out[out.length - 1].to = Math.max(out[out.length - 1].to, n);
    pendingEvents(lineId).forEach(function (e) {
      var t = tms(e.ts);
      if (isNaN(t)) return;
      out = out.filter(function (x) { return x.from < t; });
      if (out.length) out[out.length - 1].to = Math.min(out[out.length - 1].to, t);
      out.push({ state: e.state, from: t, to: Math.max(t, n), reason: e.reason, product: e.product, pending: true });
    });
    return out;
  }
  /* HTML стрічки за вікно [a, b) (мс); o: {axis, cls, info} */
  function stripHtml(segs, a, b, o) {
    o = o || {};
    var n = nowMs(), span = Math.max(1, b - a), h = '';
    (segs || []).forEach(function (s) {
      var f = Math.max(a, s.from), t = Math.min(b, s.to, n);
      if (!(t > f)) return;
      var tip = fmt.time(new Date(f)) + '–' + fmt.time(new Date(t)) + ' · ' + UI.stateLabel(s.state) + (s.reason ? ' — ' + s.reason : '') + ' · ' + fmt.duration(t - f);
      h += '<i class="st-' + esc(s.state) + (s.pending ? ' pend' : '') + '" style="left:' + ((f - a) / span * 100).toFixed(3) + '%;width:' + ((t - f) / span * 100).toFixed(3) + '%"' +
        ' title="' + esc(tip) + '" data-tip="' + esc(tip) + '"></i>';
    });
    if (n < b) {
      var fl = Math.max(0, (n - a) / span * 100);
      h += '<u class="op-strip-fut" style="left:' + fl.toFixed(3) + '%"></u>';
      if (n > a) h += '<b class="op-strip-now" style="left:' + fl.toFixed(3) + '%"></b>';
    }
    var ticks = '';
    [6, 12, 18].forEach(function (H) { ticks += '<s style="left:' + (H / 24 * 100).toFixed(3) + '%"></s>'; });
    var axis = o.axis ? '<div class="op-axis" aria-hidden="true"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>' : '';
    return '<div class="op-strip' + (o.cls ? ' ' + o.cls : '') + '" role="img" aria-label="' + esc(o.label || 'Стани лінії протягом доби') + '">' + h + ticks + '</div>' + axis;
  }

  /* ------------------------------ записи історії (рядки) ------------------------------ */
  var recIdx = {};
  function recordsOf(d, lineId) {
    var out = [];
    var evAsc = (d.events || []).filter(function (e) { return !e.void; }).slice().sort(function (a, b) { return tms(a.ts) - tms(b.ts); });
    var pe = lineId ? pendingEvents(lineId) : [], firstPending = pe.length ? tms(pe[0].ts) : null;
    var nextTs = {};
    evAsc.forEach(function (e, i) { nextTs[e.id] = i + 1 < evAsc.length ? tms(evAsc[i + 1].ts) : (firstPending && firstPending >= tms(e.ts) ? firstPending : null); });
    (d.events || []).forEach(function (e) { out.push({ k: 'event', ts: tms(e.ts), r: e, end: nextTs[e.id] }); });
    (d.checks || []).forEach(function (c) { out.push({ k: 'check', ts: tms(c.ts), r: c }); });
    (d.works || []).forEach(function (w) { out.push({ k: 'work', ts: tms(w.ts), r: w }); });
    (d.readings || []).forEach(function (x) { out.push({ k: 'reading', ts: tms(x.ts), r: x }); });
    out.sort(function (a, b) { return b.ts - a.ts; });
    return out;
  }
  function recHtml(x) {
    var r = x.r, v = r.void ? ' op-void' : '', vb = r.void ? UI.badge('анульовано', 'muted') : '';
    var time = '<span class="op-rec-time">' + esc(fmt.time(new Date(x.ts))) + '</span>';
    if (x.k === 'event') {
      var dur = r.void ? '' : fmt.duration((x.end || nowMs()) - x.ts);
      var sub = [r.reason, r.note, r.product, r.operator].filter(Boolean).join(' · ');
      var fl = r.flag ? UI.badge(UI.label('flag', r.flag), r.flag === 'forced' ? 'soon' : 'bad') : '';
      return '<div class="op-rec k-event' + v + '">' + time + '<span class="op-rec-ic st-' + esc(r.state) + '">' + icon(UI.STATE_ICON[r.state] || 'dot', 20) + '</span>' +
        '<span class="op-rec-main"><b>' + esc(UI.stateLabel(r.state)) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>' +
        '<span class="op-rec-end">' + fl + vb + (dur ? '<span class="op-rec-dur">' + esc(dur) + (x.end ? '' : ' · триває') + '</span>' : '') + '</span></div>';
    }
    if (x.k === 'check') {
      recIdx['check:' + r.id] = r;
      var csub = [r.operator, r.product, r.failed ? r.failed + ' ' + fmt.plural(r.failed, ['зауваження', 'зауваження', 'зауважень']) : '',
        r.out_of_range ? r.out_of_range + ' поза нормою' : '', r.missing ? 'не заповнено: ' + r.missing : ''].filter(Boolean).join(' · ');
      return '<button type="button" class="op-rec k-check' + v + '" data-rec="check" data-id="' + esc(r.id) + '">' + time +
        '<span class="op-rec-ic">' + icon('checklist', 20) + '</span><span class="op-rec-main"><b>' + esc(OCC_TITLE[r.occasion] || 'Чек-лист') + '</b>' +
        (csub ? '<small>' + esc(csub) + '</small>' : '') + '</span><span class="op-rec-end">' + vb +
        (r.result ? UI.badge(UI.label('check_result', r.result), RESULT_TONE[r.result] || 'muted') : '') + icon('next', 20, 'op-chev') + '</span></button>';
    }
    if (x.k === 'work') {
      recIdx['work:' + r.id] = r;
      var wsub = [UI.label('work_type', r.work_type), unitName(r.unit_id), r.performer, r.duration_min ? fmt.duration(r.duration_min * MIN) : ''].filter(Boolean).join(' · ');
      return '<button type="button" class="op-rec k-work' + v + '" data-rec="work" data-id="' + esc(r.id) + '">' + time +
        '<span class="op-rec-ic">' + icon('wrench', 20) + '</span><span class="op-rec-main"><b>' + esc(r.title || UI.label('work_type', r.work_type)) + '</b>' +
        (wsub ? '<small>' + esc(wsub) + '</small>' : '') + '</span><span class="op-rec-end">' + vb + (r.status === 'open' ? UI.badge('відкрито', 'info') : '') + icon('next', 20, 'op-chev') + '</span></button>';
    }
    var m = App.meter(r.meter_id);
    var rsub = [r.mode === 'inc' ? 'за зміну' : '', r.operator, r.note].filter(Boolean).join(' · ');
    return '<div class="op-rec k-reading' + v + '">' + time + '<span class="op-rec-ic">' + icon('gauge', 20) + '</span><span class="op-rec-main"><b>' +
      esc((m ? m.name : 'Лічильник') + ': ' + numText(r.value, m && m.unit_label)) + '</b>' + (rsub ? '<small>' + esc(rsub) + '</small>' : '') + '</span>' +
      '<span class="op-rec-end">' + vb + '</span></div>';
  }
  function pendingHtml(lineId) {
    var q = Api.pendingFor(lineId);
    if (!q.length) return '';
    return q.slice().reverse().map(function (op) {
      var d = App.describeOp(op), ts = op.params && op.params.ts;
      var clickable = op.action === 'checklist';
      if (clickable) recIdx['pcheck:' + op.op_id] = op;
      var tag = clickable ? 'button type="button"' : 'div';
      return '<' + tag + ' class="op-rec is-pending"' + (clickable ? ' data-rec="pcheck" data-id="' + esc(op.op_id) + '"' : '') + '>' +
        '<span class="op-rec-time">' + esc(ts ? fmt.time(ts) : '') + '</span><span class="op-rec-ic">' + icon('refresh', 20) + '</span>' +
        '<span class="op-rec-main"><b>' + esc(d.title) + '</b><small>очікує синхронізації' +
          (op.last_error && op.last_error.error !== 'NETWORK' && op.last_error.error !== 'TIMEOUT' ? ' · ' + esc(op.last_error.message || op.last_error.error) : '') + '</small></span>' +
        '<span class="op-rec-end">' + UI.badge('у черзі', 'info') + '</span></' + (clickable ? 'button' : 'div') + '>';
    }).join('');
  }
  function bindRecords(root) {
    UI.delegate(root, 'click', '[data-rec]', function (e, b) {
      var k = b.getAttribute('data-rec'), id = b.getAttribute('data-id');
      if (k === 'check') { var c = recIdx['check:' + id]; showCheck(id, c && c.ts, c); }
      else if (k === 'work') { var w = recIdx['work:' + id]; if (w) showWork(w); }
      else if (k === 'pcheck') { var op = recIdx['pcheck:' + id]; if (op) showPendingCheck(op); }
    });
  }

  /* =====================================================================
     ЕКРАН ЛІНІЇ  #/line/:id
     ===================================================================== */
  var moreOpen = {};
  var lastLineHash = '';
  var lastActAt = 0;

  function lineMissing(host, id) {
    App.setTitle('Лінію не знайдено');
    host.innerHTML = UI.pageHead({ title: 'Лінію не знайдено', back: '#/' }) +
      UI.emptyState({ icon: 'alert', title: 'Такої лінії немає', text: 'Лінію «' + (id || '') + '» не знайдено або її вимкнули в розділі «Обладнання».',
        action: { label: 'До списку ліній', href: '#/' } });
  }

  function lineScreen(p, host, ctx) {
    var l = App.line(p.id);
    if (!l) { lineMissing(host, p.id); return; }
    App.setTitle(l.name);
    lastLineHash = lineHref(l.id);
    var s = App.lineStatus(l.id);
    var kick = [l.kind, l.area].filter(Boolean).join(' · ') || 'Лінія';
    host.innerHTML = UI.pageHead({ title: l.name, kicker: kick, back: '#/' }) +
      '<div class="op-layout"><div class="op-col op-col-main">' + statusHtml(l, s) + actionsHtml(l, s) + '</div>' +
      '<div class="op-col op-col-side">' + maintHtml(l) + todayHtml(l) + '</div></div>';

    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b || b.disabled || !host.contains(b)) return;
      e.preventDefault();
      // захист від подвійного дотику: після прямого запису екран одразу перемальовується, і другий дотик влучив би в іншу кнопку
      if (Date.now() - lastActAt < 600) return;
      var a = b.getAttribute('data-act');
      if (a === 'resume' || a === 'run-direct') lastActAt = Date.now();
      runAction(l.id, a, b);
    });
    host.addEventListener('click', function (e) {
      var seg = e.target.closest('.op-today .op-strip i[data-tip]');
      var info = host.querySelector('.op-today .op-strip-info');
      if (seg && info) info.textContent = seg.getAttribute('data-tip');
    });
    host.addEventListener('toggle', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('op-more')) moreOpen[l.id] = e.target.open;
    }, true);
    bindRecords(host);

    var c = cached(l.id, 2);
    if (!c || Date.now() - c.at > 60000) {
      loadLine(l.id, 2, 60000).then(function () {
        if (!ctx.alive()) return;
        var body = host.querySelector('#opTodayBody');
        if (body) body.innerHTML = todayBody(l);
      });
    }
  }

  /* ---- блок стану ---- */
  function statusHtml(l, s) {
    var st = s.state || 'off';
    var since = s.since ? UI.toDate(s.since) : null;
    var sinceTxt = since ? 'з ' + fmt.time(since) + (fmt.dayKey(since) !== todayKey() ? ' · ' + fmt.dateShort(since) : '') : 'ще не запускалася';
    var reason = (st !== 'run' && st !== 'off') ? [s.reason, s.note].filter(Boolean).join(' — ') : '';
    var today = App.liveTodayHours(s);
    var lc = s.last_check;
    var lcTxt = lc && lc.ts ? esc(UI.label('occasion', lc.occasion)) + ' · ' + esc(fmt.dt(lc.ts)) + ' · ' +
      (lc.result ? '<span class="op-res r-' + esc(lc.result) + '">' + esc(UI.label('check_result', lc.result).toLowerCase()) + '</span>' : '<span class="dim">надсилається</span>') : '<span class="dim">—</span>';
    var warn = '';
    var inWork = st === 'run' || st === 'stop';
    // без чинного чек-листа, хоча робота почалася недавно (довгу роботу покриває попередження long_run)
    var fresh = s.work_since && nowMs() - tms(s.work_since) < (S().checklist_valid_hours || 12) * 3600000;
    if (inWork && (s.flag === 'no_checklist' || (!s.start_check_valid && fresh))) {
      warn += '<div class="op-warn bad">' + icon('alert', 22) + '<span>Лінія працює <b>без чек-листа запуску</b>. Пройдіть його зараз — запис буде в історії.</span>' +
        '<button type="button" class="btn sm" data-act="late-check">' + icon('checklist', 18) + '<span>Пройти чек-лист</span></button></div>';
    } else if (inWork && s.flag === 'forced') {
      warn += '<div class="op-warn soon">' + icon('alert', 22) + '<span>Лінію запущено попри зауваження в чек-листі.</span></div>';
    }
    if (s.long_run) {
      warn += '<div class="op-warn soon">' + icon('clock', 22) + '<span>Лінія працює понад ' + esc(fmt.num(S().long_run_hours || 16)) +
        ' год без завершення. Не забудьте чек-лист завершення зміни.</span></div>';
    }
    if (st === 'off' && lastStartFailed(s)) {
      warn += '<div class="op-warn bad">' + icon('alert', 22) + '<span>Останній чек-лист запуску <b>не пройдено</b>. Перед запуском пройдіть його ще раз.</span></div>';
    }
    if (s.pending) {
      warn += '<div class="op-warn info">' + icon('refresh', 22) + '<span>Очікує синхронізації: ' + s.pending + ' ' +
        fmt.plural(s.pending, ['запис', 'записи', 'записів']) + '. Стан показано з урахуванням цих записів.</span>' +
        '<button type="button" class="btn sm ghost" data-action="show-queue">Деталі</button></div>';
    }
    return '<section class="op-status st-' + esc(st) + (s.pending ? ' is-pending' : '') + '" aria-label="Стан лінії">' +
      '<div class="op-st-band"><div class="op-st-name"><span class="op-st-ic">' + icon(UI.STATE_ICON[st] || 'dot', 30) + '</span><b>' + esc(UI.stateLabel(st)) + '</b>' +
      (s.pending ? '<span class="op-st-sync" title="Очікує синхронізації">' + icon('refresh', 20) + '</span>' : '') + '</div>' +
      '<div class="op-st-time">' + (since ? '<span class="op-clock">' + UI.timer(since, 'clock') + '</span>' : '') + '<small>' + esc(sinceTxt) + '</small></div></div>' +
      (reason ? '<div class="op-st-reason">' + esc(reason) + '</div>' : '') +
      '<dl class="op-st-meta">' +
      '<div><dt>Продукт</dt><dd>' + (s.product ? esc(s.product) : '<span class="dim">—</span>') + '</dd></div>' +
      '<div><dt>Оператор</dt><dd>' + (s.operator ? esc(s.operator) : '<span class="dim">—</span>') + '</dd></div>' +
      '<div><dt>Сьогодні в роботі</dt><dd>' + (today > 0.004 ? esc(fmt.hm(today)) : '<span class="dim">не працювала</span>') + '</dd></div>' +
      '<div><dt>Останній чек-лист</dt><dd>' + lcTxt + '</dd></div>' +
      '</dl>' + (warn ? '<div class="op-warns">' + warn + '</div>' : '') + '</section>';
  }

  /* ---- дії за станом ---- */
  function act(key, label, sub, ic, tone, primary) { return { key: key, label: label, sub: sub, icon: ic, tone: tone, primary: !!primary }; }
  function actionsFor(l, s) {
    var st = s.state || 'off';
    var A = [];
    var CH = act('changeover', 'Переналаштування', 'Зміна продукту або формату', 'sliders', 'setup');
    var REP = act('repair', 'Ремонт', 'Поломка, аварійна зупинка', 'wrench', 'repair');
    var END = act('end', 'Завершити роботу', 'Чек-лист завершення → Не працює', 'power', 'off');
    switch (st) {
      case 'run':
        A = [act('stop', 'Простій', 'Зупинка з причиною', 'pause', 'stop'), CH, REP, END];
        break;
      case 'stop':
        A = [act('resume', 'Відновити роботу', s.reason ? 'Після простою: ' + s.reason : 'Лінія знову працює', 'play', 'run', true), CH, REP, END];
        break;
      case 'setup':
        A = [act('setup-done', 'Налаштування завершено', 'Чек-лист і запуск лінії', 'check', 'setup', true), REP];
        break;
      case 'repair':
        A = [act('repair-done', 'Ремонт завершено', 'Записати, що зроблено, і вибрати, що далі', 'check', 'repair', true)];
        break;
      case 'maint':
        A = [act('maint-done', 'ТО завершено', 'Записати виконані роботи і вибрати, що далі', 'check', 'maint', true)];
        break;
      case 'clean':
        A = [act('clean-done', 'Миття завершено', 'Запис про миття → Не працює', 'check', 'clean', true)];
        break;
      default:
        if (startValid(s) && S().require_start_checklist !== false) {
          var lc = s.last_check && s.last_check.occasion === 'start' ? s.last_check : null;
          A.push(act('run-direct', 'Запустити', lc ? 'Чек-лист запуску пройдено о ' + fmt.time(lc.ts) : 'Чек-лист запуску ще чинний', 'play', 'run', true));
          A.push(act('start', 'Пройти чек-лист ще раз', 'Перевірити лінію заново перед запуском', 'checklist', 'muted'));
        } else if (S().require_start_checklist === false) {
          A.push(act('run-direct', 'Запустити', 'Лінія одразу перейде в «Працює»', 'play', 'run', true));
          A.push(act('start', 'Чек-лист запуску', 'Необов’язковий, але рекомендований', 'checklist', 'muted'));
        } else {
          A.push(act('start', 'Підготовка і запуск', 'Чек-лист запуску → Працює', 'play', 'run', true));
        }
        A.push(act('setup', 'Налаштування', 'Підготовка формату без запуску', 'sliders', 'setup'),
          act('clean', 'Миття', 'Санобробка лінії', 'droplet', 'clean'),
          act('maint', 'ТО / ППР', 'Планове обслуговування', 'tool', 'maint'),
          REP);
    }
    return A;
  }
  function actionsHtml(l, s) {
    var A = actionsFor(l, s);
    var prim = A.filter(function (a) { return a.primary; }), rest = A.filter(function (a) { return !a.primary; });
    var bb = function (a, solid) {
      return UI.bigButton({ label: a.label, sub: a.sub, icon: a.icon, tone: a.tone, solid: solid, className: solid ? 'op-prim' : '', attrs: { 'data-act': a.key } });
    };
    return '<section class="op-acts" aria-label="Дії">' +
      (prim.length ? '<div class="op-acts-prim">' + prim.map(function (a) { return bb(a, true); }).join('') + '</div>' : '') +
      (rest.length ? '<div class="op-acts-grid">' + rest.map(function (a) { return bb(a, false); }).join('') + '</div>' : '') +
      '</section>' +
      '<nav class="op-quick" aria-label="Інше">' +
      UI.bigButton({ label: 'Записати роботу', sub: 'Ремонт, ТО, заміна…', icon: 'wrench', tone: 'muted', className: 'compact', attrs: { 'data-act': 'work' } }) +
      UI.bigButton({ label: 'Лічильники', sub: 'Внести показники', icon: 'gauge', tone: 'muted', className: 'compact', attrs: { 'data-act': 'meters' } }) +
      UI.bigButton({ label: 'Історія лінії', sub: 'Останні 14 днів', icon: 'history', tone: 'muted', className: 'compact', href: lineHref(l.id, '/history') }) +
      '</nav>';
  }

  /* ---- панель ТО ---- */
  function orderedDue(lineId) {
    return App.dueFor(lineId).slice().sort(function (a, b) {
      return (DUE_ORDER[a.status] || 9) - (DUE_ORDER[b.status] || 9) || (b.pct || 0) - (a.pct || 0);
    });
  }
  function dueRow(d, pend) {
    var done = !!pend[d.rule_id], st = done ? 'ok' : d.status;
    var where = [unitName(d.unit_id), d.part].filter(Boolean).join(' · ');
    var badge = done ? UI.badge('виконано', 'ok', { icon: 'check' }) : UI.badge(UI.label('due_status', d.status), d.status === 'due' ? 'due' : d.status === 'soon' ? 'soon' : d.status === 'ok' ? 'ok' : 'muted');
    return '<button type="button" class="op-due s-' + esc(st) + '" data-act="due" data-rule="' + esc(d.rule_id) + '">' +
      '<span class="op-due-main"><span class="op-due-t">' + esc(d.title) + '</span>' + (where ? '<span class="op-due-s">' + esc(where) + '</span>' : '') +
      (d.status !== 'none' || done ? UI.progress(done ? 0 : d.pct, st, { label: d.title }) : '') +
      '<span class="op-due-sum">' + (done ? 'Позначено виконаним · очікує синхронізації' : esc(d.summary || '')) + '</span></span>' +
      '<span class="op-due-b">' + badge + icon('next', 20, 'op-chev') + '</span></button>';
  }
  function maintHtml(l) {
    var list = orderedDue(l.id), pend = pendingRuleWorks(l.id);
    var hot = list.filter(function (d) { return (d.status === 'due' || d.status === 'soon') && !pend[d.rule_id]; });
    var rest = list.filter(function (d) { return hot.indexOf(d) < 0; });
    var nd = hot.filter(function (d) { return d.status === 'due'; }).length, ns = hot.length - nd;
    var hint = nd || ns ? [nd ? nd + ' ' + fmt.plural(nd, ['прострочена', 'прострочені', 'прострочених']) : '', ns ? ns + ' скоро' : ''].filter(Boolean).join(' · ') : (list.length ? 'усе в нормі' : '');
    var body;
    if (!list.length) {
      body = '<div class="op-empty">' + icon('info', 20) + '<span>Регламент ТО для цієї лінії ще не заповнено. Керівник додає його в розділі «Обладнання».</span></div>';
    } else {
      body = (hot.length ? '<div class="op-due-list">' + hot.map(function (d) { return dueRow(d, pend); }).join('') + '</div>' :
        '<div class="op-empty ok">' + icon('check', 20) + '<span>Строки ТО в нормі — нічого не прострочено.</span></div>') +
        (rest.length ? '<details class="op-more"' + (moreOpen[l.id] ? ' open' : '') + '><summary>' + icon('down', 20) + '<span>Усі роботи регламенту · ' + rest.length + '</span></summary>' +
          '<div class="op-due-list">' + rest.map(function (d) { return dueRow(d, pend); }).join('') + '</div></details>' : '');
    }
    return '<section class="card op-maint"><div class="card-head">' + icon('tool', 20) + 'ТО і ППР' + (hint ? '<span class="hint">' + esc(hint) + '</span>' : '') + '</div>' +
      '<div class="card-body">' + body + '</div></section>';
  }

  /* ---- сьогодні ---- */
  function todayHtml(l) {
    return '<section class="card op-today"><div class="card-head">' + icon('clock', 20) + 'Сьогодні<span class="hint">' + esc(fmt.dayLabel(todayKey())) + '</span></div>' +
      '<div class="card-body" id="opTodayBody">' + todayBody(l) + '</div></section>';
  }
  function todayBody(l) {
    var c = cached(l.id, 2), pend = pendingHtml(l.id);
    var more = '<a class="op-more-link" href="' + lineHref(l.id, '/history') + '">Уся історія лінії' + icon('next', 18) + '</a>';
    if (!c) {
      var ce = cache[l.id + ':2'];
      if (ce && ce.err) {
        return '<div class="op-empty">' + icon('cloudOff', 20) + '<span>Історію за сьогодні не вдалося завантажити: ' + esc(ce.err.message || 'немає зв’язку') + '.</span></div>' +
          (pend ? '<div class="op-recs">' + pend + '</div>' : '');
      }
      return UI.spinner('Завантаження…') + (pend ? '<div class="op-recs">' + pend + '</div>' : '');
    }
    var d = c.data, k = todayKey(), a = dayStart(k), b = dayStart(keyAdd(k, 1));
    var segs = segsWithPending(d.timeline, l.id);
    var recs = recordsOf(d, l.id).filter(function (x) { return x.ts >= a; });
    var MAXR = 8;
    var list = recs.slice(0, MAXR).map(recHtml).join('');
    return stripHtml(segs, a, b, { axis: true, label: 'Стани лінії сьогодні' }) +
      '<div class="op-strip-info" aria-live="polite">Торкніться смуги, щоб побачити подробиці</div>' +
      (pend || list ? '<div class="op-recs">' + pend + list + '</div>' : '<div class="op-empty">' + icon('info', 20) + '<span>Сьогодні записів ще немає.</span></div>') +
      (recs.length > MAXR ? '<div class="op-more-row">Ще ' + (recs.length - MAXR) + ' ' + fmt.plural(recs.length - MAXR, ['запис', 'записи', 'записів']) + ' за сьогодні · ' + more + '</div>' : '<div class="op-more-row">' + more + '</div>');
  }

  /* ---- дії екрана лінії ---- */
  function withOp(lineId, fn) {
    return App.requireOperator(lineId).then(function (op) {
      if (!op) return null;
      if (!App.line(lineId)) { UI.toast('Лінію не знайдено', { tone: 'err' }); return null; }
      return fn(op);
    });
  }
  function runAction(lineId, a, btn) {
    var l = App.line(lineId);
    if (!l) return;
    var s = App.lineStatus(lineId);
    switch (a) {
      case 'start': withOp(lineId, function () { App.go(lineHref(lineId, '/check/start')); }); break;
      case 'late-check': withOp(lineId, function () { App.go(lineHref(lineId, '/check/start?then=none')); }); break;
      case 'end': withOp(lineId, function () { App.go(lineHref(lineId, '/check/end')); }); break;
      case 'run-direct':
        withOp(lineId, function (op) { writeEvent(lineId, op, { state: 'run' }); savedToast('Лінію запущено'); });
        break;
      case 'resume':
        withOp(lineId, function (op) { writeEvent(lineId, op, { state: 'run' }); savedToast('Роботу відновлено'); });
        break;
      case 'stop': withOp(lineId, function (op) { return stopDialog(l, op); }); break;
      case 'repair': withOp(lineId, function (op) { return repairDialog(l, op); }); break;
      case 'setup': withOp(lineId, function (op) { return setupDialog(l, s, op, 'setup'); }); break;
      case 'changeover': withOp(lineId, function (op) { return setupDialog(l, s, op, 'changeover'); }); break;
      case 'clean': withOp(lineId, function (op) { return cleanDialog(l, op); }); break;
      case 'maint': withOp(lineId, function (op) { return maintDialog(l, op); }); break;
      case 'setup-done': withOp(lineId, function (op) { return setupDone(l, op); }); break;
      case 'repair-done': withOp(lineId, function (op) { return workDone(l, op, 'repair'); }); break;
      case 'maint-done': withOp(lineId, function (op) { return workDone(l, op, 'maint'); }); break;
      case 'clean-done': withOp(lineId, function (op) { return cleanDone(l, op); }); break;
      case 'work': withOp(lineId, function () { App.go(lineHref(lineId, '/work')); }); break;
      case 'meters': openReadings(lineId); break;
      case 'due': showDue(btn.getAttribute('data-rule')); break;
      default: break;
    }
  }

  /* ---- діалоги зміни стану ---- */
  function formModal(o) {
    var box = UI.el('div', { class: 'op-dlg' + (o.cls ? ' ' + o.cls : '') });
    box.innerHTML = (o.intro ? '<p class="op-dlg-intro">' + o.intro + '</p>' : '') + o.html;
    var m = UI.modal({
      title: o.title, body: box, size: o.size || 'md', className: 'op-modal', initialFocus: o.focus,
      actions: [{ label: 'Скасувати', tone: 'ghost', value: null },
        { label: o.submit.label, tone: o.submit.tone || 'primary', icon: o.submit.icon, onClick: function (mm) {
          var v = o.validate(box, mm);
          if (!v) return false;
          mm.close(v);
          return false;
        } }]
    });
    if (o.init) o.init(box, m);
    return m.result;
  }
  function stopDialog(l, op) {
    var list = Array.isArray(S().stop_reasons) && S().stop_reasons.length ? S().stop_reasons : DEF_REASONS;
    return formModal({
      title: 'Простій', cls: 'op-dlg-stop', focus: '.op-reasons .chip',
      intro: 'Чому зупинилася <b>' + esc(l.name) + '</b>?',
      html: UI.field.chips({ name: 'reason', label: 'Причина', required: true, options: list.map(function (r) { return { value: r, label: r }; }), className: 'op-reasons' }) +
        UI.field.textarea({ name: 'note', label: 'Примітка', rows: 2, maxLength: 500, placeholder: 'Необов’язково: що саме сталося' }),
      submit: { label: 'Зафіксувати простій', icon: 'pause' },
      validate: function (root) {
        var v = UI.readForm(root), e = {};
        if (!v.reason) e.reason = 'Оберіть причину простою';
        else if (/^інше$/i.test(v.reason) && !v.note) e.note = 'Для «Інше» коротко опишіть причину';
        return UI.setErrors(root, e) ? null : v;
      }
    }).then(function (v) {
      if (!v) return;
      writeEvent(l.id, op, { state: 'stop', reason: v.reason, note: v.note });
      savedToast('Простій зафіксовано: ' + v.reason);
    });
  }
  function unitChips(l, value) {
    var units = App.unitsOf(l.id);
    if (!units.length) return '';
    return UI.field.chips({ name: 'unit', label: 'Агрегат', value: value || '', className: 'op-unit-chips',
      options: [{ value: '', label: 'Лінія в цілому' }].concat(units.map(function (u) { return { value: u.id, label: u.name }; })) });
  }
  function repairDialog(l, op) {
    return formModal({
      title: 'Ремонт / аварійна зупинка',
      intro: 'Лінія перейде в стан <b>«Ремонт»</b>. Коли все полагодять — натисніть «Ремонт завершено».',
      html: unitChips(l, '') +
        UI.field.textarea({ name: 'cause', label: 'Що сталося?', required: true, rows: 3, maxLength: 300, placeholder: 'Напр., тече клапан дозатора, не закручує кришки' }) +
        (S().instant_repair !== false ? '<div class="box info op-note">' + icon('send', 20) + 'Керівництво отримає сповіщення про ремонт.</div>' : ''),
      submit: { label: 'Почати ремонт', tone: 'danger', icon: 'wrench' },
      validate: function (root) {
        var v = UI.readForm(root);
        return UI.setErrors(root, { cause: v.cause ? '' : 'Опишіть, що сталося' }) ? null : v;
      }
    }).then(function (v) {
      if (!v) return;
      var u = App.unit(v.unit);
      writeEvent(l.id, op, { state: 'repair', reason: v.cause.slice(0, 300), note: u ? 'Агрегат: ' + u.name : '' });
      savedToast('Лінія в ремонті');
    });
  }
  function setupDialog(l, s, op, kind) {
    var ch = kind === 'changeover';
    return formModal({
      title: ch ? 'Переналаштування' : 'Налаштування',
      intro: ch ? 'Лінія зупиняється для зміни продукту або формату. Після налаштування — чек-лист і запуск.' :
        'Лінія перейде в стан <b>«Налаштування»</b>. Коли закінчите — натисніть «Налаштування завершено».',
      html: UI.field.text({ name: 'product', label: ch ? 'Новий продукт / формат' : 'Продукт / формат', required: ch, value: ch ? '' : s.product,
        datalist: recentProducts(), maxLength: 200, placeholder: 'Почніть вводити або виберіть зі списку' }) +
        UI.field.textarea({ name: 'note', label: 'Примітка', rows: 2, maxLength: 500, placeholder: ch ? 'Необов’язково: що змінюємо' : 'Необов’язково: що налаштовуємо' }),
      submit: { label: ch ? 'Почати переналаштування' : 'Почати налаштування', icon: 'sliders' },
      validate: function (root) {
        var v = UI.readForm(root);
        return UI.setErrors(root, { product: ch && !v.product ? 'Вкажіть, на що переналаштовуєте' : '' }) ? null : v;
      }
    }).then(function (v) {
      if (!v) return;
      rememberProduct(v.product);
      writeEvent(l.id, op, { state: 'setup', reason: ch ? 'Переналаштування' : 'Налаштування', product: v.product || undefined, note: v.note });
      savedToast(ch ? 'Переналаштування розпочато' : 'Налаштування розпочато');
    });
  }
  function cleanDialog(l, op) {
    return formModal({
      title: 'Миття / санобробка',
      intro: 'Лінія перейде в стан <b>«Миття»</b>. Коли закінчите — натисніть «Миття завершено».',
      html: UI.field.textarea({ name: 'note', label: 'Примітка', rows: 2, maxLength: 500, placeholder: 'Необов’язково: що миємо, чим' }),
      submit: { label: 'Почати миття', icon: 'droplet' }, focus: '.modal-foot .btn.primary',
      validate: function (root) { return UI.readForm(root); }
    }).then(function (v) {
      if (!v) return;
      writeEvent(l.id, op, { state: 'clean', reason: 'Миття', note: v.note });
      savedToast('Миття розпочато');
    });
  }
  /* список правил лінії (прострочені й скорі — першими) */
  function orderedRules(lineId) {
    var due = {};
    App.dueFor(lineId).forEach(function (d) { due[d.rule_id] = d; });
    return bySort(App.rulesOf(lineId)).map(function (r) { return { r: r, d: due[r.id] || null }; }).sort(function (a, b) {
      var sa = a.d ? DUE_ORDER[a.d.status] : 5, sb = b.d ? DUE_ORDER[b.d.status] : 5;
      return sa - sb;
    });
  }
  function maintDialog(l, op) {
    var rules = orderedRules(l.id);
    var html = rules.length ? UI.field.chips({ name: 'rules', label: 'Які роботи плануєте', multi: true, className: 'op-rule-chips',
      options: rules.map(function (x) { return { value: x.r.id, label: x.r.title, tone: x.d && (x.d.status === 'due' || x.d.status === 'soon') ? x.d.status : '' }; }) }) +
      '<p class="field-hint op-mt">Червоним — прострочені, бурштиновим — скоро. Можна нічого не вибирати.</p>' : '';
    return formModal({
      title: 'ТО / ППР',
      intro: 'Лінія перейде в стан <b>«ТО / ППР»</b>. Після робіт натисніть «ТО завершено» і запишіть, що зроблено.',
      html: html + UI.field.textarea({ name: 'note', label: 'Примітка', rows: 2, maxLength: 500, placeholder: 'Необов’язково' }),
      submit: { label: 'Почати ТО', icon: 'tool' }, focus: rules.length ? '.op-rule-chips .chip' : '.modal-foot .btn.primary',
      validate: function (root) { return UI.readForm(root); }
    }).then(function (v) {
      if (!v) return;
      var titles = (v.rules || []).map(function (id) { var r = App.rule(id); return r ? r.title : ''; }).filter(Boolean);
      writeEvent(l.id, op, { state: 'maint', reason: (titles.join('; ') || 'ТО / ППР').slice(0, 300), note: v.note });
      savedToast('ТО розпочато');
    });
  }

  /* ---- завершення налаштування / ремонту / ТО / миття ---- */
  function goCheck(lineId, occ, q) { App.go(lineHref(lineId, '/check/' + occ + (q ? '?' + q : ''))); }
  function setupDone(l, op) {
    return Promise.all([needStartCheck(l.id), ranSinceOff(l.id)]).then(function (r) {
      var need = r[0], ran = r[1] === true;
      return UI.choose({
        title: 'Налаштування завершено', columns: 1,
        text: need ? 'Лінія ще не працювала після вимкнення — перед запуском потрібен чек-лист запуску.' : 'Перед запуском — короткий чек-лист переналаштування.',
        options: [
          { value: 'run', label: 'Запустити лінію', sub: need ? 'Чек-лист запуску → Працює' : 'Чек-лист переналаштування → Працює', icon: 'play', tone: 'run' },
          { value: 'off', label: 'Не запускати — зупинити лінію', sub: ran ? 'Чек-лист завершення → Не працює' : 'Записати налаштування → Не працює', icon: 'power', tone: 'off' }
        ]
      }).then(function (v) {
        if (v === 'run') goCheck(l.id, need ? 'start' : 'changeover');
        else if (v === 'off') {
          if (ran) goCheck(l.id, 'end');
          else {
            var s = App.lineStatus(l.id);
            return openWorkForm({ line_id: l.id, mode: 'setup', operator: op, requireOperator: false, started: s.since, product: s.product,
              title: 'Налаштування без запуску', heading: 'Запис про налаштування', submitLabel: 'Зберегти і зупинити лінію' }).then(function (res) {
              if (!res) return;
              writeEvent(l.id, op, { state: 'off', ref_id: res.ids[0] });
              savedToast('Налаштування записано, лінія не працює');
            });
          }
        }
      });
    });
  }
  function unitFromNote(lineId, note) {
    var m = /^Агрегат:\s*(.+)$/.exec(String(note || '').trim());
    if (!m) return '';
    var u = App.unitsOf(lineId).filter(function (x) { return x.name === m[1].trim(); })[0];
    return u ? u.id : '';
  }
  function workDone(l, op, kind) {
    var s = App.lineStatus(l.id);
    var o = { line_id: l.id, mode: kind, operator: op, requireOperator: false, started: s.since };
    if (kind === 'repair') {
      o.cause = s.reason;
      o.unit_id = unitFromNote(l.id, s.note);
      o.downtime_min = minutesSince(s.since);
      o.heading = 'Ремонт завершено';
    } else {
      var titles = String(s.reason || '').split(/;\s*/);
      o.rule_ids = App.rulesOf(l.id).filter(function (r) { return titles.indexOf(r.title) >= 0; }).map(function (r) { return r.id; });
      o.heading = 'ТО завершено';
    }
    o.submitLabel = 'Зберегти і далі';
    return openWorkForm(o).then(function (res) {
      if (!res) return;
      return nextAfterWork(l, op, kind, res.ids[0]);
    });
  }
  function nextAfterWork(l, op, kind, workId) {
    return Promise.all([needStartCheck(l.id), ranSinceOff(l.id)]).then(function (r) {
      var need = r[0], ran = r[1] === true;
      var st = UI.stateLabel(kind);
      return UI.choose({
        title: 'Що далі з лінією?', columns: 1, cancel: kind === 'repair' ? 'Ремонт ще триває' : 'ТО ще триває',
        text: 'Роботу записано. Лінія зараз у стані «' + st + '».',
        options: [
          { value: 'run', label: 'Запустити лінію', sub: need ? 'Спершу — чек-лист запуску' : 'Одразу в «Працює»', icon: 'play', tone: 'run' },
          { value: 'off', label: 'Зупинити лінію', sub: ran ? 'Чек-лист завершення → Не працює' : 'Лінія не працювала після вимкнення → Не працює', icon: 'power', tone: 'off' }
        ].concat(ran ? [{ value: 'off-now', label: 'Зупинити без чек-листа', sub: 'Буде позначено «Завершення без чек-листа»', icon: 'stop', tone: 'muted' }] : [])
      }).then(function (v) {
        if (v === 'run') {
          if (need) goCheck(l.id, 'start');
          else { writeEvent(l.id, op, { state: 'run' }); savedToast('Лінію запущено'); }
        } else if (v === 'off') {
          if (ran) goCheck(l.id, 'end');
          else { writeEvent(l.id, op, { state: 'off', ref_id: workId }); savedToast('Лінія не працює'); }
        } else if (v === 'off-now') {
          writeEvent(l.id, op, { state: 'off' });
          savedToast('Лінія не працює');
        }
      });
    });
  }
  function cleanDone(l, op) {
    var s = App.lineStatus(l.id);
    return ranSinceOff(l.id).then(function (ran) {
      return openWorkForm({ line_id: l.id, mode: 'clean', operator: op, requireOperator: false, started: s.since, description: s.note,
        heading: 'Миття завершено', submitLabel: ran ? 'Зберегти і завершити роботу' : 'Зберегти і зупинити лінію' }).then(function (res) {
        if (!res) return;
        if (ran === true) { goCheck(l.id, 'end'); return; }
        writeEvent(l.id, op, { state: 'off', ref_id: res.ids[0] });
        savedToast('Миття записано, лінія не працює');
      });
    });
  }

  /* ---- деталі ТО ---- */
  function critText(c) {
    var unit = c.kind === 'days' ? 'дн.' : c.kind === 'hours' ? 'мотогод' : (c.unit_label || '');
    var dec = c.kind === 'meter' ? 0 : 1;
    var n = function (v) { return v === null || v === undefined || isNaN(v) ? '—' : fmt.num(v, Math.abs(v) >= 100 ? 0 : dec) + (unit ? ' ' + unit : ''); };
    return { name: UI.label('criterion', c.kind), interval: n(c.interval), used: n(c.used), left: c.left < 0 ? 'перевищено на ' + n(-c.left) : n(c.left),
      due: c.due_date ? (c.forecast ? '≈ ' : '') + fmt.date(c.due_date) : '—' };
  }
  function showDue(ruleId) {
    var d = (App.state.due || []).filter(function (x) { return x.rule_id === ruleId; })[0];
    var r = App.rule(ruleId);
    if (!d && !r) { UI.toast('Роботу регламенту не знайдено', { tone: 'err' }); return; }
    d = d || { rule_id: ruleId, line_id: r.line_id, unit_id: r.unit_id, title: r.title, work_type: r.work_type, part: r.part, status: 'none', criteria: [], summary: '' };
    var pend = pendingRuleWorks(d.line_id)[ruleId];
    var st = pend ? 'ok' : d.status;
    var crit = (d.criteria || []).map(function (c) {
      var t = critText(c), cs = c.pct >= 1 ? 'due' : d.status === 'soon' && d.driver === c.kind ? 'soon' : 'ok';
      return '<div class="op-crit"><div class="op-crit-h"><b>' + esc(t.name) + '</b><span>кожні ' + esc(t.interval) + '</span><span class="op-crit-pct">' + esc(fmt.frac(c.pct)) + '</span></div>' +
        UI.progress(c.pct, cs) + '<div class="op-crit-f"><span>використано ' + esc(t.used) + '</span><span class="' + (c.left < 0 ? 'c-bad' : '') + '">' +
        (c.left < 0 ? esc(t.left) : 'залишилось ' + esc(t.left)) + '</span><span>строк ' + esc(t.due) + '</span></div></div>';
    }).join('');
    var body = '<div class="op-due-d">' +
      '<div class="badges">' + (pend ? UI.badge('виконано · очікує синхронізації', 'ok', { icon: 'check' }) :
        UI.badge(UI.label('due_status', d.status), d.status === 'due' ? 'due' : d.status === 'soon' ? 'soon' : d.status === 'ok' ? 'ok' : 'muted')) +
      UI.badge(UI.label('work_type', d.work_type), 'muted') + '</div>' +
      (d.summary && !pend ? '<p class="op-due-big s-' + esc(st) + '">' + esc(d.summary) + '</p>' : '') +
      (d.status !== 'none' && !pend ? UI.progress(d.pct, d.status, { className: 'lg' }) : '') +
      UI.kv([['Агрегат', esc(unitName(d.unit_id) || 'Лінія в цілому')], ['Деталь / вузол', esc(d.part || '')],
        ['Востаннє', d.last_date ? esc(fmt.date(d.last_date)) : '<span class="dim">ще не виконувалось у системі</span>'],
        ['Строк', d.due_date ? esc((d.forecast ? 'орієнтовно ' : '') + fmt.date(d.due_date)) : '—']]) +
      (crit ? '<div class="section-title">Критерії</div><div class="op-crits">' + crit + '</div>' : '') +
      (r && r.instructions ? '<div class="section-title">Інструкція</div><div class="op-instr">' + esc(r.instructions) + '</div>' : '') +
      '</div>';
    UI.modal({
      title: d.title, size: 'md', className: 'op-modal', body: body,
      actions: [{ label: 'Закрити', tone: 'ghost', value: null },
        { label: 'Позначити виконаним', tone: 'primary', icon: 'check', onClick: function (mm) {
          mm.close(null);
          markDone(d.line_id, ruleId);
          return false;
        } }]
    });
  }
  function markDone(lineId, ruleId) {
    return openWorkForm({ line_id: lineId, mode: 'rule', rule_id: ruleId, heading: 'Позначити виконаним' }).then(function (res) {
      if (res) savedToast('Роботу «' + (App.rule(ruleId) ? App.rule(ruleId).title : '') + '» позначено виконаною');
      return res;
    });
  }

  /* =====================================================================
     ФОРМА РОБОТИ (модальна або на сторінці)
     opts: {line_id, mode:'free'|'repair'|'maint'|'rule'|'clean'|'setup', rule_id, rule_ids, work_type, unit_id,
            title, cause, description, product, started, finished, downtime_min, operator:{name, staff_id},
            requireOperator (true), heading, submitLabel}
     → Promise<{ids, works, writes} | null>
     ===================================================================== */
  var TYPE_FIELDS = {
    cause: { repair: 1, replace: 1, inspect: 1, other: 1 },
    parts: { repair: 1, replace: 1, to: 1, ppr: 1, other: 1 },
    params: { setup: 1, changeover: 1, calib: 1 },
    product: { setup: 1, changeover: 1 }
  };
  function WorkForm(root, l, o) {
    o = o || {};
    var mode = o.mode || 'free';
    var multi = mode === 'maint';
    var showRules = mode !== 'repair' && mode !== 'clean' && mode !== 'setup';
    var rules = orderedRules(l.id);
    var st = {
      type: o.work_type || { repair: 'repair', clean: 'clean', setup: 'setup' }[mode] || '',
      unit: o.unit_id && App.unit(o.unit_id) ? o.unit_id : '',
      sel: [], auto: '', mv: {}
    };
    (o.rule_ids || (o.rule_id ? [o.rule_id] : [])).forEach(function (id) { var r = App.rule(id); if (r && r.line_id === l.id && st.sel.indexOf(id) < 0) st.sel.push(id); });
    if (!multi && st.sel.length > 1) st.sel = st.sel.slice(0, 1);
    if (st.sel.length === 1) { var r0 = App.rule(st.sel[0]); if (!o.work_type) st.type = r0.work_type || st.type; if (!o.unit_id) st.unit = r0.unit_id || ''; }
    if (mode === 'maint' && !st.type) st.type = 'to';
    var op = o.operator || App.operator();
    var fin = o.finished ? UI.toDate(o.finished) : now();
    var sta = o.started ? UI.toDate(o.started) : null;
    if (sta && fin && sta.getTime() > fin.getTime()) sta = fin;

    function autoTitle() {
      if (st.sel.length === 1) { var r = App.rule(st.sel[0]); return r ? r.title : ''; }
      if (mode === 'clean') return 'Миття / санобробка лінії';
      if (!st.type || st.type === 'repair') return '';
      var u = App.unit(st.unit);
      return UI.label('work_type', st.type) + (u ? ' — ' + u.name : '');
    }
    var initTitle = o.title || autoTitle();
    st.auto = o.title ? '' : initTitle;

    var units = App.unitsOf(l.id);
    var typeOpts = UI.options('work_type');
    var html = '<div class="form-grid op-wf-grid">' +
      '<div class="field span-2" data-field="work_type" data-wf="type"><div class="field-label">Вид роботи <span class="req" aria-hidden="true">*</span></div>' +
      UI.chips({ name: 'work_type', options: typeOpts, value: st.type, label: 'Вид роботи', className: 'op-type-chips' }) + '<div class="field-err" role="alert"></div></div>' +
      (units.length ? UI.field.select({ name: 'unit_id', label: 'Агрегат', value: st.unit, className: 'span-2',
        options: [{ value: '', label: 'Лінія в цілому' }].concat(units.map(function (u) { return { value: u.id, label: u.name }; })) }) : '') +
      (showRules && rules.length ? '<div class="field span-2" data-field="rules"><div class="field-label">' + (multi ? 'Виконані роботи за регламентом' : 'За регламентом ТО / ППР') +
        ' <span class="op-lbl-opt">необов’язково</span></div><div class="op-rules" role="group"></div><div class="field-err" role="alert"></div></div>' : '') +
      '<div class="span-2 op-multi-note" data-wf="multi" hidden></div>' +
      '<div class="span-2" data-wf="title">' + UI.field.text({ name: 'title', label: 'Що зроблено', required: true, value: initTitle, maxLength: 300,
        placeholder: mode === 'repair' ? 'Напр., замінено ущільнювач клапана дозатора' : 'Коротко: яку роботу виконано' }) + '</div>' +
      '<div class="span-2" data-wf="cause">' + UI.field.textarea({ name: 'cause', label: 'Причина / несправність', required: mode === 'repair', value: o.cause || '', rows: 2, maxLength: 1000,
        placeholder: 'Що було не так' }) + '</div>' +
      '<div class="span-2">' + UI.field.textarea({ name: 'description', label: 'Опис робіт', value: o.description || '', rows: 3, maxLength: 4000, placeholder: 'Необов’язково: подробиці' }) + '</div>' +
      '<div class="span-2" data-wf="parts">' + UI.field.text({ name: 'parts', label: 'Замінені деталі', maxLength: 1000, placeholder: 'Напр., ущільнювач 25×3 — 2 шт.' }) + '</div>' +
      '<div class="span-2" data-wf="params">' + UI.field.text({ name: 'params', label: 'Параметри налаштування', maxLength: 2000, placeholder: 'Напр., доза 302 г; 24 пл./хв' }) + '</div>' +
      '<div class="span-2" data-wf="product">' + UI.field.text({ name: 'product', label: 'Продукт / формат', value: o.product || '', datalist: recentProducts(), maxLength: 200 }) + '</div>' +
      '<div class="span-2 op-meters-wf" data-wf="meters"></div>' +
      UI.field.text({ name: 'performer', label: 'Виконавець', required: true, value: op ? op.name : '', datalist: staffNames(), maxLength: 120 }) +
      UI.field.number({ name: 'downtime_min', label: 'Простій лінії, хв', value: o.downtime_min, hint: 'Скільки лінія не працювала через цю роботу' }) +
      UI.field.datetime({ name: 'started', label: 'Початок', value: sta || '', hint: 'Необов’язково' }) +
      UI.field.datetime({ name: 'finished', label: 'Завершено', required: true, value: fin }) +
      '</div>';
    root.innerHTML = html;
    var q = function (sel) { return root.querySelector(sel); };

    function visibleRules() {
      return rules.filter(function (x) { return !st.unit || !x.r.unit_id || x.r.unit_id === st.unit || st.sel.indexOf(x.r.id) >= 0; });
    }
    function drawRules() {
      var box = q('.op-rules');
      if (!box) return;
      var list = visibleRules();
      box.innerHTML = list.length ? list.map(function (x) {
        var on = st.sel.indexOf(x.r.id) >= 0, d = x.d, pend = pendingRuleWorks(l.id)[x.r.id];
        var b = pend ? UI.badge('виконано', 'ok') : d ? UI.badge(UI.label('due_status', d.status), d.status === 'due' ? 'due' : d.status === 'soon' ? 'soon' : d.status === 'ok' ? 'ok' : 'muted') : '';
        return '<button type="button" class="op-rule' + (on ? ' on' : '') + '" data-rule="' + esc(x.r.id) + '" aria-pressed="' + on + '">' +
          '<span class="op-rule-box">' + (on ? icon('check', 20) : '') + '</span><span class="op-rule-tx"><b>' + esc(x.r.title) + '</b><small>' +
          esc([UI.label('work_type', x.r.work_type), unitName(x.r.unit_id), d && d.summary].filter(Boolean).join(' · ')) + '</small></span>' + b + '</button>';
      }).join('') : '<div class="op-empty">' + icon('info', 20) + '<span>Для цього агрегата робіт у регламенті немає.</span></div>';
    }
    function drawMeters() {
      var box = q('[data-wf="meters"]');
      var seen = {}, ms = [];
      st.sel.forEach(function (id) { var r = App.rule(id); if (r && r.meter_id && !seen[r.meter_id]) { seen[r.meter_id] = 1; var m = App.meter(r.meter_id); if (m) ms.push(m); } });
      box.hidden = !ms.length;
      box.innerHTML = ms.map(function (m) {
        return UI.field.number({ name: 'mv_' + m.id, label: 'Показник: ' + m.name, unit: m.unit_label, value: st.mv[m.id] !== undefined ? st.mv[m.id] : '',
          hint: 'Зараз у системі: ' + numText(m.value, m.unit_label) + (m.value_ts ? ' (' + fmt.dt(m.value_ts) + ')' : '') + '. Можна не заповнювати.' });
      }).join('');
    }
    function refresh() {
      var many = st.sel.length > 1;
      var show = function (key, on) { var n = q('[data-wf="' + key + '"]'); if (n) n.hidden = !on; };
      show('type', !many);
      show('title', !many);
      var t = many ? '' : st.type;
      show('cause', mode === 'repair' || !!TYPE_FIELDS.cause[t]);
      show('parts', !!TYPE_FIELDS.parts[t] || many);
      show('params', !!TYPE_FIELDS.params[t]);
      show('product', !!TYPE_FIELDS.product[t]);
      var mn = q('[data-wf="multi"]');
      mn.hidden = !many;
      if (many) {
        mn.innerHTML = '<div class="box info">' + icon('info', 20) + 'Буде записано ' + st.sel.length + ' ' + fmt.plural(st.sel.length, ['роботу', 'роботи', 'робіт']) +
          ' — кожну окремо, зі спільним описом і часом:<ul>' + st.sel.map(function (id) { var r = App.rule(id); return '<li>' + esc(r ? r.title : id) + '</li>'; }).join('') + '</ul></div>';
      }
      var ti = q('input[name="title"]'), a = autoTitle();
      if (ti && (!ti.value.trim() || ti.value === st.auto)) ti.value = a;
      st.auto = a;
      drawRules();
      drawMeters();
    }
    root.addEventListener('change', function (e) {
      if (e.detail && e.detail.name === 'work_type') {
        st.type = e.detail.value || '';
        refresh();
      } else if (e.target && e.target.name === 'unit_id') {
        st.unit = e.target.value;
        refresh();
      }
    });
    var touched = {};
    root.addEventListener('input', function (e) {
      var n = e.target && e.target.name;
      if (n && n.indexOf('mv_') === 0) st.mv[n.slice(3)] = e.target.value;
      if (n === 'started' || n === 'finished') touched[n] = 1;
    });
    UI.delegate(root, 'click', '.op-rule', function (e, b) {
      var id = b.getAttribute('data-rule'), i = st.sel.indexOf(id);
      if (i >= 0) st.sel.splice(i, 1);
      else if (multi) st.sel.push(id);
      else st.sel = [id];
      if (st.sel.length === 1) {
        var r = App.rule(st.sel[0]);
        if (r) {
          st.type = r.work_type || st.type;
          UI.setChipValue(root, 'work_type', st.type);
          if (r.unit_id && !multi) { st.unit = r.unit_id; var us = q('select[name="unit_id"]'); if (us) us.value = r.unit_id; }
        }
      }
      refresh();
    });
    refresh();

    function submit() {
      var v = UI.readForm(root), e = {}, many = st.sel.length > 1;
      var n = nowMs();
      if (!many && !v.work_type) e.work_type = 'Оберіть вид роботи';
      if (!many && !v.title) e.title = 'Коротко опишіть, що зроблено';
      if (mode === 'repair' && !v.cause) e.cause = 'Вкажіть причину або несправність';
      var askWho = !v.performer && o.requireOperator !== false && !App.operator();
      if (!v.performer && !askWho) e.performer = 'Вкажіть, хто виконав роботу';
      // час, який не змінювали вручну, — точний: «Завершено» = мить збереження, «Початок» = початок стану
      var f = touched.finished || o.finished ? tms(v.finished) : n;
      var s0 = touched.started ? (v.started ? tms(v.started) : null) : (sta ? sta.getTime() : null);
      if (touched.finished && (!v.finished || isNaN(f))) e.finished = 'Вкажіть, коли роботу завершено';
      else if (f > n + 2 * MIN) e.finished = 'Час завершення не може бути в майбутньому';
      else if (f < n - 366 * DAY) e.finished = 'Не старше за рік';
      if (s0 !== null && !isNaN(f) && s0 > f) e.started = 'Початок пізніше за завершення';
      var dtRaw = (q('input[name="downtime_min"]') || { value: '' }).value.trim();
      if (dtRaw && (v.downtime_min === null || isNaN(v.downtime_min) || v.downtime_min < 0)) e.downtime_min = 'Лише число хвилин (0 або більше)';
      else if (v.downtime_min > 100000) e.downtime_min = 'Забагато — перевірте число';
      var mvals = {};
      Object.keys(v).forEach(function (k) {
        if (k.indexOf('mv_') !== 0) return;
        var raw = q('input[name="' + k + '"]').value.trim();
        if (!raw) return;
        if (v[k] === null || isNaN(v[k])) e[k] = 'Введіть число';
        else if (v[k] < 0) e[k] = 'Показник не може бути від’ємним';
        else mvals[k.slice(3)] = v[k];
      });
      if (UI.setErrors(root, e)) return Promise.resolve(false);
      var lower = Object.keys(mvals).filter(function (id) { var m = App.meter(id); return m && m.mode !== 'inc' && typeof m.value === 'number' && mvals[id] < m.value; });
      var confirmLower = lower.length ? UI.confirm({ title: 'Показник менший за попередній', ok: 'Так, зберегти',
        text: lower.map(function (id) { var m = App.meter(id); return m.name + ': ' + numText(mvals[id]) + ' < ' + numText(m.value); }).join('; ') + '. Можливо, лічильник замінили або скинули. Зберегти?' }) : Promise.resolve(true);
      var needOp = o.requireOperator === false ? Promise.resolve(op || { name: v.performer, staff_id: staffIdByName(v.performer) }) : App.requireOperator(l.id);
      return confirmLower.then(function (yes) {
        if (!yes) return false;
        return needOp.then(function (who) {
          if (!who) return false;
          if (!v.performer) { v.performer = who.name; var pi = q('input[name="performer"]'); if (pi) pi.value = who.name; }
          var perfId = who.name === v.performer ? (who.staff_id || '') : staffIdByName(v.performer);
          var base = {
            line_id: l.id, description: v.description, cause: TYPE_FIELDS.cause[v.work_type] || mode === 'repair' || many ? v.cause : '',
            parts: TYPE_FIELDS.parts[v.work_type] || many ? v.parts : '', params: TYPE_FIELDS.params[v.work_type] ? v.params : '',
            product: TYPE_FIELDS.product[v.work_type] ? v.product : '', performer: v.performer, staff_id: perfId,
            started: s0 !== null && !isNaN(s0) ? new Date(s0).toISOString() : undefined, ts: new Date(f).toISOString(), status: 'done'
          };
          var works = [];
          var mk = function (extra) { var w = {}; Object.keys(base).forEach(function (k) { if (base[k] !== undefined && base[k] !== '') w[k] = base[k]; }); Object.keys(extra).forEach(function (k) { if (extra[k] !== undefined && extra[k] !== '' && extra[k] !== null) w[k] = extra[k]; }); w.id = Api.newId(); return w; };
          if (st.sel.length) {
            st.sel.forEach(function (id, i) {
              var r = App.rule(id);
              if (!r) return;
              works.push(mk({ rule_id: r.id, work_type: many ? r.work_type : (v.work_type || r.work_type), unit_id: many ? r.unit_id : (v.unit_id || r.unit_id), title: many ? r.title : v.title,
                downtime_min: i === 0 ? v.downtime_min : null, meter_value: r.meter_id && mvals[r.meter_id] !== undefined ? mvals[r.meter_id] : undefined }));
            });
          } else {
            works.push(mk({ work_type: v.work_type, unit_id: v.unit_id, title: v.title, downtime_min: v.downtime_min }));
          }
          if (!works.length) return false;
          if (v.product) rememberProduct(v.product);
          var writes = works.map(function (w) { return write('work', w); });
          return { ids: works.map(function (w) { return w.id; }), works: works, writes: writes };
        });
      });
    }
    return { submit: submit };
  }
  function openWorkForm(opts) {
    opts = opts || {};
    var l = App.line(opts.line_id);
    if (!l) { UI.alert({ title: 'Лінію не знайдено', text: 'Не вдалося відкрити форму роботи.' }); return Promise.resolve(null); }
    var getOp = opts.requireOperator === false ? Promise.resolve(opts.operator || App.operator()) : App.requireOperator(l.id);
    return getOp.then(function (op) {
      if (opts.requireOperator !== false && !op) return null;
      var o = {};
      Object.keys(opts).forEach(function (k) { o[k] = opts[k]; });
      o.operator = op;
      o.requireOperator = false;
      var box = UI.el('div', { class: 'op-wf' });
      var form = WorkForm(box, l, o);
      var m = UI.modal({
        title: (o.heading || 'Запис роботи') + ' · ' + l.name, size: 'lg', className: 'op-modal op-wf-modal', body: box, locked: true,
        actions: [{ label: 'Скасувати', tone: 'ghost', value: null },
          { label: o.submitLabel || 'Зберегти роботу', tone: 'primary', icon: 'check', onClick: function () { return form.submit(); } }]
      });
      return m.result.then(function (r) {
        if (r && r.ids && !opts.silent) {
          if (o.mode !== 'rule' && o.mode !== 'repair' && o.mode !== 'maint' && o.mode !== 'clean' && o.mode !== 'setup') savedToast(r.ids.length > 1 ? 'Записано робіт: ' + r.ids.length : 'Роботу записано');
        }
        return r || null;
      });
    });
  }

  /* ---- #/line/:id/work — запис роботи на сторінці ---- */
  function workScreen(p, host, ctx) {
    var l = App.line(p.id);
    if (!l) { lineMissing(host, p.id); return; }
    App.setTitle('Запис роботи · ' + l.name);
    var mode = { repair: 1, maint: 1, rule: 1, clean: 1, setup: 1 }[p.mode] ? p.mode : (p.rule ? 'rule' : 'free');
    host.innerHTML = UI.pageHead({ title: 'Запис роботи', kicker: l.name, back: lineHref(l.id), sub: 'Ремонт, ТО, заміна деталі, налаштування — усе, що зроблено на лінії.' }) +
      '<section class="card op-wf-card"><div class="card-body"><div class="op-wf" data-track-dirty></div>' +
      '<div class="form-actions"><a class="btn ghost" href="' + lineHref(l.id) + '" data-back>Скасувати</a>' +
      '<button type="button" class="btn primary lg" data-wf-save>' + icon('check') + '<span>Зберегти роботу</span></button></div></div></section>';
    var form = WorkForm(host.querySelector('.op-wf'), l, { mode: mode, rule_id: p.rule, work_type: p.type, unit_id: p.unit, requireOperator: true });
    var busy = false;
    host.querySelector('[data-wf-save]').addEventListener('click', function () {
      if (busy) return;
      busy = true;
      form.submit().then(function (r) {
        busy = false;
        if (!r || !ctx.alive()) return;
        savedToast(r.ids.length > 1 ? 'Записано робіт: ' + r.ids.length : 'Роботу записано');
        returnToLine(l.id);
      }, function () { busy = false; });
    });
  }
  function returnToLine(lineId) {
    App.setDirty(false);
    if (lastLineHash === lineHref(lineId)) App.back(lineHref(lineId));
    else App.go(lineHref(lineId), { replace: true });
  }

  /* =====================================================================
     ЛІЧИЛЬНИКИ
     ===================================================================== */
  function openReadings(lineId) {
    var l = App.line(lineId);
    if (!l) return Promise.resolve(null);
    var ms = bySort(App.metersOf(lineId));
    var s = App.lineStatus(lineId);
    var hours = '<div class="box op-note">' + icon('clock', 20) + 'Мотогодини лінії: <b>' + esc(numText(s.cum_h)) + '</b> — рахуються автоматично за часом роботи.</div>';
    if (!ms.length) {
      return UI.alert({ title: 'Лічильники · ' + l.name, html: hours + '<p class="op-mt">Для цієї лінії інших лічильників немає. Керівник може додати їх у розділі «Обладнання».</p>' });
    }
    return App.requireOperator(lineId).then(function (op) {
      if (!op) return null;
      var html = hours + '<div class="op-meters">' + ms.map(function (m) {
        var inc = m.mode === 'inc';
        return '<div class="op-meter">' + UI.field.number({ name: 'm_' + m.id, label: m.name, unit: m.unit_label,
          hint: (inc ? 'Приріст за зміну (скільки додалося). ' : 'Поточний показник на лічильнику. ') + 'Останнє: ' + numText(m.value, m.unit_label) + (m.value_ts ? ', ' + fmt.dt(m.value_ts) : '') }) + '</div>';
      }).join('') + '</div>' + UI.field.text({ name: 'note', label: 'Примітка', maxLength: 500, placeholder: 'Необов’язково' });
      var box = UI.el('div', { class: 'op-dlg' });
      box.innerHTML = html;
      var m = UI.modal({
        title: 'Лічильники · ' + l.name, size: 'md', className: 'op-modal', body: box,
        actions: [{ label: 'Скасувати', tone: 'ghost', value: null }, { label: 'Зберегти показники', tone: 'primary', icon: 'check', onClick: function (mm) {
          var v = UI.readForm(box), e = {}, vals = [];
          ms.forEach(function (mt) {
            var raw = box.querySelector('input[name="m_' + mt.id + '"]').value.trim();
            if (!raw) return;
            var x = v['m_' + mt.id];
            if (x === null || isNaN(x)) e['m_' + mt.id] = 'Введіть число';
            else if (x < 0) e['m_' + mt.id] = 'Не може бути від’ємним';
            else vals.push({ m: mt, v: x });
          });
          if (UI.setErrors(box, e)) return false;
          if (!vals.length) { mm.setError('Введіть хоча б один показник'); return false; }
          var lower = vals.filter(function (x) { return x.m.mode !== 'inc' && typeof x.m.value === 'number' && x.v < x.m.value; });
          var ok = lower.length ? UI.confirm({ title: 'Показник менший за попередній', ok: 'Так, зберегти',
            text: lower.map(function (x) { return x.m.name + ': ' + numText(x.v) + ' < ' + numText(x.m.value); }).join('; ') + '. Можливо, лічильник замінили або скинули. Зберегти?' }) : Promise.resolve(true);
          return ok.then(function (yes) {
            if (!yes) return false;
            vals.forEach(function (x) { write('reading', { line_id: lineId, meter_id: x.m.id, value: x.v, mode: x.m.mode || 'abs', operator: op.name, note: v.note }); });
            savedToast(vals.length > 1 ? 'Показники збережено' : 'Показник збережено');
            return true;
          });
        } }]
      });
      return m.result;
    });
  }

  /* =====================================================================
     ЧЕК-ЛИСТ  #/line/:id/check/:occasion
     ===================================================================== */
  /* оцінка відповіді — як у ядрі (addChecklist) */
  function evalItem(it, v) {
    var r = { answered: false, ok: null, text: '', num: null };
    if (v === undefined || v === null || String(v).trim() === '') return r;
    if (it.type === 'check') {
      if (!CHECK_V[v]) return r;
      r.answered = true; r.ok = v === 'ok' ? true : v === 'fail' ? false : null; r.text = CHECK_V[v];
    } else if (it.type === 'number') {
      var n = UI.num(v);
      if (n === null) return r;
      r.answered = true; r.num = n;
      r.ok = (it.min === null || it.min === undefined || n >= it.min) && (it.max === null || it.max === undefined || n <= it.max);
      r.text = numText(n, it.unit_label);
    } else if (it.type === 'select') {
      var sv = String(v).replace(/^!/, '').trim().toLowerCase();
      optsOf(it).forEach(function (o) {
        var bare = String(o).replace(/^!/, '').trim();
        if (!r.answered && bare.toLowerCase() === sv) { r.answered = true; r.ok = String(o).charAt(0) !== '!'; r.text = bare; }
      });
    } else {
      r.answered = true; r.ok = true; r.text = String(v).trim();
    }
    if (it.critical && r.answered && r.ok === null) r.ok = false;
    return r;
  }
  function thenFor(occ, state, q) {
    if (q === 'none') return '';
    if (occ === 'end') return state === 'off' ? '' : 'off';
    if (state === 'run' || state === 'stop') return '';
    return 'run';
  }
  function itemHtml(it) {
    var id = esc(it.id);
    var meta = [unitName(it.unit_id)].filter(Boolean).map(esc).join(' · ');
    var head = '<div class="op-item-h"><div class="op-item-t">' + esc(it.text) + (it.required !== false ? ' <span class="req" title="Обов’язковий пункт">*</span>' : ' <span class="op-lbl-opt">необов’язково</span>') + '</div>' +
      (meta || it.critical ? '<div class="op-item-s">' + meta + (it.critical ? UI.badge('Критичний', 'bad', { icon: 'shield' }) : '') + '</div>' : '') +
      (it.hint ? '<div class="op-item-hint">' + icon('info', 16) + esc(it.hint) + '</div>' : '') +
      '<button type="button" class="op-add-note" data-note-add>' + icon('plus', 16) + 'Додати примітку</button></div>';
    var ctl = '';
    if (it.type === 'check') {
      ctl = '<div class="op-tri" role="group" aria-label="Відповідь">' +
        '<button type="button" class="op-tri-b v-ok" data-v="ok" aria-pressed="false">' + icon('check', 22) + '<span>Норма</span></button>' +
        '<button type="button" class="op-tri-b v-fail" data-v="fail" aria-pressed="false">' + icon('x', 22) + '<span>Зауваження</span></button>' +
        '<button type="button" class="op-tri-b v-na" data-v="na" aria-pressed="false"><span>Н/З</span></button></div>';
    } else if (it.type === 'number') {
      var rg = rangeText(it);
      ctl = '<div class="op-num"><div class="inp-wrap"><input class="inp num" type="text" inputmode="decimal" autocomplete="off" name="v_' + id + '" aria-label="' + esc(it.text) + '" placeholder="' +
        '"' + (it.target !== null && it.target !== undefined ? ' data-target="' + esc(it.target) + '"' : '') + '>' + (it.unit_label ? '<span class="inp-unit">' + esc(it.unit_label) + '</span>' : '') + '</div>' +
        '<div class="op-range">' + (rg ? 'Норма: <b>' + esc(rg) + '</b>' : 'Без меж') + (it.target !== null && it.target !== undefined ? ' · ціль ' + esc(fmt.num(it.target, 3)) : '') + '</div>' +
        '<div class="op-verdict" aria-live="polite"></div></div>';
    } else if (it.type === 'select') {
      ctl = UI.chips({ name: 'v_' + it.id, allowEmpty: true, label: it.text, className: 'op-sel', options: optsOf(it).map(function (o) {
        var bad = String(o).charAt(0) === '!', bare = String(o).replace(/^!/, '').trim();
        return { value: bare, label: bare, tone: bad ? 'danger' : 'ok' };
      }) });
      if (!optsOf(it).length) ctl = '<div class="op-empty">' + icon('alert', 20) + '<span>Варіанти відповіді не задано — зверніться до керівника.</span></div>';
    } else {
      ctl = '<textarea class="inp" rows="2" maxlength="2000" name="v_' + id + '" aria-label="' + esc(it.text) + '" placeholder="Введіть текст"></textarea>';
    }
    return '<div class="op-item t-' + esc(it.type) + (it.critical ? ' is-crit' : '') + '" data-item="' + id + '">' + head + '<div class="op-item-c">' + ctl + '</div>' +
      '<div class="op-item-note" hidden><div class="field" data-field="n_' + id + '"><label for="n_' + id + '">Примітка<span class="op-note-req"></span></label>' +
      '<textarea class="inp" rows="2" maxlength="1000" id="n_' + id + '" name="n_' + id + '" placeholder="Що саме не так, що зроблено"></textarea><div class="field-err" role="alert"></div></div></div></div>';
  }

  function checklistScreen(p, host, ctx) {
    var l = App.line(p.id);
    if (!l) { lineMissing(host, p.id); return; }
    var occ = p.occasion;
    if (!OCC_TITLE[occ]) {
      App.setTitle('Чек-лист');
      host.innerHTML = UI.pageHead({ title: 'Невідомий чек-лист', kicker: l.name, back: lineHref(l.id) }) +
        UI.emptyState({ icon: 'alert', title: 'Такого чек-листа немає', text: 'Бувають чек-листи запуску, переналаштування і завершення.', action: { label: 'До лінії', href: lineHref(l.id) } });
      return;
    }
    App.setTitle(OCC_TITLE[occ] + ' · ' + l.name);
    var s = App.lineStatus(l.id);
    var items = bySort(App.itemsFor(l.id, occ));
    var meters = occ === 'end' ? bySort(App.metersOf(l.id).filter(function (m) { return m.ask_on_end; })) : [];
    var then = thenFor(occ, s.state, p.then);
    var workBlock = s.state === 'setup' && occ !== 'end' && then === 'run';
    var started = now().toISOString();
    var A = {}, N = {}, MV = {};
    var itemById = {};
    items.forEach(function (it) { itemById[it.id] = it; });
    var reqItems = items.filter(function (it) { return it.required !== false; });

    var thenTxt = then === 'run' ? 'Після перевірки лінія перейде в стан «Працює».' : then === 'off' ? 'Після перевірки лінія перейде в стан «Не працює».' :
      'Чек-лист буде збережено, стан лінії не зміниться.';
    var secs = [], secMap = {};
    items.forEach(function (it) {
      var k = it.section || 'Інше';
      if (!secMap[k]) { secMap[k] = { name: k, items: [] }; secs.push(secMap[k]); }
      secMap[k].items.push(it);
    });
    var op0 = App.operator();
    var showProduct = occ !== 'end';
    var info = '<section class="card op-ck-info"><div class="card-body">' +
      '<div class="op-ck-who"><span class="op-ck-lbl">Проходить</span><b id="ckWho">' + (op0 ? esc(op0.name) : '<span class="dim">оператора не вибрано</span>') + '</b>' +
      '<button type="button" class="btn sm" data-ck="who">' + icon('user', 18) + '<span>' + (op0 ? 'Змінити' : 'Вибрати') + '</span></button></div>' +
      '<div class="op-ck-when"><span class="op-ck-lbl">Розпочато</span><b>' + esc(fmt.time(started)) + '</b></div>' +
      (showProduct ? UI.field.text({ name: 'product', label: 'Продукт / формат', value: s.product || '', datalist: recentProducts(), maxLength: 200,
        placeholder: 'Що будемо випускати', className: 'op-ck-prod' }) : '') +
      '</div></section>';
    var body = '';
    if (!items.length) {
      body += '<div class="box info op-ck-empty">' + icon('info', 20) + 'Для цієї лінії немає пунктів чек-листа ' + esc(OCC_OF[occ]) +
        '. Керівник може додати їх у розділі «Обладнання». Запис усе одно можна зберегти й продовжити.</div>';
    }
    secs.forEach(function (sec, i) {
      body += '<section class="op-sec"><h2 class="op-sec-t"><span class="op-sec-n">' + (i + 1) + '</span>' + esc(sec.name) + '<small>' + sec.items.length + '</small></h2>' +
        sec.items.map(itemHtml).join('') + '</section>';
    });
    if (meters.length) {
      body += '<section class="op-sec"><h2 class="op-sec-t"><span class="op-sec-n">' + icon('gauge', 18) + '</span>Лічильники<small>' + meters.length + '</small></h2>' +
        '<div class="op-item op-mtrs">' + meters.map(function (m) {
          var inc = m.mode === 'inc';
          return UI.field.number({ name: 'mv_' + m.id, label: m.name + (inc ? ' за зміну' : ''), unit: m.unit_label,
            hint: (inc ? 'Скільки вироблено за зміну. ' : 'Показник на лічильнику зараз. ') + 'Останнє: ' + numText(m.value, m.unit_label) + (m.value_ts ? ', ' + fmt.dt(m.value_ts) : '') });
        }).join('') + '</div></section>';
    }
    if (workBlock) {
      var chk = occ === 'changeover' ? 'переналаштування' : 'налаштування';
      body += '<section class="op-sec op-wb"><h2 class="op-sec-t"><span class="op-sec-n">' + icon('wrench', 18) + '</span>Запис про ' + chk + '</h2><div class="op-item">' +
        UI.field.check({ name: 'wb_on', label: 'Записати роботу з ' + chk + ' в історію лінії', value: true }) +
        '<div class="op-wb-f">' + UI.field.textarea({ name: 'wb_params', label: 'Параметри налаштування', rows: 2, maxLength: 2000, placeholder: 'Напр., формат ПЕТ 500 мл; доза 503 г; 22 пл./хв' }) +
        UI.field.text({ name: 'wb_perf', label: 'Хто налаштовував', value: op0 ? op0.name : '', datalist: staffNames(), maxLength: 120 }) +
        '<p class="field-hint">Початок — ' + esc(fmt.dt(s.since)) + ' (коли лінія перейшла в «Налаштування»).</p></div></div></section>';
    }
    var foot = '<div class="op-ck-foot"><div class="op-ck-prog"><div class="op-ck-prog-t" id="ckProgT"></div>' +
      '<div class="prog lg"><i id="ckProgBar" style="width:0%"></i></div></div>' +
      '<button type="button" class="btn primary lg op-ck-go" data-ck="go">' + icon('checklist') + '<span class="op-go-l">Перевірити й завершити</span><span class="op-go-s">Завершити</span></button></div>';

    host.innerHTML = UI.pageHead({ title: OCC_TITLE[occ], kicker: l.name, back: lineHref(l.id), sub: esc(thenTxt) }) +
      '<div class="op-ck" data-track-dirty>' + info + body + foot + '</div>';

    var root = host.querySelector('.op-ck');
    function card(id) { return root.querySelector('.op-item[data-item="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]'); }
    function upd(id) {
      var it = itemById[id], c = card(id);
      if (!it || !c) return;
      var r = evalItem(it, A[id]);
      c.classList.toggle('is-ok', r.answered && r.ok === true);
      c.classList.toggle('is-bad', r.answered && r.ok === false);
      c.classList.toggle('is-na', r.answered && r.ok === null);
      if (r.answered) c.classList.remove('is-missing');
      var noteBox = c.querySelector('.op-item-note');
      var need = r.answered && r.ok === false;
      var show = need || nz(N[id]) || c.classList.contains('note-open');
      noteBox.hidden = !show;
      c.querySelector('[data-note-add]').hidden = show;
      var rq = c.querySelector('.op-note-req');
      if (rq) rq.innerHTML = need && it.critical ? ' <span class="req">*</span> <span class="op-lbl-opt">обов’язково для критичного пункту</span>' : '';
      if (it.type === 'check') {
        UI.qsa('.op-tri-b', c).forEach(function (b) { var on = b.getAttribute('data-v') === A[id]; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      } else if (it.type === 'number') {
        var vd = c.querySelector('.op-verdict'), raw = A[id];
        vd.className = 'op-verdict';
        if (!nz(raw)) vd.innerHTML = '';
        else if (!r.answered) { vd.className += ' bad'; vd.innerHTML = icon('alert', 18) + 'Це не число'; }
        else if (r.ok) { vd.className += ' ok'; vd.innerHTML = icon('check', 18) + 'У нормі'; }
        else { vd.className += ' bad'; vd.innerHTML = icon('alert', 18) + (it.min !== null && it.min !== undefined && r.num < it.min ? 'Нижче норми' : 'Вище норми'); }
      } else if (it.type === 'select') {
        c.classList.toggle('sel-bad', r.answered && r.ok === false);
      }
    }
    function progress() {
      var done = 0, reqLeft = 0;
      items.forEach(function (it) {
        var r = evalItem(it, A[it.id]);
        if (r.answered) done++;
        else if (it.required !== false) reqLeft++;
      });
      var tot = items.length;
      var pct = tot ? done / tot * 100 : 100;
      root.querySelector('#ckProgBar').style.width = pct.toFixed(1) + '%';
      root.querySelector('#ckProgT').innerHTML = tot ? '<b>' + done + ' з ' + tot + '</b> ' + (reqLeft ? '· залишилось обов’язкових: <b class="c-warn">' + reqLeft + '</b>' : '<span class="c-ok">· обов’язкові заповнено</span>') :
        'Пунктів немає';
      var go = root.querySelector('[data-ck="go"]');
      go.classList.toggle('is-ready', !reqLeft);
    }
    function touch() { App.setDirty(true); }

    UI.delegate(root, 'click', '.op-tri-b', function (e, b) {
      var c = b.closest('.op-item'), id = c.getAttribute('data-item'), v = b.getAttribute('data-v');
      A[id] = A[id] === v ? '' : v;
      touch(); upd(id); progress();
      if (A[id] === 'fail') { var n = c.querySelector('textarea[name^="n_"]'); if (n) setTimeout(function () { try { n.focus({ preventScroll: true }); } catch (x) { n.focus(); } }, 30); }
    });
    UI.delegate(root, 'click', '[data-note-add]', function (e, b) {
      var c = b.closest('.op-item');
      c.classList.add('note-open');
      upd(c.getAttribute('data-item'));
      var n = c.querySelector('textarea[name^="n_"]'); if (n) n.focus();
    });
    root.addEventListener('change', function (e) {
      var d = e.detail;
      if (d && d.name && d.name.indexOf('v_') === 0) { var id = d.name.slice(2); A[id] = d.value || ''; touch(); upd(id); progress(); }
    });
    root.addEventListener('input', function (e) {
      var t = e.target, n = t && t.name;
      if (!n) return;
      if (n.indexOf('v_') === 0) { var id = n.slice(2); A[id] = t.value; upd(id); progress(); }
      else if (n.indexOf('n_') === 0) { N[n.slice(2)] = t.value; }
      else if (n.indexOf('mv_') === 0) { MV[n.slice(3)] = t.value; }
      else if (n === 'wb_on') { /* нижче */ }
    });
    root.addEventListener('change', function (e) {
      if (e.target && e.target.name === 'wb_on') { var f = root.querySelector('.op-wb-f'); if (f) f.hidden = !e.target.checked; }
    });
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-ck]');
      if (!b) return;
      var a = b.getAttribute('data-ck');
      if (a === 'who') {
        App.chooseOperator(l.id).then(function (op) {
          if (!ctx.alive()) return;
          var o2 = op || App.operator();
          root.querySelector('#ckWho').innerHTML = o2 ? esc(o2.name) : '<span class="dim">оператора не вибрано</span>';
          var wp = root.querySelector('input[name="wb_perf"]'); if (wp && o2 && !wp.value) wp.value = o2.name;
        });
      } else if (a === 'go') submit();
    });
    // Enter у числовому полі — до наступного поля (зручно з екранною клавіатурою)
    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || !e.target || e.target.tagName !== 'INPUT' || e.target.type !== 'text') return;
      e.preventDefault();
      var all = UI.qsa('input.inp[type="text"], textarea.inp', root).filter(function (x) { return x.offsetParent !== null; });
      var nx = all[all.indexOf(e.target) + 1];
      if (nx) { try { nx.focus({ preventScroll: false }); } catch (x) { nx.focus(); } } else e.target.blur();
    });
    items.forEach(function (it) { upd(it.id); });
    progress();

    /* ---- перевірка і підсумок ---- */
    function flash(el) { if (!el) return; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    function validate() {
      var first = null, miss = 0, bad = 0;
      UI.clearErrors(root);
      items.forEach(function (it) {
        var c = card(it.id), r = evalItem(it, A[it.id]);
        if (it.type === 'number' && nz(A[it.id]) && !r.answered) { bad++; c.classList.add('is-missing'); if (!first) first = c; return; }
        if (!r.answered && it.required !== false) { miss++; c.classList.add('is-missing'); if (!first) first = c; return; }
        c.classList.remove('is-missing');
        if (it.critical && r.answered && r.ok === false && !nz(N[it.id])) {
          bad++;
          c.classList.add('note-open'); upd(it.id);
          UI.setErrors(c, (function () { var o = {}; o['n_' + it.id] = 'Для критичного пункту опишіть зауваження'; return o; })());
          if (!first) first = c;
        }
      });
      var me = {};
      meters.forEach(function (m) {
        var raw = MV[m.id];
        if (!nz(raw)) return;
        var x = UI.num(raw);
        if (x === null) me['mv_' + m.id] = 'Введіть число';
        else if (x < 0) me['mv_' + m.id] = 'Не може бути від’ємним';
      });
      if (Object.keys(me).length) { UI.setErrors(root.querySelector('.op-mtrs'), me); bad++; if (!first) first = root.querySelector('.op-mtrs'); }
      if (first) {
        flash(first);
        UI.toast(miss ? 'Заповніть обов’язкові пункти: ' + miss : 'Перевірте позначені пункти', { tone: 'warn' });
        return false;
      }
      return true;
    }
    function submit() {
      if (!validate()) return;
      App.requireOperator(l.id).then(function (op) {
        if (!op || !ctx.alive()) return;
        root.querySelector('#ckWho').textContent = op.name;
        summary(op);
      });
    }
    function summary(op) {
      var res = items.map(function (it) { return { it: it, r: evalItem(it, A[it.id]) }; });
      var failed = 0, oor = 0, na = 0, crit = false;
      res.forEach(function (x) {
        if (x.it.type === 'check' && x.r.ok === false) failed++;
        if ((x.it.type === 'number' || x.it.type === 'select') && x.r.ok === false) oor++;
        if (x.r.answered && x.r.ok === null) na++;
        if (x.it.critical && x.r.ok === false) crit = true;
      });
      var result = crit ? 'fail' : failed + oor > 0 ? 'remarks' : 'ok';
      var probs = res.filter(function (x) { return x.r.ok === false; });
      var head = result === 'ok' ? '<div class="op-sum-res ok">' + icon('check', 30) + '<div><b>Усе в нормі</b><span>Зауважень немає</span></div></div>' :
        result === 'remarks' ? '<div class="op-sum-res soon">' + icon('alert', 30) + '<div><b>Є зауваження</b><span>' + (failed ? failed + ' ' + fmt.plural(failed, ['зауваження', 'зауваження', 'зауважень']) : '') +
          (failed && oor ? ' · ' : '') + (oor ? oor + ' поза нормою' : '') + '. Керівництво побачить їх у звіті.</span></div></div>' :
          '<div class="op-sum-res bad">' + icon('alert', 30) + '<div><b>Чек-лист не пройдено</b><span>Зауваження в критичних пунктах. Запуск — лише під відповідальність оператора.</span></div></div>';
      var counts = '<div class="op-sum-counts"><span><b>' + items.length + '</b> ' + fmt.plural(items.length, ['пункт', 'пункти', 'пунктів']) + '</span><span><b>' + res.filter(function (x) { return x.r.ok === true; }).length + '</b> норма</span>' +
        '<span' + (failed ? ' class="c-bad"' : '') + '><b>' + failed + '</b> ' + fmt.plural(failed, ['зауваження', 'зауваження', 'зауважень']) + '</span><span' + (oor ? ' class="c-bad"' : '') + '><b>' + oor +
        '</b> поза нормою</span><span><b>' + na + '</b> Н/З</span></div>';
      var plist = probs.length ? '<div class="op-sum-list">' + probs.map(function (x) {
        return '<div class="op-sum-p">' + icon('alert', 18) + '<div><b>' + esc(x.it.text) + '</b><span>' + esc(x.r.text) +
          (x.it.type === 'number' && rangeText(x.it) ? ' (норма ' + esc(rangeText(x.it)) + ')' : '') + (nz(N[x.it.id]) ? ' — ' + esc(N[x.it.id]) : '') + '</span></div>' +
          (x.it.critical ? UI.badge('критичний', 'bad') : '') + '</div>';
      }).join('') + '</div>' : '';
      var rds = meters.filter(function (m) { return nz(MV[m.id]); });
      var rlist = rds.length ? '<div class="op-sum-rd">' + rds.map(function (m) {
        var x = UI.num(MV[m.id]), low = m.mode !== 'inc' && typeof m.value === 'number' && x < m.value;
        return '<div>' + icon('gauge', 18) + esc(m.name) + ': <b>' + esc(numText(x, m.unit_label)) + '</b>' + (low ? ' <span class="c-warn">(менше за попередній ' + esc(numText(m.value)) + ')</span>' : '') + '</div>';
      }).join('') + '</div>' : (meters.length ? '<div class="op-sum-rd dim">Показники лічильників не внесено.</div>' : '');
      var failStart = result === 'fail' && then === 'run';
      var html = head + counts + plist + rlist +
        UI.field.textarea({ name: 'comment', label: failStart ? 'Коментар (обов’язково, якщо запускаєте попри зауваження)' : 'Коментар', rows: 2, maxLength: 2000,
          placeholder: 'Необов’язково: що варто знати керівнику або наступній зміні' });
      var acts = [{ label: 'Назад', tone: 'ghost', icon: 'back', value: null }];
      var choice = function (c) { return function (mm) { return commit(op, c, mm); }; };
      if (then === 'run' && result !== 'fail') {
        acts.push({ label: 'Зберегти без запуску', tone: 'ghost', onClick: choice({ state: '' }) });
        acts.push({ label: 'Запустити лінію', tone: 'ok', icon: 'play', onClick: choice({ state: 'run' }) });
      } else if (failStart) {
        acts.push({ label: 'Не запускати — викликати ремонт', tone: 'danger', icon: 'wrench', onClick: choice({ state: 'repair', reason: 'Чек-лист ' + OCC_OF[occ] + ' не пройдено', note: probs.filter(function (x) { return x.it.critical; }).map(function (x) { return x.it.text; }).join('; ').slice(0, 500) }) });
        acts.push({ label: 'Запустити під мою відповідальність', tone: 'primary', icon: 'play', onClick: choice({ state: 'run', forced: true }) });
      } else if (then === 'off') {
        if (result === 'fail') acts.push({ label: 'Викликати ремонт', tone: 'danger', icon: 'wrench', onClick: choice({ state: 'repair', reason: 'Чек-лист завершення не пройдено' }) });
        acts.push({ label: 'Завершити роботу', tone: 'primary', icon: 'power', onClick: choice({ state: 'off' }) });
      } else {
        acts.push({ label: 'Зберегти чек-лист', tone: 'primary', icon: 'check', onClick: choice({ state: '' }) });
      }
      UI.modal({ title: 'Підсумок: ' + OCC_TITLE[occ].toLowerCase(), size: 'md', className: 'op-modal op-sum-modal', body: html, actions: acts,
        initialFocus: '.modal-foot .btn:last-child' });
    }
    function commit(op, c, mm) {
      var comment = (mm.body.querySelector('textarea[name="comment"]') || {}).value || '';
      comment = comment.trim();
      if (c.forced && !comment) {
        mm.setError('Опишіть, чому запускаєте попри зауваження');
        var ta = mm.body.querySelector('textarea[name="comment"]'); if (ta) ta.focus();
        return false;
      }
      var prodIn = root.querySelector('input[name="product"]');
      var product = prodIn ? prodIn.value.trim() : (s.product || '');
      var answers = items.filter(function (it) { return nz(A[it.id]) || nz(N[it.id]); }).map(function (it) {
        return { item_id: it.id, value: nz(A[it.id]) ? String(A[it.id]).trim() : '', note: nz(N[it.id]) ? N[it.id].trim() : '' };
      });
      var readings = meters.filter(function (m) { return nz(MV[m.id]) && UI.num(MV[m.id]) !== null; }).map(function (m) {
        return { id: Api.newId(), meter_id: m.id, value: UI.num(MV[m.id]), mode: m.mode || 'abs' };
      });
      var cur = App.lineStatus(l.id);
      // робота з налаштування / переналаштування (як у журналі робіт)
      var wbOn = root.querySelector('input[name="wb_on"]');
      if (workBlock && c.state === 'run' && wbOn && wbOn.checked && cur.state === 'setup') {
        var perf = (root.querySelector('input[name="wb_perf"]').value || op.name).trim();
        var wt = occ === 'changeover' ? 'changeover' : 'setup';
        var w = { id: Api.newId(), line_id: l.id, work_type: wt, title: UI.label('work_type', wt) + (product ? ' на ' + product : ''),
          params: root.querySelector('textarea[name="wb_params"]').value.trim(), product: product, performer: perf,
          staff_id: perf === op.name ? (op.staff_id || '') : staffIdByName(perf), status: 'done', ts: now().toISOString() };
        if (cur.since) w.started = UI.toDate(cur.since).toISOString();
        if (wt === 'changeover' && cur.since) w.downtime_min = minutesSince(cur.since);
        Object.keys(w).forEach(function (k) { if (w[k] === '') delete w[k]; });
        write('work', w);
      }
      var params = { line_id: l.id, occasion: occ, started: started, product: product, comment: comment, answers: answers };
      var of = opFields(op);
      params.operator = of.operator; params.staff_id = of.staff_id;
      if (readings.length) params.readings = readings;
      if (c.state) {
        params.then_event = { state: c.state };
        if (product && c.state !== 'off') params.then_event.product = product;
        if (c.reason) params.then_event.reason = c.reason;
        if (c.note) params.then_event.note = c.note;
      }
      if (c.forced) params.forced = true;
      write('checklist', params);
      rememberProduct(product);
      mm.close(true);
      var msg = c.state === 'run' ? (c.forced ? 'Лінію запущено під відповідальність оператора' : 'Чек-лист збережено, лінію запущено') :
        c.state === 'off' ? 'Чек-лист збережено, роботу завершено' : c.state === 'repair' ? 'Чек-лист збережено, лінія в ремонті' : 'Чек-лист збережено';
      savedToast(msg, c.forced || c.state === 'repair' ? 'warn' : 'ok');
      returnToLine(l.id);
      return false;
    }
  }

  /* =====================================================================
     ДЕТАЛІ: чек-лист, робота
     ===================================================================== */
  function answersHtml(check, answers) {
    var secs = [], map = {};
    answers.forEach(function (a) {
      var k = a.section || 'Інше';
      if (!map[k]) { map[k] = []; secs.push(k); }
      map[k].push(a);
    });
    var dur = check.started && check.ts ? fmt.duration(tms(check.ts) - tms(check.started)) : '';
    var head = UI.kv([
      ['Результат', check.result ? UI.badge(UI.label('check_result', check.result), RESULT_TONE[check.result] || 'muted') : '<span class="dim">ще не оцінено (у черзі)</span>'],
      ['Завершено', esc(fmt.datetime(check.ts)) + (dur ? ' <span class="dim">· тривав ' + esc(dur) + '</span>' : '')],
      ['Оператор', esc(check.operator || '')], ['Продукт', esc(check.product || '')],
      check.comment ? ['Коментар', esc(check.comment)] : null,
      check.void ? ['Анульовано', esc(check.void_note || 'так')] : null
    ]);
    if (!answers.length) return head + '<div class="op-empty op-mt">' + icon('info', 20) + '<span>Відповідей немає.</span></div>';
    return head + secs.map(function (k) {
      return '<div class="section-title">' + esc(k) + '</div><div class="op-ans">' + map[k].map(function (a) {
        var cls = a.ok === true ? 'ok' : a.ok === false ? 'bad' : 'na';
        var val = nz(a.value) ? a.value : '—';
        if (a.type === 'number' && a.num_value !== null && a.num_value !== undefined) val = numText(a.num_value, a.unit_label);
        var rg = a.type === 'number' ? rangeText(a) : '';
        return '<div class="op-an ' + cls + '"><div class="op-an-t">' + esc(a.text) + (rg ? '<small>норма ' + esc(rg) + '</small>' : '') + (a.note ? '<em>' + esc(a.note) + '</em>' : '') + '</div>' +
          '<div class="op-an-v">' + (a.ok === true ? icon('check', 18) : a.ok === false ? icon('alert', 18) : '') + '<b>' + esc(nz(a.value) || a.type === 'number' ? val : 'не заповнено') + '</b></div></div>';
      }).join('') + '</div>';
    }).join('');
  }
  function showCheck(id, ts, row) {
    var box = UI.el('div', { class: 'op-dlg op-ck-detail' });
    box.innerHTML = UI.spinner('Завантаження відповідей…');
    var title = row && OCC_TITLE[row.occasion] ? OCC_TITLE[row.occasion] : 'Чек-лист';
    var m = UI.modal({ title: title, size: 'lg', className: 'op-modal', body: box, actions: [{ label: 'Закрити', tone: 'primary', value: null }] });
    Api.call('check_detail', { id: id, ts: ts }).then(function (r) {
      if (!box.isConnected) return;
      if (!r.ok) { box.innerHTML = '<div class="box err">' + icon('alert', 20) + esc(r.message || 'Не вдалося завантажити чек-лист') + '</div>'; return; }
      m.setTitle((OCC_TITLE[r.check.occasion] || 'Чек-лист') + ' · ' + fmt.dt(r.check.ts));
      box.innerHTML = answersHtml(r.check, r.answers || []);
    });
    return m.result;
  }
  function showPendingCheck(op) {
    var p = op.params || {};
    var answers = (p.answers || []).map(function (a) {
      var it = App.item(a.item_id) || { text: a.item_id, type: 'text' };
      var r = evalItem(it, a.value);
      return { section: it.section, text: it.text, type: it.type, value: r.text || a.value, num_value: r.num, unit_label: it.unit_label, min: it.min, max: it.max,
        ok: r.answered ? r.ok : null, note: a.note };
    });
    var box = UI.el('div', { class: 'op-dlg op-ck-detail' });
    box.innerHTML = '<div class="box info">' + icon('refresh', 20) + 'Чек-лист ще не надіслано — очікує синхронізації.</div><div class="op-mt"></div>' +
      answersHtml({ ts: p.ts, started: p.started, operator: p.operator, product: p.product, comment: p.comment }, answers);
    return UI.modal({ title: (OCC_TITLE[p.occasion] || 'Чек-лист') + ' · ' + fmt.dt(p.ts), size: 'lg', className: 'op-modal', body: box,
      actions: [{ label: 'Закрити', tone: 'primary', value: null }] }).result;
  }
  function showWork(w) {
    var r = w.rule_id ? App.rule(w.rule_id) : null;
    var dur = w.duration_min !== null && w.duration_min !== undefined ? fmt.duration(w.duration_min * MIN) : '';
    var body = UI.kv([
      ['Вид', esc(UI.label('work_type', w.work_type))],
      ['Що зроблено', esc(w.title || '')],
      ['Агрегат', esc(unitName(w.unit_id) || 'Лінія в цілому')],
      r ? ['Регламент', esc(r.title)] : null,
      w.cause ? ['Причина', esc(w.cause)] : null,
      w.description ? ['Опис', '<span class="op-pre">' + esc(w.description) + '</span>'] : null,
      w.parts ? ['Замінені деталі', esc(w.parts)] : null,
      w.params ? ['Параметри', esc(w.params)] : null,
      w.product ? ['Продукт', esc(w.product)] : null,
      ['Виконавець', esc(w.performer || '')],
      ['Початок', w.started ? esc(fmt.datetime(w.started)) : ''],
      ['Завершено', esc(fmt.datetime(w.ts))],
      dur ? ['Тривалість', esc(dur)] : null,
      w.downtime_min ? ['Простій лінії', esc(fmt.duration(w.downtime_min * MIN))] : null,
      w.hours_at !== null && w.hours_at !== undefined ? ['Мотогодини лінії', esc(numText(w.hours_at))] : null,
      w.meter_at !== null && w.meter_at !== undefined ? ['Лічильник', esc(numText(w.meter_at))] : null,
      ['Статус', esc(UI.label('work_status', w.status || 'done'))],
      w.void ? ['Анульовано', esc(w.void_note || 'так')] : null
    ]);
    return UI.modal({ title: w.title || 'Робота', size: 'md', className: 'op-modal', body: body, actions: [{ label: 'Закрити', tone: 'primary', value: null }] }).result;
  }

  /* =====================================================================
     ІСТОРІЯ ЛІНІЇ  #/line/:id/history
     ===================================================================== */
  var TYPES = [{ value: 'all', label: 'Усе' }, { value: 'event', label: 'Стан' }, { value: 'check', label: 'Чек-листи' }, { value: 'work', label: 'Роботи' }, { value: 'reading', label: 'Показники' }];
  function historyScreen(p, host, ctx) {
    var l = App.line(p.id);
    if (!l) { lineMissing(host, p.id); return; }
    App.setTitle('Історія · ' + l.name);
    var st = { type: TYPES.some(function (t) { return t.value === p.type; }) ? p.type : 'all', day: p.day || '', data: null, lim: 80 };
    host.innerHTML = UI.pageHead({ title: 'Історія лінії', kicker: l.name, back: lineHref(l.id), sub: 'Останні 14 днів',
      actions: '<button type="button" class="btn op-hreload" data-h="reload" aria-label="Оновити історію">' + icon('refresh', 20) + '<span>Оновити</span></button>' }) + '<div class="op-hist"></div>';
    var box = host.querySelector('.op-hist');
    bindRecords(host);
    function load(force) {
      var c = cached(l.id, 14);
      if (c && !force) { st.data = c.data; draw(); if (Date.now() - c.at < 60000) return; }
      else box.innerHTML = UI.spinner('Завантаження історії…');
      loadLine(l.id, 14, force ? 0 : 60000).then(function (r) {
        if (!ctx.alive()) return;
        if (r && r.ok) { st.data = r; st.partial = ''; draw(); return; }
        if (st.data && !st.partial) { UI.toast('Не вдалося оновити: ' + ((r && r.message) || 'немає зв’язку'), { tone: 'warn' }); return; }
        var c2 = cached(l.id, 2);
        if (c2) { st.data = c2.data; st.partial = (r && r.message) || 'немає зв’язку з сервером'; draw(); return; }
        box.innerHTML = UI.emptyState({ icon: 'cloudOff', title: 'Історію не завантажено', text: ((r && r.message) || 'Немає зв’язку з сервером') + '. Записи, що очікують синхронізації, показано нижче.',
          action: { label: 'Спробувати ще раз', action: 'hist-retry' } }) + (Api.pendingFor(l.id).length ? '<div class="op-recs op-mt">' + pendingHtml(l.id) + '</div>' : '');
      });
    }
    function draw() {
      var d = st.data;
      if (!d) return;
      var segs = segsWithPending(d.timeline, l.id);
      var days = (d.days || []).slice().reverse();
      var tk = todayKey();
      var rows = days.map(function (x) {
        var a = dayStart(x.day), b = dayStart(keyAdd(x.day, 1));
        var run = x.hours && x.hours.run || 0;
        var sub = [x.starts ? x.starts + ' ' + fmt.plural(x.starts, ['запуск', 'запуски', 'запусків']) : '', x.checks ? x.checks + ' ' + fmt.plural(x.checks, ['чек-лист', 'чек-листи', 'чек-листів']) : ''].filter(Boolean).join(' · ');
        return '<button type="button" class="op-hday' + (st.day === x.day ? ' on' : '') + '" data-day="' + esc(x.day) + '" aria-pressed="' + (st.day === x.day) + '">' +
          '<span class="op-hday-l"><b>' + esc(fmt.dayLabel(x.day)) + '</b><small>' + (x.day === tk ? 'сьогодні' : x.day === keyAdd(tk, -1) ? 'вчора' : '&nbsp;') + '</small></span>' +
          '<span class="op-hday-s">' + stripHtml(segs, a, b, { label: 'Стани лінії ' + fmt.dayLabel(x.day) }) + '</span>' +
          '<span class="op-hday-v"><b>' + (run > 0.004 ? esc(fmt.hm(run)) : '—') + '</b><small>' + esc(sub || 'без запусків') + '</small></span></button>';
      }).join('');
      var recs = recordsOf(d, l.id);
      var counts = { all: recs.length, event: 0, check: 0, work: 0, reading: 0 };
      recs.forEach(function (x) { counts[x.k]++; });
      var list = recs.filter(function (x) { return (st.type === 'all' || x.k === st.type) && (!st.day || fmt.dayKey(new Date(x.ts)) === st.day); });
      var groups = [], cur = null;
      list.forEach(function (x) {
        var k = fmt.dayKey(new Date(x.ts));
        if (!cur || cur.k !== k) { cur = { k: k, items: [] }; groups.push(cur); }
        cur.items.push(x);
      });
      var LIM = st.lim, shown = 0;
      var listHtml = groups.map(function (g) {
        if (shown >= LIM) return '';
        var its = g.items.slice(0, LIM - shown);
        shown += its.length;
        return '<div class="op-hgroup"><div class="op-hgroup-t">' + esc(fmt.dayLabel(g.k)) + (g.k === tk ? ' · сьогодні' : '') + '<small>' + g.items.length + '</small></div>' +
          '<div class="op-recs">' + its.map(recHtml).join('') + '</div></div>';
      }).join('');
      var pend = pendingHtml(l.id);
      box.innerHTML = (st.partial ? '<div class="box warn op-hpart">' + icon('cloudOff', 20) + 'Показано лише останні 2 дні: ' + esc(st.partial) +
        '. <button type="button" class="btn sm" data-h="reload">' + icon('refresh', 18) + '<span>Спробувати ще раз</span></button></div>' : '') +
        '<section class="card op-hdays"><div class="card-head">' + icon('chart', 20) + 'Стани по днях<span class="hint">торкніться дня, щоб відфільтрувати</span></div>' +
        '<div class="card-body"><div class="op-hday op-hday-axis" aria-hidden="true"><span class="op-hday-l"></span><span class="op-hday-s"><span class="op-axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></span></span><span class="op-hday-v"><small>у роботі</small></span></div>' +
        rows + '<div class="op-mt">' + UI.stateLegend() + '</div></div></section>' +
        '<div class="op-hfilt">' + UI.segmented({ name: 'htype', value: st.type, options: TYPES.map(function (t) { return { value: t.value, label: t.label, count: counts[t.value] }; }) }) +
        (st.day ? '<button type="button" class="btn sm" data-h="clear-day">' + icon('x', 18) + '<span>' + esc(fmt.dayLabel(st.day)) + '</span></button>' : '') + '</div>' +
        (pend ? '<div class="op-hgroup"><div class="op-hgroup-t">Очікують синхронізації</div><div class="op-recs">' + pend + '</div></div>' : '') +
        (listHtml || '<div class="op-empty op-mt">' + icon('info', 20) + '<span>Записів за вибраний період немає.</span></div>') +
        (list.length > LIM ? '<div class="op-more-row op-hmore"><span>Показано ' + LIM + ' з ' + list.length + '</span><button type="button" class="btn" data-h="more">' +
          icon('down', 20) + '<span>Показати ще</span></button></div>' : '');
    }
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-h], [data-day], [data-action="hist-retry"]');
      if (!b) return;
      if (b.hasAttribute('data-day')) {
        var dk = b.getAttribute('data-day'); st.day = st.day === dk ? '' : dk; st.lim = 80; draw();
        var f = host.querySelector('.op-hfilt'); if (f && st.day) f.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      else if (b.getAttribute('data-h') === 'more') { st.lim += 150; draw(); }
      else if (b.getAttribute('data-action') === 'hist-retry') load(true);
      else if (b.getAttribute('data-h') === 'reload') load(true);
      else if (b.getAttribute('data-h') === 'clear-day') { st.day = ''; draw(); }
    });
    host.addEventListener('change', function (e) {
      if (e.detail && e.detail.name === 'htype') { st.type = e.detail.value || 'all'; st.lim = 80; draw(); }
    });
    load(false);
    return {
      onQueue: function () { if (st.data) draw(); },
      onBoot: function (state, meta) { if (meta && meta.source === 'ack' && st.data) load(true); }
    };
  }

  /* ------------------------------ маршрути ------------------------------ */
  App.route('/line/:id', lineScreen);
  App.route('/line/:id/check/:occasion', checklistScreen, { rerender: false });
  App.route('/line/:id/work', workScreen, { rerender: false });
  App.route('/line/:id/history', historyScreen);

  return {
    openWorkForm: openWorkForm,
    openReadings: openReadings,
    showCheck: showCheck,
    showWork: showWork,
    showDue: showDue,
    markDone: markDone,
    stripHtml: stripHtml,
    evalItem: evalItem,
    needStartCheck: needStartCheck,
    ranSinceOff: ranSinceOff
  };
})();
