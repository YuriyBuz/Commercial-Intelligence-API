/* =====================================================================
   FOODLINE · Лінії — сервер Google Apps Script (Server.gs)
   API для планшетів і керівника (doGet / doPost), зберігання в Google-таблиці
   (SheetStore), блокування записів, листи, щоденний звіт, тригери, меню.
   Уся бізнес-логіка — у Core.gs (вміст lines/assets/core.js, глобальний LinesCore).

   ЯК РОЗГОРНУТИ
   1. Створіть нову Google-таблицю (напр. «Облік ліній»).
   2. Розширення → Apps Script. У проєкті мають бути два файли:
        Core.gs   — вставте ПОВНИЙ вміст lines/assets/core.js;
        Server.gs — вставте цей файл.
      Новий проєкт уже містить файл «Code.gs» (з function myFunction) — перейменуйте його на Core.gs
      (⋮ біля назви → Перейменувати) і замініть весь його вміст, або видаліть і створіть Core.gs заново.
   3. Налаштування проєкту (⚙) → увімкніть «Показувати файл маніфесту appsscript.json у редакторі»,
      відкрийте appsscript.json і замініть його вміст на lines/apps-script/appsscript.json.
      (Якщо редактор не приймає пояс «Europe/Kyiv», вкажіть «Europe/Kiev».)
   4. Оберіть функцію setup → «Виконати» (або оновіть таблицю й скористайтеся меню
      «Облік ліній → Початкове налаштування») і надайте дозволи:
        «Перевірити дозволи» → оберіть свій обліковий запис. Google покаже попередження
        «Google не перевірив цей застосунок» (Google hasn't verified this app) — це нормально для
        власного скрипту: натисніть «Додатково» (Advanced) → «Перейти до <назва проєкту> (небезпечно)»
        → «Дозволити». Буде створено аркуші, налаштування, токен доступу, PIN керівника й тригери
        (щоденний звіт, щогодинна перевірка строків ТО).
   5. Розгорнути → Нове розгортання → тип «Веб-застосунок»:
        Виконувати від імені: «Я» (Me)   ·   Хто має доступ: «Будь-хто» (Anyone).
      Скопіюйте URL веб-застосунку — він закінчується на /exec — і вставте його в меню
      «Облік ліній → Вказати адресу веб-застосунку (/exec)».
      (Адреса з …/dev — тестова: працює лише для редакторів проєкту, на планшетах — ні.)
   6. Аркуш «Налаштування» → параметр «manager_emails»: адреси керівників через кому (або
      «Керівництво → Налаштування» в застосунку) — та/або «Email» працівників на аркуші «Персонал»:
      керівникам надходять усі листи, механікам і електрикам — про ТО й ремонти, контролю якості —
      про зауваження в чек-листах (якщо задано «Лінії» — лише про ці лінії). Без жодної адреси
      листи-нагадування НЕ надсилаються. Перевірка — меню «Облік ліній → Надіслати звіт зараз».
   7. Меню «Облік ліній → Показати токен і PIN» — введіть адресу (/exec) і токен на планшетах
      («Налаштування пристрою» → робота з Google-таблицею). PIN — для розділу «Керівництво».
   8. (Необовʼязково) «Облік ліній → Заповнити демо-даними» — лише в порожню таблицю.
   ОНОВЛЕННЯ КОДУ: замініть Core.gs / Server.gs (і appsscript.json, якщо змінився) → знову
   «Облік ліній → Початкове налаштування» (дані не зачіпає; підтвердить нові дозволи) → Розгорнути →
   Керування розгортаннями → ✎ Редагувати → Версія: «Нова версія» → Розгорнути. URL лишається тим самим.
   ЧАСОВИЙ ПОЯС: змінюйте лише параметр «tz» (Керівництво → Налаштування) — застосунок сам переведе
   пояс таблиці, зберігши час записів. Не змінюйте пояс у «Файл → Налаштування таблиці»: Google
   тлумачить уже записані дати в новому поясі, і час усіх записів зсувається.
   МІСЦЕ: Google-таблиця вміщує до 10 млн клітинок (разом із порожніми). Щоденний звіт попередить
   на 70 %; тоді «Облік ліній → Архівувати старі чек-листи» перенесе давні чек-листи в окрему таблицю.

   ДОЗВОЛИ (oauthScopes в appsscript.json):
     spreadsheets         — ця таблиця (SpreadsheetApp.getActiveSpreadsheet(): аркуші, діапазони,
                            перевірка даних, flush) і створення таблиці-архіву (SpreadsheetApp.create,
                            лише з меню «Архівувати старі чек-листи»); openById не використовується;
     script.container.ui  — SpreadsheetApp.getUi(): меню, повідомлення й запити (лише з меню);
     script.scriptapp     — ScriptApp: тригери (newTrigger / getProjectTriggers / deleteTrigger),
                            getService().getUrl();
     script.send_mail     — MailApp.sendEmail / getRemainingDailyQuota.
   Без окремих дозволів: LockService, CacheService, PropertiesService, ContentService, Utilities,
   Session.getScriptTimeZone, Logger / console.

   Властивості скрипту (Script Properties): API_TOKEN, ADMIN_PIN (створює setup), API_URL (адреса
   …/exec — меню «Вказати адресу веб-застосунку»); службові: DAILY_TRIGGER (година й пояс
   тригера звіту), LAST_DAILY (день останнього щоденного звіту — для надолуження пропущеного).
   Лише оголошення var / function на верхньому рівні (порядок завантаження файлів не важливий).
   ===================================================================== */

var SERVER_VERSION = '1.0.0';
var LOCK_WAIT_MS = 25000;               // скільки чекати блокування перед відповіддю LOCKED
var CHUNK_ROWS = 500;                   // since(): читання журналу знизу вгору порціями
var UPDATE_GAP_ROWS = 50;               // update(): рядки ближче за це — одна група
var UPDATE_MAX_RUNS = 8;                // update(): до стількох відрізків — запис без читання, інакше діапазоном
var FIND_GAP_ROWS = 20;                 // findBy(): знайдені рядки ближче за це — одним читанням діапазону
var ADMIN_FAILS_PER_DEVICE = 10;        // невдалих спроб PIN керівника з одного пристрою …
var ADMIN_FAILS_GLOBAL = 60;            // … і з усіх пристроїв разом …
var ADMIN_WINDOW_SEC = 600;             // … за 10 хвилин
var MENU_TITLE = 'Облік ліній';
var MAIL_NAME = 'Облік ліній';
var JSONP_RE = /^[A-Za-z_$][\w$]{0,63}$/;
var HEAD_BG = '#f3ead7';
var SERVICE_BG = '#d9d9d9';
var SERVICE_FG = '#5f5f5f';
var NOTE_SERVICE = 'Службовий стовпець: його заповнює система. Не змінюйте вручну — значення буде перераховано.';
var NOTE_SECRET = 'PIN працівника (4–8 цифр, необовʼязково). Стовпець має формат «Звичайний текст» — PIN із нулем ' +
  'на початку (0427) зберігається як є; не змінюйте формат. На планшети передається лише його хеш.';
var CELL_LIMIT = 10000000;              // ліміт клітинок Google-таблиці (усі аркуші, і порожні клітинки теж)
var CELL_WARN = 7000000;                // з цього обсягу — попередження в щоденному звіті
var GROW_ROWS = 500;                    // запас рядків, що додається в кінець аркуша
var ARCHIVE_TABLES = ['checks', 'answers'];   // що архівуємо (ядро не перераховує з них мотогодини й лічильники)
var ARCHIVE_MONTHS = 12;                // типово — старші за рік
var ARCHIVE_MIN_MONTHS = 6;
var ARCHIVE_CHUNK = 5000;               // рядків за крок (кожен крок — окреме коротке блокування)
var ARCHIVE_BUDGET_MS = 240000;         // не довше 4 хв за запуск (ліміт виконання Apps Script — 6 хв)
// …/macros/s/<id>/exec; Google Workspace — …/a/macros/<домен>/s/<id>/exec (старий вигляд — …/a/<домен>/macros/s/…)
var EXEC_URL_RE = /^https:\/\/script\.google\.com\/(macros|a\/macros\/[^\/\s]+|a\/[^\/\s]+\/macros)\/s\/[A-Za-z0-9_\-]+\/exec$/;
var NOTE_LOG = 'Журнал заповнює застосунок, нові записи — внизу. Не сортуйте й не видаляйте рядки (для перегляду — фільтр). ' +
  'Помилковий запис анулюйте в застосунку (Керівництво → Журнал).';
var NOTE_PLAN = 'Аркуш формується автоматично (щодня та з меню «Облік ліній»). Ручні зміни буде перезаписано.';

/* =====================================================================
   HTTP: doGet / doPost
   ===================================================================== */

/* GET: ?action=…&token=…&payload=<JSON>[&callback=fn]. Резервний канал клієнта (JSONP), коли POST
   блокується мережею, — тому приймає й записи (пакети ідемпотентні за id операцій) */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var cb = p.callback === undefined || p.callback === null ? '' : String(p.callback);
  if (cb && !JSONP_RE.test(cb)) {
    return jsonOut_({ ok: false, error: 'BAD_REQUEST', message: 'Некоректна назва функції callback' });
  }
  var req = null, res;
  try { req = getRequest_(p); } catch (err) { res = { ok: false, error: 'BAD_REQUEST', message: 'Некоректний JSON у параметрі payload' }; }
  if (!res) res = handleRequest_(req);
  return cb ? jsonpOut_(cb, res) : jsonOut_(res);
}

/* POST: тіло — JSON (Content-Type text/plain, щоб браузер не робив preflight) */
function doPost(e) {
  var req = {};
  try {
    var body = e && e.postData ? e.postData.contents : '';
    if (body) {
      req = JSON.parse(body);
      if (!req || typeof req !== 'object' || Array.isArray(req)) throw new Error('not an object');
    }
  } catch (err) {
    return jsonOut_({ ok: false, error: 'BAD_REQUEST', message: 'Некоректний JSON у тілі запиту' });
  }
  var p = (e && e.parameter) || {};
  for (var k in p) if (has_(p, k) && !has_(req, k) && k !== 'callback') req[k] = p[k];
  return jsonOut_(handleRequest_(req));
}

function getRequest_(p) {
  var req = {}, k;
  if (p.payload) {
    var o = JSON.parse(String(p.payload));
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('payload is not an object');
    for (k in o) if (has_(o, k)) req[k] = o[k];
  }
  for (k in p) if (has_(p, k) && k !== 'payload' && k !== 'callback') req[k] = p[k];
  return req;
}

