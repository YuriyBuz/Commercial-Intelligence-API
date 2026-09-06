/**
 * FOODLINE · Commercial Intelligence API
 * Віддає у JSON: продажі, собівартість, умови мереж і нормалізований промо-план.
 *
 * Розгортання:
 *   1. Розширення → Apps Script (у будь-якій з таблиць або окремий проєкт)
 *   2. Вставити цей файл
 *   3. Налаштування проєкту → Властивості скрипта → додати DATA_ID і PROMO_ID
 *      (ID таблиць навмисно не зашиті в код: цей репозиторій публічний,
 *       а те, що потрапило в git-історію, звідти вже не прибрати)
 *   4. Запустити setup() один раз — він створить токен. Забрати значення
 *      з Властивостей скрипта (у лог токен не пишеться)
 *   5. Розгорнути → Новий розгортання → Веб-додаток
 *      «Виконувати як: Я», «Хто має доступ: Усі»
 *      Доступ «Усі» потрібен для JSONP з GitHub Pages, тому єдиний бар'єр —
 *      токен. Самі таблиці при цьому мають бути закриті: вебдодаток читає їх
 *      від імені власника й без публічного доступу до них
 *   6. Скопіювати URL + токен у панель («Джерело даних»)
 *
 * Ендпоінти (GET):
 *   ?token=XXX&action=ping
 *   ?token=XXX&action=all          — усе одразу (за замовчуванням)
 *   ?token=XXX&action=light        — усе, крім важкого масиву продажів
 *   ?token=XXX&action=sales|cost|terms|promo|profit
 *   &callback=fn                   — JSONP (обхід CORS з GitHub Pages)
 *   &fresh=1                       — ігнорувати кеш (не частіше, ніж раз на FRESH_MIN)
 */

var CFG = {
  // Назви аркушів у таблиці BIG DATA. Якщо не знайдено — береться за позицією.
  SHEET_SALES:  'Данні продажів',
  SHEET_COST:   'Собівартість',
  SHEET_TERMS:  'Умови мереж',
  SHEET_PROFIT: 'рент',

  // Рік, до якого належать дані аркуша рентабельності (там лише назви місяців)
  PROFIT_YEAR: 2026,

  // Аркуші промо-плану, які ігнорувати (службові)
  PROMO_SKIP: ['інструкція', 'instruction', 'довідник', 'служб', 'temp', 'шаблон'],

  CACHE_MIN: 120,         // хвилин життя кешу
  FRESH_MIN: 10,          // мінімум хвилин між примусовими перечитуваннями
  CHUNK: 90000,           // розмір шматка кешу (ліміт CacheService ~100 КБ)
  CHUNK_MAX: 150          // максимум шматків (понад це кеш не пишемо)
};

/** Дозволені значення action. Довільні значення створювали б сміттєві ключі кешу. */
var ACTIONS_ = ['ping', 'all', 'light', 'sales', 'cost', 'terms', 'promo', 'profit'];

/** ID таблиць — лише з властивостей скрипта, не з коду */
function cfgId_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('Не задано властивість скрипта ' + key);
  return v;
}

/* ============================ ТОЧКА ВХОДУ ============================ */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var cb = safeCallback_(p.callback);
  try {
    if (!checkToken_(p.token)) return out_({ ok: false, error: 'BAD_TOKEN' }, cb);

    var action = String(p.action || 'all').toLowerCase();
    if (ACTIONS_.indexOf(action) < 0) return out_({ ok: false, error: 'BAD_ACTION' }, cb);

    if (action === 'ping') {
      return out_({ ok: true, pong: true, time: new Date().toISOString(), version: '1.3' }, cb);
    }

    // fresh дороге: повне перечитування обох таблиць. Без обмеження будь-хто,
    // хто дістався ендпоінта, здатен вичерпати добову квоту Apps Script.
    var fresh = p.fresh === '1' && freshAllowed_();

    // light — усе, крім важкого масиву продажів: панель стартує швидше
    var light = action === 'light';
    var payload = cached_('fl_' + action, fresh, function () {
      var d = { ok: true, generated: new Date().toISOString(), action: action };
      if (action === 'all' || action === 'sales') d.sales = readSales_();
      if (action === 'all' || light || action === 'cost')  d.cost  = readCost_();
      if (action === 'all' || light || action === 'terms') d.terms = readTerms_();
      if (action === 'all' || light || action === 'profit') {
        var pf = readProfit_();
        d.profit = pf.table;
        d.profitDiag = pf.diag;
      }
      if (action === 'all' || light || action === 'promo') {
        var pr = readPromo_();
        d.promo = pr.table;
        d.promoDiag = pr.diag;
      }
      return d;
    });

    return outRaw_(payload, cb);
  } catch (err) {
    // Стек лишається в журналі виконання, назовні — лише факт помилки:
    // інакше будь-який запит показує назви аркушів і внутрішню структуру.
    console.error(err && err.stack || err);
    return out_({ ok: false, error: 'INTERNAL' }, cb);
  }
}

