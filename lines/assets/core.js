/* =====================================================================
   FOODLINE · Лінії — спільне ядро (core.js)
   Схема таблиць, мітки, нормалізація рядків, MemoryStore, уся бізнес-логіка
   (createApp → handle), демо-дані (seedDemo), sha256.
   Працює БЕЗ ЗМІН у трьох середовищах:
     • браузер (<script src="assets/core.js">) → глобальна змінна LinesCore;
     • Node (require / vm) → module.exports;
     • Google Apps Script V8 (вставляється як файл Core.gs; усі .gs — одна глобальна область).
   Тому: лише ES2019, без DOM і Node API, без import/export, один глобальний var.
   ===================================================================== */
var LinesCore = (function () {
  'use strict';

  var VERSION = '1.0.0';
  var MIN = 60000, HOUR = 3600000, DAY = 86400000;
  var FUTURE_SLACK = 2 * MIN;            // допуск на розбіжність годинників клієнта
  var MAX_BACKDATE = 45 * DAY;           // найдавніший час події / чек-листа / показника з клієнта
  var MAX_BACKDATE_WORK = 366 * DAY;     // робота може вноситися «заднім числом» до року
  var ORDER_WINDOW = 45 * DAY;           // вікно пошуку опорної події для записів «із минулого»
  var ID_RE = /^[A-Za-z0-9_.:\-]{1,80}$/;

  /* ------------------------------ дрібні утиліти ------------------------------ */

  function has(o, k) { return o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k); }
  function isDate(v) { return Object.prototype.toString.call(v) === '[object Date]'; }
  function isBlank(v) { return v === undefined || v === null || (typeof v === 'string' && v.trim() === ''); }
  function copy(o) { var r = {}; for (var k in o) if (has(o, k)) r[k] = o[k]; return r; }
  function assign(t, s) { if (s) for (var k in s) if (has(s, k)) t[k] = s[k]; return t; }
  function round(n, d) {
    if (n === null || n === undefined || typeof n !== 'number' || !isFinite(n)) return n;
    var f = Math.pow(10, d === undefined || d === null ? 0 : d);
    var r = Math.round(n * f) / f;
    return r === 0 ? 0 : r;              // без -0
  }
  function r4(n) { return round(n, 4); }
  function r2(n) { return round(n, 2); }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(y, m, d) { return String(y) + '-' + pad2(m) + '-' + pad2(d); }
  function splitKey(k) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(k || ''));
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  function isKey(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()); }
  function keyAdd(k, n) {
    var p = splitKey(k);
    var t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  function keyDiff(a, b) {           // кількість днів від a до b
    var pa = splitKey(a), pb = splitKey(b);
    return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / DAY);
  }
  function keyDow(k) { var p = splitKey(k); return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); }
  function toMs(d) {
    if (isDate(d)) return d.getTime();
    if (typeof d === 'number') return d;
    var p = parseDate(d);
    return p ? p.getTime() : NaN;
  }
  function hoursBetween(a, b) { return (toMs(b) - toMs(a)) / HOUR; }
  function addDays(d, n) { return new Date(toMs(d) + n * DAY); }
  function txt(v, max) {
    var s = toStr(v);
    return max && s.length > max ? s.slice(0, max) : s;
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function uniq(arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) if (!has(seen, arr[i])) { seen[arr[i]] = 1; out.push(arr[i]); }
    return out;
  }
  function groupBy(rows, key) {
    var g = {};
    for (var i = 0; i < rows.length; i++) {
      var k = rows[i][key];
      (g[k] || (g[k] = [])).push(rows[i]);
    }
    return g;
  }
  /* число у форматі uk-UA: 12 345,5 (нерозривний пробіл між тисячами) */
  function fmtNum(n, dec) {
    if (n === null || n === undefined || typeof n !== 'number' || !isFinite(n)) return '—';
    dec = dec === undefined || dec === null ? 0 : dec;
    var s = Math.abs(n).toFixed(dec).split('.');
    var intp = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    var frac = s[1] ? s[1].replace(/0+$/, '') : '';
    var neg = n < 0 && (Number(s[0]) > 0 || /[1-9]/.test(frac));
    return (neg ? '-' : '') + intp + (frac ? ',' + frac : '');
  }
  function fmtHours(h) { return fmtNum(h, h < 10 ? 1 : 0) + ' год'; }
  function isEmail(s) { return /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/.test(String(s || '')); }
  function toEmails(v) {
    if (isBlank(v)) return [];
    var arr = Array.isArray(v) ? v : String(v).split(/[,;\s]+/);
    var out = [];
    for (var i = 0; i < arr.length; i++) { var s = toStr(arr[i]).toLowerCase(); if (s) out.push(s); }
    return uniq(out);
  }

  /* детермінований генератор псевдовипадкових чисел (для демо-даних) */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function rand36(n) {
    var s = '', i;
    var c = typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function' ? crypto : null;
    if (c) {
      var a = new Uint8Array(n);
      c.getRandomValues(a);
      for (i = 0; i < n; i++) s += (a[i] % 36).toString(36);
    } else {
      for (i = 0; i < n; i++) s += Math.floor(Math.random() * 36).toString(36);
    }
    return s;
  }
  /* 12 символів base36: 7 — час (секунди), 5 — випадкові; у межах секунди на цьому пристрої
     не повторюються (інакше записи однієї дії в черзі сервер прийняв би за повтор) */
  var uuidSec = '', uuidSeen = {};
  function uuid() {
    var t = Math.floor(Date.now() / 1000).toString(36), id;
    while (t.length < 7) t = '0' + t;
    t = t.slice(-7);
    if (t !== uuidSec) { uuidSec = t; uuidSeen = {}; }
    do { id = t + rand36(5); } while (uuidSeen[id] === 1);
    uuidSeen[id] = 1;
    return id;
  }

  /* глибока копія відповіді з перетворенням Date → ISO-рядок */
  function wire(o) {
    if (o === null || o === undefined) return o === undefined ? undefined : null;
    if (isDate(o)) return isNaN(o.getTime()) ? null : o.toISOString();
    if (Array.isArray(o)) {
      var a = new Array(o.length);
      for (var i = 0; i < o.length; i++) { var w = wire(o[i]); a[i] = w === undefined ? null : w; }
      return a;
    }
    if (typeof o === 'object') {
      var r = {};
      for (var k in o) {
        if (!has(o, k)) continue;
        var v = o[k];
        if (v === undefined || typeof v === 'function') continue;
        r[k] = wire(v);
      }
      return r;
    }
    if (typeof o === 'number' && !isFinite(o)) return null;
    return o;
  }

  /* ------------------------------ час і часові пояси ------------------------------ */

  var fmtCache = {};
  function hasIntl() {
    return typeof Intl !== 'undefined' && Intl && typeof Intl.DateTimeFormat === 'function' &&
      typeof Intl.DateTimeFormat.prototype.formatToParts === 'function';
  }
  function intlParts(d, tz) {
    var f = fmtCache[tz];
    if (!f) {
      f = fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    }
    var ps = f.formatToParts(d), o = {};
    for (var i = 0; i < ps.length; i++) o[ps[i].type] = ps[i].value;
    return { y: +o.year, m: +o.month, d: +o.day, H: (+o.hour) % 24, M: +o.minute, S: +o.second };
  }
  /* типова реалізація env.dayKey — через Intl (Server.gs підміняє на Utilities.formatDate) */
  function defDayKey(d, tz) {
    var dd = isDate(d) ? d : new Date(toMs(d));
    if (tz && hasIntl()) { var p = intlParts(dd, tz); return ymd(p.y, p.m, p.d); }
    return dd.toISOString().slice(0, 10);
  }
  function tzOffsetMs(ms, tz) {
    var p = intlParts(new Date(ms), tz);
    var whole = ms - (((ms % 1000) + 1000) % 1000);
    return Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S) - whole;
  }
  /* типова реалізація env.dayStart — локальна північ дня key у поясі tz (з урахуванням переходу на літній час) */
  function defDayStart(key, tz) {
    var k = splitKey(key);
    if (!k) return null;
    var guess = Date.UTC(k.y, k.m - 1, k.d);
    if (!tz || !hasIntl()) return new Date(guess);
    var off = tzOffsetMs(guess, tz), t = guess - off, off2 = tzOffsetMs(t, tz);
    if (off2 !== off) t = guess - off2;
    return new Date(t);
  }
  function defaultEnv() {
    return { now: function () { return new Date(); }, uuid: uuid, dayKey: defDayKey, dayStart: defDayStart, parts: null, custom: false };
  }
  function makeEnv(e) {
    e = e || {};
    var d = defaultEnv();
    var dk = typeof e.dayKey === 'function' ? e.dayKey : d.dayKey;
    var ds = typeof e.dayStart === 'function' ? e.dayStart : d.dayStart;
    return {
      now: typeof e.now === 'function' ? e.now : d.now,
      uuid: typeof e.uuid === 'function' ? e.uuid : d.uuid,
      dayKey: dk,
      dayStart: ds,
      parts: typeof e.parts === 'function' ? e.parts : null,
      // власні dayKey/dayStart (напр. Utilities у GAS) — тоді Intl не використовуємо взагалі
      custom: dk !== defDayKey || ds !== defDayStart
    };
  }
  /* часовий пояс: сам пояс → його застарілий/новий синонім (старі ICU не знають Europe/Kyiv) → null */
  var TZ_ALIAS = { 'Europe/Kyiv': 'Europe/Kiev', 'Europe/Kiev': 'Europe/Kyiv' };
  function tzWorks(env, tz) {
    if (!tz || typeof tz !== 'string') return false;
    try { return isKey(env.dayKey(new Date(), tz)); } catch (e) { return false; }
  }
  function resolveTz(env, tz) {
    if (tzWorks(env, tz)) return tz;
    var a = has(TZ_ALIAS, tz) ? TZ_ALIAS[tz] : null;
    return a && tzWorks(env, a) ? a : null;
  }
  /* робочий пояс заводу: заданий → типовий (або синонім) → UTC */
  function plantTz(env, tz) {
    return resolveTz(env, tz) || resolveTz(env, DEFAULT_SETTINGS.tz) || 'UTC';
  }
  /* набір функцій часу для конкретного поясу, побудований на env.dayKey/dayStart */
  function timeKit(env, tz) {
    env = env && env.dayKey && env.dayStart ? env : makeEnv(env);
    var custom = env.custom !== undefined ? !!env.custom : (env.dayKey !== defDayKey || env.dayStart !== defDayStart);
    var kit = { tz: tz };
    kit.key = function (d) { return env.dayKey(isDate(d) ? d : new Date(toMs(d)), tz); };
    kit.start = function (key) { var s = env.dayStart(key, tz); return isDate(s) ? s : new Date(toMs(s)); };
    kit.parts = function (d) {
      d = isDate(d) ? d : new Date(toMs(d));
      if (env.parts) return env.parts(d, tz);
      if (!custom && hasIntl()) { try { return intlParts(d, tz); } catch (e) { /* далі — запасний варіант */ } }
      // запасний варіант лише через dayKey/dayStart; перехід DST вважаємо о 01:00 UTC (як у Європі)
      var key = kit.key(d), p = splitKey(key);
      var M = kit.start(key).getTime(), M2 = kit.start(keyAdd(key, 1)).getTime();
      var ms = d.getTime() - M, len = M2 - M;
      if (len !== DAY && d.getTime() >= Date.UTC(p.y, p.m - 1, p.d, 1)) ms += DAY - len;
      var sec = Math.floor(ms / 1000);
      return { y: p.y, m: p.m, d: p.d, H: Math.floor(sec / 3600), M: Math.floor((sec % 3600) / 60), S: sec % 60 };
    };
    /* локальний час заводу → Date */
    kit.local = function (y, mo, d, h, mi, se) {
      var key = ymd(y, mo, d), base = kit.start(key);
      if (!base || isNaN(base.getTime())) return null;
      var want = ((h || 0) * 60 + (mi || 0)) * 60 + (se || 0);
      var t = base.getTime() + want * 1000;
      var p = kit.parts(new Date(t));
      var got = keyDiff(key, ymd(p.y, p.m, p.d)) * 86400 + (p.H * 60 + p.M) * 60 + p.S;
      if (got !== want) t += (want - got) * 1000;
      return new Date(t);
    };
    kit.fmtD = function (d) { if (!d) return ''; var p = kit.parts(d); return pad2(p.d) + '.' + pad2(p.m) + '.' + p.y; };
    kit.fmtHM = function (d) { if (!d) return ''; var p = kit.parts(d); return pad2(p.H) + ':' + pad2(p.M); };
    kit.fmtDT = function (d) { return d ? kit.fmtD(d) + ' ' + kit.fmtHM(d) : ''; };
    kit.fmtDM = function (d) { if (!d) return ''; var p = kit.parts(d); return pad2(p.d) + '.' + pad2(p.m); };
    return kit;
  }
  var DEF_KIT = null;
  function defaultKit() {
    if (!DEF_KIT) { var e = makeEnv(); DEF_KIT = timeKit(e, plantTz(e, 'Europe/Kyiv')); }
    return DEF_KIT;
  }

  /* ------------------------------ мітки (LABELS) ------------------------------ */

  var LABELS = {
    state: { off: 'Не працює', run: 'Працює', setup: 'Налаштування', stop: 'Простій', repair: 'Ремонт', maint: 'ТО / ППР', clean: 'Миття' },
    occasion: { start: 'Запуск', changeover: 'Переналаштування', end: 'Завершення' },
    work_type: {
      setup: 'Налаштування', changeover: 'Переналаштування', repair: 'Ремонт', to: 'ТО', ppr: 'ППР',
      replace: 'Заміна деталі', lube: 'Змащування', clean: 'Миття / санобробка', calib: 'Калібрування',
      inspect: 'Огляд / діагностика', other: 'Інше'
    },
    item_type: { check: 'Відмітка', number: 'Число', text: 'Текст', select: 'Вибір' },
    role: { operator: 'Оператор', setter: 'Наладчик', mechanic: 'Механік', electrician: 'Електрик', qa: 'Контроль якості', manager: 'Керівник' },
    meter_mode: { abs: 'Накопичувальний показник', inc: 'Приріст за зміну' },
    check_result: { ok: 'Норма', remarks: 'Із зауваженнями', fail: 'Не пройдено' },
    work_status: { done: 'Виконано', open: 'Відкрито' },
    flag: { no_checklist: 'Запуск без чек-листа', no_end_checklist: 'Завершення без чек-листа', forced: 'Запуск попри зауваження' },
    due_status: { ok: 'У нормі', soon: 'Скоро', due: 'Потрібно виконати', none: 'Без інтервалу' },
    notice_kind: { digest: 'Щоденний звіт', due: 'Настав строк ТО', checklist: 'Зауваження в чек-листі', repair: 'Ремонт / аварійна зупинка', test: 'Тест' },
    // допоміжні набори (не зберігаються в таблицях як enum)
    day_status: { miss: 'Запуск без чек-листа', warn: 'Із зауваженнями', ok: 'Перевірки виконано', cont: 'Робота без запуску', idle: 'Не працювала' },
    check_value: { ok: 'Норма', fail: 'Зауваження', na: 'Н/З' },
    criterion: { days: 'Календар', hours: 'Мотогодини', meter: 'Лічильник' }
  };

  var REV = {};
  function enumKey(s) { return String(s).trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/'); }
  (function buildRev() {
    for (var set in LABELS) {
      var m = {};
      for (var code in LABELS[set]) { m[enumKey(code)] = code; m[enumKey(LABELS[set][code])] = code; }
      REV[set] = m;
    }
  })();
  function toEnum(set, v, free) {
    if (isBlank(v)) return '';
    var m = REV[set], code = m ? m[enumKey(v)] : '';
    if (code) return code;
    return free ? toStr(v) : '';
  }
  function toEnums(set, v) {
    if (isBlank(v)) return [];
    var arr = Array.isArray(v) ? v : String(v).split(/[,;]/), out = [];
    for (var i = 0; i < arr.length; i++) { var c = toEnum(set, arr[i]); if (c) out.push(c); }
    return uniq(out);
  }
  function label(set, code) {
    if (Array.isArray(code)) { var a = []; for (var i = 0; i < code.length; i++) a.push(label(set, code[i])); return a.join(', '); }
    var s = LABELS[set];
    if (code === null || code === undefined) return '';
    return (s && has(s, code) && s[code]) || String(code);
  }

  /* ------------------------------ перетворення значень ------------------------------ */

  function toStr(v) {
    if (v === null || v === undefined) return '';
    if (isDate(v)) return isNaN(v.getTime()) ? '' : v.toISOString();
    return String(v).trim();
  }
  function toNum(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (isDate(v) || typeof v === 'object') return null;
    var s = String(v).replace(/[\s  ']/g, '').replace(/−/g, '-').replace(',', '.');
    if (!s || !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }
  var TRUE_WORDS = { 'true': 1, 'так': 1, '1': 1, 'x': 1, 'х': 1, '✓': 1, '✔': 1, 'yes': 1, 'y': 1, '+': 1 };
  function toBool(v) {
    if (v === true) return true;
    if (typeof v === 'number') return v === 1;
    if (v === null || v === undefined || v === false) return false;
    return has(TRUE_WORDS, String(v).trim().toLowerCase());
  }
  function toList(v) {
    if (v === null || v === undefined) return [];
    var arr = Array.isArray(v) ? v : String(v).split(';'), out = [];
    for (var i = 0; i < arr.length; i++) { var s = toStr(arr[i]); if (s) out.push(s); }
    return out;
  }
  function toIds(v) {
    if (v === null || v === undefined) return [];
    var arr = Array.isArray(v) ? v : String(v).split(/[,;\s]+/), out = [];
    for (var i = 0; i < arr.length; i++) { var s = toStr(arr[i]); if (s) out.push(s); }
    return uniq(out);
  }
  /* Date | ISO | 'DD.MM.YYYY[ HH:mm[:ss]]' | 'YYYY-MM-DD[ HH:mm]' (локальний час заводу) → Date | null */
  function parseDate(v, kit) {
    if (v === null || v === undefined || v === '') return null;
    if (isDate(v)) return isNaN(v.getTime()) ? null : new Date(v.getTime());
    if (typeof v === 'number') return isFinite(v) ? new Date(v) : null;
    if (typeof v !== 'string') return null;
    var s = v.trim();
    if (!s) return null;
    var m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[,\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (m) return localDate(kit, +m[3], +m[2], +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    m = /^(\d{4})-(\d{2})-(\d{2})(?:[\sT](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(s);
    if (m) return localDate(kit, +m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    var t = Date.parse(s);
    return isNaN(t) ? null : new Date(t);
  }
  function localDate(kit, y, mo, d, h, mi, se) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
    var chk = new Date(Date.UTC(y, mo - 1, d));
    if (chk.getUTCDate() !== d || chk.getUTCMonth() !== mo - 1) return null;
    return (kit || defaultKit()).local(y, mo, d, h, mi, se);
  }

  /* ------------------------------ схема таблиць ------------------------------ */

  function col(k, t, type, o) {
    type = type || 'str';
    var c = { k: k, t: t, type: type }, i = type.indexOf(':');
    c.base = i > 0 ? type.slice(0, i) : type;
    if (i > 0) c.set = type.slice(i + 1);
    if (o) for (var x in o) if (has(o, x)) c[x] = o[x];
    return c;
  }
  var SRV = { service: true };
  function logTail() {
    return [col('device', 'Пристрій'), col('created', 'Записано', 'date'),
      col('void', 'Анульовано', 'bool'), col('void_note', 'Причина анулювання')];
  }

  var SCHEMA = {
    settings: { sheet: 'Налаштування', pk: 'key', kind: 'config', cols: [
      col('key', 'Параметр', 'id'), col('value', 'Значення'), col('note', 'Опис')] },
    lines: { sheet: 'Лінії', pk: 'id', kind: 'config', cols: [
      col('id', 'ID', 'id'), col('name', 'Назва'), col('kind', 'Тип'), col('area', 'Дільниця'),
      col('description', 'Опис'), col('sort', 'Порядок', 'num'), col('active', 'Активна', 'bool', { def: true }),
      col('created', 'Створено', 'date'),
      col('cur_state', 'Поточний стан', 'enum:state', SRV), col('cur_since', 'Стан з', 'date', SRV),
      col('cur_product', 'Поточний продукт', 'str', SRV), col('cur_operator', 'Поточний оператор', 'str', SRV),
      col('cur_event', 'ID останньої події', 'id', SRV), col('cur_cum_h', 'Мотогодини на момент події', 'num', SRV),
      col('cur_starts', 'Запусків усього', 'num', SRV)] },
    units: { sheet: 'Агрегати', pk: 'id', kind: 'config', cols: [
      col('id', 'ID', 'id'), col('line_id', 'ID лінії', 'id'), col('name', 'Назва'), col('kind', 'Тип'),
      col('model', 'Модель'), col('serial', 'Серійний номер'), col('maker', 'Виробник'),
      col('year', 'Рік випуску', 'num'), col('installed', 'Введено в експлуатацію', 'date'),
      col('hours_offset', 'Мотогодини до початку обліку', 'num'),
      col('base_cum', 'Мотогодини лінії при додаванні', 'num', SRV),
      col('notes', 'Примітки'), col('sort', 'Порядок', 'num'), col('active', 'Активний', 'bool', { def: true }),
      col('created', 'Створено', 'date')] },
    items: { sheet: 'Чек-листи і параметри', pk: 'id', kind: 'config', cols: [
      col('id', 'ID', 'id'), col('line_id', 'ID лінії', 'id'), col('unit_id', 'ID агрегату', 'id'),
      col('occasions', 'Коли', 'enums:occasion'), col('section', 'Розділ'), col('text', 'Пункт / параметр'),
      col('type', 'Тип', 'enum:item_type', { def: 'check' }), col('unit_label', 'Од. виміру'),
      col('min', 'Мін', 'num'), col('max', 'Макс', 'num'), col('target', 'Норма', 'num'),
      col('options', 'Варіанти', 'list'), col('required', 'Обовʼязковий', 'bool', { def: true }),
      col('critical', 'Критичний', 'bool'), col('hint', 'Підказка'), col('sort', 'Порядок', 'num'),
      col('active', 'Активний', 'bool', { def: true })] },
    meters: { sheet: 'Лічильники', pk: 'id', kind: 'config', cols: [
      col('id', 'ID', 'id'), col('line_id', 'ID лінії', 'id'), col('unit_id', 'ID агрегату', 'id'),
      col('name', 'Назва'), col('unit_label', 'Од. виміру'), col('mode', 'Тип обліку', 'enum:meter_mode', { def: 'abs' }),
      col('ask_on_end', 'Питати при завершенні роботи', 'bool'), col('sort', 'Порядок', 'num'),
      col('active', 'Активний', 'bool', { def: true }),
      col('cur_value', 'Поточне значення', 'num', SRV), col('cur_ts', 'Оновлено', 'date', SRV)] },
    rules: { sheet: 'Регламент ТО і ППР', pk: 'id', kind: 'config', cols: [
      col('id', 'ID', 'id'), col('line_id', 'ID лінії', 'id'), col('unit_id', 'ID агрегату', 'id'),
      col('title', 'Робота'), col('work_type', 'Вид', 'enum:work_type', { def: 'to' }), col('part', 'Деталь / вузол'),
      col('interval_days', 'Інтервал, днів', 'num'), col('interval_hours', 'Інтервал, мотогодин', 'num'),
      col('meter_id', 'ID лічильника', 'id'), col('interval_meter', 'Інтервал за лічильником', 'num'),
      col('warn_days', 'Попереджати за, днів', 'num'), col('warn_pct', 'Попереджати з, %', 'num'),
      col('notify', 'Email для сповіщень'), col('instructions', 'Інструкція'),
      col('base_date', 'Відлік від дати', 'date'), col('base_hours', 'Відлік мотогодин лінії', 'num'),
      col('base_meter', 'Відлік лічильника', 'num'),
      col('last_date', 'Останнє виконання', 'date', SRV), col('last_hours', 'Мотогодини при виконанні', 'num', SRV),
      col('last_meter', 'Лічильник при виконанні', 'num', SRV), col('last_work_id', 'ID останньої роботи', 'id', SRV),
      col('sort', 'Порядок', 'num'), col('active', 'Активний', 'bool', { def: true }), col('created', 'Створено', 'date')] },
    staff: { sheet: 'Персонал', pk: 'id', kind: 'config', cols: [
      col('id', 'ID', 'id'), col('name', 'ПІБ'), col('role', 'Посада', 'enum:role', { def: 'operator' }),
      col('line_ids', 'Лінії', 'ids'), col('email', 'Email'), col('pin', 'PIN', 'str', { secret: true, pin: true }),
      col('sort', 'Порядок', 'num'), col('active', 'Активний', 'bool', { def: true })] },
    events: { sheet: 'Журнал стану', pk: 'id', kind: 'log', cols: [
      col('id', 'ID', 'id'), col('ts', 'Час', 'date'), col('line_id', 'ID лінії', 'id'), col('state', 'Стан', 'enum:state'),
      col('reason', 'Причина'), col('product', 'Продукт / формат'), col('operator', 'Оператор'),
      col('staff_id', 'ID працівника', 'id'), col('note', 'Примітка'), col('ref_id', 'Повʼязаний запис', 'id'),
      col('prev_state', 'Попередній стан', 'enum:state'), col('cum_h', 'Мотогодини лінії', 'num'),
      col('starts', 'Запусків', 'num'), col('flag', 'Позначка', 'enum:flag')].concat(logTail()) },
    checks: { sheet: 'Чек-листи', pk: 'id', kind: 'log', cols: [
      col('id', 'ID', 'id'), col('ts', 'Завершено', 'date'), col('started', 'Розпочато', 'date'),
      col('line_id', 'ID лінії', 'id'), col('occasion', 'Коли', 'enum:occasion'), col('operator', 'Оператор'),
      col('staff_id', 'ID працівника', 'id'), col('product', 'Продукт / формат'),
      col('result', 'Результат', 'enum:check_result'), col('total', 'Пунктів', 'num'), col('failed', 'Зауважень', 'num'),
      col('out_of_range', 'Поза нормою', 'num'), col('missing', 'Не заповнено', 'num'), col('na', 'Н/З', 'num'),
      col('comment', 'Коментар')].concat(logTail()) },
    answers: { sheet: 'Чек-листи — відповіді', pk: 'id', kind: 'log', cols: [
      col('id', 'ID', 'id'), col('check_id', 'ID чек-листа', 'id'), col('ts', 'Час', 'date'),
      col('line_id', 'ID лінії', 'id'), col('unit_id', 'ID агрегату', 'id'), col('item_id', 'ID пункту', 'id'),
      col('section', 'Розділ'), col('text', 'Пункт / параметр'), col('type', 'Тип', 'enum:item_type'),
      col('value', 'Значення'), col('num_value', 'Числове значення', 'num'), col('unit_label', 'Од. виміру'),
      col('min', 'Мін', 'num'), col('max', 'Макс', 'num'), col('ok', 'В нормі', 'bool', { nullable: true }),
      col('note', 'Примітка'), col('void', 'Анульовано', 'bool')] },
    works: { sheet: 'Журнал робіт', pk: 'id', kind: 'log', cols: [
      col('id', 'ID', 'id'), col('ts', 'Завершено', 'date'), col('started', 'Розпочато', 'date'),
      col('line_id', 'ID лінії', 'id'), col('unit_id', 'ID агрегату', 'id'), col('work_type', 'Вид', 'enum:work_type'),
      col('rule_id', 'ID регламенту', 'id'), col('title', 'Що зроблено'), col('description', 'Опис'),
      col('cause', 'Причина / несправність'), col('parts', 'Замінені деталі'), col('params', 'Параметри налаштування'),
      col('product', 'Продукт / формат'), col('performer', 'Виконавець'), col('staff_id', 'ID працівника', 'id'),
      col('duration_min', 'Тривалість, хв', 'num'), col('downtime_min', 'Простій, хв', 'num'),
      col('hours_at', 'Мотогодини лінії', 'num'), col('meter_at', 'Лічильник', 'num'),
      col('status', 'Статус', 'enum:work_status', { def: 'done' })].concat(logTail()) },
    readings: { sheet: 'Показники лічильників', pk: 'id', kind: 'log', cols: [
      col('id', 'ID', 'id'), col('ts', 'Час', 'date'), col('meter_id', 'ID лічильника', 'id'),
      col('line_id', 'ID лінії', 'id'), col('unit_id', 'ID агрегату', 'id'), col('value', 'Значення', 'num'),
      col('mode', 'Тип обліку', 'enum:meter_mode'), col('operator', 'Оператор'), col('event_id', 'ID події', 'id'),
      col('note', 'Примітка')].concat(logTail()) },
    notices: { sheet: 'Сповіщення', pk: 'id', kind: 'system', cols: [
      col('id', 'ID', 'id'), col('ts', 'Час', 'date'), col('kind', 'Тип', 'enum:notice_kind'), col('key', 'Ключ'),
      col('to', 'Кому'), col('subject', 'Тема'), col('status', 'Статус'), col('error', 'Помилка')] },
    plan: { sheet: 'План ППР', pk: null, kind: 'system', cols: [
      col('date', 'Дата', 'date'), col('line', 'Лінія'), col('unit', 'Агрегат'), col('title', 'Робота'),
      col('work_type', 'Вид', 'enum:work_type'), col('basis', 'Підстава'), col('status', 'Статус', 'enum:due_status'),
      col('rule_id', 'ID регламенту', 'id'), col('generated', 'Сформовано', 'date')] }
  };
  var TABLES = ['settings', 'lines', 'units', 'items', 'meters', 'rules', 'staff',
    'events', 'checks', 'answers', 'works', 'readings', 'notices', 'plan'];
  var LOG_TABLES = ['events', 'checks', 'answers', 'works', 'readings'];
  var EDITABLE = { lines: 1, units: 1, items: 1, meters: 1, rules: 1, staff: 1 };
  var COLS = {};
  (function () {
    for (var t in SCHEMA) {
      var m = {};
      SCHEMA[t].cols.forEach(function (c) { m[c.k] = c; });
      COLS[t] = m;
    }
  })();

  /* ------------------------------ налаштування ------------------------------ */

  var SETTINGS_META = [
    { key: 'company', type: 'str', def: 'Foodline Production', note: 'Назва підприємства (у звітах і листах)' },
    { key: 'tz', type: 'tz', def: 'Europe/Kyiv', note: 'Часовий пояс підприємства (IANA, напр. Europe/Kyiv)' },
    { key: 'manager_emails', type: 'emails', def: [], admin: true, note: 'Email керівництва для звітів і сповіщень (через кому)' },
    { key: 'digest_hour', type: 'num', def: 7, min: 0, max: 23, int: true, note: 'Година надсилання щоденного звіту (0–23)' },
    { key: 'digest_mode', type: 'choice', def: 'if_any', values: ['always', 'if_any'], note: 'always — щодня; if_any — лише коли є що повідомити' },
    { key: 'instant_due', type: 'bool', def: true, note: 'Одразу надсилати лист, коли настав строк ТО / ППР' },
    { key: 'instant_checklist', type: 'bool', def: true, note: 'Одразу надсилати лист про зауваження в чек-листі' },
    { key: 'instant_repair', type: 'bool', def: true, note: 'Одразу надсилати лист про ремонт / аварійну зупинку' },
    { key: 'warn_days', type: 'num', def: 7, min: 0, max: 365, note: 'Попереджати про ТО за стільки днів' },
    { key: 'warn_pct', type: 'num', def: 90, min: 1, max: 100, pct: true, note: 'Попереджати про ТО з такого % інтервалу' },
    { key: 'checklist_valid_hours', type: 'num', def: 12, min: 1, max: 72, note: 'Скільки годин чинний чек-лист запуску (після завершення роботи лінії потрібен новий)' },
    { key: 'require_start_checklist', type: 'bool', def: true, note: 'Вимагати чек-лист перед запуском лінії' },
    { key: 'require_end_checklist', type: 'bool', def: true, note: 'Вимагати чек-лист при завершенні роботи' },
    { key: 'avg_window_days', type: 'num', def: 28, min: 1, max: 365, int: true, note: 'За скільки днів рахувати середнє напрацювання' },
    { key: 'plan_horizon_days', type: 'num', def: 365, min: 7, max: 1100, int: true, note: 'Горизонт плану ППР, днів' },
    { key: 'long_run_hours', type: 'num', def: 16, min: 1, max: 72, note: 'Попереджати, якщо лінія працює без завершення довше, год' },
    { key: 'refresh_sec', type: 'num', def: 90, min: 15, max: 3600, int: true, note: 'Як часто планшети оновлюють дані, с' },
    { key: 'stop_reasons', type: 'list', def: ['Немає сировини / тари', 'Очікування', 'Перерва', 'Мікрозупинка / застрягання', 'Налагодження', 'Інше'], note: 'Причини простою (через крапку з комою)' },
    { key: 'products', type: 'list', def: [], note: 'Продукти / формати для підказок (через крапку з комою)' },
    { key: 'app_url', type: 'str', def: '', note: 'Адреса застосунку (для посилань у листах)' },
    { key: 'sheet_url', type: 'str', def: '', admin: true, service: true, note: 'Посилання на таблицю (заповнюється автоматично)' }
  ];
  var META_BY_KEY = {};
  var DEFAULT_SETTINGS = {};
  SETTINGS_META.forEach(function (m) {
    META_BY_KEY[m.key] = m;
    DEFAULT_SETTINGS[m.key] = Array.isArray(m.def) ? m.def.slice() : m.def;
  });
  function cloneVal(v) { return Array.isArray(v) ? v.slice() : v; }
  /* відсоток: Google-таблиця зберігає введене «90%» як 0,9 → 90 */
  function pctVal(v) { return typeof v === 'number' && v > 0 && v <= 1 ? round(v * 100, 6) : v; }
  function toPct(v) {
    if (typeof v === 'string' && /%\s*$/.test(v)) return toNum(v.replace(/%\s*$/, ''));
    var n = toNum(v);
    return n === null ? null : pctVal(n);
  }
  /* значення з клітинки таблиці → типізоване значення (невалідне → типове) */
  function coerceSetting(meta, v) {
    if (isBlank(v)) return cloneVal(meta.def);
    switch (meta.type) {
      case 'num': {
        var n = meta.pct ? toPct(v) : toNum(v);
        if (n === null) return meta.def;
        if (meta.int) n = Math.round(n);
        return clamp(n, meta.min, meta.max);
      }
      case 'bool': return toBool(v);
      case 'choice': { var s = toStr(v).toLowerCase(); return meta.values.indexOf(s) >= 0 ? s : meta.def; }
      case 'list': return toList(v);
      case 'emails': return toEmails(v).filter(isEmail);
      default: return toStr(v);
    }
  }
  /* типізоване значення → текст для клітинки */
  function settingCell(meta, v) {
    switch (meta.type) {
      case 'list': return toList(v).join('; ');
      case 'emails': return toEmails(v).join(', ');
      case 'bool': return v ? 'так' : 'ні';
      case 'num': return v === null || v === undefined ? '' : String(v);
      default: return toStr(v);
    }
  }

  /* ------------------------------ нормалізація рядків ------------------------------ */

  function normVal(c, v, kit) {
    if (isBlank(v) && c.def !== undefined) return cloneVal(c.def);
    switch (c.base) {
      // PIN: апостроф, яким у таблиці зберігають провідні нулі («'0427»), — не частина PIN
      case 'id': case 'str': return c.pin ? toStr(v).replace(/^'\s*/, '') : toStr(v);
      case 'num': return toNum(v);
      case 'bool':
        if (c.nullable && isBlank(v)) return null;
        return toBool(v);
      case 'date': return parseDate(v, kit);
      case 'enum': return toEnum(c.set, v, c.free);
      case 'enums': return toEnums(c.set, v);
      case 'list': return toList(v);
      case 'ids': return toIds(v);
      default: return toStr(v);
    }
  }
  function denormVal(c, v) {
    switch (c.base) {
      case 'id': case 'str': return v === null || v === undefined ? '' : (isDate(v) ? toStr(v) : String(v));
      case 'num': { var n = toNum(v); return n === null ? '' : n; }
      case 'bool':
        if (c.nullable && (v === null || v === undefined || v === '')) return '';
        return typeof v === 'boolean' ? v : toBool(v);
      case 'date': {
        if (isDate(v)) return isNaN(v.getTime()) ? '' : v;
        var d = parseDate(v);
        return d || '';
      }
      case 'enum': {
        var code = toEnum(c.set, v, c.free);
        if (!code) return '';
        return (LABELS[c.set] && LABELS[c.set][code]) || code;
      }
      case 'enums': return toEnums(c.set, v).map(function (x) { return LABELS[c.set][x]; }).join(', ');
      case 'list': return toList(v).join('; ');
      case 'ids': return toIds(v).join(', ');
      default: return v === null || v === undefined ? '' : v;
    }
  }
  /* сирий рядок сховища (ключі — k або заголовки t) → типізований об'єкт */
  function norm(table, raw, kit) {
    var s = SCHEMA[table];
    if (!s) throw new Error('Невідома таблиця: ' + table);
    raw = raw || {};
    var out = {};
    for (var i = 0; i < s.cols.length; i++) {
      var c = s.cols[i], v = raw[c.k];
      if (v === undefined && raw[c.t] !== undefined) v = raw[c.t];
      out[c.k] = normVal(c, v, kit);
    }
    return out;
  }
  /* типізований об'єкт → рядок для сховища (лише присутні ключі) */
  function denorm(table, obj) {
    var s = SCHEMA[table];
    if (!s) throw new Error('Невідома таблиця: ' + table);
    var out = {};
    for (var i = 0; i < s.cols.length; i++) {
      var c = s.cols[i];
      if (!has(obj, c.k)) continue;
      out[c.k] = denormVal(c, obj[c.k]);
    }
    return out;
  }
  function blank(table) { return norm(table, {}); }

  /* ------------------------------ MemoryStore ------------------------------ */

  function MemoryStore(initial) {
    if (!(this instanceof MemoryStore)) return new MemoryStore(initial);
    this.data = {};
    for (var i = 0; i < TABLES.length; i++) this.data[TABLES[i]] = [];
    var src = initial && initial.data && typeof initial.data === 'object' ? initial.data : initial;
    if (src && typeof src === 'object') {
      for (var t in src) if (has(src, t) && Array.isArray(src[t])) this.data[t] = src[t].map(copy);
    }
  }
  MemoryStore.prototype._rows = function (t) { return this.data[t] || (this.data[t] = []); };
  MemoryStore.prototype.all = function (t) { return this._rows(t).slice(); };
  MemoryStore.prototype.since = function (t, date) {
    var b = toMs(date), rows = this._rows(t), out = [];
    for (var i = 0; i < rows.length; i++) {
      var d = parseDate(rows[i].ts);
      if (!d || isNaN(b) || d.getTime() >= b) out.push(rows[i]);
    }
    return out;
  };
  MemoryStore.prototype.insert = function (t, rows) {
    var arr = this._rows(t);
    for (var i = 0; i < (rows || []).length; i++) arr.push(copy(rows[i]));
    return (rows || []).length;
  };
  MemoryStore.prototype.update = function (t, patches) {
    var pk = (SCHEMA[t] && SCHEMA[t].pk) || 'id', arr = this._rows(t), idx = {}, n = 0;
    // за дублікатів ключа оновлюється перший рядок (так само ядро читає довідники)
    for (var i = 0; i < arr.length; i++) { var key = String(arr[i][pk]); if (!has(idx, key)) idx[key] = i; }
    for (var j = 0; j < (patches || []).length; j++) {
      var p = patches[j], at = idx[String(p[pk])];
      if (at === undefined) continue;
      var row = arr[at];
      for (var k in p) if (has(p, k)) row[k] = p[k];
      n++;
    }
    return n;
  };
  /* необовʼязковий метод сховища: сирі рядки, де стовпець col дорівнює value (можна й із зайвими — ядро фільтрує).
     Сховище без нього (або що повертає null) ядро обходить читанням вікна / усього журналу */
  MemoryStore.prototype.findBy = function (t, col, value) {
    var c = COLS[t] && COLS[t][col], v = toStr(value), rows = this._rows(t), out = [];
    for (var i = 0; i < rows.length; i++) {
      var x = rows[i][col];
      if (x === undefined && c) x = rows[i][c.t];
      if (toStr(x) === v) out.push(rows[i]);
    }
    return out;
  };
  MemoryStore.prototype.replace = function (t, rows) { this.data[t] = (rows || []).map(copy); return this.data[t].length; };
  MemoryStore.prototype.lock = function (fn) { return fn(); };
  MemoryStore.prototype.toJSON = function () { return this.data; };

  /* ------------------------------ SHA-256 (чистий JS) ------------------------------ */

  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00); i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function sha256(msg) {
    var bytes = utf8Bytes(String(msg === null || msg === undefined ? '' : msg));
    var len = bytes.length, hi = Math.floor(len * 8 / 4294967296), lo = (len * 8) >>> 0, i;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
      (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var W = new Array(64);
    for (var off = 0; off < bytes.length; off += 64) {
      for (i = 0; i < 16; i++) {
        W[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
      }
      for (i = 16; i < 64; i++) {
        var x = W[i - 15], y = W[i - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K256[i] + W[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var hex = '';
    for (i = 0; i < 8; i++) { var s = (H[i] >>> 0).toString(16); while (s.length < 8) s = '0' + s; hex += s; }
    return hex;
  }
  var PIN_RE = /^\d{4,8}$/;
  function pinHash(id, pin) { return pin ? sha256(String(id) + ':' + String(pin)) : null; }

  /* ------------------------------ помилки ------------------------------ */

  var ERR_MSG = {
    BAD_TOKEN: 'Невірний токен доступу',
    ADMIN_REQUIRED: 'Потрібен PIN керівника',
    BAD_REQUEST: 'Некоректний запит',
    NOT_FOUND: 'Запис не знайдено',
    UNKNOWN_ACTION: 'Невідома дія',
    LOCKED: 'Сервер зайнятий іншим записом, спробуйте ще раз',
    SERVER_ERROR: 'Помилка сервера',
    RATE_LIMIT: 'Забагато спроб, зачекайте кілька хвилин'
  };
  function AppError(code, message) {
    var e = new Error(message || ERR_MSG[code] || code);
    e.code = code;
    e.isAppError = true;
    return e;
  }
  function bad(msg) { return AppError('BAD_REQUEST', msg); }
  function notFound(msg) { return AppError('NOT_FOUND', msg); }
  function errorResponse(e) {
    if (e && e.isAppError) return { ok: false, error: e.code, message: e.message };
    if (e && (e.code === 'LOCKED' || /lock/i.test(String(e.message || '')) && /timeout|timed out|тайм/i.test(String(e.message || '')))) {
      return { ok: false, error: 'LOCKED', message: ERR_MSG.LOCKED };
    }
    return { ok: false, error: 'SERVER_ERROR', message: ERR_MSG.SERVER_ERROR + ': ' + String((e && e.message) || e) };
  }

  /* дії API: write — змінює дані (хост бере store.lock); admin — потрібен PIN керівника */
  var ACTIONS = {
    ping: {}, bootstrap: {}, line: {}, check_detail: {}, history: {}, dashboard: {}, plan: {},
    event: { write: true }, checklist: { write: true }, work: { write: true }, reading: { write: true }, batch: { write: true },
    admin_check: { admin: true }, save: { admin: true, write: true }, remove: { admin: true, write: true },
    'void': { admin: true, write: true }, settings_save: { admin: true, write: true },
    digest_preview: { admin: true }, notices: { admin: true }, recompute: { admin: true, write: true }
  };

  /* =====================================================================
     createApp(store, env) — уся бізнес-логіка + маршрутизатор дій API
     Прямі методи повертають Date-об'єкти та кидають AppError;
     app.handle() ніколи не кидає і повертає JSON-сумісну відповідь (wire).
     ===================================================================== */
  function createApp(store, envIn) {
    if (!store) throw new Error('LinesCore.createApp: потрібне сховище (store)');
    var env = makeEnv(envIn);
    var cache = {}, depth = 0;
    var readOnly = false;          // true під час READ-дій handle(): тоді ядро нічого не пише в сховище

    /* кеш живе протягом одного публічного виклику (скидається на вході) */
    function entry(fn) {
      return function () {
        if (depth === 0) cache = {};
        depth++;
        try { return fn.apply(null, arguments); } finally { depth--; }
      };
    }
    function nowD() { var n = env.now(); return isDate(n) ? new Date(n.getTime()) : new Date(toMs(n)); }
    function asDate(v) { return isBlank(v) ? null : parseDate(v, kit()); }

    /* ---------- налаштування ---------- */
    function readSettings() {
      var S = {}, k, seen = {};
      for (k in DEFAULT_SETTINGS) S[k] = cloneVal(DEFAULT_SETTINGS[k]);
      var rows = store.all('settings') || [];
      for (var i = 0; i < rows.length; i++) {
        var r = norm('settings', rows[i]);
        if (!r.key || has(seen, r.key)) continue;     // дублікат ключа — діє перший рядок
        seen[r.key] = 1;
        if (META_BY_KEY[r.key]) S[r.key] = coerceSetting(META_BY_KEY[r.key], r.value);
        else S[r.key] = r.value;
      }
      // невідомий пояс → типовий; якщо рушій не знає і його (старий ICU) — синонім або UTC
      S.tz = plantTz(env, S.tz);
      return S;
    }
    function settings() { return cache.S || (cache.S = readSettings()); }
    function kit() { return cache.K || (cache.K = timeKit(env, settings().tz)); }
    function publicSettings(admin) {
      var S = settings(), o = {};
      for (var k in S) {
        if (!has(S, k)) continue;
        if (!admin && META_BY_KEY[k] && META_BY_KEY[k].admin) continue;
        o[k] = cloneVal(S[k]);
      }
      return o;
    }

    /* ---------- доступ до сховища ---------- */
    function rawBlank(r) {
      for (var x in r) if (has(r, x) && !isBlank(r[x]) && !(isDate(r[x]) && isNaN(r[x].getTime()))) return false;
      return true;
    }
    /* довідник: рядки без ID (порожні чи додані в таблиці без ID) і повтори ID пропускаються
       (діє перший рядок) — про них повідомляємо керівника (config_issues у bootstrap) */
    function tbl(t) {
      var c = cache.cfg || (cache.cfg = {});
      if (!c[t]) {
        var k = kit(), sc = SCHEMA[t], byId = sc.kind === 'config' && sc.pk === 'id', seen = {}, out = [], issues = [];
        (store.all(t) || []).forEach(function (r) {
          var n = norm(t, r, k);
          if (byId) {
            if (!n.id) { if (!rawBlank(r)) issues.push({ table: t, sheet: sc.sheet, id: '', name: n.name || n.title || n.text || '', problem: 'no_id' }); return; }
            if (has(seen, n.id)) { issues.push({ table: t, sheet: sc.sheet, id: n.id, name: n.name || n.title || n.text || '', problem: 'duplicate' }); return; }
            seen[n.id] = 1;
          }
          // PIN не з 4–8 цифр (напр. 427 — клітинка втратила текстовий формат і провідний нуль): увійти з ним не вийде
          if (t === 'staff' && n.pin && !PIN_RE.test(n.pin)) issues.push({ table: t, sheet: sc.sheet, id: n.id, name: n.name, problem: 'bad_pin' });
          out.push(n);
        });
        c[t] = out;
        (cache.issues || (cache.issues = {}))[t] = issues;
      }
      return c[t];
    }
    function configIssues() {
      var out = [];
      Object.keys(EDITABLE).forEach(function (t) { tbl(t); out = out.concat((cache.issues && cache.issues[t]) || []); });
      return out;
    }
    function find(t, id) {
      if (isBlank(id)) return null;
      id = toStr(id);
      var rs = tbl(t);
      for (var i = 0; i < rs.length; i++) if (rs[i].id === id) return rs[i];
      return null;
    }
    function logSince(t, from) {
      var k = kit(), b = toMs(from), raw = store.since(t, new Date(b)) || [], out = [];
      for (var i = 0; i < raw.length; i++) {
        var r = norm(t, raw[i], k);
        if (r.ts && r.ts.getTime() >= b) out.push(r);
      }
      return out;
    }
    function logAll(t) {
      var k = kit();
      return (store.all(t) || []).map(function (r) { return norm(t, r, k); }).filter(function (r) { return !!r.ts; });
    }
    function touched(t) {
      cache.dc = null;
      if (t === 'settings') { cache.S = null; cache.K = null; }
    }
    function insertRows(t, objs) {
      if (!objs || !objs.length) return;
      store.insert(t, objs.map(function (o) { return denorm(t, o); }));
      if (cache.cfg) delete cache.cfg[t];
      touched(t);
    }
    function patchRows(t, patches) {
      if (!patches || !patches.length) return;
      store.update(t, patches.map(function (p) { return denorm(t, p); }));
      patchCached(t, patches);
    }
    /* зміни лише в кеші довідника (без запису в сховище) */
    function patchCached(t, patches) {
      var c = cache.cfg && cache.cfg[t];
      if (c) {
        var pk = SCHEMA[t].pk, idx = {};
        for (var i = 0; i < c.length; i++) idx[c[i][pk]] = i;
        patches.forEach(function (p) {
          var at = idx[p[pk]];
          if (at === undefined) return;
          var n = norm(t, denorm(t, p), kit());
          for (var k in p) if (has(p, k) && has(n, k)) c[at][k] = n[k];
        });
      }
      touched(t);
    }
    /* пошук запису журналу за id (ідемпотентність) у вікні ts − 1 доба */
    function findLog(t, id, ts) {
      var rows = store.since(t, new Date(ts.getTime() - DAY)) || [];
      for (var i = rows.length - 1; i >= 0; i--) if (toStr(rows[i].id) === id) return norm(t, rows[i], kit());
      return null;
    }
    /* записи журналу, де col = value, — через store.findBy (сховище шукає без читання всього аркуша);
       null — сховище так не вміє (тоді викликач читає вікно або весь журнал) */
    function logBy(t, col, value) {
      if (typeof store.findBy !== 'function') return null;
      var v = toStr(value), raw = store.findBy(t, col, v);
      if (!raw) return null;
      var k = kit();
      return raw.map(function (r) { return norm(t, r, k); }).filter(function (r) { return !!r.ts && toStr(r[col]) === v; });
    }
    /* свіжий запис (ts з клієнта / запису) дешевше знайти вікном від ts — аркуш читається знизу;
       давній — через findBy сховища (інакше вікно від ts читало б майже весь журнал) */
    var RECENT = 14 * DAY;
    function isRecent(ts) { return !!ts && ts.getTime() >= nowD().getTime() - RECENT; }
    /* запис журналу за id (анулювання / перегляд): вікно від ts ↔ findBy сховища, в останню чергу — увесь журнал */
    function locateLog(t, id, ts) {
      var row = null, rows = null;
      var near = function () { return ts ? findLog(t, id, new Date(ts.getTime() + DAY / 2)) : null; };
      if (isRecent(ts) && (row = near())) return row;
      rows = logBy(t, 'id', id);
      if (!rows && !isRecent(ts) && (row = near())) return row;
      if (!rows) rows = logAll(t);
      for (var i = 0; i < rows.length; i++) if (rows[i].id === id) row = rows[i];
      return row;
    }
    /* відповіді чек-листа (вставлені разом із ним, ts той самий) */
    function answersOf(chk) {
      var rows = isRecent(chk.ts) ? null : logBy('answers', 'check_id', chk.id);
      return (rows || logSince('answers', new Date(chk.ts.getTime() - DAY))).filter(function (a) { return a.check_id === chk.id; });
    }
    function byTs(a, b) {
      var d = a.ts.getTime() - b.ts.getTime();
      if (d) return d;
      return (a.created ? a.created.getTime() : 0) - (b.created ? b.created.getTime() : 0);
    }
    function descTs(a, b) { return byTs(b, a); }
    function cmpStr(a, b) { a = String(a || ''); b = String(b || ''); return a < b ? -1 : a > b ? 1 : 0; }
    function bySort(a, b) {
      return ((a.sort || 0) - (b.sort || 0)) || cmpStr(a.name || a.text || a.title, b.name || b.text || b.title) || cmpStr(a.id, b.id);
    }
    function lineEvents(lineId, from) {
      var rows = from ? logSince('events', from) : logAll('events');
      return rows.filter(function (e) { return e.line_id === lineId && !e.void; }).sort(byTs);
    }
    function activeLines() { return tbl('lines').filter(function (l) { return l.active; }).sort(bySort); }
    function linesFor(ids) {
      var list = ids ? (Array.isArray(ids) ? ids.map(toStr) : toIds(ids)) : [];
      return tbl('lines').filter(function (l) { return list.length ? list.indexOf(l.id) >= 0 : l.active; }).sort(bySort);
    }
    function lineName(id) { var l = find('lines', id); return l ? l.name : id; }
    function unitName(id) { if (!id) return ''; var u = find('units', id); return u ? u.name : id; }
    function dev(ctx, p) { return txt((ctx && ctx.device) || (p && p.device) || '', 120); }
    function cleanId(v, what) {
      var s = toStr(v);
      if (!s) return '';
      if (!ID_RE.test(s)) throw bad('Некоректний ідентифікатор' + (what ? ' (' + what + ')' : '') + ': ' + s.slice(0, 40));
      return s;
    }
    function refId(v) { return txt(v, 80); }
    /* час запису з клієнта: майбутнє → now; занадто давній (скинутий годинник планшета) → відмова */
    function clampTs(v, now, maxBack) {
      if (isBlank(v)) return now;
      var d = parseDate(v, kit());
      if (!d) throw bad('Невірний формат часу: ' + toStr(v).slice(0, 40));
      if (d.getTime() > now.getTime() + FUTURE_SLACK) return now;
      if (maxBack && d.getTime() < now.getTime() - maxBack) {
        throw bad('Час запису ' + kit().fmtDT(d) + ' давніший за ' + Math.round(maxBack / DAY) +
          ' дн. — перевірте дату й годинник пристрою');
      }
      return d;
    }
    function isTrue(v) { return v === true || v === 'true' || v === 1 || v === '1'; }
    /* межа періоду: Date | 'YYYY-MM-DD' (для кінця — початок наступного дня) | ISO */
    function bound(v, isEnd) {
      if (isBlank(v)) return null;
      if (isDate(v)) return new Date(v.getTime());
      if (isKey(v)) { var k = v.trim(); return kit().start(isEnd ? keyAdd(k, 1) : k); }
      return parseDate(v, kit());
    }

    /* ---------- мотогодини та відрізки стану ---------- */
    function cumAt(line, T) {
      if (!line) return 0;
      var t = toMs(T);
      if (!line.cur_since || t >= line.cur_since.getTime()) {
        var c = line.cur_cum_h || 0;
        if (line.cur_state === 'run' && line.cur_since) c += Math.max(0, (t - line.cur_since.getTime()) / HOUR);
        return r4(c);
      }
      var evs = lineEvents(line.id, new Date(t));
      if (evs.length) {
        var e = evs[0];
        return r4(Math.max(0, (e.cum_h || 0) - (e.prev_state === 'run' ? (e.ts.getTime() - t) / HOUR : 0)));
      }
      var all = lineEvents(line.id, null), last = null;
      for (var i = 0; i < all.length; i++) if (all[i].ts.getTime() <= t) last = all[i];
      return last ? r4((last.cum_h || 0) + (last.state === 'run' ? (t - last.ts.getTime()) / HOUR : 0)) : 0;
    }
    /* мотогодини як функція часу за відсортованими точками (події + поточний стан лінії);
       правильна для T не раніше першої точки або коли до першої точки подій немає */
    function snapEv(e) { return { ts: e.ts, state: e.state, prev_state: e.prev_state, cum_h: e.cum_h }; }
    function lineCurSnap(line) {
      return line && line.cur_since ? { ts: line.cur_since, state: line.cur_state || 'off', prev_state: null, cum_h: line.cur_cum_h || 0 } : null;
    }
    function cumFnOf(evs, cur) {
      var pts = evs.map(snapEv);
      if (cur && (!pts.length || cur.ts.getTime() > pts[pts.length - 1].ts.getTime())) pts.push(cur);
      return function (T) {
        var t = toMs(T), last = null;
        for (var i = 0; i < pts.length; i++) { if (pts[i].ts.getTime() <= t) last = pts[i]; else break; }
        if (last) return r4((last.cum_h || 0) + (last.state === 'run' ? (t - last.ts.getTime()) / HOUR : 0));
        var f = pts[0];
        if (f) return r4(Math.max(0, (f.cum_h || 0) - (f.prev_state === 'run' ? (f.ts.getTime() - t) / HOUR : 0)));
        return 0;
      };
    }
    /* подія, що діяла на початок вікна (для причини / продукту стану, який «переходить» у вікно).
       Потрібна лише лініям, у яких вікно починається не зі стану «Не працює». */
    function carryIn(lines, evBy, from) {
      var f = toMs(from), need = {}, n = 0, lb = f - 14 * DAY;
      lines.forEach(function (l) {
        var evs = evBy[l.id] || [], first = evs[0], want;
        if (first) want = first.ts.getTime() > f && !!first.prev_state && first.prev_state !== 'off';
        else want = !!l.cur_since && l.cur_since.getTime() <= f && (l.cur_state || 'off') !== 'off';
        if (!want) return;
        need[l.id] = 1; n++;
        if (!first) lb = Math.min(lb, Math.max(l.cur_since.getTime(), f - 62 * DAY));
      });
      if (!n) return evBy;
      var last = {};
      logSince('events', new Date(lb)).forEach(function (e) {
        if (e.void || !has(need, e.line_id) || e.ts.getTime() >= f) return;
        var p = last[e.line_id];
        if (!p || byTs(p, e) <= 0) last[e.line_id] = e;
      });
      for (var id in last) if (has(last, id)) evBy[id] = [last[id]].concat(evBy[id] || []);
      return evBy;
    }
    /* чи є подія i запуском лінії: перший «Працює» після «Не працює» (у т. ч. через налаштування / ремонт / ТО).
       Для переходів не з off/run/stop — за лічильником запусків відносно попередньої події списку. */
    function isStartAt(evs, i) {
      var e = evs[i];
      if (!e || e.state !== 'run') return false;
      if (e.prev_state === 'off') return true;
      if (e.prev_state === 'run' || e.prev_state === 'stop') return false;
      if (e.flag === 'no_checklist') return true;
      var p = i > 0 ? evs[i - 1] : null;
      if (p && typeof p.starts === 'number' && typeof e.starts === 'number') return e.starts > p.starts;
      return false;
    }
    /* чи працювала лінія (run / stop) після останнього «Не працює» — станом на подію idx включно; null — невідомо */
    function ranBefore(list, idx) {
      for (var k = idx; k >= 0; k--) {
        var s = list[k].state;
        if (s === 'off') return false;
        if (s === 'run' || s === 'stop') return true;
      }
      return null;
    }
    /* перехід лінії в «Не працює» (завершення роботи) — після нього потрібен новий чек-лист запуску */
    function isOffTr(e) { return e.state === 'off' && e.prev_state !== 'off'; }
    /* відрізки стану лінії у вікні [from, to); evs — непогашені події лінії за зростанням ts */
    function segments(line, evs, from, to) {
      var f = toMs(from), t = toMs(to), out = [];
      if (!(t > f)) return out;
      var i = 0, before = null, cur;
      while (i < evs.length && evs[i].ts.getTime() <= f) { before = evs[i]; i++; }
      if (before) cur = { state: before.state, product: before.product, reason: before.reason, event_id: before.id };
      else if (i < evs.length) cur = { state: evs[i].prev_state || 'off', product: '', reason: '', event_id: '' };
      else if (line && line.cur_since && line.cur_since.getTime() <= f) {
        cur = { state: line.cur_state || 'off', product: line.cur_product || '', reason: '', event_id: line.cur_event || '' };
      } else cur = { state: 'off', product: '', reason: '', event_id: '' };
      var curFrom = f;
      for (; i < evs.length; i++) {
        var e = evs[i], et = e.ts.getTime();
        if (et >= t) break;
        if (et > curFrom) out.push(mkSeg(cur, curFrom, et));
        cur = { state: e.state, product: e.product, reason: e.reason, event_id: e.id };
        curFrom = et;
      }
      if (t > curFrom) out.push(mkSeg(cur, curFrom, t));
      return out;
    }
    function mkSeg(c, a, b) {
      return { state: c.state, from: new Date(a), to: new Date(b), hours: r4((b - a) / HOUR),
        product: c.product || '', reason: c.reason || '', event_id: c.event_id || '' };
    }
    function emptyHours() { var h = {}; for (var s in LABELS.state) h[s] = 0; return h; }
    function clipHours(segs, a, b, acc) {
      acc = acc || emptyHours();
      var A = toMs(a), B = toMs(b);
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i], x = Math.max(A, s.from.getTime()), y = Math.min(B, s.to.getTime());
        if (y > x) acc[s.state] = (acc[s.state] || 0) + (y - x) / HOUR;
      }
      return acc;
    }
    function roundMap(h) { for (var k in h) if (has(h, k)) h[k] = r4(h[k]); return h; }

    /* ---------- поточний стан лінії (для планшета) ---------- */
    /* початок поточної роботи лінії (перехід із «Не працює»); якщо його немає у вікні — шукаємо глибше */
    function workStart(line, evs, from, now) {
      var t = now.getTime();
      var scan = function (list) {
        for (var i = list.length - 1; i >= 0; i--) {
          var e = list[i];
          if (e.ts.getTime() > t) continue;
          if (e.prev_state === 'off' && e.state !== 'off') return e.ts;
        }
        return null;
      };
      var ws = scan(evs);
      if (ws) return ws;
      var f = from ? toMs(from) : (evs.length ? evs[0].ts.getTime() : t);
      var lb = t - 7 * DAY;              // обмежений пошук: для ліній, що працюють цілодобово, не читаємо весь журнал
      if (f > lb) {
        var more = lineEvents(line.id, new Date(lb));
        ws = scan(more);
        if (ws) return ws;
        f = lb;
      }
      // робота триває довше за доступну історію — найраніша відома межа
      return new Date(Math.min(f, line.cur_since ? line.cur_since.getTime() : f));
    }
    function statusOf(line, evs, checks, now, from) {
      var S = settings(), K = kit(), t = now.getTime();
      var st = line.cur_state || 'off', last = null, i;
      for (i = evs.length - 1; i >= 0; i--) if (evs[i].id === line.cur_event) { last = evs[i]; break; }
      var today = 0, segs = segments(line, evs, K.start(K.key(now)), now);
      for (i = 0; i < segs.length; i++) if (segs[i].state === 'run') today += segs[i].hours;
      var lastCheck = null, newest = -Infinity, vFrom = t - S.checklist_valid_hours * HOUR;
      for (i = 0; i < checks.length; i++) {
        var c = checks[i], x = c.ts.getTime();
        if (c.void || c.line_id !== line.id) continue;
        if (!lastCheck || c.ts >= lastCheck.ts) lastCheck = c;
        if (c.occasion === 'start' && x >= vFrom && x <= t + FUTURE_SLACK && x > newest) newest = x;
      }
      // чек-лист запуску чинний до першого переходу лінії в «Не працює» після нього (нова зміна — новий чек-лист)
      var valid = false;
      if (newest > -Infinity) {
        var f0 = from ? toMs(from) : (evs.length ? evs[0].ts.getTime() : t);
        var offs = f0 > newest ? lineEvents(line.id, new Date(newest)) : evs;
        valid = !offs.some(function (e) { var y = e.ts.getTime(); return isOffTr(e) && y >= newest && y <= t + FUTURE_SLACK; });
      }
      var workSince = st !== 'off' ? workStart(line, evs, from, now) : null;
      // чи була лінія в «Працює» / «Простій» після останнього «Не працює» (як ran у addEvent: наступне «Працює» — не запуск)
      var ran = st === 'off' ? false : (st === 'run' || st === 'stop') ? true : ranBefore(evs, evs.length - 1);
      if (ran === null) {
        var fr = from ? toMs(from) : (evs.length ? evs[0].ts.getTime() : t);
        if (fr > t - ORDER_WINDOW) { var deep = lineEvents(line.id, new Date(t - ORDER_WINDOW)); ran = ranBefore(deep, deep.length - 1); }
        ran = !!ran;
      }
      return {
        line_id: line.id, state: st, since: line.cur_since || null, product: line.cur_product || '',
        operator: line.cur_operator || '', staff_id: last ? last.staff_id : '', event_id: line.cur_event || '',
        reason: last ? last.reason : '', note: last ? last.note : '', flag: last ? last.flag : '',
        cum_h: cumAt(line, now), starts: line.cur_starts || 0, today_h: r4(today),
        last_check: lastCheck ? { id: lastCheck.id, ts: lastCheck.ts, occasion: lastCheck.occasion, result: lastCheck.result } : null,
        start_check_valid: valid,
        long_run: !!(st !== 'off' && workSince && (t - workSince.getTime()) / HOUR >= S.long_run_hours),
        work_since: workSince, ran_since_off: ran
      };
    }
    function statusFor(lineId, now) {
      var S = settings(), K = kit(), line = find('lines', lineId);
      if (!line) return null;
      var from = Math.min(K.start(K.key(now)).getTime(), now.getTime() - (S.long_run_hours + 1) * HOUR,
        now.getTime() - S.checklist_valid_hours * HOUR - FUTURE_SLACK);
      var evs = lineEvents(line.id, new Date(from));
      var cf = now.getTime() - Math.max(7 * DAY, S.checklist_valid_hours * HOUR);
      var checks = logSince('checks', new Date(cf)).filter(function (c) { return c.line_id === line.id && !c.void; }).sort(byTs);
      return statusOf(line, evs, checks, now, new Date(from));
    }

    /* ---------- лічильники ---------- */
    function walkMeter(rs, defMode) {
      var v = 0;
      for (var i = 0; i < rs.length; i++) {
        var md = rs[i].mode || defMode || 'abs';
        if (md === 'inc') v += rs[i].value || 0; else v = rs[i].value || 0;
      }
      return v;
    }
    function meterValueAt(m, T) {
      if (!m) return 0;
      var t = toMs(T);
      if (!m.cur_ts || t >= m.cur_ts.getTime()) return m.cur_ts ? (m.cur_value || 0) : 0;
      var after = logSince('readings', new Date(t + 1)).filter(function (r) { return r.meter_id === m.id && !r.void && r.ts.getTime() > t; });
      var absAfter = after.some(function (r) { return (r.mode || m.mode) !== 'inc'; });
      if (!absAfter) {
        var v = m.cur_value || 0;
        after.forEach(function (r) { v -= r.value || 0; });
        return r4(v);
      }
      // після T є накопичувальний показник — значення на T від останнього накопичувального до T (вікно, без all())
      var mine = function (r) { return r.meter_id === m.id && !r.void && r.ts.getTime() <= t; };
      var rs = logSince('readings', new Date(t - ORDER_WINDOW)).filter(mine).sort(byTs);
      var k = -1;
      for (var i = rs.length - 1; i >= 0; i--) if ((rs[i].mode || m.mode) !== 'inc') { k = i; break; }
      if (k < 0) rs = logAll('readings').filter(mine).sort(byTs);   // опори у вікні немає — уся історія
      else rs = rs.slice(k);
      return r4(walkMeter(rs, m.mode));
    }
    /* значення лічильника на T як відлік регламенту. До першого показника значення невідоме: для накопичувального
       обліку відлік — перший показник (інакше весь показник табло став би «напрацюванням»), для приросту — 0 */
    function meterRefAt(m, T) {
      if (!m) return 0;
      var t = toMs(T);
      if (m.cur_ts && t < m.cur_ts.getTime()) {
        var first = null;
        logAll('readings').forEach(function (r) {
          if (r.meter_id === m.id && !r.void && (!first || byTs(r, first) < 0)) first = r;
        });
        if (first && first.ts.getTime() > t) return (first.mode || m.mode || 'abs') === 'inc' ? 0 : r4(first.value || 0);
      }
      return r4(meterValueAt(m, T));
    }
    /* середній приріст лічильника за добу у вікні */
    function meterAvg(m, rs, from, now) {
      var inc = 0, cum = null, start = null, t = now.getTime();
      for (var i = 0; i < rs.length; i++) {
        var r = rs[i], v = r.value || 0, md = r.mode || m.mode || 'abs';
        if (r.ts.getTime() > t) break;
        if (md === 'inc') {
          inc += v;
          if (cum !== null) cum += v;
          if (start === null) start = Math.max(from.getTime(), r.ts.getTime() - DAY);
        } else {
          if (cum !== null) inc += Math.max(0, v - cum);
          cum = v;
          if (start === null) start = r.ts.getTime();
        }
      }
      if (start === null) return 0;
      return r4(inc / Math.max(1, (t - start) / DAY));
    }
    function meterView(m, dc) {
      var o = copy(m);
      o.value = m.cur_value;
      o.value_ts = m.cur_ts;
      if (dc) o.avg_per_day = dc.avgM[m.id] || 0;
      return o;
    }

    /* ---------- контекст розрахунку строків ТО ---------- */
    function dueCtx(now) {
      if (cache.dc && cache.dc.now.getTime() === now.getTime()) return cache.dc;
      var S = settings(), W = S.avg_window_days, from = new Date(now.getTime() - W * DAY);
      var evs = logSince('events', from).filter(function (e) { return !e.void; }).sort(byTs);
      var evBy = groupBy(evs, 'line_id'), avgH = {}, cum = {};
      tbl('lines').forEach(function (l) {
        cum[l.id] = cumAt(l, now);
        var st = from.getTime();
        if (l.created && l.created.getTime() > st) st = l.created.getTime();
        // облік лінії почався у вікні (перша подія без напрацювання до неї) — середнє від дня першої події
        var f0 = (evBy[l.id] || [])[0];
        if (f0 && f0.prev_state === 'off' && !(f0.cum_h > 1e-6)) {
          var d0 = kit().start(kit().key(f0.ts)).getTime();
          if (d0 > st) st = d0;
        }
        var h = 0;
        segments(l, evBy[l.id] || [], st, now).forEach(function (s) { if (s.state === 'run') h += s.hours; });
        avgH[l.id] = r4(h / Math.max(1, (now.getTime() - st) / DAY));
      });
      var rds = logSince('readings', from).filter(function (r) { return !r.void; }).sort(byTs);
      var rBy = groupBy(rds, 'meter_id'), avgM = {}, mval = {};
      tbl('meters').forEach(function (m) {
        mval[m.id] = m.cur_ts && m.cur_ts.getTime() > now.getTime() ? meterValueAt(m, now) : (m.cur_value || 0);
        avgM[m.id] = meterAvg(m, rBy[m.id] || [], from, now);
      });
      cache.dc = { now: now, S: S, from: from, evBy: evBy, avgH: avgH, cum: cum, avgM: avgM, mval: mval };
      return cache.dc;
    }
    function critLeftText(c) {
      if (c.kind === 'days') { var d = Math.floor(c.left); return d >= 1 ? fmtNum(d) + ' дн.' : 'менше доби'; }
      if (c.kind === 'hours') return (c.left >= 1 ? fmtNum(Math.round(c.left)) : '<1') + ' мотогод';
      return fmtNum(Math.round(c.left)) + ' ' + c.unit_label;
    }
    function critOverText(c) {
      var over = -c.left;
      if (c.kind === 'days') { var d = Math.floor(over); return d >= 1 ? 'прострочено на ' + fmtNum(d) + ' дн.' : 'строк настав сьогодні'; }
      if (c.kind === 'hours') return 'перевищено на ' + fmtNum(Math.round(over)) + ' мотогод';
      return 'перевищено на ' + fmtNum(Math.round(over)) + ' ' + c.unit_label;
    }
    function dueSummary(status, crit) {
      if (!crit.length) return 'без інтервалу';
      if (status === 'due') {
        var over = crit.filter(function (c) { return c.left <= 0; });
        return (over.length ? over : crit).map(critOverText).join(' · ');
      }
      return 'залишилось ' + crit.map(critLeftText).join(' · ');
    }
    /* + n календарних днів у поясі заводу зі збереженням часу доби (DST-коректно); дробова частина — як тривалість */
    function calAdd(d, n) {
      var K = kit(), ms0 = toMs(d), whole = Math.floor(n), frac = n - whole;
      var p = K.parts(new Date(ms0)), k = splitKey(keyAdd(ymd(p.y, p.m, p.d), whole));
      var r = K.local(k.y, k.m, k.d, p.H, p.M, p.S);
      if (!r || isNaN(r.getTime())) return new Date(ms0 + n * DAY);
      return new Date(r.getTime() + (((ms0 % 1000) + 1000) % 1000) + frac * DAY);
    }
    function computeDue(rule, dc) {
      if (typeof rule === 'string') rule = find('rules', rule);
      if (!rule) throw notFound('Регламент не знайдено');
      dc = dc || dueCtx(nowD());
      var now = dc.now, S = dc.S, t = now.getTime();
      var line = find('lines', rule.line_id);
      var meter = rule.meter_id ? find('meters', rule.meter_id) : null;
      var refDate, refHours, refMeter, fromWork = !!rule.last_date;
      if (fromWork) {
        refDate = rule.last_date;
        refHours = rule.last_hours !== null ? rule.last_hours : cumAt(line, rule.last_date);
        refMeter = rule.last_meter !== null ? rule.last_meter : (meter ? meterValueAt(meter, rule.last_date) : 0);
      } else {
        refDate = rule.base_date || rule.created || now;
        // незаповнений відлік (рядок із таблиці) — значення на дату відліку, а не 0
        refHours = rule.base_hours !== null && rule.base_hours !== undefined ? rule.base_hours : (line ? cumAt(line, refDate) : 0);
        refMeter = rule.base_meter !== null && rule.base_meter !== undefined ? rule.base_meter : (meter ? meterValueAt(meter, refDate) : 0);
      }
      var crit = [];
      if (rule.interval_days > 0) {
        // строк — календарні дні в поясі заводу (перехід на літній/зимовий час не зсуває дату)
        var I = rule.interval_days, dd = calAdd(refDate, I), span = Math.max(1, dd.getTime() - refDate.getTime());
        var fr = (t - refDate.getTime()) / span, usedD = I * fr;
        crit.push({ kind: 'days', interval: I, used: r2(usedD), left: r2(I - usedD), pct: fr,
          due_date: dd, unit_label: 'дн.', forecast: false, period_days: I });
      }
      if (rule.interval_hours > 0 && line) {
        var IH = rule.interval_hours, cumNow = has(dc.cum, line.id) ? dc.cum[line.id] : cumAt(line, now);
        var usedH = cumNow - refHours, leftH = IH - usedH, avg = dc.avgH[line.id] || 0;
        // перевищено, а прогнозу немає (лінія стоїть) — строк уже настав: сьогодні
        var dh = avg > 0 ? new Date(t + leftH / avg * DAY) : (usedH >= IH ? new Date(t) : null);
        crit.push({ kind: 'hours', interval: IH, used: r2(usedH), left: r2(leftH), pct: usedH / IH,
          due_date: dh, unit_label: 'мотогод', forecast: avg > 0, avg: avg, period_days: avg > 0 ? r2(IH / avg) : null });
      }
      if (meter && rule.interval_meter > 0) {
        var IM = rule.interval_meter, mv = has(dc.mval, meter.id) ? dc.mval[meter.id] : (meter.cur_value || 0);
        var usedM = mv - refMeter, leftM = IM - usedM, am = dc.avgM[meter.id] || 0;
        var dm = am > 0 ? new Date(t + leftM / am * DAY) : (usedM >= IM ? new Date(t) : null);
        crit.push({ kind: 'meter', interval: IM, used: r2(usedM), left: r2(leftM), pct: usedM / IM,
          due_date: dm, unit_label: meter.unit_label || 'од.',
          forecast: am > 0, avg: am, meter_id: meter.id, period_days: am > 0 ? r2(IM / am) : null });
      }
      var pct = null, dueDate = null, driver = null, basis = null, bc = null;
      crit.forEach(function (c) {
        if (pct === null || c.pct > pct) { pct = c.pct; driver = c.kind; }
        if (c.due_date && (!dueDate || c.due_date.getTime() < dueDate.getTime())) { dueDate = c.due_date; basis = c.kind; bc = c; }
      });
      var status;
      if (!crit.length) status = 'none';
      else if (pct >= 1) status = 'due';
      else {
        var rp = pctVal(rule.warn_pct);
        var wp = rp > 0 ? rp : S.warn_pct;
        var wd = rule.warn_days !== null && rule.warn_days !== undefined ? rule.warn_days : S.warn_days;
        // «за N днів» діє, лише коли N менше за сам інтервал — інакше щойно виконана робота була б «скоро» завжди
        var byDays = !!dueDate && dueDate.getTime() - t <= wd * DAY && !(bc && bc.period_days !== null && wd >= bc.period_days);
        status = (pct * 100 >= wp || byDays) ? 'soon' : 'ok';
      }
      var summary = dueSummary(status, crit);
      crit.forEach(function (c) { c.pct = r4(c.pct); });
      return {
        rule_id: rule.id, line_id: rule.line_id, unit_id: rule.unit_id, title: rule.title, work_type: rule.work_type,
        part: rule.part, status: status, pct: pct === null ? null : r4(pct), due_date: dueDate,
        forecast: !!bc && bc.forecast, due_basis: basis, ref_date: refDate, ref_hours: r4(refHours),
        ref_meter: meter ? r4(refMeter) : null, driver: driver, criteria: crit, summary: summary,
        overdue_days: status === 'due' && dueDate ? round(Math.max(0, (t - dueDate.getTime()) / DAY), 1) : 0,
        last_date: rule.last_date || null, last_work_id: rule.last_work_id || '',
        ref_work_id: fromWork ? (rule.last_work_id || '') : ''
      };
    }
    var DUE_ORDER = { due: 0, soon: 1, ok: 2, none: 3 };
    function dueSort(a, b) {
      var x = a.due_date ? a.due_date.getTime() : Infinity, y = b.due_date ? b.due_date.getTime() : Infinity;
      return (DUE_ORDER[a.status] - DUE_ORDER[b.status]) || (x < y ? -1 : x > y ? 1 : 0) || cmpStr(a.title, b.title) || cmpStr(a.rule_id, b.rule_id);
    }
    function activeRules() {
      return tbl('rules').filter(function (r) {
        if (!r.active) return false;
        var l = find('lines', r.line_id);
        if (!l || !l.active) return false;
        if (r.unit_id) { var u = find('units', r.unit_id); if (u && !u.active) return false; }
        return true;
      });
    }
    /* регламенти, додані прямо в таблиці: без «Відлік від дати» і «Створено» — відлік від першого розрахунку;
       незаповнені «Відлік мотогодин» / «Відлік лічильника» — значення на дату відліку (а не 0).
       Під час READ-дій (readOnly) — лише в пам'яті; у сховище записують дії запису та задачі хоста. */
    function initSheetRules() {
      var at = nowD(), patches = [];
      tbl('rules').forEach(function (r) {
        if (!r.id || r.last_date) return;
        var line = find('lines', r.line_id), meter = r.meter_id ? find('meters', r.meter_id) : null;
        var p = { id: r.id }, n = 0, ref = r.base_date || r.created;
        if (!ref) { p.created = at; p.base_date = at; ref = at; n++; }
        if (r.base_hours === null && line) { p.base_hours = cumAt(line, ref); n++; }
        if (r.base_meter === null && meter) { p.base_meter = meterRefAt(meter, ref); n++; }
        if (n) patches.push(p);
      });
      if (!patches.length) return;
      if (readOnly) patchCached('rules', patches);
      else patchRows('rules', patches);
    }
    /* агрегати, додані прямо в таблиці (без «Мотогодини лінії при додаванні»): напрацювання — від «Створено»
       (порожньо — від першого розрахунку), а не вся історія лінії. Як і для регламентів: READ — лише в пам'яті */
    function initSheetUnits() {
      var at = nowD(), patches = [];
      tbl('units').forEach(function (u) {
        if (!u.id || u.base_cum !== null) return;
        var line = find('lines', u.line_id);
        if (!line) return;
        var p = { id: u.id }, ref = u.created;
        if (!ref) { p.created = at; ref = at; }
        p.base_cum = cumAt(line, ref);
        patches.push(p);
      });
      if (!patches.length) return;
      if (readOnly) patchCached('units', patches);
      else patchRows('units', patches);
    }
    function initSheetRows() { initSheetRules(); initSheetUnits(); }
    function dueList(now) {
      now = now ? (isDate(now) ? now : parseDate(now, kit()) || nowD()) : nowD();
      initSheetRows();
      var dc = dueCtx(now);
      return activeRules().map(function (r) { return computeDue(r, dc); }).sort(dueSort);
    }

    /* ---------- план ППР ---------- */
    function buildPlan(fromIn, toIn) {
      var now = nowD(), S = settings(), K = kit();
      var from = bound(fromIn, false) || K.start(K.key(now));
      var to = bound(toIn, true) || new Date(from.getTime() + S.plan_horizon_days * DAY);
      var dc = dueCtx(now), items = [], rules = [];
      dueList(now).forEach(function (d) {
        if (d.status === 'none') return;
        var r = find('rules', d.rule_id), periods = [];
        if (r.interval_days > 0) periods.push({ basis: 'days', p: r.interval_days });
        var ah = dc.avgH[r.line_id] || 0;
        if (r.interval_hours > 0 && ah > 0) periods.push({ basis: 'hours', p: r.interval_hours / ah });
        var am = r.meter_id ? (dc.avgM[r.meter_id] || 0) : 0;
        if (r.meter_id && r.interval_meter > 0 && am > 0) periods.push({ basis: 'meter', p: r.interval_meter / am });
        var best = null;
        periods.forEach(function (x) { if (!best || x.p < best.p) best = x; });
        var info = { rule_id: r.id, line_id: r.line_id, unit_id: r.unit_id, title: r.title, work_type: r.work_type,
          status: d.status, period_days: best ? r2(best.p) : null, basis: best ? best.basis : null, note: '', count: 0 };
        var overdue = d.status === 'due';
        if (!overdue && (!d.due_date || !best)) { info.note = 'Немає даних про напрацювання для прогнозу'; rules.push(info); return; }
        if (!best) info.note = 'Немає даних про напрацювання для прогнозу';
        // прострочене — завжди в плані: на дату строку (не пізніше «зараз»), але не раніше початку періоду
        var t = overdue ? Math.max(from.getTime(), Math.min(d.due_date ? d.due_date.getTime() : now.getTime(), now.getTime()))
          : d.due_date.getTime();
        var next = function (x) { return best.basis === 'days' ? calAdd(new Date(x), best.p).getTime() : x + best.p * DAY; };
        if (!overdue) while (t < from.getTime()) t = next(t);
        var n = 0;
        while (t <= to.getTime() && n < 400) {
          n++;
          var key = K.key(new Date(t));
          items.push({ date: K.start(key), day: key, rule_id: r.id, line_id: r.line_id, unit_id: r.unit_id,
            title: r.title, work_type: r.work_type, part: r.part,
            forecast: n === 1 ? d.forecast : best.basis !== 'days', overdue: n === 1 && overdue,
            status: n === 1 ? d.status : 'ok', basis: n === 1 ? (d.due_basis || (best && best.basis) || 'days') : best.basis, n: n });
          if (!best) break;                       // немає періоду — лише прострочене входження
          t = next(t);
        }
        info.count = n;
        rules.push(info);
      });
      var lineOrder = {};
      tbl('lines').slice().sort(bySort).forEach(function (l, i) { lineOrder[l.id] = i; });
      items.sort(function (a, b) {
        return (a.date - b.date) || ((lineOrder[a.line_id] || 0) - (lineOrder[b.line_id] || 0)) || cmpStr(a.title, b.title);
      });
      return { from: from, to: to, items: items, rules: rules, avg_h: copy(dc.avgH), avg_meter: copy(dc.avgM) };
    }
    function basisText(it, ri) {
      var s = it.basis === 'hours' ? 'Прогноз за мотогодинами' : it.basis === 'meter' ? 'Прогноз за лічильником' : 'Календарний інтервал';
      if (ri && ri.period_days) s += ' (≈ кожні ' + fmtNum(ri.period_days, ri.period_days < 10 ? 1 : 0) + ' дн.)';
      return it.overdue ? 'Прострочено · ' + s : s;
    }
    function planRows(fromIn, toIn) {
      var p = buildPlan(fromIn, toIn), now = nowD(), ri = {};
      p.rules.forEach(function (r) { ri[r.rule_id] = r; });
      return p.items.map(function (it) {
        return { date: it.date, line: lineName(it.line_id), unit: unitName(it.unit_id), title: it.title,
          work_type: it.work_type, basis: basisText(it, ri[it.rule_id]), status: it.status, rule_id: it.rule_id, generated: now };
      });
    }
    function refreshPlan(fromIn, toIn) {
      var rows = planRows(fromIn, toIn);
      store.replace('plan', rows.map(function (r) { return denorm('plan', r); }));
      return { ok: true, count: rows.length };
    }

    /* ---------- вікно журналів, контроль чек-листів, статистика ---------- */
    /* журнали за вікно; lines — для них у evBy на початок додається подія, що діяла на початок вікна */
    function loadWindow(from, lines) {
      var evs = logSince('events', from).filter(function (e) { return !e.void; }).sort(byTs);
      var checks = logSince('checks', from).filter(function (c) { return !c.void; }).sort(byTs);
      var works = logSince('works', from).filter(function (w) { return !w.void; }).sort(byTs);
      var evBy = groupBy(evs, 'line_id');
      if (lines) carryIn(lines, evBy, from);
      return { from: from, evs: evs, checks: checks, works: works,
        evBy: evBy, checkBy: groupBy(checks, 'line_id'), workBy: groupBy(works, 'line_id') };
    }
    function dayKeysBetween(from, to) {
      var K = kit(), a = K.key(from), b = K.key(new Date(toMs(to) - 1)), out = [];
      for (var k = a, g = 0; k <= b && g < 1500; k = keyAdd(k, 1), g++) out.push(k);
      return out;
    }
    function complianceData(keys, lines, data, now) {
      var K = kit(), res = {};
      if (!keys.length) return res;
      var bounds = keys.map(function (k) { return { key: k, a: K.start(k).getTime(), b: K.start(keyAdd(k, 1)).getTime() }; });
      var first = bounds[0].a, last = Math.min(bounds[bounds.length - 1].b, now.getTime());
      lines.forEach(function (l) {
        var evs = data.evBy[l.id] || [], chs = data.checkBy[l.id] || [];
        var segs = segments(l, evs, first, last);
        res[l.id] = bounds.map(function (bd) {
          var starts = 0, nc = 0, ne = 0, forced = 0, dayChecks = [], badCheck = false;
          evs.forEach(function (e, i) {
            var x = e.ts.getTime();
            if (x < bd.a || x >= bd.b) return;
            if (isStartAt(evs, i)) starts++;
            if (e.flag === 'no_checklist') nc++;
            if (e.flag === 'no_end_checklist') ne++;
            if (e.flag === 'forced') forced++;
          });
          chs.forEach(function (c) {
            var x = c.ts.getTime();
            if (x < bd.a || x >= bd.b) return;
            dayChecks.push({ id: c.id, ts: c.ts, occasion: c.occasion, result: c.result, na: c.na || 0 });
            if ((c.occasion === 'start' || c.occasion === 'changeover') && (c.result === 'remarks' || c.result === 'fail')) badCheck = true;
          });
          var runH = clipHours(segs, bd.a, Math.min(bd.b, last)).run;
          var uncovered = nc + ne, status;
          if (uncovered > 0) status = 'miss';
          else if (badCheck || forced > 0) status = 'warn';
          else if (starts > 0 || dayChecks.length > 0) status = 'ok';
          else if (runH > 0) status = 'cont';
          else status = 'idle';
          return { day: bd.key, status: status, starts: starts, covered: Math.max(0, starts - nc), run_h: r2(runH),
            checks: dayChecks, uncovered: uncovered, forced: forced };
        });
      });
      return res;
    }
    function compliancePct(comp) {
      var out = {}, T = 0, C = 0;
      for (var id in comp) {
        if (!has(comp, id)) continue;
        var t = 0, c = 0;
        comp[id].forEach(function (d) { t += d.starts; c += d.covered; });
        out[id] = t ? round(c / t * 100, 1) : null;
        T += t; C += c;
      }
      out.all = T ? round(C / T * 100, 1) : null;
      return out;
    }
    function statsData(from, to, lines, data, now) {
      var A = toMs(from), Bw = toMs(to), B = Math.min(Bw, now.getTime()), res = {};
      lines.forEach(function (l) {
        var evs = data.evBy[l.id] || [], segs = segments(l, evs, A, B);
        var hours = roundMap(clipHours(segs, A, B)), stops = {};
        segs.forEach(function (s) {
          if (s.state !== 'stop') return;
          var k = s.reason || 'Без причини';
          stops[k] = (stops[k] || 0) + s.hours;
        });
        var starts = 0, repairs = 0;
        evs.forEach(function (e, i) {
          var x = e.ts.getTime();
          if (x < A || x >= Bw) return;
          if (isStartAt(evs, i)) starts++;
          if (e.state === 'repair') repairs++;
        });
        var wbt = {};
        (data.workBy[l.id] || []).forEach(function (w) {
          var x = w.ts.getTime();
          if (x < A || x >= Bw) return;
          wbt[w.work_type] = (wbt[w.work_type] || 0) + 1;
        });
        var ch = { n: 0, ok: 0, remarks: 0, fail: 0, oor: 0, na: 0 };
        (data.checkBy[l.id] || []).forEach(function (c) {
          var x = c.ts.getTime();
          if (x < A || x >= Bw) return;
          ch.n++;
          if (c.result === 'ok') ch.ok++; else if (c.result === 'remarks') ch.remarks++; else if (c.result === 'fail') ch.fail++;
          ch.oor += c.out_of_range || 0;
          ch.na += c.na || 0;
        });
        var total = 0;
        for (var k in hours) if (has(hours, k)) total += hours[k];
        res[l.id] = { hours: hours, total_h: r4(total), starts: starts, stops_by_reason: roundMap(stops), repairs: repairs,
          repair_h: hours.repair, works_by_type: wbt, checks: ch.n, checks_ok: ch.ok, checks_remarks: ch.remarks,
          checks_fail: ch.fail, out_of_range: ch.oor, checks_na: ch.na };
      });
      return res;
    }
    function dailyData(keys, lines, data, now) {
      var K = kit(), res = {};
      if (!keys.length) return res;
      var A = K.start(keys[0]).getTime(), B = Math.min(K.start(keyAdd(keys[keys.length - 1], 1)).getTime(), now.getTime());
      lines.forEach(function (l) {
        var segs = segments(l, data.evBy[l.id] || [], A, B);
        res[l.id] = keys.map(function (k) {
          var a = K.start(k).getTime(), b = Math.min(K.start(keyAdd(k, 1)).getTime(), B);
          return { day: k, hours: roundMap(clipHours(segs, a, b)) };
        });
      });
      return res;
    }
    function issuesData(from, to, lineIds, data, limit) {
      var A = toMs(from), B = toMs(to), ok = {}, out = [];
      lineIds.forEach(function (id) { ok[id] = 1; });
      var chk = {};
      data.checks.forEach(function (c) { chk[c.id] = c; });
      logSince('answers', new Date(A)).forEach(function (a) {
        if (a.void || a.ok !== false || !has(ok, a.line_id) || a.ts.getTime() > B) return;
        var c = chk[a.check_id];
        if (!c) return;
        out.push({ ts: a.ts, line_id: a.line_id, kind: 'answer', text: a.text,
          value: a.value + (a.unit_label && a.type === 'number' ? ' ' + a.unit_label : ''), note: a.note,
          operator: c.operator, check_id: c.id, occasion: c.occasion, section: a.section, item_id: a.item_id });
      });
      data.evs.forEach(function (e) {
        var x = e.ts.getTime();
        if (e.state !== 'repair' || x < A || x > B || !has(ok, e.line_id)) return;
        out.push({ ts: e.ts, line_id: e.line_id, kind: 'repair', text: 'Ремонт' + (e.reason ? ': ' + e.reason : ''),
          note: e.note, operator: e.operator, event_id: e.id });
      });
      data.works.forEach(function (w) {
        var x = w.ts.getTime();
        if (w.work_type !== 'repair' || x < A || x > B || !has(ok, w.line_id)) return;
        out.push({ ts: w.ts, line_id: w.line_id, kind: 'repair', text: w.title, note: w.cause,
          operator: w.performer, work_id: w.id, parts: w.parts });
      });
      out.sort(descTs);
      return out.slice(0, limit || 30);
    }
    function compliancePub(fromIn, toIn, lineIds) {
      var now = nowD(), K = kit();
      var to = bound(toIn, true) || now;
      var from = bound(fromIn, false) || K.start(keyAdd(K.key(now), -13));
      var keys = dayKeysBetween(from, to);
      if (!keys.length) return {};
      var lines = linesFor(lineIds);
      return complianceData(keys, lines, loadWindow(K.start(keys[0]), lines), now);
    }
    function statsPub(fromIn, toIn, lineIds) {
      var now = nowD(), K = kit();
      var to = bound(toIn, true) || now;
      var from = bound(fromIn, false) || K.start(keyAdd(K.key(now), -13));
      var lines = linesFor(lineIds);
      return statsData(from, to, lines, loadWindow(from, lines), now);
    }

    /* ---------- READ-дії ---------- */
    function publicLine(l) {
      var o = copy(l);
      SCHEMA.lines.cols.forEach(function (c) { if (c.service) delete o[c.k]; });
      return o;
    }
    function publicStaff(s, admin) {
      var o = { id: s.id, name: s.name, role: s.role, line_ids: s.line_ids.slice(), pin_hash: pinHash(s.id, s.pin), active: s.active, sort: s.sort };
      if (admin) { o.email = s.email; o.has_pin = !!s.pin; }
      return o;
    }
    function publicRule(r, admin) { var o = copy(r); if (!admin) delete o.notify; return o; }
    function adminView(t, o) {
      if (t === 'staff') return publicStaff(o, true);
      return copy(o);
    }
    function bootstrap(ctx) {
      ctx = ctx || {};
      initSheetRows();
      var admin = !!ctx.admin, now = nowD(), S = settings(), dc = dueCtx(now);
      var lineOk = {};
      var lines = tbl('lines').filter(function (l) { if (admin || l.active) { lineOk[l.id] = 1; return true; } return false; }).sort(bySort);
      var keep = function (r) { return (admin || r.active) && has(lineOk, r.line_id); };
      var cf = new Date(now.getTime() - Math.max(7 * DAY, S.checklist_valid_hours * HOUR));
      var chBy = groupBy(logSince('checks', cf).filter(function (c) { return !c.void; }).sort(byTs), 'line_id');
      var status = {};
      lines.forEach(function (l) { status[l.id] = statusOf(l, dc.evBy[l.id] || [], chBy[l.id] || [], now, dc.from); });
      var units = tbl('units').filter(keep).sort(bySort).map(function (u) {
        var o = copy(u);
        o.hours = r2((u.hours_offset || 0) + (has(dc.cum, u.line_id) ? dc.cum[u.line_id] : 0) - (u.base_cum || 0));
        return o;
      });
      return {
        ok: true, version: VERSION, now: now, admin: admin,
        settings: publicSettings(admin),
        lines: lines.map(publicLine),
        units: units,
        items: tbl('items').filter(keep).sort(bySort).map(copy),
        meters: tbl('meters').filter(keep).sort(bySort).map(function (m) { return meterView(m, dc); }),
        rules: tbl('rules').filter(keep).sort(bySort).map(function (r) { return publicRule(r, admin); }),
        staff: tbl('staff').filter(function (s) { return admin || s.active; }).sort(bySort).map(function (s) { return publicStaff(s, admin); }),
        status: status,
        due: dueList(now),
        avg_h: copy(dc.avgH),
        avg_meter: copy(dc.avgM),
        config_issues: admin ? configIssues() : undefined
      };
    }
    function daysParam(v, def) { var n = toNum(v); return clamp(Math.round(n === null ? def : n), 1, 62); }
    function lineView(p) {
      var line = find('lines', p.line_id);
      if (!line) throw notFound('Лінію не знайдено: ' + toStr(p.line_id));
      var now = nowD(), K = kit(), days = daysParam(p.days, 14);
      var todayKey = K.key(now), fromKey = keyAdd(todayKey, -(days - 1)), from = K.start(fromKey);
      var evs = lineEvents(line.id, from);
      var mine = function (r) { return r.line_id === line.id && !r.void; };
      var checks = logSince('checks', from).filter(mine).sort(byTs);
      var works = logSince('works', from).filter(mine).sort(byTs);
      var readings = logSince('readings', from).filter(mine).sort(byTs);
      var segEvs = carryIn([line], (function () { var o = {}; o[line.id] = evs; return o; })(), from)[line.id] || evs;
      var segs = segments(line, segEvs, from, now), keys = [];
      for (var k = fromKey; k <= todayKey; k = keyAdd(k, 1)) keys.push(k);
      var dayList = keys.map(function (k) {
        var a = K.start(k).getTime(), b = K.start(keyAdd(k, 1)).getTime();
        var inDay = function (r) { var x = r.ts.getTime(); return x >= a && x < b; };
        return { day: k, hours: roundMap(clipHours(segs, a, Math.min(b, now.getTime()))),
          starts: segEvs.filter(function (e, i) { return inDay(e) && isStartAt(segEvs, i); }).length,
          checks: checks.filter(inDay).length };
      });
      return {
        ok: true, line_id: line.id, from: from, to: now,
        events: evs.slice().sort(descTs), checks: checks.slice().sort(descTs),
        works: works.slice().sort(descTs), readings: readings.slice().sort(descTs),
        timeline: segs.map(function (s) { return { state: s.state, from: s.from, to: s.to, hours: s.hours, product: s.product, reason: s.reason }; }),
        days: dayList
      };
    }
    function checkDetail(p) {
      var id = toStr(p.id);
      if (!id) throw bad('Не вказано ID чек-листа');
      var chk = locateLog('checks', id, asDate(p.ts));
      if (!chk) throw notFound('Чек-лист не знайдено: ' + id);
      var answers = answersOf(chk);
      var idx = function (a) { var m = /-(\d+)$/.exec(a.id); return m ? +m[1] : 0; };
      answers.sort(function (a, b) { return idx(a) - idx(b); });
      return { ok: true, check: chk, answers: answers };
    }
    var HIST_TYPES = ['events', 'checks', 'works', 'readings'];
    function histText(t, r) {
      switch (t) {
        case 'events': return [label('state', r.state), r.reason, r.product, r.operator, r.note, r.flag ? label('flag', r.flag) : ''].join(' ');
        case 'checks': return [label('occasion', r.occasion), label('check_result', r.result), r.operator, r.product, r.comment].join(' ');
        case 'works': return [label('work_type', r.work_type), r.title, r.description, r.cause, r.parts, r.params, r.product, r.performer].join(' ');
        default: {
          var m = find('meters', r.meter_id);
          return [m ? m.name : '', r.note, r.operator, String(r.value)].join(' ');
        }
      }
    }
    function history(p) {
      var now = nowD();
      var to = bound(p.to, true) || now, from = bound(p.from, false) || new Date(to.getTime() - 30 * DAY);
      var toExcl = isKey(p.to);
      var types = Array.isArray(p.types) ? p.types.map(toStr) : (isBlank(p.types) ? HIST_TYPES : String(p.types).split(/[,;\s]+/));
      types = types.filter(function (t) { return HIST_TYPES.indexOf(t) >= 0; });
      var limit = clamp(Math.round(toNum(p.limit) || 500), 1, 5000);
      var q = toStr(p.q).toLowerCase(), lineId = toStr(p.line_id), unitId = toStr(p.unit_id);
      var wt = isBlank(p.work_type) ? '' : toEnum('work_type', p.work_type);
      if (!isBlank(p.work_type) && !wt) throw bad('Невідомий вид роботи: ' + toStr(p.work_type));
      var includeVoid = !(p.include_void === false || p.include_void === 'false' || p.include_void === 0);
      var res = { ok: true, from: from, to: to, events: [], checks: [], works: [], readings: [],
        truncated: { events: false, checks: false, works: false, readings: false } };
      types.forEach(function (t) {
        var rows = logSince(t, from).filter(function (r) {
          var x = r.ts.getTime();
          if (toExcl ? x >= to.getTime() : x > to.getTime()) return false;
          if (!includeVoid && r.void) return false;
          if (lineId && r.line_id !== lineId) return false;
          if (unitId && (t === 'events' || t === 'checks' || r.unit_id !== unitId)) return false;
          if (wt && t === 'works' && r.work_type !== wt) return false;
          if (q && histText(t, r).toLowerCase().indexOf(q) < 0) return false;
          return true;
        }).sort(descTs);
        res.truncated[t] = rows.length > limit;
        res[t] = rows.slice(0, limit);
      });
      return res;
    }
    /* день заводу YYYY-MM-DD з параметра — лише справжня дата (не 2026-02-30), інакше '' */
    function dayParam(v) {
      if (!isKey(v)) return '';
      v = v.trim();
      return keyAdd(v, 0) === v ? v : '';
    }
    function dashboard(p) {
      p = p || {};
      var now = nowD(), K = kit(), todayKey = K.key(now), days = daysParam(p.days, 14);
      // необов'язковий період {from, to} (дні заводу, не довше 62 днів, не пізніше сьогодні); інакше — останні days днів
      var pf = dayParam(p.from), pt = dayParam(p.to);
      var toKey = pt && pt < todayKey ? pt : todayKey;
      var fromKey = pf && pf <= toKey ? pf : keyAdd(toKey, -(days - 1));
      if (keyDiff(fromKey, toKey) >= 62) fromKey = keyAdd(toKey, -61);
      var live = toKey === todayKey;
      var from = K.start(fromKey), end = live ? now : K.start(keyAdd(toKey, 1)), keys = [];
      for (var k = fromKey; k <= toKey; k = keyAdd(k, 1)) keys.push(k);
      var lines = activeLines(), data = loadWindow(from, lines), ids = lines.map(function (l) { return l.id; });
      var comp = complianceData(keys, lines, data, now);
      var status = {};
      // стан ліній і план ТО — завжди «зараз», незалежно від періоду
      lines.forEach(function (l) { status[l.id] = statusOf(l, data.evBy[l.id] || [], data.checkBy[l.id] || [], now, from); });
      return {
        ok: true, from: from, to: end, days: keys,
        compliance: comp, compliance_pct: compliancePct(comp),
        stats: statsData(from, end, lines, data, now),
        daily: dailyData(keys, lines, data, now),
        // межа минулого періоду виключна (issuesData бере ts ≤ to)
        issues: issuesData(from, live ? end : new Date(end.getTime() - 1), ids, data, 30),
        due: dueList(now),
        status: status
      };
    }
    function noticesList(p) {
      var limit = clamp(Math.round(toNum(p && p.limit) || 100), 1, 2000);
      return { ok: true, notices: logAll('notices').sort(descTs).slice(0, limit) };
    }

    /* ---------- WRITE: подія стану лінії ---------- */
    function startChecks(lineId, from, to) {
      var S = settings(), a = toMs(from) - S.checklist_valid_hours * HOUR, b = toMs(to) + FUTURE_SLACK;
      return logSince('checks', new Date(a)).filter(function (c) {
        return c.line_id === lineId && !c.void && c.occasion === 'start' && c.ts.getTime() <= b;
      });
    }
    /* чинний чек-лист запуску для запуску о ts: у вікні [ts − checklist_valid_hours, ts + 2 хв] і пізніший
       за останній перехід лінії в «Не працює» до запуску (offFn → мс, ліниво; -Infinity — не було) */
    function hasStartCheck(checks, ts, offFn) {
      var S = settings(), t = ts.getTime(), a = t - S.checklist_valid_hours * HOUR, b = t + FUTURE_SLACK, nb = -Infinity;
      checks.forEach(function (c) { var x = c.ts.getTime(); if (x >= a && x <= b && x > nb) nb = x; });
      if (nb === -Infinity) return false;
      return !offFn || offFn() < nb;
    }
    /* останній перехід лінії в «Не працює» не пізніше ref (подія — з урахуванням порядку byTs, або момент часу).
       Читаємо лише вікно чинності чек-листа: давніші переходи на чинність уже не впливають */
    function lastOffUpTo(lineId, ref) {
      var isEv = !!(ref && ref.ts), t = isEv ? ref.ts.getTime() : toMs(ref);
      var evs = lineEvents(lineId, new Date(t - settings().checklist_valid_hours * HOUR - FUTURE_SLACK));
      for (var i = evs.length - 1; i >= 0; i--) {
        var e = evs[i];
        if (isEv ? byTs(e, ref) > 0 : e.ts.getTime() > t) continue;
        if (isOffTr(e)) return e.ts.getTime();
      }
      return -Infinity;
    }
    /* позначка події: запуск без чинного чек-листа запуску → no_checklist (навіть коли клієнт просить 'forced');
       'forced' — запуск попри зауваження; завершення без чек-листа → no_end_checklist */
    function flagFor(e, prevState, isStart, wantForced, getChecks, offFn) {
      var S = settings();
      if (isStart && S.require_start_checklist && !hasStartCheck(getChecks(), e.ts, offFn)) return 'no_checklist';
      if (wantForced) return 'forced';
      if (e.state === 'off' && prevState !== 'off' && S.require_end_checklist && !e.ref_id) return 'no_end_checklist';
      return '';
    }
    function setLineCur(lineId, e, prodFallback) {
      patchRows('lines', [e ? {
        id: lineId, cur_state: e.state, cur_since: e.ts,
        // «Не працює» без продукту зберігає останній продукт лінії (підказка для наступного запуску)
        cur_product: e.product || (e.state === 'off' ? (prodFallback || '') : ''),
        cur_operator: e.operator || '', cur_event: e.id, cur_cum_h: e.cum_h || 0, cur_starts: e.starts || 0
      } : {
        id: lineId, cur_state: 'off', cur_since: null, cur_product: '', cur_operator: '', cur_event: '', cur_cum_h: 0, cur_starts: 0
      }]);
    }
    /* перерахунок послідовності подій після опорної (anchor); ranAtAnchor — чи працювала лінія після
       останнього «Не працює» станом на опорну подію. Повертає {changed, from}: from — найраніший момент,
       з якого змінилися мотогодини лінії (Infinity — не змінилися). */
    function recomputeSeq(line, anchor, list, ranAtAnchor) {
      list = list.slice().sort(byTs);
      var checks = null;
      var getChecks = function () {
        if (!checks) checks = list.length ? startChecks(line.id, list[0].ts, list[list.length - 1].ts) : [];
        return checks;
      };
      var prev = anchor ? { state: anchor.state, ts: anchor.ts, cum_h: anchor.cum_h || 0, starts: anchor.starts || 0 } : null;
      var ran = anchor ? !!ranAtAnchor : false;
      var patches = [], from = Infinity;
      // останній перехід в «Не працює»: серед перерахованих подій, інакше — до опорної події включно (ліниво)
      var lastOff = null, offPrev = null;
      var offAt = function () {
        if (lastOff !== null) return lastOff;
        if (offPrev === null) offPrev = anchor ? lastOffUpTo(line.id, anchor) : -Infinity;
        return offPrev;
      };
      list.forEach(function (e, i) {
        var ps = prev ? prev.state : 'off';
        var cum = prev ? r4(prev.cum_h + (prev.state === 'run' ? (e.ts.getTime() - prev.ts.getTime()) / HOUR : 0)) : 0;
        var start = e.state === 'run' && !ran;
        var st = (prev ? prev.starts : 0) + (start ? 1 : 0);
        var fl = flagFor(e, ps, start, e.flag === 'forced', getChecks, offAt);
        if (e.state === 'off' && ps !== 'off') lastOff = e.ts.getTime();
        var cumChanged = e.prev_state !== ps || e.cum_h === null || Math.abs(e.cum_h - cum) > 1e-4;
        if (cumChanged || e.starts !== st || e.flag !== fl) {
          patches.push({ id: e.id, prev_state: ps, cum_h: cum, starts: st, flag: fl });
          if (cumChanged) from = Math.min(from, i > 0 ? list[i - 1].ts.getTime() : (anchor ? anchor.ts.getTime() : -Infinity));
          e.prev_state = ps; e.cum_h = cum; e.starts = st; e.flag = fl;
        }
        prev = { state: e.state, ts: e.ts, cum_h: cum, starts: st };
        if (e.state === 'off') ran = false;
        else if (e.state === 'run' || e.state === 'stop') ran = true;
      });
      patchRows('events', patches);
      var last = list.length ? list[list.length - 1] : anchor;
      // останній відомий продукт — для «Не працює» без продукту
      var prod = '';
      for (var k = list.length - 2; k >= -1 && !prod; k--) {
        var pe = k >= 0 ? list[k] : anchor;
        if (pe && pe.product) prod = pe.product;
      }
      if (!prod && anchor) prod = line.cur_product || '';
      var old = lineCurSnap(line);
      if (!old !== !last || (old && last && (old.ts.getTime() !== last.ts.getTime() || old.state !== last.state ||
          Math.abs(old.cum_h - (last.cum_h || 0)) > 1e-4))) {
        from = Math.min(from, old ? old.ts.getTime() : Infinity, last ? last.ts.getTime() : Infinity);
      }
      setLineCur(line.id, last || null, prod);
      return { changed: patches.length, from: from };
    }
    /* похідні знімки мотогодин після зміни журналу подій лінії з моменту from:
       works.hours_at (і rules.last_hours для останньої роботи регламенту) — точно за новими подіями;
       units.base_cum / rules.base_hours (відлік, взятий на дату створення / «Відлік від дати») —
       зсуваються на різницю нових і старих мотогодин на цю дату (коли відома стара функція oldFn). */
    function refreshSnaps(lineId, from, oldFn, allWorks, lineEvs) {
      if (from === null || from === undefined || from === Infinity) return;
      var line = find('lines', lineId);
      if (!line) return;
      var all = !isFinite(from), f = all ? -Infinity : from;
      var evs = lineEvs || lineEvents(line.id, all ? null : new Date(f));
      var newFn = cumFnOf(evs, lineCurSnap(line));
      var src = allWorks || (all ? logAll('works') : logSince('works', new Date(f)));
      var wp = [], rp = [], up = [];
      src.forEach(function (w) {
        if (w.line_id !== line.id || w.void || w.ts.getTime() < f) return;
        var h = newFn(w.ts);
        if (w.hours_at !== null && Math.abs(w.hours_at - h) <= 1e-4) return;
        wp.push({ id: w.id, hours_at: h });
        w.hours_at = h;
        var r = w.rule_id ? find('rules', w.rule_id) : null;
        if (r && r.last_work_id === w.id) rp.push({ id: r.id, last_hours: h });
      });
      if (oldFn) {
        tbl('units').forEach(function (u) {
          if (u.line_id !== line.id || !u.created || u.created.getTime() < f || u.base_cum === null) return;
          var d = newFn(u.created) - oldFn(u.created);
          if (Math.abs(d) > 1e-4) up.push({ id: u.id, base_cum: r4(u.base_cum + d) });
        });
        tbl('rules').forEach(function (r) {
          if (r.line_id !== line.id || r.last_date || !r.base_date || r.base_date.getTime() < f || r.base_hours === null) return;
          var d = newFn(r.base_date) - oldFn(r.base_date);
          if (Math.abs(d) > 1e-4) rp.push({ id: r.id, base_hours: r4(r.base_hours + d) });
        });
      }
      patchRows('works', wp);
      patchRows('rules', rp);
      patchRows('units', up);
    }
    function recomputeLineI(lineId, allEvents, opt) {
      opt = opt || {};
      var line = find('lines', lineId);
      if (!line) throw notFound('Лінію не знайдено: ' + toStr(lineId));
      var list = (allEvents ? allEvents.filter(function (e) { return e.line_id === line.id && !e.void; }) : lineEvents(line.id, null)).sort(byTs);
      var res = recomputeSeq(line, null, list, false);
      var from = Math.min(res.from, opt.from === undefined ? Infinity : opt.from);
      refreshSnaps(line.id, from, opt.oldFn || null, opt.works || null, list);
      return { ok: true, line_id: line.id, events: list.length, changed: res.changed };
    }
    /* перерахунок подій лінії від моменту T (анулювання): опорна подія — остання раніше T у вікні ORDER_WINDOW,
       як для подій «із минулого»; без опори у вікні — уся історія. win — уже прочитані події лінії від T − ORDER_WINDOW */
    function recomputeFromI(line, T, oldFn, win) {
      var t = toMs(T);
      var list = (win || lineEvents(line.id, new Date(t - ORDER_WINDOW))).filter(function (e) { return !e.void; }).sort(byTs);
      var idx = -1;
      for (var i = 0; i < list.length; i++) if (list[i].ts.getTime() < t) idx = i;
      var ran = idx >= 0 ? ranBefore(list, idx) : null;
      if (ran === null) return recomputeLineI(line.id, null, { from: t, oldFn: oldFn || null });
      var res = recomputeSeq(line, list[idx], list.slice(idx + 1), ran);
      refreshSnaps(line.id, Math.min(t, res.from), oldFn || null, null, list);
      return { ok: true, line_id: line.id, events: list.length, changed: res.changed };
    }
    /* чи працювала лінія після останнього «Не працює» до моменту ts (для переходу в «Працює» не з off/run/stop) */
    function ranSinceOff(line, ts) {
      var l1 = lineEvents(line.id, new Date(ts.getTime() - 2 * DAY));
      var r = ranBefore(l1, l1.length - 1);
      if (r === null) { l1 = lineEvents(line.id, new Date(ts.getTime() - ORDER_WINDOW)); r = ranBefore(l1, l1.length - 1); }
      return !!r;
    }
    /* повтор уже записаної події: якщо похідне оновлення тоді не відбулося (збій після вставки) — відновлюємо */
    function repairDup(line, dup) {
      var evs = lineEvents(line.id, dup.ts), i = -1, k;
      for (k = 0; k < evs.length; k++) if (evs[k].id === dup.id) i = k;
      if (i < 0) return;
      var nx = evs[i + 1], ok;
      if (nx) {
        var exp = r4((dup.cum_h || 0) + (dup.state === 'run' ? (nx.ts.getTime() - dup.ts.getTime()) / HOUR : 0));
        ok = nx.prev_state === dup.state && nx.cum_h !== null && Math.abs(nx.cum_h - exp) <= 1e-4;
      } else ok = line.cur_event === dup.id;
      if (ok) return;
      var list = lineEvents(line.id, new Date(dup.ts.getTime() - ORDER_WINDOW)), p = -1;
      for (k = 0; k < list.length; k++) if (list[k].id === dup.id) p = k;
      if (p <= 0) { list = lineEvents(line.id, null); p = -1; for (k = 0; k < list.length; k++) if (list[k].id === dup.id) p = k; }
      if (p < 0) return;
      var anchor = p > 0 ? list[p - 1] : null;
      var res = recomputeSeq(line, anchor, list.slice(p), anchor ? ranBefore(list, p - 1) : false);
      refreshSnaps(line.id, Math.min(dup.ts.getTime(), res.from), null, null, list);
    }
    function addEvent(p, ctx) {
      p = p || {}; ctx = ctx || {};
      var S = settings(), now = nowD();
      var line = find('lines', p.line_id);
      if (!line) throw notFound('Лінію не знайдено: ' + toStr(p.line_id));
      var state = toEnum('state', p.state);
      if (!state) throw bad('Невідомий стан лінії: ' + toStr(p.state));
      var ts = clampTs(p.ts, now, MAX_BACKDATE);
      var id = cleanId(p.id, 'id') || env.uuid();
      var dup = findLog('events', id, ts);
      if (dup) {
        if (!dup.void && dup.line_id === line.id) repairDup(line, dup);
        return { ok: true, event: dup, status: statusFor(line.id, now), duplicate: true };
      }
      var ev = blank('events');
      assign(ev, {
        id: id, ts: ts, line_id: line.id, state: state, reason: txt(p.reason, 300), product: txt(p.product, 200),
        operator: txt(p.operator, 120), staff_id: refId(p.staff_id), note: txt(p.note, 2000), ref_id: refId(p.ref_id),
        device: dev(ctx, p), created: now, 'void': false
      });
      var fast = !line.cur_since || ts.getTime() >= line.cur_since.getTime();
      var prev = null, anchor = null, after = [], list = null, idx = -1, ran = false, oldFn = null;
      if (fast) {
        if (line.cur_since) {
          prev = { state: line.cur_state || 'off', ts: line.cur_since, cum_h: line.cur_cum_h || 0,
            starts: line.cur_starts || 0, product: line.cur_product, operator: line.cur_operator };
        }
        if (state === 'run' && prev && prev.state !== 'off') {
          ran = prev.state === 'run' || prev.state === 'stop' ? true : ranSinceOff(line, ts);
        }
      } else {
        // подія «із минулого» (офлайн-черга): знаходимо опорну подію та перераховуємо наступні
        list = lineEvents(line.id, new Date(ts.getTime() - ORDER_WINDOW));
        var lastLE = function (arr) { var k = -1; for (var i = 0; i < arr.length; i++) if (arr[i].ts.getTime() <= ts.getTime()) k = i; return k; };
        idx = lastLE(list);
        if (idx < 0) { list = lineEvents(line.id, null); idx = lastLE(list); }
        oldFn = cumFnOf(list, lineCurSnap(line));
        anchor = idx >= 0 ? list[idx] : null;
        after = list.slice(idx + 1);
        ran = anchor ? !!ranBefore(list, idx) : false;
        if (anchor) prev = { state: anchor.state, ts: anchor.ts, cum_h: anchor.cum_h || 0, starts: anchor.starts || 0,
          product: anchor.product, operator: anchor.operator };
      }
      var isStart = state === 'run' && !ran;
      ev.prev_state = prev ? prev.state : 'off';
      ev.cum_h = prev ? r4(prev.cum_h + (prev.state === 'run' ? (ts.getTime() - prev.ts.getTime()) / HOUR : 0)) : 0;
      ev.starts = (prev ? prev.starts : 0) + (isStart ? 1 : 0);
      if (!ev.product && state !== 'off' && prev) ev.product = prev.product || '';
      if (!ev.operator && prev) ev.operator = prev.operator || '';
      ev.flag = flagFor(ev, ev.prev_state, isStart, isTrue(p.forced), function () { return startChecks(line.id, ts, ts); },
        function () { return lastOffUpTo(line.id, ts); });
      insertRows('events', [ev]);
      if (fast) {
        setLineCur(line.id, ev, line.cur_product);
        // подія, що надійшла із запізненням (офлайн-черга) і змінює «працює / не працює»: оновлюємо знімки мотогодин
        var runChange = prev ? (prev.state === 'run') !== (state === 'run') : state === 'run';
        if (runChange && ts.getTime() < now.getTime() - FUTURE_SLACK) {
          var p0 = prev;
          refreshSnaps(line.id, ts.getTime(), function (T) {
            return p0 ? r4(p0.cum_h + (p0.state === 'run' ? Math.max(0, toMs(T) - p0.ts.getTime()) / HOUR : 0)) : 0;
          });
        }
      } else {
        var res0 = recomputeSeq(find('lines', line.id), anchor, after.concat([ev]), ran);
        refreshSnaps(line.id, Math.min(ts.getTime(), res0.from), oldFn, null, list.slice(0, idx + 1).concat(after, [ev]).sort(byTs));
      }
      var res = { ok: true, event: ev, status: statusFor(line.id, now) };
      if (state === 'repair' && S.instant_repair) res._notify = [noticeRepair(find('lines', line.id), ev)];
      return res;
    }

    /* ---------- WRITE: чек-лист ---------- */
    function normCheckValue(v) {
      if (v === true || v === 1) return 'ok';
      if (v === false || v === 0) return 'fail';
      if (isBlank(v)) return '';
      var s = String(v).trim().toLowerCase();
      if (['ok', 'true', '✓', '✔', 'норма', 'так', 'yes', '1'].indexOf(s) >= 0) return 'ok';
      if (['fail', 'false', '✗', '✘', 'зауваження', 'ні', 'no', '0', 'bad'].indexOf(s) >= 0) return 'fail';
      if (['na', 'н/з', 'n/a', '-', '—', 'нз', 'не застосовно'].indexOf(s) >= 0) return 'na';
      return '';
    }
    function evalAnswer(it, a) {
      var r = { answered: false, ok: null, value: '', num: null };
      if (!a) return r;
      var v = a.value;
      if (it.type === 'check') {
        var code = normCheckValue(v);
        if (!code) return r;
        r.answered = true;
        r.ok = code === 'ok' ? true : code === 'fail' ? false : null;
        r.value = LABELS.check_value[code];
      } else if (it.type === 'number') {
        var n = toNum(v);
        if (n === null) return r;
        r.answered = true;
        r.num = n;
        r.ok = (it.min === null || n >= it.min) && (it.max === null || n <= it.max);
        r.value = String(n).replace('.', ',');
      } else if (it.type === 'select') {
        var s = toStr(v).replace(/^!/, '').trim().toLowerCase();
        if (!s) return r;
        for (var i = 0; i < it.options.length; i++) {
          var o = it.options[i], bare = o.replace(/^!/, '').trim();
          if (bare.toLowerCase() === s) { r.answered = true; r.ok = o.charAt(0) !== '!'; r.value = bare; return r; }
        }
      } else {
        var t = txt(v, 2000);
        if (t) { r.answered = true; r.ok = true; r.value = t; }
      }
      return r;
    }
    function checklistItems(lineId, occ) {
      return tbl('items').filter(function (it) {
        if (!it.active || it.line_id !== lineId || it.occasions.indexOf(occ) < 0) return false;
        if (it.unit_id) { var u = find('units', it.unit_id); if (!u || !u.active) return false; }
        return true;
      }).sort(bySort);
    }
    /* чек-лист запуску, що надійшов ПІСЛЯ події запуску (інший пристрій / черга): знімаємо «Запуск без чек-листа»
       з запусків, які він покриває (ts у [чек-лист − 2 хв, чек-лист + checklist_valid_hours] і до першого
       переходу лінії в «Не працює» після чек-листа) */
    function clearNoChecklist(line, cts) {
      var S = settings();
      if (!S.require_start_checklist || !line) return;
      var c = cts.getTime(), a = c - FUTURE_SLACK, b = c + S.checklist_valid_hours * HOUR;
      if (!line.cur_since || line.cur_since.getTime() < a) return;          // подій після чек-листа немає
      var evs = logSince('events', new Date(a)).filter(function (e) {
        return e.line_id === line.id && !e.void && e.ts.getTime() <= b;
      }).sort(byTs);
      var ps = [];
      for (var i = 0; i < evs.length; i++) {
        var e = evs[i];
        if (e.flag === 'no_checklist') ps.push({ id: e.id, flag: '' });
        if (isOffTr(e) && e.ts.getTime() >= c) break;                      // робота завершилася — далі чек-лист не чинний
      }
      patchRows('events', ps);
    }
    function addChecklist(p, ctx) {
      p = p || {}; ctx = ctx || {};
      var S = settings(), now = nowD();
      var line = find('lines', p.line_id);
      if (!line) throw notFound('Лінію не знайдено: ' + toStr(p.line_id));
      var occ = toEnum('occasion', p.occasion);
      if (!occ) throw bad('Невідомий тип чек-листа: ' + toStr(p.occasion));
      var ts = clampTs(p.ts, now, MAX_BACKDATE);
      var started = asDate(p.started);
      if (!isBlank(p.started) && !started) throw bad('Невірний час початку чек-листа');
      if (!started || started.getTime() > ts.getTime()) started = started ? new Date(ts.getTime()) : null;
      var id = cleanId(p.id, 'id') || env.uuid();
      var te = p.then_event && typeof p.then_event === 'object' && !isBlank(p.then_event.state) ? p.then_event : null;
      var teState = te ? toEnum('state', te.state) : '';
      if (te && !teState) throw bad('Невідомий стан лінії: ' + toStr(te.state));
      var teId = te ? (cleanId(te.id, 'then_event.id') || id + '-e') : '';
      if (te && !isBlank(te.ts)) clampTs(te.ts, now, MAX_BACKDATE);     // перевірка до запису (атомарність)
      // показники перевіряються ДО запису чек-листа: після вставки ніщо не повинно кидати BAD_REQUEST
      var rds = [], skipped = [];
      (Array.isArray(p.readings) ? p.readings : []).forEach(function (r, i) {
        if (!r || typeof r !== 'object') return;
        var m = find('meters', r.meter_id), v = toNum(r.value);
        var md = isBlank(r.mode) ? '' : toEnum('meter_mode', r.mode);
        if (!m || v === null || v < 0 || (!isBlank(r.mode) && !md)) {
          skipped.push({ meter_id: toStr(r.meter_id), value: toStr(r.value), mode: toStr(r.mode) });
          return;
        }
        rds.push({ id: cleanId(r.id, 'readings.id') || id + '-r' + (i + 1), meter_id: m.id, value: v, mode: md, note: r.note });
      });
      var res, dup = findLog('checks', id, ts);
      if (dup) {
        res = { ok: true, check: dup, duplicate: true };
      } else {
        var items = checklistItems(line.id, occ), given = {};
        (Array.isArray(p.answers) ? p.answers : []).forEach(function (a) { if (a && !isBlank(a.item_id)) given[toStr(a.item_id)] = a; });
        var missing = 0, failed = 0, oor = 0, na = 0, crit = false, rows = [];
        items.forEach(function (it, i) {
          var a = given[it.id], r = evalAnswer(it, a), note = a ? txt(a.note, 1000) : '';
          var isNa = r.answered && r.ok === null;
          if (isNa) na++;
          // «Н/З» для критичного пункту (безпека, санобробка) не підтверджує його — це зауваження;
          // для обовʼязкового — лише з поясненням у примітці, інакше це пропущена перевірка — теж зауваження
          if (isNa && (it.critical || (it.required && !note))) r.ok = false;
          if (!r.answered && it.required) missing++;
          if (it.type === 'check' && r.ok === false) failed++;
          if ((it.type === 'number' || it.type === 'select') && r.ok === false) oor++;
          if (it.critical && r.ok === false) crit = true;
          if (r.answered || note || it.required) {
            rows.push(assign(blank('answers'), {
              id: id + '-' + (i + 1), check_id: id, ts: ts, line_id: line.id, unit_id: it.unit_id, item_id: it.id,
              section: it.section, text: it.text, type: it.type, value: r.value, num_value: r.num,
              unit_label: it.unit_label, min: it.min, max: it.max, ok: r.answered ? r.ok : null, note: note, 'void': false
            }));
          }
        });
        var chk = assign(blank('checks'), {
          id: id, ts: ts, started: started, line_id: line.id, occasion: occ, operator: txt(p.operator, 120),
          staff_id: refId(p.staff_id), product: txt(p.product, 200),
          result: missing > 0 || crit ? 'fail' : (failed + oor > 0 ? 'remarks' : 'ok'),
          total: items.length, failed: failed, out_of_range: oor, missing: missing, na: na, comment: txt(p.comment, 2000),
          device: dev(ctx, p), created: now, 'void': false
        });
        insertRows('checks', [chk]);
        insertRows('answers', rows);
        if (occ === 'start') clearNoChecklist(find('lines', line.id), ts);
        res = { ok: true, check: chk };
        if (chk.result !== 'ok' && S.instant_checklist) res._notify = [noticeChecklist(line, chk, rows)];
      }
      var check = res.check;
      if (rds.length) {
        res.readings = rds.map(function (r) {
          return addReadingI({ id: r.id, ts: check.ts, meter_id: r.meter_id, value: r.value, mode: r.mode,
            operator: check.operator, event_id: teId, note: r.note }, ctx, MAX_BACKDATE_WORK).reading;
        });
      }
      if (skipped.length) res.readings_skipped = skipped;
      if (te) {
        var er = addEvent({ id: teId, ts: isBlank(te.ts) ? check.ts : te.ts, line_id: line.id, state: teState,
          reason: te.reason, product: isBlank(te.product) ? check.product : te.product, operator: check.operator,
          staff_id: check.staff_id, note: te.note, ref_id: check.id,
          forced: isTrue(p.forced) && check.result !== 'ok' }, ctx);
        res.event = er.event;
        res.status = er.status;
        if (er._notify) res._notify = (res._notify || []).concat(er._notify);
      }
      if (!res.status) res.status = statusFor(line.id, now);
      return res;
    }

    /* ---------- WRITE: робота (ТО, ремонт, налаштування …) ---------- */
    function addWork(p, ctx) {
      p = p || {}; ctx = ctx || {};
      var now = nowD();
      var line = find('lines', p.line_id);
      if (!line) throw notFound('Лінію не знайдено: ' + toStr(p.line_id));
      var rule = null;
      if (!isBlank(p.rule_id)) {
        rule = find('rules', p.rule_id);
        if (!rule) throw notFound('Регламент не знайдено: ' + toStr(p.rule_id));
        if (rule.line_id !== line.id) throw bad('Регламент належить іншій лінії');
      }
      var wt = isBlank(p.work_type) ? (rule ? rule.work_type : '') : toEnum('work_type', p.work_type);
      if (!wt) throw bad('Невідомий вид роботи: ' + toStr(p.work_type));
      var unitId = toStr(p.unit_id) || (rule ? rule.unit_id : '');
      if (unitId) {
        var u = find('units', unitId);
        if (!u) throw notFound('Агрегат не знайдено: ' + unitId);
        if (u.line_id !== line.id) throw bad('Агрегат належить іншій лінії');
      }
      var status = isBlank(p.status) ? 'done' : toEnum('work_status', p.status);
      if (!status) throw bad('Невідомий статус роботи: ' + toStr(p.status));
      var ts = clampTs(p.ts, now, MAX_BACKDATE_WORK);
      var started = asDate(p.started);
      if (started && started.getTime() > ts.getTime()) started = new Date(ts.getTime());
      var id = cleanId(p.id, 'id') || env.uuid();
      var meter = null;
      if (!isBlank(p.meter_id)) {
        meter = find('meters', p.meter_id);
        if (!meter) throw notFound('Лічильник не знайдено: ' + toStr(p.meter_id));
      } else if (rule && rule.meter_id) meter = find('meters', rule.meter_id);
      var mv = toNum(p.meter_value);
      if (!isBlank(p.meter_value) && (mv === null || mv < 0)) throw bad('Невірний показник лічильника');
      var dup = findLog('works', id, ts);
      if (dup) {
        // повтор після збою: похідні оновлення (показник, last_* регламенту) виконуються ідемпотентно
        var rd = { ok: true, work: dup, duplicate: true };
        if (!dup.void) {
          if (meter && mv !== null) {
            rd.reading = addReadingI({ id: id + '-m', ts: dup.ts, meter_id: meter.id, value: mv, mode: 'abs', operator: dup.performer,
              note: 'Показник під час роботи «' + dup.title + '»' }, ctx, MAX_BACKDATE_WORK).reading;
          }
          var rl = rule ? find('rules', rule.id) : null;
          if (rl && dup.rule_id === rl.id && dup.status === 'done' && rl.last_work_id !== dup.id &&
              (!rl.last_date || dup.ts.getTime() >= rl.last_date.getTime())) {
            patchRows('rules', [{ id: rl.id, last_date: dup.ts, last_hours: dup.hours_at, last_meter: dup.meter_at, last_work_id: dup.id }]);
          }
        }
        if (rule) rd.due = computeDue(find('rules', rule.id), dueCtx(nowD()));
        return rd;
      }
      var dur = toNum(p.duration_min), down = toNum(p.downtime_min);
      if (dur === null && started) dur = Math.round((ts.getTime() - started.getTime()) / MIN);
      if ((dur !== null && dur < 0) || (down !== null && down < 0)) throw bad('Тривалість не може бути відʼємною');
      var w = assign(blank('works'), {
        id: id, ts: ts, started: started, line_id: line.id, unit_id: unitId, work_type: wt, rule_id: rule ? rule.id : '',
        title: txt(p.title, 300) || (rule ? rule.title : label('work_type', wt)), description: txt(p.description, 4000),
        cause: txt(p.cause, 1000), parts: txt(p.parts, 1000), params: txt(p.params, 2000), product: txt(p.product, 200),
        performer: txt(p.performer, 120), staff_id: refId(p.staff_id), duration_min: dur, downtime_min: down,
        hours_at: cumAt(line, ts), meter_at: meter ? (mv !== null ? mv : meterValueAt(meter, ts)) : mv,
        status: status, device: dev(ctx, p), created: now, 'void': false
      });
      insertRows('works', [w]);
      var res = { ok: true, work: w };
      if (meter && mv !== null) {
        res.reading = addReadingI({ id: id + '-m', ts: ts, meter_id: meter.id, value: mv, mode: 'abs', operator: w.performer,
          note: 'Показник під час роботи «' + w.title + '»' }, ctx, MAX_BACKDATE_WORK).reading;
      }
      if (rule && status === 'done' && (!rule.last_date || ts.getTime() >= rule.last_date.getTime())) {
        patchRows('rules', [{ id: rule.id, last_date: ts, last_hours: w.hours_at, last_meter: w.meter_at, last_work_id: id }]);
      }
      if (rule) res.due = computeDue(find('rules', rule.id), dueCtx(nowD()));
      return res;
    }

    /* ---------- WRITE: показник лічильника ---------- */
    function addReading(p, ctx) { return addReadingI(p, ctx, MAX_BACKDATE); }
    function addReadingI(p, ctx, maxBack) {
      p = p || {}; ctx = ctx || {};
      var now = nowD();
      var m = find('meters', p.meter_id);
      if (!m) throw notFound('Лічильник не знайдено: ' + toStr(p.meter_id));
      var v = toNum(p.value);
      if (v === null) throw bad('Показник має бути числом');
      if (v < 0) throw bad('Показник не може бути відʼємним');
      var mode = isBlank(p.mode) ? (m.mode || 'abs') : toEnum('meter_mode', p.mode);
      if (!mode) throw bad('Невідомий тип обліку: ' + toStr(p.mode));
      var ts = clampTs(p.ts, now, maxBack);
      var id = cleanId(p.id, 'id') || env.uuid();
      var dup = findLog('readings', id, ts);
      if (dup) {
        // повтор після збою: поточне значення лічильника не оновилося — застосовуємо показник зараз
        if (!dup.void && dup.meter_id === m.id && (!m.cur_ts || dup.ts.getTime() > m.cur_ts.getTime())) {
          var dm = dup.mode || m.mode || 'abs';
          patchRows('meters', [{ id: m.id, cur_value: r4(dm === 'inc' ? (m.cur_value || 0) + (dup.value || 0) : (dup.value || 0)), cur_ts: dup.ts }]);
        }
        return { ok: true, reading: dup, meter: meterView(find('meters', m.id)), duplicate: true };
      }
      var r = assign(blank('readings'), {
        id: id, ts: ts, meter_id: m.id, line_id: m.line_id, unit_id: m.unit_id, value: v, mode: mode,
        operator: txt(p.operator, 120), event_id: refId(p.event_id), note: txt(p.note, 1000), device: dev(ctx, p),
        created: now, 'void': false
      });
      insertRows('readings', [r]);
      if (!m.cur_ts || ts.getTime() >= m.cur_ts.getTime()) {
        patchRows('meters', [{ id: m.id, cur_value: r4(mode === 'inc' ? (m.cur_value || 0) + v : v), cur_ts: ts }]);
      } else {
        // показник «із минулого»: поточне значення змінюється, лише якщо після нього немає накопичувального показника
        // (читаємо показники лише від ts, без усього журналу)
        var later = logSince('readings', ts).filter(function (x) {
          return x.meter_id === m.id && !x.void && x.id !== id && x.ts.getTime() > ts.getTime();
        });
        var absLater = later.some(function (x) { return (x.mode || m.mode || 'abs') !== 'inc'; });
        if (!absLater) {
          var incs = 0;
          later.forEach(function (x) { incs += x.value || 0; });
          patchRows('meters', [{ id: m.id, cur_value: r4(mode === 'inc' ? (m.cur_value || 0) + v : v + incs), cur_ts: m.cur_ts }]);
        }
      }
      return { ok: true, reading: r, meter: meterView(find('meters', m.id)) };
    }
    function recomputeMeterI(id, allReadings) {
      var m = find('meters', id);
      if (!m) throw notFound('Лічильник не знайдено: ' + toStr(id));
      var rs = (allReadings || logAll('readings')).filter(function (r) { return r.meter_id === m.id && !r.void; }).sort(byTs);
      var v = rs.length ? r4(walkMeter(rs, m.mode)) : null;
      patchRows('meters', [{ id: m.id, cur_value: v, cur_ts: rs.length ? rs[rs.length - 1].ts : null }]);
      return { ok: true, meter_id: m.id, value: v };
    }
    function recomputeRuleI(id, allWorks) {
      var r = find('rules', id);
      if (!r) throw notFound('Регламент не знайдено: ' + toStr(id));
      var ws = (allWorks || logAll('works')).filter(function (w) {
        return w.rule_id === r.id && !w.void && w.status === 'done';
      }).sort(byTs);
      var last = ws.length ? ws[ws.length - 1] : null;
      var lh = last ? last.hours_at : null, lm = last ? last.meter_at : null;
      if (last) {
        // робота без знімків (напр. внесена прямо в таблицю) — рахуємо один раз і зберігаємо в журналі,
        // щоб розрахунок строків не відтворював історію при кожному bootstrap
        var wp = { id: last.id }, fix = false, ln = find('lines', last.line_id || r.line_id);
        var mt = r.meter_id ? find('meters', r.meter_id) : null;
        if (lh === null && ln) { lh = cumAt(ln, last.ts); wp.hours_at = lh; fix = true; }
        if (lm === null && mt) { lm = r4(meterValueAt(mt, last.ts)); wp.meter_at = lm; fix = true; }
        if (fix) { patchRows('works', [wp]); last.hours_at = lh; last.meter_at = lm; }
      }
      patchRows('rules', [{ id: r.id, last_date: last ? last.ts : null, last_hours: lh,
        last_meter: lm, last_work_id: last ? last.id : '' }]);
      return { ok: true, rule_id: r.id, last_date: last ? last.ts : null };
    }
    function recomputeAll() {
      var evs = logAll('events'), ws = logAll('works'), rs = logAll('readings');
      var n = { lines: 0, rules: 0, meters: 0 };
      // спершу лічильники (meter_at робіт без знімка), далі лінії (мотогодини подій і робіт), потім регламенти
      tbl('meters').slice().forEach(function (m) { recomputeMeterI(m.id, rs); });
      tbl('lines').slice().forEach(function (l) { recomputeLineI(l.id, evs, { from: -Infinity, works: ws }); n.lines++; });
      tbl('rules').slice().forEach(function (r) { recomputeRuleI(r.id, ws); n.rules++; });
      n.meters = tbl('meters').length;
      return { ok: true, lines: n.lines, rules: n.rules, meters: n.meters };
    }

    /* ---------- ADMIN ---------- */
    function sameVal(a, b) {
      if (isDate(a) || isDate(b)) return isDate(a) && isDate(b) && a.getTime() === b.getTime();
      if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
      return a === b;
    }
    function nextSort(t, o) {
      var max = 0;
      tbl(t).forEach(function (r) { if ((!o.line_id || r.line_id === o.line_id) && r.sort > max) max = r.sort; });
      return Math.floor(max / 10) * 10 + 10;
    }
    function validateRow(t, o) {
      var need = function (v, msg) { if (isBlank(v) || (Array.isArray(v) && !v.length)) throw bad(msg); };
      var lineOf = function (id) {
        need(id, 'Оберіть лінію');
        if (!find('lines', id)) throw bad('Лінію не знайдено: ' + id);
      };
      var unitOf = function (id, lineId) {
        if (!id) return;
        var u = find('units', id);
        if (!u) throw bad('Агрегат не знайдено: ' + id);
        if (u.line_id !== lineId) throw bad('Агрегат «' + u.name + '» належить іншій лінії');
      };
      var nonNeg = function (v, name) { if (v !== null && v !== undefined && v < 0) throw bad('Поле «' + name + '» не може бути відʼємним'); };
      switch (t) {
        case 'lines':
          need(o.name, 'Вкажіть назву лінії');
          break;
        case 'units':
          need(o.name, 'Вкажіть назву агрегату');
          lineOf(o.line_id);
          nonNeg(o.hours_offset, 'Мотогодини до початку обліку');
          if (o.year !== null && (o.year < 1900 || o.year > 2100)) throw bad('Невірний рік випуску');
          break;
        case 'items':
          need(o.text, 'Вкажіть текст пункту');
          lineOf(o.line_id);
          unitOf(o.unit_id, o.line_id);
          if (!o.type) o.type = 'check';
          if (!o.occasions.length) o.occasions = ['start'];
          if (o.min !== null && o.max !== null && o.min > o.max) throw bad('Мінімум більший за максимум');
          if (o.type === 'select' && !o.options.length) throw bad('Для пункту «Вибір» задайте варіанти через крапку з комою');
          break;
        case 'meters':
          need(o.name, 'Вкажіть назву лічильника');
          lineOf(o.line_id);
          unitOf(o.unit_id, o.line_id);
          if (!o.mode) o.mode = 'abs';
          break;
        case 'rules': {
          need(o.title, 'Вкажіть назву роботи');
          lineOf(o.line_id);
          unitOf(o.unit_id, o.line_id);
          if (!o.work_type) o.work_type = 'to';
          nonNeg(o.interval_days, 'Інтервал, днів');
          nonNeg(o.interval_hours, 'Інтервал, мотогодин');
          nonNeg(o.interval_meter, 'Інтервал за лічильником');
          nonNeg(o.warn_days, 'Попереджати за, днів');
          if (o.warn_pct !== null) o.warn_pct = pctVal(o.warn_pct);            // 0,9 (= «90%» з таблиці) → 90
          if (o.warn_pct !== null && (o.warn_pct < 0 || o.warn_pct > 100)) throw bad('«Попереджати з, %» — від 0 до 100');
          if (o.interval_meter > 0 && !o.meter_id) throw bad('Для інтервалу за лічильником оберіть лічильник');
          if (o.meter_id) {
            var m = find('meters', o.meter_id);
            if (!m) throw bad('Лічильник не знайдено: ' + o.meter_id);
            if (m.line_id !== o.line_id) throw bad('Лічильник належить іншій лінії');
          }
          var emails = toEmails(o.notify), wrong = emails.filter(function (e) { return !isEmail(e); });
          if (wrong.length) throw bad('Невірний email: ' + wrong[0]);
          o.notify = emails.join(', ');
          break;
        }
        case 'staff':
          need(o.name, 'Вкажіть ПІБ');
          if (!o.role) o.role = 'operator';
          o.line_ids.forEach(function (id) { if (!find('lines', id)) throw bad('Лінію не знайдено: ' + id); });
          if (o.email && !isEmail(o.email)) throw bad('Невірний email: ' + o.email);
          break;
      }
    }
    function applyRuleHelpers(o, row, existing, now) {
      var K = kit();
      var hasHelp = ['last_done_date', 'used_hours', 'used_meter'].some(function (k) { return has(row, k) && !isBlank(row[k]); });
      var line = find('lines', o.line_id), meter = o.meter_id ? find('meters', o.meter_id) : null;
      if (hasHelp && existing && existing.last_date) {
        // відлік уже веде журнал робіт — допоміжні поля нічого б не змінили (тихо ігнорувати не можна)
        throw bad('Для цього регламенту вже є виконання в журналі робіт (' + K.fmtD(existing.last_date) +
          '). Щоб задати нове виконання, запишіть роботу за регламентом («Позначити виконаним») з потрібною датою.');
      }
      if (hasHelp) {
        var ld = null;
        if (!isBlank(row.last_done_date)) {
          ld = parseDate(row.last_done_date, K);
          if (!ld) throw bad('Невірна дата останнього виконання');
          if (ld.getTime() > now.getTime() + FUTURE_SLACK) throw bad('Дата останнього виконання не може бути в майбутньому');
        }
        var uh = isBlank(row.used_hours) ? null : toNum(row.used_hours);
        var um = isBlank(row.used_meter) ? null : toNum(row.used_meter);
        if (!isBlank(row.used_hours) && (uh === null || uh < 0)) throw bad('Невірне напрацювання з останнього виконання, мотогод');
        if (!isBlank(row.used_meter) && (um === null || um < 0)) throw bad('Невірне напрацювання за лічильником');
        o.base_date = ld || now;
        // напрацювання не вказано — рахуємо за журналом від дати виконання (до початку обліку — від його початку);
        // вказане вручну — загальне напрацювання з того часу (для дат до початку обліку в застосунку)
        o.base_hours = uh === null ? (ld ? cumAt(line, ld) : cumAt(line, now)) : r4(cumAt(line, now) - uh);
        o.base_meter = !meter ? null : um === null ? (ld ? meterRefAt(meter, ld) : r4(meterValueAt(meter, now))) : r4(meterValueAt(meter, now) - um);
      } else if (!existing) {
        if (!o.base_date) o.base_date = now;
        if (o.base_hours === null) o.base_hours = cumAt(line, now);
        if (o.base_meter === null) o.base_meter = meter ? r4(meterValueAt(meter, now)) : null;
      } else {
        // інша лінія / інший лічильник — відлік напрацювання з поточного значення
        if (o.line_id !== existing.line_id && !has(row, 'base_hours')) o.base_hours = cumAt(line, now);
        if (o.meter_id !== existing.meter_id && !has(row, 'base_meter')) o.base_meter = meter ? r4(meterValueAt(meter, now)) : null;
      }
    }
    function saveRow(p) {
      p = p || {};
      var t = toStr(p.table);
      if (!EDITABLE[t]) throw bad('Цю таблицю не можна редагувати: ' + t);
      var row = p.row;
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw bad('Не передано дані рядка');
      var now = nowD(), K = kit();
      var id = toStr(row.id);
      if (id && !ID_RE.test(id)) throw bad('Некоректний ID: ' + id.slice(0, 40));
      if (t === 'units') initSheetUnits();             // рядок із таблиці без відліку — спершу фіксуємо відлік
      var existing = id ? find(t, id) : null;
      var inp = {};
      SCHEMA[t].cols.forEach(function (c) {
        if (c.service || c.secret || c.k === 'id' || c.k === 'created' || !has(row, c.k)) return;
        var raw = row[c.k];
        if (!isBlank(raw)) {
          if (c.base === 'enum' && !toEnum(c.set, raw)) throw bad('Невідоме значення «' + toStr(raw) + '» у полі «' + c.t + '»');
          if (c.base === 'enums') {
            (Array.isArray(raw) ? raw : String(raw).split(/[,;]/)).forEach(function (x) {
              if (!isBlank(x) && !toEnum(c.set, x)) throw bad('Невідоме значення «' + toStr(x) + '» у полі «' + c.t + '»');
            });
          }
          if (c.base === 'num' && toNum(raw) === null) throw bad('Поле «' + c.t + '» має бути числом');
          if (c.base === 'date' && !parseDate(raw, K)) throw bad('Поле «' + c.t + '»: невірна дата');
        }
        var v = normVal(c, raw, K);
        if (c.base === 'str') v = txt(v, 4000);
        inp[c.k] = v;
      });
      var o = existing ? assign(copy(existing), inp) : assign(blank(t), inp);
      if (t === 'staff') {
        if (row.clear_pin === true || row.pin === null) o.pin = '';
        else if (has(row, 'pin')) {
          var pin = toStr(row.pin);
          if (pin) {
            if (!PIN_RE.test(pin)) throw bad('PIN має складатися з 4–8 цифр');
            o.pin = pin;
          }
        }
      }
      validateRow(t, o);
      if (!existing) {
        o.id = id || env.uuid();
        if (has(COLS[t], 'created')) o.created = now;
        if (isBlank(row.sort)) o.sort = nextSort(t, o);
        if (t === 'lines') assign(o, { cur_state: 'off', cur_since: null, cur_product: '', cur_operator: '', cur_event: '', cur_cum_h: 0, cur_starts: 0 });
        if (t === 'units') o.base_cum = cumAt(find('lines', o.line_id), now);
      } else if (t === 'units' && o.line_id !== existing.line_id) {
        // агрегат перенесено на іншу лінію: напрацювання переноситься, далі рахується від мотогодин нової лінії
        var oldLine = find('lines', existing.line_id);
        var total = (o.hours_offset || 0) + (oldLine ? cumAt(oldLine, now) : 0) - (existing.base_cum || 0);
        o.hours_offset = r4(Math.max(0, total));
        o.base_cum = cumAt(find('lines', o.line_id), now);
      }
      if (t === 'rules') applyRuleHelpers(o, row, existing, now);
      if (existing) {
        var patch = { id: o.id }, changed = false;
        for (var k in o) if (has(o, k) && k !== 'id' && !sameVal(o[k], existing[k])) { patch[k] = o[k]; changed = true; }
        if (changed) patchRows(t, [patch]);
      } else insertRows(t, [o]);
      return { ok: true, row: adminView(t, find(t, o.id) || o), created: !existing };
    }
    function removeRow(p) {
      p = p || {};
      var t = toStr(p.table);
      if (!EDITABLE[t]) throw bad('Цю таблицю не можна редагувати: ' + t);
      var r = find(t, p.id);
      if (!r) throw notFound('Запис не знайдено: ' + toStr(p.id));
      if (r.active) patchRows(t, [{ id: r.id, active: false }]);
      return { ok: true, table: t, id: r.id };
    }
    function voidRow(p) {
      p = p || {};
      var t = toStr(p.table);
      if (['events', 'checks', 'works', 'readings'].indexOf(t) < 0) throw bad('Анулювати можна лише записи журналів');
      var id = toStr(p.id);
      if (!id) throw bad('Не вказано ID запису');
      // без читання всього журналу: findBy сховища або вікно від ts, який передає клієнт (журнал його має)
      var row = locateLog(t, id, asDate(p.ts));
      if (!row) throw notFound('Запис не знайдено: ' + id);
      var already = !!row.void, note = txt(p.note, 500);
      var vLine = t === 'events' ? find('lines', row.line_id) : null, win = null, oldFn = null;
      if (vLine) {
        // події лінії у вікні перед записом; мотогодини до анулювання — для зсуву відліків агрегатів / регламентів
        win = lineEvents(vLine.id, new Date(row.ts.getTime() - ORDER_WINDOW));
        if (!already) oldFn = cumFnOf(win, lineCurSnap(vLine));
      }
      if (!already) patchRows(t, [{ id: id, 'void': true, void_note: note }]);
      if (t === 'events') {
        if (vLine) recomputeFromI(vLine, row.ts, oldFn, win.filter(function (e) { return e.id !== id; }));
      } else if (t === 'checks') {
        var ans = answersOf(row).filter(function (a) { return !a.void; });
        patchRows('answers', ans.map(function (a) { return { id: a.id, 'void': true }; }));
        // від чек-листа запуску залежать лише позначки запусків після нього
        var cLine = row.occasion === 'start' ? find('lines', row.line_id) : null;
        if (cLine) recomputeFromI(cLine, new Date(row.ts.getTime() - FUTURE_SLACK), null, null);
      } else if (t === 'works') {
        var lr = isRecent(row.ts) ? null : logBy('readings', 'id', id + '-m');
        var linked = lr ? (lr[lr.length - 1] || null) : findLog('readings', id + '-m', row.ts);
        if (linked && !linked.void) patchRows('readings', [{ id: linked.id, 'void': true, void_note: note || 'Анульовано разом із роботою' }]);
        if (row.rule_id && find('rules', row.rule_id)) recomputeRuleI(row.rule_id);
        if (linked && find('meters', linked.meter_id)) recomputeMeterI(linked.meter_id);
      } else if (t === 'readings') {
        if (find('meters', row.meter_id)) recomputeMeterI(row.meter_id);
      }
      return { ok: true, table: t, id: id, already: already };
    }
    function validateSetting(meta, v) {
      switch (meta.type) {
        case 'num': {
          var n = meta.pct ? toPct(v) : toNum(v);
          if (n === null) throw bad('Параметр «' + meta.key + '» має бути числом');
          if (meta.int) n = Math.round(n);
          if (n < meta.min || n > meta.max) throw bad('Параметр «' + meta.key + '» — від ' + meta.min + ' до ' + meta.max);
          return n;
        }
        case 'bool': return typeof v === 'boolean' ? v : toBool(v);
        case 'choice': {
          var s = toStr(v).toLowerCase();
          if (meta.values.indexOf(s) < 0) throw bad('Параметр «' + meta.key + '»: допустимо ' + meta.values.join(' / '));
          return s;
        }
        case 'list': return toList(v);
        case 'emails': {
          var e = toEmails(v), wrong = e.filter(function (x) { return !isEmail(x); });
          if (wrong.length) throw bad('Невірний email: ' + wrong[0]);
          return e;
        }
        case 'tz': {
          var tz = toStr(v);
          if (!resolveTz(env, tz)) throw bad('Невідомий часовий пояс: ' + tz);
          return tz;
        }
        default: return txt(v, 2000);
      }
    }
    function settingsSave(p) {
      var vals = p && p.values;
      if (!vals || typeof vals !== 'object' || Array.isArray(vals)) throw bad('Очікується обʼєкт values');
      var existing = {}, ins = [], ups = [], key;
      (store.all('settings') || []).forEach(function (r) { existing[norm('settings', r).key] = 1; });
      for (key in vals) {
        if (!has(vals, key)) continue;
        var meta = META_BY_KEY[key];
        if (!meta) throw bad('Невідомий параметр: ' + key);
        var cell = settingCell(meta, validateSetting(meta, vals[key]));
        if (has(existing, key)) ups.push({ key: key, value: cell });
        else ins.push({ key: key, value: cell, note: meta.note });
      }
      insertRows('settings', ins);
      patchRows('settings', ups);
      return { ok: true, settings: publicSettings(true) };
    }
    function settingsRows(values) {
      return SETTINGS_META.filter(function (m) { return !m.service; }).map(function (m) {
        var v = values && has(values, m.key) ? values[m.key] : m.def;
        return { key: m.key, value: settingCell(m, v), note: m.note };
      });
    }

    /* ---------- листи: оформлення ---------- */
    var C = { ink: '#1f1a14', muted: '#6b6158', line: '#e4ddd2', due: '#b3261e', soon: '#9a6200', ok: '#2e7d32', accent: '#e8a33d', grey: '#7e746a' };
    var STATE_COLOR = { off: '#7e746a', run: '#4f8a2b', setup: '#3d63b0', stop: '#b7791f', repair: '#b3261e', maint: '#8a4f8f', clean: '#2f7f73' };
    var DAY_COLOR = { miss: C.due, warn: C.soon, ok: C.ok, cont: '#3d63b0', idle: C.grey };
    function pill(text, color) {
      return '<span style="display:inline-block;padding:1px 8px;border-radius:10px;background:' + color +
        ';color:#ffffff;font-size:12px;line-height:18px;white-space:nowrap;">' + esc(text) + '</span>';
    }
    function h2(t) {
      return '<h2 style="font-size:15px;line-height:1.3;margin:24px 0 8px;padding:0 0 4px;border-bottom:2px solid ' +
        C.accent + ';color:' + C.ink + ';">' + esc(t) + '</h2>';
    }
    function tableHtml(rows) {
      return '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:13px;line-height:1.4;">' +
        rows.join('') + '</table>';
    }
    /* cells — масив уже екранованих HTML-фрагментів */
    function trHtml(cells) {
      return '<tr>' + cells.map(function (c, i) {
        return '<td style="padding:6px 8px;border-bottom:1px solid ' + C.line + ';vertical-align:top;' + (i === 0 ? 'white-space:nowrap;' : '') + '">' + c + '</td>';
      }).join('') + '</tr>';
    }
    function small(s) { return '<div style="color:' + C.muted + ';font-size:12px;">' + esc(s) + '</div>'; }
    function mailWrap(title, subtitle, body) {
      var S = settings();
      var link = /^https?:\/\//i.test(S.app_url || '') ?
        '<p style="margin:24px 0 0;"><a href="' + esc(S.app_url) + '" style="display:inline-block;background:' + C.accent +
        ';color:' + C.ink + ';text-decoration:none;padding:9px 16px;border-radius:6px;font-weight:bold;">Відкрити «Облік ліній»</a></p>' : '';
      return '<!DOCTYPE html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
        esc(title) + '</title></head><body style="margin:0;padding:0;background:#f4f1ec;">' +
        '<div style="max-width:720px;margin:0 auto;padding:20px 16px;font-family:Arial,Helvetica,sans-serif;color:' + C.ink + ';font-size:14px;line-height:1.45;">' +
        '<div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#8a6d3b;">FOODLINE · Лінії · ' + esc(S.company) + '</div>' +
        '<h1 style="font-size:20px;line-height:1.3;margin:6px 0 4px;color:' + C.ink + ';">' + esc(title) + '</h1>' +
        (subtitle ? '<div style="color:' + C.muted + ';font-size:13px;">' + esc(subtitle) + '</div>' : '') +
        '<div style="background:#ffffff;border:1px solid ' + C.line + ';border-radius:8px;padding:4px 14px 14px;margin-top:14px;">' + body + '</div>' +
        link + '<p style="margin:24px 0 0;color:#8c8278;font-size:11px;">Лист сформовано автоматично системою обліку роботи та обслуговування виробничих ліній.</p>' +
        '</div></body></html>';
    }
    function textFooter() {
      var S = settings();
      return /^https?:\/\//i.test(S.app_url || '') ? '\n\nВідкрити застосунок: ' + S.app_url : '';
    }
    function where(lineId, unitId) { var u = unitName(unitId); return lineName(lineId) + (u ? ' · ' + u : ''); }

    /* ---------- отримувачі листів ---------- */
    /* хто, крім «Email керівництва» (manager_emails), отримує листи — за посадою в «Персонал» (активні, з email;
       якщо в людини задано «Лінії» — лише про ці лінії): */
    var MAIL_ROLES = {
      digest: ['manager'],                                    // щоденний звіт — усім керівникам
      due: ['manager', 'mechanic', 'electrician'],            // настав строк ТО / ППР
      repair: ['manager', 'mechanic', 'electrician'],         // ремонт / аварійна зупинка
      checklist: ['manager', 'qa']                            // зауваження в чек-листі
    };
    function recipients(kind, lineId, extra) {
      var out = [], seen = {};
      var add = function (e) {
        var k = String(e || '').trim().toLowerCase();
        if (!isEmail(k) || has(seen, k)) return;
        seen[k] = 1; out.push(k);
      };
      settings().manager_emails.forEach(add);
      var roles = MAIL_ROLES[kind] || ['manager'];
      tbl('staff').slice().sort(bySort).forEach(function (s) {
        if (!s.active || roles.indexOf(s.role) < 0 || !s.email) return;
        if (lineId && s.line_ids.length && s.line_ids.indexOf(lineId) < 0) return;
        toEmails(s.email).forEach(add);
      });
      (extra || []).forEach(add);
      return out;
    }

    /* значення відповіді чек-листа для листа; «Н/З» без примітки на обовʼязковому пункті — пропущена перевірка */
    function ansVal(a) {
      if (a.ok === null && !a.value) return 'не заповнено';
      var v = a.value + (a.unit_label && a.type === 'number' ? ' ' + a.unit_label : '');
      if (a.type === 'check' && a.ok === false && a.value === LABELS.check_value.na && !a.note) v += ' (без пояснення)';
      return v;
    }

    /* ---------- миттєві сповіщення ---------- */
    function noticeRepair(line, ev) {
      var K = kit();
      var subject = 'Ремонт / аварійна зупинка — ' + line.name;
      var rows = [
        trHtml(['Лінія', esc(line.name)]),
        trHtml(['Час', esc(K.fmtDT(ev.ts))]),
        trHtml(['Причина', esc(ev.reason || '—')]),
        trHtml(['Продукт', esc(ev.product || '—')]),
        trHtml(['Оператор', esc(ev.operator || '—')])
      ];
      if (ev.note) rows.push(trHtml(['Примітка', esc(ev.note)]));
      var text = subject + '\nЧас: ' + K.fmtDT(ev.ts) + '\nПричина: ' + (ev.reason || '—') + '\nПродукт: ' + (ev.product || '—') +
        '\nОператор: ' + (ev.operator || '—') + (ev.note ? '\nПримітка: ' + ev.note : '') + textFooter();
      return { key: 'repair:' + ev.id, kind: 'repair', to: recipients('repair', line.id), subject: subject,
        html: mailWrap(subject, 'Лінію переведено в стан «Ремонт»', tableHtml(rows)), text: text };
    }
    function noticeChecklist(line, chk, answers) {
      var K = kit();
      var subject = 'Зауваження в чек-листі — ' + line.name + ' (' + label('check_result', chk.result) + ')';
      var badRows = answers.filter(function (a) { return a.ok === false || (a.ok === null && !a.value); });
      var info = tableHtml([
        trHtml(['Лінія', esc(line.name)]),
        trHtml(['Чек-лист', esc(label('occasion', chk.occasion) + ' · ' + K.fmtDT(chk.ts))]),
        trHtml(['Результат', pill(label('check_result', chk.result), chk.result === 'fail' ? C.due : C.soon)]),
        trHtml(['Оператор', esc(chk.operator || '—')]),
        trHtml(['Продукт', esc(chk.product || '—')])
      ].concat(chk.comment ? [trHtml(['Коментар', esc(chk.comment)])] : []));
      var list = badRows.map(function (a) {
        var v = ansVal(a);
        var norm2 = a.type === 'number' && (a.min !== null || a.max !== null) ? 'норма ' + (a.min !== null ? fmtNum(a.min, 2) : '…') + '–' + (a.max !== null ? fmtNum(a.max, 2) : '…') : '';
        return trHtml([esc(a.section || ''), esc(a.text) + (norm2 ? small(norm2) : ''), esc(v) + (a.note ? small(a.note) : '')]);
      });
      var body = info + (list.length ? h2('Пункти із зауваженнями') + tableHtml(list) : '');
      var text = subject + '\n' + label('occasion', chk.occasion) + ' · ' + K.fmtDT(chk.ts) + ' · оператор: ' + (chk.operator || '—') +
        '\nПродукт: ' + (chk.product || '—') + (chk.comment ? '\nКоментар: ' + chk.comment : '') +
        (badRows.length ? '\n\n' + badRows.map(function (a) {
          return '— ' + a.text + ': ' + ansVal(a) + (a.note ? ' (' + a.note + ')' : '');
        }).join('\n') : '') + textFooter();
      return { key: 'check:' + chk.id, kind: 'checklist', to: recipients('checklist', line.id), subject: subject,
        html: mailWrap(subject, 'Чек-лист завершено з результатом «' + label('check_result', chk.result) + '»', body), text: text };
    }
    function mailDue(d, rule) {
      var K = kit();
      var subject = 'Настав строк ТО: ' + d.title + ' — ' + lineName(d.line_id);
      var crit = d.criteria.map(function (c) {
        return trHtml([esc(LABELS.criterion[c.kind]), esc('інтервал ' + fmtNum(c.interval) + ' ' + c.unit_label),
          esc('використано ' + fmtNum(c.used, 1) + ' (' + fmtNum(c.pct * 100) + '%)')]);
      });
      var body = tableHtml([
        trHtml(['Робота', esc(d.title) + (d.part ? small(d.part) : '')]),
        trHtml(['Обладнання', esc(where(d.line_id, d.unit_id))]),
        trHtml(['Вид', esc(label('work_type', d.work_type))]),
        trHtml(['Стан', pill(label('due_status', d.status), C.due) + ' ' + esc(d.summary)]),
        trHtml(['Відлік від', esc(K.fmtD(d.ref_date))])
      ]) + h2('Умови') + tableHtml(crit) +
        (rule && rule.instructions ? h2('Інструкція') + '<p style="margin:6px 0;white-space:pre-line;">' + esc(rule.instructions) + '</p>' : '');
      var text = subject + '\nОбладнання: ' + where(d.line_id, d.unit_id) + '\nСтан: ' + d.summary + '\nВідлік від: ' + K.fmtD(d.ref_date) +
        (rule && rule.instructions ? '\n\nІнструкція:\n' + rule.instructions : '') + textFooter();
      return { subject: subject, html: mailWrap(subject, d.summary, body), text: text };
    }
    function keyChecker(s) {
      if (!s) return function () { return false; };
      if (typeof s.has === 'function') return function (k) { return s.has(k); };
      if (Array.isArray(s)) { var o = {}; s.forEach(function (k) { o[k] = 1; }); return function (k) { return has(o, k); }; }
      if (typeof s === 'object') return function (k) { return !!s[k]; };
      return function () { return false; };
    }
    function dueAlerts(nowIn, sentKeys) {
      var S = settings(), K = kit();
      if (!S.instant_due) return [];
      var now = nowIn ? (parseDate(nowIn, K) || nowD()) : nowD(), sent = keyChecker(sentKeys), out = [];
      dueList(now).forEach(function (d) {
        if (d.status !== 'due') return;
        // ключ — точка відліку: день + ID роботи (два виконання в один день дають різні ключі)
        var key = 'due:' + d.rule_id + ':' + K.key(d.ref_date) + (d.ref_work_id ? ':' + d.ref_work_id : '');
        if (sent(key)) return;
        var rule = find('rules', d.rule_id);
        var to = recipients('due', d.line_id, toEmails(rule && rule.notify));
        var m = mailDue(d, rule);
        out.push({ key: key, kind: 'due', to: to, subject: m.subject, html: m.html, text: m.text, rule_id: d.rule_id, line_id: d.line_id });
      });
      return out;
    }
    function logNotices(list) {
      var now = nowD();
      var rows = (list || []).map(function (n) {
        return assign(blank('notices'), {
          id: toStr(n.id) || env.uuid(), ts: n.ts ? (parseDate(n.ts, kit()) || now) : now,
          kind: toEnum('notice_kind', n.kind) || 'test', key: txt(n.key, 200),
          to: (Array.isArray(n.to) ? n.to : toEmails(n.to)).join(', '), subject: txt(n.subject, 300),
          status: txt(n.status || 'sent', 20), error: txt(n.error, 500)
        });
      });
      insertRows('notices', rows);
      return rows;
    }
    function sentKeys() {
      var s = new Set();
      (store.all('notices') || []).forEach(function (r) {
        var n = norm('notices', r, kit());
        if (n.key && n.status === 'sent') s.add(n.key);
      });
      return s;
    }

    /* ---------- щоденний звіт ---------- */
    function buildDigest(nowIn) {
      var S = settings(), K = kit();
      var now = nowIn ? (parseDate(nowIn, K) || nowD()) : nowD();
      var todayKey = K.key(now), yKey = keyAdd(todayKey, -1);
      var lines = activeLines(), ids = {};
      lines.forEach(function (l) { ids[l.id] = 1; });
      var due = dueList(now);
      var dueItems = due.filter(function (d) { return d.status === 'due'; });
      var soonItems = due.filter(function (d) { return d.status === 'soon'; });
      var dayFrom = new Date(now.getTime() - DAY);
      var data = loadWindow(new Date(Math.min(K.start(yKey).getTime(), dayFrom.getTime())), lines);
      var comp = complianceData([yKey], lines, data, now);
      var uncovered = 0;
      lines.forEach(function (l) { (comp[l.id] || []).forEach(function (d) { uncovered += d.uncovered; }); });
      var chk = {};
      data.checks.forEach(function (c) { chk[c.id] = c; });
      var inDay = function (d) { return d.getTime() >= dayFrom.getTime() && d.getTime() <= now.getTime(); };
      var failed = logSince('answers', dayFrom).filter(function (a) {
        return !a.void && a.ok === false && chk[a.check_id] && has(ids, a.line_id) && inDay(a.ts);
      }).sort(byTs);
      var repEvents = data.evs.filter(function (e) { return e.state === 'repair' && has(ids, e.line_id) && inDay(e.ts); });
      var repWorks = data.works.filter(function (w) { return w.work_type === 'repair' && has(ids, w.line_id) && inDay(w.ts); });
      var stopEvents = data.evs.filter(function (e) { return e.state === 'stop' && has(ids, e.line_id) && inDay(e.ts); });
      var endOf = function (e) {
        var list = data.evBy[e.line_id] || [], i = list.indexOf(e);
        return i >= 0 && i + 1 < list.length ? list[i + 1].ts : now;
      };
      var mins = function (e) { return Math.max(0, Math.round((endOf(e).getTime() - e.ts.getTime()) / MIN)); };
      // одна поломка — один ремонт (як KPI «Ремонти» на панелі): робота «Ремонт», записана під час стану «Ремонт»
      // (або повʼязана з подією, що його завершила), окремо не рахується; рядки в листі — обидва
      var linked = function (w) {
        return repEvents.some(function (e) {
          if (e.line_id !== w.line_id) return false;
          var list = data.evBy[e.line_id] || [], i = list.indexOf(e), nx = i >= 0 && i + 1 < list.length ? list[i + 1] : null;
          var a = e.ts.getTime() - FUTURE_SLACK, b = (nx ? nx.ts : now).getTime() + FUTURE_SLACK;
          var x = w.ts.getTime(), y = w.started ? w.started.getTime() : x;
          return (x >= a && x <= b) || (y >= a && y <= b) || (!!nx && nx.ref_id === w.id);
        });
      };
      var repairs = repEvents.length + repWorks.filter(function (w) { return !linked(w); }).length;
      var hasContent = dueItems.length > 0 || soonItems.length > 0 || failed.length > 0 || repairs > 0 || uncovered > 0;

      var subject = 'Облік ліній — звіт за ' + K.fmtD(now);
      var html = '', text = subject + '\n' + S.company + '\n';
      var dueRow = function (d) {
        return trHtml([pill(label('due_status', d.status), d.status === 'due' ? C.due : C.soon),
          esc(d.title) + small(where(d.line_id, d.unit_id)),
          esc(d.summary) + (d.due_date ? small('строк: ' + K.fmtD(d.due_date) + (d.forecast ? ' (прогноз)' : '')) : '')]);
      };
      var dueText = function (d) { return '— ' + d.title + ' · ' + where(d.line_id, d.unit_id) + ' · ' + d.summary + (d.due_date ? ' · строк ' + K.fmtD(d.due_date) : ''); };
      if (dueItems.length) {
        html += h2('Потрібно виконати (' + dueItems.length + ')') + tableHtml(dueItems.map(dueRow));
        text += '\nПОТРІБНО ВИКОНАТИ\n' + dueItems.map(dueText).join('\n') + '\n';
      }
      if (soonItems.length) {
        // «скоро» — за % інтервалу або за днями (у регламенті може бути свій поріг), тож без «N днів» у заголовку
        var soonTitle = 'Скоро потрібно виконати (' + soonItems.length + ')';
        html += h2(soonTitle) + tableHtml(soonItems.map(dueRow));
        text += '\n' + soonTitle.toUpperCase() + '\n' + soonItems.map(dueText).join('\n') + '\n';
      }
      var compRows = [], compText = [];
      lines.forEach(function (l) {
        var d = (comp[l.id] || [])[0];
        if (!d) return;
        var extra = 'запусків: ' + d.starts + (d.uncovered ? ' · без чек-листа: ' + d.uncovered : '') +
          ' · чек-листів: ' + d.checks.length + ' · роботи: ' + fmtNum(d.run_h, 1) + ' год';
        compRows.push(trHtml([pill(label('day_status', d.status), DAY_COLOR[d.status]), esc(l.name) + small(extra)]));
        compText.push('— ' + l.name + ': ' + label('day_status', d.status) + ' (' + extra + ')');
      });
      if (compRows.length) {
        var ct = 'Щоденні перевірки за вчора (' + K.fmtD(K.start(yKey)) + ')';
        html += h2(ct) + tableHtml(compRows);
        text += '\n' + ct.toUpperCase() + '\n' + compText.join('\n') + '\n';
      }
      if (failed.length) {
        html += h2('Зауваження в чек-листах за добу (' + failed.length + ')') + tableHtml(failed.map(function (a) {
          var c = chk[a.check_id];
          var v = ansVal(a);
          return trHtml([esc(K.fmtDT(a.ts)), esc(a.text) + small(lineName(a.line_id) + ' · ' + label('occasion', c.occasion) + (c.operator ? ' · ' + c.operator : '')),
            esc(v) + (a.note ? small(a.note) : '')]);
        }));
        text += '\nЗАУВАЖЕННЯ В ЧЕК-ЛИСТАХ ЗА ДОБУ\n' + failed.map(function (a) {
          return '— ' + K.fmtDT(a.ts) + ' · ' + lineName(a.line_id) + ' · ' + a.text + ': ' + ansVal(a) + (a.note ? ' (' + a.note + ')' : '');
        }).join('\n') + '\n';
      }
      if (repairs || stopEvents.length) {
        var rrows = [], rtext = [];
        repEvents.forEach(function (e) {
          rrows.push(trHtml([esc(K.fmtDT(e.ts)), pill('Ремонт', C.due) + ' ' + esc(lineName(e.line_id)) + small((e.reason || 'без причини') + ' · ' + fmtNum(mins(e)) + ' хв')]));
          rtext.push('— ' + K.fmtDT(e.ts) + ' · ' + lineName(e.line_id) + ' · ремонт: ' + (e.reason || 'без причини') + ' · ' + mins(e) + ' хв');
        });
        repWorks.forEach(function (w) {
          rrows.push(trHtml([esc(K.fmtDT(w.ts)), esc(w.title) + small(where(w.line_id, w.unit_id) + (w.cause ? ' · причина: ' + w.cause : '') +
            (w.parts ? ' · деталі: ' + w.parts : '') + (w.performer ? ' · ' + w.performer : ''))]));
          rtext.push('— ' + K.fmtDT(w.ts) + ' · ' + lineName(w.line_id) + ' · ' + w.title + (w.cause ? ' (причина: ' + w.cause + ')' : ''));
        });
        var agg = {};
        stopEvents.forEach(function (e) {
          var k = e.line_id + '\u0000' + (e.reason || 'Без причини');
          if (!agg[k]) agg[k] = { line_id: e.line_id, reason: e.reason || 'Без причини', n: 0, min: 0 };
          agg[k].n++;
          agg[k].min += mins(e);
        });
        Object.keys(agg).sort().forEach(function (k) {
          var a = agg[k];
          rrows.push(trHtml([pill('Простій', C.soon), esc(lineName(a.line_id)) + small(a.reason + ' · ' + a.n + ' раз(и) · ' + fmtNum(a.min) + ' хв')]));
          rtext.push('— ' + lineName(a.line_id) + ' · простій «' + a.reason + '»: ' + a.n + ' раз(и), ' + a.min + ' хв');
        });
        html += h2('Ремонти та простої за добу') + tableHtml(rrows);
        text += '\nРЕМОНТИ ТА ПРОСТОЇ ЗА ДОБУ\n' + rtext.join('\n') + '\n';
      }
      var stRows = [], stText = [];
      lines.forEach(function (l) {
        var st = l.cur_state || 'off';
        var sub = (l.cur_since ? 'з ' + K.fmtDT(l.cur_since) : '') + (l.cur_product ? ' · ' + l.cur_product : '') + (l.cur_operator ? ' · ' + l.cur_operator : '');
        stRows.push(trHtml([pill(label('state', st), STATE_COLOR[st] || C.grey), esc(l.name) + (sub ? small(sub) : '')]));
        stText.push('— ' + l.name + ': ' + label('state', st) + (sub ? ' (' + sub + ')' : ''));
      });
      if (stRows.length) {
        html += h2('Стан ліній зараз') + tableHtml(stRows);
        text += '\nСТАН ЛІНІЙ ЗАРАЗ\n' + stText.join('\n') + '\n';
      }
      if (!hasContent) {
        html = '<p style="margin:14px 0 0;">Порушень і прострочених робіт немає.</p>' + html;
        text += '\nПорушень і прострочених робіт немає.\n';
      }
      return {
        subject: subject, html: mailWrap(subject, 'Станом на ' + K.fmtDT(now), html), text: text + textFooter(),
        to: recipients('digest'), has_content: hasContent,
        counts: { due: dueItems.length, soon: soonItems.length, failed: failed.length, repairs: repairs, uncovered: uncovered, stops: stopEvents.length }
      };
    }

    /* ---------- маршрутизатор ---------- */
    function batch(req, ctx) {
      var ops = req.ops;
      if (!Array.isArray(ops)) throw bad('Очікується масив ops');
      if (ops.length > 50) throw bad('Забагато операцій у пакеті (максимум 50)');
      return {
        ok: true,
        results: ops.map(function (op) {
          var opId = op && op.op_id !== undefined ? op.op_id : null;
          try {
            if (!op || typeof op !== 'object') throw bad('Некоректна операція');
            var a = toStr(op.action);
            if (a === 'batch') throw bad('Вкладений пакет не дозволено');
            cache = {};
            var r = route(a, op, ctx), out = { op_id: opId, ok: true, data: wire(r) };
            if (r && r.duplicate) out.duplicate = true;
            return out;
          } catch (e) {
            var er = errorResponse(e);
            return { op_id: opId, ok: false, error: er.error, message: er.message };
          }
        })
      };
    }
    var ROUTES = {
      ping: function () { return { ok: true, version: VERSION, now: nowD(), company: settings().company }; },
      bootstrap: function (r, c) { return bootstrap(c); },
      line: lineView,
      check_detail: checkDetail,
      history: history,
      dashboard: dashboard,
      plan: function (r) { var p = buildPlan(r.from, r.to); p.ok = true; return p; },
      event: addEvent,
      checklist: addChecklist,
      work: addWork,
      reading: addReading,
      batch: batch,
      admin_check: function () { return { ok: true }; },
      save: saveRow,
      remove: removeRow,
      'void': voidRow,
      settings_save: settingsSave,
      digest_preview: function () { var d = buildDigest(); d.ok = true; return d; },
      notices: noticesList,
      recompute: function () { return recomputeAll(); }
    };
    function route(action, req, ctx) {
      var info = has(ACTIONS, action) ? ACTIONS[action] : null;
      if (!info || !has(ROUTES, action)) throw AppError('UNKNOWN_ACTION', 'Невідома дія: ' + (action || '(порожньо)'));
      if (info.admin && !(ctx && ctx.admin)) throw AppError('ADMIN_REQUIRED');
      return ROUTES[action](req, ctx || {});
    }
    function handle(req, ctx) {
      req = req && typeof req === 'object' ? req : {};
      ctx = ctx || {};
      var action = toStr(req.action), info = has(ACTIONS, action) ? ACTIONS[action] : null, ro = readOnly;
      // READ-дії хост виконує без store.lock — тож вони не пишуть у сховище (похідні значення — лише в пам'яті)
      readOnly = !(info && info.write);
      try { return wire(route(action, req, ctx)); } catch (e) { return errorResponse(e); } finally { readOnly = ro; }
    }

    return {
      version: VERSION,
      env: env,
      store: store,
      handle: entry(handle),
      bootstrap: entry(bootstrap),
      addEvent: entry(addEvent),
      addChecklist: entry(addChecklist),
      addWork: entry(addWork),
      addReading: entry(addReading),
      dueAll: entry(dueList),
      computeDue: entry(function (rule, dc) { return computeDue(rule, dc); }),
      buildPlan: entry(buildPlan),
      planRows: entry(planRows),
      refreshPlan: entry(refreshPlan),
      compliance: entry(compliancePub),
      stats: entry(statsPub),
      buildDigest: entry(buildDigest),
      dueAlerts: entry(dueAlerts),
      logNotices: entry(logNotices),
      sentKeys: entry(sentKeys),
      recomputeLine: entry(function (id) { return recomputeLineI(id, null, { from: -Infinity }); }),
      recomputeRule: entry(function (id) { return recomputeRuleI(id); }),
      recomputeMeter: entry(function (id) { return recomputeMeterI(id); }),
      recomputeAll: entry(recomputeAll),
      settings: entry(function () { var S = settings(), o = {}; for (var k in S) if (has(S, k)) o[k] = cloneVal(S[k]); return o; }),
      settingsRows: settingsRows,
      lineCumAt: entry(function (lineId, d) { return cumAt(find('lines', lineId), d ? toMs(d) : nowD()); }),
      meterValueAt: entry(function (meterId, d) { return meterValueAt(find('meters', meterId), d ? toMs(d) : nowD()); }),
      lineStatus: entry(function (lineId) { return statusFor(toStr(lineId), nowD()); }),
      timeKit: entry(function () { return kit(); })
    };
  }

  /* =====================================================================
     seedDemo(store, env, {now, days}) — детерміновані демо-дані соусного заводу.
     Будує все через власні дії застосунку в MemoryStore (з явним ts),
     потім копіює кожну таблицю в цільове сховище ОДНИМ insert на таблицю.
     ===================================================================== */
  var DEMO_PRODUCTS = ['Кетчуп «Лагідний» 300 г', 'Кетчуп «Шашличний» 500 г', 'Соус «Часниковий» 200 г',
    'Майонез «Провансаль» 350 г', 'Гірчиця «Столова» 130 г'];

  function demoConfig() {
    var P = DEMO_PRODUCTS;
    var IT = function (id, L, unit, occ, section, text, type, o) {
      return assign({ id: id, line_id: L, unit_id: unit || '', occasions: occ.split(','), section: section, text: text, type: type || 'check' }, o || {});
    };
    var SAFETY = 'Захисні огородження та кнопка аварійної зупинки справні';
    var items = [
      IT('I101', 'L1', '', 'start', 'Огляд вузлів', SAFETY, 'check', { critical: true, hint: 'Перевірте спрацювання кнопки «Стоп» без продукту' }),
      IT('I102', 'L1', 'U11', 'start', 'Огляд вузлів', 'Дозатор: немає підтікань, шланги та клапани цілі'),
      IT('I103', 'L1', 'U12', 'start', 'Огляд вузлів', 'Закупорювач: патрони чисті, накладки без зносу'),
      IT('I104', 'L1', 'U13', 'start', 'Огляд вузлів', 'Конвеєр: натяг ланцюга в нормі, сторонніх предметів немає'),
      IT('I105', 'L1', 'U13', 'start', 'Змащування', 'Напрямні та ланцюг конвеєра змащено (харчове мастило H1)'),
      IT('I106', 'L1', '', 'start', 'Миття / санобробка', 'Продуктовий тракт промито та продезінфіковано', 'check', { critical: true }),
      IT('I107', 'L1', '', 'start,changeover', 'Налаштування', 'Формат тари та кришки відповідає продукту'),
      IT('I108', 'L1', 'U12', 'start,changeover', 'Налаштування', 'Маркування дати на кришці', 'select', { options: ['Чітке', '!Нечітке', '!Відсутнє'] }),
      IT('I109', 'L1', 'U14', 'start', 'Параметри', 'Тиск повітря, бар', 'number', { unit_label: 'бар', min: 5.5, max: 7, target: 6.2 }),
      IT('I110', 'L1', '', 'start', 'Параметри', 'Температура продукту, °C', 'number', { unit_label: '°C', min: 18, max: 30, target: 22 }),
      IT('I111', 'L1', 'U11', 'start,changeover', 'Параметри', 'Контрольна маса дози, г (пляшка 300 г)', 'number',
        { unit_label: 'г', min: 298, max: 306, target: 302, required: false, format: '300', hint: 'Середнє з 5 пляшок; заповнюйте для формату 300 г' }),
      IT('I112', 'L1', 'U11', 'start,changeover', 'Параметри', 'Контрольна маса дози, г (пляшка 500 г)', 'number',
        { unit_label: 'г', min: 497, max: 508, target: 503, required: false, format: '500', hint: 'Середнє з 5 пляшок; заповнюйте для формату 500 г' }),
      IT('I113', 'L1', 'U12', 'changeover', 'Параметри налаштування', 'Момент закручування кришки, Н·м', 'number', { unit_label: 'Н·м', min: 1.8, max: 2.6, target: 2.2 }),
      IT('I121', 'L1', 'U11', 'changeover', 'Чистка', 'Залишки попереднього продукту видалено, дозатор промито', 'check', { critical: true }),
      IT('I122', 'L1', '', 'changeover', 'Формат', 'Встановлено напрямні та зірочки для нового формату тари'),
      IT('I123', 'L1', '', 'changeover', 'Перевірка етикетки / дати', 'Продукт, партія та дата відповідають виробничому завданню', 'check', { critical: true }),
      IT('I131', 'L1', '', 'end', 'Миття', 'Лінію зупинено, залишки продукту злито з бункера'),
      IT('I132', 'L1', '', 'end', 'Миття', 'Продуктовий тракт промито (CIP)'),
      IT('I133', 'L1', '', 'end', 'Прибирання', 'Робоче місце та підлогу прибрано'),
      IT('I134', 'L1', '', 'end', 'Залишки', 'Залишок порожньої тари, шт', 'number', { unit_label: 'шт', required: false, rmin: 40, rmax: 600 }),
      IT('I135', 'L1', '', 'end', 'Залишки', 'Примітки для наступної зміни', 'text', { required: false }),

      IT('I201', 'L2', '', 'start', 'Огляд вузлів', SAFETY, 'check', { critical: true }),
      IT('I202', 'L2', 'U21', 'start', 'Огляд вузлів', 'Губки запаювання чисті, тефлонова стрічка без пошкоджень'),
      IT('I203', 'L2', 'U21', 'start', 'Огляд вузлів', 'Присоски та захвати пакетів справні'),
      IT('I204', 'L2', 'U22', 'start', 'Огляд вузлів', 'Дозатор: немає підтікань, клапани чисті'),
      IT('I205', 'L2', 'U23', 'start', 'Змащування', 'Підшипники конвеєра відведення змащено'),
      IT('I206', 'L2', '', 'start', 'Миття / санобробка', 'Бункер і продуктовий тракт промито та продезінфіковано', 'check', { critical: true }),
      IT('I207', 'L2', 'U21', 'start,changeover', 'Налаштування', 'Шов пакета (тест на розрив)', 'select', { options: ['Міцний', '!Слабкий', '!Негерметичний'] }),
      IT('I208', 'L2', 'U24', 'start', 'Параметри', 'Тиск повітря, бар', 'number', { unit_label: 'бар', min: 5.5, max: 7, target: 6.3 }),
      IT('I209', 'L2', '', 'start', 'Параметри', 'Температура продукту, °C', 'number', { unit_label: '°C', min: 18, max: 30, target: 21 }),
      IT('I210', 'L2', 'U21', 'start,changeover', 'Параметри', 'Температура запаювання, °C', 'number', { unit_label: '°C', min: 150, max: 175, target: 162 }),
      IT('I211', 'L2', 'U22', 'start,changeover', 'Параметри', 'Відхилення маси дози від номіналу, %', 'number',
        { unit_label: '%', min: -0.5, max: 2, target: 0.7, hint: 'Середнє з 5 пакетів' }),
      IT('I221', 'L2', 'U22', 'changeover', 'Чистка', 'Бункер і дозатор звільнено від попереднього продукту, промито', 'check', { critical: true }),
      IT('I222', 'L2', 'U21', 'changeover', 'Формат', 'Встановлено формувач і плівку для нового продукту'),
      IT('I223', 'L2', '', 'changeover', 'Перевірка етикетки / дати', 'Друк дати та партії на пакеті відповідає продукту', 'check', { critical: true }),
      IT('I231', 'L2', '', 'end', 'Миття', 'Бункер, дозатор і губки запаювання очищено'),
      IT('I232', 'L2', '', 'end', 'Прибирання', 'Обрізки плівки та брак прибрано, зона чиста'),
      IT('I233', 'L2', '', 'end', 'Залишки', 'Залишок плівки на рулоні, м', 'number', { unit_label: 'м', required: false, rmin: 20, rmax: 400 }),
      IT('I234', 'L2', '', 'end', 'Залишки', 'Примітки для наступної зміни', 'text', { required: false }),

      IT('I301', 'L3', '', 'start', 'Огляд вузлів', SAFETY, 'check', { critical: true }),
      IT('I302', 'L3', 'U31', 'start', 'Огляд вузлів', 'Етикетувальник: ролики та ніж чисті, без клею'),
      IT('I303', 'L3', 'U31', 'start', 'Огляд вузлів', 'Рулон етикетки відповідає продукту', 'check', { critical: true }),
      IT('I304', 'L3', 'U32', 'start', 'Огляд вузлів', 'Принтер: рівень чорнила та розчинника в нормі'),
      IT('I305', 'L3', 'U33', 'start', 'Змащування', 'Ланцюг термотунелю змащено (високотемпературне мастило)'),
      IT('I306', 'L3', 'U32', 'start,changeover', 'Налаштування', 'Тест-друк дати та партії', 'select', { options: ['Чіткий', '!Нечіткий', '!Зміщений'] }),
      IT('I307', 'L3', 'U31', 'start,changeover', 'Налаштування', 'Позиціонування етикетки', 'select', { options: ['Рівно', '!Зміщення', '!Перекіс'] }),
      IT('I308', 'L3', 'U33', 'start', 'Параметри', 'Температура термотунелю, °C', 'number', { unit_label: '°C', min: 160, max: 190, target: 175 }),
      IT('I309', 'L3', '', 'start', 'Параметри', 'Швидкість конвеєра, пл./хв', 'number', { unit_label: 'пл./хв', min: 40, max: 80, target: 60 }),
      IT('I310', 'L3', '', 'start', 'Параметри', 'Тиск повітря, бар', 'number', { unit_label: 'бар', min: 5.5, max: 7, target: 6.1 }),
      IT('I321', 'L3', 'U31', 'changeover', 'Формат', 'Замінено рулон етикетки, етикетки попереднього продукту прибрано з лінії', 'check', { critical: true }),
      IT('I322', 'L3', 'U32', 'changeover', 'Перевірка етикетки / дати', 'Дата, партія та термін придатності на етикетці вірні', 'check', { critical: true }),
      IT('I331', 'L3', 'U31', 'end', 'Прибирання', 'Клей і пил з етикетувальника прибрано'),
      IT('I332', 'L3', 'U32', 'end', 'Прибирання', 'Принтер переведено в режим очікування (промивка сопла)'),
      IT('I333', 'L3', '', 'end', 'Залишки', 'Залишок етикеток, рулонів', 'number', { unit_label: 'рул.', required: false, rmin: 1, rmax: 12 }),
      IT('I334', 'L3', '', 'end', 'Залишки', 'Примітки для наступної зміни', 'text', { required: false })
    ];
    var perLine = {};
    items.forEach(function (it) { perLine[it.line_id] = (perLine[it.line_id] || 0) + 10; it.sort = perLine[it.line_id]; });

    return {
      lines: [
        { id: 'L1', name: 'Лінія фасування №1 (ПЕТ-пляшка)', kind: 'Фасувальна', area: 'Цех фасування соусів', sort: 10,
          description: 'Фасування кетчупів у ПЕТ-пляшку 300–500 г: поршневий дозатор, закупорювач, пластинчастий конвеєр.' },
        { id: 'L2', name: 'Лінія фасування №2 (дой-пак)', kind: 'Фасувальна', area: 'Цех фасування соусів', sort: 20,
          description: 'Фасування майонезу та соусів у дой-пак 200–350 г із термозварюванням шва.' },
        { id: 'L3', name: 'Етикетувальна лінія №3', kind: 'Етикетувальна', area: 'Дільниця пакування', sort: 30,
          description: 'Нанесення самоклейких етикеток і дати виготовлення на ПЕТ-пляшку, групове пакування в термоплівку.' }
      ],
      units: [
        { id: 'U11', line_id: 'L1', name: 'Поршневий дозатор 4-головий', kind: 'Дозатор', model: 'ДП-4/500', serial: 'ДП4-2021-0387', maker: 'Укрпакмаш', year: 2021, installed: '12.04.2021', hours_offset: 6120, sort: 10 },
        { id: 'U12', line_id: 'L1', name: 'Закупорювальний автомат', kind: 'Закупорювач', model: 'ЗА-12', serial: 'ЗА12-2021-0112', maker: 'Укрпакмаш', year: 2021, installed: '12.04.2021', hours_offset: 5980, sort: 20 },
        { id: 'U13', line_id: 'L1', name: 'Пластинчастий конвеєр', kind: 'Конвеєр', model: 'КП-6000', serial: 'КП-19-044', maker: 'Конвеєрні системи', year: 2019, installed: '03.09.2019', hours_offset: 9100, sort: 30 },
        { id: 'U14', line_id: 'L1', name: 'Гвинтовий компресор', kind: 'Компресор', model: 'SC-11', serial: 'SC11-7781', maker: 'AirTech', year: 2020, installed: '15.01.2020', hours_offset: 12040, sort: 40 },
        { id: 'U21', line_id: 'L2', name: 'Фасувально-пакувальний автомат дой-пак', kind: 'Фасувальний автомат', model: 'DP-240', serial: 'DP240-22-015', maker: 'Fillpack', year: 2022, installed: '20.06.2022', hours_offset: 3480, sort: 10 },
        { id: 'U22', line_id: 'L2', name: 'Поршневий дозатор соусів', kind: 'Дозатор', model: 'ДС-2/350', serial: 'ДС2-22-031', maker: 'Укрпакмаш', year: 2022, installed: '20.06.2022', hours_offset: 3410, sort: 20 },
        { id: 'U23', line_id: 'L2', name: 'Стрічковий конвеєр відведення', kind: 'Конвеєр', model: 'КС-3000', serial: 'КС-22-107', maker: 'Конвеєрні системи', year: 2022, installed: '20.06.2022', hours_offset: 3300, sort: 30 },
        { id: 'U24', line_id: 'L2', name: 'Гвинтовий компресор', kind: 'Компресор', model: 'SC-7.5', serial: 'SC75-5520', maker: 'AirTech', year: 2018, installed: '02.03.2018', hours_offset: 15800, sort: 40 },
        { id: 'U31', line_id: 'L3', name: 'Етикетувальник самоклейких етикеток', kind: 'Етикетувальник', model: 'L-200', serial: 'L200-20-0093', maker: 'LabelPro', year: 2020, installed: '10.11.2020', hours_offset: 7200, sort: 10 },
        { id: 'U32', line_id: 'L3', name: 'Каплеструменевий принтер (датер)', kind: 'Датер', model: 'CJ-400', serial: 'CJ4-21-5561', maker: 'Markjet', year: 2021, installed: '18.05.2021', hours_offset: 5100, sort: 20 },
        { id: 'U33', line_id: 'L3', name: 'Термоусадковий тунель', kind: 'Термотунель', model: 'ТТ-450', serial: 'ТТ450-18-007', maker: 'Термопак', year: 2018, installed: '25.07.2018', hours_offset: 10300, sort: 30 }
      ],
      items: items,
      meters: [
        { id: 'M1', line_id: 'L1', unit_id: 'U11', name: 'Цикли дозатора', unit_label: 'цикл.', mode: 'abs', ask_on_end: false, sort: 10, init: 1254300 },
        { id: 'M2', line_id: 'L1', unit_id: '', name: 'Вироблено', unit_label: 'шт', mode: 'inc', ask_on_end: true, sort: 20 },
        { id: 'M3', line_id: 'L2', unit_id: 'U22', name: 'Цикли дозатора', unit_label: 'цикл.', mode: 'abs', ask_on_end: false, sort: 10, init: 684200 },
        { id: 'M4', line_id: 'L2', unit_id: '', name: 'Вироблено', unit_label: 'шт', mode: 'inc', ask_on_end: true, sort: 20 },
        { id: 'M5', line_id: 'L3', unit_id: 'U31', name: 'Етикеток нанесено', unit_label: 'шт', mode: 'abs', ask_on_end: true, sort: 10, init: 1843200 }
      ],
      rules: [
        { id: 'R1', line_id: 'L1', unit_id: 'U13', title: 'Змащення ланцюга конвеєра', work_type: 'lube', part: 'Ланцюг і напрямні пластинчастого конвеєра',
          interval_days: 7, interval_hours: 40, warn_days: 2, auto: true, dur: 20, help: { from: 'start', days: 5, used_hours: 22 },
          instructions: 'Зупинити конвеєр і заблокувати пуск. Очистити ланцюг від залишків продукту, нанести харчове мастило H1 тонким шаром на ланки та напрямні, прокрутити вручну.' },
        { id: 'R2', line_id: 'L1', unit_id: 'U11', title: 'Заміна ущільнювачів дозатора', work_type: 'replace', part: 'Ущільнювальні кільця поршнів (комплект на 4 головки)',
          interval_hours: 500, auto: true, dur: 45, help: { from: 'start', days: 40, used_hours: 420 },
          instructions: 'Розібрати поршневі групи, замінити всі ущільнювальні кільця, змастити силіконовим мастилом H1, перевірити герметичність на воді.' },
        { id: 'R3', line_id: 'L2', unit_id: 'U21', title: 'ТО-1 фасувального автомата', work_type: 'to', part: 'Фасувально-пакувальний автомат DP-240',
          interval_days: 30, auto: true, dur: 60, help: { from: 'start', days: 20 },
          instructions: 'Перевірити та підтягнути кріплення, очистити датчики, перевірити пневмоциліндри та вакуумну систему, змастити напрямні, перевірити натяг ременів.' },
        { id: 'R4', line_id: 'L1', unit_id: '', title: 'ППР — капітальне ТО лінії', work_type: 'ppr', part: 'Лінія фасування №1 у цілому',
          interval_days: 180, warn_days: 14, help: { from: 'now', days: 176 },
          instructions: 'Плановий зупин лінії на 1 зміну: дефектування вузлів, заміна зношених підшипників і ременів, перевірка електрообладнання, калібрування датчиків.' },
        { id: 'R5', line_id: 'L1', unit_id: 'U14', title: 'Заміна фільтра компресора', work_type: 'replace', part: 'Повітряний і масляний фільтри, сепаратор',
          interval_days: 90, interval_hours: 1000, help: { from: 'now', days: 95, used_hours: 610 },
          instructions: 'Вимкнути та знеструмити компресор, скинути тиск. Замінити повітряний і масляний фільтри, перевірити рівень мастила, скинути лічильник сервісу.' },
        { id: 'R6', line_id: 'L2', unit_id: 'U22', title: 'Калібрування дозатора (контрольне зважування)', work_type: 'calib', part: 'Поршневий дозатор ДС-2',
          interval_days: 30, scheduled: 26, dur: 40, help: { from: 'start', days: 5 },
          instructions: 'Зважити 10 доз на повірених вагах, скоригувати хід поршня, оформити протокол калібрування.' },
        { id: 'R7', line_id: 'L2', unit_id: 'U21', title: 'Заміна тефлонової стрічки губок запаювання', work_type: 'replace', part: 'Стрічка тефлонова 0,13 × 25 мм',
          interval_hours: 250, auto: true, dur: 25, help: { from: 'start', days: 12, used_hours: 100 },
          instructions: 'Охолодити губки, зняти стару стрічку, знежирити поверхню, наклеїти нову без складок.' },
        { id: 'R8', line_id: 'L2', unit_id: 'U22', title: 'Заміна поршневої пари дозатора', work_type: 'replace', part: 'Поршнева пара ДС-2 (поршень + гільза)',
          meter_id: 'M3', interval_meter: 400000, auto: true, dur: 60, help: { from: 'start', days: 30, used_meter: 250000 },
          instructions: 'Демонтувати дозувальну головку, замінити поршневу пару, перевірити дозу контрольним зважуванням.' },
        { id: 'R9', line_id: 'L3', unit_id: 'U31', title: 'Заміна ножа етикетувальника', work_type: 'replace', part: 'Ніж відрізний L-200',
          meter_id: 'M5', interval_meter: 150000, auto: true, dur: 20, help: { from: 'start', days: 4, used_meter: 30000 },
          instructions: 'Зняти захисний кожух, замінити ніж, відрегулювати зазор 0,05 мм, перевірити відрізання на 20 етикетках.' },
        { id: 'R10', line_id: 'L3', unit_id: 'U32', title: 'Очищення друкуючої головки', work_type: 'clean', part: 'Друкуюча головка та сопло CJ-400',
          interval_days: 3, warn_days: 1, auto: true, dur: 15, help: { from: 'start', days: 1 },
          instructions: 'Промити сопло та головку розчинником з промивальної пляшки, протерти безворсовою серветкою, виконати тест-друк.' }
      ],
      staff: [
        { id: 'S1', name: 'Олена Коваленко', role: 'operator', line_ids: ['L1'], pin: '1111', sort: 10 },
        { id: 'S2', name: 'Ігор Мельник', role: 'operator', line_ids: ['L2'], sort: 20 },
        { id: 'S3', name: 'Наталія Бондар', role: 'operator', line_ids: ['L3'], sort: 30 },
        { id: 'S4', name: 'Сергій Ткаченко', role: 'operator', line_ids: ['L1', 'L2'], sort: 40 },
        { id: 'S5', name: 'Андрій Шевчук', role: 'setter', line_ids: [], sort: 50 },
        { id: 'S6', name: 'Віктор Олійник', role: 'mechanic', line_ids: [], sort: 60 },
        { id: 'S7', name: 'Марина Кравченко', role: 'manager', line_ids: [], sort: 70 }
      ],
      cfg: {
        L1: { ops: ['S1', 'S4'], start: 7 * 60 + 25, end: 19 * 60 + 25, rate: 1450, sat: 0.35, repairP: 0.09, products: [P[0], P[1]],
          produced: 'M2', cycles: 'M1', cyclesPer: 0.25, counter: null, coUnit: 'U11', device: 'Планшет лінії 1',
          critItem: 'I101', critNote: 'Не спрацьовує кнопка аварійної зупинки на закупорювачі', critReason: 'Несправна кнопка аварійної зупинки',
          critFix: 'Замінено кнопку аварійної зупинки, перевірено ланцюг безпеки', critParts: 'Кнопка аварійна «грибок» Ø40 мм, 1НЗ', critUnit: 'U12',
          params: function (p) {
            return /500/.test(p) ? 'Формат: ПЕТ 500 мл; доза 503 г; швидкість 22 пл./хв; момент закручування 2,3 Н·м'
              : 'Формат: ПЕТ 300 мл; доза 302 г; швидкість 30 пл./хв; момент закручування 2,0 Н·м';
          },
          repairs: [
            { unit: 'U12', cause: 'Застрягання пляшок на вході закупорювача', fix: 'Відрегульовано напрямні та зірочку подачі, замінено датчик наявності тари', parts: 'Датчик наявності тари (оптичний)' },
            { unit: 'U11', cause: 'Підтікання продукту з-під ущільнення дозатора', fix: 'Замінено ущільнювальні кільця поршня №3', parts: 'Кільце ущільнювальне 32×3 NBR (харчове), 2 шт.' },
            { unit: 'U13', cause: 'Спрацював захист двигуна конвеєра', fix: 'Усунено заклинювання ланцюга, перевірено струм двигуна', parts: '' },
            { unit: 'U12', cause: 'Не подаються кришки в патрон закупорювача', fix: 'Очищено та відрегульовано лоток кришок, замінено пружину', parts: 'Пружина лотка кришок' }
          ] },
        L2: { ops: ['S2', 'S4'], start: 7 * 60 + 40, end: 19 * 60 + 10, rate: 1100, sat: 0.15, repairP: 0.08, products: [P[3], P[2]],
          produced: 'M4', cycles: 'M3', cyclesPer: 1, counter: null, coUnit: 'U21', device: 'Планшет лінії 2',
          params: function (p) {
            return /350/.test(p) ? 'Дой-пак 350 г; доза 352 г; температура запаювання 165 °C; 32 уп./хв'
              : 'Дой-пак 200 г; доза 201 г; температура запаювання 158 °C; 40 уп./хв';
          },
          repairs: [
            { unit: 'U21', cause: 'Негерметичний шов пакета', fix: 'Очищено губки запаювання, замінено тефлонову стрічку, відкалібровано температуру', parts: 'Стрічка тефлонова 0,13 × 25 мм' },
            { unit: 'U21', cause: 'Обрив плівки на формувачі', fix: 'Заправлено плівку, відрегульовано натяг гальма рулону', parts: '' },
            { unit: 'U21', cause: 'Не відкривається пакет — знос присосок', fix: 'Замінено присоски захвату пакета', parts: 'Присоска вакуумна Ø20, 4 шт.' },
            { unit: 'U24', cause: 'Витік повітря в пневмосистемі', fix: 'Замінено фітинг і ділянку пневмотрубки', parts: 'Фітинг прямий 8 мм; трубка ПУ 8 мм — 1,5 м' }
          ] },
        L3: { ops: ['S3', 'S3'], start: 7 * 60 + 45, end: 19 * 60 + 30, rate: 2600, sat: 0.25, repairP: 0.08, products: [P[0], P[1], P[4]],
          produced: null, cycles: null, cyclesPer: 0, counter: 'M5', coUnit: 'U31', device: 'Планшет лінії 3',
          forcedSkip: 'I308', forcedComment: 'Датчик температури тунелю не показує. Перевірено пірометром — 176 °C, запуск під мою відповідальність, викликано електрика.',
          params: function (p) { return 'Етикетка «' + p.replace(/\s*\d+\s*г$/, '') + '»; рулон 1000 шт.; швидкість 60 пл./хв; друк: дата, партія, термін придатності'; },
          repairs: [
            { unit: 'U31', cause: 'Етикетка клеїться з перекосом', fix: 'Відрегульовано притискні щітки та датчик етикетки', parts: '' },
            { unit: 'U32', cause: 'Принтер не друкує — засмічене сопло', fix: 'Промито сопло, замінено фільтр чорнила', parts: 'Фільтр чорнила CJ-400' },
            { unit: 'U31', cause: 'Обрив підкладки етикетки', fix: 'Заправлено рулон, відрегульовано натяг, замінено притискний ролик', parts: 'Ролик притискний' },
            { unit: 'U33', cause: 'Термотунель не набирає температуру', fix: 'Замінено ТЕН №2 термотунелю', parts: 'ТЕН 2,5 кВт' }
          ] }
      }
    };
  }

  function seedDemo(target, envIn, opts) {
    if (!target) throw new Error('LinesCore.seedDemo: потрібне сховище');
    opts = opts || {};
    var base = makeEnv(envIn);
    var now = opts.now ? parseDate(opts.now) : base.now();
    now = isDate(now) ? new Date(now.getTime()) : new Date(toMs(now));
    var days = clamp(Math.floor(toNum(opts.days) || 35), 2, 120);
    var rnd = mulberry32(toNum(opts.seed) || 20260925);
    var R = function () { return rnd(); };
    var chance = function (p) { return rnd() < p; };
    var irand = function (a, b) { return a + Math.floor(rnd() * (b - a + 1)); };
    var pick = function (arr) { return arr[Math.floor(rnd() * arr.length)]; };
    var seq = 0;
    var nid = function (pfx) { seq++; var s = seq.toString(36); while (s.length < 5) s = '0' + s; return pfx + s; };
    var D = demoConfig(), CFG = D.cfg, P = DEMO_PRODUCTS;

    // часовий пояс — з цільового сховища (якщо задано), інакше типовий
    var existing = {};
    (target.all('settings') || []).forEach(function (r) { var n = norm('settings', r); if (n.key) existing[n.key] = n; });
    var tzSet = existing.tz && existing.tz.value && resolveTz(base, existing.tz.value) ? existing.tz.value : DEFAULT_SETTINGS.tz;
    var tz = plantTz(base, tzSet);        // робочий пояс цього рушія (старий ICU: Europe/Kiev)
    var S0 = {};
    for (var sk in DEFAULT_SETTINGS) S0[sk] = cloneVal(DEFAULT_SETTINGS[sk]);
    S0.tz = tzSet;
    S0.products = P.slice();
    var settingRows = SETTINGS_META.filter(function (m) { return !m.service; }).map(function (m) {
      return { key: m.key, value: settingCell(m, S0[m.key]), note: m.note };
    });

    var mem = new MemoryStore();
    mem.insert('settings', settingRows);
    var clock = now.getTime();
    var app = createApp(mem, {
      now: function () { return new Date(clock); },
      uuid: function () { return nid('dm'); },
      dayKey: base.dayKey, dayStart: base.dayStart, parts: base.parts
    });
    var K = timeKit(base, tz);
    var todayKey = K.key(now), firstKey = keyAdd(todayKey, -days);
    var t0 = K.start(firstKey).getTime(), nowMs = now.getTime();
    var dayAt = function (key, minutes) { return K.start(key).getTime() + Math.round(minutes * MIN); };
    var OPS = {};
    D.staff.forEach(function (s) { OPS[s.id] = s.name; });

    function call(action, params, ts, device) {
      clock = Math.min(ts, nowMs) + 1000;
      var r = app.handle(assign({ action: action }, params), { admin: true, device: device || 'Керівник (демо)' });
      if (!r.ok) throw new Error('seedDemo: ' + action + ' — ' + r.error + ': ' + r.message);
      return r;
    }

    /* --- довідники --- */
    var cfgTs = t0 - DAY;
    var save = function (table, row) { return call('save', { table: table, row: row }, cfgTs); };
    D.lines.forEach(function (l) { save('lines', l); });
    D.units.forEach(function (u) { save('units', u); });
    D.meters.forEach(function (m) {
      var row = copy(m);
      delete row.init;
      save('meters', row);
      if (m.init) call('reading', { id: nid('r'), ts: new Date(cfgTs), meter_id: m.id, value: m.init, note: 'Початковий показник' }, cfgTs);
    });
    D.items.forEach(function (it) {
      var row = copy(it);
      delete row.format; delete row.rmin; delete row.rmax;
      save('items', row);
    });
    var RULE = {};
    D.rules.forEach(function (r) {
      RULE[r.id] = r;
      var row = copy(r), h = r.help || {};
      delete row.help; delete row.auto; delete row.dur; delete row.scheduled;
      var ld = h.from === 'now' ? nowMs - h.days * DAY : t0 - (h.days || 0) * DAY;
      if (ld > cfgTs) ld = cfgTs - DAY;
      if (r.scheduled && keyAdd(todayKey, -r.scheduled) < firstKey) ld = nowMs - r.scheduled * DAY;
      row.last_done_date = new Date(ld).toISOString();
      if (h.used_hours) row.used_hours = h.used_hours;
      if (h.used_meter) row.used_meter = h.used_meter;
      save('rules', row);
    });
    D.staff.forEach(function (s) { save('staff', s); });

    /* --- симуляція роботи ліній --- */
    var st = {}, runMs = { L1: 0, L2: 0, L3: 0 }, product = { L1: P[0], L2: P[3], L3: P[0] };
    var counters = {};
    D.meters.forEach(function (m) { if (m.init) counters[m.id] = m.init; });
    var REM_CHECK = ['Послаблене кріплення — підтягнуто', 'Незначне підтікання, повідомлено механіку', 'Залишки продукту — доочищено',
      'Помітний знос, потрібна заміна найближчим часом', 'Сторонній предмет — прибрано'];
    var REM_NUM = ['Відрегульовано, повторний замір у нормі', 'Повідомлено наладчику', 'Скориговано налаштування'];
    var REM_SEL = ['Налаштовано повторно, контрольний зразок у нормі', 'Відбраковано 12 шт., налаштовано'];
    var TEXT_NOTES = ['Сировини вистачить до обіду наступної зміни', 'Потрібно замовити кришки', 'Все гаразд, зауважень немає',
      'Низький рівень чорнила у принтері', 'Залишок продукту в бункері ~40 кг'];
    var STOP_REASONS = ['Мікрозупинка / застрягання', 'Мікрозупинка / застрягання', 'Мікрозупинка / застрягання', 'Мікрозупинка / застрягання',
      'Немає сировини / тари', 'Немає сировини / тари', 'Немає сировини / тари', 'Очікування', 'Очікування', 'Налагодження', 'Інше'];
    var STOP_NOTES = { 'Мікрозупинка / застрягання': 'Застрягла тара на вході', 'Немає сировини / тари': 'Очікування тари зі складу',
      'Очікування': 'Очікування результату лабораторного аналізу', 'Налагодження': 'Підрегулювання дозатора', 'Інше': 'Прибирання розлитого продукту' };

    function account(L, ts) { var s = st[L]; if (s && s.state === 'run') runMs[L] += Math.max(0, ts - s.ts); }
    function ev(L, state, ts, extra) {
      account(L, ts);
      var r = call('event', assign({ id: nid('e'), ts: new Date(ts), line_id: L, state: state }, extra || {}), ts, CFG[L].device);
      st[L] = { state: state, ts: ts };
      return r;
    }
    function genAnswers(L, occ, prod, o) {
      o = o || {};
      var fmt = /500/.test(prod || '') ? '500' : '300', out = [];
      D.items.forEach(function (it) {
        if (it.line_id !== L || it.occasions.indexOf(occ) < 0 || o.skip === it.id) return;
        var a = { item_id: it.id, value: '', note: '' };
        if (it.type === 'check') {
          if (o.critFail === it.id) { a.value = 'fail'; a.note = o.critNote || ''; }
          else if (!it.critical && chance(0.018)) { a.value = 'fail'; a.note = pick(REM_CHECK); }
          else a.value = 'ok';
        } else if (it.type === 'number') {
          if (it.format && it.format !== fmt) return;
          if (it.min === undefined && it.max === undefined) {
            if (!chance(0.6)) return;
            a.value = String(irand(it.rmin || 0, it.rmax || 100));
          } else {
            var span = it.max - it.min, dec = span < 20 ? 1 : 0, v;
            if (chance(0.03)) {
              v = chance(0.5) ? it.max + span * (0.05 + R() * 0.15) : it.min - span * (0.05 + R() * 0.15);
              a.note = pick(REM_NUM);
            } else v = it.target + (R() - 0.5) * span * 0.5;
            a.value = String(round(v, dec)).replace('.', ',');
          }
        } else if (it.type === 'select') {
          var bads = it.options.filter(function (x) { return x.charAt(0) === '!'; });
          if (bads.length && chance(0.02)) { a.value = pick(bads).slice(1); a.note = pick(REM_SEL); }
          else a.value = it.options.filter(function (x) { return x.charAt(0) !== '!'; })[0];
        } else {
          if (!chance(0.25)) return;
          a.value = pick(TEXT_NOTES);
        }
        out.push(a);
      });
      return out;
    }
    function checklist(L, occ, ts, o) {
      var r = call('checklist', {
        id: nid('c'), ts: new Date(ts), started: new Date(ts - (o.dur || irand(8, 16)) * MIN), line_id: L, occasion: occ,
        operator: OPS[o.op], staff_id: o.op, product: o.product || '', comment: o.comment || '',
        answers: genAnswers(L, occ, o.product, o.gen), then_event: o.then || null, readings: o.readings || null, forced: !!o.forced
      }, ts, CFG[L].device);
      if (o.then) { account(L, ts); st[L] = { state: o.then.state, ts: ts }; }
      return r;
    }
    function work(L, o, ts) {
      return call('work', assign({ id: nid('w'), ts: new Date(ts), line_id: L }, o), ts, CFG[L].device);
    }
    function reading(L, meterId, value, ts, op) {
      return call('reading', { id: nid('r'), ts: new Date(ts), meter_id: meterId, value: value, operator: OPS[op] || '' }, ts, CFG[L].device);
    }
    function maintSession(L, startTs, list) {
      var mech = 'S6';
      ev(L, 'maint', startTs, { operator: OPS[mech], staff_id: mech, note: 'Планове обслуговування: ' + list.map(function (r) { return r.title; }).join('; ') });
      var cur = startTs + 5 * MIN, lastW = '';
      list.forEach(function (r) {
        var dur = r.dur || irand(15, 35);
        var w = work(L, { started: new Date(cur), unit_id: r.unit_id, rule_id: r.id, work_type: r.work_type, title: r.title,
          description: 'Виконано згідно з регламентом. ' + (r.instructions || ''), parts: r.work_type === 'replace' ? r.part : '',
          performer: OPS[mech], staff_id: mech, duration_min: dur, downtime_min: 0 }, cur + dur * MIN);
        lastW = w.work.id;
        cur += (dur + 3) * MIN;
      });
      ev(L, 'off', cur, { ref_id: lastW, operator: OPS[mech], staff_id: mech });
      return cur;
    }
    function doStop(L, s, dur, reason, op) {
      ev(L, 'stop', s, { reason: reason, operator: OPS[op], staff_id: op, note: chance(0.4) ? (STOP_NOTES[reason] || '') : '' });
      ev(L, 'run', s + dur * MIN, { operator: OPS[op], staff_id: op });
    }
    function doChangeover(L, s, dur, op) {
      var c = CFG[L], cur = product[L];
      var others = c.products.filter(function (x) { return x !== cur; });
      var np = others.length ? pick(others) : cur;
      ev(L, 'setup', s, { operator: OPS[op], staff_id: op, note: 'Переналаштування: ' + cur + ' → ' + np });
      work(L, { started: new Date(s + 2 * MIN), unit_id: c.coUnit, work_type: 'changeover', title: 'Переналаштування на ' + np,
        params: c.params(np), product: np, performer: OPS.S5, staff_id: 'S5', duration_min: dur - 12, downtime_min: dur }, s + (dur - 10) * MIN);
      checklist(L, 'changeover', s + dur * MIN, { op: op, product: np, dur: 8, then: { state: 'run' } });
      product[L] = np;
    }
    function doRepair(L, s, dur, op) {
      var rp = pick(CFG[L].repairs);
      ev(L, 'repair', s, { reason: rp.cause, operator: OPS[op], staff_id: op });
      var w = work(L, { started: new Date(s + 4 * MIN), unit_id: rp.unit, work_type: 'repair', title: rp.fix, cause: rp.cause, parts: rp.parts,
        performer: OPS.S6, staff_id: 'S6', duration_min: dur - 8, downtime_min: dur, product: product[L] }, s + (dur - 2) * MIN);
      ev(L, 'run', s + dur * MIN, { ref_id: w.work.id, operator: OPS[op], staff_id: op });
    }
    function endShift(L, key, tE, op, flags) {
      var c = CFG[L], s = st[L];
      var runH = (runMs[L] + (s && s.state === 'run' ? tE - s.ts : 0)) / HOUR;
      var produced = Math.round(runH * c.rate * (0.88 + R() * 0.14));
      var rds = [];
      if (c.produced) rds.push({ meter_id: c.produced, value: produced });
      if (c.counter) { counters[c.counter] += produced; rds.push({ meter_id: c.counter, value: counters[c.counter] }); }
      var clean = keyDow(key) === 5 && L !== 'L3' && !flags.short;
      if (flags.noEndCheck) {
        ev(L, 'off', tE, { operator: OPS[op], staff_id: op });
        rds.forEach(function (r) { reading(L, r.meter_id, r.value, tE + MIN, op); });
      } else {
        checklist(L, 'end', tE, { op: op, product: product[L], dur: irand(10, 18), readings: rds, then: { state: clean ? 'clean' : 'off' } });
      }
      if (c.cycles) { counters[c.cycles] += Math.round(produced * c.cyclesPer); reading(L, c.cycles, counters[c.cycles], tE + 2 * MIN, op); }
      if (clean) {
        var cs = tE + 3 * MIN, cd = irand(40, 60);
        var wc = work(L, { started: new Date(cs), work_type: 'clean', title: 'Санобробка лінії наприкінці тижня',
          description: 'Розбирання продуктового тракту, миття лужним і кислотним розчином, дезінфекція, ополіскування.',
          performer: OPS[op], staff_id: op, duration_min: cd }, cs + cd * MIN);
        ev(L, 'off', cs + cd * MIN + MIN, { ref_id: wc.work.id, operator: OPS[op], staff_id: op });
      }
    }
    function workDay(L, key, flags) {
      var c = CFG[L], op = chance(0.8) ? c.ops[0] : c.ops[1];
      runMs[L] = 0;
      var tStart = dayAt(key, c.start + irand(-10, 12)), tEnd = dayAt(key, c.end + irand(-10, 25));
      if (flags.maint.length) {
        // ТО перед зміною: тривалість сесії — за фактичними тривалостями робіт (без виходу за початок зміни)
        var need = 5 + 10;
        flags.maint.forEach(function (r) { need += (r.dur || 35) + 3; });
        var mEnd = maintSession(L, tStart - need * MIN, flags.maint);
        if (mEnd > tStart - 5 * MIN) tStart = mEnd + 10 * MIN;
      }
      if (chance(0.12)) {
        var others = c.products.filter(function (x) { return x !== product[L]; });
        if (others.length) product[L] = pick(others);
      }
      var prod = product[L];
      if (flags.noCheck) {
        ev(L, 'run', tStart, { operator: OPS[op], staff_id: op, product: prod, note: 'Планшет був розряджений, чек-лист не заповнено' });
      } else if (flags.critRepair && c.critItem) {
        checklist(L, 'start', tStart, { op: op, product: prod, gen: { critFail: c.critItem, critNote: c.critNote },
          then: { state: 'repair', reason: c.critReason } });
        var rd = irand(40, 70);
        var w = work(L, { started: new Date(tStart + 5 * MIN), unit_id: c.critUnit, work_type: 'repair', title: c.critFix, cause: c.critReason,
          parts: c.critParts, performer: OPS.S6, staff_id: 'S6', duration_min: rd - 8, downtime_min: rd, product: prod }, tStart + (rd - 2) * MIN);
        ev(L, 'run', tStart + rd * MIN, { operator: OPS[op], staff_id: op, ref_id: w.work.id, product: prod });
      } else if (flags.forcedMissing && c.forcedSkip) {
        checklist(L, 'start', tStart, { op: op, product: prod, gen: { skip: c.forcedSkip }, comment: c.forcedComment, forced: true, then: { state: 'run' } });
      } else {
        checklist(L, 'start', tStart, { op: op, product: prod, then: { state: 'run' } });
      }
      var queue = [], n = irand(0, 2), i;
      for (i = 0; i < n; i++) queue.push('stop');
      if (chance(L === 'L3' ? 0.25 : 0.2)) queue.push('changeover');
      if (flags.repair || chance(c.repairP)) queue.push('repair');
      for (i = queue.length - 1; i > 0; i--) { var j = Math.floor(R() * (i + 1)), tmp = queue[i]; queue[i] = queue[j]; queue[j] = tmp; }
      var lunch = chance(0.85) ? dayAt(key, 12 * 60 + irand(0, 15)) : null;
      var cursor = st[L].ts + irand(40, 90) * MIN;
      while (queue.length || lunch) {
        var k = queue.length ? queue[0] : null;
        var dur = k === 'stop' ? irand(6, 45) : k === 'changeover' ? irand(25, 55) : k === 'repair' ? irand(35, 110) : 0;
        var s = k ? cursor + irand(25, 120) * MIN : 0;
        if (lunch && (!k || s + dur * MIN > lunch - 5 * MIN)) {
          var ls = Math.max(lunch, cursor + 5 * MIN);
          if (ls + 30 * MIN < tEnd - 30 * MIN && st[L].state === 'run') { doStop(L, ls, 30, 'Перерва', op); cursor = st[L].ts; }
          lunch = null;
          continue;
        }
        queue.shift();
        if (s + dur * MIN > tEnd - 30 * MIN || st[L].state !== 'run') continue;
        if (k === 'stop') { var reason = pick(STOP_REASONS); doStop(L, s, dur, reason, op); }
        else if (k === 'changeover') doChangeover(L, s, dur, op);
        else doRepair(L, s, dur, op);
        cursor = st[L].ts;
      }
      endShift(L, key, Math.max(tEnd, st[L].ts + 20 * MIN), op, flags);
    }

    var SPECIAL = [
      { L: 'L2', at: 5, flag: 'noCheck', start: true }, { L: 'L3', at: 12, flag: 'noCheck', start: true },
      { L: 'L1', at: 23, flag: 'noCheck', start: true }, { L: 'L1', at: 9, flag: 'critRepair', start: true },
      { L: 'L3', at: 17, flag: 'forcedMissing', start: true }, { L: 'L2', at: 20, flag: 'noEndCheck' },
      { L: 'L2', at: 14, flag: 'repair' }, { L: 'L3', at: 27, flag: 'repair' }
    ];
    var scheduled = {};
    D.rules.forEach(function (r) {
      if (!r.scheduled) return;
      var k = keyAdd(todayKey, -r.scheduled);
      if (k >= firstKey) (scheduled[k] || (scheduled[k] = [])).push(r);
    });
    var LINES = ['L1', 'L2', 'L3'];
    for (var di = 0; di < days; di++) {
      var key = keyAdd(firstKey, di), dow = keyDow(key);
      clock = dayAt(key, 6 * 60);
      var dueNow = app.dueAll(new Date(clock));
      LINES.forEach(function (L) {
        var c = CFG[L];
        var working = dow >= 1 && dow <= 5 ? chance(0.94) : dow === 6 ? chance(c.sat) : false;
        var maint = [];
        dueNow.forEach(function (d) {
          if (d.line_id !== L || !RULE[d.rule_id] || !RULE[d.rule_id].auto) return;
          if (d.pct >= 1 ? chance(0.85) : (d.pct >= 0.9 && chance(0.35))) maint.push(RULE[d.rule_id]);
        });
        (scheduled[key] || []).forEach(function (r) { if (r.line_id === L) maint.push(r); });
        if (!working) {
          if (maint.length) maintSession(L, dayAt(key, 9 * 60), maint);
          return;
        }
        var flags = { maint: maint }, startUsed = false;
        SPECIAL.forEach(function (sp) {
          if (sp.used || sp.L !== L || di < sp.at) return;
          if (sp.start && startUsed) return;
          flags[sp.flag] = true;
          sp.used = true;
          if (sp.start) startUsed = true;
        });
        workDay(L, key, flags);
      });
    }

    /* --- сьогодні: лінія 1 працює, лінія 2 не працює, лінія 3 у простої --- */
    (function () {
      var L = 'L1', c = CFG[L], op = c.ops[0], last = st[L] ? st[L].ts : t0;
      runMs[L] = 0;
      var s = Math.max(dayAt(todayKey, c.start), nowMs - 10 * HOUR, last + 30 * MIN);
      if (s > nowMs - 40 * MIN) s = Math.max(last + 5 * MIN, nowMs - 40 * MIN);
      checklist(L, 'start', s, { op: op, product: product[L], then: { state: 'run' } });
      if (nowMs - s > 3 * HOUR) doStop(L, s + 95 * MIN, 18, 'Мікрозупинка / застрягання', op);
    })();
    (function () {
      var L = 'L3', c = CFG[L], op = c.ops[0], last = st[L] ? st[L].ts : t0;
      var s = Math.max(dayAt(todayKey, c.start), nowMs - 9 * HOUR, last + 30 * MIN);
      if (s > nowMs - 60 * MIN) s = Math.max(last + 5 * MIN, nowMs - 60 * MIN);
      checklist(L, 'start', s, { op: op, product: product[L], then: { state: 'run' } });
      ev(L, 'stop', Math.max(s + 20 * MIN, nowMs - 25 * MIN), { reason: 'Немає сировини / тари', note: 'Очікуємо пляшки з лінії №1', operator: OPS[op], staff_id: op });
    })();
    (function () {
      var L = 'L2', c = CFG[L], op = c.ops[0], last = st[L] ? st[L].ts : t0;
      runMs[L] = 0;
      var s = Math.max(dayAt(todayKey, c.start), last + 30 * MIN);
      if (nowMs - s < 5 * HOUR) return;
      var e = nowMs - irand(30, 60) * MIN;
      checklist(L, 'start', s, { op: op, product: product[L], then: { state: 'run' } });
      if (e - s > 4 * HOUR) doStop(L, s + 2 * HOUR, 25, 'Очікування', op);
      endShift(L, todayKey, e, op, { short: true });
    })();

    /* --- копіювання в цільове сховище: один insert на таблицю --- */
    var counts = {};
    TABLES.forEach(function (t) {
      if (t === 'settings' || t === 'notices' || t === 'plan') return;
      var rows = mem.data[t] || [];
      counts[t] = rows.length;
      if (rows.length) target.insert(t, rows.map(copy));
    });
    var missing = settingRows.filter(function (r) { return !has(existing, r.key); });
    if (missing.length) target.insert('settings', missing);
    if (has(existing, 'products') && isBlank(existing.products.value)) {
      target.update('settings', [{ key: 'products', value: settingCell(META_BY_KEY.products, P) }]);
    }
    counts.settings = missing.length;

    clock = nowMs;
    var due = app.dueAll(now), states = {};
    LINES.forEach(function (L) { states[L] = st[L] ? st[L].state : 'off'; });
    return {
      ok: true, from: new Date(t0), to: now, days: days, counts: counts, states: states,
      due: due.filter(function (d) { return d.status === 'due'; }).length,
      soon: due.filter(function (d) { return d.status === 'soon'; }).length
    };
  }

  /* ------------------------------ публічний інтерфейс ------------------------------ */
  return {
    VERSION: VERSION,
    SCHEMA: SCHEMA,
    LABELS: LABELS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    SETTINGS_META: SETTINGS_META,
    TABLES: TABLES,
    LOG_TABLES: LOG_TABLES,
    ACTIONS: ACTIONS,
    ERR_MSG: ERR_MSG,
    DEMO_PRODUCTS: DEMO_PRODUCTS,
    norm: norm,
    denorm: denorm,
    label: label,
    MemoryStore: MemoryStore,
    createApp: createApp,
    seedDemo: seedDemo,
    sha256: sha256,
    pinHash: pinHash,
    wire: wire,
    util: {
      uuid: uuid,
      parseDate: parseDate,
      dayKey: defDayKey,
      dayStart: defDayStart,
      timeKit: timeKit,
      defaultEnv: defaultEnv,
      addDays: addDays,
      keyAdd: keyAdd,
      keyDiff: keyDiff,
      keyDow: keyDow,
      isKey: isKey,
      hoursBetween: hoursBetween,
      round: round,
      clamp: clamp,
      toNum: toNum,
      toBool: toBool,
      toStr: toStr,
      toList: toList,
      toIds: toIds,
      toEnum: toEnum,
      toEnums: toEnums,
      toEmails: toEmails,
      isEmail: isEmail,
      esc: esc,
      fmtNum: fmtNum,
      fmtHours: fmtHours,
      wire: wire,
      mulberry32: mulberry32,
      coerceSetting: function (key, v) { var m = META_BY_KEY[key]; return m ? coerceSetting(m, v) : toStr(v); },
      settingCell: function (key, v) { var m = META_BY_KEY[key]; return m ? settingCell(m, v) : toStr(v); },
      errorResponse: errorResponse,
      AppError: AppError
    }
  };

})();
if (typeof module === 'object' && module && module.exports) module.exports = LinesCore;