function jsonOut_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function jsonpOut_(cb, o) {
  // U+2028 / U+2029 недопустимі в JS-рядках старих рушіїв
  var s = JSON.stringify(o).split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
  return ContentService.createTextOutput('/**/' + cb + '(' + s + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
}

/* =====================================================================
   Обробка запиту: токен → PIN керівника → дія ядра (запис — під блокуванням) → листи
   ===================================================================== */
function handleRequest_(req) {
  try {
    req = req && typeof req === 'object' && !Array.isArray(req) ? req : {};
    var action = str_(req.action);
    var info = has_(LinesCore.ACTIONS, action) ? LinesCore.ACTIONS[action] : null;
    var props = PropertiesService.getScriptProperties();
    var token = props.getProperty('API_TOKEN') || '';
    if (!token || !safeEq_(req.token, token)) {
      // без токена відповідає лише ping (перевірка адреси), і то без даних
      if (action === 'ping' || action === '') return { ok: true, version: LinesCore.VERSION };
      return errOut_('BAD_TOKEN');
    }
    var adm = adminAuth_(req, props);
    if (info && info.admin && adm.limited) return errOut_('RATE_LIMIT');
    var ctx = { admin: adm.admin, device: str_(req.device).slice(0, 120) };
    var store = new SheetStore();
    var app = LinesCore.createApp(store, gasEnv_());
    var res;
    if (info && info.write && (!info.admin || ctx.admin)) {
      res = store.lock(function () {
        var r = app.handle(req, ctx);
        var list = takeNotify_(r);
        if (list.length) {
          try { deliver_(store, app, list); } catch (e) { console.error('Сповіщення не надіслано: ' + errText_(e)); }
        }
        if (r && r.ok) afterWrite_(action, req, store, app);
        return r;
      });
    } else {
      res = app.handle(req, ctx);
      takeNotify_(res);
      if (action === 'ping' && res && res.ok) res.server = SERVER_VERSION;
    }
    return res;
  } catch (e) {
    if (typeof LinesCore === 'undefined') {
      return { ok: false, error: 'SERVER_ERROR', message: 'Помилка сервера: не знайдено LinesCore — додайте до проєкту файл Core.gs' };
    }
    return LinesCore.util.errorResponse(e);
  }
}

function errOut_(code, message) {
  return { ok: false, error: code, message: message || LinesCore.ERR_MSG[code] || code };
}

/* PIN керівника: обмеження невдалих спроб через CacheService. Повтор того самого невірного PIN
   (напр. планшет зі старим PIN) рахується один раз; підбір — кожна нова спроба. */
function adminAuth_(req, props) {
  var given = str_(req.admin);
  if (!given) return { admin: false, limited: false };
  var cache = CacheService.getScriptCache();
  var dk = 'fl_adm_' + LinesCore.sha256('dev:' + str_(req.device)).slice(0, 32), gk = 'fl_adm_all';
  var d = failGet_(cache, dk), g = failGet_(cache, gk);
  if (d.n >= ADMIN_FAILS_PER_DEVICE || g.n >= ADMIN_FAILS_GLOBAL) return { admin: false, limited: true };
  var pin = props.getProperty('ADMIN_PIN') || '';
  if (pin && safeEq_(given, pin)) return { admin: true, limited: false };
  var h = LinesCore.sha256('pin:' + given).slice(0, 16);
  if (d.last !== h) {
    d.last = h;
    failBump_(cache, dk, d);
    failBump_(cache, gk, g);
  }
  return { admin: false, limited: false, failed: true };
}
function failGet_(cache, key) {
  var o = null, now = Date.now();
  try { var raw = cache.get(key); o = raw ? JSON.parse(raw) : null; } catch (e) { o = null; }
  if (!o || typeof o.n !== 'number' || typeof o.t !== 'number' || now - o.t >= ADMIN_WINDOW_SEC * 1000) return { n: 0, t: now, last: '' };
  return o;
}
function failBump_(cache, key, o) {
  o.n++;
  var left = Math.max(1, Math.ceil((o.t + ADMIN_WINDOW_SEC * 1000 - Date.now()) / 1000));
  try { cache.put(key, JSON.stringify(o), left); } catch (e) { /* кеш недоступний — без обмеження */ }
}

/* порівняння без раннього виходу (токен, PIN) */
function safeEq_(a, b) {
  a = str_(a); b = str_(b);
  if (!a || !b) return false;
  var diff = a.length ^ b.length;
  for (var i = 0; i < b.length; i++) diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ b.charCodeAt(i);
  return diff === 0;
}

/* _notify з відповіді (і з результатів пакета) — вилучаємо, щоб не йшли клієнту */
function takeNotify_(r) {
  var out = [];
  if (!r || typeof r !== 'object') return out;
  if (r._notify) { out = out.concat(r._notify); delete r._notify; }
  if (Array.isArray(r.results)) {
    r.results.forEach(function (x) {
      if (x && x.data && x.data._notify) { out = out.concat(x.data._notify); delete x.data._notify; }
    });
  }
  return out;
}

/* після успішного запису: зміна години звіту / поясу → тригер і пояс таблиці */
function afterWrite_(action, req, store, app) {
  if (action !== 'settings_save' || !req.values || typeof req.values !== 'object') return;
  var v = req.values;
  if (!has_(v, 'digest_hour') && !has_(v, 'tz')) return;
  var S = app.settings();
  try { syncTriggers_(S, false); } catch (e) { console.warn('Тригер звіту не оновлено: ' + errText_(e)); }
  try { retimeZone_(store, S.tz); } catch (e) { console.error('Пояс таблиці не змінено: ' + errText_(e)); }
}

/* пояс таблиці → tz, зберігши моменти часу. Sheets зберігає дату-час як «настінний» час у поясі
   таблиці, тож проста зміна поясу зсунула б усі записані дати на різницю поясів. Тому: читаємо
   стовпці дат (моменти за старим поясом) → змінюємо пояс → записуємо ті самі Date назад
   (формули й текст у клітинках лишаються). Виклик — під блокуванням. */
function retimeZone_(store, tz) {
  var ss = store.ss;
  if (!tz || ss.getSpreadsheetTimeZone() === tz) return 0;
  var jobs = [];
  LinesCore.TABLES.forEach(function (t) {
    var sh = store.sheet_(t);
    if (!sh) return;
    var h = store.head_(t), last = sh.getLastRow();
    if (last < 2) return;
    h.known.forEach(function (kc) {
      if (kc.c.base !== 'date') return;
      var rng = sh.getRange(2, kc.col, last - 1, 1), vals = rng.getValues(), any = false;
      for (var i = 0; i < vals.length && !any; i++) if (isDate_(vals[i][0])) any = true;
      if (any) jobs.push({ rng: rng, vals: vals, fx: rng.getFormulas() });
    });
  });
  ss.setSpreadsheetTimeZone(tz);
  jobs.forEach(function (j) {
    j.rng.setValues(j.vals.map(function (row, i) { return [j.fx[i][0] || keepCell_(row[0])]; }));
  });
  store.forget_();
  return jobs.length;
}

/* =====================================================================
   Листи: надсилання через MailApp + журнал «Сповіщення» (ключ — захист від повторів)
   list: [{key, kind, to:[emails], subject, html, text}]; opt.force — надіслати попри ключ
   ===================================================================== */
function deliver_(store, app, list, opt) {
  opt = opt || {};
  var idx = noticeIndex_(store), rows = [], out = [], quota = null;
  (list || []).forEach(function (n) {
    if (!n) return;
    var key = str_(n.key);
    if (key && !opt.force && idx.sent[key]) { out.push({ key: key, status: 'duplicate', error: '', to: [] }); return; }
    var to = LinesCore.util.toEmails(n.to).filter(LinesCore.util.isEmail);
    var status = 'sent', error = '';
    if (!to.length) {
      status = 'error';
      error = 'Немає отримувачів: заповніть ' + mailWhere_();
    } else {
      if (quota === null) quota = mailQuota_();
      if (quota < to.length) {
        status = 'error';
        error = 'Вичерпано денний ліміт листів Google (залишок: ' + quota + ')';
      } else {
        try {
          MailApp.sendEmail({ to: to.join(','), subject: String(n.subject || MAIL_NAME).slice(0, 250),
            htmlBody: String(n.html || ''), body: String(n.text || n.subject || ''), name: MAIL_NAME });
          quota -= to.length;
        } catch (e) {
          status = 'error';
          error = 'Помилка надсилання: ' + errText_(e);
        }
      }
    }
    if (status === 'sent' && key) idx.sent[key] = 1;
    var seenKey = key + '|' + status + '|' + error;
    // невдача з тією самою причиною вже в журналі — не дублюємо рядок (повторна спроба — наступного разу)
    if (status !== 'sent' && key && idx.seen[seenKey]) { out.push({ key: key, status: status, error: error, to: to, logged: false }); return; }
    idx.seen[seenKey] = 1;
    rows.push({ key: key, kind: n.kind, to: to, subject: n.subject, status: status, error: error });
    out.push({ key: key, status: status, error: error, to: to });
  });
  if (rows.length) app.logNotices(rows);
  return out;
}
/* де задати отримувачів листів (для повідомлень) */
function mailWhere_() {
  return '«manager_emails» на аркуші «' + LinesCore.SCHEMA.settings.sheet + '» або «Email» працівника з посадою «' +
    LinesCore.LABELS.role.manager + '» на аркуші «' + LinesCore.SCHEMA.staff.sheet + '»';
}
/* отримувачі щоденного звіту без побудови самого звіту (як у ядрі: «manager_emails» + активні
   працівники з посадою «Керівник» і email на аркуші «Персонал») */
function digestTo_(store, S) {
  var to = S.manager_emails.slice();
  store.all('staff').forEach(function (r) {
    var p = LinesCore.norm('staff', r);
    if (p.active && p.role === 'manager') to = to.concat(LinesCore.util.toEmails(p.email));
  });
  return to.filter(LinesCore.util.isEmail);
}
function noticeIndex_(store) {
  var sent = {}, seen = {};
  store.all('notices').forEach(function (r) {
    var n = LinesCore.norm('notices', r);
    if (!n.key) return;
    if (n.status === 'sent') sent[n.key] = 1;
    seen[n.key + '|' + n.status + '|' + n.error] = 1;
  });
  return { sent: sent, seen: seen };
}
function mailQuota_() {
  try { return MailApp.getRemainingDailyQuota(); } catch (e) { return Infinity; }
}

/* =====================================================================
   Середовище для ядра: час через Utilities (часовий пояс заводу), id через getUuid
   ===================================================================== */
function gasEnv_() {
  var okTz = {}, C = { key: {}, start: {}, part: {} }, nC = 0;
  function checkTz(tz) {
    if (!has_(okTz, tz)) okTz[tz] = tzKnown_(tz);
    if (!okTz[tz]) throw new Error('Невідомий часовий пояс: ' + tz);
  }
  /* кеш викликів Utilities на одне виконання (обмежений за розміром) */
  function memo(kind, k, fn) {
    if (has_(C[kind], k)) return C[kind][k];
    if (++nC > 20000) { C = { key: {}, start: {}, part: {} }; nC = 1; }
    return (C[kind][k] = fn());
  }
  return {
    now: function () { return new Date(); },
    uuid: function () { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); },
    // межі доби припадають на цілі хвилини — кеш за хвилиною точний
    dayKey: function (d, tz) {
      checkTz(tz);
      return memo('key', tz + '|' + Math.floor(d.getTime() / 60000), function () { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); });
    },
    dayStart: function (key, tz) {
      checkTz(tz);
      return new Date(memo('start', tz + '|' + key, function () {
        return Utilities.parseDate(key + ' 00:00:00', tz, 'yyyy-MM-dd HH:mm:ss').getTime();
      }));
    },
    parts: function (d, tz) {
      checkTz(tz);
      var s = memo('part', tz + '|' + Math.floor(d.getTime() / 1000), function () { return Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm:ss'); });
      return { y: +s.slice(0, 4), m: +s.slice(5, 7), d: +s.slice(8, 10), H: +s.slice(11, 13), M: +s.slice(14, 16), S: +s.slice(17, 19) };
    }
  };
}
/* Utilities.formatDate мовчки підставляє GMT для невідомого поясу (напр. старі дані без
   Europe/Kyiv) — тоді ядро перейде на синонім (Europe/Kiev). Пояс вважаємо відомим, якщо це
   UTC/GMT або якщо взимку чи влітку зсув не нульовий. */
function tzKnown_(tz) {
  if (typeof tz !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(tz)) return false;
  if (/^(Etc\/)?(UTC|GMT|UCT|Zulu|Universal|Greenwich)([+-]0)?$/i.test(tz)) return true;
  var y = new Date().getUTCFullYear();
  try {
    return Utilities.formatDate(new Date(Date.UTC(y, 0, 15, 12)), tz, 'Z') !== '+0000' ||
      Utilities.formatDate(new Date(Date.UTC(y, 6, 15, 12)), tz, 'Z') !== '+0000';
  } catch (e) { return false; }
}

/* =====================================================================
   SheetStore — сховище ядра поверх аркушів Google-таблиці
   Стовпці знаходяться за текстом заголовка (порядок довільний, чужі стовпці не чіпаємо),
   кеш аркушів / заголовків / довідників — на одне виконання (новий SheetStore на кожен запит).
   ===================================================================== */
function SheetStore(ss) {
  if (!(this instanceof SheetStore)) return new SheetStore(ss);
  this.ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  this.S = LinesCore.SCHEMA;
  this.sheets_ = {};                     // t → Sheet | null
  this.heads_ = {};                      // t → відповідність стовпців
  this.rows_ = {};                       // t → сирі рядки довідника (кеш)
  this.rowAt_ = {};                      // t → {id: номер рядка} для кешованого довідника
  this.last_ = {};                       // t → getLastRow()
  this.tail_ = {};                       // t → прочитаний низ журналу (since): {top, objs, tsv, full, g*}
  this.seen_ = {};                       // t → {ключ: номер рядка} — рядки, знайдені findBy (для update)
  this.cbPending_ = {};                  // t → {sh, from, to}: прапорці для рядків, доданих під блокуванням
  this.depth_ = 0;
  this.created_ = [];
  this.cbRule_ = null;
}

SheetStore.prototype.sheet_ = function (t) {
  if (!has_(this.sheets_, t)) this.sheets_[t] = this.ss.getSheetByName(this.S[t].sheet);
  return this.sheets_[t];
};
SheetStore.prototype.lastRow_ = function (t, sh) {
  if (!has_(this.last_, t)) this.last_[t] = sh.getLastRow();
  return this.last_[t];
};
/* скинути кеш даних (після зміни схеми / на вході в блокування) */
SheetStore.prototype.forget_ = function (t) {
  if (t) { delete this.rows_[t]; delete this.rowAt_[t]; delete this.last_[t]; delete this.tail_[t]; delete this.seen_[t]; return; }
  this.rows_ = {}; this.rowAt_ = {}; this.last_ = {}; this.tail_ = {}; this.seen_ = {};
};

/* заголовки: точний текст → текст без регістру/зайвих пробілів/різних апострофів → код стовпця (k) */
SheetStore.prototype.head_ = function (t) {
  if (this.heads_[t]) return this.heads_[t];
  var sc = this.S[t], sh = this.sheet_(t);
  var h = { map: {}, cols: {}, width: 0, known: [], maxKnown: 0 };
  if (sh) {
    var w = sh.getLastColumn();
    if (w > 0) {
      var hdr = sh.getRange(1, 1, 1, w).getValues()[0], exact = {}, loose = {}, used = {};
      h.width = w;
      for (var i = 0; i < hdr.length; i++) {
        var s = String(hdr[i] === null || hdr[i] === undefined ? '' : hdr[i]).trim();
        if (!s) continue;
        if (!has_(exact, s)) exact[s] = i + 1;
        var n = headNorm_(s);
        if (!has_(loose, n)) loose[n] = i + 1;
      }
      var pick = function (c, col) { if (col && !used[col]) { used[col] = 1; h.map[c.k] = col; } };
      sc.cols.forEach(function (c) { pick(c, exact[c.t] || loose[headNorm_(c.t)]); });
      sc.cols.forEach(function (c) { if (!h.map[c.k]) pick(c, loose[headNorm_(c.k)]); });
    }
  }
  sc.cols.forEach(function (c) {
    h.cols[c.k] = c;
    if (h.map[c.k]) { h.known.push({ k: c.k, col: h.map[c.k], c: c }); h.maxKnown = Math.max(h.maxKnown, h.map[c.k]); }
  });
  h.known.sort(function (a, b) { return a.col - b.col; });
  this.heads_[t] = h;
  return h;
};

SheetStore.prototype.cacheable_ = function (t) { return this.S[t].kind === 'config'; };

/* рядок аркуша → сирий обʼєкт {k: значення}; порожній рядок → null */
SheetStore.prototype.rowObj_ = function (h, row) {
  var o = {}, blank = true;
  for (var i = 0; i < h.known.length; i++) {
    var x = h.known[i], v = row[x.col - 1];
    if (v === undefined || v === null) v = '';
    o[x.k] = v;
    if (v !== '' && v !== false) blank = false;
  }
  return blank ? null : o;
};

SheetStore.prototype.all = function (t) {
  if (this.rows_[t]) return this.rows_[t].map(copy_);
  var sh = this.sheet_(t);
  if (!sh) return [];
  var cfg = this.cacheable_(t), tl = this.tail_[t];
  if (tl && tl.full && !cfg) return tl.objs.filter(Boolean).map(copy_);
  var h = this.head_(t), pk = this.S[t].pk, out = [], at = {}, objs = [], tsv = [];
  var last = h.maxKnown ? this.lastRow_(t, sh) : 0, tc = h.map.ts;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, h.maxKnown).getValues();
    for (var i = 0; i < vals.length; i++) {
      var o = this.rowObj_(h, vals[i]);
      if (tc) { objs.push(o); tsv.push(vals[i][tc - 1]); }
      if (!o) continue;
      out.push(o);
      var id = pk ? keyStr_(o[pk]) : '';
      if (id && !has_(at, id)) at[id] = i + 2;
    }
  }
  if (cfg && h.maxKnown) {
    this.rows_[t] = out;
    this.rowAt_[t] = at;
    return out.map(copy_);
  }
  if (tc && h.maxKnown) {
    // журнал прочитано цілком — це й повний хвіст для since()
    this.tail_[t] = { top: 2, objs: objs, tsv: tsv, full: true, gMax: -Infinity, gMin: Infinity, gDated: 0, gText: false, tMax: -Infinity };
    return out.map(copy_);
  }
  return out;
};