/**
 * Ім'я callback потрапляє у відповідь із типом text/javascript, тобто
 * виконується у браузері. Пропускаємо лише звичайний ідентифікатор —
 * інакше ендпоінт став би хостингом довільного JS на домені Google.
 */
var CALLBACK_RE_ = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

function safeCallback_(cb) {
  cb = String(cb || '');
  return CALLBACK_RE_.test(cb) ? cb : '';
}

function out_(obj, cb) { return outRaw_(JSON.stringify(obj), cb); }

function outRaw_(json, cb) {
  if (cb) {
    return ContentService
      .createTextOutput(cb + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/* ============================ ТОКЕН ============================ */

function setup() {
  var props = PropertiesService.getScriptProperties();
  var t = props.getProperty('API_TOKEN');
  if (!t) {
    t = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('API_TOKEN', t);
  }
  // Токен навмисно не потрапляє в Logger: журнали виконання зберігаються
  // і видимі всім, хто має доступ на редагування проєкту.
  Logger.log('Готово. Значення — у Налаштування проєкту → Властивості скрипта → API_TOKEN');
}

/** Скинути токен: старий одразу перестає діяти, панелям треба ввести новий */
function rotateToken() {
  PropertiesService.getScriptProperties()
    .setProperty('API_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  Logger.log('Токен замінено. Нове значення — у Властивостях скрипта.');
}

function checkToken_(t) {
  var real = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!real) {
    // Раніше тут стояло «немає токена — пускаємо всіх». При розгортанні
    // «Хто має доступ: Усі» це віддавало всі дані анонімно.
    console.error('API_TOKEN не задано — запити відхиляються. Запустіть setup().');
    return false;
  }
  t = String(t || '');
  if (t.length !== real.length) return false;
  var diff = 0;
  for (var i = 0; i < t.length; i++) diff |= t.charCodeAt(i) ^ real.charCodeAt(i);
  return diff === 0;
}

/* ============================ КЕШ ============================ */

/** Не частіше одного примусового перечитування на FRESH_MIN хвилин */
function freshAllowed_() {
  var c = CacheService.getScriptCache();
  if (c.get('fl_fresh_lock')) return false;
  c.put('fl_fresh_lock', '1', CFG.FRESH_MIN * 60);
  return true;
}

function cached_(key, fresh, producer) {
  var cache = CacheService.getScriptCache();
  if (!fresh) {
    var metaRaw = cache.get(key + '_meta');
    if (metaRaw) {
      var meta = JSON.parse(metaRaw);
      var keys = [];
      for (var i = 0; i < meta.n; i++) keys.push(key + '_' + i);
      var parts = cache.getAll(keys);
      var buf = '', complete = true;
      for (var j = 0; j < meta.n; j++) {
        var s = parts[key + '_' + j];
        if (s == null) { complete = false; break; }
        buf += s;
      }
      if (complete) return buf;
    }
  }
  var json = JSON.stringify(producer());
  try {
    var n = Math.ceil(json.length / CFG.CHUNK), map = {};
    if (n <= CFG.CHUNK_MAX) {
      for (var k = 0; k < n; k++) map[key + '_' + k] = json.substr(k * CFG.CHUNK, CFG.CHUNK);
      map[key + '_meta'] = JSON.stringify({ n: n, at: Date.now() });
      cache.putAll(map, CFG.CACHE_MIN * 60);
    }
  } catch (e) { /* кеш не критичний */ }
  return json;
}

function clearCache() {
  var c = CacheService.getScriptCache();
  // Раніше список був неповний — 'light' і 'profit' не чистилися,
  // хоча панель користується саме 'light'.
  ACTIONS_.forEach(function (a) {
    var meta = c.get('fl_' + a + '_meta');
    if (meta) {
      var n = JSON.parse(meta).n, ks = ['fl_' + a + '_meta'];
      for (var i = 0; i < n; i++) ks.push('fl_' + a + '_' + i);
      c.removeAll(ks);
    }
  });
  c.remove('fl_fresh_lock');
  return 'ok';
}

/* ============================ ХЕЛПЕРИ ============================ */

/**
 * Замінює текстові колонки на індекси у спільному словнику.
 * Назва SKU повторюється десятки тисяч разів — це головна вага відповіді.
 */
function encode_(cols, rows, textCols) {
  var idx = {}, dict = {}, pos = {};
  textCols.forEach(function (name) {
    var c = cols.indexOf(name);
    if (c < 0) return;
    idx[name] = c; dict[name] = []; pos[name] = {};
  });
  for (var r = 0; r < rows.length; r++) {
    for (var name in idx) {
      var c = idx[name], v = String(rows[r][c] === null || rows[r][c] === undefined ? '' : rows[r][c]);
      var p = pos[name][v];
      if (p === undefined) { p = dict[name].length; dict[name].push(v); pos[name][v] = p; }
      rows[r][c] = p;
    }
  }
  return { cols: cols, rows: rows, enc: dict };
}

/** Підписи шапок, які не можна плутати з номенклатурою.
 *  \b не працює з кирилицею, тому межу слова описуємо явно. */
var HEADERISH_ = /^(наименование|наименовани|назва|номенклатура|код товара|код товару|артикул|штрих|товар|итого|разом|всього|усього|прогноз|план|ціна|цена|механ|мережа|бренд|неделя|тиждень|месяц|місяць)(\s|$|[:.,()])/i;

/** Округлення, щоб не тягнути 12 знаків після коми */
function r2_(v) { return Math.round((+v || 0) * 100) / 100; }
function r3_(v) { return Math.round((+v || 0) * 1000) / 1000; }

function sheetBy_(ss, name, fallbackIdx) {
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  var all = ss.getSheets();
  return all[fallbackIdx] || all[0];
}

/** «1 234,56» / «-1 872» / Date → число */
function num_(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  var s = String(v)
    .replace(/\u00A0/g, '')
    .replace(/\s/g, '')
    .replace(/[^\d,.\-]/g, '')
    .replace(/,/g, '.');
  var parts = s.split('.');
  if (parts.length > 2) s = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function str_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v).replace(/\u00A0/g, ' ').trim();
}

var MONTHS_ = {
  'январь': 1, 'січень': 1, 'янв': 1, 'січ': 1,
  'февраль': 2, 'лютий': 2, 'фев': 2, 'лют': 2,
  'март': 3, 'березень': 3, 'мар': 3, 'бер': 3,
  'апрель': 4, 'квітень': 4, 'апр': 4, 'кві': 4,
  'май': 5, 'травень': 5, 'мая': 5, 'тра': 5,
  'июнь': 6, 'червень': 6, 'июн': 6, 'чер': 6,
  'июль': 7, 'липень': 7, 'июл': 7, 'лип': 7,
  'август': 8, 'серпень': 8, 'авг': 8, 'сер': 8,
  'сентябрь': 9, 'вересень': 9, 'сен': 9, 'вер': 9,
  'октябрь': 10, 'жовтень': 10, 'окт': 10, 'жов': 10,
  'ноябрь': 11, 'листопад': 11, 'ноя': 11, 'лис': 11,
  'декабрь': 12, 'грудень': 12, 'дек': 12, 'гру': 12
};

function monthNum_(v) {
  if (typeof v === 'number' && v >= 1 && v <= 12) return v;
  var s = String(v || '').toLowerCase().replace(/[.\s]/g, '');
  if (MONTHS_[s]) return MONTHS_[s];
  for (var k in MONTHS_) if (s.indexOf(k) === 0) return MONTHS_[k];
  var n = parseInt(s, 10);
  return (n >= 1 && n <= 12) ? n : 0;
}

/**
 * Обережно: «32.30» — це ціна, а не 32 березня. Тому з тексту приймаємо
 * лише повну дату з роком, а короткий формат — тільки там, де ми вже знаємо,
 * що дивимось на шапку тижнів (isWeekDate_).
 */
function isDateCell_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return true;
  var s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true;
  var m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})$/);
  return !!(m && +m[1] >= 1 && +m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12);
}

