/* =====================================================================
   FOODLINE · Лінії — спільні UI-помічники (ui.js)
   Один глобальний об’єкт UI. Без залежностей, крім LinesCore (мітки, числа).
   Правило: будь-який динамічний текст у HTML — лише через UI.esc() / UI.html``.
   Статичні компоненти повертають HTML-РЯДКИ; інтерактивні (modal, keypad,
   table, menu, toast) — елементи або об’єкти-контролери. Див. docs/client-api.md.
   ===================================================================== */
var UI = (function () {
  'use strict';

  var LBL = LinesCore.LABELS;
  var U = LinesCore.util;

  /* ------------------------------ базові ------------------------------ */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function RawHtml(s) { this.s = String(s === null || s === undefined ? '' : s); }
  RawHtml.prototype.toString = function () { return this.s; };
  /* позначити рядок як готовий HTML (не екранувати в UI.html``) */
  function raw(s) { return new RawHtml(s); }
  function htmlVal(v) {
    if (v === null || v === undefined || v === false) return '';
    if (v instanceof RawHtml) return v.s;
    if (Array.isArray(v)) return v.map(htmlVal).join('');
    return esc(v);
  }
  /* тегований шаблон: UI.html`<b>${name}</b>` — значення екрануються; UI.raw(x) — ні; масиви з’єднуються */
  function html(strings) {
    var out = strings[0];
    for (var i = 1; i < arguments.length; i++) out += htmlVal(arguments[i]) + strings[i];
    return out;
  }
  /* об’єкт → рядок атрибутів: true → просто ім’я; false/null/undefined — пропуск */
  function attrs(o) {
    var s = '';
    if (!o) return s;
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      if (v === false || v === null || v === undefined) return;
      s += ' ' + k + (v === true ? '' : '="' + esc(v) + '"');
    });
    return s;
  }
  /* створення елемента: UI.el('button', {class:'btn', on:{click: fn}, text:'OK'}, child1, 'текст', …) */
  function el(tag, props) {
    var n = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class' || k === 'className') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.keys(v).forEach(function (p) { n.style[p] = v[p]; });
      else if (k === 'dataset') Object.keys(v).forEach(function (d) { n.dataset[d] = v[d]; });
      else if (k === 'on') Object.keys(v).forEach(function (e) { n.addEventListener(e, v[e]); });
      else if (k in n && typeof v !== 'string') n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(n, arguments[i]);
    return n;
  }
  function append(n, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(n, x); }); return; }
    n.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  /* делегування подій: fn(event, matchedElement); повертає функцію відписки */
  function delegate(root, type, selector, fn) {
    var h = function (e) {
      var t = e.target && e.target.closest ? e.target.closest(selector) : null;
      if (t && root.contains(t)) fn(e, t);
    };
    root.addEventListener(type, h);
    return function () { root.removeEventListener(type, h); };
  }
  var uidSeq = 0;
  function uid(p) { return (p || 'u') + '_' + (++uidSeq).toString(36); }
  function toNum(v) { return U.toNum(v); }
  function toDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    var d = typeof v === 'number' ? new Date(v) : U.parseDate(v);
    return d && !isNaN(d.getTime()) ? d : null;
  }
  /* «зараз» для таймерів і відносного часу; App підміняє на час із поправкою годинника */
  var nowFn = function () { return new Date(); };

  /* ------------------------------ форматування ------------------------------ */

  var tz = null, dtf = {};
  var WD = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  var MON = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];
  var MON_FULL = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function setTz(z) { tz = z || null; dtf = {}; }
  /* складові дати в поясі заводу (settings.tz), інакше — у поясі пристрою */
  function parts(d) {
    d = toDate(d);
    if (!d) return null;
    var key = tz || '_';
    if (dtf[key] === undefined) {
      dtf[key] = null;
      if (tz && typeof Intl !== 'undefined') {
        try {
          dtf[key] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
            day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
        } catch (e) {
          try { dtf[key] = new Intl.DateTimeFormat('en-GB', { timeZone: tz === 'Europe/Kyiv' ? 'Europe/Kiev' : 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }); } catch (e2) { dtf[key] = null; }
        }
      }
    }
    var f = dtf[key];
    if (f && f.formatToParts) {
      var o = {};
      f.formatToParts(d).forEach(function (x) { o[x.type] = x.value; });
      var wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      return { y: +o.year, m: +o.month, d: +o.day, H: (+o.hour) % 24, M: +o.minute, S: +o.second, wd: wdMap[o.weekday] || 0 };
    }
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), H: d.getHours(), M: d.getMinutes(), S: d.getSeconds(), wd: d.getDay() };
  }
  function dayKey(d) { var p = parts(d); return p ? p.y + '-' + p2(p.m) + '-' + p2(p.d) : ''; }
  function plural(n, forms) {
    n = Math.abs(Math.floor(n));
    var a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return forms[0];
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return forms[1];
    return forms[2];
  }
  function num(n, dec) { return U.fmtNum(typeof n === 'string' ? U.toNum(n) : n, dec); }
  /* тривалість у мс → «3 год 12 хв», «45 хв», «2 дн. 3 год», «<1 хв» */
  function duration(ms, o) {
    o = o || {};
    if (ms === null || ms === undefined || isNaN(ms)) return '—';
    ms = Math.max(0, ms);
    var m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (o.seconds && m < 1) return Math.floor(ms / 1000) + ' с';
    if (m < 1) return '<1 хв';
    if (h < 1) return m + ' хв';
    if (d < 1) return h + ' год' + (m % 60 ? ' ' + (m % 60) + ' хв' : '');
    return d + ' дн.' + (h % 24 ? ' ' + (h % 24) + ' год' : '');
  }
  /* мс → «03:12:45» (для великих таймерів) */
  function clock(ms) {
    ms = Math.max(0, ms || 0);
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600);
    return (h < 10 ? '0' : '') + h + ':' + p2(Math.floor(s / 60) % 60) + ':' + p2(s % 60);
  }
  var fmt = {
    setTz: setTz,
    tz: function () { return tz; },
    parts: parts,
    dayKey: dayKey,
    plural: plural,
    num: num,
    int: function (n) { return num(n, 0); },
    /* 25.09.2026 */
    date: function (d) { var p = parts(d); return p ? p2(p.d) + '.' + p2(p.m) + '.' + p.y : '—'; },
    /* 25.09 */
    dateShort: function (d) { var p = parts(d); return p ? p2(p.d) + '.' + p2(p.m) : '—'; },
    /* 25 вересня 2026 */
    dateLong: function (d) { var p = parts(d); return p ? p.d + ' ' + MON_FULL[p.m - 1] + ' ' + p.y : '—'; },
    /* 14:05 */
    time: function (d) { var p = parts(d); return p ? p2(p.H) + ':' + p2(p.M) : '—'; },
    /* 25.09.2026 14:05 */
    datetime: function (d) { var p = parts(d); return p ? p2(p.d) + '.' + p2(p.m) + '.' + p.y + ' ' + p2(p.H) + ':' + p2(p.M) : '—'; },
    /* розумно: сьогодні → «14:05», цього року → «25.09 14:05», інакше → «25.09.2025 14:05» */
    dt: function (d) {
      var p = parts(d);
      if (!p) return '—';
      var n = parts(nowFn());
      var t = p2(p.H) + ':' + p2(p.M);
      if (p.y === n.y && p.m === n.m && p.d === n.d) return t;
      if (p.y === n.y) return p2(p.d) + '.' + p2(p.m) + ' ' + t;
      return p2(p.d) + '.' + p2(p.m) + '.' + p.y + ' ' + t;
    },
    /* «пт» */
    weekday: function (d) { var p = parts(d); return p ? WD[p.wd] : ''; },
    /* день 'YYYY-MM-DD' → «пт 25.09» */
    dayLabel: function (key) {
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || ''));
      if (!m) return '';
      var wd = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
      return WD[wd] + ' ' + m[3] + '.' + m[2];
    },
    /* «25 вер» */
    dayMonth: function (d) { var p = parts(d); return p ? p.d + ' ' + MON[p.m - 1] : ''; },
    monthName: function (m) { return ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'][m - 1] || ''; },
    duration: duration,
    clock: clock,
    /* години (дробові) → «3 год 12 хв» */
    hm: function (h) { return h === null || h === undefined || isNaN(h) ? '—' : duration(h * 3600000); },
    /* години → «12,5 год» */
    hours: function (h, dec) { return h === null || h === undefined || isNaN(h) ? '—' : num(h, dec === undefined ? (Math.abs(h) < 10 ? 1 : 0) : dec) + ' год'; },
    /* відсоток із числа 0–100 → «85 %» */
    pct: function (v, dec) { return v === null || v === undefined || isNaN(v) ? '—' : num(v, dec || 0) + ' %'; },
    /* відсоток із частки 0–1 → «85 %» */
    frac: function (v, dec) { return v === null || v === undefined || isNaN(v) ? '—' : num(v * 100, dec || 0) + ' %'; },
    /* відносний час: «щойно», «5 хв тому», «сьогодні о 14:05», «вчора о 09:10», «через 3 дн.» */
    relative: function (d) {
      d = toDate(d);
      if (!d) return '—';
      var now = nowFn(), diff = now.getTime() - d.getTime(), a = Math.abs(diff), fut = diff < 0;
      var min = Math.round(a / 60000), hr = Math.floor(a / 3600000);
      if (a < 60000) return fut ? 'за хвилину' : 'щойно';
      if (min < 60) return fut ? 'через ' + min + ' хв' : min + ' хв тому';
      var kd = dayKey(d), kn = dayKey(now);
      var dd = Math.round((Date.parse(kd + 'T00:00:00Z') - Date.parse(kn + 'T00:00:00Z')) / 86400000);
      if (hr < 6) return fut ? 'через ' + hr + ' год' : hr + ' год тому';
      if (dd === 0) return 'сьогодні о ' + fmt.time(d);
      if (dd === -1) return 'вчора о ' + fmt.time(d);
      if (dd === 1) return 'завтра о ' + fmt.time(d);
      if (dd < 0 && dd > -7) return (-dd) + ' дн. тому';
      if (dd > 0 && dd < 7) return 'через ' + dd + ' дн.';
      return fmt.date(d);
    },
    /* значення для <input type=datetime-local> (час пристрою) і назад → Date */
    inputDT: function (d) {
      d = toDate(d);
      if (!d) return '';
      return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    },
    fromInputDT: function (s) {
      var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ''));
      return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
    },
    inputDate: function (d) { d = toDate(d); return d ? d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) : ''; }
  };

  /* ------------------------------ мітки та кольори ------------------------------ */

  var STATES = ['run', 'stop', 'setup', 'clean', 'maint', 'repair', 'off'];
  function label(set, code) { return LinesCore.label(set, code); }
  function stateLabel(s) { return label('state', s || 'off'); }
  function stateColor(s) { return 'var(--st-' + (LBL.state[s] ? s : 'off') + ')'; }
  function options(set, o) {
    o = o || {};
    return Object.keys(LBL[set] || {}).filter(function (k) { return !o.only || o.only.indexOf(k) >= 0; })
      .map(function (k) { return { value: k, label: LBL[set][k] }; });
  }

  /* ------------------------------ іконки ------------------------------ */

  var ICONS = {
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    next: '<path d="M9 18l6-6-6-6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    up: '<path d="M18 15l-6-6-6 6"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    sun: '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    play: '<path d="M6 4l14 8-14 8z"/>',
    pause: '<path d="M7 4h3v16H7zM14 4h3v16h-3z"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
    power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    checklist: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
    backspace: '<path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><path d="M18 9l-6 6M12 9l6 6"/>',
    droplet: '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
    tablet: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M12 18h.01"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    cloud: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
    cloudOff: '<path d="M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3M1 1l22 22"/>',
    gauge: '<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    history: '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
    chart: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
    printer: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>',
    box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/>',
    tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
    dot: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>'
  };
  /* inline-SVG іконка (рядок): UI.icon('wrench', 20) */
  function icon(name, size, cls) {
    var s = size || 22;
    return '<svg class="ic ic-' + esc(name) + (cls ? ' ' + esc(cls) : '') + '" viewBox="0 0 24 24" width="' + s + '" height="' + s +
      '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      (ICONS[name] || ICONS.dot) + '</svg>';
  }
  var STATE_ICON = { off: 'power', run: 'play', setup: 'sliders', stop: 'pause', repair: 'wrench', maint: 'tool', clean: 'droplet' };

  /* ------------------------------ статичні компоненти (HTML-рядки) ------------------------------ */

  /* пігулка стану: UI.statusPill('run', {since, size:'lg'|'sm', soft, label, pending, timer:'dur'|'clock'}) */
  function statusPill(state, o) {
    o = o || {};
    var st = LBL.state[state] ? state : 'off';
    var cls = 'pill st-' + st + (o.size ? ' ' + o.size : '') + (o.soft ? ' soft' : '') + (o.pending ? ' pending' : '') + (o.className ? ' ' + o.className : '');
    var since = toDate(o.since);
    var tm = '';
    if (since && o.timer !== false) {
      var f = o.timer || 'dur';
      tm = '<span class="tm" data-since="' + esc(since.toISOString()) + '" data-fmt="' + esc(f) + '">' +
        esc(timerText(since, f)) + '</span>';
    }
    return '<span class="' + cls + '"><i class="dot" aria-hidden="true"></i><b>' + esc(o.label || stateLabel(st)) + '</b>' + tm +
      (o.pending ? '<span class="sync" title="Очікує синхронізації">' + icon('refresh', 14) + '</span>' : '') + '</span>';
  }
  /* живий таймер без пігулки: <span data-since> (оновлюється UI.tick) */
  function timer(since, f) {
    var d = toDate(since);
    if (!d) return '—';
    f = f || 'dur';
    return '<span class="tm" data-since="' + esc(d.toISOString()) + '" data-fmt="' + esc(f) + '">' + esc(timerText(d, f)) + '</span>';
  }
  function timerText(since, f) {
    var ms = nowFn().getTime() - since.getTime();
    if (f === 'clock') return clock(ms);
    if (f === 'rel') return fmt.relative(since);
    if (f === 'durs') return duration(ms, { seconds: true });
    return duration(ms);
  }
  /* мітка-бейдж: tone = due|soon|ok|info|bad|muted|accent або код стану (run, stop …) */
  function badge(text, tone, o) {
    o = o || {};
    var t = tone || 'muted';
    var cls = 'badge ' + (LBL.state[t] ? 'st-' + t + ' b-state' : 'b-' + t) + (o.className ? ' ' + o.className : '');
    return '<span class="' + cls + '"' + (o.title ? ' title="' + esc(o.title) + '"' : '') + '>' + (o.icon ? icon(o.icon, 16) : '') + esc(text) + '</span>';
  }
  /* смуга прогресу ТО: pct — частка (1 = 100 %), status — ok|soon|due|none */
  function progress(pct, status, o) {
    o = o || {};
    var p = typeof pct === 'number' && isFinite(pct) ? pct : 0;
    var w = Math.max(0, Math.min(100, p * 100));
    var st = status || (p >= 1 ? 'due' : p >= 0.9 ? 'soon' : 'ok');
    return '<div class="prog s-' + esc(st) + (o.className ? ' ' + esc(o.className) : '') + '" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
      Math.round(p * 100) + '"' + (o.label ? ' aria-label="' + esc(o.label) + '"' : '') + '><i style="width:' + w.toFixed(1) + '%"></i>' +
      (p > 1 ? '<b class="over" style="width:' + Math.min(100, (p - 1) * 100).toFixed(1) + '%"></b>' : '') + '</div>';
  }
  /* велика кнопка дії: {label, sub, icon, tone (код стану|primary|danger|ok), solid, action, href, disabled, attrs, className} */
  function bigButton(o) {
    o = o || {};
    var tone = o.tone ? ' tone-' + o.tone : '';
    var cls = 'bigbtn' + tone + (o.solid ? ' solid' : '') + (o.className ? ' ' + o.className : '');
    var inner = (o.icon ? '<span class="bb-ic">' + icon(o.icon, 26) + '</span>' : '') +
      '<span class="bb-tx"><span class="bb-l">' + esc(o.label) + '</span>' + (o.sub ? '<span class="bb-s">' + esc(o.sub) + '</span>' : '') + '</span>' +
      (o.badge ? '<span class="bb-badge">' + esc(o.badge) + '</span>' : '') + (o.chevron ? '<span class="bb-chev">' + icon('next', 22) + '</span>' : '');
    var a = o.attrs || {};
    if (o.href) return '<a class="' + cls + '" href="' + esc(o.href) + '"' + attrs(a) + '>' + inner + '</a>';
    return '<button type="button" class="' + cls + '"' + (o.action ? ' data-action="' + esc(o.action) + '"' : '') +
      (o.value !== undefined ? ' data-value="' + esc(o.value) + '"' : '') + (o.disabled ? ' disabled' : '') + attrs(a) + '>' + inner + '</button>';
  }
  /* узагальнена плитка: {title, kicker, body (HTML), foot (HTML), href, state, tone, attrs, className} */
  function tile(o) {
    o = o || {};
    var cls = 'tile' + (o.state ? ' st-' + o.state : '') + (o.tone ? ' tone-' + o.tone : '') + (o.className ? ' ' + o.className : '');
    var inner = (o.kicker ? '<div class="tile-k">' + esc(o.kicker) + '</div>' : '') +
      (o.title ? '<div class="tile-t">' + esc(o.title) + '</div>' : '') +
      (o.body ? '<div class="tile-b">' + o.body + '</div>' : '') + (o.foot ? '<div class="tile-f">' + o.foot + '</div>' : '');
    if (o.href) return '<a class="' + cls + '" href="' + esc(o.href) + '"' + attrs(o.attrs) + '>' + inner + '</a>';
    return '<div class="' + cls + '"' + attrs(o.attrs) + '>' + inner + '</div>';
  }
  /* заголовок сторінки: {title, sub, back (hash|true), actions (HTML), kicker} */
  function pageHead(o) {
    o = o || {};
    var back = o.back ? '<a class="btn icon ghost back" href="' + esc(o.back === true ? '#/' : o.back) + '" data-back aria-label="Назад">' + icon('back', 26) + '</a>' : '';
    return '<header class="page-head">' + back + '<div class="ph-main">' + (o.kicker ? '<div class="ph-k">' + esc(o.kicker) + '</div>' : '') +
      '<h1>' + esc(o.title || '') + '</h1>' + (o.sub ? '<div class="ph-sub">' + o.sub + '</div>' : '') + '</div>' +
      (o.actions ? '<div class="ph-act">' + o.actions + '</div>' : '') + '</header>';
  }
  /* вибір-чипи: {name, options:[{value,label,tone,count,disabled}], value (рядок | масив для multi), multi, allowEmpty, size:'sm', className, label}.
     Клік перемикає чип і генерує подію 'change' (bubbles) на контейнері з detail {name, value, values}. */
  function chips(o, kind) {
    o = o || {};
    var multi = !!o.multi, sel = o.value;
    var isOn = function (v) { return multi ? (Array.isArray(sel) && sel.map(String).indexOf(String(v)) >= 0) : sel !== undefined && sel !== null && String(sel) === String(v); };
    var cls = (kind === 'seg' ? 'seg' : 'chips') + (o.size ? ' ' + o.size : '') + (o.className ? ' ' + o.className : '');
    return '<div class="' + cls + '" data-chips="' + esc(o.name || '') + '"' + (multi ? ' data-multi="1"' : '') + (o.allowEmpty ? ' data-allow-empty="1"' : '') +
      ' role="group"' + (o.label ? ' aria-label="' + esc(o.label) + '"' : '') + '>' +
      (o.options || []).map(function (op) {
        if (typeof op !== 'object') op = { value: op, label: op };
        var on = isOn(op.value);
        return '<button type="button" class="chip' + (on ? ' on' : '') + (op.tone ? ' tone-' + esc(op.tone) : '') + '" data-value="' + esc(op.value) +
          '" aria-pressed="' + (on ? 'true' : 'false') + '"' + (op.disabled ? ' disabled' : '') + '>' +
          (op.icon ? icon(op.icon, 18) : '') + (op.tone && LBL.state[op.tone] ? '<i class="cdot st-' + esc(op.tone) + '"></i>' : '') +
          '<span>' + esc(op.label) + '</span>' + (op.count !== undefined && op.count !== null ? '<em>' + esc(op.count) + '</em>' : '') + '</button>';
      }).join('') + '</div>';
  }
  function segmented(o) { return chips(o, 'seg'); }
  /* поточне значення групи чипів (елемент групи або root + name) */
  function chipValue(root, name) {
    var g = name ? qs('[data-chips="' + cssEsc(name) + '"]', root) : root;
    if (!g) return null;
    var vals = qsa('.chip.on', g).map(function (b) { return b.getAttribute('data-value'); });
    return g.getAttribute('data-multi') ? vals : (vals[0] === undefined ? null : vals[0]);
  }
  function setChipValue(root, name, value) {
    var g = name ? qs('[data-chips="' + cssEsc(name) + '"]', root) : root;
    if (!g) return;
    var vals = Array.isArray(value) ? value.map(String) : [String(value)];
    qsa('.chip', g).forEach(function (b) {
      var on = vals.indexOf(b.getAttribute('data-value')) >= 0;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-chips] > .chip') : null;
    if (!b || b.disabled) return;
    var g = b.parentNode, multi = !!g.getAttribute('data-multi'), allowEmpty = !!g.getAttribute('data-allow-empty');
    if (multi) {
      b.classList.toggle('on');
    } else {
      if (b.classList.contains('on')) { if (!allowEmpty) return; b.classList.remove('on'); }
      else { qsa('.chip.on', g).forEach(function (x) { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); }); b.classList.add('on'); }
    }
    b.setAttribute('aria-pressed', b.classList.contains('on') ? 'true' : 'false');
    var v = chipValue(g);
    g.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { name: g.getAttribute('data-chips'), value: multi ? null : v, values: multi ? v : (v === null ? [] : [v]) } }));
  });

  /* ---- поля форм (HTML-рядки). Спільні опції: {name, label, value, required, hint, placeholder, id, attrs, className, disabled} ---- */
  var fseq = 0;
  function field(o) {
    o = o || {};
    var type = o.type || 'text';
    var id = o.id || ('f_' + String(o.name || 'x').replace(/[^\w-]/g, '_') + '_' + (++fseq));
    var req = o.required ? ' <span class="req" aria-hidden="true">*</span>' : '';
    var common = { id: id, name: o.name, required: !!o.required, disabled: !!o.disabled, placeholder: o.placeholder, autocomplete: o.autocomplete || 'off' };
    var a = function (extra) { var x = {}; [common, extra || {}, o.attrs || {}].forEach(function (src) { Object.keys(src).forEach(function (k) { x[k] = src[k]; }); }); return attrs(x); };
    var ctl = '', lbl = o.label ? '<label for="' + esc(id) + '">' + esc(o.label) + req + '</label>' : '';
    var v = o.value === null || o.value === undefined ? '' : o.value;
    switch (type) {
      case 'number': {
        var nv = typeof v === 'number' ? String(v).replace('.', ',') : v;
        ctl = '<input class="inp num" type="text" inputmode="decimal" data-type="num"' + a({ value: nv }) + '>';
        if (o.unit) ctl = '<div class="inp-wrap">' + ctl + '<span class="inp-unit">' + esc(o.unit) + '</span></div>';
        break;
      }
      case 'select': {
        var opts = (o.options || []).map(function (op) {
          if (typeof op !== 'object') op = { value: op, label: op };
          return '<option value="' + esc(op.value) + '"' + (String(op.value) === String(v) ? ' selected' : '') + (op.disabled ? ' disabled' : '') + '>' + esc(op.label) + '</option>';
        }).join('');
        if (o.placeholder !== undefined) opts = '<option value=""' + (v === '' ? ' selected' : '') + '>' + esc(o.placeholder) + '</option>' + opts;
        common.placeholder = null;
        ctl = '<select class="inp"' + a() + '>' + opts + '</select>';
        break;
      }
      case 'textarea':
        ctl = '<textarea class="inp" rows="' + (o.rows || 3) + '"' + a({ maxlength: o.maxLength }) + '>' + esc(v) + '</textarea>';
        break;
      case 'datetime':
        ctl = '<input class="inp" type="datetime-local" data-type="datetime"' + a({ value: v ? fmt.inputDT(v) : '' }) + '>';
        break;
      case 'date':
        ctl = '<input class="inp" type="date" data-type="date"' + a({ value: v ? (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fmt.inputDate(v)) : '' }) + '>';
        break;
      case 'check':
        return '<div class="field field-check' + (o.className ? ' ' + esc(o.className) : '') + '" data-field="' + esc(o.name || '') + '">' +
          '<label class="check"><input type="checkbox"' + a({ checked: !!v, placeholder: null }) + '><span>' + esc(o.label || '') + '</span></label>' +
          (o.hint ? '<div class="field-hint">' + esc(o.hint) + '</div>' : '') + '<div class="field-err" role="alert"></div></div>';
      case 'chips':
        ctl = chips({ name: o.name, options: o.options, value: v, multi: o.multi, allowEmpty: o.allowEmpty, label: o.label });
        lbl = o.label ? '<div class="field-label">' + esc(o.label) + req + '</div>' : '';
        break;
      default: {
        var list = '';
        if (o.datalist && o.datalist.length) {
          common.list = id + '_dl';
          list = '<datalist id="' + esc(id) + '_dl">' + o.datalist.map(function (x) { return '<option value="' + esc(x) + '"></option>'; }).join('') + '</datalist>';
        }
        ctl = '<input class="inp" type="' + esc(type) + '"' + a({ value: v, maxlength: o.maxLength, inputmode: o.inputmode }) + '>' + list;
      }
    }
    return '<div class="field' + (o.className ? ' ' + esc(o.className) : '') + '" data-field="' + esc(o.name || '') + '">' + lbl + ctl +
      (o.hint ? '<div class="field-hint">' + esc(o.hint) + '</div>' : '') + '<div class="field-err" role="alert"></div></div>';
  }
  ['text', 'number', 'select', 'textarea', 'datetime', 'date', 'check', 'chips', 'password', 'email', 'url'].forEach(function (t) {
    field[t] = function (o) { var x = {}; Object.keys(o || {}).forEach(function (k) { x[k] = o[k]; }); x.type = t; return field(x); };
  });
  /* значення форми: {name: value}; checkbox → bool; data-type=num → число|null; datetime → ISO|''; date → 'YYYY-MM-DD'; чипи → значення/масив */
  function readForm(root) {
    var out = {};
    qsa('input[name], select[name], textarea[name]', root).forEach(function (n) {
      if (n.disabled) return;
      var k = n.name, t = n.getAttribute('data-type');
      if (n.type === 'checkbox') out[k] = n.checked;
      else if (n.type === 'radio') { if (n.checked) out[k] = n.value; }
      else if (t === 'num') out[k] = n.value.trim() === '' ? null : U.toNum(n.value);
      else if (t === 'datetime') { var d = fmt.fromInputDT(n.value); out[k] = d ? d.toISOString() : ''; }
      else out[k] = n.value.trim();
    });
    qsa('[data-chips]', root).forEach(function (g) { var k = g.getAttribute('data-chips'); if (k) out[k] = chipValue(g); });
    return out;
  }
  /* помилки полів: UI.setErrors(root, {name: 'текст'}) — фокус на першому; повертає true, якщо помилки є */
  function setErrors(root, errs) {
    clearErrors(root);
    var first = null;
    Object.keys(errs || {}).forEach(function (k) {
      if (!errs[k]) return;
      var f = qs('[data-field="' + cssEsc(k) + '"]', root);
      if (!f) return;
      f.classList.add('has-err');
      var e = qs('.field-err', f);
      if (e) e.textContent = errs[k];
      var c = qs('input, select, textarea, .chip', f);
      if (c) c.setAttribute('aria-invalid', 'true');
      if (!first) first = c;
    });
    if (first) { try { first.focus({ preventScroll: false }); } catch (e) { first.focus(); } }
    return !!first;
  }
  function clearErrors(root) {
    qsa('.field.has-err', root).forEach(function (f) {
      f.classList.remove('has-err');
      var e = qs('.field-err', f);
      if (e) e.textContent = '';
      qsa('[aria-invalid]', f).forEach(function (c) { c.removeAttribute('aria-invalid'); });
    });
  }
  /* порожній стан: {icon, title, text, action:{label, href|action, tone}} */
  function emptyState(o) {
    o = o || {};
    var act = '';
    if (o.action) {
      var ac = o.action;
      act = ac.href ? '<a class="btn ' + esc(ac.tone || 'primary') + '" href="' + esc(ac.href) + '">' + esc(ac.label) + '</a>'
        : '<button type="button" class="btn ' + esc(ac.tone || 'primary') + '" data-action="' + esc(ac.action || '') + '">' + esc(ac.label) + '</button>';
    }
    return '<div class="empty">' + (o.icon !== false ? '<div class="empty-ic">' + icon(o.icon || 'info', 34) + '</div>' : '') +
      '<h3>' + esc(o.title || 'Нічого немає') + '</h3>' + (o.text ? '<p>' + esc(o.text) + '</p>' : '') + (act ? '<div class="empty-act">' + act + '</div>' : '') + '</div>';
  }
  function spinner(text) {
    return '<div class="spin-wrap" role="status"><span class="spinner" aria-hidden="true"></span>' + (text ? '<span>' + esc(text) + '</span>' : '') + '</div>';
  }
  function loading(host, text) { host.innerHTML = spinner(text || 'Завантаження…'); }
  /* пари «назва — значення»: [[label, html], …] (значення — готовий HTML) */
  function kv(pairs, cls) {
    return '<dl class="kv' + (cls ? ' ' + esc(cls) : '') + '">' + (pairs || []).filter(Boolean).map(function (p) {
      return '<dt>' + esc(p[0]) + '</dt><dd>' + (p[1] === null || p[1] === undefined || p[1] === '' ? '—' : p[1]) + '</dd>';
    }).join('') + '</dl>';
  }
  /* горизонтальні смуги: items [{label, value, color, valueText, title}], o {max, fmt(v), unit} */
  function bars(items, o) {
    o = o || {};
    items = items || [];
    var max = o.max || Math.max.apply(null, [0].concat(items.map(function (x) { return x.value || 0; })));
    if (!items.length) return '<div class="hbars empty-bars">' + esc(o.empty || 'Немає даних') + '</div>';
    return '<div class="hbars">' + items.map(function (x) {
      var w = max > 0 ? Math.max(0, Math.min(100, (x.value || 0) / max * 100)) : 0;
      var vt = x.valueText !== undefined ? x.valueText : (o.fmt ? o.fmt(x.value) : num(x.value, 1) + (o.unit ? ' ' + o.unit : ''));
      return '<div class="hb"' + (x.title ? ' title="' + esc(x.title) + '"' : '') + '><div class="hb-l">' + esc(x.label) + '</div>' +
        '<div class="hb-t"><i style="width:' + w.toFixed(1) + '%;background:' + esc(x.color || 'var(--accent-bg)') + '"></i></div>' +
        '<div class="hb-v">' + esc(vt) + '</div></div>';
    }).join('') + '</div>';
  }
  /* складена смуга: parts [{value, color, label}], o {height, title} */
  function stackBar(parts, o) {
    o = o || {};
    var tot = (parts || []).reduce(function (s, p) { return s + (p.value > 0 ? p.value : 0); }, 0);
    return '<div class="sbar"' + (o.height ? ' style="height:' + (+o.height) + 'px"' : '') + (o.title ? ' title="' + esc(o.title) + '"' : '') + '>' +
      (tot > 0 ? parts.filter(function (p) { return p.value > 0; }).map(function (p) {
        return '<i style="flex:' + p.value.toFixed(4) + ' 1 0;background:' + esc(p.color) + '" title="' + esc((p.label || '') + (p.valueText ? ': ' + p.valueText : '')) + '"></i>';
      }).join('') : '') + '</div>';
  }
  /* смуга годин за станами: hours {state: h} (як у stats/daily) */
  function stateBar(hours, o) {
    return stackBar(STATES.map(function (s) {
      var h = hours && hours[s] || 0;
      return { value: h, color: stateColor(s), label: stateLabel(s), valueText: fmt.hours(h) };
    }), o);
  }
  function legend(items) {
    return '<div class="legend">' + (items || []).map(function (x) {
      return '<span><i style="background:' + esc(x.color) + '"></i>' + esc(x.label) + '</span>';
    }).join('') + '</div>';
  }
  function stateLegend(only) {
    return legend(STATES.filter(function (s) { return !only || only.indexOf(s) >= 0; }).map(function (s) { return { color: stateColor(s), label: stateLabel(s) }; }));
  }

  /* ------------------------------ живі таймери ------------------------------ */
  /* оновлює всі [data-since] (data-fmt: dur|durs|clock|rel) усередині root; App викликає щосекунди */
  function tick(root) {
    var list = (root || document).querySelectorAll('[data-since]');
    for (var i = 0; i < list.length; i++) {
      var n = list[i], d = toDate(n.getAttribute('data-since'));
      if (!d) continue;
      var t = timerText(d, n.getAttribute('data-fmt') || 'dur');
      if (n.textContent !== t) n.textContent = t;
    }
  }

  /* ------------------------------ модальні вікна ------------------------------ */

  var stack = [];
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function focusables(box) {
    return qsa(FOCUSABLE, box).filter(function (n) { return n.offsetWidth > 0 || n.offsetHeight > 0 || n === document.activeElement; });
  }
  /* UI.modal({title, body (HTML|Element|масив), actions:[{label, tone, value, onClick(m, e), autofocus, icon, className, disabled}],
       size:'sm'|'md'|'lg'|'full', locked, className, onClose(v), initialFocus (селектор), noHead})
     → {root, box, body, foot, result: Promise, close(v), setBusy(b), setError(msg), setLocked(b), setTitle(t)}.
     Esc / клік по фону закривають (результат null), якщо вікно не locked. onClick: false — не закривати;
     Promise — кнопки блокуються до завершення; значення (≠ false) стає результатом. */
  function modal(o) {
    o = o || {};
    var titleId = uid('mt');
    var overlay = el('div', { class: 'modal-overlay' });
    var box = el('div', { class: 'modal' + (o.size ? ' modal-' + o.size : '') + (o.className ? ' ' + o.className : ''), role: 'dialog', 'aria-modal': 'true', tabindex: '-1' });
    if (o.title) box.setAttribute('aria-labelledby', titleId);
    var head = null;
    if (!o.noHead && (o.title || !o.locked)) {
      head = el('div', { class: 'modal-head' });
      head.innerHTML = '<h2 id="' + titleId + '">' + esc(o.title || '') + '</h2>' +
        '<button type="button" class="btn icon ghost modal-x" data-close aria-label="Закрити">' + icon('x', 24) + '</button>';
      box.appendChild(head);
    }
    var body = el('div', { class: 'modal-body' });
    if (typeof o.body === 'string') body.innerHTML = o.body;
    else append(body, o.body);
    var err = el('div', { class: 'modal-err', role: 'alert' });
    err.hidden = true;
    box.appendChild(body);
    box.appendChild(err);
    var foot = null;
    var acts = (o.actions || []).filter(Boolean);
    if (acts.length) {
      foot = el('div', { class: 'modal-foot' });
      acts.forEach(function (a) {
        var b = el('button', { type: 'button', class: 'btn ' + (a.tone || '') + (a.className ? ' ' + a.className : '') });
        b.innerHTML = (a.icon ? icon(a.icon, 20) : '') + '<span>' + esc(a.label) + '</span>';
        if (a.disabled) b.disabled = true;
        if (a.id) b.id = a.id;
        if (a.autofocus) b.setAttribute('data-autofocus', '');
        b.addEventListener('click', function (e) { runAction(a, e); });
        a._btn = b;
        foot.appendChild(b);
      });
      box.appendChild(foot);
    }
    overlay.appendChild(box);
    var prevFocus = document.activeElement, closed = false, resolveFn, busy = false;
    var result = new Promise(function (r) { resolveFn = r; });
    var api = {
      root: overlay, box: box, body: body, foot: foot, head: head, result: result, locked: !!o.locked,
      close: close,
      setBusy: function (b) {
        busy = !!b;
        box.classList.toggle('is-busy', busy);
        qsa('.modal-foot .btn, [data-close]', box).forEach(function (x) { x.disabled = busy || !!x._wasDisabled; });
      },
      setError: function (msg) { err.textContent = msg || ''; err.hidden = !msg; if (msg) err.scrollIntoView({ block: 'nearest' }); },
      setLocked: function (b) { api.locked = !!b; var x = qs('[data-close]', box); if (x) x.hidden = api.locked; },
      setTitle: function (t) { var h = qs('#' + titleId, box); if (h) h.textContent = t; },
      button: function (i) { return acts[i] && acts[i]._btn; }
    };
    if (o.locked) api.setLocked(true);
    function runAction(a, e) {
      if (busy) return;
      api.setError('');
      if (!a.onClick) { close(a.value === undefined ? null : a.value); return; }
      var r;
      try { r = a.onClick(api, e); } catch (ex) { console.error(ex); api.setError(String(ex && ex.message || ex)); return; }
      if (r === false) return;
      if (r && typeof r.then === 'function') {
        api.setBusy(true);
        r.then(function (v) { if (closed) return; api.setBusy(false); if (v !== false) close(a.value !== undefined ? a.value : v); },
          function (ex) { if (closed) return; api.setBusy(false); api.setError(String(ex && ex.message || ex)); });
        return;
      }
      close(a.value !== undefined ? a.value : (r === undefined || r === true ? null : r));
    }
    function close(v) {
      if (closed) return;
      closed = true;
      var i = stack.indexOf(api);
      if (i >= 0) stack.splice(i, 1);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (!stack.length) document.documentElement.classList.remove('modal-open');
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) { try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* пропуск */ } }
      if (o.onClose) { try { o.onClose(v); } catch (e) { console.error(e); } }
      resolveFn(v === undefined ? null : v);
    }
    var downOnOverlay = false;
    overlay.addEventListener('mousedown', function (e) { downOnOverlay = e.target === overlay; });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay && downOnOverlay && !api.locked && !busy) close(null);
      var x = e.target.closest && e.target.closest('[data-close]');
      if (x && box.contains(x) && !api.locked && !busy) close(null);
    });
    document.body.appendChild(overlay);
    document.documentElement.classList.add('modal-open');
    stack.push(api);
    var f = (o.initialFocus && qs(o.initialFocus, box)) || qs('[data-autofocus]', box) || qs('[autofocus]', body) ||
      qs('input:not([type=hidden]):not([disabled]), select, textarea', body) || box;
    var focusIt = function () { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } };
    focusIt();
    setTimeout(function () { if (!closed && !box.contains(document.activeElement)) focusIt(); }, 0);
    return api;
  }
  document.addEventListener('keydown', function (e) {
    var top = stack[stack.length - 1];
    if (!top) return;
    if (e.key === 'Escape') {
      if (!top.locked && !top.box.classList.contains('is-busy')) { e.preventDefault(); top.close(null); }
      return;
    }
    if (e.key === 'Tab') {
      var f = focusables(top.box);
      if (!f.length) { e.preventDefault(); top.box.focus(); return; }
      var first = f[0], last = f[f.length - 1], a = document.activeElement;
      if (!top.box.contains(a)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && (a === first || a === top.box)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    }
  });
  function isModalOpen() { return stack.length > 0; }

  /* підтвердження: UI.confirm('Текст') або {title, text, html, ok, cancel, danger} → Promise<boolean> */
  function confirm(o) {
    if (typeof o === 'string') o = { text: o };
    o = o || {};
    var m = modal({
      title: o.title || 'Підтвердіть дію', size: 'sm', className: 'modal-confirm',
      body: '<div class="modal-text">' + (o.html || esc(o.text || '')) + '</div>',
      actions: [{ label: o.cancel || 'Скасувати', value: false, tone: 'ghost' },
        { label: o.ok || 'Так', value: true, tone: o.danger ? 'danger' : 'primary', autofocus: true }]
    });
    return m.result.then(function (v) { return v === true; });
  }
  /* повідомлення з однією кнопкою → Promise */
  function alertBox(o) {
    if (typeof o === 'string') o = { text: o };
    o = o || {};
    return modal({ title: o.title || 'Увага', size: 'sm', body: '<div class="modal-text">' + (o.html || esc(o.text || '')) + '</div>',
      actions: [{ label: o.ok || 'Зрозуміло', tone: 'primary', value: true, autofocus: true }] }).result;
  }
  /* введення тексту: {title, label, text, value, placeholder, required, multiline, maxLength, ok, inputmode, hint} → Promise<string|null> */
  function prompt(o) {
    o = o || {};
    var name = 'prompt_value';
    var body = (o.text ? '<p class="modal-text">' + esc(o.text) + '</p>' : '') +
      field({ type: o.multiline ? 'textarea' : 'text', name: name, label: o.label || '', value: o.value || '', placeholder: o.placeholder,
        required: o.required, maxLength: o.maxLength || (o.multiline ? 2000 : 200), inputmode: o.inputmode, hint: o.hint, rows: 4 });
    var m = modal({
      title: o.title || 'Введіть значення', size: 'sm', body: body,
      actions: [{ label: o.cancel || 'Скасувати', value: null, tone: 'ghost' },
        { label: o.ok || 'Зберегти', tone: 'primary', onClick: function (mm) {
          var v = qs('[name="' + name + '"]', mm.body).value.trim();
          if (o.required && !v) { setErrors(mm.body, (function () { var e = {}; e[name] = 'Заповніть це поле'; return e; })()); return false; }
          mm.close(v);
          return false;
        } }]
    });
    if (!o.multiline) {
      var inp = qs('input', m.body);
      if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); m.button(1).click(); } });
    }
    return m.result;
  }
  /* вибір із великих кнопок: {title, text, options:[{value, label, sub, icon, tone, disabled}], cancel, columns} → Promise<value|null> */
  function choose(o) {
    o = o || {};
    var body = (o.text ? '<p class="modal-text">' + esc(o.text) + '</p>' : '') +
      '<div class="choose-grid' + (o.columns ? ' cols-' + (+o.columns) : '') + '">' + (o.options || []).map(function (op, i) {
        return bigButton({ label: op.label, sub: op.sub, icon: op.icon, tone: op.tone, disabled: op.disabled, attrs: { 'data-choose': i } });
      }).join('') + '</div>';
    var m = modal({ title: o.title || 'Оберіть', size: o.size || 'md', body: body, className: 'modal-choose',
      actions: o.cancel === false ? [] : [{ label: o.cancel || 'Скасувати', value: null, tone: 'ghost' }] });
    delegate(m.body, 'click', '[data-choose]', function (e, b) { m.close(o.options[+b.getAttribute('data-choose')].value); });
    return m.result;
  }

  /* ------------------------------ тости ------------------------------ */
  /* UI.toast('Збережено', {tone:'ok'|'warn'|'err'|'info', ms, action:{label, onClick}}) → елемент */
  function toast(msg, o) {
    o = o || {};
    var hostEl = document.getElementById('toasts');
    if (!hostEl) { hostEl = el('div', { id: 'toasts', class: 'toast-host', 'aria-live': 'polite' }); document.body.appendChild(hostEl); }
    var tone = o.tone || 'info';
    var t = el('div', { class: 't toast-' + tone, role: tone === 'err' ? 'alert' : 'status' });
    var ic = { ok: 'check', warn: 'alert', err: 'alert', info: 'info' }[tone] || 'info';
    t.innerHTML = icon(ic, 22) + '<span class="t-msg">' + esc(msg) + '</span>';
    if (o.action) {
      var b = el('button', { type: 'button', class: 'btn sm' + (tone === 'info' ? ' primary' : ''), text: o.action.label });
      b.addEventListener('click', function (e) { e.stopPropagation(); remove(); if (o.action.onClick) o.action.onClick(); });
      t.appendChild(b);
    }
    var timer = null;
    function remove() { clearTimeout(timer); if (t.parentNode) t.parentNode.removeChild(t); }
    t.addEventListener('click', remove);
    hostEl.appendChild(t);
    while (hostEl.children.length > 4) hostEl.removeChild(hostEl.firstChild);
    var ms = o.ms !== undefined ? o.ms : (tone === 'err' ? 7000 : o.action ? 9000 : 3500);
    if (ms > 0) timer = setTimeout(remove, ms);
    t.remove = remove;
    return t;
  }

  /* ------------------------------ цифрова клавіатура ------------------------------ */
  /* UI.keypad({title, text, hint, mode:'pin'|'decimal'|'int', value, minLength, maxLength, unit, allowNegative,
       submitLabel, allowEmpty, onSubmit(value) → true | 'текст помилки' | Promise}) → Promise<string|null>.
     Повертає введений рядок (десятковий — із комою; перетворення: UI.num(s)). Працює й фізична клавіатура. */
  function keypad(o) {
    o = o || {};
    var mode = o.mode || 'pin';
    var maxLen = o.maxLength || (mode === 'pin' ? 8 : 12);
    var minLen = o.minLength !== undefined ? o.minLength : (mode === 'pin' ? 4 : 1);
    var val = o.value === null || o.value === undefined ? '' : String(o.value).replace('.', ',');
    var left = mode === 'decimal' ? ',' : (o.allowNegative ? '±' : 'C');
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', left, '0', 'del'];
    var body = '<div class="kp kp-' + esc(mode) + '">' + (o.text ? '<div class="kp-text">' + esc(o.text) + '</div>' : '') +
      '<div class="kp-display" aria-live="polite"><span class="kp-val"></span>' + (o.unit ? '<span class="kp-unit">' + esc(o.unit) + '</span>' : '') + '</div>' +
      '<div class="kp-keys">' + keys.map(function (k) {
        if (k === 'del') return '<button type="button" class="kp-key kp-del" data-k="del" aria-label="Стерти">' + icon('backspace', 28) + '</button>';
        var lab = k === 'C' ? 'Очистити' : k === '±' ? 'Змінити знак' : k === ',' ? 'Кома' : k;
        return '<button type="button" class="kp-key' + (/[\d,]/.test(k) ? '' : ' kp-fn') + '" data-k="' + esc(k) + '" aria-label="' + esc(lab) + '">' + esc(k) + '</button>';
      }).join('') + '</div>' + (o.hint ? '<div class="kp-hint">' + esc(o.hint) + '</div>' : '') + '</div>';
    var m = modal({
      title: o.title || (mode === 'pin' ? 'Введіть PIN' : 'Введіть значення'), size: 'sm', className: 'modal-keypad', body: body,
      actions: [{ label: 'Скасувати', value: null, tone: 'ghost' }, { label: o.submitLabel || 'Готово', tone: 'primary', onClick: submit }]
    });
    var disp = qs('.kp-val', m.body);
    function render() {
      if (mode === 'pin') {
        var s = '';
        for (var i = 0; i < Math.max(minLen, val.length); i++) s += '<i class="' + (i < val.length ? 'on' : '') + '"></i>';
        disp.innerHTML = s;
      } else disp.textContent = val === '' ? '0' : val;
      disp.parentNode.classList.toggle('is-empty', val === '');
    }
    function press(k) {
      m.setError('');
      if (k === 'del') val = val.slice(0, -1);
      else if (k === 'C') val = '';
      else if (k === '±') val = val.charAt(0) === '-' ? val.slice(1) : '-' + val;
      else if (k === ',') { if (val.indexOf(',') < 0) val = (val === '' || val === '-' ? val + '0' : val) + ','; }
      else if (/^\d$/.test(k)) {
        if (val.replace(/[-,]/g, '').length >= maxLen) return;
        if (mode !== 'pin' && (val === '0' || val === '-0')) val = val.slice(0, -1);
        val += k;
      }
      render();
    }
    function submit(mm) {
      var digits = val.replace(/[-,]/g, '');
      if (!val && o.allowEmpty) { mm.close(''); return false; }
      if (digits.length < Math.max(1, minLen)) { mm.setError(mode === 'pin' ? 'PIN має містити щонайменше ' + minLen + ' ' + plural(minLen, ['цифру', 'цифри', 'цифр']) : 'Введіть значення'); return false; }
      var out = val.replace(/,$/, '');
      if (!o.onSubmit) { mm.close(out); return false; }
      var r;
      try { r = o.onSubmit(out); } catch (e) { mm.setError(String(e && e.message || e)); return false; }
      var fin = function (res) {
        if (res === true || res === undefined || res === null) { mm.close(out); return; }
        mm.setError(typeof res === 'string' ? res : 'Невірне значення');
        if (mode === 'pin') { val = ''; render(); }
        m.box.classList.remove('shake'); void m.box.offsetWidth; m.box.classList.add('shake');
      };
      if (r && typeof r.then === 'function') {
        mm.setBusy(true);
        return r.then(function (res) { mm.setBusy(false); fin(res); return false; }, function (e) { mm.setBusy(false); mm.setError(String(e && e.message || e)); return false; });
      }
      fin(r);
      return false;
    }
    delegate(m.body, 'click', '[data-k]', function (e, b) { press(b.getAttribute('data-k')); });
    // фізична клавіатура — поки ця клавіатура верхнє вікно (незалежно від фокуса)
    var onKey = function (e) {
      if (stack[stack.length - 1] !== m || m.box.classList.contains('is-busy')) return;
      var t = e.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (/^\d$/.test(e.key)) { press(e.key); e.preventDefault(); }
      else if (e.key === 'Backspace') { press('del'); e.preventDefault(); }
      else if ((e.key === ',' || e.key === '.') && mode === 'decimal') { press(','); e.preventDefault(); }
      else if (e.key === '-' && o.allowNegative) { press('±'); e.preventDefault(); }
      else if (e.key === 'Enter') {
        if (t && t.tagName === 'BUTTON' && !t.classList.contains('kp-key')) return;     // Enter на кнопці — її власна дія
        e.preventDefault();
        m.button(1).click();
      }
    };
    document.addEventListener('keydown', onKey);
    m.result.then(function () { document.removeEventListener('keydown', onKey); });
    render();
    return m.result;
  }

  /* ------------------------------ спливне меню ------------------------------ */
  /* UI.menu(anchorEl, [{label, icon, onClick, href, danger, checked, disabled, sep, sub}]) → {close} */
  var openMenu = null;
  function menu(anchor, items, o) {
    o = o || {};
    if (openMenu) openMenu.close();
    var box = el('div', { class: 'menu' + (o.className ? ' ' + o.className : ''), role: 'menu' });
    items.filter(Boolean).forEach(function (it) {
      if (it.sep) { box.appendChild(el('div', { class: 'menu-sep', role: 'separator' })); return; }
      var tag = it.href ? 'a' : 'button';
      var b = el(tag, { class: 'menu-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : ''), role: 'menuitem' });
      if (it.href) b.href = it.href; else b.type = 'button';
      if (it.disabled) b.setAttribute('aria-disabled', 'true');
      b.innerHTML = (it.icon ? icon(it.icon, 22) : '<span class="ic-sp"></span>') + '<span class="mi-l">' + esc(it.label) +
        (it.sub ? '<small>' + esc(it.sub) + '</small>' : '') + '</span>' + (it.checked ? icon('check', 20, 'mi-chk') : '');
      b.addEventListener('click', function (e) {
        if (it.disabled) { e.preventDefault(); return; }
        close();
        if (it.onClick) { e.preventDefault(); it.onClick(e); }
      });
      box.appendChild(b);
    });
    document.body.appendChild(box);
    var r = anchor.getBoundingClientRect(), vw = document.documentElement.clientWidth;
    var w = box.offsetWidth;
    var left = Math.min(Math.max(8, r.right - w), vw - w - 8);
    box.style.left = left + 'px';
    box.style.top = (r.bottom + 6) + 'px';
    anchor.setAttribute('aria-expanded', 'true');
    function onDoc(e) { if (!box.contains(e.target) && !anchor.contains(e.target)) close(); }
    function onKey(e) {
      if (e.key === 'Escape') { close(); anchor.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        var list = qsa('.menu-item', box), i = list.indexOf(document.activeElement);
        i = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        list[i].focus(); e.preventDefault();
      }
    }
    setTimeout(function () { document.addEventListener('mousedown', onDoc); document.addEventListener('touchstart', onDoc, { passive: true }); }, 0);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    var first = qs('.menu-item', box);
    if (first) first.focus({ preventScroll: true });
    function close() {
      if (!box.parentNode) return;
      box.parentNode.removeChild(box);
      anchor.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('touchstart', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      if (openMenu && openMenu.box === box) openMenu = null;
    }
    openMenu = { close: close, box: box };
    return openMenu;
  }

  /* ------------------------------ таблиця з сортуванням ------------------------------ */
  /* UI.table({columns:[{key, label, num, sortable=true, value(row), render(row)→HTML, csv(row), className, width, title}],
       rows, sort:{key, dir:'asc'|'desc'}, empty, onRow(row, event), rowClass(row), rowAttrs(row), maxHeight, className, caption})
     → HTMLElement (div.tbl-wrap) з методами: setRows(rows), getRows() (відсортовані), sortBy(key, dir). */
  function table(o) {
    o = o || {};
    var cols = o.columns || [], rows = (o.rows || []).slice(), sort = o.sort ? { key: o.sort.key, dir: o.sort.dir || 'asc' } : null;
    var wrap = el('div', { class: 'tbl-wrap' + (o.className ? ' ' + o.className : '') });
    if (o.maxHeight) wrap.style.maxHeight = typeof o.maxHeight === 'number' ? o.maxHeight + 'px' : o.maxHeight;
    function colVal(c, r) {
      var v = c.value ? c.value(r) : r[c.key];
      return v;
    }
    function cmp(a, b) {
      if (a === b) return 0;
      if (a === null || a === undefined || a === '') return 1;
      if (b === null || b === undefined || b === '') return -1;
      if (a instanceof Date) a = a.getTime();
      if (b instanceof Date) b = b.getTime();
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      if (typeof a === 'string' && typeof b === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(a) && /^\d{4}-\d{2}-\d{2}T/.test(b)) return a < b ? -1 : 1;
      return String(a).localeCompare(String(b), 'uk', { numeric: true, sensitivity: 'base' });
    }
    function sorted() {
      if (!sort) return rows;
      var c = cols.filter(function (x) { return x.key === sort.key; })[0];
      if (!c) return rows;
      var mul = sort.dir === 'desc' ? -1 : 1;
      return rows.map(function (r, i) { return { r: r, i: i, v: colVal(c, r) }; }).sort(function (a, b) {
        var x = a.v, y = b.v;
        var blankA = x === null || x === undefined || x === '', blankB = y === null || y === undefined || y === '';
        if (blankA || blankB) return blankA && blankB ? a.i - b.i : blankA ? 1 : -1;     // порожні — завжди внизу
        return (cmp(x, y) * mul) || (a.i - b.i);
      }).map(function (x) { return x.r; });
    }
    function cell(c, r) {
      if (c.render) return c.render(r);
      var v = colVal(c, r);
      if (v === null || v === undefined || v === '') return '<span class="dim">—</span>';
      if (v instanceof Date) return esc(fmt.dt(v));
      if (typeof v === 'number') return esc(num(v, c.dec !== undefined ? c.dec : 2));
      if (typeof v === 'boolean') return v ? 'так' : 'ні';
      return esc(v);
    }
    var cur = [];
    function draw() {
      cur = sorted();
      var h = '<table class="tbl">' + (o.caption ? '<caption>' + esc(o.caption) + '</caption>' : '') + '<thead><tr>' + cols.map(function (c) {
        var cls = (c.num ? 'num' : '') + (c.className ? ' ' + c.className : '');
        var st = c.width ? ' style="width:' + esc(c.width) + '"' : '';
        if (c.sortable === false) return '<th class="' + cls + '"' + st + '>' + esc(c.label || '') + '</th>';
        var on = sort && sort.key === c.key;
        return '<th class="sortable ' + cls + (on ? ' sorted ' + sort.dir : '') + '"' + st + ' aria-sort="' + (on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') + '">' +
          '<button type="button" class="th-sort" data-sort="' + esc(c.key) + '"' + (c.title ? ' title="' + esc(c.title) + '"' : '') + '>' + esc(c.label || '') + '</button></th>';
      }).join('') + '</tr></thead><tbody>';
      if (!cur.length) h += '<tr class="tbl-empty"><td colspan="' + cols.length + '">' + esc(o.empty || 'Немає даних') + '</td></tr>';
      cur.forEach(function (r, i) {
        var ra = o.rowAttrs ? attrs(o.rowAttrs(r)) : '';
        h += '<tr data-i="' + i + '"' + (o.onRow ? ' class="clickable' + (o.rowClass ? ' ' + esc(o.rowClass(r) || '') : '') + '" tabindex="0"' : (o.rowClass ? ' class="' + esc(o.rowClass(r) || '') + '"' : '')) + ra + '>' +
          cols.map(function (c) { return '<td class="' + (c.num ? 'num' : '') + (c.className ? ' ' + c.className : '') + '">' + cell(c, r) + '</td>'; }).join('') + '</tr>';
      });
      wrap.innerHTML = h + '</tbody></table>';
    }
    wrap.addEventListener('click', function (e) {
      var b = e.target.closest('.th-sort');
      if (b) {
        var k = b.getAttribute('data-sort');
        sort = sort && sort.key === k ? { key: k, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'asc' };
        draw();
        var nb = qs('.th-sort[data-sort="' + cssEsc(k) + '"]', wrap);
        if (nb) nb.focus();
        return;
      }
      if (!o.onRow) return;
      var tr = e.target.closest('tr[data-i]');
      if (tr && !e.target.closest('a, button, input, select, textarea')) o.onRow(cur[+tr.getAttribute('data-i')], e);
    });
    wrap.addEventListener('keydown', function (e) {
      if (!o.onRow || (e.key !== 'Enter' && e.key !== ' ')) return;
      var tr = e.target.closest && e.target.closest('tr[data-i]');
      if (tr && e.target === tr) { e.preventDefault(); o.onRow(cur[+tr.getAttribute('data-i')], e); }
    });
    wrap.setRows = function (r) { rows = (r || []).slice(); draw(); };
    wrap.getRows = function () { return cur.slice(); };
    wrap.sortBy = function (k, d) { sort = { key: k, dir: d || 'asc' }; draw(); };
    wrap.columns = cols;
    draw();
    return wrap;
  }

  /* ------------------------------ CSV і файли ------------------------------ */
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) v = fmt.datetime(v);
    else if (typeof v === 'number') v = String(v).replace('.', ',');
    else if (typeof v === 'boolean') v = v ? 'так' : 'ні';
    else if (Array.isArray(v)) v = v.join('; ');
    v = String(v);
    if (/^[=+\-@]/.test(v)) v = "'" + v;             // захист від формул у Excel
    return /[";\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  /* UI.csv('журнал.csv', columns [{key,label,csv(row)|value(row)}] | null, rows (об’єкти або масиви)) — завантаження файлу (Excel: ; і BOM) */
  function csv(filename, columns, rows) {
    var lines = [];
    if (columns && columns.length) {
      lines.push(columns.map(function (c) { return csvCell(c.label || c.key); }).join(';'));
      (rows || []).forEach(function (r) {
        lines.push(columns.map(function (c) { return csvCell(c.csv ? c.csv(r) : c.value ? c.value(r) : r[c.key]); }).join(';'));
      });
    } else (rows || []).forEach(function (r) { lines.push((Array.isArray(r) ? r : [r]).map(csvCell).join(';')); });
    download(filename, '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }
  function download(filename, content, mime) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename || 'file' });
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 1500);
  }

  return {
    esc: esc, raw: raw, html: html, attrs: attrs, el: el, qs: qs, qsa: qsa, delegate: delegate, uid: uid,
    num: toNum, toDate: toDate,
    get now() { return nowFn; }, set now(f) { nowFn = typeof f === 'function' ? f : function () { return new Date(); }; },
    fmt: fmt,
    LABELS: LBL, STATES: STATES, STATE_ICON: STATE_ICON, label: label, stateLabel: stateLabel, stateColor: stateColor, options: options,
    icon: icon, ICONS: ICONS,
    statusPill: statusPill, timer: timer, badge: badge, progress: progress, bigButton: bigButton, tile: tile, pageHead: pageHead,
    chips: chips, segmented: segmented, chipValue: chipValue, setChipValue: setChipValue,
    field: field, readForm: readForm, setErrors: setErrors, clearErrors: clearErrors,
    emptyState: emptyState, spinner: spinner, loading: loading, kv: kv,
    bars: bars, stackBar: stackBar, stateBar: stateBar, legend: legend, stateLegend: stateLegend,
    tick: tick,
    modal: modal, isModalOpen: isModalOpen, confirm: confirm, alert: alertBox, prompt: prompt, choose: choose,
    toast: toast, keypad: keypad, menu: menu, table: table, csv: csv, download: download
  };
})();