/* рядки з ts >= date (у порядку аркуша); текст у «Час» — теж віддаємо ядру, рядки без часу — ні.
   Читаємо лише низ журналу (tail_): можуть потрапити й старші рядки — ядро їх відфільтрує */
SheetStore.prototype.since = function (t, date) {
  var b = isDate_(date) ? date.getTime() : (typeof date === 'number' ? date : NaN);
  if (!isFinite(b)) return this.all(t);
  var sh = this.sheet_(t);
  if (!sh) return [];
  var h = this.head_(t);
  if (!h.map.ts) return this.all(t);
  var tl = this.tailTo_(t, sh, h, b), out = [];
  for (var i = 0; i < tl.objs.length; i++) {
    var o = tl.objs[i], ts = tl.tsv[i];
    if (!o) continue;
    if (isDate_(ts)) { if (!(ts.getTime() >= b)) continue; }
    else if (ts === '' || ts === null || ts === undefined) continue;
    out.push(copy_(o));
  }
  return out;
};

/* низ журналу, достатній для межі b: знизу вгору, доки верхні CHUNK_ROWS прочитаних рядків не стануть
   цілком старшими за межу (є дати, усі < b, без тексту в «Час»). Перша порція — CHUNK_ROWS рядків; якщо
   межа ще вище за неї — наступна одразу на стільки рядків, скільки до межі за щільністю вже прочитаного
   (+20 % і CHUNK_ROWS), тож давня межа — кілька читань, а не порція на кожні CHUNK_ROWS рядків.
   Кеш — на виконання (скидається на вході в блокування): пакет операцій не перечитує ті самі рядки,
   менша межа — дочитує лише вище; insert / update оновлюють кеш */