/** Значення комірки як мітка часу, або null */
function dateVal_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return v.getTime();
  var iso = toISO_(v);
  if (!iso) return null;
  var d = new Date(iso + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d.getTime();
}

function toISO_(v, defYear) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  var m = s.match(/^(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?$/);
  if (!m) return '';
  if (+m[1] < 1 || +m[1] > 31 || +m[2] < 1 || +m[2] > 12) return '';
  if (!m[3] && !defYear) return '';
  var y = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : String(defYear);
  return y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
}

/* ============================ ПРОДАЖІ ============================ */
/**
 * Агрегує до рівня рік · місяць · партнер · бренд · SKU · підрозділ · менеджер.
 * Торгова точка згортається (інакше payload завеликий), але кількість ТТ рахується.
 */
function readSales_() {
  var ss = SpreadsheetApp.openById(cfgId_('DATA_ID'));
  var sh = sheetBy_(ss, CFG.SHEET_SALES, 0);
  var vals = sh.getDataRange().getValues();
  if (!vals.length) return { cols: [], rows: [] };

  var head = vals[0].map(function (h) { return str_(h).toLowerCase(); });
  function col(names, def) {
    for (var i = 0; i < head.length; i++)
      for (var j = 0; j < names.length; j++)
        if (head[i].indexOf(names[j]) === 0) return i;
    return def;
  }
  var C = {
    year:    col(['год', 'рік'], 0),
    month:   col(['месяц', 'місяц'], 1),
    partner: col(['партнер', 'контраг'], 2),
    outlet:  col(['торгов', 'точка'], 3),
    brand:   col(['бренд', 'тм'], 4),
    sku:     col(['номенклат'], 5),
    div:     col(['подразд', 'підрозд'], 6),
    mgr:     col(['менедж'], 7),
    qty:     col(['количест', 'кількіс'], 8),
    lit:     col(['литр', 'літр'], 9),
    rev:     col(['выручк', 'виручк', 'сумма', 'сума'], 10)
  };

  var agg = {}, outlets = {};
  for (var r = 1; r < vals.length; r++) {
    var row = vals[r];
    var sku = str_(row[C.sku]);
    if (!sku) continue;
    var y = num_(row[C.year]) || 0;
    var m = monthNum_(row[C.month]);
    if (!y || !m) continue;

    var partner = str_(row[C.partner]);
    var brand   = str_(row[C.brand]) || '—';
    var key = y + '|' + m + '|' + partner + '|' + brand + '|' + sku + '|' +
              str_(row[C.div]) + '|' + str_(row[C.mgr]);

    if (!agg[key]) {
      agg[key] = [y, m, partner, brand, sku, str_(row[C.div]), str_(row[C.mgr]), 0, 0, 0, 0];
      outlets[key] = {};
    }
    var a = agg[key];
    a[7] += num_(row[C.qty]);
    a[8] += num_(row[C.lit]);
    a[9] += num_(row[C.rev]);
    var o = str_(row[C.outlet]);
    if (o) outlets[key][o] = 1;
  }

  var rows = [];
  for (var k in agg) {
    var a = agg[k];
    a[7] = r2_(a[7]); a[8] = r3_(a[8]); a[9] = r2_(a[9]);
    a[10] = Object.keys(outlets[k]).length;
    rows.push(a);
  }

  var out = encode_(
    ['year', 'month', 'partner', 'brand', 'sku', 'division', 'manager', 'qty', 'litres', 'revenue', 'outlets'],
    rows, ['partner', 'brand', 'sku', 'division', 'manager']);
  out.sourceRows = vals.length - 1;
  return out;
}

