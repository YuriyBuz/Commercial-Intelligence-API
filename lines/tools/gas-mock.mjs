/* =====================================================================
   FOODLINE · Лінії — імітація (mock) сервісів Google Apps Script у памʼяті.
   Потрібна для тестів (tests/server.test.mjs) і локального емулятора
   (tools/dev-server.mjs), які виконують СПРАВЖНІ Core.gs + Server.gs у node:vm.

   ВИКОРИСТАННЯ
     import { createGasMock, loadGasProject } from './gas-mock.mjs';

     // 1) лише сервіси: глобальні імена для vm-контексту + інспектор стану
     const { globals, inspect } = createGasMock({ tz: 'Europe/Kyiv', now: '2026-09-25T06:00:00Z' });

     // 2) готовий проєкт: vm-контекст з Core.gs (assets/core.js) і Server.gs (як у GAS —
     //    звичайні скрипти зі спільною глобальною областю; функції верхнього рівня — ctx.*)
     const { ctx, inspect } = loadGasProject({ now: Date.now() });
     ctx.setup();
     const out = ctx.doPost({ postData: { contents: JSON.stringify({ action: 'ping' }) }, parameter: {} });
     out.getContent(); out.getMimeType();       // 'application/json' | 'application/javascript'

   ОПЦІЇ createGasMock(options)
     tz             — часовий пояс скрипту (appsscript.json → timeZone), типово 'Europe/Kyiv'
     spreadsheetTz  — часовий пояс таблиці (типово = tz); у ньому розбираються введені дати
     now            — годинник: Date | мс | ISO-рядок | функція → Date/мс; без нього — реальний час
     mailQuota      — залишок денного ліміту листів (типово 100)
     ui             — true: доступний SpreadsheetApp.getUi() (як у меню); типово false (веб-застосунок / тригер)
     sheets         — назви аркушів нової таблиці (типово ['Аркуш1'])
     spreadsheetId, spreadsheetName, userEmail, webAppUrl, echo (дублювати console.* у stdout)

   globals: SpreadsheetApp, LockService, CacheService, PropertiesService, MailApp, ScriptApp,
     ContentService, Utilities, Session, Logger, console, Date (підміна з керованим годинником:
     new Date() і Date.now() беруть час із mock; усе інше — як у справжнього Date).

   inspect (стан для перевірок у тестах):
     calls / resetCalls()      — лічильники викликів: getValues, setValues (також 'getValues:<аркуш>',
                                 'setValues:<аркуш>'), getFormulas, getRange, getLastRow, cellsRead,
                                 cellsWritten, flush, sendEmail …
     sheetNames(), sheet(name) — аркуш: values(), header(), records(), cell(r,c), formulas(), formatAt(r,c),
                                 validationAt(r,c), noteAt(r,c), styleAt(r,c,prop), lastRow, lastColumn,
                                 maxRows, maxColumns, frozenRows, tabColor; «людські» правки:
                                 type(r,c,v) / typeRow(r,arr) / appendRow(arr) (з автоперетворенням, як при
                                 введенні в Sheets), raw(r,c,v) (без перетворення), insertColumnBefore(c,n),
                                 moveColumn(from,to), deleteRows(r,n)
     formulas                  — журнал усіх формул, записаних через API [{sheet,row,col,formula}]
     spreadsheet               — { timeZone(), url, id }
     mails, mailQuota(n?), failNextMail(msg)
     triggers()                — [{id, handler, type, atHour, everyDays, everyHours, everyMinutes, tz, …}]
     properties()              — копія Script Properties
     cache                     — { get(k), keys(), clear() }
     lock                      — { hold(), release(), held(), attempts } — імітація «чужого» блокування
     clock                     — { now(), set(v), advance(ms), real() }
     ui                        — { enable(b), available(), alerts, menus, toasts }
     logs                      — записи console.* та Logger.log

   СЕМАНТИКА (як у справжньому Apps Script)
     • діапазони 1-базні; getRange з numRows/numColumns < 1 або за межами аркуша (getMaxRows/
       getMaxColumns; нова таблиця — 1000×26) кидає помилку; getLastRow() порожнього аркуша = 0;
     • getValues повертає '' для порожніх клітинок; setValues кидає при невідповідності розмірів;
     • setValues / setValue перетворюють рядки, як при введенні користувачем: '=…' (а також '+…'/'-…',
       що не є числом) — формула (записується в журнал formulas; getValues повертає '#ERROR!');
       провідний апостроф — буквальний текст (апостроф не зберігається); "007", "12.5", "5,5", "-3",
       "1e3", "12%" — числа; "25.09.2026[ 08:00]", "2026-09-25[ 08:00]" — дати (у поясі таблиці);
       "12:30" — час (дата 30.12.1899); TRUE/FALSE — логічні; Date і boolean зберігаються як є;
     • перевірка «прапорець» (requireCheckbox) робить порожні клітинки діапазону значенням false
       (тому вони враховуються в getLastRow — як у Sheets);
     • невідомий часовий пояс в Utilities.formatDate/parseDate мовчки стає GMT (як у Java);
     • виклик неіснуючого методу будь-якого обʼєкта mock кидає «… is not implemented in mock» —
       так тести ловлять використання API, якого немає в Apps Script.
   ===================================================================== */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

const RealDate = Date;
const HERE = dirname(fileURLToPath(import.meta.url));

/* файли проєкту Apps Script: Core.gs = assets/core.js, Server.gs */
export const GAS_FILES = [
  { path: join(HERE, '..', 'assets', 'core.js'), name: 'Core.gs' },
  { path: join(HERE, '..', 'apps-script', 'Server.gs'), name: 'Server.gs' }
];

/* ------------------------------ дрібниці ------------------------------ */