SheetStore.prototype.tailTo_ = function (t, sh, h, b) {
  var tl = this.tail_[t], tc = h.map.ts;
  if (!tl) {
    var last = this.lastRow_(t, sh);
    tl = this.tail_[t] = { top: Math.max(2, last + 1), objs: [], tsv: [], full: last < 2,
      gMax: -Infinity, gMin: Infinity, gDated: 0, gText: false, tMax: -Infinity };
  }
  while (!tl.full && !(tl.gDated > 0 && !tl.gText && tl.gMax < b)) {
    var end = tl.top - 1, n = CHUNK_ROWS;
    if (tl.gDated > 0 && tl.gMin >= b && tl.tMax > tl.gMin) {
      n = Math.max(n, Math.ceil((tl.gMin - b) * tl.objs.length / (tl.tMax - tl.gMin) * 1.2) + CHUNK_ROWS);
    }
    var start = Math.max(2, end - n + 1);
    var vals = sh.getRange(start, 1, end - start + 1, h.maxKnown).getValues();
    // g* — лише верхні CHUNK_ROWS рядків прочитаного (за ними — умова зупинки й оцінка відстані до межі)
    var objs = new Array(vals.length), tsv = new Array(vals.length), guard = Math.min(vals.length, CHUNK_ROWS);
    var gMax = -Infinity, gMin = Infinity, gDated = 0, gText = false;
    for (var i = 0; i < vals.length; i++) {
      var ts = vals[i][tc - 1];
      tsv[i] = ts;
      objs[i] = this.rowObj_(h, vals[i]);
      if (isDate_(ts)) {
        var ms = ts.getTime();
        if (ms > tl.tMax) tl.tMax = ms;
        if (i < guard) { gDated++; if (ms > gMax) gMax = ms; if (ms < gMin) gMin = ms; }
      } else if (i < guard && ts !== '' && ts !== null && ts !== undefined) gText = true;
    }
    tl.objs = objs.concat(tl.objs);
    tl.tsv = tsv.concat(tl.tsv);
    tl.top = start;
    tl.full = start <= 2;
    tl.gMax = gMax; tl.gMin = gMin; tl.gDated = gDated; tl.gText = gText;
  }
  return tl;
};

/* необовʼязковий метод сховища для ядра (давній запис журналу за ID, відповіді чек-листа за ID чек-листа):
   сирі рядки, де стовпець col дорівнює value (текст без пробілів по краях), у порядку аркуша.
   Читаємо лише цей стовпець (над прочитаним низом журналу; сам низ — з кешу tail_), далі — лише знайдені
   рядки: близькі — одним діапазоном. null — немає аркуша чи стовпця (ядро обійде читанням вікна / журналу).
   Номери знайдених рядків за ключем запамʼятовуються: update() їх уже не шукає */
SheetStore.prototype.findBy = function (t, col, value) {
  var v = str_(value), sh = v ? this.sheet_(t) : null;
  if (!sh) return null;
  var h = this.head_(t), c = h.map[col];
  if (!c) return null;
  var tl = this.tail_[t], pk = this.S[t].pk, upto = tl ? tl.top - 1 : this.lastRow_(t, sh);
  var seen = this.seen_[t] || (this.seen_[t] = {}), hits = [], out = [], i;
  if (upto >= 2) {
    var cv = sh.getRange(2, c, upto - 1, 1).getValues();
    for (i = 0; i < cv.length; i++) if (keyStr_(cv[i][0]) === v) hits.push(i + 2);
  }
  // пошук за ключем переглянув увесь стовпець — перший знайдений рядок точно перший із цим ключем
  var byPk = col === pk, first = true;
  var keep = function (o, r) {
    out.push(o);
    var id = pk ? keyStr_(o[pk]) : '';
    if (id && (byPk ? first : !has_(seen, id))) seen[id] = r;
    first = false;
  };
  for (i = 0; i < hits.length;) {
    var j = i;
    while (j + 1 < hits.length && hits[j + 1] - hits[j] <= FIND_GAP_ROWS) j++;
    var r0 = hits[i], vals = sh.getRange(r0, 1, hits[j] - r0 + 1, h.maxKnown).getValues();
    for (; i <= j; i++) {
      var o = this.rowObj_(h, vals[hits[i] - r0]);
      if (o) keep(o, hits[i]);
    }
  }
  if (tl) {
    for (i = 0; i < tl.objs.length; i++) {
      var x = tl.objs[i];
      if (x && keyStr_(x[col]) === v) keep(copy_(x), tl.top + i);
    }
  }
  return out;
};

/* додати рядки в кінець — одним setValues */
SheetStore.prototype.insert = function (t, rows) {
  rows = rows || [];
  if (!rows.length) return 0;
  var sh = this.ensureTable_(t, false), h = this.head_(t), width = h.maxKnown, data = new Array(rows.length);
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i], a = new Array(width);
    for (var j = 0; j < width; j++) a[j] = '';
    for (var x = 0; x < h.known.length; x++) {
      var kc = h.known[x];
      if (has_(r, kc.k)) a[kc.col - 1] = cellOut_(kc.c, r[kc.k]);
    }
    data[i] = a;
  }
  var start = Math.max(2, this.lastRow_(t, sh) + 1);
  growRows_(sh, start + rows.length - 1, h);
  this.textCols_(sh, h, start, rows.length);
  sh.getRange(start, 1, rows.length, width).setValues(data);
  this.last_[t] = start + rows.length - 1;
  this.checkboxes_(sh, h, start, rows.length, t);
  var cache = this.rows_[t], at = this.rowAt_[t], pk = this.S[t].pk, tl = this.tail_[t], tc = h.map.ts;
  if ((cache && at) || tl) {
    data.forEach(function (a, n) {
      var o = {};
      h.known.forEach(function (kc) { o[kc.k] = cellBack_(kc.c, a[kc.col - 1]); });
      if (tl) { tl.objs.push(copy_(o)); tl.tsv.push(tc ? o.ts : ''); }
      if (!cache || !at) return;
      cache.push(o);
      var id = pk ? keyStr_(o[pk]) : '';
      if (id && !has_(at, id)) at[id] = start + n;
    });
  }
  return rows.length;
};

/* patches: [{<pk>: id, …поля}] — перший рядок із таким ключем. Номер рядка — з кешу довідника
   або одним читанням стовпця ключа. Кілька клітинок — окремими записами без читання;
   багато близьких рядків — одним діапазоном (значення й формули сусідніх клітинок зберігаються) */
SheetStore.prototype.update = function (t, patches) {
  patches = patches || [];
  if (!patches.length) return 0;
  var pk = this.S[t].pk || 'id';
  var sh = this.ensureTable_(t, false), h = this.head_(t), pcol = h.map[pk];
  if (!pcol) return 0;
  var at = this.rowAt_[t] || this.rowsOf_(t, sh, pcol, pk, patches);
  var secret = {};
  h.known.forEach(function (kc) { if (kc.c.secret) secret[kc.col] = 1; });
  var byRow = {}, rowList = [], n = 0;
  patches.forEach(function (p) {
    var row = at[keyStr_(p && p[pk])];
    if (!row) return;
    n++;
    var cells = byRow[row];
    if (!cells) { cells = byRow[row] = {}; rowList.push(row); }
    for (var k in p) if (has_(p, k) && k !== pk && h.map[k]) cells[h.map[k]] = cellOut_(h.cols[k], p[k]);
  });
  rowList.sort(function (a, b) { return a - b; });
  var groups = [], g = null;
  rowList.forEach(function (r) {
    if (!g || r - g.to > UPDATE_GAP_ROWS) { g = { from: r, to: r, rows: [], runs: 0 }; groups.push(g); }
    g.to = r;
    g.rows.push(r);
    g.runs += cellRuns_(byRow[r]).length;
  });
  groups.forEach(function (gr) {
    if (gr.runs <= UPDATE_MAX_RUNS) {
      gr.rows.forEach(function (r) {
        for (var c in byRow[r]) if (secret[c]) sh.getRange(r, +c).setNumberFormat('@');
        cellRuns_(byRow[r]).forEach(function (run) { sh.getRange(r, run.col, 1, run.vals.length).setValues([run.vals]); });
      });
      return;
    }
    var c1 = Infinity, c2 = 0;
    gr.rows.forEach(function (r) { for (var c in byRow[r]) { var ci = +c; if (ci < c1) c1 = ci; if (ci > c2) c2 = ci; } });
    if (!c2) return;
    var rng = sh.getRange(gr.from, c1, gr.to - gr.from + 1, c2 - c1 + 1);
    var vals = rng.getValues(), fx = rng.getFormulas();
    var out = vals.map(function (row, ri) {
      // текст сусідніх клітинок знову захищаємо; PIN (формат '@') — як є, без апострофа
      return row.map(function (v, ci) { return fx[ri][ci] ? fx[ri][ci] : secret[c1 + ci] ? v : keepCell_(v); });
    });
    gr.rows.forEach(function (r) { var cells = byRow[r]; for (var c in cells) out[r - gr.from][+c - c1] = cells[c]; });
    for (var sc in secret) if (+sc >= c1 && +sc <= c2) sh.getRange(gr.from, +sc, gr.to - gr.from + 1, 1).setNumberFormat('@');
    rng.setValues(out);
  });
  var cache = this.rows_[t], tl = this.tail_[t];
  var put = function (o, p) {
    for (var k in p) if (has_(p, k) && k !== pk && h.map[k]) o[k] = cellBack_(h.cols[k], cellOut_(h.cols[k], p[k]));
  };
  if (cache) {
    patches.forEach(function (p) {
      var id = keyStr_(p && p[pk]);
      for (var ci = 0; ci < cache.length; ci++) {
        if (keyStr_(cache[ci][pk]) !== id) continue;
        put(cache[ci], p);
        break;
      }
    });
  }
  if (tl) {
    patches.forEach(function (p) {
      var i = (at[keyStr_(p && p[pk])] || 0) - tl.top;
      if (i < 0 || i >= tl.objs.length || !tl.objs[i]) return;
      put(tl.objs[i], p);
      if (h.map.ts && has_(p, 'ts')) tl.tsv[i] = tl.objs[i].ts;
    });
  }
  return n;
};

/* номери рядків за ключем (перший рядок із ключем): з прочитаного низу журналу (tail_) і знайдених
   findBy (seen_), а чого там немає — одним читанням стовпця ключа вище низу (без tail_ — усього стовпця) */
SheetStore.prototype.rowsOf_ = function (t, sh, pcol, pk, patches) {
  var tl = this.tail_[t], seen = this.seen_[t], at = {}, i, id;
  if (seen) for (id in seen) if (has_(seen, id)) at[id] = seen[id];
  if (tl) {
    for (i = 0; i < tl.objs.length; i++) {
      id = tl.objs[i] ? keyStr_(tl.objs[i][pk]) : '';
      if (id && !has_(at, id)) at[id] = tl.top + i;
    }
  }
  if (tl || seen) {
    var miss = patches.some(function (p) { return !has_(at, keyStr_(p && p[pk])); });
    if (!miss) return at;
  }
  var upto = tl ? tl.top - 1 : this.lastRow_(t, sh);
  if (upto < 2) return at;
  var ids = sh.getRange(2, pcol, upto - 1, 1).getValues(), above = {};
  for (i = 0; i < ids.length; i++) {
    id = keyStr_(ids[i][0]);
    if (id && !has_(above, id)) above[id] = i + 2;
  }
  for (id in above) if (has_(above, id)) at[id] = above[id];
  return at;
};
/* клітинки рядка {стовпець: значення} → суцільні відрізки [{col, vals}] */
function cellRuns_(cells) {
  var cols = Object.keys(cells).map(Number).sort(function (a, b) { return a - b; }), runs = [], cur = null;
  cols.forEach(function (c) {
    if (cur && c === cur.col + cur.vals.length) cur.vals.push(cells[c]);
    else { cur = { col: c, vals: [cells[c]] }; runs.push(cur); }
  });
  return runs;
}