/* ============================ СОБІВАРТІСТЬ ============================ */

function readCost_() {
  var ss = SpreadsheetApp.openById(cfgId_('DATA_ID'));
  var sh = sheetBy_(ss, CFG.SHEET_COST, 1);
  var vals = sh.getDataRange().getValues();

  // шукаємо рядок-заголовок (там, де є «Номенклатура»)
  var hr = -1;
  for (var r = 0; r < Math.min(vals.length, 30); r++) {
    for (var c = 0; c < vals[r].length; c++) {
      if (str_(vals[r][c]).toLowerCase().indexOf('номенклат') === 0) { hr = r; break; }
    }
    if (hr >= 0) break;
  }
  if (hr < 0) return { cols: [], rows: [] };

  var head = vals[hr].map(function (h) { return str_(h).toLowerCase(); });
  function find(sub, def) {
    for (var i = 0; i < head.length; i++) if (head[i].indexOf(sub) >= 0) return i;
    return def;
  }
  var C = {
    sku:   find('номенклат', 0),
    price: find('цена без', 1),
    qty:   find('количест', 2),
    lit:   find('литр', 3),
    mat:   find('себестоимость (матери', find('себестоимость матери', 6)),
    wage:  find('сдельная з/п за 1', find('себестоимость (сдельн', 7)),
    extra: find('доп. затраты на 1', find('доп затраты', 8)),
    ratio: find('соотношение', 9)
  };
  // «Себестоимость (материалы) за 1шт.» vs «Себестоимость материалов» (сумарна)
  var matUnit = -1;
  for (var i = 0; i < head.length; i++) {
    if (head[i].indexOf('матери') >= 0 && head[i].indexOf('за 1') >= 0) matUnit = i;
  }
  if (matUnit >= 0) C.mat = matUnit;
  var wageUnit = -1;
  for (var i2 = 0; i2 < head.length; i2++) {
    if (head[i2].indexOf('сдельн') >= 0 && head[i2].indexOf('за 1') >= 0) wageUnit = i2;
  }
  if (wageUnit >= 0) C.wage = wageUnit;

  var rows = [];
  for (var r2 = hr + 1; r2 < vals.length; r2++) {
    var sku = str_(vals[r2][C.sku]);
    if (!sku || /^итого|^разом|^всього|^номенклат/i.test(sku)) continue;
    var mat = num_(vals[r2][C.mat]);
    var wage = num_(vals[r2][C.wage]);
    var extra = num_(vals[r2][C.extra]);
    var total = num_(vals[r2][C.price]);
    if (!total) total = mat + wage + extra;
    var qty = num_(vals[r2][C.qty]);
    if (!total && !qty) continue;                    // порожній або повторний заголовок
    rows.push([sku, total, mat, wage, extra, qty, num_(vals[r2][C.lit])]);
  }
  return {
    cols: ['sku', 'unitCost', 'matPerUnit', 'wagePerUnit', 'extraPerUnit', 'qtyPeriod', 'litresPeriod'],
    rows: rows
  };
}