const isDateObj = (v) => Object.prototype.toString.call(v) === '[object Date]';
const pad = (n, w) => { let s = String(Math.abs(n)); while (s.length < w) s = '0' + s; return (n < 0 ? '-' : '') + s; };
const PASS = new Set(['then', 'toJSON', 'constructor', 'toString', 'valueOf', 'inspect', 'nodeType',
  'asymmetricMatch', '$$typeof', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__proto__']);

function notImpl(what) {
  return new Error(what + ' is not implemented in mock (tools/gas-mock.mjs) — перевірте, чи існує цей метод у справжньому Apps Script');
}
/* обʼєкт, що кидає помилку при зверненні до невідомої властивості */
function strict(name, obj) {
  return new Proxy(obj, {
    get(t, p, r) {
      if (typeof p === 'symbol' || p in t || PASS.has(p)) return Reflect.get(t, p, r);
      throw notImpl(name + '.' + String(p));
    }
  });
}
function sigError(method) {
  return new Error('The parameters don\'t match the method signature for ' + method + '.');
}

/* ------------------------------ часові пояси ------------------------------ */

const tzOk = new Map();
function tzValid(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  if (!tzOk.has(tz)) {
    let ok = true;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch (e) { ok = false; }
    tzOk.set(tz, ok);
  }
  return tzOk.get(tz);
}
const fmtCache = new Map();
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function partsIn(ms, tz) {
  const zone = tzValid(tz) ? tz : 'UTC';          // як Java: невідомий пояс → GMT
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    fmtCache.set(zone, f);
  }
  const o = {};
  for (const p of f.formatToParts(new RealDate(ms))) o[p.type] = p.value;
  return { y: +o.year, M: +o.month, d: +o.day, H: (+o.hour) % 24, m: +o.minute, s: +o.second,
    S: ((ms % 1000) + 1000) % 1000, wd: WEEKDAYS[o.weekday] };
}
function offsetOf(ms, tz) {
  const p = partsIn(ms, tz);
  return RealDate.UTC(p.y, p.M - 1, p.d, p.H, p.m, p.s) - (ms - (((ms % 1000) + 1000) % 1000));
}
/* локальний час поясу → мс UTC */
function zonedToMs(y, M, d, H, m, s, S, tz) {
  const guess = RealDate.UTC(y, M - 1, d, H || 0, m || 0, s || 0, S || 0);
  const off = offsetOf(guess, tz);
  let t = guess - off;
  const off2 = offsetOf(t, tz);
  if (off2 !== off) t = guess - off2;
  return t;
}

/* шаблони java.text.SimpleDateFormat (підмножина) */
function tokenize(pattern) {
  const out = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '\'') {
      if (pattern[i + 1] === '\'') { out.push({ lit: '\'' }); i += 2; continue; }
      let j = i + 1, s = '';
      while (j < pattern.length) {
        if (pattern[j] === '\'') { if (pattern[j + 1] === '\'') { s += '\''; j += 2; continue; } break; }
        s += pattern[j++];
      }
      out.push({ lit: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (pattern[j] === ch) j++;
      out.push({ ch, n: j - i });
      i = j;
      continue;
    }
    out.push({ lit: ch });
    i++;
  }
  return out;
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function offText(offMin, n, letter) {
  if (letter === 'X' && offMin === 0) return 'Z';
  const sg = offMin < 0 ? '-' : '+', a = Math.abs(offMin), hh = pad(Math.floor(a / 60), 2), mm = pad(a % 60, 2);
  if (letter === 'Z') return sg + hh + mm;
  return n === 1 ? sg + hh : n === 2 ? sg + hh + mm : sg + hh + ':' + mm;
}
function formatDateImpl(date, tz, pattern) {
  const ms = date.getTime(), p = partsIn(ms, tz), off = Math.round(offsetOf(ms, tz) / 60000);
  return tokenize(pattern).map((t) => {
    if (t.lit !== undefined) return t.lit;
    const n = t.n;
    switch (t.ch) {
      case 'y': return n === 2 ? pad(p.y % 100, 2) : pad(p.y, n);
      case 'M': return n >= 4 ? MONTHS[p.M - 1] : n === 3 ? MONTHS[p.M - 1].slice(0, 3) : pad(p.M, n);
      case 'd': return pad(p.d, n);
      case 'H': return pad(p.H, n);
      case 'h': return pad(((p.H + 11) % 12) + 1, n);
      case 'a': return p.H < 12 ? 'AM' : 'PM';
      case 'm': return pad(p.m, n);
      case 's': return pad(p.s, n);
      case 'S': return pad(p.S, n);
      case 'E': return n >= 4 ? DAYS[p.wd] : DAYS[p.wd].slice(0, 3);
      case 'u': return String(p.wd === 0 ? 7 : p.wd);
      case 'Z': case 'X': return offText(off, n, t.ch);
      default: throw notImpl('Utilities.formatDate: літера шаблону \'' + t.ch + '\'');
    }
  }).join('');
}
function parseDateImpl(str, tz, pattern) {
  const groups = [];
  let re = '^';
  for (const t of tokenize(pattern)) {
    if (t.lit !== undefined) { re += t.lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    switch (t.ch) {
      case 'y': re += t.n === 2 ? '(\\d{2})' : '(\\d{4})'; groups.push('y' + (t.n === 2 ? '2' : '')); break;
      case 'M': case 'd': case 'H': case 'm': case 's': re += '(\\d{1,2})'; groups.push(t.ch); break;
      case 'S': re += '(\\d{1,3})'; groups.push('S'); break;
      default: throw notImpl('Utilities.parseDate: літера шаблону \'' + t.ch + '\'');
    }
  }
  const m = new RegExp(re).exec(String(str));
  if (!m) throw new Error('Unparseable date: "' + str + '"');
  const v = { y: 1970, M: 1, d: 1, H: 0, m: 0, s: 0, S: 0 };
  groups.forEach((g, i) => {
    const n = +m[i + 1];
    if (g === 'y2') v.y = 2000 + n; else v[g] = n;
  });
  return zonedToMs(v.y, v.M, v.d, v.H, v.m, v.s, v.S, tz);
}

/* ===================================================================== */

export function createGasMock(options = {}) {
  const opt = {
    tz: 'Europe/Kyiv', spreadsheetTz: null, now: null, mailQuota: 100, ui: false, sheets: ['Аркуш1'],
    spreadsheetId: '1MOCKspreadsheetID', spreadsheetName: 'Облік ліній (mock)', userEmail: 'owner@example.com',
    webAppUrl: 'https://script.google.com/macros/s/MOCK_DEPLOYMENT/exec', echo: false, ...options
  };
  const scriptTz = opt.tz;

  /* ---------- годинник ---------- */
  let clockFn = null, fixedMs = null;
  const toMsAny = (v) => (isDateObj(v) ? v.getTime() : typeof v === 'number' ? v : RealDate.parse(v));
  function setClock(v) {
    clockFn = null; fixedMs = null;
    if (v === null || v === undefined) return;
    if (typeof v === 'function') { clockFn = v; return; }
    const ms = toMsAny(v);
    if (!isFinite(ms)) throw new Error('gas-mock: невірний час ' + v);
    fixedMs = ms;
  }
  function clockNow() {
    if (clockFn) return toMsAny(clockFn());
    return fixedMs !== null ? fixedMs : RealDate.now();
  }
  setClock(opt.now);

  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(clockNow()); else super(...a); }
    static now() { return clockNow(); }
  }
  const mkDate = (ms) => new FakeDate(ms);

  /* ---------- лічильники й журнали ---------- */
  const calls = Object.create(null);
  const count = (k, n = 1) => { calls[k] = (calls[k] || 0) + n; };
  const logs = [];
  const formulaLog = [];

  /* ---------- таблиця ---------- */
  let ssTz = opt.spreadsheetTz || scriptTz;
  const book = { id: opt.spreadsheetId, name: opt.spreadsheetName, sheets: [], nextId: 1, active: null, toasts: [] };
  const modelOf = new WeakMap();                 // proxy аркуша → модель

  /* введення значення «як користувач» → { v, f } (f — формула) */
  function enter(v) {
    if (v === null || v === undefined) return { v: '' };
    if (typeof v === 'boolean') return { v };
    if (typeof v === 'number') {
      if (!isFinite(v)) throw new Error('Невірне числове значення: ' + v);
      return { v };
    }
    if (isDateObj(v)) {
      if (isNaN(v.getTime())) throw new Error('Invalid Date cannot be written to a cell');
      return { v: mkDate(v.getTime()) };
    }
    if (typeof v !== 'string') throw sigError('SpreadsheetApp.Range.setValues (значення типу ' + typeof v + ')');
    if (v.length > 50000) throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.');
    if (v.charAt(0) === '\'') return { v: v.slice(1) };
    if (v === '') return { v: '' };
    if (v.charAt(0) === '=') return { f: v };
    const t = v.trim();
    if (/^(true|false)$/i.test(t)) return { v: t.toLowerCase() === 'true' };
    if (/^[+-]?(\d+([.,]\d+)?|[.,]\d+)(e[+-]?\d+)?$/i.test(t)) return { v: Number(t.replace(',', '.')) };
    let m = /^([+-]?\d+([.,]\d+)?)\s*%$/.exec(t);
    if (m) return { v: Number(m[1].replace(',', '.')) / 100 };
    m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
    if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) {
      return { v: mkDate(zonedToMs(+m[3], +m[2], +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), 0, ssTz)) };
    }
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
    if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) {
      return { v: mkDate(zonedToMs(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), 0, ssTz)) };
    }
    m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
    if (m && +m[1] < 24) return { v: mkDate(zonedToMs(1899, 12, 30, +m[1], +m[2], +(m[3] || 0), 0, ssTz)) };
    if (/^[+-]/.test(v)) return { f: '=' + v };      // «+…» / «-…» Sheets сприймає як формулу
    return { v };
  }

  const CELL_KEY = (r, c) => r * 32768 + c;

  class SheetModel {
    constructor(name) {
      this.name = name; this.id = book.nextId++;
      this.rows = []; this.maxRows = 1000; this.maxCols = 26; this.frozenRows = 0;
      this.formulas = new Map(); this.notes = new Map();
      this.formats = []; this.validations = []; this.styles = []; this.widths = new Map();
      this.tabColor = null; this.colDirty = true; this.lastColCache = 0; this.proxy = null;
    }
    get(r, c) { const row = this.rows[r - 1]; if (!row) return ''; const v = row[c - 1]; return v === undefined ? '' : v; }
    put(r, c, v) {
      let row = this.rows[r - 1];
      if (!row) { if (v === '') return; row = this.rows[r - 1] = []; }
      row[c - 1] = v;
      this.colDirty = true;
    }
    lastRow() {
      let n = this.rows.length;
      while (n > 0 && rowEmpty(this.rows[n - 1])) n--;
      if (n < this.rows.length) this.rows.length = n;
      return n;
    }
    lastCol() {
      if (!this.colDirty) return this.lastColCache;
      let max = 0;
      for (const row of this.rows) {
        if (!row) continue;
        for (let j = row.length - 1; j >= max; j--) if (row[j] !== undefined && row[j] !== '') { max = j + 1; break; }
      }
      this.colDirty = false;
      this.lastColCache = max;
      return max;
    }
    write(r, c, x) {
      const key = CELL_KEY(r, c);
      if (x.f !== undefined) {
        this.formulas.set(key, x.f);
        formulaLog.push({ sheet: this.name, row: r, col: c, formula: x.f });
        this.put(r, c, '#ERROR!');
      } else {
        this.formulas.delete(key);
        this.put(r, c, x.v);
      }
    }
    lastOp(list, r, c) {
      for (let i = list.length - 1; i >= 0; i--) {
        const o = list[i];
        if (r >= o.r && r < o.r + o.nr && c >= o.c && c < o.c + o.nc) return o;
      }
      return null;
    }
    checkboxAt(r, c) { const o = this.lastOp(this.validations, r, c); return !!(o && o.rule && o.rule.type === 'CHECKBOX'); }
    shiftRows(after, n) {               // вставка n рядків після after
      if (this.rows.length > after) this.rows.splice(after, 0, ...new Array(n));
      this.remapKeys((r, c) => (r > after ? [r + n, c] : [r, c]));
    }
    shiftCols(after, n) {
      for (const row of this.rows) if (row && row.length > after) row.splice(after, 0, ...new Array(n).fill(''));
      this.remapKeys((r, c) => (c > after ? [r, c + n] : [r, c]));
      this.colDirty = true;
    }
    remapKeys(fn) {
      for (const name of ['formulas', 'notes']) {
        const old = this[name], next = new Map();
        for (const [k, v] of old) { const r = Math.floor(k / 32768), c = k % 32768, [r2, c2] = fn(r, c); if (r2 > 0 && c2 > 0) next.set(CELL_KEY(r2, c2), v); }
        this[name] = next;
      }
    }
  }
  function rowEmpty(row) {
    if (!row) return true;
    for (let j = 0; j < row.length; j++) if (row[j] !== undefined && row[j] !== '') return false;
    return true;
  }
  function a1(r, c, nr, nc) {
    const col = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
    const a = col(c) + r;
    return nr === 1 && nc === 1 ? a : a + ':' + col(c + nc - 1) + (r + nr - 1);
  }

  /* ---------- перевірка даних ---------- */
  const builtRules = new WeakSet();
  const ruleData = new WeakMap();
  const Criteria = { CHECKBOX: 'CHECKBOX', VALUE_IN_LIST: 'VALUE_IN_LIST', VALUE_IN_RANGE: 'VALUE_IN_RANGE',
    NUMBER_BETWEEN: 'NUMBER_BETWEEN', DATE_IS_VALID_DATE: 'DATE_IS_VALID_DATE', TEXT_IS_VALID_EMAIL: 'TEXT_IS_VALID_EMAIL' };
  function newDataValidation() {
    const st = { type: null, values: [], dropdown: true, allowInvalid: true, help: '' };
    const B = strict('DataValidationBuilder', {
      requireCheckbox(checked, unchecked) {
        st.type = 'CHECKBOX';
        st.values = checked === undefined ? [] : [checked].concat(unchecked === undefined ? [] : [unchecked]);
        return B;
      },
      requireValueInList(values, showDropdown) {
        if (!Array.isArray(values) || !values.every((x) => typeof x === 'string')) throw sigError('SpreadsheetApp.DataValidationBuilder.requireValueInList');
        if (values.length > 500) throw new Error('Too many values in the list (mock limit 500)');
        st.type = 'VALUE_IN_LIST'; st.values = Array.from(values); st.dropdown = showDropdown === undefined ? true : !!showDropdown;
        return B;
      },
      setAllowInvalid(b) { st.allowInvalid = !!b; return B; },
      setHelpText(t) { st.help = String(t); return B; },
      build() {
        if (!st.type) throw new Error('Data validation rule has no criteria');
        const rule = { type: st.type, values: st.values.slice(), dropdown: st.dropdown, allowInvalid: st.allowInvalid, help: st.help };
        const R = strict('DataValidation', {
          getCriteriaType: () => rule.type,
          getCriteriaValues: () => (rule.type === 'VALUE_IN_LIST' ? [rule.values.slice(), rule.dropdown] : rule.values.slice()),
          getAllowInvalid: () => rule.allowInvalid,
          getHelpText: () => rule.help
        });
        builtRules.add(R);
        ruleData.set(R, rule);
        return R;
      }
    });
    return B;
  }

  /* ---------- Range ---------- */
  function makeRange(sh, r, c, nr, nc) {
    const cells = (fn) => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) fn(r + i, c + j, i, j); };
    let P = null;
    const R = {
      getRow: () => r, getColumn: () => c, getNumRows: () => nr, getNumColumns: () => nc,
      getLastRow: () => r + nr - 1, getLastColumn: () => c + nc - 1,
      getA1Notation: () => a1(r, c, nr, nc),
      getSheet: () => sheetProxy(sh),
      getValues() {
        count('getValues'); count('getValues:' + sh.name); count('cellsRead', nr * nc);
        const out = new Array(nr);
        for (let i = 0; i < nr; i++) {
          const row = sh.rows[r - 1 + i], a = new Array(nc);
          for (let j = 0; j < nc; j++) {
            const v = row ? row[c - 1 + j] : undefined;
            a[j] = v === undefined ? '' : isDateObj(v) ? mkDate(v.getTime()) : v;
          }
          out[i] = a;
        }
        return out;
      },
      getValue() { count('getValue'); const v = sh.get(r, c); return isDateObj(v) ? mkDate(v.getTime()) : v; },
      setValues(values) {
        count('setValues'); count('setValues:' + sh.name);
        if (!Array.isArray(values)) throw sigError('SpreadsheetApp.Range.setValues');
        if (values.length !== nr) {
          throw new Error('The number of rows in the data does not match the number of rows in the range. The data has ' +
            values.length + ' but the range has ' + nr + '.');
        }
        const conv = new Array(nr);
        for (let i = 0; i < nr; i++) {
          const row = values[i];
          if (!Array.isArray(row)) throw sigError('SpreadsheetApp.Range.setValues');
          if (row.length !== nc) {
            throw new Error('The number of columns in the data does not match the number of columns in the range. The data has ' +
              row.length + ' but the range has ' + nc + '.');
          }
          conv[i] = row.map(enter);                  // спершу перетворення: помилка не записує частину
        }
        count('cellsWritten', nr * nc);
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sh.write(r + i, c + j, conv[i][j]);
        return P;
      },
      setValue(v) {
        count('setValue');
        const x = enter(v);
        cells((rr, cc) => sh.write(rr, cc, x));
        return P;
      },
      getFormulas() {
        count('getFormulas');
        const out = [];
        for (let i = 0; i < nr; i++) {
          const a = new Array(nc);
          for (let j = 0; j < nc; j++) a[j] = sh.formulas.get(CELL_KEY(r + i, c + j)) || '';
          out.push(a);
        }
        return out;
      },
      getFormula() { return sh.formulas.get(CELL_KEY(r, c)) || ''; },
      clearContent() {
        count('clearContent');
        cells((rr, cc) => { sh.formulas.delete(CELL_KEY(rr, cc)); sh.put(rr, cc, ''); });
        return P;
      },
      setNumberFormat(f) {
        if (typeof f !== 'string') throw sigError('SpreadsheetApp.Range.setNumberFormat');
        count('format'); sh.formats.push({ r, c, nr, nc, f });
        return P;
      },
      setDataValidation(rule) {
        if (rule !== null && !builtRules.has(rule)) throw sigError('SpreadsheetApp.Range.setDataValidation');
        const data = rule ? ruleData.get(rule) : null;
        count('validation'); sh.validations.push({ r, c, nr, nc, rule: data });
        if (data && data.type === 'CHECKBOX') cells((rr, cc) => { if (sh.get(rr, cc) === '') sh.put(rr, cc, false); });
        return P;
      },
      clearDataValidations() { count('validation'); sh.validations.push({ r, c, nr, nc, rule: null }); return P; },
      setFontWeight(w) { count('style'); sh.styles.push({ r, c, nr, nc, prop: 'fontWeight', value: w }); return P; },
      setBackground(color) { count('style'); sh.styles.push({ r, c, nr, nc, prop: 'background', value: color }); return P; },
      setFontColor(color) { count('style'); sh.styles.push({ r, c, nr, nc, prop: 'fontColor', value: color }); return P; },
      setWrap(b) { count('style'); sh.styles.push({ r, c, nr, nc, prop: 'wrap', value: !!b }); return P; },
      setNote(note) { count('style'); cells((rr, cc) => sh.notes.set(CELL_KEY(rr, cc), note === null ? '' : String(note))); return P; },
      getNote() { return sh.notes.get(CELL_KEY(r, c)) || ''; }
    };
    P = strict('Range', R);
    return P;
  }

  /* ---------- Sheet ---------- */
  function checkInt(v, method) { if (typeof v !== 'number' || !Number.isInteger(v)) throw sigError(method); }
  function sheetProxy(sh) {
    if (sh.proxy) return sh.proxy;
    const S = {
      getName: () => sh.name,
      setName(n) {
        if (book.sheets.some((x) => x !== sh && x.name === n)) throw new Error('A sheet with the name "' + n + '" already exists. Please enter another name.');
        sh.name = String(n); return sh.proxy;
      },
      getSheetId: () => sh.id,
      getIndex: () => book.sheets.indexOf(sh) + 1,
      getParent: () => ssProxy,
      getLastRow() { count('getLastRow'); return sh.lastRow(); },
      getLastColumn() { count('getLastColumn'); return sh.lastCol(); },
      getMaxRows: () => sh.maxRows,
      getMaxColumns: () => sh.maxCols,
      getRange(row, column, numRows, numColumns) {
        count('getRange');
        if (typeof row === 'string') throw notImpl('Sheet.getRange(a1Notation)');
        if (arguments.length < 2) throw sigError('SpreadsheetApp.Sheet.getRange');
        const nr = numRows === undefined ? 1 : numRows, nc = numColumns === undefined ? 1 : numColumns;
        [row, column, nr, nc].forEach((v) => checkInt(v, 'SpreadsheetApp.Sheet.getRange'));
        if (row < 1) throw new Error('The starting row of the range is too small.');
        if (column < 1) throw new Error('The starting column of the range is too small.');
        if (nr < 1) throw new Error('The number of rows in the range must be at least 1.');
        if (nc < 1) throw new Error('The number of columns in the range must be at least 1.');
        if (row + nr - 1 > sh.maxRows || column + nc - 1 > sh.maxCols) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
        return makeRange(sh, row, column, nr, nc);
      },
      getDataRange() { return makeRange(sh, 1, 1, Math.max(1, sh.lastRow()), Math.max(1, sh.lastCol())); },
      insertRowsAfter(after, howMany) {
        checkInt(after, 'SpreadsheetApp.Sheet.insertRowsAfter'); checkInt(howMany, 'SpreadsheetApp.Sheet.insertRowsAfter');
        if (after < 1 || after > sh.maxRows) throw new Error('Those rows are out of bounds.');
        if (howMany < 1) throw new Error('The number of rows to insert must be at least 1.');
        count('insertRows'); sh.shiftRows(after, howMany); sh.maxRows += howMany;
        return sh.proxy;
      },
      insertColumnsAfter(after, howMany) {
        checkInt(after, 'SpreadsheetApp.Sheet.insertColumnsAfter'); checkInt(howMany, 'SpreadsheetApp.Sheet.insertColumnsAfter');
        if (after < 1 || after > sh.maxCols) throw new Error('Those columns are out of bounds.');
        if (howMany < 1) throw new Error('The number of columns to insert must be at least 1.');
        count('insertColumns'); sh.shiftCols(after, howMany); sh.maxCols += howMany;
        return sh.proxy;
      },
      deleteRows(pos, howMany) {
        checkInt(pos, 'SpreadsheetApp.Sheet.deleteRows'); checkInt(howMany, 'SpreadsheetApp.Sheet.deleteRows');
        if (pos < 1 || howMany < 1 || pos + howMany - 1 > sh.maxRows) throw new Error('Those rows are out of bounds.');
        if (howMany >= sh.maxRows) throw new Error('You can\'t delete all the rows on the sheet.');
        count('deleteRows'); sh.rows.splice(pos - 1, howMany); sh.maxRows -= howMany; sh.colDirty = true;
        return sh.proxy;
      },
      getFrozenRows: () => sh.frozenRows,
      setFrozenRows(n) { checkInt(n, 'SpreadsheetApp.Sheet.setFrozenRows'); sh.frozenRows = n; return sh.proxy; },
      setTabColor(color) { sh.tabColor = color; return sh.proxy; },
      setColumnWidth(col, w) { checkInt(col, 'SpreadsheetApp.Sheet.setColumnWidth'); sh.widths.set(col, w); return sh.proxy; },
      activate() { book.active = sh; return sh.proxy; }
    };
    sh.proxy = strict('Sheet', S);
    modelOf.set(sh.proxy, sh);
    return sh.proxy;
  }

  /* ---------- Spreadsheet ---------- */
  function addSheet(name, index) {
    if (book.sheets.some((x) => x.name === name)) throw new Error('A sheet with the name "' + name + '" already exists. Please enter another name.');
    const sh = new SheetModel(name);
    const at = index === undefined ? book.sheets.length : Math.max(0, Math.min(book.sheets.length, index));
    book.sheets.splice(at, 0, sh);
    book.active = sh;
    return sh;
  }
  opt.sheets.forEach((n) => addSheet(n));
  const ssObj = {
    getId: () => book.id,
    getName: () => book.name,
    getUrl: () => 'https://docs.google.com/spreadsheets/d/' + book.id + '/edit',
    getSheets: () => book.sheets.map(sheetProxy),
    getSheetByName(name) { count('getSheetByName'); const sh = book.sheets.find((x) => x.name === name); return sh ? sheetProxy(sh) : null; },
    insertSheet(a, b, c) {
      if (c !== undefined) throw notImpl('Spreadsheet.insertSheet(name, index, options)');
      let name, index;
      if (typeof a === 'string') { name = a; index = b; } else if (typeof a === 'number') index = a;
      if (index !== undefined) checkInt(index, 'SpreadsheetApp.Spreadsheet.insertSheet');
      if (name === undefined) { let n = book.sheets.length + 1; while (book.sheets.some((x) => x.name === 'Аркуш' + n)) n++; name = 'Аркуш' + n; }
      count('insertSheet');
      return sheetProxy(addSheet(name, index));
    },
    deleteSheet(sheet) {
      const sh = modelOf.get(sheet);
      if (!sh) throw sigError('SpreadsheetApp.Spreadsheet.deleteSheet');
      if (book.sheets.length === 1) throw new Error('You can\'t remove all the sheets in a document.');
      book.sheets.splice(book.sheets.indexOf(sh), 1);
      if (book.active === sh) book.active = book.sheets[0];
    },
    getActiveSheet: () => sheetProxy(book.active || book.sheets[0]),
    setActiveSheet(sheet) { const sh = modelOf.get(sheet); if (!sh) throw sigError('SpreadsheetApp.Spreadsheet.setActiveSheet'); book.active = sh; return sheet; },
    getSpreadsheetTimeZone: () => ssTz,
    setSpreadsheetTimeZone(tz) { if (!tzValid(tz)) throw new Error('Invalid argument: timeZone'); ssTz = tz; },
    toast(msg, title, timeout) { book.toasts.push({ msg: String(msg), title: title === undefined ? '' : String(title), timeout }); }
  };
  const ssProxy = strict('Spreadsheet', ssObj);

  /* ---------- UI ---------- */
  const uiState = { available: !!opt.ui, alerts: [], menus: [] };
  const Button = { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO', CLOSE: 'CLOSE' };
  const ButtonSet = { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO', YES_NO_CANCEL: 'YES_NO_CANCEL' };
  const uiProxy = strict('Ui', {
    Button, ButtonSet,
    alert(a, b, c) {
      let rec;
      if (arguments.length === 1) rec = { title: '', prompt: String(a), buttons: 'OK' };
      else if (arguments.length === 2) rec = { title: '', prompt: String(a), buttons: b };
      else rec = { title: String(a), prompt: String(b), buttons: c };
      uiState.alerts.push(rec);
      return Button.OK;
    },
    createMenu(caption) {
      const menu = { caption: String(caption), items: [] };
      const M = strict('Menu', {
        addItem(cap, fn) {
          if (typeof fn !== 'string') throw sigError('Ui.Menu.addItem');
          menu.items.push({ caption: String(cap), fn });
          return M;
        },
        addSeparator() { menu.items.push({ separator: true }); return M; },
        addToUi() { uiState.menus.push(menu); }
      });
      return M;
    }
  });

  /* ---------- SpreadsheetApp ---------- */
  const SpreadsheetApp = strict('SpreadsheetApp', {
    getActiveSpreadsheet: () => ssProxy,
    getActive: () => ssProxy,
    openById(id) {
      if (id !== book.id) throw new Error('Unexpected error while getting the method or property openById on object SpreadsheetApp.');
      return ssProxy;
    },
    flush() { count('flush'); },
    getUi() {
      if (!uiState.available) throw new Error('Cannot call SpreadsheetApp.getUi() from this context.');
      return uiProxy;
    },
    newDataValidation,
    DataValidationCriteria: Criteria
  });

  /* ---------- LockService ---------- */
  const lockState = { other: false, held: 0, attempts: [] };
  function makeLock() {
    let mine = false;
    const L = strict('Lock', {
      tryLock(ms) {
        checkInt(ms, 'LockService.Lock.tryLock');
        lockState.attempts.push({ method: 'tryLock', timeoutMs: ms, granted: !lockState.other });
        if (mine) return true;
        if (lockState.other) return false;
        mine = true; lockState.held++;
        return true;
      },
      waitLock(ms) {
        if (!L.tryLock(ms)) throw new Error('Lock timeout: another process was holding the lock for too long.');
      },
      releaseLock() { if (mine) { mine = false; lockState.held--; } },
      hasLock: () => mine
    });
    return L;
  }
  const LockService = strict('LockService', {
    getScriptLock: makeLock, getDocumentLock: makeLock, getUserLock: makeLock
  });

  /* ---------- CacheService ---------- */
  const cacheMap = new Map();
  function makeCache() {
    const alive = (k) => { const e = cacheMap.get(k); if (!e) return null; if (e.exp <= clockNow()) { cacheMap.delete(k); return null; } return e; };
    const checkKey = (k) => { if (typeof k !== 'string' || !k || k.length > 250) throw new Error('Invalid cache key: ' + k); };
    const C = strict('Cache', {
      get(k) { checkKey(k); const e = alive(k); return e ? e.v : null; },
      getAll(keys) { const o = {}; keys.forEach((k) => { const e = alive(k); if (e) o[k] = e.v; }); return o; },
      put(k, v, sec) {
        checkKey(k);
        const s = String(v);
        if (s.length > 100 * 1024) throw new Error('Argument too large: value');
        const t = sec === undefined ? 600 : Math.min(21600, Math.max(1, Number(sec)));
        cacheMap.set(k, { v: s, exp: clockNow() + t * 1000 });
      },
      putAll(o, sec) { Object.keys(o).forEach((k) => C.put(k, o[k], sec)); },
      remove(k) { cacheMap.delete(k); },
      removeAll(keys) { keys.forEach((k) => cacheMap.delete(k)); }
    });
    return C;
  }
  const scriptCache = makeCache();
  const CacheService = strict('CacheService', {
    getScriptCache: () => scriptCache, getUserCache: () => scriptCache, getDocumentCache: () => scriptCache
  });

  /* ---------- PropertiesService ---------- */
  function makeProps() {
    const m = new Map();
    const P = strict('Properties', {
      getProperty: (k) => (m.has(k) ? m.get(k) : null),
      setProperty(k, v) { m.set(String(k), String(v)); return P; },
      setProperties(o, deleteAllOthers) {
        if (deleteAllOthers) m.clear();
        Object.keys(o).forEach((k) => m.set(k, String(o[k])));
        return P;
      },
      getProperties() { const o = {}; m.forEach((v, k) => { o[k] = v; }); return o; },
      getKeys: () => Array.from(m.keys()),
      deleteProperty(k) { m.delete(k); return P; },
      deleteAllProperties() { m.clear(); return P; }
    });
    return P;
  }
  const scriptProps = makeProps(), userProps = makeProps(), docProps = makeProps();
  const PropertiesService = strict('PropertiesService', {
    getScriptProperties: () => scriptProps, getUserProperties: () => userProps, getDocumentProperties: () => docProps
  });

  /* ---------- MailApp ---------- */
  const mails = [];
  let quota = opt.mailQuota, failNext = null;
  const MailApp = strict('MailApp', {
    sendEmail(a, b, c, d) {
      let m;
      if (a && typeof a === 'object') m = { ...a };
      else {
        if (typeof a !== 'string' || typeof b !== 'string') throw sigError('MailApp.sendEmail');
        m = { to: a, subject: b, body: c, ...(d || {}) };
      }
      const rcpts = [m.to, m.cc, m.bcc].filter(Boolean).join(',').split(',').map((s) => s.trim()).filter(Boolean);
      if (!rcpts.length) throw new Error('Failed to send email: no recipient');
      rcpts.forEach((x) => { if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(x)) throw new Error('Invalid email: ' + x); });
      if (typeof m.subject !== 'string') throw sigError('MailApp.sendEmail');
      if (m.body === undefined && m.htmlBody === undefined) throw sigError('MailApp.sendEmail');
      if (failNext) { const e = failNext; failNext = null; throw new Error(e); }
      if (quota < rcpts.length) throw new Error('Service invoked too many times for one day: email.');
      quota -= rcpts.length;
      count('sendEmail');
      mails.push({ ...m, recipients: rcpts, ts: mkDate(clockNow()) });
    },
    getRemainingDailyQuota: () => quota
  });

  /* ---------- ScriptApp ---------- */
  const triggers = [];
  let trigSeq = 0;
  const EventType = { CLOCK: 'CLOCK', ON_OPEN: 'ON_OPEN', ON_EDIT: 'ON_EDIT', ON_FORM_SUBMIT: 'ON_FORM_SUBMIT', ON_CHANGE: 'ON_CHANGE' };
  function triggerProxy(t) {
    if (!t.proxy) {
      t.proxy = strict('Trigger', {
        getHandlerFunction: () => t.handler,
        getUniqueId: () => t.id,
        getEventType: () => EventType.CLOCK,
        getTriggerSource: () => 'CLOCK',
        getTriggerSourceId: () => null
      });
    }
    return t.proxy;
  }
  function clockBuilder(handler) {
    const cfg = { handler };
    const B = strict('ClockTriggerBuilder', {
      atHour(h) { checkInt(h, 'ScriptApp.ClockTriggerBuilder.atHour'); if (h < 0 || h > 23) throw new Error('Invalid argument: hour'); cfg.atHour = h; return B; },
      nearMinute(m) { checkInt(m, 'ScriptApp.ClockTriggerBuilder.nearMinute'); cfg.nearMinute = m; return B; },
      everyDays(n) { checkInt(n, 'ScriptApp.ClockTriggerBuilder.everyDays'); if (n < 1) throw new Error('Invalid argument: days'); cfg.everyDays = n; return B; },
      everyWeeks(n) { checkInt(n, 'ScriptApp.ClockTriggerBuilder.everyWeeks'); cfg.everyWeeks = n; return B; },
      everyHours(n) {
        checkInt(n, 'ScriptApp.ClockTriggerBuilder.everyHours');
        if ([1, 2, 4, 6, 8, 12].indexOf(n) < 0) throw new Error('The frequency must be one of 1, 2, 4, 6, 8 or 12.');
        cfg.everyHours = n; return B;
      },
      everyMinutes(n) {
        checkInt(n, 'ScriptApp.ClockTriggerBuilder.everyMinutes');
        if ([1, 5, 10, 15, 30].indexOf(n) < 0) throw new Error('The frequency must be one of 1, 5, 10, 15 or 30.');
        cfg.everyMinutes = n; return B;
      },
      inTimezone(tz) { if (!tzValid(tz)) throw new Error('Invalid argument: timezone'); cfg.tz = tz; return B; },
      after(ms) { checkInt(ms, 'ScriptApp.ClockTriggerBuilder.after'); cfg.after = ms; return B; },
      at(date) { if (!isDateObj(date)) throw sigError('ScriptApp.ClockTriggerBuilder.at'); cfg.at = mkDate(date.getTime()); return B; },
      create() {
        const rec = ['everyDays', 'everyWeeks', 'everyHours', 'everyMinutes', 'after', 'at'].filter((k) => cfg[k] !== undefined);
        if (rec.length !== 1) throw new Error('Clock trigger must have exactly one schedule (everyDays/everyHours/…); got: ' + rec.join(', '));
        if (cfg.atHour !== undefined && !(cfg.everyDays || cfg.everyWeeks)) throw new Error('atHour() can only be used with everyDays() or everyWeeks().');
        if (triggers.length >= 20) throw new Error('This script has too many triggers. Triggers must be deleted from the script before more can be added.');
        const t = { id: 'trig-' + (++trigSeq), type: 'CLOCK', tz: cfg.tz || scriptTz, ...cfg };
        triggers.push(t);
        return triggerProxy(t);
      }
    });
    return B;
  }
  const ScriptApp = strict('ScriptApp', {
    newTrigger(fn) {
      if (typeof fn !== 'string' || !fn) throw sigError('ScriptApp.newTrigger');
      return strict('TriggerBuilder', { timeBased: () => clockBuilder(fn) });
    },
    getProjectTriggers: () => triggers.map(triggerProxy),
    deleteTrigger(t) {
      const i = triggers.findIndex((x) => x.proxy === t);
      if (i < 0) throw new Error('Trigger not found');
      triggers.splice(i, 1);
    },
    getService: () => strict('Service', { getUrl: () => opt.webAppUrl, isEnabled: () => true }),
    getScriptId: () => 'mock-script-id',
    EventType,
    TriggerSource: { CLOCK: 'CLOCK', SPREADSHEETS: 'SPREADSHEETS', DOCUMENTS: 'DOCUMENTS', FORMS: 'FORMS', CALENDAR: 'CALENDAR' },
    AuthMode: { NONE: 'NONE', CUSTOM_FUNCTION: 'CUSTOM_FUNCTION', LIMITED: 'LIMITED', FULL: 'FULL' }
  });

  /* ---------- ContentService ---------- */
  const MimeType = { ATOM: 'application/atom+xml', CSV: 'text/csv', ICAL: 'text/calendar', JAVASCRIPT: 'application/javascript',
    JSON: 'application/json', RSS: 'application/rss+xml', TEXT: 'text/plain', VCARD: 'text/vcard', XML: 'text/xml' };
  const MIME_SET = new Set(Object.values(MimeType));
  const ContentService = strict('ContentService', {
    MimeType,
    createTextOutput(content) {
      let text = content === undefined ? '' : String(content), mime = MimeType.TEXT;
      const T = strict('TextOutput', {
        getContent: () => text,
        setContent(s) { text = String(s); return T; },
        append(s) { text += String(s); return T; },
        getMimeType: () => mime,
        setMimeType(m) { if (!MIME_SET.has(m)) throw sigError('ContentService.TextOutput.setMimeType'); mime = m; return T; },
        getFileName: () => null
      });
      return T;
    }
  });

  /* ---------- Utilities ---------- */
  const Utilities = strict('Utilities', {
    formatDate(date, tz, pattern) {
      if (!isDateObj(date) || typeof tz !== 'string' || typeof pattern !== 'string') throw sigError('Utilities.formatDate');
      if (isNaN(date.getTime())) throw new Error('Invalid argument: date');
      count('formatDate');
      return formatDateImpl(date, tz, pattern);
    },
    parseDate(str, tz, pattern) {
      if (typeof str !== 'string' || typeof tz !== 'string' || typeof pattern !== 'string') throw sigError('Utilities.parseDate');
      count('parseDate');
      return mkDate(parseDateImpl(str, tz, pattern));
    },
    getUuid: () => randomUUID(),
    sleep(ms) { checkInt(ms, 'Utilities.sleep'); if (fixedMs !== null) fixedMs += ms; }
  });

  /* ---------- Session, Logger, console ---------- */
  const user = strict('User', { getEmail: () => opt.userEmail });
  const Session = strict('Session', {
    getScriptTimeZone: () => scriptTz,
    getActiveUser: () => user,
    getEffectiveUser: () => user,
    getActiveUserLocale: () => 'uk'
  });
  const say = (level, args) => {
    logs.push({ level, text: args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ') });
    if (opt.echo) console[level === 'log' ? 'log' : level](...args);
  };
  const Logger = strict('Logger', {
    log(...args) { say('log', args); return Logger; },
    getLog: () => logs.map((l) => l.text).join('\n'),
    clear() { logs.length = 0; return Logger; }
  });
  const mockConsole = {
    log: (...a) => say('log', a), info: (...a) => say('info', a), warn: (...a) => say('warn', a),
    error: (...a) => say('error', a), debug: (...a) => say('debug', a)
  };

  const globals = {
    SpreadsheetApp, LockService, CacheService, PropertiesService, MailApp, ScriptApp, ContentService,
    Utilities, Session, Logger, console: mockConsole, Date: FakeDate
  };

  /* ---------- інспектор ---------- */
  function sheetInspector(name) {
    const sh = book.sheets.find((x) => x.name === name);
    if (!sh) return null;
    const cp = (v) => (isDateObj(v) ? mkDate(v.getTime()) : v);
    const grow = (r, c) => { if (r > sh.maxRows) sh.maxRows = r; if (c > sh.maxCols) sh.maxCols = c; };
    const I = {
      name,
      get lastRow() { return sh.lastRow(); },
      get lastColumn() { return sh.lastCol(); },
      get maxRows() { return sh.maxRows; },
      get maxColumns() { return sh.maxCols; },
      get frozenRows() { return sh.frozenRows; },
      get tabColor() { return sh.tabColor; },
      cell: (r, c) => cp(sh.get(r, c)),
      values() {
        const R = sh.lastRow(), C = sh.lastCol(), out = [];
        for (let r = 1; r <= R; r++) { const a = []; for (let c = 1; c <= C; c++) a.push(cp(sh.get(r, c))); out.push(a); }
        return out;
      },
      header() { const C = sh.lastCol(), a = []; for (let c = 1; c <= C; c++) a.push(sh.get(1, c)); return a; },
      records() {
        const h = I.header(), R = sh.lastRow(), out = [];
        for (let r = 2; r <= R; r++) {
          const o = {};
          h.forEach((t, j) => { if (t !== '') o[t] = cp(sh.get(r, j + 1)); });
          out.push(o);
        }
        return out;
      },
      col(title) { const j = I.header().indexOf(title); return j < 0 ? 0 : j + 1; },
      formulas() { const out = []; sh.formulas.forEach((f, k) => out.push({ row: Math.floor(k / 32768), col: k % 32768, formula: f })); return out; },
      formatAt(r, c) { const o = sh.lastOp(sh.formats, r, c); return o ? o.f : null; },
      validationAt(r, c) {
        const o = sh.lastOp(sh.validations, r, c);
        return o && o.rule ? { type: o.rule.type, values: o.rule.values.slice(), allowInvalid: o.rule.allowInvalid, dropdown: o.rule.dropdown } : null;
      },
      noteAt: (r, c) => sh.notes.get(CELL_KEY(r, c)) || '',
      styleAt(r, c, prop) {
        for (let i = sh.styles.length - 1; i >= 0; i--) {
          const o = sh.styles[i];
          if (o.prop === prop && r >= o.r && r < o.r + o.nr && c >= o.c && c < o.c + o.nc) return o.value;
        }
        return null;
      },
      /* «людські» правки: без лічильників викликів API */
      type(r, c, v) { grow(r, c); sh.write(r, c, enter(v)); return I; },
      typeRow(r, arr) { arr.forEach((v, j) => I.type(r, j + 1, v)); return I; },
      appendRow(arr) { return I.typeRow(sh.lastRow() + 1, arr); },
      raw(r, c, v) { grow(r, c); sh.formulas.delete(CELL_KEY(r, c)); sh.put(r, c, v); return I; },
      insertColumnBefore(col, n = 1) { sh.shiftCols(col - 1, n); sh.maxCols += n; return I; },
      moveColumn(from, to) {
        const R = sh.rows.length, vals = [];
        for (let r = 0; r < R; r++) { const row = sh.rows[r]; vals.push(row ? row.splice(from - 1, 1)[0] : undefined); }
        for (let r = 0; r < R; r++) {
          let row = sh.rows[r];
          if (vals[r] === undefined || vals[r] === '') { if (row && row.length >= to) row.splice(to - 1, 0, ''); continue; }
          if (!row) row = sh.rows[r] = [];
          while (row.length < to - 1) row.push('');
          row.splice(to - 1, 0, vals[r]);
        }
        sh.colDirty = true;
        return I;
      },
      deleteRows(r, n = 1) { sh.rows.splice(r - 1, n); sh.colDirty = true; return I; }
    };
    return I;
  }

  const inspect = {
    calls,
    resetCalls() { Object.keys(calls).forEach((k) => delete calls[k]); },
    sheetNames: () => book.sheets.map((s) => s.name),
    sheet: sheetInspector,
    formulas: formulaLog,
    spreadsheet: { timeZone: () => ssTz, url: ssObj.getUrl(), id: book.id, toasts: book.toasts },
    mails,
    mailQuota(n) { if (n !== undefined) quota = n; return quota; },
    failNextMail(msg) { failNext = msg || 'Mail service error (mock)'; },
    triggers: () => triggers.map((t) => { const o = { ...t }; delete o.proxy; return o; }),
    properties: () => scriptProps.getProperties(),
    cache: {
      get: (k) => { const e = cacheMap.get(k); return e && e.exp > clockNow() ? e.v : null; },
      keys: () => Array.from(cacheMap.keys()),
      clear: () => cacheMap.clear()
    },
    lock: {
      hold() { lockState.other = true; },
      release() { lockState.other = false; },
      held: () => lockState.held > 0,
      attempts: lockState.attempts
    },
    clock: {
      now: () => mkDate(clockNow()),
      set: setClock,
      advance(ms) { fixedMs = clockNow() + ms; clockFn = null; },
      real() { setClock(null); }
    },
    ui: {
      enable(b = true) { uiState.available = !!b; },
      available: () => uiState.available,
      alerts: uiState.alerts,
      menus: uiState.menus,
      toasts: book.toasts
    },
    logs,
    Date: FakeDate
  };

  return { globals, inspect };
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

/* Проєкт Apps Script у vm: файли виконуються як звичайні скрипти в одному глобальному контексті
   (як .gs-файли), top-level функції стають ctx.*. files: [{path, name?} | {source, name}] */
export function loadGasProject(options = {}) {
  const { files = GAS_FILES, ...mockOpts } = options;
  const { globals, inspect } = createGasMock(mockOpts);
  const ctx = vm.createContext({ ...globals });
  for (const f of files) {
    const src = f.source !== undefined ? f.source : readFileSync(f.path, 'utf8');
    vm.runInContext(src, ctx, { filename: f.name || basename(f.path || 'script.gs') });
  }
  return { ctx, globals, inspect };
}