/* заміна всіх рядків (напр. «План ППР») */
SheetStore.prototype.replace = function (t, rows) {
  rows = rows || [];
  var sh = this.ensureTable_(t, false), h = this.head_(t), width = h.maxKnown;
  var last = this.lastRow_(t, sh), w = Math.max(width, sh.getLastColumn());
  if (last >= 2 && w > 0) sh.getRange(2, 1, last - 1, w).clearContent();
  this.forget_(t);
  delete this.cbPending_[t];
  this.last_[t] = 1;
  if (!rows.length) return 0;
  var data = rows.map(function (r) {
    var a = new Array(width);
    for (var j = 0; j < width; j++) a[j] = '';
    h.known.forEach(function (kc) { if (has_(r, kc.k)) a[kc.col - 1] = cellOut_(kc.c, r[kc.k]); });
    return a;
  });
  growRows_(sh, rows.length + 1, h);
  this.textCols_(sh, h, 2, rows.length);
  sh.getRange(2, 1, rows.length, width).setValues(data);
  this.last_[t] = rows.length + 1;
  this.checkboxes_(sh, h, 2, rows.length);
  return rows.length;
};

/* виключне виконання (LockService); вкладені виклики — без повторного блокування */
SheetStore.prototype.lock = function (fn) {
  if (this.depth_ > 0) {
    this.depth_++;
    try { return fn(); } finally { this.depth_--; }
  }
  var lk = LockService.getScriptLock();
  if (!lk.tryLock(LOCK_WAIT_MS)) throw LinesCore.util.AppError('LOCKED');
  this.depth_ = 1;
  this.forget_();                        // прочитане до блокування могло застаріти
  try {
    return fn();
  } finally {
    this.depth_ = 0;
    try { this.flushCheckboxes_(); } catch (e) { console.warn('Прапорці не додано: ' + errText_(e)); }
    try { SpreadsheetApp.flush(); } catch (e) { /* далі все одно звільняємо */ }
    lk.releaseLock();
  }
};

/* усі аркуші схеми (у порядку TABLES); full — повторно застосувати оформлення до всіх стовпців */
SheetStore.prototype.ensureSchema = function (full) {
  var self = this;
  this.created_ = [];
  LinesCore.TABLES.forEach(function (t) { self.ensureTable_(t, !!full); });
  return this.created_.slice();
};

/* аркуш таблиці існує й має всі стовпці схеми (відсутні дописуються праворуч) */
SheetStore.prototype.ensureTable_ = function (t, full) {
  var sc = this.S[t], sh = this.sheet_(t), created = false;
  if (!sh) {
    sh = this.ss.insertSheet(sc.sheet, this.ss.getSheets().length);
    this.sheets_[t] = sh;
    delete this.heads_[t];
    created = true;
    this.created_.push(sc.sheet);
  }
  var h = this.head_(t);
  var add = sc.cols.filter(function (c) { return !h.map[c.k]; });
  if (add.length) {
    var at = h.width + 1;
    growCols_(sh, at + add.length - 1);
    sh.getRange(1, at, 1, add.length).setValues([add.map(function (c) { return textCell_(c.t); })]);
    delete this.heads_[t];
    this.forget_(t);
    h = this.head_(t);
  }
  if (created || full) trimCols_(sh, h);
  if (created || full || add.length) this.format_(t, sh, h, created || full ? null : add, created);
  return sh;
};

/* оформлення: жирний закріплений заголовок, службові стовпці — сірі з приміткою,
   формат дати, випадні списки для enum (з українськими мітками), прапорці для bool */
SheetStore.prototype.format_ = function (t, sh, h, onlyCols, created) {
  var sc = this.S[t], list = onlyCols || sc.cols, self = this, maxR = sh.getMaxRows();
  if (h.maxKnown) {
    if (!onlyCols) sh.getRange(1, 1, 1, h.maxKnown).setFontWeight('bold');
    if (sh.getFrozenRows() < 1) sh.setFrozenRows(1);
  }
  var last = sh.getLastRow();
  list.forEach(function (c) {
    var col = h.map[c.k];
    if (!col) return;
    var head = sh.getRange(1, col);
    if (onlyCols) head.setFontWeight('bold');
    if (c.service) head.setBackground(SERVICE_BG).setFontColor(SERVICE_FG).setNote(NOTE_SERVICE);
    else {
      head.setBackground(HEAD_BG);
      if (c.secret) head.setNote(NOTE_SECRET);
    }
    if (maxR < 2) return;
    var body = sh.getRange(2, col, maxR - 1, 1);
    // PIN — «Звичайний текст»: інакше введений у таблиці «0427» Sheets збереже числом 427
    if (c.secret) body.setNumberFormat('@');
    else if (c.base === 'date') body.setNumberFormat(t === 'plan' && c.k === 'date' ? 'dd.MM.yyyy' : 'dd.MM.yyyy HH:mm');
    else if (c.base === 'enum') {
      var labels = [], set = LinesCore.LABELS[c.set];
      for (var code in set) if (has_(set, code)) labels.push(set[code]);
      body.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(labels, true).setAllowInvalid(true).build());
    } else if (c.base === 'bool' && !c.nullable && last >= 2) {
      // прапорці лише на рядках із даними: порожня клітинка з прапорцем = FALSE і рахується в getLastRow
      sh.getRange(2, col, last - 1, 1).setDataValidation(self.checkbox_());
    }
  });
  if (created || !onlyCols) {
    var first = h.map.id || h.map.key || h.map.date;
    if (first && sc.kind === 'log') sh.getRange(1, first).setNote(NOTE_LOG);
    if (first && t === 'plan') sh.getRange(1, first).setNote(NOTE_PLAN);
    if (created && sc.kind !== 'config') sh.setTabColor(sc.kind === 'log' ? '#8fa6c4' : '#b0b0b0');
  }
};

SheetStore.prototype.checkbox_ = function () {
  return this.cbRule_ || (this.cbRule_ = SpreadsheetApp.newDataValidation().requireCheckbox().build());
};
/* прапорці для щойно записаних рядків. Під блокуванням — один раз на таблицю при виході з нього
   (рядки пакета додаються підряд — одна перевірка даних на весь діапазон, а не на кожну операцію) */
SheetStore.prototype.checkboxes_ = function (sh, h, start, n, t) {
  var end = start + n - 1, p = t ? this.cbPending_[t] : null;
  if (t && this.depth_ > 0) {
    if (p && p.sh === sh && start <= p.to + 1 && end >= p.from - 1) { p.from = Math.min(p.from, start); p.to = Math.max(p.to, end); return; }
    if (p) this.applyCheckboxes_(t, p);
    this.cbPending_[t] = { sh: sh, from: start, to: end };
    return;
  }
  this.applyCheckboxes_(t, { sh: sh, from: start, to: end }, h);
};
SheetStore.prototype.applyCheckboxes_ = function (t, p, h) {
  var self = this;
  (h || this.head_(t)).known.forEach(function (kc) {
    if (kc.c.base === 'bool' && !kc.c.nullable) p.sh.getRange(p.from, kc.col, p.to - p.from + 1, 1).setDataValidation(self.checkbox_());
  });
};
SheetStore.prototype.flushCheckboxes_ = function () {
  var p = this.cbPending_;
  this.cbPending_ = {};
  for (var t in p) if (has_(p, t)) this.applyCheckboxes_(t, p[t]);
};
/* стовпці «Звичайний текст» (PIN): формат '@' перед записом — навіть якщо його прибрали в таблиці */
SheetStore.prototype.textCols_ = function (sh, h, start, n) {
  h.known.forEach(function (kc) { if (kc.c.secret) sh.getRange(start, kc.col, n, 1).setNumberFormat('@'); });
};

/* ------------------------------ значення клітинок ------------------------------ */

/* значення для запису в стовпець c: Date / число / логічне — як є; рядки — із захистом
   від формул і автоперетворення Sheets (див. textCell_) */
function cellOut_(c, v) {
  if (v === null || v === undefined) return '';
  // PIN: клітинка у форматі '@' (textCols_) — рядок як є; апостроф там зберігся б буквально
  if (c && c.secret) return isDate_(v) ? '' : String(v).slice(0, 49999);
  if (isDate_(v)) return isNaN(v.getTime()) ? '' : v;
  if (typeof v === 'number') return isFinite(v) ? v : '';
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') v = String(v);
  if (c && c.base === 'num') {
    var n = LinesCore.util.toNum(v);
    if (n !== null) return n;
  }
  return textCell_(v);
}
/* рядок, який Sheets перетворив би (формула, число, дата, час, TRUE/FALSE, #N/A…) або почався б
   з апострофа, записуємо з провідним апострофом — у клітинці лишається буквальний текст */