/* ============================ УМОВИ МЕРЕЖ ============================ */

function readTerms_() {
  var ss = SpreadsheetApp.openById(cfgId_('DATA_ID'));
  var sh = sheetBy_(ss, CFG.SHEET_TERMS, 2);
  var vals = sh.getDataRange().getValues();

  var hr = -1;
  for (var r = 0; r < Math.min(vals.length, 20); r++) {
    if (str_(vals[r][0]).toLowerCase().indexOf('мереж') === 0) { hr = r; break; }
  }
  if (hr < 0) hr = 0;

  function pct(v) {
    var s = str_(v);
    if (!s || s === '-' || s === '—' || s === '–') return 0;
    var n = num_(s);
    if (typeof v === 'number' && v > 0 && v < 1) return v * 100;
    return n;
  }

  var rows = [];
  for (var r2 = hr + 1; r2 < vals.length; r2++) {
    var name = str_(vals[r2][0]);
    if (!name) continue;
    rows.push([
      name,
      pct(vals[r2][1]),                      // ретро
      pct(vals[r2][2]),                      // маркетинговий бюджет
      pct(vals[r2][3]),                      // компенсація
      pct(vals[r2][4]),                      // логістичний бонус
      pct(vals[r2][5]),                      // додатковий бюджет
      pct(vals[r2][6]),                      // разом
      num_(vals[r2][7]),                     // відтермінування, днів
      str_(vals[r2][8])                      // статус
    ]);
  }
  return {
    cols: ['chain', 'retro', 'mb', 'compensation', 'lb', 'extraBudget', 'totalBonus', 'delayDays', 'status'],
    rows: rows
  };
}

/* ============================ РЕНТАБЕЛЬНІСТЬ (ФАКТ) ============================ */
/**
 * Аркуш «рент»: ієрархічний звіт партнер → бренд → номенклатура по місяцях.
 * Дає фактичний маркетинг у гривнях, а не оцінку з довідника умов.
 */
function readProfit_() {
  var ss = SpreadsheetApp.openById(cfgId_('DATA_ID'));
  var sh = null, all = ss.getSheets();
  for (var i = 0; i < all.length; i++) {
    if (all[i].getName().toLowerCase().indexOf(CFG.SHEET_PROFIT.toLowerCase()) >= 0) { sh = all[i]; break; }
  }
  if (!sh) return { table: { cols: [], rows: [] }, diag: { error: 'аркуш не знайдено' } };

  var vals = sh.getDataRange().getValues();
  if (vals.length < 4) return { table: { cols: [], rows: [] }, diag: { error: 'аркуш порожній' } };

  // останній рядок шапки — той, де в колонці назви написано «Номенклатура»
  var hr = -1;
  for (var r = 0; r < Math.min(vals.length, 20); r++) {
    for (var c = 0; c < Math.min(vals[r].length, 4); c++) {
      if (str_(vals[r][c]).toLowerCase().indexOf('номенклат') === 0) { hr = r; }
    }
  }
  if (hr < 0) return { table: { cols: [], rows: [] }, diag: { error: 'шапку не знайдено' } };

  // колонка з назвою — та, де стоїть «Номенклатура»
  var nameCol = 1;
  for (var c2 = 0; c2 < Math.min(vals[hr].length, 4); c2++) {
    if (str_(vals[hr][c2]).toLowerCase().indexOf('номенклат') === 0) nameCol = c2;
  }
  var monthCol = nameCol > 0 ? nameCol - 1 : 0;

  // склеюємо всі рядки шапки по колонках
  var wide = [];
  for (var c3 = 0; c3 < vals[hr].length; c3++) {
    var t = '';
    for (var hh = Math.max(0, hr - 2); hh <= hr; hh++) t += ' ' + str_(vals[hh][c3]);
    wide[c3] = t.toLowerCase();
  }
  function col(parts) {
    for (var c = 0; c < wide.length; c++) {
      var ok = true;
      for (var p = 0; p < parts.length; p++) if (wide[c].indexOf(parts[p]) < 0) ok = false;
      if (ok) return c;
    }
    return -1;
  }
  var C = {
    ros:      col(['рентабельн', 'продаж']),
    roTotal:  col(['рентабельн', 'общая']),
    income:   col(['доход']),
    revenue:  col(['выручка']),
    cogs:     col(['себестоимость']),
    mktBuy:   col(['маркетинг', 'покупатели']),
    mktSup:   col(['маркетинг', 'поставщики']),
    delivery: col(['тариф']),
    oneBuy:   col(['разовый', 'покупатели']),
    oneSup:   col(['разовый', 'поставщики'])
  };
  // «разовый» ділить підписи з основним маркетингом — беремо останні збіги
  for (var c4 = wide.length - 1; c4 >= 0; c4--) {
    if (wide[c4].indexOf('разовый') >= 0 && wide[c4].indexOf('покупатели') >= 0) { C.oneBuy = c4; break; }
  }
  for (var c5 = wide.length - 1; c5 >= 0; c5--) {
    if (wide[c5].indexOf('разовый') >= 0 && wide[c5].indexOf('поставщики') >= 0) { C.oneSup = c5; break; }
  }

  var rows = [], curPartner = '', curBrand = '';
  var counts = { partner: 0, brand: 0, sku: 0, skipped: 0 };

  for (var r2 = hr + 1; r2 < vals.length; r2++) {
    var name = str_(vals[r2][nameCol]);
    if (!name) { counts.skipped++; continue; }
    var mon = monthNum_(str_(vals[r2][monthCol]));
    if (!mon) { counts.skipped++; continue; }

    var level = classifyProfitRow_(name);
    if (level === 1) { curPartner = name; curBrand = ''; counts.partner++; }
    else if (level === 2) { curBrand = name; counts.brand++; }
    else counts.sku++;

    rows.push([
      CFG.PROFIT_YEAR, mon, level,
      level === 1 ? name : curPartner,
      level === 2 ? name : (level === 3 ? curBrand : ''),
      level === 3 ? name : '',
      num_(vals[r2][C.ros]), num_(vals[r2][C.roTotal]),
      num_(vals[r2][C.income]), num_(vals[r2][C.revenue]), num_(vals[r2][C.cogs]),
      num_(vals[r2][C.mktBuy]), num_(vals[r2][C.mktSup]), num_(vals[r2][C.delivery]),
      num_(vals[r2][C.oneBuy]), num_(vals[r2][C.oneSup])
    ]);
  }

  return {
    table: encode_(
      ['year', 'month', 'level', 'partner', 'brand', 'sku',
        'rosPct', 'roTotalPct', 'income', 'revenue', 'cogs',
        'mktBuyers', 'mktSuppliers', 'delivery', 'oneTimeBuyers', 'oneTimeSuppliers'],
      rows, ['partner', 'brand', 'sku']),
    diag: { sheet: sh.getName(), headerRow: hr + 1, nameCol: nameCol + 1, cols: C, counts: counts }
  };
}