function textCell_(s) {
  s = String(s);
  if (s.length > 49999) s = s.slice(0, 49999);
  if (!s) return '';
  if (/^\s*[=+\-@']/.test(s) || /^[\t\r\n]/.test(s) ||
      (/^[\s\d.,:\/+\-%()eE₴$€£]+$/.test(s) && /\d/.test(s)) ||
      /^\s*\d{4}-\d{1,2}-\d{1,2}/.test(s) ||
      /^\s*(true|false)\s*$/i.test(s) ||
      /^\s*#(N\/A|REF!|DIV\/0!|VALUE!|NAME\?|NUM!|NULL!|ERROR!)\s*$/i.test(s)) {
    return '\'' + s;
  }
  return s;
}
/* незмінна клітинка при перезаписі діапазону: текст знову захищаємо */
function keepCell_(v) { return typeof v === 'string' ? textCell_(v) : v; }
/* що поверне getValues після запису значення cellOut_ (для кешів) */
function readBack_(v) {
  if (isDate_(v)) return new Date(v.getTime());
  return typeof v === 'string' && v.charAt(0) === '\'' ? v.slice(1) : v;
}
/* … у стовпець c: порожня клітинка з прапорцем читається як FALSE */
function cellBack_(c, v) {
  if (c && c.secret) return v;
  var x = readBack_(v);
  return x === '' && c && c.base === 'bool' && !c.nullable ? false : x;
}

/* додати рядки в кінець аркуша (із запасом); успадковані прапорці (порожні = FALSE, що зсунуло б
   getLastRow) знімаємо, решта оформлення (формат дати, списки) лишається */
function growRows_(sh, need, h) {
  var max = sh.getMaxRows();
  if (max >= need) return;
  var add = Math.max(need - max, GROW_ROWS);
  try {
    sh.insertRowsAfter(max, add);
  } catch (e) {
    if (!isCellLimit_(e)) throw e;
    // запас не вміщається в ліміт клітинок — лише потрібні рядки
    add = need - max;
    try { sh.insertRowsAfter(max, add); } catch (e2) { if (isCellLimit_(e2)) throw fullError_(); throw e2; }
  }
  (h ? h.known : []).forEach(function (kc) {
    if (kc.c.base === 'bool' && !kc.c.nullable) sh.getRange(max + 1, kc.col, add, 1).clearDataValidations().clearContent();
  });
}
function growCols_(sh, need) {
  var max = sh.getMaxColumns();
  if (max < need) sh.insertColumnsAfter(max, need - max);
}
/* порожні стовпці праворуч від даних (нова вкладка — 26 стовпців) теж займають місце в ліміті клітинок */
function trimCols_(sh, h) {
  var keep = Math.max(1, h.width, sh.getLastColumn()), max = sh.getMaxColumns();
  if (max > keep) sh.deleteColumns(keep + 1, max - keep);
}
function isCellLimit_(e) { return /above the limit of [\d,.\s]+ cells/i.test(errText_(e)); }
function fullError_() {
  return LinesCore.util.AppError('SERVER_ERROR', 'Google-таблиця заповнена (ліміт — 10 млн клітинок), запис неможливий. ' +
    'Керівнику: меню таблиці «' + MENU_TITLE + ' → Архівувати старі чек-листи». Записи планшетів чекають у черзі.');
}
/* клітинок у сітці всіх аркушів (разом із порожніми) — саме їх рахує ліміт Google */
function gridCells_(ss) {
  var n = 0;
  ss.getSheets().forEach(function (sh) { n += sh.getMaxRows() * sh.getMaxColumns(); });
  return n;
}
function capacityNote_(cells) {
  if (cells < CELL_WARN) return '';
  return 'Google-таблиця заповнена на ' + Math.floor(cells / CELL_LIMIT * 100) + '% (' + fmtInt_(cells) + ' з ' + fmtInt_(CELL_LIMIT) +
    ' клітинок). Після досягнення ліміту записи з планшетів перестануть зберігатися. Перенесіть давні чек-листи ' +
    'в архів: меню таблиці «' + MENU_TITLE + ' → Архівувати старі чек-листи».';
}
function fmtInt_(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

/* =====================================================================
   Задачі за розкладом і пункти меню
   ===================================================================== */

/* виконати fn(store, app) під блокуванням */
function withApp_(fn) {
  var store = new SheetStore();
  var app = LinesCore.createApp(store, gasEnv_());
  return store.lock(function () { return fn(store, app); });
}
/* задача тригера: LOCKED — у журнал (щоденну задачу надолужить щогодинна), інші помилки — далі (лист від Google) */
function runJob_(name, fn) {
  try {
    var r = withApp_(fn);
    console.log(name + ': ' + JSON.stringify(LinesCore.wire(r)));
    return r;
  } catch (e) {
    var er = LinesCore.util.errorResponse(e);
    console.error(name + ': ' + er.message);
    if (er.error === 'LOCKED') return er;
    throw e;
  }
}

/* щодня о digest_hour: звіт керівництву + оновлення аркуша «План ППР» */
function dailyJob() {
  return runJob_('dailyJob', function (store, app) { return dailyWork_(store, app, new Date()); });
}
/* тіло щоденної задачі; успіх позначається днем у LAST_DAILY (ключ 'digest:<день>' не дасть другого листа) */
function dailyWork_(store, app, now) {
  var S = app.settings(), res = { ok: true, digest: 'none', plan: 0 };
  var d = app.buildDigest(now);
  var cells = gridCells_(store.ss), note = capacityNote_(cells);
  res.has_content = d.has_content;
  res.cells = cells;
  if (note) { res.warning = note; console.warn(note); }
  if (d.has_content || S.digest_mode === 'always' || note) {
    var r = deliver_(store, app, [{ key: 'digest:' + app.timeKit().key(now), kind: 'digest', to: d.to, subject: d.subject,
      html: note ? noteHtml_(d.html, note) : d.html, text: note ? 'УВАГА. ' + note + '\n\n' + d.text : d.text }])[0];
    res.digest = r.status;
    res.to = r.to;
    if (r.error) res.error = r.error;
  }
  res.plan = app.refreshPlan().count;
  PropertiesService.getScriptProperties().setProperty('LAST_DAILY', app.timeKit().key(now));
  return res;
}
function digestHour_(S) { return Math.max(0, Math.min(23, Math.round(+S.digest_hour || 0))); }
/* сьогоднішній щоденний запуск пропущено (LOCKED, збій Sheets, тригер видалено чи створено вже після
   години звіту — напр. у день setup): година звіту настала, а LAST_DAILY — не сьогодні. Лише за
   сьогодні: звіт будується на «зараз» і має ключ 'digest:<сьогодні>' — надолуження вночі за вчора
   надіслало б сьогоднішній звіт завчасно й «з'їло» вчасний. Дублікат листа не дасть той самий ключ. */
function dailyMissed_(app, now) {
  var K = app.timeKit();
  if (K.parts(now).H < digestHour_(app.settings())) return false;
  return (PropertiesService.getScriptProperties().getProperty('LAST_DAILY') || '') < K.key(now);
}
/* попередження на початку листа (після <body>) */
function noteHtml_(html, note) {
  var box = '<div style="max-width:720px;margin:16px auto 0;padding:10px 14px;border:1px solid #d9a441;border-radius:8px;' +
    'background:#fff4dc;color:#5a3b00;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;"><b>Увага.</b> ' +
    escHtml_(note) + '</div>';
  var m = /<body[^>]*>/i.exec(html || '');
  return m ? html.slice(0, m.index + m[0].length) + box + html.slice(m.index + m[0].length) : box + (html || '');
}

/* щогодини: сповіщення про роботи, строк яких настав (кожен ключ — один раз); пропущений щоденний звіт */
function hourlyJob() {
  return runJob_('hourlyJob', function (store, app) {
    var r = dueCheck_(store, app), now = new Date();
    try { syncTriggers_(app.settings(), false); } catch (e) { console.warn('Тригер звіту: ' + errText_(e)); }
    if (dailyMissed_(app, now)) {
      // збій звіту не зриває сповіщень про строки (вони вже надіслані); наступна година спробує знову
      try { r.daily = dailyWork_(store, app, now); } catch (e) { r.daily = { ok: false, error: errText_(e) }; console.error('Надолуження звіту: ' + errText_(e)); }
    }
    return r;
  });
}
function dueCheck_(store, app) {
  var idx = noticeIndex_(store);
  var alerts = app.dueAlerts(new Date(), idx.sent);
  var out = alerts.length ? deliver_(store, app, alerts) : [];
  var due = app.dueAll().filter(function (d) { return d.status === 'due'; }).length;
  return { ok: true, due: due, alerts: alerts.length,
    sent: out.filter(function (x) { return x.status === 'sent'; }).length,
    failed: out.filter(function (x) { return x.status === 'error'; }).length,
    errors: out.filter(function (x) { return x.error; }).map(function (x) { return x.error; }) };
}

/* меню: Початкове налаштування */
function setup() {
  return menu_('Початкове налаштування', function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var store = new SheetStore(ss);
    var app = LinesCore.createApp(store, gasEnv_());
    return store.lock(function () {
      var created = store.ensureSchema(true);
      // налаштування: відсутні ключі з типовими значеннями; порожній опис — доповнюємо
      var have = {};
      store.all('settings').forEach(function (r) { var n = LinesCore.norm('settings', r); if (n.key && !have[n.key]) have[n.key] = n; });
      var add = app.settingsRows().filter(function (r) { return !have[r.key]; });
      var upd = [], url = ss.getUrl();
      LinesCore.SETTINGS_META.forEach(function (m) {
        if (!have[m.key]) return;
        var p = { key: m.key }, ch = false;
        if (!have[m.key].note) { p.note = m.note; ch = true; }
        if (m.key === 'sheet_url' && have[m.key].value !== url) { p.value = url; ch = true; }
        if (ch) upd.push(p);
      });
      if (!have.sheet_url) {
        var meta = LinesCore.SETTINGS_META.filter(function (m) { return m.key === 'sheet_url'; })[0];
        add.push({ key: 'sheet_url', value: url, note: meta ? meta.note : '' });
      }
      store.insert('settings', add);
      store.update('settings', upd);
      var S = app.settings();
      var tzNote = '';
      // пояс таблиці = пояс заводу; уже записані дати зберігають свій момент часу
      try { retimeZone_(store, S.tz); } catch (e) { tzNote = errText_(e); }
      var scriptTz = Session.getScriptTimeZone();
      // секрети — лише якщо їх ще немає
      var props = PropertiesService.getScriptProperties(), gen = [];
      if (!props.getProperty('API_TOKEN')) { props.setProperty('API_TOKEN', newToken_()); gen.push('токен доступу'); }
      if (!props.getProperty('ADMIN_PIN')) { props.setProperty('ADMIN_PIN', newPin_()); gen.push('PIN керівника'); }
      var trig = syncTriggers_(S, true);
      var removed = dropDefaultSheet_(ss, store);
      var cells = gridCells_(ss), full = capacityNote_(cells);
      var steps = [];
      if (!apiUrl_(props)) {
        steps.push('Розгорнути → Нове розгортання → тип «Веб-застосунок» (виконувати від імені: «Я»; доступ: «Будь-хто») → ' +
          'скопіюйте URL, що закінчується на /exec, і вставте його в меню «' + MENU_TITLE + ' → Вказати адресу веб-застосунку (/exec)».');
      }
      if (!digestTo_(store, S).length) {
        steps.push('Аркуш «' + LinesCore.SCHEMA.settings.sheet + '» → параметр «manager_emails»: адреси керівників через кому ' +
          '(або «Email» працівника з посадою «' + LinesCore.LABELS.role.manager + '» на аркуші «' + LinesCore.SCHEMA.staff.sheet + '»). ' +
          'Без них листи-нагадування не надсилаються керівництву. Перевірка — «' + MENU_TITLE + ' → Надіслати звіт зараз».');
      }
      steps.push('«' + MENU_TITLE + ' → Показати токен і PIN» — адреса й токен для планшетів.');
      var msg = 'Готово. ' + (created.length ? 'Створено аркуші: ' + created.join(', ') + '.' : 'Усі аркуші вже були.') +
        '\nНалаштувань додано: ' + add.length + '.' +
        (gen.length ? '\nЗгенеровано: ' + gen.join(' і ') + '.' : '') +
        '\nТригери: щоденний звіт о ' + S.digest_hour + ':00 (' + S.tz + '), щогодинна перевірка строків ТО.' +
        (scriptTz && scriptTz !== S.tz ? '\nУвага: пояс скрипту (' + scriptTz + ') відрізняється від поясу заводу (' + S.tz +
          '). Змініть timeZone в appsscript.json.' : '') +
        (tzNote ? '\nПояс таблиці не змінено: ' + tzNote : '') +
        (full ? '\nУвага: ' + full : '') +
        '\n\nДалі:\n' + steps.map(function (s, i) { return (i + 1) + '. ' + s; }).join('\n');
      return { ok: true, message: msg, created: created, settings_added: add.length, generated: gen,
        triggers: trig, tz: S.tz, removed_sheet: removed, cells: cells };
    });
  });
}

/* меню: Заповнити демо-даними (лише в порожню таблицю) */
function seedDemoData() {
  return menu_('Демо-дані', function () {
    var store = new SheetStore(), env = gasEnv_();
    return store.lock(function () {
      if (store.all('lines').length) {
        return { ok: false, message: 'На аркуші «' + LinesCore.SCHEMA.lines.sheet + '» уже є дані. ' +
          'Демо-дані можна додати лише в порожню таблицю.' };
      }
      store.ensureSchema(false);
      var r = LinesCore.seedDemo(store, env, { now: new Date() });
      var app = LinesCore.createApp(store, env);
      var plan = app.refreshPlan().count;
      var c = r.counts || {};
      return { ok: true, counts: c, plan: plan, message: 'Демо-дані додано: ліній — ' + (c.lines || 0) + ', агрегатів — ' +
        (c.units || 0) + ', подій — ' + (c.events || 0) + ', чек-листів — ' + (c.checks || 0) + ', робіт — ' + (c.works || 0) +
        '. Рядків у «Плані ППР»: ' + plan + '.' };
    });
  });
}

/* меню: Надіслати звіт зараз (незалежно від digest_mode) */
function sendDigestNow() {
  return menu_('Щоденний звіт', function () {
    return withApp_(function (store, app) {
      var now = new Date(), d = app.buildDigest(now);
      if (!d.to.length) return { ok: false, message: 'Не задано отримувачів: заповніть ' + mailWhere_() + '.' };
      var r = deliver_(store, app, [{ key: 'digest:manual:' + now.getTime(), kind: 'digest', to: d.to,
        subject: d.subject, html: d.html, text: d.text }], { force: true })[0];
      return r.status === 'sent' ? { ok: true, to: r.to, message: 'Звіт надіслано: ' + r.to.join(', ') + '.' }
        : { ok: false, message: 'Звіт не надіслано. ' + r.error };
    });
  });
}

/* меню: Перевірити строки ТО зараз */
function checkDueNow() {
  return menu_('Строки ТО', function () {
    return withApp_(function (store, app) {
      var r = dueCheck_(store, app);
      r.message = 'Прострочених робіт: ' + r.due + '. Нових сповіщень надіслано: ' + r.sent + '.' +
        (r.errors.length ? '\nНе надіслано: ' + r.errors[0] : '');
      return r;
    });
  });
}

/* меню: Оновити «План ППР» */
function refreshPlan() {
  return menu_('План ППР', function () {
    return withApp_(function (store, app) {
      var r = app.refreshPlan();
      return { ok: true, count: r.count, message: 'Аркуш «' + LinesCore.SCHEMA.plan.sheet + '» оновлено: ' + r.count + ' рядк.' };
    });
  });
}

/* меню: Перерахувати мотогодини (стан ліній, лічильники, регламенти) */
function recomputeAll() {
  return menu_('Перерахунок', function () {
    return withApp_(function (store, app) {
      var r = app.recomputeAll();
      r.message = 'Перераховано: ліній — ' + r.lines + ', регламентів — ' + r.rules + ', лічильників — ' + r.meters + '.';
      return r;
    });
  });
}

/* меню: Показати токен і PIN. Адреса — лише …/exec: збережена власником (API_URL) або getUrl(), якщо
   він повернув саме …/exec. З меню getUrl() зазвичай дає …/dev (тестова адреса розгортання HEAD: лише
   для редакторів, анонімний планшет отримає сторінку входу Google замість JSON) — її не показуємо. */
function showSecrets() {
  var p = PropertiesService.getScriptProperties();
  var token = p.getProperty('API_TOKEN') || '', pin = p.getProperty('ADMIN_PIN') || '', url = apiUrl_(p), svc = '';
  if (!url) { try { svc = String(ScriptApp.getService().getUrl() || ''); } catch (e) { svc = ''; } }
  var how = 'Розгорнути → Керування розгортаннями → ваш веб-застосунок → скопіюйте URL, що закінчується на /exec, ' +
    'і вставте його в меню «' + MENU_TITLE + ' → Вказати адресу веб-застосунку (/exec)».';
  var addr = url ? url
    : (/\/dev$/.test(svc) ? 'ще не вказано. Увага: адреса, що закінчується на /dev, — тестова, на планшетах вона НЕ працює. '
      : 'ще не вказано (якщо веб-застосунок не розгорнуто: Розгорнути → Нове розгортання → Веб-застосунок, від імені «Я», доступ «Будь-хто»). ') + how;
  var msg = !token ? 'Спершу виконайте «' + MENU_TITLE + ' → Початкове налаштування».'
    : 'Адреса API (URL веб-застосунку, …/exec):\n' + addr +
      '\n\nТокен доступу: ' + token + '\nPIN керівника: ' + pin +
      '\n\nНа планшеті: «Налаштування пристрою» → робота з Google-таблицею → вставте адресу й токен. ' +
      'PIN — для розділу «Керівництво». Не передавайте токен і PIN стороннім.';
  say_('Токен і PIN', msg);
  return { ok: !!token, token: token, pin: pin, url: url, message: msg };
}
/* адреса API для планшетів: збережена власником або getUrl(), якщо це …/exec */
function apiUrl_(props) {
  var u = str_(props.getProperty('API_URL'));
  if (EXEC_URL_RE.test(u)) return u;
  try { u = str_(ScriptApp.getService().getUrl()); } catch (e) { u = ''; }
  return EXEC_URL_RE.test(u) ? u : '';
}

/* меню: Вказати адресу веб-застосунку (/exec) — один раз після розгортання */
function setApiUrl(url) {
  return menu_('Адреса веб-застосунку', function () {
    var ui = uiOrNull_(), given = url;
    if (given === undefined || given === null || typeof given === 'object') {
      if (!ui) return { ok: false, message: 'Запустіть з меню таблиці «' + MENU_TITLE + '».' };
      var r = ui.prompt('Адреса веб-застосунку', 'Вставте URL веб-застосунку, що закінчується на /exec\n' +
        '(Розгорнути → Керування розгортаннями → ваш веб-застосунок → URL):', ui.ButtonSet.OK_CANCEL);
      if (r.getSelectedButton() !== ui.Button.OK) return { ok: false, cancelled: true };
      given = r.getResponseText();
    }
    var u = str_(given).replace(/[?#].*$/, '');
    if (/\/dev$/.test(u)) {
      return { ok: false, message: 'Це тестова адреса (/dev) — вона працює лише для редакторів проєкту. Потрібна адреса, що закінчується на /exec: ' +
        'Розгорнути → Керування розгортаннями.' };
    }
    if (!EXEC_URL_RE.test(u)) {
      return { ok: false, message: 'Це не адреса веб-застосунку Apps Script. Очікується https://script.google.com/macros/s/…/exec' };
    }
    PropertiesService.getScriptProperties().setProperty('API_URL', u);
    return { ok: true, url: u, message: 'Адресу збережено: ' + u + '\nДалі — «' + MENU_TITLE + ' → Показати токен і PIN».' };
  });
}

/* меню: Архівувати старі чек-листи. Чек-листи й відповіді, старші за N місяців, переносяться в нову
   таблицю «… — архів …» на Диску власника й видаляються з робочої (звільняє місце в ліміті 10 млн
   клітинок). Події, роботи й показники не архівуються: з них ядро перераховує мотогодини, лічильники
   й строки ТО. Кроками по ARCHIVE_CHUNK рядків, кожен — під коротким блокуванням: спершу копія,
   потім видалення (збій між ними дає хіба що повтор рядків в архіві, а не втрату). */
function archiveLogs(months) {
  return menu_('Архівування', function () {
    var ui = uiOrNull_(), m = months;
    if (m === undefined || m === null || typeof m === 'object') {
      // без вікна підтвердження (редактор, тригер) — лише з явною кількістю місяців: archiveLogs(12)
      if (!ui) return { ok: false, message: 'Запустіть з меню таблиці «' + MENU_TITLE + ' → Архівувати старі чек-листи».' };
      var r = ui.prompt('Архівувати старі чек-листи', 'Чек-листи й відповіді, старші за вказану кількість місяців (щонайменше ' +
        ARCHIVE_MIN_MONTHS + '), буде перенесено в окрему нову Google-таблицю на вашому Диску й видалено з цієї. ' +
        'Журнали стану, робіт і показників лишаються.\n\nСтарші за скільки місяців? (порожньо — ' + ARCHIVE_MONTHS + ')', ui.ButtonSet.OK_CANCEL);
      if (r.getSelectedButton() !== ui.Button.OK) return { ok: false, cancelled: true };
      m = str_(r.getResponseText()) || ARCHIVE_MONTHS;
    }
    m = Math.floor(Number(m));
    if (!isFinite(m) || m < ARCHIVE_MIN_MONTHS) {
      return { ok: false, message: 'Вкажіть ціле число місяців, не менше ' + ARCHIVE_MIN_MONTHS + '.' };
    }
    return archiveOld_(m);
  });
}
function archiveOld_(months) {
  var t0 = Date.now(), env = gasEnv_(), ss = SpreadsheetApp.getActiveSpreadsheet();
  var app0 = LinesCore.createApp(new SheetStore(ss), env), K = app0.timeKit(), tz = app0.settings().tz;
  var cutoff = K.start(monthsBack_(K.key(new Date()), months)), until = K.fmtD(cutoff);
  var dest = null, moved = {}, left = false;
  ARCHIVE_TABLES.forEach(function (t) {
    moved[t] = 0;
    while (!left) {
      if (Date.now() - t0 > ARCHIVE_BUDGET_MS) { left = true; break; }
      var store = new SheetStore(ss);
      var n = store.lock(function () {
        var sh = store.sheet_(t);
        if (!sh) return 0;
        var h = store.head_(t), tc = h.map.ts, last = store.lastRow_(t, sh);
        if (!tc || last < 2) return 0;
        // лише суцільний початок журналу, старший за межу (журнал дописується в кінець майже за часом)
        var n0 = Math.min(ARCHIVE_CHUNK, last - 1), ts = sh.getRange(2, tc, n0, 1).getValues(), k = 0;
        while (k < n0 && isDate_(ts[k][0]) && ts[k][0].getTime() < cutoff.getTime()) k++;
        if (!k) return 0;
        var w = sh.getLastColumn(), rng = sh.getRange(2, 1, k, w);
        var head = sh.getRange(1, 1, 1, w).getValues()[0], vals = rng.getValues();
        if (!dest) {
          dest = SpreadsheetApp.create(MAIL_NAME + ' — архів чек-листів до ' + until);
          try { dest.setSpreadsheetTimeZone(tz); } catch (e) { /* пояс за замовчуванням */ }
        }
        archiveAppend_(dest, sh.getName(), head, vals);
        SpreadsheetApp.flush();
        if (k + 1 < sh.getMaxRows()) sh.deleteRows(2, k);
        else {
          // під заголовком не лишилося б жодного рядка (нові успадкували б його оформлення) —
          // останній рядок лише очищаємо: формат дат і списки лишаються, прапорці — прибираємо
          if (k > 1) sh.deleteRows(2, k - 1);
          sh.getRange(2, 1, 1, sh.getMaxColumns()).clearContent();
          h.known.forEach(function (kc) {
            if (kc.c.base === 'bool' && !kc.c.nullable) sh.getRange(2, kc.col).clearDataValidations().clearContent();
          });
        }
        store.forget_(t);
        return k;
      });
      if (!n) break;
      moved[t] += n;
    }
  });
  if (dest) archiveFinish_(dest);
  var total = 0;
  for (var t in moved) if (has_(moved, t)) total += moved[t];
  var cells = gridCells_(ss);
  var msg = !total ? 'Немає чек-листів, старших за ' + until + '. Зайнято клітинок: ' + fmtInt_(cells) + ' з ' + fmtInt_(CELL_LIMIT) + '.'
    : 'Перенесено в архів (записи до ' + until + '): чек-листів — ' + moved.checks + ', відповідей — ' + moved.answers + '.' +
      '\nАрхів: «' + dest.getName() + '» — ' + dest.getUrl() +
      '\nЗайнято клітинок: ' + fmtInt_(cells) + ' з ' + fmtInt_(CELL_LIMIT) + '.' +
      (left ? '\nНе все встигнуто за один запуск — запустіть «Архівувати старі чек-листи» ще раз (буде створено ще одну таблицю-архів).' : '');
  return { ok: true, moved: moved, until: until, cells: cells, partial: left, url: dest ? dest.getUrl() : '', message: msg };
}
/* дописати рядки в аркуш таблиці-архіву (створюється з заголовком; сітка — точно під дані) */
function archiveAppend_(dest, name, head, vals) {
  var w = head.length, sh = dest.getSheetByName(name), start;
  if (!sh) {
    sh = dest.insertSheet(name);
    if (sh.getMaxColumns() > w) sh.deleteColumns(w + 1, sh.getMaxColumns() - w);
    else if (sh.getMaxColumns() < w) sh.insertColumnsAfter(sh.getMaxColumns(), w - sh.getMaxColumns());
    sh.getRange(1, 1, 1, w).setValues([head.map(keepCell_)]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  start = Math.max(2, sh.getLastRow() + 1);
  if (sh.getMaxRows() < start + vals.length - 1) sh.insertRowsAfter(sh.getMaxRows(), start + vals.length - 1 - sh.getMaxRows());
  // значення (не формули); текст — буквально, дати — у форматі журналу
  sh.getRange(start, 1, vals.length, w).setValues(vals.map(function (row) { return row.map(keepCell_); }));
  head.forEach(function (x, j) {
    if (vals.some(function (row) { return isDate_(row[j]); })) sh.getRange(start, j + 1, vals.length, 1).setNumberFormat('dd.MM.yyyy HH:mm');
  });
}
/* архів: без порожнього першого аркуша і зайвих рядків */
function archiveFinish_(dest) {
  dest.getSheets().forEach(function (sh) {
    if (dest.getSheets().length > 1 && sh.getLastRow() === 0 && sh.getLastColumn() === 0) { dest.deleteSheet(sh); return; }
    var last = Math.max(2, sh.getLastRow() + 1);
    if (sh.getMaxRows() > last) sh.deleteRows(last + 1, sh.getMaxRows() - last);
  });
}
/* 'YYYY-MM-DD' мінус m місяців (день — не більший за останній день місяця) */
function monthsBack_(key, m) {
  var y = +key.slice(0, 4), mo = +key.slice(5, 7) - m, d = +key.slice(8, 10);
  while (mo < 1) { mo += 12; y--; }
  var dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (Math.min(d, dim) < 10 ? '0' : '') + Math.min(d, dim);
}

/* меню в таблиці */
function onOpen(e) {
  try {
    SpreadsheetApp.getUi().createMenu(MENU_TITLE)
      .addItem('Початкове налаштування', 'setup')
      .addItem('Заповнити демо-даними', 'seedDemoData')
      .addSeparator()
      .addItem('Надіслати звіт зараз', 'sendDigestNow')
      .addItem('Перевірити строки ТО зараз', 'checkDueNow')
      .addItem('Оновити «План ППР»', 'refreshPlan')
      .addItem('Перерахувати мотогодини', 'recomputeAll')
      .addItem('Архівувати старі чек-листи', 'archiveLogs')
      .addSeparator()
      .addItem('Вказати адресу веб-застосунку (/exec)', 'setApiUrl')
      .addItem('Показати токен і PIN', 'showSecrets')
      .addToUi();
  } catch (err) {
    console.warn('Меню не створено: ' + errText_(err));
  }
}

/* ------------------------------ допоміжне для задач ------------------------------ */

/* тригери: один щоденний (dailyJob о digest_hour у поясі заводу) і один щогодинний (hourlyJob);
   force — видалити наявні для цих функцій і створити заново */
function syncTriggers_(S, force) {
  var props = PropertiesService.getScriptProperties();
  var hour = digestHour_(S);
  var want = hour + '@' + S.tz, daily = [], hourly = [], changed = [];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'dailyJob') daily.push(t);
    else if (f === 'hourlyJob') hourly.push(t);
  });
  if (force || daily.length !== 1 || props.getProperty('DAILY_TRIGGER') !== want) {
    daily.forEach(function (t) { ScriptApp.deleteTrigger(t); });
    var b = ScriptApp.newTrigger('dailyJob').timeBased().atHour(hour).everyDays(1);
    try { b = b.inTimezone(S.tz); } catch (e) { /* пояс скрипту */ }
    b.create();
    props.setProperty('DAILY_TRIGGER', want);
    changed.push('dailyJob');
  }
  if (force || hourly.length !== 1) {
    hourly.forEach(function (t) { ScriptApp.deleteTrigger(t); });
    ScriptApp.newTrigger('hourlyJob').timeBased().everyHours(1).create();
    changed.push('hourlyJob');
  }
  return { daily_hour: hour, tz: S.tz, changed: changed };
}

/* порожній типовий аркуш нової таблиці («Аркуш1» / «Sheet1») більше не потрібен */
function dropDefaultSheet_(ss, store) {
  var ours = {};
  LinesCore.TABLES.forEach(function (t) { ours[LinesCore.SCHEMA[t].sheet] = 1; });
  var removed = '';
  ss.getSheets().forEach(function (sh) {
    var n = sh.getName();
    if (removed || ours[n] || !/^(Sheet|Аркуш|Лист|Arkusz)\s?\d+$/i.test(n)) return;
    if (sh.getLastRow() === 0 && sh.getLastColumn() === 0 && ss.getSheets().length > 1) { ss.deleteSheet(sh); removed = n; }
  });
  return removed;
}

/* випадкові значення з Utilities.getUuid (крипто-випадкові UUID v4) */
function randomBytes_(n) {
  var out = [];
  while (out.length < n) {
    var hex = Utilities.getUuid().replace(/-/g, '');
    hex = hex.slice(0, 12) + hex.slice(13, 16) + hex.slice(17);      // без версії та варіанта
    for (var i = 0; i + 1 < hex.length && out.length < n; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  }
  return out;
}
function newToken_() {
  var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789', s = '';
  while (s.length < 24) {
    randomBytes_(32).forEach(function (b) { if (s.length < 24 && b < 228) s += abc.charAt(b % 57); });
  }
  return s;
}
function newPin_() {
  var s = '';
  while (s.length < 6) randomBytes_(8).forEach(function (b) { if (s.length < 6 && b < 250) s += String(b % 10); });
  return s;
}

/* пункт меню: результат → повідомлення (без UI — у журнал виконання) */
function menu_(title, fn) {
  var r;
  try {
    r = fn();
  } catch (e) {
    var er = LinesCore.util.errorResponse(e);
    r = { ok: false, error: er.error, message: er.error === 'LOCKED' ? er.message : 'Помилка: ' + errText_(e) };
  }
  if (r && r.message) say_(title, r.message);
  return r;
}
function uiOrNull_() {
  try { return SpreadsheetApp.getUi(); } catch (e) { return null; }   // тригер / веб-застосунок: UI немає
}
function say_(title, text) {
  var ui = uiOrNull_();
  if (ui) {
    try { ui.alert(title, text, ui.ButtonSet.OK); return; } catch (e2) { /* далі — у журнал */ }
  }
  console.log(title + ': ' + text);
}

/* ------------------------------ дрібні утиліти ------------------------------ */

function has_(o, k) { return o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k); }
function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]'; }
function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function keyStr_(v) { return isDate_(v) ? '' : str_(v); }
function copy_(o) { var r = {}; for (var k in o) if (has_(o, k)) r[k] = o[k]; return r; }
function headNorm_(s) { return String(s).toLowerCase().replace(/[ʼ’‘`']/g, '\'').replace(/\s+/g, ' ').trim(); }
function errText_(e) { return String((e && e.message) || e); }
function escHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