/** 1 — партнер, 2 — бренд, 3 — номенклатура */
function classifyProfitRow_(name) {
  if (/\d+\s*(мл|гр\b|г\b|кг|л\b|шт)/i.test(name) || name.length > 45) return 3;
  if (/\b(тов|фоп|пп|груп|група|группа|маркет|компані|компани|трейд|фуд|логістик)\b/i.test(name)) return 1;
  if (/(ТОВ|ФОП|ПП|ГРУП|ТзОВ)\s*$/.test(name) || /^(ТОВ|ФОП|ПП)\s/.test(name)) return 1;
  return 2;
}

/* ============================ ПРОМО-ПЛАН ============================ */
/**
 * Реальна структура аркушів: колонки — тижні (понеділки), а кожен SKU займає
 * блок із кількох під-рядків, підписаних у службовій колонці:
 *
 *   прогноз, кол-во   → плановий обсяг (число)
 *   название промо    → назва механіки (текст) — те, що видно на полиці
 *   стоимость промо   → промо-ціна (число)
 *   условия           → глибина знижки: «25%», «30% комп.» або число
 *
 * Ліворуч можуть бути ШК, артикул, базова ціна («цена б/НДС» / «ціна без ПДВ»)
 * та представленість у ТТ. Деякі аркуші містять кілька секцій (2025 і 2026)
 * одна під одною — кожна зі своєю шапкою тижнів.
 */

var LABELS_ = [
  { k: 'plan',    re: /(прогноз|план|кол-?во|кількіс|обсяг|объ[её]м)/i },
  { k: 'name',    re: /(назв|наимен).{0,12}(промо|акц)|^\s*(промо|акц[іи])/i },
  { k: 'price',   re: /(стоимость|вартіст|ціна\s*промо|цена\s*промо|промо.{0,3}цін|промо.{0,3}цен|сц)/i },
  { k: 'terms',   re: /(умов|услови|знижк|скидк|глибин|глубин|компенс)/i },
  { k: 'start',   re: /(старт|відвантаж|отгруз|поставк)/i },
  { k: 'outlets', re: /(представлен|кільк.{0,8}тт|тт\b)/i }
];

function labelKind_(txt) {
  var t = str_(txt);
  if (!t) return '';
  for (var i = 0; i < LABELS_.length; i++) if (LABELS_[i].re.test(t)) return LABELS_[i].k;
  return '';
}

/** Витягує глибину знижки з тексту або числа: «30% комп.» → 30, 0.25 → 25 */
function depthOf_(raw) {
  if (typeof raw === 'number') {
    if (raw > 0 && raw <= 1) return Math.round(raw * 1000) / 10;
    if (raw > 1 && raw <= 95) return Math.round(raw * 10) / 10;
    return null;
  }
  var t = str_(raw);
  var m = t.match(/(\d{1,3}(?:[.,]\d+)?)\s*%/);
  if (m) {
    var v = parseFloat(m[1].replace(',', '.'));
    return (v > 0 && v <= 95) ? v : null;
  }
  return null;
}

/** Рядки шапки тижнів: щонайменше 4 дати, більшість з кроком рівно 7 днів */
function weekHeaderRows_(vals) {
  var out = [];
  for (var r = 0; r < vals.length; r++) {
    var cols = [], stamps = [];
    for (var c = 0; c < vals[r].length; c++) {
      if (isDateCell_(vals[r][c])) {
        var ts = dateVal_(vals[r][c]);
        if (ts !== null) { cols.push(c); stamps.push(ts); }
      }
    }
    if (cols.length < 4) continue;
    var weekly = 0;
    for (var i = 1; i < stamps.length; i++) {
      var d = Math.round((stamps[i] - stamps[i - 1]) / 86400000);
      if (d === 7 || d === 14 || d === 0) weekly++;
    }
    if (weekly / (stamps.length - 1) >= 0.6) out.push({ row: r, cols: cols });
  }
  return out;
}

function readPromo_() {
  var ss = SpreadsheetApp.openById(cfgId_('PROMO_ID'));
  var sheets = ss.getSheets();
  var rows = [], diag = [];

  sheets.forEach(function (sh) {
    var name = sh.getName(), lower = name.toLowerCase();
    for (var s = 0; s < CFG.PROMO_SKIP.length; s++) {
      if (lower.indexOf(CFG.PROMO_SKIP[s]) >= 0) { diag.push({ sheet: name, skipped: true }); return; }
    }
    if (sh.isSheetHidden()) { diag.push({ sheet: name, skipped: true, hidden: true }); return; }

    var vals;
    try { vals = sh.getDataRange().getValues(); }
    catch (e) { diag.push({ sheet: name, error: String(e) }); return; }
    if (vals.length < 3) { diag.push({ sheet: name, skipped: true, empty: true }); return; }

    var heads = weekHeaderRows_(vals);
    if (!heads.length) {
      diag.push({ sheet: name, skipped: true, reason: 'шапку тижнів не знайдено' });
      return;
    }

    var sheetDiag = {
      sheet: name, sections: [], weeks: 0, skus: 0, cells: 0,
      metrics: { plan: 0, name: 0, price: 0, terms: 0, start: 0, note: 0 },
      withDepth: 0
    };
    var skuSet = {};

    heads.forEach(function (H, hi) {
      var hr = H.row;
      var stop = (hi + 1 < heads.length) ? heads[hi + 1].row : vals.length;
      var firstWeekCol = H.cols[0];

      var weekCol = {};
      H.cols.forEach(function (c) {
        var iso = toISO_(vals[hr][c]);
        if (iso) weekCol[c] = iso;
      });
      var nWeeks = 0;
      for (var wk in weekCol) nWeeks++;
      if (!nWeeks) return;

      /* --- ліві колонки --- */
      var titles = [];
      for (var c2 = 0; c2 < firstWeekCol; c2++) {
        var t = '';
        for (var hh = Math.max(0, hr - 3); hh <= hr; hh++) t += ' ' + str_(vals[hh][c2]);
        titles[c2] = t.toLowerCase();
      }
      function byTitle(re) {
        for (var c = 0; c < titles.length; c++) if (re.test(titles[c])) return c;
        return -1;
      }
      var barcodeCol = byTitle(/шк|штрих/);
      var articleCol = byTitle(/артикул|код товар/);
      var priceCol   = byTitle(/цін[аи]?\s*(без|б\/)|цена\s*(без|б\/)/);
      var outletsCol = byTitle(/представлен/);

      /* колонка міток — та, де найчастіше трапляються відомі підписи */
      var labelCol = -1, labelHits = 0;
      for (var lc = 0; lc < firstWeekCol; lc++) {
        var hits = 0;
        for (var rr = hr + 1; rr < stop; rr++) if (labelKind_(vals[rr][lc])) hits++;
        if (hits > labelHits) { labelHits = hits; labelCol = lc; }
      }
      if (labelHits < 3) labelCol = -1;

      /* колонка назви — найдовші тексти серед лівих, крім службових */
      var nameCol = -1, nameScore = 0;
      for (var nc = 0; nc < firstWeekCol; nc++) {
        if (nc === labelCol || nc === barcodeCol || nc === articleCol) continue;
        var len = 0, cnt = 0;
        for (var r3 = hr + 1; r3 < stop; r3++) {
          var v = str_(vals[r3][nc]);
          if (v && !/^\d+([.,]\d+)?$/.test(v)) { len += v.length; cnt++; }
        }
        var avg = cnt ? len / cnt : 0;
        if (avg > nameScore) { nameScore = avg; nameCol = nc; }
      }
      if (nameCol < 0) return;
      var brandCol = (nameCol > 0 && nameCol !== 0) ? 0 : -1;
      if (brandCol === labelCol || brandCol === barcodeCol) brandCol = -1;

      /* рік секції — з дат шапки */
      var secYear = +weekCol[H.cols[0]].slice(0, 4);

      /* --- обхід --- */
      var curBrand = '', curSku = '', curBc = '', curArt = '', curPrice = 0, curOutlets = 0;
      var secCells = 0;

      for (var r4 = hr + 1; r4 < stop; r4++) {
        var row = vals[r4];

        var nm = str_(row[nameCol]);
        if (nm && HEADERISH_.test(nm)) nm = '';
        if (nm && nm.length > 6 && !/^\d+([.,]\d+)?$/.test(nm)) {
          curSku = nm;
          curBc = barcodeCol >= 0 ? str_(row[barcodeCol]) : '';
          curArt = articleCol >= 0 ? str_(row[articleCol]) : '';
          curPrice = priceCol >= 0 ? num_(row[priceCol]) : 0;
          curOutlets = outletsCol >= 0 ? num_(row[outletsCol]) : 0;
          skuSet[curSku] = 1;
        } else if (nm === '' && curSku) {
          /* об'єднані комірки: підтягуємо те, що з'явилось у під-рядку */
          if (!curPrice && priceCol >= 0) curPrice = num_(row[priceCol]);
          if (!curBc && barcodeCol >= 0) curBc = str_(row[barcodeCol]);
        }
        if (brandCol >= 0) {
          var b = str_(row[brandCol]);
          if (b && b.length < 40 && b !== curSku && !HEADERISH_.test(b)) curBrand = b;
        }
        if (!curSku) continue;

        var kind = labelCol >= 0 ? labelKind_(row[labelCol]) : '';

        for (var wc in weekCol) {
          var raw = row[wc];
          if (raw === '' || raw === null || raw === undefined) continue;
          var txt = str_(raw);
          if (!txt) continue;

          var metric = kind, textVal = '', numVal = null, depth = null;

          if (!metric) {
            /* аркуші без під-рядків: класифікуємо за вмістом */
            if (isDateCell_(raw)) metric = 'start';
            else if (depthOf_(raw) !== null && /%/.test(txt)) metric = 'terms';
            else if (typeof raw === 'number') metric = 'plan';
            else metric = 'name';
          }

          if (metric === 'start') {
            textVal = toISO_(raw, secYear);
            if (!textVal) { metric = 'note'; textVal = txt; }
          } else if (metric === 'terms') {
            depth = depthOf_(raw);
            textVal = txt;
            if (depth === null && !/%/.test(txt) && typeof raw !== 'number') metric = 'note';
          } else if (metric === 'plan' || metric === 'price' || metric === 'outlets') {
            numVal = num_(raw);
            if (!numVal) continue;
          } else {
            textVal = txt;
            var d2 = depthOf_(raw);
            if (d2 !== null && /%/.test(txt)) depth = d2;
          }

          rows.push([
            name, curBrand, curSku, curBc, curArt, curPrice, curOutlets,
            weekCol[wc], metric, textVal, numVal, depth
          ]);
          secCells++;
          if (sheetDiag.metrics[metric] !== undefined) sheetDiag.metrics[metric]++;
          if (depth !== null) sheetDiag.withDepth++;
        }
      }

      sheetDiag.sections.push({
        headerRow: hr + 1, year: secYear, weeks: nWeeks,
        nameCol: nameCol + 1,
        labelCol: labelCol >= 0 ? labelCol + 1 : null,
        priceCol: priceCol >= 0 ? priceCol + 1 : null,
        barcodeCol: barcodeCol >= 0 ? barcodeCol + 1 : null,
        cells: secCells
      });
      sheetDiag.weeks += nWeeks;
      sheetDiag.cells += secCells;
    });

    sheetDiag.skus = Object.keys(skuSet).length;
    diag.push(sheetDiag);
  });

  return {
    table: encode_(
      ['chain', 'brand', 'sku', 'barcode', 'article', 'basePrice', 'outletsPlan',
       'week', 'metric', 'text', 'value', 'depth'],
      rows, ['chain', 'brand', 'sku', 'barcode', 'article', 'week', 'metric', 'text']),
    diag: diag
  };
}

/* ============================ ТЕСТ ============================ */

function testAll() {
  var s = readSales_();  Logger.log('sales rows: ' + s.rows.length + ' (з ' + s.sourceRows + ')');
  var c = readCost_();   Logger.log('cost rows: ' + c.rows.length);
  var t = readTerms_();  Logger.log('terms rows: ' + t.rows.length);
  var p = readPromo_();  Logger.log('promo rows: ' + p.table.rows.length);
  Logger.log(JSON.stringify(p.diag, null, 1));
  var f = readProfit_(); Logger.log('profit rows: ' + f.table.rows.length);
  Logger.log(JSON.stringify(f.diag, null, 1));
}
