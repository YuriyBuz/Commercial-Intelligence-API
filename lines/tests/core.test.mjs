/* Модульні тести ядра lines/assets/core.js (node:test, без залежностей).
 * Запуск: cd lines && node --test tests/core.test.mjs
 * Часовий пояс заводу — Europe/Kyiv: влітку UTC+3, взимку UTC+2
 * (напр. 08:00 за Києвом 15.09.2026 = 05:00Z). */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import LinesCore, { coreSource, loadCore, loadCoreAsGlobalScript } from './load-core.mjs';

const { MemoryStore, createApp, norm, denorm, util, LABELS, SCHEMA, TABLES } = LinesCore;
const HOUR = 3600e3;
const K = (f) => f.app.timeKit();
const DAY = 86400e3;
const ms = (v) => new Date(v).getTime();
const isoOf = (v) => new Date(v).toISOString();

/* ------------------------------------------------------------------ фікстури */

function fixture(nowIso = '2026-09-15T18:00:00Z', extraEnv = {}) {
  const store = new MemoryStore();
  let clock = ms(nowIso);
  let seq = 0;
  const env = { now: () => new Date(clock), uuid: () => 'gen' + (++seq), ...extraEnv };
  const app = createApp(store, env);
  const ADMIN = { admin: true, device: 'Тест' };
  const f = {
    store, app, env,
    setNow(v) { clock = ms(v); },
    get now() { return new Date(clock); },
    call: (action, params = {}, ctx = { device: 'Планшет' }) => app.handle({ action, ...params }, ctx),
    admin: (action, params = {}) => app.handle({ action, ...params }, ADMIN),
    ok(r) { assert.equal(r.ok, true, 'очікувався ok: ' + JSON.stringify(r).slice(0, 500)); return r; },
    save(table, row) { return f.ok(f.admin('save', { table, row })).row; },
    ev(id, ts, state, extra = {}) { return f.ok(f.call('event', { id, ts, line_id: 'L1', state, ...extra })); },
    rows(table) { return store.all(table).map((r) => norm(table, r)); },
    row(table, id) { return f.rows(table).find((r) => r.id === id); },
    setting(values) { return f.ok(f.admin('settings_save', { values })); }
  };
  return f;
}

const START_OK = [
  { item_id: 'I1', value: 'ok' },
  { item_id: 'I2', value: 'ok' },
  { item_id: 'I3', value: '6,2' },
  { item_id: 'I4', value: 'Міцний' }
];

/* типова конфігурація: 2 лінії, агрегати, пункти чек-листів усіх типів, лічильники, персонал */
function config(f, { rules = [], keepU2 = false } = {}) {
  f.save('lines', { id: 'L1', name: 'Лінія 1', kind: 'Фасувальна', sort: 10 });
  f.save('lines', { id: 'L2', name: 'Лінія 2', kind: 'Етикетувальна', sort: 20 });
  f.save('units', { id: 'U1', line_id: 'L1', name: 'Дозатор', hours_offset: 100 });
  f.save('units', { id: 'U2', line_id: 'L1', name: 'Старий агрегат' });
  f.save('items', { id: 'I1', line_id: 'L1', occasions: 'Запуск', section: 'Огляд', text: 'Огородження справні', type: 'check', critical: true });
  f.save('items', { id: 'I2', line_id: 'L1', occasions: ['start'], section: 'Змащування', text: 'Ланцюг змащено', type: 'Відмітка' });
  f.save('items', { id: 'I3', line_id: 'L1', unit_id: 'U1', occasions: 'start', section: 'Параметри', text: 'Тиск повітря, бар', type: 'number', unit_label: 'бар', min: '5,5', max: 7 });
  f.save('items', { id: 'I4', line_id: 'L1', occasions: 'start', section: 'Налаштування', text: 'Шов пакета', type: 'select', options: 'Міцний; !Слабкий' });
  f.save('items', { id: 'I5', line_id: 'L1', occasions: 'start', section: 'Примітки', text: 'Примітка', type: 'text', required: false });
  f.save('items', { id: 'I6', line_id: 'L1', occasions: 'end', section: 'Миття', text: 'Промито', type: 'check' });
  f.save('items', { id: 'I7', line_id: 'L1', occasions: 'Запуск, Переналаштування', section: 'Параметри', text: 'Маса дози, г', type: 'number', min: 298, max: 306, required: false });
  f.save('items', { id: 'I8', line_id: 'L1', unit_id: 'U2', occasions: 'start', section: 'Огляд', text: 'Пункт старого агрегату', type: 'check' });
  f.save('meters', { id: 'M1', line_id: 'L1', unit_id: 'U1', name: 'Цикли дозатора', unit_label: 'цикл.', mode: 'abs' });
  f.save('meters', { id: 'M2', line_id: 'L1', name: 'Вироблено, шт', unit_label: 'шт', mode: 'Приріст за зміну', ask_on_end: true });
  f.save('staff', { id: 'S1', name: 'Олена', role: 'operator', line_ids: 'L1', pin: '1234', email: 'olena@example.com' });
  f.save('staff', { id: 'S2', name: 'Віктор', role: 'Механік' });
  if (!keepU2) f.ok(f.admin('remove', { table: 'units', id: 'U2' }));
  rules.forEach((r) => f.save('rules', r));
}

/* рекурсивний пошук ключа / Date у відповіді */
function findKey(o, key, path = '') {
  if (!o || typeof o !== 'object') return null;
  for (const k of Object.keys(o)) {
    if (k === key) return path + '.' + k;
    const r = findKey(o[k], key, path + '.' + k);
    if (r) return r;
  }
  return null;
}
function hasDate(o) {
  if (o instanceof Date) return true;
  if (!o || typeof o !== 'object') return false;
  return Object.keys(o).some((k) => hasDate(o[k]));
}

/* ================================================================== */

describe('модуль і середовища виконання', () => {
  test('публічний інтерфейс', () => {
    assert.equal(LinesCore.VERSION, '1.1.0');
    for (const k of ['SCHEMA', 'LABELS', 'DEFAULT_SETTINGS', 'TABLES', 'norm', 'denorm', 'label', 'MemoryStore', 'createApp', 'seedDemo', 'sha256', 'util']) {
      assert.ok(k in LinesCore, k);
    }
    for (const k of ['uuid', 'parseDate', 'dayKey', 'dayStart', 'addDays', 'hoursBetween', 'round']) assert.equal(typeof util[k], 'function', k);
  });

  test('виконується як глобальний скрипт Apps Script (один var LinesCore, без module)', () => {
    const ctx = loadCoreAsGlobalScript();
    assert.equal(typeof ctx.LinesCore, 'object');
    assert.equal(ctx.LinesCore.VERSION, '1.1.0');
    const names = Object.keys(ctx).filter((k) => k !== 'LinesCore');
    assert.deepEqual(names, [], 'ядро не повинно створювати інших глобальних імен');
    const app = ctx.LinesCore.createApp(new ctx.LinesCore.MemoryStore(), {});
    const r = app.handle({ action: 'ping' }, {});
    assert.equal(r.ok, true);
    assert.equal(typeof r.now, 'string');
  });

  test('env-перевизначення dayKey/dayStart (як Utilities у GAS) використовуються', () => {
    const ctx = loadCoreAsGlobalScript();
    const C = ctx.LinesCore;
    let used = 0;
    const OFF = 3 * HOUR; // фіксований UTC+3
    const env = {
      now: () => new Date('2026-09-15T12:00:00Z'),
      dayKey: (d) => { used++; return new Date(d.getTime() + OFF).toISOString().slice(0, 10); },
      dayStart: (k) => { used++; return new Date(Date.parse(k + 'T00:00:00Z') - OFF); }
    };
    const app = C.createApp(new C.MemoryStore(), env);
    const b = app.handle({ action: 'dashboard', days: 3 }, {});
    assert.equal(b.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(b.days)), ['2026-09-13', '2026-09-14', '2026-09-15']);
    assert.ok(used > 0);
  });

  test('синтаксис ES2019: без ?. ?? import/export, lookbehind і верхньорівневих const/let', () => {
    const src = coreSource();
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
    assert.ok(!/\?\.[A-Za-z_$[(]/.test(code), 'optional chaining');
    assert.ok(!/\?\?/.test(code), 'nullish coalescing');
    assert.ok(!/^\s*(import|export)\s/m.test(code), 'import/export');
    assert.ok(!/\(\?<[=!]/.test(code), 'regex lookbehind');
    assert.ok(!/^(const|let|class)\s/m.test(code), 'top-level const/let/class');
    assert.match(src, /^var LinesCore = \(function \(\) \{/m);
    assert.match(src, /if \(typeof module === 'object' && module && module\.exports\) module\.exports = LinesCore;\s*$/);
  });

  test('loadCore() повертає незалежні екземпляри', () => {
    const a = loadCore();
    assert.notEqual(a, LinesCore);
    assert.equal(a.VERSION, LinesCore.VERSION);
  });
});

describe('схема та мітки', () => {
  test('кожна таблиця має схему з унікальними ключами й заголовками; enum-набори існують', () => {
    for (const t of TABLES) {
      const s = SCHEMA[t];
      assert.ok(s, t);
      assert.ok(['config', 'log', 'system'].includes(s.kind));
      const keys = s.cols.map((c) => c.k), heads = s.cols.map((c) => c.t);
      assert.equal(new Set(keys).size, keys.length, t + ': ключі');
      assert.equal(new Set(heads).size, heads.length, t + ': заголовки');
      if (s.pk) assert.ok(keys.includes(s.pk), t + ': pk');
      for (const c of s.cols) {
        if (c.set) assert.ok(LABELS[c.set], `${t}.${c.k}: набір ${c.set}`);
        assert.ok(['id', 'str', 'num', 'bool', 'date', 'enum', 'enums', 'list', 'ids'].includes(c.base), c.type);
      }
    }
    assert.equal(SCHEMA.settings.pk, 'key');
    assert.equal(SCHEMA.plan.pk, null);
    for (const t of ['events', 'checks', 'works', 'readings']) {
      for (const k of ['device', 'created', 'void', 'void_note', 'ts']) assert.ok(SCHEMA[t].cols.some((c) => c.k === k), t + '.' + k);
    }
  });

  test('мітки з ТЗ', () => {
    assert.equal(LABELS.state.maint, 'ТО / ППР');
    assert.equal(LABELS.work_type.to, 'ТО');
    assert.equal(LABELS.flag.no_checklist, 'Запуск без чек-листа');
    assert.equal(LABELS.due_status.due, 'Потрібно виконати');
    assert.equal(LinesCore.label('state', 'run'), 'Працює');
    assert.equal(LinesCore.label('occasion', ['start', 'end']), 'Запуск, Завершення');
    assert.equal(LinesCore.label('state', 'нема'), 'нема');
    assert.equal(LinesCore.label('state', null), '');
  });

  test('DEFAULT_SETTINGS', () => {
    const D = LinesCore.DEFAULT_SETTINGS;
    assert.equal(D.company, 'Foodline Production');
    assert.equal(D.tz, 'Europe/Kyiv');
    assert.equal(D.digest_hour, 7);
    assert.equal(D.digest_mode, 'if_any');
    assert.equal(D.instant_due, true);
    assert.equal(D.warn_pct, 90);
    assert.equal(D.checklist_valid_hours, 12);
    assert.equal(D.avg_window_days, 28);
    assert.deepEqual(D.stop_reasons, ['Немає сировини / тари', 'Очікування', 'Перерва', 'Мікрозупинка / застрягання', 'Налагодження', 'Інше']);
    assert.deepEqual(D.manager_emails, []);
    assert.deepEqual(D.products, []);
  });
});

describe('norm / denorm', () => {
  test('str / id', () => {
    const r = norm('lines', { id: 12, name: '  Лінія  ', kind: null, area: undefined });
    assert.equal(r.id, '12');
    assert.equal(r.name, 'Лінія');
    assert.equal(r.kind, '');
    assert.equal(r.area, '');
  });

  test('num: кома, пробіли, нечислові', () => {
    const n = (v) => norm('units', { hours_offset: v }).hours_offset;
    assert.equal(n('5,5'), 5.5);
    assert.equal(n(' 1 000 '), 1000);
    assert.equal(n('1\u00a0250,75'), 1250.75);
    assert.equal(n(7), 7);
    assert.equal(n('-3'), -3);
    assert.equal(n('−2,5'), -2.5);
    assert.equal(n(''), null);
    assert.equal(n(null), null);
    assert.equal(n('abc'), null);
    assert.equal(n('5.5kg'), null);
    assert.equal(n(true), null);
    assert.equal(n(NaN), null);
  });

  test('bool: усі «істинні» варіанти й типове значення', () => {
    const b = (v) => norm('items', { critical: v }).critical;
    for (const v of [true, 'TRUE', 'true', 'так', 'Так', 'ТАК', '1', 1, 'x', 'X', '✓', 'yes', ' так ']) assert.equal(b(v), true, String(v));
    for (const v of [false, 'FALSE', 'ні', '0', 0, '', null, undefined, 'maybe', 2]) assert.equal(b(v), false, String(v));
    // active / required мають типове true для порожніх клітинок, але явне false лишається false
    assert.equal(norm('lines', {}).active, true);
    assert.equal(norm('lines', { active: '' }).active, true);
    assert.equal(norm('lines', { active: false }).active, false);
    assert.equal(norm('items', {}).required, true);
    // answers.ok — трьохзначний
    assert.equal(norm('answers', { ok: '' }).ok, null);
    assert.equal(norm('answers', { ok: false }).ok, false);
    assert.equal(norm('answers', { ok: 'TRUE' }).ok, true);
  });

  test('date: Date, ISO, DD.MM.YYYY [HH:mm[:ss]] у поясі заводу, невалідні', () => {
    const d = (v) => norm('events', { ts: v }).ts;
    const src = new Date('2026-09-15T05:00:00Z');
    const same = d(src);
    assert.ok(same instanceof Date);
    assert.equal(same.getTime(), src.getTime());
    assert.equal(isoOf(d('2026-09-15T05:00:00.000Z')), '2026-09-15T05:00:00.000Z');
    assert.equal(isoOf(d('2026-09-15T08:00:00+03:00')), '2026-09-15T05:00:00.000Z');
    assert.equal(isoOf(d('25.09.2026')), '2026-09-24T21:00:00.000Z');          // північ за Києвом (UTC+3)
    assert.equal(isoOf(d('25.09.2026 07:30')), '2026-09-25T04:30:00.000Z');
    assert.equal(isoOf(d('5.9.2026 7:05:09')), '2026-09-05T04:05:09.000Z');
    assert.equal(isoOf(d('15.01.2026 08:00')), '2026-01-15T06:00:00.000Z');     // зима UTC+2
    assert.equal(isoOf(d('2026-01-15 08:00')), '2026-01-15T06:00:00.000Z');     // без зони → пояс заводу
    assert.equal(isoOf(d('2026-01-15')), '2026-01-14T22:00:00.000Z');
    // день переходу на зимовий час: 25.10.2026 04:00 EEST → 03:00 EET
    assert.equal(isoOf(d('25.10.2026 02:00')), '2026-10-24T23:00:00.000Z');
    assert.equal(isoOf(d('25.10.2026 05:00')), '2026-10-25T03:00:00.000Z');
    assert.equal(d(''), null);
    assert.equal(d(null), null);
    assert.equal(d('сміття'), null);
    assert.equal(d('31.02.2026'), null);
    assert.equal(d('12.13.2026'), null);
    assert.equal(d(new Date('x')), null);
  });

  test('enum: код або українська мітка (регістр, пробіли), невідоме → ""', () => {
    const s = (v) => norm('events', { state: v }).state;
    assert.equal(s('run'), 'run');
    assert.equal(s('Працює'), 'run');
    assert.equal(s('  працює '), 'run');
    assert.equal(s('ПРОСТІЙ'), 'stop');
    assert.equal(s('ТО / ППР'), 'maint');
    assert.equal(s('то/ппр'), 'maint');
    assert.equal(s('Невідомо'), '');
    assert.equal(s(''), '');
    assert.equal(norm('works', { work_type: 'Миття / санобробка' }).work_type, 'clean');
    assert.equal(norm('works', { work_type: 'ТО' }).work_type, 'to');
    assert.equal(norm('staff', { role: 'Наладчик' }).role, 'setter');
    assert.equal(norm('staff', {}).role, 'operator');
    assert.equal(norm('items', {}).type, 'check');
    assert.equal(norm('works', {}).status, 'done');
  });

  test('enums / list / ids', () => {
    assert.deepEqual(norm('items', { occasions: 'Запуск, Переналаштування' }).occasions, ['start', 'changeover']);
    assert.deepEqual(norm('items', { occasions: 'start;end; зовсім не те' }).occasions, ['start', 'end']);
    assert.deepEqual(norm('items', { occasions: ['end', 'Завершення'] }).occasions, ['end']);
    assert.deepEqual(norm('items', { occasions: '' }).occasions, []);
    assert.deepEqual(norm('items', { options: 'Міцний; !Слабкий;; Інше ' }).options, ['Міцний', '!Слабкий', 'Інше']);
    assert.deepEqual(norm('items', { options: ['a', ' ', 'b'] }).options, ['a', 'b']);
    assert.deepEqual(norm('staff', { line_ids: 'L1, L2;L3  L4, L1' }).line_ids, ['L1', 'L2', 'L3', 'L4']);
    assert.deepEqual(norm('staff', { line_ids: '' }).line_ids, []);
  });

  test('рядок за заголовками аркуша (порядок стовпців не важливий)', () => {
    const r = norm('lines', { 'Назва': 'Лінія Х', 'ID': 'LX', 'Активна': 'ні', 'Поточний стан': 'Працює', 'Зайвий стовпець': 1 });
    assert.equal(r.id, 'LX');
    assert.equal(r.name, 'Лінія Х');
    assert.equal(r.active, false);
    assert.equal(r.cur_state, 'run');
    assert.ok(!('Зайвий стовпець' in r));
  });

  test('denorm: мітки, списки, дати, null → "", лише присутні ключі', () => {
    const d = new Date('2026-09-15T05:00:00Z');
    const row = denorm('items', { id: 'I1', occasions: ['start', 'end'], type: 'number', options: ['a', '!b'], min: null, max: 7, required: true, critical: false });
    assert.deepEqual(row, { id: 'I1', occasions: 'Запуск, Завершення', type: 'Число', options: 'a; !b', min: '', max: 7, required: true, critical: false });
    const ev = denorm('events', { ts: d, state: 'maint', flag: '', prev_state: 'off', cum_h: 1.5 });
    assert.ok(ev.ts instanceof Date);
    assert.equal(ev.ts.getTime(), d.getTime());
    assert.equal(ev.state, 'ТО / ППР');
    assert.equal(ev.flag, '');
    assert.equal(ev.prev_state, 'Не працює');
    assert.equal(denorm('staff', { line_ids: ['L1', 'L2'] }).line_ids, 'L1, L2');
    assert.equal(denorm('answers', { ok: null }).ok, '');
    assert.equal(denorm('answers', { ok: false }).ok, false);
    assert.equal(denorm('events', { ts: null }).ts, '');
    assert.equal(denorm('events', { ts: '2026-09-15T05:00:00Z' }).ts.getTime(), d.getTime());
  });

  test('norm(denorm(x)) — тотожність для кожної таблиці', () => {
    const d = new Date('2026-09-15T05:00:00Z');
    const samples = {
      lines: { id: 'L1', name: 'Лінія', kind: 'Фасувальна', active: true, created: d, cur_state: 'repair', cur_cum_h: 12.5, cur_starts: 3 },
      items: { id: 'I1', line_id: 'L1', occasions: ['start', 'changeover'], text: 'Тиск', type: 'select', options: ['Так', '!Ні'], required: false, critical: true },
      staff: { id: 'S1', name: 'Олена', role: 'qa', line_ids: ['L1', 'L2'], pin: '0123', active: false },
      events: { id: 'E1', ts: d, line_id: 'L1', state: 'clean', prev_state: 'run', cum_h: 1.25, starts: 2, flag: 'no_end_checklist', void: true },
      answers: { id: 'A1', ok: null, type: 'number', num_value: 5.5 },
      rules: { id: 'R1', work_type: 'replace', interval_days: 30, base_date: d, last_date: null }
    };
    for (const [t, obj] of Object.entries(samples)) {
      const full = norm(t, obj);
      assert.deepEqual(norm(t, denorm(t, full)), full, t);
    }
  });

  test('невідома таблиця → помилка', () => {
    assert.throws(() => norm('nope', {}), /Невідома таблиця/);
    assert.throws(() => denorm('nope', {}), /Невідома таблиця/);
  });
});

describe('утиліти', () => {
  test('sha256: еталонні вектори та UTF-8', () => {
    assert.equal(LinesCore.sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(LinesCore.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const long = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
    assert.equal(LinesCore.sha256(long), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    for (const s of ['S1:1111', 'Привіт, лінія №1 — «кетчуп» 😀', 'x'.repeat(1000)]) {
      assert.equal(LinesCore.sha256(s), createHash('sha256').update(s, 'utf8').digest('hex'), s.slice(0, 20));
    }
    assert.equal(LinesCore.pinHash('S1', '1111'), LinesCore.sha256('S1:1111'));
    assert.equal(LinesCore.pinHash('S1', ''), null);
  });

  test('uuid: 12 символів base36, унікальні', () => {
    const ids = new Set();
    for (let i = 0; i < 2000; i++) {
      const id = util.uuid();
      assert.match(id, /^[0-9a-z]{12}$/);
      ids.add(id);
    }
    assert.equal(ids.size, 2000);
  });

  test('dayKey / dayStart (Europe/Kyiv) з переходами на літній/зимовий час', () => {
    const tz = 'Europe/Kyiv';
    assert.equal(util.dayKey(new Date('2026-09-14T21:30:00Z'), tz), '2026-09-15');
    assert.equal(util.dayKey(new Date('2026-09-14T20:59:59Z'), tz), '2026-09-14');
    assert.equal(isoOf(util.dayStart('2026-09-15', tz)), '2026-09-14T21:00:00.000Z');
    assert.equal(isoOf(util.dayStart('2026-01-15', tz)), '2026-01-14T22:00:00.000Z');
    const len = (k) => (ms(util.dayStart(util.keyAdd(k, 1), tz)) - ms(util.dayStart(k, tz))) / HOUR;
    assert.equal(len('2026-10-25'), 25);
    assert.equal(len('2026-03-29'), 23);
    assert.equal(len('2026-09-15'), 24);
    assert.equal(util.keyAdd('2026-12-31', 1), '2027-01-01');
    assert.equal(util.keyAdd('2026-03-01', -1), '2026-02-28');
  });

  test('timeKit: форматування часу, у т. ч. день переходу на зимовий час', () => {
    const kit = util.timeKit(util.defaultEnv(), 'Europe/Kyiv');
    assert.equal(kit.fmtDT(new Date('2026-10-25T00:30:00Z')), '25.10.2026 03:30');
    assert.equal(kit.fmtDT(new Date('2026-10-25T01:30:00Z')), '25.10.2026 03:30');
    assert.equal(kit.fmtDT(new Date('2026-10-25T12:00:00Z')), '25.10.2026 14:00');
    assert.equal(kit.fmtD(new Date('2026-09-14T21:00:00Z')), '15.09.2026');
  });

  test('timeKit: запасний режим без Intl-поясу (лише env.dayKey/dayStart)', () => {
    const OFF = 2 * HOUR;
    const env = {
      dayKey: (d) => new Date(d.getTime() + OFF).toISOString().slice(0, 10),
      dayStart: (k) => new Date(Date.parse(k + 'T00:00:00Z') - OFF)
    };
    const kit = util.timeKit(env, 'Not/AZone');
    assert.equal(kit.fmtDT(new Date('2026-01-10T06:15:00Z')), '10.01.2026 08:15');
    assert.equal(isoOf(kit.local(2026, 1, 10, 8, 15, 0)), '2026-01-10T06:15:00.000Z');
  });

  test('fmtNum, round, hoursBetween, esc, wire', () => {
    assert.equal(util.fmtNum(150000), '150\u00a0000');
    assert.equal(util.fmtNum(5.5, 1), '5,5');
    assert.equal(util.fmtNum(5, 2), '5');
    assert.equal(util.fmtNum(-1234.5, 1), '-1\u00a0234,5');
    assert.equal(util.fmtNum(null), '—');
    assert.equal(util.round(1.23456, 2), 1.23);
    assert.equal(util.round(-0.0001, 2), 0);
    assert.equal(util.hoursBetween('2026-09-15T05:00:00Z', '2026-09-15T07:30:00Z'), 2.5);
    assert.equal(util.esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    const w = util.wire({ a: new Date('2026-09-15T05:00:00Z'), b: [new Date(0), undefined], c: undefined, d: { e: NaN }, f: () => 1 });
    assert.deepEqual(w, { a: '2026-09-15T05:00:00.000Z', b: ['1970-01-01T00:00:00.000Z', null], d: { e: null } });
  });

  test('налаштування: перетворення клітинок', () => {
    assert.equal(util.coerceSetting('digest_hour', '8'), 8);
    assert.equal(util.coerceSetting('digest_hour', '99'), 23);
    assert.equal(util.coerceSetting('digest_hour', 'abc'), 7);
    assert.equal(util.coerceSetting('instant_due', 'ні'), false);
    assert.equal(util.coerceSetting('instant_due', ''), true);
    assert.deepEqual(util.coerceSetting('products', 'А; Б ;'), ['А', 'Б']);
    assert.deepEqual(util.coerceSetting('manager_emails', 'a@x.ua, B@X.UA; нісенітниця'), ['a@x.ua', 'b@x.ua']);
    assert.equal(util.settingCell('stop_reasons', ['А', 'Б']), 'А; Б');
    assert.equal(util.settingCell('instant_due', false), 'ні');
  });
});

describe('MemoryStore', () => {
  test('контракт сховища', () => {
    const s = new MemoryStore();
    assert.deepEqual(Object.keys(s.data).sort(), [...TABLES].sort());
    s.insert('events', [{ id: 'a', ts: new Date('2026-09-10T00:00:00Z') }, { id: 'b', ts: '2026-09-12T00:00:00.000Z' }, { id: 'c', ts: 'не дата' }]);
    assert.deepEqual(s.all('events').map((r) => r.id), ['a', 'b', 'c']);
    assert.deepEqual(s.since('events', new Date('2026-09-11T00:00:00Z')).map((r) => r.id), ['b', 'c']);
    assert.equal(s.update('events', [{ id: 'b', note: 'x' }, { id: 'zzz', note: 'y' }]), 1);
    assert.equal(s.all('events')[1].note, 'x');
    s.insert('settings', [{ key: 'tz', value: 'Europe/Kyiv' }]);
    s.update('settings', [{ key: 'tz', value: 'Europe/Berlin' }]);
    assert.equal(s.all('settings')[0].value, 'Europe/Berlin');
    s.replace('plan', [{ title: 'x' }]);
    assert.equal(s.all('plan').length, 1);
    assert.equal(s.lock(() => 42), 42);
    const copyOut = s.all('events');
    copyOut.push({ id: 'zz' });
    assert.equal(s.all('events').length, 3);
    const restored = new MemoryStore(JSON.parse(JSON.stringify(s)));
    assert.deepEqual(restored.all('events').map((r) => r.id), ['a', 'b', 'c']);
    assert.equal(new MemoryStore({ data: { lines: [{ id: 'L' }] } }).all('lines')[0].id, 'L');
  });

  test('застосунок працює після JSON-серіалізації сховища (дати як рядки)', () => {
    const f = fixture();
    config(f);
    f.ev('e1', '2026-09-15T05:00:00Z', 'run');
    const b1 = f.app.handle({ action: 'bootstrap' }, {});
    const store2 = new MemoryStore(JSON.parse(JSON.stringify(f.store)));
    const app2 = createApp(store2, { now: () => f.now });
    const b2 = app2.handle({ action: 'bootstrap' }, {});
    assert.deepEqual(b2, b1);
  });
});

describe('події стану та мотогодини', () => {
  test('cum_h / starts / prev_state через run → stop → run → off → run', () => {
    // довідники (зокрема агрегат U1) створено до подій дня
    const f = fixture('2026-09-15T04:00:00Z');
    config(f);
    f.setNow('2026-09-15T20:00:00Z');
    const r1 = f.ev('e1', '2026-09-15T05:00:00Z', 'run', { product: 'Кетчуп', operator: 'Олена' });
    assert.equal(r1.event.cum_h, 0);
    assert.equal(r1.event.starts, 1);
    assert.equal(r1.event.prev_state, 'off');
    assert.equal(r1.event.flag, 'no_checklist');
    assert.equal(r1.status.state, 'run');
    f.ev('e2', '2026-09-15T07:00:00Z', 'stop', { reason: 'Перерва' });
    f.ev('e3', '2026-09-15T07:30:00Z', 'run');
    const r4 = f.ev('e4', '2026-09-15T09:00:00Z', 'off');
    assert.equal(r4.event.flag, 'no_end_checklist');
    const r5 = f.ev('e5', '2026-09-15T10:00:00Z', 'run');
    const evs = Object.fromEntries(f.rows('events').map((e) => [e.id, e]));
    assert.deepEqual(['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => evs[id].cum_h), [0, 2, 2, 3.5, 3.5]);
    assert.deepEqual(['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => evs[id].starts), [1, 1, 1, 1, 2]);
    assert.deepEqual(['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => evs[id].prev_state), ['off', 'run', 'stop', 'run', 'off']);
    assert.equal(evs.e2.product, 'Кетчуп', 'продукт успадковується');
    assert.equal(evs.e2.operator, 'Олена', 'оператор успадковується');
    assert.equal(evs.e4.product, '', 'при зупинці лінії продукт не успадковується');
    const line = f.row('lines', 'L1');
    assert.equal(line.cur_state, 'run');
    assert.equal(line.cur_event, 'e5');
    assert.equal(line.cur_cum_h, 3.5);
    assert.equal(line.cur_starts, 2);
    assert.equal(isoOf(line.cur_since), '2026-09-15T10:00:00.000Z');
    // мотогодини на довільний момент
    assert.equal(f.app.lineCumAt('L1', new Date('2026-09-15T12:00:00Z')), 5.5);
    assert.equal(f.app.lineCumAt('L1', new Date('2026-09-15T06:00:00Z')), 1);
    assert.equal(f.app.lineCumAt('L1', new Date('2026-09-15T08:00:00Z')), 2.5);
    assert.equal(f.app.lineCumAt('L1', new Date('2026-09-15T04:00:00Z')), 0);
    assert.equal(r5.status.cum_h, 13.5);
    assert.equal(r5.status.today_h, 13.5);
    assert.equal(r5.status.starts, 2);
    // агрегат: мотогодини = hours_offset + мотогодини лінії після додавання
    const b = f.call('bootstrap');
    assert.equal(b.units.find((u) => u.id === 'U1').hours, 113.5);
  });

  test('подія «із минулого» вставляється в середину та перераховує наступні', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    f.ev('e1', '2026-09-15T05:00:00Z', 'run');
    f.ev('e2', '2026-09-15T09:00:00Z', 'off');
    assert.equal(f.row('events', 'e2').cum_h, 4);
    const late = f.ev('e3', '2026-09-15T07:00:00Z', 'stop', { reason: 'Немає сировини / тари' });
    assert.equal(late.event.cum_h, 2);
    assert.equal(late.event.prev_state, 'run');
    let e2 = f.row('events', 'e2');
    assert.equal(e2.cum_h, 2);
    assert.equal(e2.prev_state, 'stop');
    let line = f.row('lines', 'L1');
    assert.equal(line.cur_event, 'e2');
    assert.equal(line.cur_state, 'off');
    assert.equal(line.cur_cum_h, 2);
    // ще раніше за першу подію — шлях без опорної події (повний перерахунок)
    f.ev('e0', '2026-09-15T04:00:00Z', 'run');
    const evs = Object.fromEntries(f.rows('events').map((e) => [e.id, e]));
    assert.equal(evs.e0.starts, 1);
    assert.equal(evs.e0.flag, 'no_checklist');
    assert.equal(evs.e1.prev_state, 'run');
    assert.equal(evs.e1.starts, 1);
    assert.equal(evs.e1.flag, '', 'e1 більше не запуск — позначка знята');
    assert.equal(evs.e1.cum_h, 1);
    assert.equal(evs.e3.cum_h, 3);
    assert.equal(evs.e2.cum_h, 3);
    line = f.row('lines', 'L1');
    assert.equal(line.cur_cum_h, 3);
    assert.equal(line.cur_starts, 1);
    assert.equal(f.app.lineCumAt('L1', new Date('2026-09-15T06:00:00Z')), 2);
  });

  test('recomputeLine відновлює зіпсовані службові поля', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    f.ev('e1', '2026-09-15T05:00:00Z', 'run');
    f.ev('e2', '2026-09-15T08:00:00Z', 'off');
    f.store.update('events', [{ id: 'e2', cum_h: 999, starts: 7 }]);
    f.store.update('lines', [{ id: 'L1', cur_cum_h: 0, cur_state: 'Ремонт' }]);
    f.app.recomputeLine('L1');
    assert.equal(f.row('events', 'e2').cum_h, 3);
    assert.equal(f.row('events', 'e2').starts, 1);
    assert.equal(f.row('lines', 'L1').cur_cum_h, 3);
    assert.equal(f.row('lines', 'L1').cur_state, 'off');
    f.ok(f.admin('recompute'));
  });

  test('валідація, майбутній час обрізається до now', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    assert.equal(f.call('event', { id: 'x1', line_id: 'NOPE', state: 'run' }).error, 'NOT_FOUND');
    assert.equal(f.call('event', { id: 'x2', line_id: 'L1', state: 'летить' }).error, 'BAD_REQUEST');
    assert.equal(f.call('event', { id: 'x3', line_id: 'L1', state: 'run', ts: 'вчора' }).error, 'BAD_REQUEST');
    assert.equal(f.call('event', { id: 'bad id!', line_id: 'L1', state: 'run' }).error, 'BAD_REQUEST');
    const r = f.ev('x4', '2026-09-16T20:00:00Z', 'Працює');
    assert.equal(r.event.ts, '2026-09-15T20:00:00.000Z');
    assert.equal(r.event.state, 'run');
    const r2 = f.ev('x5', '2026-09-15T20:01:00Z', 'stop');
    assert.equal(r2.event.ts, '2026-09-15T20:01:00.000Z', 'допуск +2 хв');
    const r3 = f.call('event', { line_id: 'L1', state: 'run' });
    assert.equal(r3.event.id, 'gen1', 'id генерується, якщо не передано');
    assert.equal(r3.event.device, 'Планшет');
    assert.equal(r3.event.created, '2026-09-15T20:00:00.000Z');
  });

  test('неактивна лінія все одно приймає події', () => {
    const f = fixture();
    config(f);
    f.ok(f.admin('remove', { table: 'lines', id: 'L2' }));
    f.ok(f.call('event', { id: 'z', line_id: 'L2', state: 'run', ts: '2026-09-15T05:00:00Z' }));
  });

  test('сповіщення про ремонт', () => {
    const f = fixture();
    config(f);
    f.setting({ manager_emails: 'boss@example.com, Chief@Example.com' });
    const r = f.ev('rp1', '2026-09-15T05:00:00Z', 'repair', { reason: 'Обрив плівки <b>' });
    assert.equal(r._notify.length, 1);
    const n = r._notify[0];
    assert.equal(n.key, 'repair:rp1');
    assert.equal(n.kind, 'repair');
    assert.deepEqual(n.to, ['boss@example.com', 'chief@example.com']);
    assert.match(n.subject, /Лінія 1/);
    assert.ok(n.html.includes('Обрив плівки &lt;b&gt;'));
    assert.ok(!n.html.includes('<b>'));
    assert.match(n.text, /Обрив плівки <b>/);
    f.setting({ instant_repair: false });
    assert.equal(f.ev('rp2', '2026-09-15T06:00:00Z', 'repair')._notify, undefined);
  });
});

describe('ідемпотентність', () => {
  test('повтор event / checklist / work / reading з тим самим id не дублює записи', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    const e = { id: 'dup-e', ts: '2026-09-15T05:00:00Z', line_id: 'L1', state: 'run' };
    assert.equal(f.ok(f.call('event', e)).duplicate, undefined);
    const again = f.ok(f.call('event', e));
    assert.equal(again.duplicate, true);
    assert.equal(again.event.id, 'dup-e');
    assert.equal(f.rows('events').length, 1);

    const c = { id: 'dup-c', ts: '2026-09-15T06:00:00Z', line_id: 'L1', occasion: 'end', answers: [{ item_id: 'I6', value: 'ok' }],
      readings: [{ meter_id: 'M2', value: 100 }], then_event: { state: 'off' } };
    f.ok(f.call('checklist', c));
    const c2 = f.ok(f.call('checklist', c));
    assert.equal(c2.duplicate, true);
    assert.equal(f.rows('checks').length, 1);
    assert.equal(f.rows('answers').length, 1);
    assert.equal(f.rows('readings').length, 1, 'показник з чек-листа теж ідемпотентний');
    assert.equal(f.rows('events').length, 2, 'подія з then_event теж ідемпотентна');
    assert.equal(f.row('meters', 'M2').cur_value, 100);

    const w = { id: 'dup-w', ts: '2026-09-15T07:00:00Z', line_id: 'L1', work_type: 'repair', title: 'Ремонт', meter_id: 'M1', meter_value: 500 };
    f.ok(f.call('work', w));
    assert.equal(f.ok(f.call('work', w)).duplicate, true);
    assert.equal(f.rows('works').length, 1);
    assert.equal(f.rows('readings').length, 2);

    const rd = { id: 'dup-r', ts: '2026-09-15T08:00:00Z', meter_id: 'M2', value: 50 };
    f.ok(f.call('reading', rd));
    const rd2 = f.ok(f.call('reading', rd));
    assert.equal(rd2.duplicate, true);
    assert.equal(rd2.meter.value, 150);
    assert.equal(f.row('meters', 'M2').cur_value, 150);
  });

  test('batch: незалежні операції, дублікати всередині пакета, помилка не зупиняє інші', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    const op = { op_id: 1, action: 'event', id: 'b1', ts: '2026-09-15T05:00:00Z', line_id: 'L1', state: 'run' };
    const r = f.ok(f.call('batch', { ops: [
      op,
      { ...op, op_id: 2 },
      { op_id: 3, action: 'event', id: 'b2', line_id: 'NOPE', state: 'run' },
      { op_id: 4, action: 'reading', id: 'b3', ts: '2026-09-15T06:00:00Z', meter_id: 'M2', value: '12,5' },
      { op_id: 5, action: 'save', table: 'lines', row: { name: 'x' } },
      { op_id: 6, action: 'nope' },
      { op_id: 7, action: 'batch', ops: [] },
      null
    ] }));
    const res = r.results;
    assert.equal(res.length, 8);
    assert.deepEqual(res.map((x) => x.ok), [true, true, false, true, false, false, false, false]);
    assert.equal(res[0].duplicate, undefined);
    assert.equal(res[1].duplicate, true);
    assert.equal(res[2].error, 'NOT_FOUND');
    assert.equal(res[3].data.reading.value, 12.5);
    assert.equal(res[4].error, 'ADMIN_REQUIRED');
    assert.equal(res[5].error, 'UNKNOWN_ACTION');
    assert.equal(res[6].error, 'BAD_REQUEST');
    assert.equal(res[7].op_id, null);
    assert.equal(typeof res[0].data.event.ts, 'string');
    assert.equal(f.rows('events').length, 1);
    const tooMany = f.call('batch', { ops: Array.from({ length: 51 }, (_, i) => ({ op_id: i, action: 'ping' })) });
    assert.equal(tooMany.error, 'BAD_REQUEST');
    assert.equal(f.call('batch', { ops: 'x' }).error, 'BAD_REQUEST');
  });
});

describe('чек-лист: оцінювання', () => {
  const submit = (f, id, answers, extra = {}) =>
    f.ok(f.call('checklist', { id, ts: '2026-09-15T05:00:00Z', started: '2026-09-15T04:50:00Z', line_id: 'L1', occasion: 'start',
      operator: 'Олена', staff_id: 'S1', product: 'Кетчуп', answers, ...extra }));

  test('усі пункти в нормі → ok; знімок пункту у відповідях', () => {
    const f = fixture();
    config(f);
    const r = submit(f, 'c1', [...START_OK, { item_id: 'I7', value: '301,5' }, { item_id: 'ZZZ', value: 'ok' }, { item_id: 'I6', value: 'fail' }]);
    assert.equal(r.check.result, 'ok');
    assert.equal(r.check.total, 6, 'I1–I5, I7 (I6 — інша нагода, I8 — неактивний агрегат)');
    assert.deepEqual([r.check.failed, r.check.out_of_range, r.check.missing], [0, 0, 0]);
    assert.equal(r.check.occasion, 'start');
    assert.equal(r.check.started, '2026-09-15T04:50:00.000Z');
    assert.equal(r._notify, undefined);
    const ans = f.ok(f.call('check_detail', { id: 'c1' })).answers;
    assert.deepEqual(ans.map((a) => a.item_id), ['I1', 'I2', 'I3', 'I4', 'I7'], 'невідомі та чужі пункти ігноруються');
    const a3 = ans.find((a) => a.item_id === 'I3');
    assert.equal(a3.num_value, 6.2);
    assert.equal(a3.value, '6,2');
    assert.equal(a3.ok, true);
    assert.equal(a3.min, 5.5);
    assert.equal(a3.max, 7);
    assert.equal(a3.unit_label, 'бар');
    assert.equal(a3.text, 'Тиск повітря, бар');
    assert.equal(a3.section, 'Параметри');
    assert.equal(a3.unit_id, 'U1');
    assert.equal(a3.type, 'number');
    assert.equal(ans[0].value, 'Норма');
    assert.equal(ans.find((a) => a.item_id === 'I4').value, 'Міцний');
  });

  test('пункт неактивного агрегату враховується, лише коли агрегат активний', () => {
    const f = fixture();
    config(f, { keepU2: true });
    const r = submit(f, 'c1', START_OK);
    assert.equal(r.check.total, 7);
    assert.equal(r.check.missing, 1);
    assert.equal(r.check.result, 'fail');
  });

  test('зауваження, поза нормою, «!»-варіант, критичний пункт, пропуск, Н/З, текст', () => {
    const f = fixture();
    config(f);
    const with_ = (patch) => START_OK.map((a) => (patch[a.item_id] !== undefined ? { ...a, value: patch[a.item_id] } : a));
    let r = submit(f, 'r1', with_({ I2: 'fail' }));
    assert.equal(r.check.result, 'remarks');
    assert.equal(r.check.failed, 1);
    r = submit(f, 'r2', with_({ I3: '7,5' }));
    assert.equal(r.check.result, 'remarks');
    assert.equal(r.check.out_of_range, 1);
    r = submit(f, 'r3', with_({ I3: '5.4' }));
    assert.equal(r.check.out_of_range, 1);
    r = submit(f, 'r4', with_({ I4: 'Слабкий' }));
    assert.equal(r.check.result, 'remarks');
    assert.equal(r.check.out_of_range, 1);
    r = submit(f, 'r4b', with_({ I4: '!слабкий' }));
    assert.equal(r.check.out_of_range, 1);
    r = submit(f, 'r5', with_({ I1: 'fail' }));
    assert.equal(r.check.result, 'fail', 'критичний пункт');
    assert.equal(r.check.failed, 1);
    r = submit(f, 'r6', START_OK.filter((a) => a.item_id !== 'I3'));
    assert.equal(r.check.result, 'fail', 'обовʼязковий пункт без відповіді');
    assert.equal(r.check.missing, 1);
    r = submit(f, 'r7', with_({ I3: 'багато' }));
    assert.equal(r.check.missing, 1, 'NaN = без відповіді');
    r = submit(f, 'r8', with_({ I4: 'Щось інше' }));
    assert.equal(r.check.missing, 1, 'варіанту немає в списку');
    // «Н/З» на обовʼязковому пункті — лише з поясненням: тоді відповідь без оцінки
    r = submit(f, 'r9', START_OK.map((a) => (a.item_id === 'I2' ? { ...a, value: 'na', note: 'Змащували вчора, наступне — у пʼятницю' } : a)));
    assert.equal(r.check.result, 'ok', 'Н/З із поясненням — відповідь без оцінки');
    assert.deepEqual([r.check.failed, r.check.na], [0, 1]);
    const na = f.ok(f.call('check_detail', { id: 'r9' })).answers.find((a) => a.item_id === 'I2');
    assert.equal(na.ok, null);
    assert.equal(na.value, 'Н/З');
    // без пояснення — пропущена перевірка: зауваження
    r = submit(f, 'r9b', with_({ I2: 'na' }));
    assert.equal(r.check.result, 'remarks', 'Н/З без пояснення на обовʼязковому пункті');
    assert.deepEqual([r.check.failed, r.check.na], [1, 1]);
    assert.equal(f.ok(f.call('check_detail', { id: 'r9b' })).answers.find((a) => a.item_id === 'I2').ok, false);
    r = submit(f, 'r10', with_({ I2: false, I3: 6 }));
    assert.equal(r.check.result, 'remarks');
    r = submit(f, 'r11', [...START_OK, { item_id: 'I5', value: 'Все добре' }, { item_id: 'I7', value: 320, note: 'перевірено' }]);
    assert.equal(r.check.result, 'remarks', 'необовʼязковий пункт поза нормою теж зауваження');
    const det = f.ok(f.call('check_detail', { id: 'r11' })).answers;
    assert.equal(det.find((a) => a.item_id === 'I5').ok, true);
    assert.equal(det.find((a) => a.item_id === 'I7').note, 'перевірено');
    // відсутні обовʼязкові пункти теж записуються (для історії)
    const miss = f.ok(f.call('check_detail', { id: 'r6' })).answers.find((a) => a.item_id === 'I3');
    assert.equal(miss.value, '');
    assert.equal(miss.ok, null);
  });

  test('помилки валідації', () => {
    const f = fixture();
    config(f);
    assert.equal(f.call('checklist', { id: 'q1', line_id: 'L1', occasion: 'щось' }).error, 'BAD_REQUEST');
    assert.equal(f.call('checklist', { id: 'q2', line_id: 'L9', occasion: 'start' }).error, 'NOT_FOUND');
    assert.equal(f.call('checklist', { id: 'q3', line_id: 'L1', occasion: 'start', then_event: { state: 'летить' } }).error, 'BAD_REQUEST');
    assert.equal(f.rows('checks').length, 0, 'нічого не записано при помилці');
    const r = f.ok(f.call('checklist', { id: 'q4', line_id: 'L1', occasion: 'end', answers: [{ item_id: 'I6', value: 'ok' }],
      readings: [{ meter_id: 'NOPE', value: 1 }, { meter_id: 'M2', value: 'abc' }, { meter_id: 'M2', value: 7 }] }));
    assert.equal(r.readings.length, 1);
    assert.equal(r.readings_skipped.length, 2);
    assert.equal(r.readings[0].id, 'q4-r3');
  });

  test('сповіщення про чек-лист із зауваженнями', () => {
    const f = fixture();
    config(f);
    f.setting({ manager_emails: 'boss@example.com' });
    const r = submit(f, 'n1', START_OK.map((a) => (a.item_id === 'I3' ? { ...a, value: '8', note: 'Редуктор <тиску>' } : a)));
    assert.equal(r._notify.length, 1);
    assert.equal(r._notify[0].key, 'check:n1');
    assert.equal(r._notify[0].kind, 'checklist');
    assert.deepEqual(r._notify[0].to, ['boss@example.com']);
    assert.ok(r._notify[0].html.includes('Редуктор &lt;тиску&gt;'));
    assert.match(r._notify[0].subject, /Із зауваженнями/);
    f.setting({ instant_checklist: false });
    assert.equal(submit(f, 'n2', START_OK.map((a) => (a.item_id === 'I2' ? { ...a, value: 'fail' } : a)))._notify, undefined);
  });
});

describe('чек-лист + подія: позначки', () => {
  test('запуск через чек-лист без позначки; запуск без чек-листа — no_checklist', () => {
    const f = fixture('2026-09-15T06:00:00Z');
    config(f);
    const r = f.ok(f.call('checklist', { id: 'c1', ts: '2026-09-15T05:00:00Z', line_id: 'L1', occasion: 'start', operator: 'Олена',
      staff_id: 'S1', product: 'Кетчуп', answers: START_OK, then_event: { state: 'run' } }));
    assert.equal(r.event.id, 'c1-e');
    assert.equal(r.event.ref_id, 'c1');
    assert.equal(r.event.flag, '');
    assert.equal(r.event.product, 'Кетчуп', 'продукт береться з чек-листа');
    assert.equal(r.event.operator, 'Олена');
    assert.equal(r.status.state, 'run');
    assert.equal(r.status.start_check_valid, true);
    assert.equal(r.status.last_check.id, 'c1');
    f.setNow('2026-09-15T20:00:00Z');
    assert.equal(f.call('bootstrap').status.L1.start_check_valid, false, 'через 15 год чек-лист уже не чинний');
    // завершення без чек-листа
    const off = f.ev('o1', '2026-09-15T09:00:00Z', 'off');
    assert.equal(off.event.flag, 'no_end_checklist');
    // повторний запуск після завершення роботи — новий початок роботи: чек-лист c1 уже «використано»
    assert.equal(f.ev('s2', '2026-09-15T16:00:00Z', 'run').event.flag, 'no_checklist');
    // завершення через чек-лист — без позначки
    const end = f.ok(f.call('checklist', { id: 'c2', ts: '2026-09-15T16:30:00Z', line_id: 'L1', occasion: 'end',
      answers: [{ item_id: 'I6', value: 'ok' }], then_event: { state: 'off' } }));
    assert.equal(end.event.flag, '');
    // через 13 год після чек-листа запуску — чек-лист уже не чинний
    assert.equal(f.ev('s3', '2026-09-15T18:30:00Z', 'run').event.flag, 'no_checklist');
  });

  test('forced: запуск попри зауваження лише коли результат не ok', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    const bad = START_OK.map((a) => (a.item_id === 'I1' ? { ...a, value: 'fail' } : a));
    const r = f.ok(f.call('checklist', { id: 'f1', ts: '2026-09-15T05:00:00Z', line_id: 'L1', occasion: 'start', answers: bad,
      forced: true, comment: 'Під мою відповідальність', then_event: { state: 'run' } }));
    assert.equal(r.check.result, 'fail');
    assert.equal(r.event.flag, 'forced');
    f.ev('o', '2026-09-15T06:00:00Z', 'off', { ref_id: 'x' });
    const r2 = f.ok(f.call('checklist', { id: 'f2', ts: '2026-09-15T07:00:00Z', line_id: 'L1', occasion: 'start', answers: START_OK,
      forced: true, then_event: { state: 'run' } }));
    assert.equal(r2.event.flag, '');
    // відмова від запуску — ремонт
    f.ev('o2', '2026-09-15T08:00:00Z', 'off', { ref_id: 'x' });
    const r3 = f.ok(f.call('checklist', { id: 'f3', ts: '2026-09-15T09:00:00Z', line_id: 'L1', occasion: 'start', answers: bad,
      then_event: { state: 'repair', reason: 'Несправна кнопка «Стоп»' } }));
    assert.equal(r3.event.state, 'repair');
    assert.equal(r3._notify.length, 2, 'зауваження в чек-листі + ремонт');
    assert.deepEqual(r3._notify.map((n) => n.kind).sort(), ['checklist', 'repair']);
  });

  test('налаштування require_start_checklist / require_end_checklist вимикають позначки', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    f.setting({ require_start_checklist: false, require_end_checklist: 'ні' });
    assert.equal(f.ev('a', '2026-09-15T05:00:00Z', 'run').event.flag, '');
    assert.equal(f.ev('b', '2026-09-15T06:00:00Z', 'off').event.flag, '');
  });

  test('показники з чек-листа завершення прив’язуються до події', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    f.ev('a', '2026-09-15T05:00:00Z', 'run');
    const r = f.ok(f.call('checklist', { id: 'end1', ts: '2026-09-15T15:00:00Z', line_id: 'L1', occasion: 'end',
      answers: [{ item_id: 'I6', value: 'ok' }], readings: [{ meter_id: 'M2', value: 12000 }, { meter_id: 'M1', value: 5000, mode: 'abs' }],
      then_event: { state: 'off' } }));
    assert.equal(r.readings.length, 2);
    assert.equal(r.readings[0].event_id, 'end1-e');
    assert.equal(r.readings[0].mode, 'inc');
    assert.equal(f.row('meters', 'M2').cur_value, 12000);
    assert.equal(f.row('meters', 'M1').cur_value, 5000);
  });
});

describe('лічильники', () => {
  test('abs / inc, показник із минулого перераховує поточне значення', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    f.ok(f.call('reading', { id: 'a1', ts: '2026-09-15T05:00:00Z', meter_id: 'M1', value: 1000 }));
    f.ok(f.call('reading', { id: 'a2', ts: '2026-09-15T09:00:00Z', meter_id: 'M1', value: 1500 }));
    f.ok(f.call('reading', { id: 'i1', ts: '2026-09-15T05:00:00Z', meter_id: 'M2', value: 100 }));
    const r = f.ok(f.call('reading', { id: 'i2', ts: '2026-09-15T09:00:00Z', meter_id: 'M2', value: 50 }));
    assert.equal(r.meter.value, 150);
    assert.equal(r.meter.value_ts, '2026-09-15T09:00:00.000Z');
    // показник «із минулого»
    f.ok(f.call('reading', { id: 'i0', ts: '2026-09-15T04:00:00Z', meter_id: 'M2', value: 10 }));
    assert.equal(f.row('meters', 'M2').cur_value, 160);
    f.ok(f.call('reading', { id: 'a0', ts: '2026-09-15T07:00:00Z', meter_id: 'M1', value: 1200 }));
    assert.equal(f.row('meters', 'M1').cur_value, 1500);
    assert.equal(f.app.meterValueAt('M1', new Date('2026-09-15T08:00:00Z')), 1200);
    assert.equal(f.app.meterValueAt('M2', new Date('2026-09-15T06:00:00Z')), 110);
    assert.equal(f.call('reading', { id: 'x', meter_id: 'M1', value: -1 }).error, 'BAD_REQUEST');
    assert.equal(f.call('reading', { id: 'x', meter_id: 'M1', value: 'x' }).error, 'BAD_REQUEST');
    assert.equal(f.call('reading', { id: 'x', meter_id: 'M9', value: 1 }).error, 'NOT_FOUND');
    assert.equal(f.call('reading', { id: 'x', meter_id: 'M1', value: 1, mode: 'щось' }).error, 'BAD_REQUEST');
  });
});

/* лінія працює 05:00Z–10:00Z (5 год) щодня з 5 по 14 вересня; вікно середнього — 10 діб */
function utilisationFixture() {
  const f = fixture('2026-09-01T00:00:00Z');
  config(f);
  f.setting({ avg_window_days: 10, manager_emails: 'boss@example.com' });
  f.ok(f.call('reading', { id: 'm0', ts: '2026-09-01T00:00:00Z', meter_id: 'M1', value: 1000 }));
  f.save('rules', { id: 'RD', line_id: 'L1', title: 'ТО-1', work_type: 'ТО', interval_days: 30 });
  f.save('rules', { id: 'RH', line_id: 'L1', unit_id: 'U1', title: 'Заміна ущільнювачів', work_type: 'replace', interval_hours: 100 });
  f.save('rules', { id: 'RS', line_id: 'L1', title: 'Змащення', work_type: 'lube', interval_hours: 60 });
  f.save('rules', { id: 'RX', line_id: 'L1', title: 'Заміна фільтра', work_type: 'replace', interval_hours: 40, notify: 'mech@example.com; boss@example.com' });
  f.save('rules', { id: 'RM', line_id: 'L1', unit_id: 'U1', title: 'Заміна поршня', work_type: 'replace', meter_id: 'M1', interval_meter: 2000 });
  f.save('rules', { id: 'RN', line_id: 'L2', title: 'Огляд лінії 2', work_type: 'inspect', interval_hours: 50 });
  f.save('rules', { id: 'R0', line_id: 'L1', title: 'Без інтервалу', work_type: 'other' });
  for (let d = 5; d <= 14; d++) {
    const day = `2026-09-${String(d).padStart(2, '0')}`;
    f.setNow(`${day}T10:00:00Z`);
    f.ev('run' + d, `${day}T05:00:00Z`, 'run');
    f.ev('off' + d, `${day}T10:00:00Z`, 'off', { ref_id: 'x' });
  }
  f.ok(f.call('reading', { id: 'm1', ts: '2026-09-06T00:00:00Z', meter_id: 'M1', value: 1200 }));
  f.ok(f.call('reading', { id: 'm2', ts: '2026-09-10T00:00:00Z', meter_id: 'M1', value: 1600 }));
  f.ok(f.call('reading', { id: 'm3', ts: '2026-09-14T00:00:00Z', meter_id: 'M1', value: 2000 }));
  f.setNow('2026-09-15T00:00:00Z');
  return f;
}

describe('строки ТО / ППР (computeDue)', () => {
  test('календарний, за мотогодинами (прогноз), за лічильником; статуси', () => {
    const f = utilisationFixture();
    const due = Object.fromEntries(f.app.dueAll().map((d) => [d.rule_id, d]));
    assert.equal(f.app.bootstrap({}).avg_h.L1, 5);

    const d = due.RD;
    assert.equal(d.status, 'ok');
    assert.equal(d.criteria.length, 1);
    assert.equal(d.criteria[0].kind, 'days');
    assert.equal(d.criteria[0].used, 14);
    assert.equal(d.criteria[0].left, 16);
    assert.equal(isoOf(d.due_date), '2026-10-01T00:00:00.000Z');
    assert.equal(d.forecast, false);
    assert.equal(d.summary, 'залишилось 16 дн.');
    assert.equal(isoOf(d.ref_date), '2026-09-01T00:00:00.000Z');

    const h = due.RH;
    assert.equal(h.criteria[0].kind, 'hours');
    assert.equal(h.criteria[0].used, 50);
    assert.equal(h.criteria[0].left, 50);
    assert.equal(h.pct, 0.5);
    assert.equal(h.forecast, true);
    assert.equal(isoOf(h.due_date), '2026-09-25T00:00:00.000Z', '50 мотогод / 5 год на добу = 10 діб');
    assert.equal(h.status, 'ok');
    assert.equal(h.summary, 'залишилось 50 мотогод');
    assert.equal(h.ref_hours, 0);

    assert.equal(due.RS.status, 'soon', 'залишилось 10 мотогод ≈ 2 доби ≤ warn_days 7');
    assert.equal(due.RX.status, 'due');
    assert.equal(due.RX.pct, 1.25);
    assert.equal(due.RX.summary, 'перевищено на 10 мотогод');
    assert.equal(due.RX.driver, 'hours');
    // строк — коли 40 мотогод справді набралося (12.09, кінець 8-ї зміни по 5 год), а не прогноз назад за середнім
    assert.equal(isoOf(due.RX.due_date), '2026-09-12T10:00:00.000Z');
    assert.equal(due.RX.forecast, false);
    assert.equal(due.RX.overdue_days, 2.6);

    const m = due.RM;
    assert.equal(m.criteria[0].kind, 'meter');
    assert.equal(m.criteria[0].used, 1000);
    assert.equal(m.criteria[0].unit_label, 'цикл.');
    assert.equal(m.ref_meter, 1000);
    // приріст 800 з 06.09 по 15.09 (9 діб) → ≈ 88,9 на добу → 1000 / 88,9 = 11,25 доби
    assert.ok(Math.abs(ms(m.due_date) - (ms('2026-09-15T00:00:00Z') + 1000 / (800 / 9) * DAY)) < 1000);
    assert.equal(m.status, 'ok');

    assert.equal(due.RN.due_date, null, 'немає напрацювання — немає прогнозу');
    assert.equal(due.RN.status, 'ok');
    assert.equal(due.R0.status, 'none');
    assert.equal(due.R0.summary, 'без інтервалу');

    // сортування: due, soon, ok, none; далі за строком
    const order = f.app.dueAll().map((x) => x.rule_id);
    assert.deepEqual(order, ['RX', 'RS', 'RH', 'RM', 'RD', 'RN', 'R0'], 'ok — за строком: 25.09, ≈26.09, 01.10; без строку — в кінці');
  });

  test('пороги: warn_pct / warn_days правила переважають налаштування', () => {
    const f = utilisationFixture();
    const mk = (id, extra) => f.save('rules', { id, line_id: 'L1', title: id, work_type: 'to', ...extra });
    f.setNow('2026-09-01T00:00:00Z');
    mk('W1', { interval_days: 30, warn_pct: 40 });
    mk('W2', { interval_days: 30, warn_days: 20 });
    mk('W3', { interval_days: 10, warn_days: 0 });
    mk('W4', { interval_days: 10 });
    mk('W5', { interval_days: 14 });
    f.setNow('2026-09-15T00:00:00Z');
    const due = Object.fromEntries(f.app.dueAll().map((d) => [d.rule_id, d]));
    assert.equal(due.W1.status, 'soon', '46,7% ≥ 40%');
    assert.equal(due.W2.status, 'soon', '16 днів ≤ 20');
    assert.equal(due.W3.status, 'due', 'строк минув (14/10)');
    assert.equal(due.W4.summary, 'прострочено на 4 дн.');
    assert.equal(due.W5.status, 'due', 'рівно 100% → due');
    assert.equal(due.W5.summary, 'строк настав сьогодні');
    f.setting({ warn_pct: 45 });
    assert.equal(f.app.computeDue('RD').status, 'soon', '46,7% ≥ 45% з налаштувань');
  });

  test('робота за регламентом оновлює last_*, стара робота — ні; анулювання → recomputeRule', () => {
    const f = utilisationFixture();
    const w1 = f.ok(f.call('work', { id: 'w1', ts: '2026-09-10T11:00:00Z', line_id: 'L1', rule_id: 'RH', performer: 'Віктор' }));
    assert.equal(w1.work.work_type, 'replace', 'вид роботи береться з регламенту');
    assert.equal(w1.work.title, 'Заміна ущільнювачів');
    assert.equal(w1.work.unit_id, 'U1');
    assert.equal(w1.work.hours_at, 30);
    assert.equal(w1.due.rule_id, 'RH');
    assert.equal(w1.due.ref_hours, 30);
    assert.equal(w1.due.criteria[0].used, 20);
    let rule = f.row('rules', 'RH');
    assert.equal(isoOf(rule.last_date), '2026-09-10T11:00:00.000Z');
    assert.equal(rule.last_hours, 30);
    assert.equal(rule.last_work_id, 'w1');
    // старіша робота не змінює last_*
    f.ok(f.call('work', { id: 'w0', ts: '2026-09-07T11:00:00Z', line_id: 'L1', rule_id: 'RH' }));
    assert.equal(f.row('rules', 'RH').last_work_id, 'w1');
    // відкрита (не завершена) робота не рахується
    f.ok(f.call('work', { id: 'w2', ts: '2026-09-12T11:00:00Z', line_id: 'L1', rule_id: 'RH', status: 'open' }));
    assert.equal(f.row('rules', 'RH').last_work_id, 'w1');
    // анулювання останньої → попередня
    f.ok(f.admin('void', { table: 'works', id: 'w1', note: 'Помилковий запис' }));
    rule = f.row('rules', 'RH');
    assert.equal(rule.last_work_id, 'w0');
    assert.equal(rule.last_hours, 15);
    assert.equal(f.row('works', 'w1').void, true);
    assert.equal(f.row('works', 'w1').void_note, 'Помилковий запис');
    // анулювання всіх → відлік від бази
    f.ok(f.admin('void', { table: 'works', id: 'w0' }));
    rule = f.row('rules', 'RH');
    assert.equal(rule.last_date, null);
    assert.equal(rule.last_work_id, '');
    assert.equal(f.app.computeDue('RH').criteria[0].used, 50);
    assert.equal(f.admin('void', { table: 'works', id: 'w0' }).already, true, 'повторне анулювання безпечне');
  });

  test('робота з показником лічильника: meter_at + абсолютний показник', () => {
    const f = utilisationFixture();
    const w = f.ok(f.call('work', { id: 'wm', ts: '2026-09-14T12:00:00Z', line_id: 'L1', rule_id: 'RM', meter_value: 2100 }));
    assert.equal(w.work.meter_at, 2100);
    assert.equal(w.reading.id, 'wm-m');
    assert.equal(w.reading.mode, 'abs');
    assert.equal(f.row('meters', 'M1').cur_value, 2100);
    assert.equal(f.row('rules', 'RM').last_meter, 2100);
    // без meter_value — значення лічильника на момент роботи
    const w2 = f.ok(f.call('work', { id: 'wm2', ts: '2026-09-12T00:00:00Z', line_id: 'L1', rule_id: 'RM' }));
    assert.equal(w2.work.meter_at, 1600);
    // анулювання роботи анулює і її показник
    f.ok(f.admin('void', { table: 'works', id: 'wm' }));
    assert.equal(f.row('readings', 'wm-m').void, true);
    assert.equal(f.row('meters', 'M1').cur_value, 2000);
    assert.equal(f.row('rules', 'RM').last_work_id, 'wm2');
  });

  test('валідація роботи', () => {
    const f = utilisationFixture();
    assert.equal(f.call('work', { line_id: 'L1', work_type: 'щось' }).error, 'BAD_REQUEST');
    assert.equal(f.call('work', { line_id: 'L1' }).error, 'BAD_REQUEST');
    assert.equal(f.call('work', { line_id: 'L1', rule_id: 'NOPE' }).error, 'NOT_FOUND');
    assert.equal(f.call('work', { line_id: 'L2', rule_id: 'RH' }).error, 'BAD_REQUEST');
    assert.equal(f.call('work', { line_id: 'L2', work_type: 'repair', unit_id: 'U1' }).error, 'BAD_REQUEST');
    assert.equal(f.call('work', { line_id: 'L1', work_type: 'repair', duration_min: -5 }).error, 'BAD_REQUEST');
    const w = f.ok(f.call('work', { line_id: 'L1', work_type: 'Ремонт', started: '2026-09-14T22:30:00Z', ts: '2026-09-14T23:00:00Z' }));
    assert.equal(w.work.duration_min, 30);
    assert.equal(w.work.title, 'Ремонт');
    assert.equal(w.work.status, 'done');
  });
});

describe('регламент: допоміжні поля збереження', () => {
  test('last_done_date / used_hours / used_meter → base_*', () => {
    const f = utilisationFixture();
    // зараз: мотогодини лінії 50, лічильник M1 = 2000
    const r = f.save('rules', { id: 'H1', line_id: 'L1', title: 'Заміна фільтра', work_type: 'replace', interval_hours: 100,
      meter_id: 'M1', interval_meter: 1000, last_done_date: '01.09.2026', used_hours: 30, used_meter: '400' });
    assert.equal(isoOf(r.base_date), '2026-08-31T21:00:00.000Z');
    assert.equal(r.base_hours, 20);
    assert.equal(r.base_meter, 1600);
    const d = f.app.computeDue('H1');
    assert.equal(d.criteria.find((c) => c.kind === 'hours').used, 30);
    assert.equal(d.criteria.find((c) => c.kind === 'meter').used, 400);
    // без допоміжних полів — відлік від «зараз»
    const r2 = f.save('rules', { id: 'H2', line_id: 'L1', title: 'Інше', interval_hours: 10, meter_id: 'M1', interval_meter: 10 });
    assert.equal(isoOf(r2.base_date), '2026-09-15T00:00:00.000Z');
    assert.equal(r2.base_hours, 50);
    assert.equal(r2.base_meter, 2000);
    assert.equal(r2.work_type, 'to');
    // службові поля з вводу ігноруються
    const r3 = f.save('rules', { id: 'H3', line_id: 'L1', title: 'x', interval_days: 5, last_date: '01.01.2020', last_hours: 5, last_work_id: 'hack' });
    assert.equal(r3.last_date, null);
    assert.equal(r3.last_work_id, '');
    // оновлення з допоміжними полями перераховує базу
    const r4 = f.save('rules', { id: 'H2', used_hours: 5 });
    assert.equal(r4.base_hours, 45);
    assert.equal(r4.title, 'Інше', 'інші поля збережено');
    assert.equal(f.admin('save', { table: 'rules', row: { id: 'H4', line_id: 'L1', title: 'x', last_done_date: '01.01.2030' } }).error, 'BAD_REQUEST');
    assert.equal(f.admin('save', { table: 'rules', row: { id: 'H4', line_id: 'L1', title: 'x', used_hours: 'багато' } }).error, 'BAD_REQUEST');
  });
});

describe('регламент: рядки з таблиці та зміна лінії/лічильника', () => {
  test('регламент, доданий прямо в Google-таблиці, отримує відлік при першому розрахунку', () => {
    const f = utilisationFixture();
    f.store.insert('rules', [{ id: 'SHEET', line_id: 'L1', title: 'З таблиці', work_type: 'ТО', interval_hours: '100', interval_days: '30', active: '' }]);
    const due = f.app.dueAll().find((x) => x.rule_id === 'SHEET');
    assert.ok(due, 'порожня «Активний» = активний');
    assert.equal(due.criteria.find((c) => c.kind === 'hours').used, 0);
    assert.equal(due.criteria.find((c) => c.kind === 'days').used, 0);
    const r = f.row('rules', 'SHEET');
    assert.equal(isoOf(r.base_date), '2026-09-15T00:00:00.000Z');
    assert.equal(isoOf(r.created), '2026-09-15T00:00:00.000Z');
    assert.equal(r.base_hours, 50);
    f.setNow('2026-09-16T00:00:00Z');
    f.app.dueAll();
    assert.equal(isoOf(f.row('rules', 'SHEET').base_date), '2026-09-15T00:00:00.000Z', 'відлік фіксується один раз');
    assert.equal(f.app.computeDue('SHEET').criteria.find((c) => c.kind === 'days').used, 1);
  });

  test('зміна лічильника в регламенті — новий відлік лічильника', () => {
    const f = utilisationFixture();
    f.save('meters', { id: 'M3', line_id: 'L1', name: 'Інший лічильник', mode: 'abs' });
    f.ok(f.call('reading', { id: 'x3', ts: '2026-09-14T00:00:00Z', meter_id: 'M3', value: 70 }));
    assert.equal(f.row('rules', 'RM').base_meter, 1000);
    const r = f.save('rules', { id: 'RM', meter_id: 'M3' });
    assert.equal(r.base_meter, 70);
    assert.equal(f.app.computeDue('RM').criteria[0].used, 0);
  });
});

describe('план ППР', () => {
  test('періоди, прогноз, прострочені, немає даних', () => {
    const f = utilisationFixture();
    const p = f.ok(f.call('plan', { from: '2026-09-15', to: '2026-12-31' }));
    assert.equal(p.from, '2026-09-14T21:00:00.000Z');
    assert.equal(p.to, '2026-12-31T22:00:00.000Z');
    const by = (id) => p.items.filter((i) => i.rule_id === id);
    assert.deepEqual(by('RD').map((i) => i.day), ['2026-10-01', '2026-10-31', '2026-11-30', '2026-12-30']);
    assert.ok(by('RD').every((i) => i.forecast === false && i.overdue === false));
    assert.equal(by('RD')[0].date, '2026-09-30T21:00:00.000Z', 'date — початок дня за Києвом');
    assert.deepEqual(by('RH').map((i) => i.day), ['2026-09-25', '2026-10-15', '2026-11-04', '2026-11-24', '2026-12-14']);
    assert.ok(by('RH').every((i) => i.forecast === true));
    const rx = by('RX');
    assert.equal(rx[0].day, '2026-09-15');
    assert.equal(rx[0].overdue, true);
    assert.equal(rx[1].overdue, false);
    assert.equal(rx[1].day, '2026-09-23', 'період 40 / 5 = 8 діб');
    const info = Object.fromEntries(p.rules.map((r) => [r.rule_id, r]));
    assert.equal(info.RD.period_days, 30);
    assert.equal(info.RD.basis, 'days');
    assert.equal(info.RH.period_days, 20);
    assert.equal(info.RH.basis, 'hours');
    assert.equal(info.RM.basis, 'meter');
    assert.equal(by('RN').length, 0);
    assert.equal(info.RN.note, 'Немає даних про напрацювання для прогнозу');
    assert.ok(!info.R0, 'правила без інтервалу не плануються');
    assert.equal(p.avg_h.L1, 5);
    assert.ok(p.avg_meter.M1 > 88 && p.avg_meter.M1 < 89);
    for (let i = 1; i < p.items.length; i++) assert.ok(p.items[i - 1].date <= p.items[i].date, 'відсортовано за датою');
    // типовий період: сьогодні … + plan_horizon_days
    const def = f.app.buildPlan();
    assert.equal(isoOf(def.from), '2026-09-14T21:00:00.000Z');
    assert.equal(def.to.getTime() - def.from.getTime(), 365 * DAY);
    // не більше 400 входжень на правило
    f.save('rules', { id: 'TINY', line_id: 'L1', title: 'Щогодини', interval_hours: 0.01 });
    assert.equal(f.app.buildPlan().items.filter((i) => i.rule_id === 'TINY').length, 400);
  });

  test('рядки для аркуша «План ППР» і refreshPlan', () => {
    const f = utilisationFixture();
    const rows = f.app.planRows('2026-09-15', '2026-10-31');
    assert.ok(rows.length > 0);
    assert.equal(rows[0].line, 'Лінія 1');
    assert.ok(rows.every((r) => r.generated instanceof Date && typeof r.basis === 'string'));
    assert.match(rows.find((r) => r.rule_id === 'RX').basis, /^Прострочено · Прогноз за мотогодинами/);
    const res = f.app.refreshPlan('2026-09-15', '2026-10-31');
    assert.equal(res.count, rows.length);
    const stored = f.store.all('plan');
    assert.equal(stored.length, rows.length);
    assert.equal(stored.find((r) => r.rule_id === 'RD').work_type, 'ТО');
  });
});

describe('контроль щоденних перевірок (compliance)', () => {
  test('статуси miss / warn / ok / cont / idle та відсоток покриття', () => {
    const f = fixture('2026-09-18T20:00:00Z');
    config(f);
    // 15.09: запуск без чек-листа → miss
    f.ev('a1', '2026-09-15T05:00:00Z', 'run');
    f.ev('a2', '2026-09-15T15:00:00Z', 'off', { ref_id: 'x' });
    // 16.09: чек-лист із зауваженням → warn
    f.ok(f.call('checklist', { id: 'c16', ts: '2026-09-16T05:00:00Z', line_id: 'L1', occasion: 'start',
      answers: START_OK.map((a) => (a.item_id === 'I2' ? { ...a, value: 'fail' } : a)), then_event: { state: 'run' } }));
    f.ev('o16', '2026-09-16T15:00:00Z', 'off', { ref_id: 'x' });
    // 17.09: норма; лінія працює через північ
    f.ok(f.call('checklist', { id: 'c17', ts: '2026-09-17T05:00:00Z', line_id: 'L1', occasion: 'start', answers: START_OK, then_event: { state: 'run' } }));
    f.ev('s17', '2026-09-17T10:00:00Z', 'stop', { reason: 'Перерва' });
    f.ev('r17', '2026-09-17T10:30:00Z', 'run');
    // 18.09: лише продовження роботи → cont; але робота з 17.09 05:00Z триває вже 39 год без завершення
    // (long_run_hours = 16) → 17.09 — порушення «без завершення», як позначка long_run
    const comp = f.app.compliance('2026-09-14', '2026-09-18', ['L1']);
    const days = comp.L1;
    assert.deepEqual(days.map((d) => d.day), ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']);
    assert.deepEqual(days.map((d) => d.status), ['idle', 'miss', 'warn', 'miss', 'cont']);
    assert.deepEqual(days.map((d) => d.long_runs), [0, 0, 0, 1, 0]);
    assert.equal(days[3].uncovered, 0);
    assert.equal(days[3].covered, 1);
    // та сама картина без довгої роботи (поріг 48 год) — 17.09 у нормі
    f.setting({ long_run_hours: 48 });
    assert.deepEqual(f.app.compliance('2026-09-14', '2026-09-18', ['L1']).L1.map((d) => d.status), ['idle', 'miss', 'warn', 'ok', 'cont']);
    f.setting({ long_run_hours: 16 });
    assert.equal(days[1].uncovered, 1);
    assert.equal(days[1].starts, 1);
    assert.equal(days[1].covered, 0);
    assert.equal(days[1].run_h, 10);
    assert.equal(days[2].checks.length, 1);
    assert.equal(days[2].checks[0].result, 'remarks');
    assert.equal(days[3].run_h, 15.5, '05:00Z–21:00Z (північ за Києвом) мінус 0,5 год перерви');
    assert.equal(days[4].run_h, 23, 'до «зараз» 20:00Z = 23:00 за Києвом');
    const dash = f.ok(f.call('dashboard', { days: 5 }));
    assert.equal(dash.compliance_pct.L1, 66.7);
    assert.equal(dash.compliance_pct.L2, null);
    assert.equal(dash.compliance_pct.all, 66.7);
  });

  test('день переходу на зимовий час (25 год) і робота через північ', () => {
    const f = fixture('2026-10-20T00:00:00Z');
    config(f);
    f.setting({ long_run_hours: 48 });   // безперервна робота 31 год — тут перевіряємо довжину доби, а не long_run
    f.setNow('2026-10-27T12:00:00Z');
    // 24.10 20:00 за Києвом (EEST) = 17:00Z — запуск; зупинка 26.10 02:00 (EET) = 00:00Z
    f.ok(f.call('checklist', { id: 'c1', ts: '2026-10-24T17:00:00Z', line_id: 'L1', occasion: 'start', answers: START_OK, then_event: { state: 'run' } }));
    f.ok(f.call('checklist', { id: 'c2', ts: '2026-10-26T00:00:00Z', line_id: 'L1', occasion: 'end', answers: [{ item_id: 'I6', value: 'ok' }], then_event: { state: 'off' } }));
    const days = f.app.compliance('2026-10-24', '2026-10-26', ['L1']).L1;
    assert.deepEqual(days.map((d) => [d.day, d.status, d.run_h, d.starts, d.checks.length]), [
      ['2026-10-24', 'ok', 4, 1, 1],
      ['2026-10-25', 'cont', 25, 0, 0],
      ['2026-10-26', 'ok', 2, 0, 1]
    ]);
    const st = f.app.stats('2026-10-24', '2026-10-26', ['L1']).L1;
    assert.equal(st.hours.run, 31);
    assert.equal(st.total_h, 24 + 25 + 24);
    const dash = f.ok(f.call('dashboard', { days: 5 }));
    assert.deepEqual(dash.days, ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
    const d25 = dash.daily.L1.find((d) => d.day === '2026-10-25');
    assert.equal(d25.hours.run, 25);
    const sum = Object.values(d25.hours).reduce((a, b) => a + b, 0);
    assert.equal(sum, 25);
  });
});

describe('статистика та панель', () => {
  test('години за станами, причини простоїв, ремонти, роботи, чек-листи', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    f.ok(f.call('checklist', { id: 'c1', ts: '2026-09-15T05:00:00Z', line_id: 'L1', occasion: 'start',
      answers: START_OK.map((a) => (a.item_id === 'I3' ? { ...a, value: 9 } : a)), then_event: { state: 'run' } }));
    f.ev('s1', '2026-09-15T07:00:00Z', 'stop', { reason: 'Немає сировини / тари' });
    f.ev('s2', '2026-09-15T07:30:00Z', 'run');
    f.ev('s3', '2026-09-15T08:00:00Z', 'stop');
    f.ev('s4', '2026-09-15T08:15:00Z', 'repair', { reason: 'Обрив' });
    f.ok(f.call('work', { id: 'w1', ts: '2026-09-15T09:00:00Z', line_id: 'L1', work_type: 'repair', title: 'Заміна датчика', cause: 'Обрив' }));
    f.ev('s5', '2026-09-15T09:00:00Z', 'run', { ref_id: 'w1' });
    f.ok(f.call('checklist', { id: 'c2', ts: '2026-09-15T12:00:00Z', line_id: 'L1', occasion: 'end',
      answers: [{ item_id: 'I6', value: 'ok' }], then_event: { state: 'off' } }));
    const st = f.app.stats('2026-09-15', '2026-09-15', ['L1']).L1;
    assert.equal(st.hours.run, 2 + 0.5 + 3);
    assert.equal(st.hours.stop, 0.5 + 0.25);
    assert.equal(st.hours.repair, 0.75);
    assert.equal(st.repair_h, 0.75);
    assert.equal(st.hours.off, 8 + 8, '00:00–08:00 і 15:00–23:00 за Києвом');
    const total = Object.values(st.hours).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 23) < 1e-6, 'сума годин = довжина вікна до «зараз» (23 год)');
    assert.equal(st.total_h, 23);
    assert.deepEqual(st.stops_by_reason, { 'Немає сировини / тари': 0.5, 'Без причини': 0.25 });
    assert.equal(st.starts, 1);
    assert.equal(st.repairs, 1);
    assert.deepEqual(st.works_by_type, { repair: 1 });
    assert.equal(st.checks, 2);
    assert.equal(st.checks_ok, 1);
    assert.equal(st.checks_remarks, 1);
    assert.equal(st.out_of_range, 1);

    const dash = f.ok(f.call('dashboard', { days: 3 }));
    assert.deepEqual(dash.days, ['2026-09-13', '2026-09-14', '2026-09-15']);
    assert.equal(dash.from, '2026-09-12T21:00:00.000Z');
    assert.equal(dash.stats.L1.hours.run, 5.5);
    assert.equal(dash.daily.L1.length, 3);
    assert.equal(dash.daily.L1[2].hours.run, 5.5);
    assert.equal(dash.status.L1.state, 'off');
    const kinds = dash.issues.map((i) => i.kind + ':' + i.text);
    assert.deepEqual(kinds, ['repair:Заміна датчика', 'repair:Ремонт: Обрив', 'answer:Тиск повітря, бар']);
    assert.equal(dash.issues[2].value, '9 бар');
    assert.equal(dash.issues[2].check_id, 'c1');
    assert.equal(dash.issues[0].work_id, 'w1');
    assert.equal(f.call('dashboard', { days: 500 }).days.length, 62, 'максимум 62 дні');
  });

  test('дія line: події, таймлайн, дні', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    f.ev('a', '2026-09-14T05:00:00Z', 'run');
    f.ev('b', '2026-09-14T15:00:00Z', 'off', { ref_id: 'x' });
    f.ev('c', '2026-09-15T05:00:00Z', 'run', { product: 'Кетчуп' });
    f.ok(f.call('reading', { id: 'r', ts: '2026-09-15T06:00:00Z', meter_id: 'M2', value: 5 }));
    const v = f.ok(f.call('line', { line_id: 'L1', days: 2 }));
    assert.equal(v.from, '2026-09-13T21:00:00.000Z');
    assert.deepEqual(v.events.map((e) => e.id), ['c', 'b', 'a'], 'за спаданням часу');
    assert.equal(v.readings.length, 1);
    assert.deepEqual(v.timeline.map((s) => s.state), ['off', 'run', 'off', 'run']);
    assert.equal(v.timeline[3].product, 'Кетчуп');
    assert.equal(v.timeline[3].hours, 15);
    assert.deepEqual(v.days.map((d) => [d.day, d.hours.run, d.starts]), [['2026-09-14', 10, 1], ['2026-09-15', 15, 1]]);
    assert.equal(f.call('line', { line_id: 'NOPE' }).error, 'NOT_FOUND');
  });
});

describe('bootstrap', () => {
  test('форма відповіді, статус ліній, приховані поля', () => {
    const f = utilisationFixture();
    f.setNow('2026-09-15T12:00:00Z');
    f.setting({ manager_emails: 'boss@example.com' });
    f.ok(f.call('checklist', { id: 'cs', ts: '2026-09-15T05:00:00Z', line_id: 'L1', occasion: 'start', answers: START_OK, then_event: { state: 'run' } }));
    f.ok(f.admin('remove', { table: 'lines', id: 'L2' }));
    const b = f.ok(f.call('bootstrap'));
    for (const k of ['version', 'now', 'settings', 'lines', 'units', 'items', 'meters', 'rules', 'staff', 'status', 'due', 'avg_h']) assert.ok(k in b, k);
    assert.equal(b.version, '1.1.0');
    assert.equal(b.now, '2026-09-15T12:00:00.000Z');
    assert.ok(!hasDate(b));
    assert.deepEqual(b.lines.map((l) => l.id), ['L1'], 'неактивні лінії — лише для керівника');
    assert.ok(!Object.keys(b.lines[0]).some((k) => k.startsWith('cur_')));
    assert.ok(!('manager_emails' in b.settings));
    assert.ok(!('sheet_url' in b.settings));
    assert.deepEqual(b.settings.stop_reasons, LinesCore.DEFAULT_SETTINGS.stop_reasons);
    assert.ok(b.rules.every((r) => !('notify' in r)));
    assert.ok(b.rules.every((r) => r.line_id === 'L1'));
    assert.ok(b.units.every((u) => u.id !== 'U2'));
    assert.equal(findKey(b, 'pin'), null, 'PIN ніколи не передається клієнту');
    assert.equal(findKey(b, 'email'), null);
    const s1 = b.staff.find((s) => s.id === 'S1');
    assert.equal(s1.pin_hash, LinesCore.sha256('S1:1234'));
    assert.equal(b.staff.find((s) => s.id === 'S2').pin_hash, null);
    assert.deepEqual(Object.keys(s1).sort(), ['active', 'id', 'line_ids', 'name', 'pin_hash', 'role', 'sort']);
    const st = b.status.L1;
    for (const k of ['line_id', 'state', 'since', 'product', 'operator', 'staff_id', 'event_id', 'reason', 'cum_h', 'starts', 'today_h', 'last_check', 'start_check_valid', 'long_run']) {
      assert.ok(k in st, 'status.' + k);
    }
    assert.equal(st.state, 'run');
    assert.equal(st.cum_h, 57);
    assert.equal(st.today_h, 7);
    assert.equal(st.start_check_valid, true);
    assert.deepEqual(st.last_check, { id: 'cs', ts: '2026-09-15T05:00:00.000Z', occasion: 'start', result: 'ok' });
    assert.equal(st.long_run, false);
    assert.ok(!('L2' in b.status));
    const order = { due: 0, soon: 1, ok: 2, none: 3 };
    for (let i = 1; i < b.due.length; i++) assert.ok(order[b.due[i - 1].status] <= order[b.due[i].status], 'due відсортовано');
    assert.ok(b.due.every((d) => d.line_id === 'L1'), 'лише правила активних ліній');
    const m1 = b.meters.find((m) => m.id === 'M1');
    assert.equal(m1.value, 2000);
    assert.equal(m1.value_ts, '2026-09-14T00:00:00.000Z');
    assert.ok(m1.avg_per_day > 0);
    assert.equal(b.avg_h.L1, 5.2);
    // керівник бачить усе, крім PIN
    const a = f.ok(f.admin('bootstrap'));
    assert.deepEqual(a.lines.map((l) => l.id), ['L1', 'L2']);
    assert.deepEqual(a.settings.manager_emails, ['boss@example.com']);
    assert.ok('sheet_url' in a.settings);
    assert.equal(a.rules.find((r) => r.id === 'RX').notify, 'mech@example.com, boss@example.com');
    assert.equal(a.staff.find((s) => s.id === 'S1').email, 'olena@example.com');
    assert.equal(a.staff.find((s) => s.id === 'S1').has_pin, true);
    assert.equal(findKey(a, 'pin'), null);
    assert.ok(a.units.some((u) => u.id === 'U2'));
  });

  test('long_run і чинність чек-листа запуску', () => {
    const f = fixture('2026-09-15T05:00:00Z');
    config(f);
    f.ev('a', '2026-09-15T05:00:00Z', 'run');
    f.ev('b', '2026-09-15T10:00:00Z', 'stop');
    f.ev('c', '2026-09-15T11:00:00Z', 'run');
    f.setNow('2026-09-15T20:00:00Z');
    let st = f.call('bootstrap').status.L1;
    assert.equal(st.long_run, false);
    assert.equal(st.start_check_valid, false);
    assert.equal(st.work_since, '2026-09-15T05:00:00.000Z');
    f.setNow('2026-09-15T21:30:00Z');
    st = f.call('bootstrap').status.L1;
    assert.equal(st.long_run, true, '16,5 год без завершення');
  });
});

describe('доступ керівника та обробка помилок', () => {
  test('адмін-дії без PIN → ADMIN_REQUIRED', () => {
    const f = fixture();
    config(f);
    for (const action of ['admin_check', 'save', 'remove', 'void', 'settings_save', 'digest_preview', 'notices', 'recompute']) {
      const r = f.call(action, { table: 'lines', id: 'L1', row: { name: 'x' }, values: {} });
      assert.equal(r.ok, false, action);
      assert.equal(r.error, 'ADMIN_REQUIRED', action);
      assert.equal(typeof r.message, 'string');
    }
    assert.equal(f.admin('admin_check').ok, true);
    assert.equal(f.call('nope').error, 'UNKNOWN_ACTION');
    assert.equal(f.app.handle(null).error, 'UNKNOWN_ACTION');
    assert.equal(f.call('ping').company, 'Foodline Production');
  });

  test('handle ніколи не кидає: SERVER_ERROR / LOCKED', () => {
    const broken = new MemoryStore();
    broken.all = () => { throw new Error('Сховище недоступне'); };
    const app = createApp(broken, {});
    const r = app.handle({ action: 'bootstrap' }, {});
    assert.equal(r.ok, false);
    assert.equal(r.error, 'SERVER_ERROR');
    assert.match(r.message, /Сховище недоступне/);
    const locked = new MemoryStore();
    locked.all = () => { const e = new Error('Lock timeout'); e.code = 'LOCKED'; throw e; };
    assert.equal(createApp(locked, {}).handle({ action: 'ping' }, {}).error, 'LOCKED');
    // прямі методи кидають AppError із кодом
    const f = fixture();
    assert.throws(() => f.app.addEvent({ line_id: 'x', state: 'run' }), (e) => e.code === 'NOT_FOUND');
  });

  test('ACTIONS описує запис/адмін-дії для хоста', () => {
    const A = LinesCore.ACTIONS;
    assert.equal(A.event.write, true);
    assert.equal(A.bootstrap.write, undefined);
    assert.equal(A.save.admin, true);
    assert.equal(A.void.admin, true);
    assert.equal(A.batch.write, true);
  });
});

describe('адміністрування довідників', () => {
  test('створення, оновлення, валідація, службові поля', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    const line = f.save('lines', { name: 'Нова лінія', kind: 'Фасувальна', cur_state: 'run', cur_cum_h: 999 });
    assert.equal(line.id, 'gen1');
    assert.equal(line.cur_state, 'off', 'нова лінія — «Не працює»');
    assert.equal(line.cur_cum_h, 0);
    assert.equal(line.active, true);
    assert.equal(line.sort, 30);
    assert.equal(line.created, '2026-09-15T20:00:00.000Z');
    // новий агрегат отримує base_cum = мотогодини лінії зараз
    f.ev('a', '2026-09-15T05:00:00Z', 'run');
    const u = f.save('units', { line_id: 'L1', name: 'Компресор', hours_offset: 10, base_cum: 5 });
    assert.equal(u.base_cum, 15);
    assert.equal(f.call('bootstrap').units.find((x) => x.id === u.id).hours, 10);
    // оновлення: лише передані поля; службові ігноруються
    const upd = f.save('lines', { id: 'L1', description: 'Оновлено', cur_state: 'repair' });
    assert.equal(upd.name, 'Лінія 1');
    assert.equal(upd.description, 'Оновлено');
    assert.equal(upd.cur_state, 'run');
    // PIN
    let s = f.save('staff', { id: 'S1', name: 'Олена К.' });
    assert.equal(s.has_pin, true, 'PIN не змінюється, якщо не передано');
    assert.ok(!('pin' in s));
    s = f.save('staff', { id: 'S1', pin: '' });
    assert.equal(s.has_pin, true, 'порожній PIN — без змін');
    s = f.save('staff', { id: 'S1', pin: '98765' });
    assert.equal(s.pin_hash, LinesCore.sha256('S1:98765'));
    s = f.save('staff', { id: 'S1', clear_pin: true });
    assert.equal(s.has_pin, false);
    assert.equal(s.pin_hash, null);
    const bad = (table, row) => f.admin('save', { table, row }).error;
    assert.equal(bad('lines', { name: '' }), 'BAD_REQUEST');
    assert.equal(bad('units', { name: 'x', line_id: 'NOPE' }), 'BAD_REQUEST');
    assert.equal(bad('units', { name: 'x', line_id: 'L1', year: 1800 }), 'BAD_REQUEST');
    assert.equal(bad('items', { line_id: 'L1', text: 'x', type: 'дивний' }), 'BAD_REQUEST');
    assert.equal(bad('items', { line_id: 'L1', text: 'x', occasions: 'Запуск, щось' }), 'BAD_REQUEST');
    assert.equal(bad('items', { line_id: 'L1', text: 'x', type: 'select' }), 'BAD_REQUEST');
    assert.equal(bad('items', { line_id: 'L1', text: 'x', type: 'number', min: 10, max: 5 }), 'BAD_REQUEST');
    assert.equal(bad('items', { line_id: 'L2', unit_id: 'U1', text: 'x' }), 'BAD_REQUEST');
    assert.equal(bad('items', { line_id: 'L1', text: 'x', min: 'багато' }), 'BAD_REQUEST');
    assert.equal(bad('meters', { line_id: 'L1', name: 'x', mode: 'щось' }), 'BAD_REQUEST');
    assert.equal(bad('rules', { line_id: 'L1', title: 'x', interval_meter: 100 }), 'BAD_REQUEST');
    assert.equal(bad('rules', { line_id: 'L2', title: 'x', meter_id: 'M1', interval_meter: 100 }), 'BAD_REQUEST');
    assert.equal(bad('rules', { line_id: 'L1', title: 'x', interval_days: -1 }), 'BAD_REQUEST');
    assert.equal(bad('rules', { line_id: 'L1', title: 'x', warn_pct: 150 }), 'BAD_REQUEST');
    assert.equal(bad('rules', { line_id: 'L1', title: 'x', notify: 'не-пошта' }), 'BAD_REQUEST');
    assert.equal(bad('staff', { name: 'x', line_ids: 'L1, L99' }), 'BAD_REQUEST');
    assert.equal(bad('staff', { name: 'x', email: 'bad' }), 'BAD_REQUEST');
    assert.equal(bad('staff', { name: 'x', pin: '12ab' }), 'BAD_REQUEST');
    assert.equal(bad('events', { id: 'x' }), 'BAD_REQUEST');
    assert.equal(bad('lines', { id: 'погане id', name: 'x' }), 'BAD_REQUEST');
    assert.equal(f.admin('save', { table: 'lines' }).error, 'BAD_REQUEST');
    // типові значення
    const it = f.save('items', { line_id: 'L1', text: 'Новий пункт' });
    assert.equal(it.type, 'check');
    assert.deepEqual(it.occasions, ['start']);
    assert.equal(it.required, true);
    const m = f.save('meters', { line_id: 'L1', name: 'Новий' });
    assert.equal(m.mode, 'abs');
  });

  test('remove: мʼяке видалення', () => {
    const f = fixture();
    config(f);
    f.ok(f.admin('remove', { table: 'items', id: 'I2' }));
    assert.equal(f.row('items', 'I2').active, false);
    assert.ok(!f.call('bootstrap').items.some((i) => i.id === 'I2'));
    assert.equal(f.admin('remove', { table: 'items', id: 'NOPE' }).error, 'NOT_FOUND');
    assert.equal(f.admin('remove', { table: 'events', id: 'x' }).error, 'BAD_REQUEST');
  });
});

describe('анулювання (void) і перерахунки', () => {
  test('анулювання події перераховує мотогодини й стан лінії', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    f.ev('a', '2026-09-15T05:00:00Z', 'run');
    f.ev('b', '2026-09-15T07:00:00Z', 'stop');
    f.ev('c', '2026-09-15T09:00:00Z', 'off');
    assert.equal(f.row('events', 'c').cum_h, 2);
    f.ok(f.admin('void', { table: 'events', id: 'b', note: 'Помилково' }));
    assert.equal(f.row('events', 'b').void, true);
    assert.equal(f.row('events', 'c').cum_h, 4);
    assert.equal(f.row('events', 'c').prev_state, 'run');
    f.ok(f.admin('void', { table: 'events', id: 'c' }));
    const line = f.row('lines', 'L1');
    assert.equal(line.cur_state, 'run');
    assert.equal(line.cur_event, 'a');
    f.ok(f.admin('void', { table: 'events', id: 'a' }));
    const l2 = f.row('lines', 'L1');
    assert.equal(l2.cur_state, 'off');
    assert.equal(l2.cur_since, null);
    assert.equal(l2.cur_cum_h, 0);
    assert.equal(f.admin('void', { table: 'lines', id: 'L1' }).error, 'BAD_REQUEST');
    assert.equal(f.admin('void', { table: 'events', id: 'zzz' }).error, 'NOT_FOUND');
  });

  test('анулювання чек-листа анулює відповіді й знімає покриття запуску', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    f.ok(f.call('checklist', { id: 'c1', ts: '2026-09-15T05:00:00Z', line_id: 'L1', occasion: 'start', answers: START_OK }));
    f.ev('run', '2026-09-15T05:05:00Z', 'run');
    assert.equal(f.row('events', 'run').flag, '');
    f.ok(f.admin('void', { table: 'checks', id: 'c1', note: 'Заповнено заднім числом' }));
    assert.ok(f.rows('answers').every((a) => a.void));
    assert.equal(f.row('events', 'run').flag, 'no_checklist');
    assert.equal(f.call('bootstrap').status.L1.last_check, null);
  });

  test('анулювання показника перераховує лічильник', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    f.ok(f.call('reading', { id: 'r1', ts: '2026-09-15T05:00:00Z', meter_id: 'M2', value: 10 }));
    f.ok(f.call('reading', { id: 'r2', ts: '2026-09-15T06:00:00Z', meter_id: 'M2', value: 5 }));
    f.ok(f.admin('void', { table: 'readings', id: 'r2' }));
    assert.equal(f.row('meters', 'M2').cur_value, 10);
    assert.equal(isoOf(f.row('meters', 'M2').cur_ts), '2026-09-15T05:00:00.000Z');
    f.ok(f.admin('void', { table: 'readings', id: 'r1' }));
    assert.equal(f.row('meters', 'M2').cur_value, null);
  });
});

describe('історія (history)', () => {
  test('фільтри: період, лінія, агрегат, типи, вид роботи, пошук, ліміт, анульовані', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    f.save('units', { id: 'U3', line_id: 'L2', name: 'Етикетувальник' });
    f.ev('e1', '2026-09-10T05:00:00Z', 'run');
    f.ev('e2', '2026-09-14T05:00:00Z', 'stop', { reason: 'Немає етикетки' });
    f.ok(f.call('event', { id: 'e3', ts: '2026-09-14T06:00:00Z', line_id: 'L2', state: 'run' }));
    f.ok(f.call('work', { id: 'w1', ts: '2026-09-14T07:00:00Z', line_id: 'L1', unit_id: 'U1', work_type: 'repair', title: 'Заміна кільця', parts: 'Кільце 32×3' }));
    f.ok(f.call('work', { id: 'w2', ts: '2026-09-14T08:00:00Z', line_id: 'L1', work_type: 'lube', title: 'Змащення' }));
    f.ok(f.call('work', { id: 'w3', ts: '2026-09-14T09:00:00Z', line_id: 'L2', unit_id: 'U3', work_type: 'setup', title: 'Налаштування принтера' }));
    f.ok(f.call('reading', { id: 'r1', ts: '2026-09-14T10:00:00Z', meter_id: 'M1', value: 5 }));
    f.ok(f.call('checklist', { id: 'c1', ts: '2026-09-14T11:00:00Z', line_id: 'L1', occasion: 'end', answers: [{ item_id: 'I6', value: 'ok' }], comment: 'Все чисто' }));
    f.ok(f.admin('void', { table: 'works', id: 'w2' }));

    let h = f.ok(f.call('history', {}));
    assert.equal(h.events.length, 3);
    assert.equal(h.works.length, 3);
    assert.deepEqual(h.works.map((w) => w.id), ['w3', 'w2', 'w1'], 'за спаданням часу');
    assert.equal(h.works[1].void, true, 'анульовані показуються з позначкою');
    h = f.ok(f.call('history', { include_void: false }));
    assert.equal(h.works.length, 2);
    h = f.ok(f.call('history', { from: '2026-09-12', to: '2026-09-14' }));
    assert.deepEqual(h.events.map((e) => e.id), ['e3', 'e2']);
    h = f.ok(f.call('history', { from: '2026-09-12', to: '2026-09-13' }));
    assert.equal(h.events.length + h.works.length + h.checks.length + h.readings.length, 0);
    assert.equal(h.to, '2026-09-13T21:00:00.000Z');
    h = f.ok(f.call('history', { line_id: 'L2' }));
    assert.deepEqual([h.events.length, h.works.length, h.checks.length, h.readings.length], [1, 1, 0, 0]);
    h = f.ok(f.call('history', { types: ['works'], work_type: 'Ремонт' }));
    assert.deepEqual(h.works.map((w) => w.id), ['w1']);
    assert.equal(h.events.length, 0);
    h = f.ok(f.call('history', { types: 'events,checks' }));
    assert.equal(h.works.length, 0);
    assert.equal(h.checks.length, 1);
    h = f.ok(f.call('history', { unit_id: 'U1' }));
    assert.deepEqual([h.events.length, h.checks.length, h.works.length, h.readings.length], [0, 0, 1, 1]);
    h = f.ok(f.call('history', { q: 'КІЛЬЦЕ' }));
    assert.deepEqual(h.works.map((w) => w.id), ['w1']);
    assert.equal(h.events.length, 0);
    h = f.ok(f.call('history', { q: 'етикетки' }));
    assert.deepEqual(h.events.map((e) => e.id), ['e2']);
    h = f.ok(f.call('history', { q: 'простій' }));
    assert.deepEqual(h.events.map((e) => e.id), ['e2'], 'пошук і за українською міткою стану');
    h = f.ok(f.call('history', { q: 'чисто' }));
    assert.deepEqual(h.checks.map((c) => c.id), ['c1']);
    h = f.ok(f.call('history', { limit: 2 }));
    assert.equal(h.events.length, 2);
    assert.equal(h.truncated.events, true);
    assert.equal(h.truncated.readings, false);
    assert.equal(f.call('history', { work_type: 'щось' }).error, 'BAD_REQUEST');
  });

  test('check_detail', () => {
    const f = fixture();
    config(f);
    f.ok(f.call('checklist', { id: 'c1', ts: '2026-09-15T05:00:00Z', line_id: 'L1', occasion: 'start', answers: START_OK }));
    const d = f.ok(f.call('check_detail', { id: 'c1' }));
    assert.equal(d.check.id, 'c1');
    assert.equal(d.answers.length, 4);
    assert.equal(f.ok(f.call('check_detail', { id: 'c1', ts: '2026-09-15T05:00:00Z' })).answers.length, 4);
    assert.equal(f.call('check_detail', { id: 'nope' }).error, 'NOT_FOUND');
    assert.equal(f.call('check_detail', {}).error, 'BAD_REQUEST');
  });
});

describe('налаштування', () => {
  test('settings_save: типи, валідація, вставка нових ключів', () => {
    const f = fixture();
    config(f);
    const r = f.setting({ digest_hour: '8', warn_days: 3, instant_due: 'ні', products: 'А; Б', manager_emails: ['A@x.ua', 'b@x.ua'], tz: 'Europe/Kyiv' });
    assert.equal(r.settings.digest_hour, 8);
    assert.equal(r.settings.instant_due, false);
    assert.deepEqual(r.settings.products, ['А', 'Б']);
    assert.deepEqual(r.settings.manager_emails, ['a@x.ua', 'b@x.ua']);
    const rows = f.store.all('settings');
    assert.equal(rows.filter((x) => x.key === 'digest_hour').length, 1);
    assert.equal(rows.find((x) => x.key === 'digest_hour').value, '8');
    assert.equal(rows.find((x) => x.key === 'instant_due').value, 'ні');
    assert.equal(rows.find((x) => x.key === 'products').value, 'А; Б');
    assert.ok(rows.find((x) => x.key === 'digest_hour').note.length > 0);
    f.setting({ digest_hour: 9 });
    assert.equal(f.store.all('settings').filter((x) => x.key === 'digest_hour').length, 1);
    assert.equal(f.app.settings().digest_hour, 9);
    const bad = (values) => f.admin('settings_save', { values }).error;
    assert.equal(bad({ digest_hour: 30 }), 'BAD_REQUEST');
    assert.equal(bad({ digest_hour: 'рано' }), 'BAD_REQUEST');
    assert.equal(bad({ unknown_key: 1 }), 'BAD_REQUEST');
    assert.equal(bad({ digest_mode: 'never' }), 'BAD_REQUEST');
    assert.equal(bad({ manager_emails: 'boss@, x' }), 'BAD_REQUEST');
    assert.equal(bad({ tz: 'Mars/Olympus' }), 'BAD_REQUEST');
    assert.equal(f.admin('settings_save', {}).error, 'BAD_REQUEST');
  });

  test('налаштування, відредаговані прямо в таблиці (мітки, зайві пробіли)', () => {
    const store = new MemoryStore();
    store.insert('settings', [
      { key: 'warn_days', value: ' 10 ' }, { key: 'instant_due', value: 'FALSE' }, { key: 'tz', value: 'Нісенітниця/Зона' },
      { key: 'stop_reasons', value: 'Перерва; Інше' }, { key: 'custom', value: 'x' }
    ]);
    const S = createApp(store, {}).settings();
    assert.equal(S.warn_days, 10);
    assert.equal(S.instant_due, false);
    assert.equal(S.tz, 'Europe/Kyiv', 'невідомий пояс → типовий');
    assert.deepEqual(S.stop_reasons, ['Перерва', 'Інше']);
    assert.equal(S.custom, 'x');
  });
});

describe('сповіщення та щоденний звіт', () => {
  test('dueAlerts: ключі, отримувачі, дедуплікація (Set / масив / обʼєкт)', () => {
    const f = utilisationFixture();
    const alerts = f.app.dueAlerts(new Date('2026-09-15T00:00:00Z'), new Set());
    assert.deepEqual(alerts.map((a) => a.key), ['due:RX:2026-09-01']);
    const a = alerts[0];
    assert.equal(a.kind, 'due');
    assert.deepEqual(a.to, ['boss@example.com', 'mech@example.com']);
    assert.match(a.subject, /^Настав строк ТО: Заміна фільтра — Лінія 1$/);
    assert.match(a.html, /перевищено на 10 мотогод/);
    assert.match(a.text, /Лінія 1/);
    assert.equal(f.app.dueAlerts(null, new Set(['due:RX:2026-09-01'])).length, 0);
    assert.equal(f.app.dueAlerts(null, ['due:RX:2026-09-01']).length, 0);
    assert.equal(f.app.dueAlerts(null, { 'due:RX:2026-09-01': true }).length, 0);
    // після виконання роботи ключ змінюється (новий відлік)
    f.ok(f.call('work', { id: 'wx', ts: '2026-09-11T00:00:00Z', line_id: 'L1', rule_id: 'RX' }));
    assert.equal(f.app.dueAlerts(null, ['due:RX:2026-09-01']).length, 0, 'після роботи строк ще не настав');
    f.setting({ instant_due: false });
    f.store.update('rules', [{ id: 'RS', interval_hours: 1 }]);
    assert.equal(f.app.dueAlerts(null, []).length, 0, 'instant_due вимкнено');
  });

  test('logNotices / sentKeys для хоста', () => {
    const f = fixture();
    f.app.logNotices([
      { key: 'due:R1:2026-09-01', kind: 'due', to: ['a@x.ua'], subject: 'Тема', status: 'sent' },
      { key: 'check:c1', kind: 'checklist', to: 'b@x.ua, c@x.ua', subject: 'Тема 2', status: 'error', error: 'Quota' }
    ]);
    const keys = f.app.sentKeys();
    assert.ok(keys.has('due:R1:2026-09-01'));
    assert.ok(!keys.has('check:c1'));
    const n = f.ok(f.admin('notices', { limit: 10 })).notices;
    assert.equal(n.length, 2);
    assert.equal(n[1].to, 'b@x.ua, c@x.ua');
    assert.equal(n[0].kind, 'due');
  });

  test('buildDigest: тихий день → has_content=false', () => {
    const f = fixture('2026-09-15T04:00:00Z');
    config(f);
    const d = f.app.buildDigest();
    assert.equal(d.subject, 'Облік ліній — звіт за 15.09.2026');
    assert.equal(d.has_content, false);
    assert.deepEqual(d.to, []);
    assert.match(d.html, /Стан ліній зараз/);
    assert.match(d.html, /Порушень і прострочених робіт немає/);
    assert.ok(!/Потрібно виконати/.test(d.html));
    const p = f.ok(f.admin('digest_preview'));
    assert.equal(p.has_content, false);
    assert.equal(p.subject, d.subject);
  });

  test('buildDigest: розділи, екранування, посилання', () => {
    const f = utilisationFixture();
    f.setting({ app_url: 'https://example.github.io/lines/', company: 'Соуси & Ко' });
    f.save('items', { id: 'XSS', line_id: 'L1', occasions: 'start', section: '<b>Розділ</b>', text: '<script>alert(1)</script>', type: 'check', required: false });
    f.setNow('2026-09-15T12:00:00Z');
    // вчора (14.09) запуск без чек-листа вже є (utilisationFixture) → uncovered
    f.ok(f.call('checklist', { id: 'cx', ts: '2026-09-15T05:00:00Z', line_id: 'L1', occasion: 'start',
      answers: [...START_OK, { item_id: 'XSS', value: 'fail', note: '"><img src=x onerror=alert(2)>' }], then_event: { state: 'run' } }));
    f.ev('rp', '2026-09-15T08:00:00Z', 'repair', { reason: 'Обрив <плівки>' });
    f.ev('rn', '2026-09-15T09:00:00Z', 'run');
    const d = f.app.buildDigest();
    assert.equal(d.has_content, true);
    assert.deepEqual(d.to, ['boss@example.com']);
    assert.equal(d.counts.due, 1);
    assert.equal(d.counts.soon, 1);
    assert.equal(d.counts.failed, 1);
    assert.equal(d.counts.repairs, 1);
    assert.equal(d.counts.uncovered, 1);
    for (const h of ['Потрібно виконати (1)', 'Скоро потрібно виконати (1)', 'Щоденні перевірки за вчора (14.09.2026)',
      'Зауваження в чек-листах за добу (1)', 'Ремонти та простої за добу', 'Стан ліній зараз']) {
      assert.ok(d.html.includes(h), h);
    }
    assert.ok(!d.html.includes('<script>'), 'скрипт екрановано');
    assert.ok(d.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!d.html.includes('<img'), 'атрибути екрановано');
    assert.ok(d.html.includes('&quot;&gt;&lt;img src=x onerror=alert(2)&gt;'));
    assert.ok(d.html.includes('Обрив &lt;плівки&gt;'));
    assert.ok(d.html.includes('Соуси &amp; Ко'));
    assert.ok(d.html.includes('href="https://example.github.io/lines/"'));
    assert.ok(!/<link|<style|class=/.test(d.html), 'лише inline-стилі');
    assert.match(d.text, /<script>alert\(1\)<\/script>/, 'текстова версія — без екранування');
    assert.match(d.text, /Відкрити застосунок: https:\/\/example\.github\.io\/lines\//);
    assert.match(d.text, /Без чек-листа або завершення/);
    // небезпечне посилання не вставляється
    f.setting({ app_url: 'javascript:alert(1)' });
    assert.ok(!f.app.buildDigest().html.includes('javascript:'));
  });
});

describe('seedDemo', () => {
  const NOW = new Date('2026-09-25T13:40:00Z');
  let seeded = null;
  const getSeeded = () => {
    if (!seeded) {
      const store = new MemoryStore();
      const summary = LinesCore.seedDemo(store, {}, { now: NOW });
      seeded = { store, summary, app: createApp(store, { now: () => NOW }) };
    }
    return seeded;
  };

  test('детермінованість: той самий now → ідентичні дані', () => {
    const a = new MemoryStore(), b = new MemoryStore();
    LinesCore.seedDemo(a, {}, { now: NOW });
    LinesCore.seedDemo(b, { now: () => NOW });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    const c = new MemoryStore();
    LinesCore.seedDemo(c, {}, { now: new Date('2026-09-26T13:40:00Z') });
    assert.notEqual(JSON.stringify(a), JSON.stringify(c));
  });

  test('зміст: лінії, агрегати, пункти, лічильники, регламенти, персонал', () => {
    const { store, summary } = getSeeded();
    assert.equal(summary.ok, true);
    const rows = (t) => store.all(t).map((r) => norm(t, r));
    const lines = rows('lines');
    assert.deepEqual(lines.map((l) => l.name), ['Лінія фасування №1 (ПЕТ-пляшка)', 'Лінія фасування №2 (дой-пак)', 'Етикетувальна лінія №3']);
    assert.deepEqual(lines.map((l) => l.kind), ['Фасувальна', 'Фасувальна', 'Етикетувальна']);
    for (const l of lines) {
      const n = rows('units').filter((u) => u.line_id === l.id).length;
      assert.ok(n >= 3 && n <= 4, l.id + ': 3–4 агрегати');
    }
    const items = rows('items');
    for (const occ of ['start', 'changeover', 'end']) assert.ok(items.some((i) => i.occasions.includes(occ)), occ);
    assert.ok(items.some((i) => i.text === 'Тиск повітря, бар' && i.min === 5.5 && i.max === 7));
    assert.ok(items.some((i) => i.text === 'Температура продукту, °C' && i.min === 18 && i.max === 30));
    assert.ok(items.some((i) => /^Контрольна маса дози, г/.test(i.text) && i.min === 298 && i.max === 306));
    assert.ok(items.some((i) => i.critical));
    assert.ok(items.some((i) => i.type === 'select' && i.options.some((o) => o.startsWith('!'))));
    const meters = rows('meters');
    assert.ok(meters.some((m) => m.name === 'Цикли дозатора' && m.mode === 'abs'));
    assert.ok(meters.some((m) => m.name === 'Вироблено' && m.unit_label === 'шт' && m.mode === 'inc' && m.ask_on_end));
    // одиниця — лише в «Од. виміру», не в назві (інакше «Вироблено, шт: 12 шт» / «…, шт за зміну»)
    for (const m of meters) assert.ok(!m.unit_label || !m.name.endsWith(', ' + m.unit_label), m.id + ': ' + m.name);
    assert.ok(meters.some((m) => m.name === 'Етикеток нанесено' && m.line_id === 'L3'));
    const rules = rows('rules');
    assert.ok(rules.length >= 7 && rules.length <= 10);
    assert.ok(rules.some((r) => r.interval_days > 0) && rules.some((r) => r.interval_hours > 0) && rules.some((r) => r.interval_meter > 0));
    const staff = rows('staff');
    assert.ok(staff.length >= 5 && staff.length <= 7);
    assert.deepEqual(staff.filter((s) => s.pin).map((s) => [s.role, s.pin]), [['operator', '1111']]);
    for (const role of ['operator', 'setter', 'mechanic', 'manager']) assert.ok(staff.some((s) => s.role === role), role);
    const S = createApp(store, { now: () => NOW }).settings();
    assert.deepEqual(S.products, LinesCore.DEMO_PRODUCTS);
    assert.equal(S.tz, 'Europe/Kyiv');
    assert.deepEqual(S.manager_emails, [], 'демо не надсилає листів');
  });

  test('стан на момент now: L1 працює, L2 не працює, L3 простій; строки ТО', () => {
    const { summary, app } = getSeeded();
    assert.deepEqual(summary.states, { L1: 'run', L2: 'off', L3: 'stop' });
    const b = app.handle({ action: 'bootstrap' }, {});
    assert.equal(b.status.L1.state, 'run');
    assert.equal(b.status.L2.state, 'off');
    assert.equal(b.status.L3.state, 'stop');
    assert.equal(b.status.L3.reason, 'Немає сировини / тари');
    assert.equal(b.status.L1.start_check_valid, true);
    assert.ok(b.status.L1.today_h > 0);
    const due = b.due.filter((d) => d.status === 'due').length, soon = b.due.filter((d) => d.status === 'soon').length;
    assert.ok(due >= 1, 'хоча б 1 due');
    assert.ok(soon >= 2, 'хоча б 2 soon');
    assert.equal(summary.due, due);
    assert.equal(summary.soon, soon);
    assert.ok(Object.values(b.avg_h).every((h) => h > 3 && h < 16));
  });

  test('історія: позначки, зауваження, роботи всіх видів, узгодженість мотогодин', () => {
    const { store, app } = getSeeded();
    const evs = store.all('events').map((r) => norm('events', r));
    const flags = evs.reduce((a, e) => { if (e.flag) a[e.flag] = (a[e.flag] || 0) + 1; return a; }, {});
    assert.ok(flags.no_checklist >= 2 && flags.no_checklist <= 3, 'кілька запусків без чек-листа');
    assert.ok(flags.forced >= 1);
    assert.ok(flags.no_end_checklist >= 1);
    const checks = store.all('checks').map((r) => norm('checks', r));
    assert.ok(checks.some((c) => c.result === 'remarks'));
    assert.ok(checks.some((c) => c.out_of_range > 0));
    assert.ok(checks.some((c) => c.occasion === 'changeover'));
    const works = store.all('works').map((r) => norm('works', r));
    for (const t of ['repair', 'changeover', 'clean', 'replace', 'lube']) assert.ok(works.some((w) => w.work_type === t), t);
    assert.ok(works.some((w) => w.rule_id), 'ТО за регламентом');
    for (const l of ['L1', 'L2', 'L3']) assert.ok(works.filter((w) => w.line_id === l && w.work_type === 'repair').length >= 1, l + ': ремонти');
    // службові поля узгоджені з повним перерахунком
    const before = JSON.stringify(store.all('events'));
    const lines = JSON.stringify(store.all('lines'));
    app.recomputeAll();
    assert.equal(JSON.stringify(store.all('events')), before);
    assert.equal(JSON.stringify(store.all('lines')), lines);
    // показники «Вироблено» з чек-листів завершення
    assert.ok(store.all('readings').map((r) => norm('readings', r)).some((r) => r.meter_id === 'M2' && r.mode === 'inc' && r.value > 1000));
    // панель і звіт працюють на демо-даних
    const dash = app.handle({ action: 'dashboard', days: 14 }, {});
    assert.equal(dash.ok, true);
    assert.ok(dash.issues.length > 0);
    assert.ok(Object.values(dash.compliance).flat().some((d) => d.status === 'ok'));
    const dg = app.buildDigest();
    assert.equal(dg.has_content, true);
  });

  test('у сховище з наявними налаштуваннями — без дублювання ключів', () => {
    const store = new MemoryStore();
    store.insert('settings', [{ key: 'tz', value: 'Europe/Kyiv', note: '' }, { key: 'products', value: '' }, { key: 'manager_emails', value: 'x@y.ua' }]);
    const s = LinesCore.seedDemo(store, {}, { now: NOW, days: 10 });
    const keys = store.all('settings').map((r) => r.key);
    assert.equal(new Set(keys).size, keys.length);
    const S = createApp(store, { now: () => NOW }).settings();
    assert.deepEqual(S.manager_emails, ['x@y.ua'], 'наявні значення не перезаписуються');
    assert.deepEqual(S.products, LinesCore.DEMO_PRODUCTS, 'порожній список продуктів заповнюється');
    assert.equal(s.days, 10);
    assert.deepEqual(s.states, { L1: 'run', L2: 'off', L3: 'stop' });
    assert.ok(s.due >= 1 && s.soon >= 2);
  });

  test('події кожної лінії вставлено в порядку часу (ТО до зміни не заходить на запуск); знімки мотогодин узгоджені', () => {
    for (const iso of ['2026-09-25T13:00:00Z', '2026-11-20T10:00:00Z', '2026-04-20T10:00:00Z']) {
      const store = new MemoryStore();
      LinesCore.seedDemo(store, {}, { now: iso, days: 45 });
      const app = createApp(store, { now: () => new Date(iso) });
      const last = {};
      for (const e of store.all('events').map((r) => norm('events', r))) {
        if (last[e.line_id]) assert.ok(e.ts >= last[e.line_id], iso + ': ' + e.id + ' раніше за попередню подію лінії');
        last[e.line_id] = e.ts;
      }
      for (const w of store.all('works').map((r) => norm('works', r))) {
        assert.ok(Math.abs(app.lineCumAt(w.line_id, w.ts) - w.hours_at) < 1e-3, iso + ': ' + w.id + ' hours_at');
      }
      // ТО перед зміною: запуск — лише після завершення обслуговування
      const evs = store.all('events').map((r) => norm('events', r));
      assert.ok(!evs.some((e) => e.state === 'stop' && e.prev_state === 'off'), iso + ': «Простій» після «Не працює»');
    }
  });

  test('різний час доби «now» (ніч, ранок, вихідний) — стани ліній гарантовані', () => {
    for (const iso of ['2026-09-24T21:10:00Z', '2026-09-25T03:30:00Z', '2026-09-27T09:00:00Z', '2026-10-25T02:00:00Z']) {
      const store = new MemoryStore();
      const s = LinesCore.seedDemo(store, {}, { now: iso, days: 14 });
      assert.deepEqual(s.states, { L1: 'run', L2: 'off', L3: 'stop' }, iso);
      const b = createApp(store, { now: () => new Date(iso) }).bootstrap({});
      assert.equal(b.status.L1.state, 'run', iso);
      assert.equal(b.status.L2.state, 'off', iso);
      assert.equal(b.status.L3.state, 'stop', iso);
    }
  });
});

/* ================================================================== */
/* Регресійні тести за результатами рецензії (час / мотогодини, ТО, контракт) */

describe('рецензія: знімки мотогодин (works.hours_at, rules.last_hours, відліки)', () => {
  test('анулювання помилкової події: hours_at роботи та last_hours регламенту перераховуються; recompute лагодить зіпсовані', () => {
    const f = fixture('2026-09-01T00:00:00Z');
    config(f, { rules: [{ id: 'RV', line_id: 'L1', title: 'Заміна ущільнювачів', work_type: 'replace', interval_hours: 100 }] });
    f.setNow('2026-09-12T12:00:00Z');
    f.ev('e1', '2026-09-10T06:00:00Z', 'run');            // помилковий «Працює»
    f.ev('e2', '2026-09-12T10:00:00Z', 'off', { ref_id: 'x' });
    const w = f.ok(f.call('work', { id: 'w1', ts: '2026-09-12T10:30:00Z', line_id: 'L1', rule_id: 'RV' }));
    assert.equal(w.work.hours_at, 52);
    f.ok(f.admin('void', { table: 'events', id: 'e1', note: 'помилка' }));
    assert.equal(f.app.lineCumAt('L1'), 0);
    assert.equal(f.row('works', 'w1').hours_at, 0);
    assert.equal(f.row('rules', 'RV').last_hours, 0);
    const d = f.app.computeDue('RV');
    assert.equal(d.criteria[0].used, 0);
    assert.equal(d.criteria[0].left, 100, 'без «фантомних» 52 мотогод');
    // адмін-перерахунок відновлює зіпсовані знімки
    f.store.update('works', [{ id: 'w1', hours_at: 77 }]);
    f.store.update('rules', [{ id: 'RV', last_hours: 77 }]);
    f.ok(f.admin('recompute'));
    assert.equal(f.row('works', 'w1').hours_at, 0);
    assert.equal(f.row('rules', 'RV').last_hours, 0);
    f.store.update('works', [{ id: 'w1', hours_at: 5 }]);
    f.app.recomputeLine('L1');
    assert.equal(f.row('works', 'w1').hours_at, 0, 'recomputeLine теж перераховує знімки робіт');
  });

  test('події з офлайн-черги після роботи (швидкий і повільний шлях) оновлюють hours_at і last_hours', () => {
    const f = fixture('2026-09-01T00:00:00Z');
    config(f, { rules: [{ id: 'RL', line_id: 'L1', title: 'Змащення', work_type: 'lube', interval_hours: 40 }] });
    f.setNow('2026-09-15T18:00:00Z');
    f.ok(f.call('work', { id: 'w1', ts: '2026-09-15T09:00:00Z', line_id: 'L1', rule_id: 'RL' }));
    assert.equal(f.row('works', 'w1').hours_at, 0);
    f.ev('e1', '2026-09-15T05:00:00Z', 'run');                    // швидкий шлях, але із запізненням
    assert.equal(f.row('works', 'w1').hours_at, 4);
    assert.equal(f.row('rules', 'RL').last_hours, 4);
    f.ev('e2', '2026-09-15T15:00:00Z', 'off', { ref_id: 'x' });
    assert.equal(f.app.computeDue('RL').criteria[0].used, 6, '6 год після змащення, а не 10');
    f.ev('e3', '2026-09-15T07:00:00Z', 'stop');                   // повільний шлях — вставка в середину
    assert.equal(f.row('works', 'w1').hours_at, 2);
    assert.equal(f.row('rules', 'RL').last_hours, 2);
    assert.equal(f.app.computeDue('RL').criteria[0].used, 0);
    f.ok(f.admin('recompute'));
    assert.equal(f.row('works', 'w1').hours_at, 2, 'recompute стабільний');
  });

  test('відлік агрегата і регламенту, створених до надходження ранішніх подій, не отримує чужих мотогодин', () => {
    const f = fixture('2026-09-15T12:00:00Z');
    config(f, { rules: [{ id: 'RB', line_id: 'L1', title: 'Огляд', work_type: 'inspect', interval_hours: 100 }] });
    assert.equal(f.row('units', 'U1').base_cum, 0);
    f.setNow('2026-09-15T18:00:00Z');
    f.ev('a', '2026-09-15T05:00:00Z', 'run');                     // лінія працює з 05:00 (черга планшета)
    assert.equal(f.row('units', 'U1').base_cum, 7, 'мотогодини лінії на момент додавання (12:00)');
    assert.equal(f.call('bootstrap').units.find((u) => u.id === 'U1').hours, 106, '100 + 6 год після додавання');
    assert.equal(f.row('rules', 'RB').base_hours, 7);
    assert.equal(f.app.computeDue('RB').criteria[0].used, 6);
  });

  test('робота, внесена прямо в таблицю: recompute один раз зберігає знімки, bootstrap не читає весь журнал', () => {
    const f = utilisationFixture();
    f.store.insert('works', [{ id: 'hand1', ts: '12.09.2026 10:00', line_id: 'L1', rule_id: 'RM', work_type: 'Заміна деталі', title: 'Заміна поршня', status: 'Виконано' }]);
    f.ok(f.admin('recompute'));
    const r = f.row('rules', 'RM');
    assert.equal(r.last_work_id, 'hand1');
    assert.equal(r.last_hours, f.app.lineCumAt('L1', new Date('2026-09-12T07:00:00Z')));
    assert.equal(r.last_meter, 1600);
    assert.equal(f.row('works', 'hand1').hours_at, r.last_hours);
    assert.equal(f.row('works', 'hand1').meter_at, 1600);
    const calls = [];
    const oa = f.store.all.bind(f.store), os = f.store.since.bind(f.store);
    f.store.all = (t) => { calls.push('all:' + t); return oa(t); };
    f.store.since = (t, d) => { calls.push('since:' + t + ':' + Math.round((ms(f.now) - ms(d)) / DAY)); return os(t, d); };
    f.ok(f.call('bootstrap'));
    assert.ok(!calls.some((c) => /^all:(events|readings|works|checks)$/.test(c)), calls.join(' '));
    assert.ok(!calls.some((c) => /^since:(events|readings):(\d+)$/.test(c) && +RegExp.$2 > 10), calls.join(' '));
  });
});

describe('рецензія: час і пояси', () => {
  test('рушій без Europe/Kyiv (старий ICU): синонім Europe/Kiev, bootstrap і seedDemo працюють', () => {
    const RealDTF = Intl.DateTimeFormat;
    function OldDTF(loc, opts) {
      if (opts && opts.timeZone === 'Europe/Kyiv') throw new RangeError('Invalid time zone specified: Europe/Kyiv');
      return new RealDTF(loc, opts);
    }
    OldDTF.prototype = RealDTF.prototype;
    const C = loadCoreAsGlobalScript({ Intl: { DateTimeFormat: OldDTF } }).LinesCore;
    const now = new Date('2026-09-15T12:00:00Z');
    const app = C.createApp(new C.MemoryStore(), { now: () => now });
    assert.equal(app.handle({ action: 'save', table: 'lines', row: { id: 'L1', name: 'Лінія' } }, { admin: true }).ok, true);
    const b = app.handle({ action: 'bootstrap' }, {});
    assert.equal(b.ok, true, JSON.stringify(b).slice(0, 200));
    assert.equal(b.settings.tz, 'Europe/Kiev');
    assert.equal(app.handle({ action: 'settings_save', values: { tz: 'Europe/Kyiv' } }, { admin: true }).ok, true, 'Europe/Kyiv приймається');
    assert.equal(new Date(C.norm('events', { ts: '25.09.2026 07:30' }).ts).toISOString(), '2026-09-25T04:30:00.000Z');
    const s = C.seedDemo(new C.MemoryStore(), {}, { now, days: 5 });
    assert.equal(s.ok, true);
    // зовсім невідомий пояс → UTC, а не падіння
    function NoTz(loc, opts) { if (opts && opts.timeZone && opts.timeZone !== 'UTC') throw new RangeError('Invalid time zone'); return new RealDTF(loc, opts); }
    NoTz.prototype = RealDTF.prototype;
    const C2 = loadCoreAsGlobalScript({ Intl: { DateTimeFormat: NoTz } }).LinesCore;
    const b2 = C2.createApp(new C2.MemoryStore(), { now: () => now }).handle({ action: 'bootstrap' }, {});
    assert.equal(b2.ok, true);
    assert.equal(b2.settings.tz, 'UTC');
  });

  test('з env.dayKey/dayStart (Utilities у GAS) Intl не використовується взагалі', () => {
    let intl = 0;
    const RealDTF = Intl.DateTimeFormat;
    function CountDTF(loc, opts) { intl++; return new RealDTF(loc, opts); }
    CountDTF.prototype = RealDTF.prototype;
    const C = loadCoreAsGlobalScript({ Intl: { DateTimeFormat: CountDTF } }).LinesCore;
    const OFF = 3 * HOUR;
    const env = {
      now: () => new Date('2026-09-25T09:00:00Z'),
      dayKey: (d) => new Date(d.getTime() + OFF).toISOString().slice(0, 10),
      dayStart: (k) => new Date(Date.parse(k + 'T00:00:00Z') - OFF)
    };
    const st = new C.MemoryStore();
    st.insert('lines', [{ id: 'L1', name: 'Лінія 1', active: true }]);
    const app = C.createApp(st, env);
    const r = app.handle({ action: 'event', id: 'e1', line_id: 'L1', state: 'repair', reason: 'x', ts: '25.09.2026 11:15' }, {});
    assert.equal(r.ok, true);
    assert.equal(r.event.ts, '2026-09-25T08:15:00.000Z');
    assert.match(r._notify[0].text, /25\.09\.2026 11:15/);
    assert.equal(app.handle({ action: 'dashboard', days: 3 }, {}).ok, true);
    assert.equal(intl, 0, 'Intl.DateTimeFormat не створювався');
  });

  test('календарний інтервал через перехід на літній / зимовий час — та сама дата й час доби', () => {
    const f = fixture('2026-02-20T00:00:00Z');
    config(f, { rules: [{ id: 'RC', line_id: 'L1', title: 'ТО', work_type: 'to', interval_days: 30 }] });
    f.setNow('2026-03-02T00:00:00Z');
    f.ok(f.call('work', { id: 'w1', ts: '2026-03-01T21:30:00Z', line_id: 'L1', rule_id: 'RC' }));   // 01.03 23:30 EET
    const K = f.app.timeKit();
    let d = f.app.computeDue('RC');
    assert.equal(K.fmtDT(d.due_date), '31.03.2026 23:30', '30 календарних днів, той самий час доби');
    const p = f.app.buildPlan('2026-03-02', '2026-06-01');
    assert.deepEqual(p.items.filter((i) => i.rule_id === 'RC').map((i) => i.day), ['2026-03-31', '2026-04-30', '2026-05-30']);
    // рівно на строк — 100 %
    f.setNow(d.due_date);
    d = f.app.computeDue('RC');
    assert.equal(d.status, 'due');
    assert.equal(d.criteria[0].used, 30);
    // восени: 01.10 00:30 EEST + 30 днів = 31.10 00:30 EET
    const g = fixture('2026-09-25T00:00:00Z');
    config(g, { rules: [{ id: 'RC', line_id: 'L1', title: 'ТО', work_type: 'to', interval_days: 30 }] });
    g.setNow('2026-10-01T00:00:00Z');
    g.ok(g.call('work', { id: 'w1', ts: '2026-09-30T21:30:00Z', line_id: 'L1', rule_id: 'RC' }));
    assert.equal(g.app.timeKit().fmtDT(g.app.computeDue('RC').due_date), '31.10.2026 00:30');
  });

  test('годинник планшета скинуто: дуже давній час запису відхиляється (BAD_REQUEST), робота — до року назад', () => {
    const f = fixture('2026-09-15T18:00:00Z');
    config(f);
    f.ev('e1', '2026-09-15T05:00:00Z', 'run');
    const bad = f.call('event', { id: 'old', ts: '2000-01-01T08:00:00Z', line_id: 'L1', state: 'run' });
    assert.equal(bad.error, 'BAD_REQUEST');
    assert.match(bad.message, /01\.01\.2000/);
    assert.equal(f.row('lines', 'L1').cur_event, 'e1');
    assert.equal(f.app.lineCumAt('L1'), 13, 'мотогодини не роздулися');
    assert.equal(f.call('checklist', { id: 'oc', ts: '2026-07-01T05:00:00Z', line_id: 'L1', occasion: 'start', answers: START_OK }).error, 'BAD_REQUEST');
    assert.equal(f.call('reading', { id: 'or', ts: '2026-07-01T05:00:00Z', meter_id: 'M2', value: 1 }).error, 'BAD_REQUEST');
    assert.equal(f.rows('checks').length + f.rows('readings').length, 0);
    assert.equal(f.call('work', { id: 'ow', ts: '2024-01-01T05:00:00Z', line_id: 'L1', work_type: 'repair' }).error, 'BAD_REQUEST');
    f.ok(f.call('work', { id: 'w1', ts: '2026-05-01T05:00:00Z', line_id: 'L1', work_type: 'repair', title: 'Архівний ремонт' }));
    f.ok(f.call('event', { id: 'ok44', ts: '2026-08-02T05:00:00Z', line_id: 'L1', state: 'clean' }));
  });

  test('long_run / work_since: початок роботи раніше за вікно подій', () => {
    const f = fixture('2026-09-14T12:00:00Z');
    config(f);
    f.setNow('2026-09-15T18:00:00Z');
    f.ev('e1', '2026-09-14T19:00:00Z', 'run');
    f.ev('e2', '2026-09-15T08:00:00Z', 'stop', { reason: 'Перерва' });
    const r = f.ev('e3', '2026-09-15T08:30:00Z', 'run');
    assert.equal(r.status.work_since, '2026-09-14T19:00:00.000Z');
    assert.equal(r.status.long_run, true);
    assert.equal(f.app.lineStatus('L1').long_run, true);
    const d = f.ok(f.call('dashboard', { days: 1 }));
    assert.equal(d.status.L1.work_since, '2026-09-14T19:00:00.000Z');
    assert.equal(d.status.L1.long_run, true);
    assert.equal(f.call('bootstrap').status.L1.long_run, true);
  });

  test('причина / продукт стану, що переходить у вікно, не втрачаються (статистика, таймлайн, панель)', () => {
    const f = fixture('2026-09-14T12:00:00Z');
    config(f);
    f.setNow('2026-09-15T12:00:00Z');
    f.ev('a', '2026-09-14T15:00:00Z', 'run', { product: 'Кетчуп 300 г' });
    f.ev('b', '2026-09-14T19:00:00Z', 'stop', { reason: 'Немає сировини / тари' });   // 22:00 за Києвом
    f.ev('c', '2026-09-14T23:00:00Z', 'run');                                          // 02:00 15.09
    const st = f.app.stats('2026-09-15', '2026-09-15', ['L1']).L1;
    assert.deepEqual(st.stops_by_reason, { 'Немає сировини / тари': 2 });
    assert.equal(st.starts, 0);
    const lv = f.ok(f.call('line', { line_id: 'L1', days: 1 }));
    assert.deepEqual(lv.timeline.map((s) => [s.state, s.hours, s.reason, s.product]),
      [['stop', 2, 'Немає сировини / тари', 'Кетчуп 300 г'], ['run', 13, '', 'Кетчуп 300 г']]);
    assert.deepEqual(lv.events.map((e) => e.id), ['c'], 'подія до вікна не потрапляє у список');
    const d = f.ok(f.call('dashboard', { days: 1 }));
    assert.deepEqual(d.stats.L1.stops_by_reason, { 'Немає сировини / тари': 2 });
    // лінія стоїть кілька днів без подій у вікні
    const g = fixture('2026-09-10T00:00:00Z');
    config(g);
    g.setNow('2026-09-12T12:00:00Z');
    g.ev('s', '2026-09-12T06:00:00Z', 'stop', { reason: 'Очікування' });
    g.setNow('2026-09-15T12:00:00Z');
    assert.deepEqual(g.app.stats('2026-09-15', '2026-09-15', ['L1']).L1.stops_by_reason, { 'Очікування': 15 });
  });

  test('середнє напрацювання нової лінії (без «Створено») — від дня першої події', () => {
    const f = fixture('2026-09-01T00:00:00Z');
    f.store.insert('lines', [{ id: 'L1', name: 'Лінія з таблиці' }]);
    f.store.insert('rules', [{ id: 'R1', line_id: 'L1', title: 'Заміна', interval_hours: 100, base_hours: 0, base_date: '01.09.2026' }]);
    for (const d of ['12', '13', '14']) {
      f.setNow(`2026-09-${d}T21:00:00Z`);
      f.ev('r' + d, `2026-09-${d}T04:00:00Z`, 'run');
      f.ev('o' + d, `2026-09-${d}T20:00:00Z`, 'off', { ref_id: 'x' });
    }
    f.setNow('2026-09-15T00:00:00Z');
    const b = f.call('bootstrap');
    assert.ok(b.avg_h.L1 > 14 && b.avg_h.L1 < 17, 'avg_h ' + b.avg_h.L1);
    const d = b.due.find((x) => x.rule_id === 'R1');
    assert.ok(d.due_date < '2026-09-20', 'прогноз ~ за 3 доби, а не через місяць: ' + d.due_date);
  });
});

describe('рецензія: строки ТО, план, сповіщення', () => {
  test('прострочене за мотогодинами (лінія стоїть): строк — коли поріг перейдено за журналом; завжди потрапляє в план', () => {
    const f = fixture('2026-08-01T00:00:00Z');
    config(f, { rules: [
      { id: 'RA', line_id: 'L1', title: 'Заміна фільтра', work_type: 'replace', interval_days: 30, interval_hours: 10 },
      { id: 'RB', line_id: 'L1', title: 'Заміна ущільнювачів', work_type: 'replace', interval_hours: 10 }
    ] });
    f.setting({ avg_window_days: 7 });
    f.setNow('2026-08-02T20:00:00Z');
    f.ev('r', '2026-08-02T06:00:00Z', 'run');
    f.ev('o', '2026-08-02T18:00:00Z', 'off', { ref_id: 'x' });
    f.setNow('2026-08-20T06:00:00Z');
    const due = Object.fromEntries(f.app.dueAll().map((d) => [d.rule_id, d]));
    for (const id of ['RA', 'RB']) {
      assert.equal(due[id].status, 'due');
      assert.equal(due[id].due_date.toISOString(), '2026-08-02T16:00:00.000Z', id + ': 10 мотогод набралося о 16:00 02.08');
      assert.equal(due[id].due_basis, 'hours');
      assert.equal(due[id].forecast, false);
    }
    const p = f.app.buildPlan();
    const by = (id) => p.items.filter((i) => i.rule_id === id);
    assert.deepEqual(by('RA').slice(0, 2).map((i) => [i.day, i.overdue, i.basis]), [['2026-08-20', true, 'hours'], ['2026-09-19', false, 'days']]);
    assert.deepEqual(by('RB').map((i) => [i.day, i.overdue]), [['2026-08-20', true]], 'одне прострочене входження без повторів');
    assert.equal(p.rules.find((r) => r.rule_id === 'RB').note, 'Немає даних про напрацювання для прогнозу');
    const rows = f.app.planRows();
    assert.match(rows.find((r) => r.rule_id === 'RA').basis, /^Прострочено · Прогноз за мотогодинами/);
    assert.ok(rows.some((r) => r.rule_id === 'RB'));
  });

  test('короткий інтервал (≤ warn_days): одразу після виконання — «У нормі», «Скоро» — з 90 %', () => {
    const f = fixture('2026-09-01T00:00:00Z');
    config(f, { rules: [
      { id: 'LUBE', line_id: 'L1', title: 'Змащення ланцюга', work_type: 'lube', interval_days: 7 },
      { id: 'HEAD', line_id: 'L1', title: 'Очищення головки', work_type: 'clean', interval_days: 3 },
      { id: 'H40', line_id: 'L1', title: 'Змащення 40 мотогод', work_type: 'lube', interval_hours: 40 },
      { id: 'M30', line_id: 'L1', title: 'ТО-1', work_type: 'to', interval_days: 30 }
    ] });
    for (let d = 2; d <= 14; d++) {
      const day = `2026-09-${String(d).padStart(2, '0')}`;
      f.setNow(`${day}T15:00:00Z`);
      f.ev('r' + d, `${day}T06:00:00Z`, 'run');
      f.ev('o' + d, `${day}T14:00:00Z`, 'off', { ref_id: 'x' });
    }
    f.setNow('2026-09-15T00:00:00Z');
    for (const id of ['LUBE', 'HEAD', 'H40', 'M30']) f.ok(f.call('work', { id: 'w' + id, ts: '2026-09-15T00:00:00Z', line_id: 'L1', rule_id: id }));
    const st = () => Object.fromEntries(f.app.dueAll().map((d) => [d.rule_id, d.status]));
    assert.deepEqual(st(), { LUBE: 'ok', HEAD: 'ok', H40: 'ok', M30: 'ok' });
    assert.equal(f.app.buildDigest().counts.soon, 0);
    f.setNow('2026-09-21T08:00:00Z');   // 6,33 з 7 днів = 90,5 %
    assert.equal(st().LUBE, 'soon');
    f.setNow('2026-09-17T00:00:00Z');
    assert.equal(st().LUBE, 'ok');
    f.setNow('2026-10-08T00:00:00Z');   // 30-денний: за 7 днів — «Скоро» (warn_days < інтервалу)
    assert.equal(st().M30, 'soon');
  });

  test('ключ сповіщення: друге прострочення після роботи в той самий день не губиться', () => {
    const f = fixture('2026-09-01T03:00:00Z');
    config(f);
    f.setNow('2026-09-01T03:00:00Z');
    f.ev('r0', '2026-09-01T03:00:00Z', 'run');
    f.save('rules', { id: 'F', line_id: 'L1', title: 'Фільтр', work_type: 'replace', interval_hours: 500, used_hours: 520 });
    const a1 = f.app.dueAlerts(new Date('2026-09-01T03:00:00Z'), []);
    assert.deepEqual(a1.map((a) => a.key), ['due:F:2026-09-01']);
    f.ok(f.call('work', { id: 'w1', ts: '2026-09-01T07:00:00Z', line_id: 'L1', rule_id: 'F' }));
    f.setNow('2026-09-22T12:00:00Z');   // 509 мотогод від заміни
    const d = f.app.computeDue('F');
    assert.equal(d.status, 'due');
    const a2 = f.app.dueAlerts(null, ['due:F:2026-09-01']);
    assert.deepEqual(a2.map((a) => a.key), ['due:F:2026-09-01:w1']);
  });

  test('допоміжні поля регламенту з історією робіт — відмова, а не тихий «успіх»', () => {
    const f = utilisationFixture();
    f.ok(f.call('work', { id: 'w1', ts: '2026-09-10T00:00:00Z', line_id: 'L1', rule_id: 'RD' }));
    const r = f.admin('save', { table: 'rules', row: { id: 'RD', last_done_date: '14.09.2026' } });
    assert.equal(r.error, 'BAD_REQUEST');
    assert.match(r.message, /журналі робіт/);
    assert.equal(f.row('rules', 'RD').base_date.toISOString(), '2026-09-01T00:00:00.000Z', 'нічого не змінено');
    assert.equal(f.admin('save', { table: 'rules', row: { id: 'RD', used_hours: 5 } }).error, 'BAD_REQUEST');
    f.ok(f.admin('save', { table: 'rules', row: { id: 'RD', title: 'ТО-1 (оновлено)' } }));
    // без історії — як раніше
    assert.equal(f.save('rules', { id: 'RH', used_hours: 10 }).base_hours, 40);
  });

  test('рядок регламенту з таблиці: «Відлік від дати» без «Відлік мотогодин» / «Відлік лічильника»', () => {
    const f = utilisationFixture();
    f.store.insert('rules', [
      { id: 'SH1', line_id: 'L1', title: 'За мотогодинами', interval_hours: 100, base_date: '10.09.2026' },
      { id: 'SH2', line_id: 'L1', title: 'За лічильником', meter_id: 'M1', interval_meter: 5000, base_date: '10.09.2026' },
      { id: 'SH3', line_id: 'L1', title: 'Лише створено', interval_hours: 100, created: '12.09.2026' }
    ]);
    const due = Object.fromEntries(f.app.dueAll().map((d) => [d.rule_id, d]));
    const cum = (iso) => f.app.lineCumAt('L1', new Date(iso));
    assert.equal(due.SH1.criteria[0].used, 50 - cum('2026-09-09T21:00:00Z'));
    assert.equal(due.SH1.status, 'ok');
    assert.equal(due.SH2.criteria[0].used, 800, '2000 − 1200 (показник на 10.09 00:00 за Києвом)');
    assert.equal(due.SH3.criteria[0].used, 50 - cum('2026-09-11T21:00:00Z'));
    assert.equal(f.app.dueAlerts(null, []).filter((a) => /SH/.test(a.key)).length, 0, 'немає хибних листів');
    assert.equal(f.row('rules', 'SH2').base_meter, 1200, 'відлік збережено');
  });

  test('warn_pct, введений у таблиці як «90%» (0,9) — це 90 %', () => {
    const f = utilisationFixture();
    f.store.insert('rules', [{ id: 'P1', line_id: 'L1', title: 'x', interval_days: 140, warn_pct: 0.9, base_date: '01.09.2026' }]);
    assert.equal(f.app.computeDue('P1').status, 'ok', '10 % < 90 %');
    f.store.update('rules', [{ id: 'P1', warn_pct: 0.05 }]);
    assert.equal(f.app.computeDue('P1').status, 'soon', '10 % ≥ 5 %');
    const s = new MemoryStore();
    s.insert('settings', [{ key: 'warn_pct', value: 0.9 }]);
    assert.equal(createApp(s, {}).settings().warn_pct, 90);
    assert.equal(util.coerceSetting('warn_pct', '75%'), 75);
    assert.equal(f.save('rules', { id: 'P2', line_id: 'L1', title: 'y', interval_days: 10, warn_pct: 0.8 }).warn_pct, 80);
    assert.equal(f.setting({ warn_pct: '0,85' }).settings.warn_pct, 85);
  });
});

describe('рецензія: щоденні перевірки', () => {
  test('запуск через «Налаштування» / ремонт без чек-листа запуску — теж запуск і no_checklist', () => {
    const f = fixture('2026-09-15T04:00:00Z');
    config(f);
    f.setNow('2026-09-15T18:00:00Z');
    f.ev('s', '2026-09-15T05:00:00Z', 'setup');
    f.ok(f.call('checklist', { id: 'c1', ts: '2026-09-15T05:20:00Z', line_id: 'L1', occasion: 'changeover',
      answers: [{ item_id: 'I7', value: '300' }], then_event: { state: 'run' } }));
    let e = f.row('events', 'c1-e');
    assert.equal(e.prev_state, 'setup');
    assert.equal(e.starts, 1);
    assert.equal(e.flag, 'no_checklist');
    // переналаштування посеред зміни — не запуск
    f.ev('s2', '2026-09-15T09:00:00Z', 'setup');
    const r2 = f.ev('r2', '2026-09-15T09:30:00Z', 'run');
    assert.equal(r2.event.starts, 1);
    assert.equal(r2.event.flag, '');
    f.ok(f.call('checklist', { id: 'c2', ts: '2026-09-15T15:00:00Z', line_id: 'L1', occasion: 'end',
      answers: [{ item_id: 'I6', value: 'ok' }], then_event: { state: 'off' } }));
    const day = f.app.compliance('2026-09-15', '2026-09-15', ['L1']).L1[0];
    assert.equal(day.starts, 1);
    assert.equal(day.status, 'miss');
    assert.equal(day.covered, 0);
    assert.equal(f.ok(f.call('dashboard', { days: 1 })).compliance_pct.L1, 0);
    assert.equal(f.app.stats('2026-09-15', '2026-09-15', ['L1']).L1.starts, 1);
    // forced без жодного чек-листа запуску — не «покрито»
    f.setNow('2026-09-16T18:00:00Z');
    assert.equal(f.ev('x', '2026-09-16T05:00:00Z', 'run', { forced: true }).event.flag, 'no_checklist');
    // ремонт після невдалого чек-листа запуску, потім запуск — запуск покрито тим чек-листом
    f.ev('xo', '2026-09-16T06:00:00Z', 'off', { ref_id: 'x' });
    f.ok(f.call('checklist', { id: 'c3', ts: '2026-09-16T07:00:00Z', line_id: 'L1', occasion: 'start',
      answers: START_OK.map((a) => (a.item_id === 'I1' ? { ...a, value: 'fail' } : a)), then_event: { state: 'repair' } }));
    const rr = f.ev('rr', '2026-09-16T08:00:00Z', 'run');
    assert.equal(rr.event.flag, '');
    assert.equal(rr.event.starts, 3);
    // повний перерахунок дає те саме
    const before = JSON.stringify(f.store.all('events'));
    f.app.recomputeLine('L1');
    assert.equal(JSON.stringify(f.store.all('events')), before);
  });

  test('після «Не працює» чек-лист запуску вже не чинний: наступна зміна проходить новий (статус, позначки, перерахунок)', () => {
    const f = fixture('2026-09-15T05:00:00Z');
    config(f);
    const st = () => f.ok(f.call('bootstrap')).status.L1;
    f.ok(f.call('checklist', { id: 'c1', ts: '2026-09-15T05:00:00Z', line_id: 'L1', occasion: 'start', answers: START_OK }));
    f.setNow('2026-09-15T05:30:00Z');
    assert.equal(st().start_check_valid, true, 'чек-лист пройдено, лінія ще не запускалася');
    // «Зберегти без запуску», запуск пізніше — той самий чек-лист
    assert.equal(f.ev('r1', '2026-09-15T05:30:00Z', 'run').event.flag, '');
    f.setNow('2026-09-15T09:00:00Z');
    f.ev('p1', '2026-09-15T08:00:00Z', 'stop', { reason: 'Перерва' });
    assert.equal(f.ev('r2', '2026-09-15T08:30:00Z', 'run').event.flag, '', 'відновлення після простою — не запуск');
    assert.equal(st().start_check_valid, true);
    // завершення роботи через чек-лист завершення
    f.ok(f.call('checklist', { id: 'e1', ts: '2026-09-15T09:00:00Z', line_id: 'L1', occasion: 'end',
      answers: [{ item_id: 'I6', value: 'ok' }], then_event: { state: 'off' } }));
    f.setNow('2026-09-15T10:00:00Z');
    let s = st();
    assert.equal(s.state, 'off');
    assert.equal(s.start_check_valid, false, 'чек-лист 05:00 чинний лише до завершення роботи');
    assert.equal(f.app.lineStatus('L1').start_check_valid, false);
    // ТО після зміни, потім «Запустити» — це запуск без чек-листа
    f.ev('m1', '2026-09-15T09:30:00Z', 'maint');
    const r3 = f.ev('r3', '2026-09-15T10:00:00Z', 'run', { operator: 'Сергій' });
    assert.equal(r3.event.flag, 'no_checklist');
    assert.equal(r3.event.starts, 2);
    const day = f.app.compliance('2026-09-15', '2026-09-15', ['L1']).L1[0];
    assert.deepEqual([day.starts, day.covered, day.status], [2, 1, 'miss']);
    // новий чек-лист після завершення — запуск покрито (пізніше надійшов із черги планшета)
    f.setNow('2026-09-15T10:30:00Z');
    f.ok(f.call('checklist', { id: 'c2', ts: '2026-09-15T09:59:00Z', line_id: 'L1', occasion: 'start', answers: START_OK }));
    assert.equal(f.row('events', 'r3').flag, '');
    assert.equal(st().start_check_valid, true);
    // пізній чек-лист не покриває запуск ПІСЛЯ наступного завершення
    f.setNow('2026-09-15T12:00:00Z');
    f.ev('o2', '2026-09-15T11:00:00Z', 'off', { ref_id: 'x' });
    assert.equal(f.ev('r4', '2026-09-15T11:30:00Z', 'run').event.flag, 'no_checklist');
    f.setNow('2026-09-15T12:30:00Z');
    f.ok(f.call('checklist', { id: 'c3', ts: '2026-09-15T10:59:00Z', line_id: 'L1', occasion: 'start', answers: START_OK }));
    assert.equal(f.row('events', 'r4').flag, 'no_checklist', 'між чек-листом і запуском лінія завершила роботу');
    // «Не працює», що надійшло із запізненням (офлайн-черга), знімає чинність і з уже записаного запуску
    f.ok(f.call('checklist', { id: 'c4', ts: '2026-09-15T12:30:00Z', line_id: 'L1', occasion: 'start', answers: START_OK, then_event: { state: 'run' } }));
    assert.equal(f.row('events', 'c4-e').flag, '');
    f.ev('o3', '2026-09-15T11:45:00Z', 'off', { ref_id: 'x' });                  // r4 → off 11:45 → c4 12:30 → run: покрито
    assert.equal(f.row('events', 'c4-e').flag, '');
    f.setNow('2026-09-15T14:00:00Z');
    f.ev('o4', '2026-09-15T13:00:00Z', 'off', { ref_id: 'x' });
    f.ev('r5', '2026-09-15T13:30:00Z', 'run');
    assert.equal(f.row('events', 'r5').flag, 'no_checklist');
    // анулювання «Не працює» повертає чинність чек-листа c4
    f.ok(f.admin('void', { table: 'events', id: 'o4', note: 'Помилково' }));
    assert.equal(f.row('events', 'r5').flag, '', 'після анулювання r5 — продовження роботи');
    // повний перерахунок дає те саме, що й покрокові записи
    const before = JSON.stringify(f.store.all('events'));
    f.app.recomputeLine('L1');
    assert.equal(JSON.stringify(f.store.all('events')), before);
  });

  test('чек-лист запуску, що прийшов після події запуску, знімає no_checklist', () => {
    const f = fixture('2026-09-15T06:00:00Z');
    config(f);
    assert.equal(f.ev('e1', '2026-09-15T05:00:00Z', 'run').event.flag, 'no_checklist');
    f.ok(f.call('checklist', { id: 'c1', ts: '2026-09-15T04:50:00Z', line_id: 'L1', occasion: 'start', answers: START_OK }));
    assert.equal(f.row('events', 'e1').flag, '');
    const day = f.app.compliance('2026-09-15', '2026-09-15', ['L1']).L1[0];
    assert.deepEqual([day.status, day.covered], ['ok', 1]);
    f.app.recomputeLine('L1');
    assert.equal(f.row('events', 'e1').flag, '', 'той самий результат, що й повний перерахунок');
  });

  test('«Н/З» на критичному пункті — не норма: результат fail, лист, у відповіді ok=false', () => {
    const f = fixture();
    config(f);
    f.setting({ manager_emails: 'boss@example.com' });
    const r = f.ok(f.call('checklist', { id: 'n1', ts: '2026-09-15T05:00:00Z', line_id: 'L1', occasion: 'start',
      answers: START_OK.map((a) => (a.item_id === 'I1' ? { ...a, value: 'na' } : a)), then_event: { state: 'run' } }));
    assert.equal(r.check.result, 'fail');
    assert.equal(r.check.failed, 1);
    assert.equal(r._notify[0].kind, 'checklist');
    assert.match(r._notify[0].text, /Огородження справні: Н\/З/);
    const a = f.ok(f.call('check_detail', { id: 'n1' })).answers.find((x) => x.item_id === 'I1');
    assert.deepEqual([a.value, a.ok], ['Н/З', false]);
    // некритичний «Н/З» із поясненням — без оцінки
    const r2 = f.ok(f.call('checklist', { id: 'n2', ts: '2026-09-15T06:00:00Z', line_id: 'L1', occasion: 'start',
      answers: START_OK.map((a) => (a.item_id === 'I2' ? { ...a, value: 'na', note: 'Ланцюг замінено вчора, змащений' } : a)) }));
    assert.equal(r2.check.result, 'ok');
    assert.equal(r2.check.na, 1);
  });
});

describe('рецензія: контракт, надійність, продуктивність', () => {
  test('рядки довідників без ID і з повтором ID (з таблиці) не потрапляють у логіку; керівник бачить їх у config_issues', () => {
    const f = fixture();
    config(f);
    f.store.insert('items', [{ line_id: 'L1', text: 'Перевірити заземлення', occasions: 'Запуск', type: 'Відмітка' }]);
    f.store.insert('lines', [{}, { name: 'Лінія 4 (додана в таблиці)' }]);
    f.store.insert('rules', [{ line_id: 'L1', title: 'Без ID', interval_days: 1, base_date: '01.01.2026' }]);
    f.store.insert('items', [{ id: 'I3', line_id: 'L1', text: 'Копія рядка', occasions: 'Запуск', type: 'Число', min: 2, max: 4 }]);
    const b = f.ok(f.call('bootstrap'));
    assert.deepEqual(b.lines.map((l) => l.id), ['L1', 'L2']);
    assert.deepEqual(Object.keys(b.status), ['L1', 'L2']);
    assert.ok(b.items.every((i) => i.id));
    assert.equal(b.items.filter((i) => i.id === 'I3').length, 1);
    assert.equal(b.items.find((i) => i.id === 'I3').text, 'Тиск повітря, бар', 'діє перший рядок');
    assert.equal(b.config_issues, undefined, 'лише для керівника');
    const r = f.ok(f.call('checklist', { id: 'c1', ts: '2026-09-15T05:00:00Z', line_id: 'L1', occasion: 'start', answers: START_OK }));
    assert.equal(r.check.result, 'ok');
    assert.deepEqual(f.app.dueAlerts(null, []).map((a) => a.key), []);
    const a = f.ok(f.admin('bootstrap'));
    const iss = a.config_issues.map((x) => [x.table, x.problem, x.name]);
    assert.deepEqual(iss.sort(), [
      ['items', 'duplicate', 'Копія рядка'], ['items', 'no_id', 'Перевірити заземлення'],
      ['lines', 'no_id', 'Лінія 4 (додана в таблиці)'], ['rules', 'no_id', 'Без ID']
    ].sort());
    // оновлення за ID змінює той самий (перший) рядок, який читає ядро
    f.save('items', { id: 'I3', unit_label: 'кПа' });
    assert.equal(f.ok(f.call('bootstrap')).items.find((i) => i.id === 'I3').unit_label, 'кПа');
  });

  test('повтор після часткового збою відновлює похідні дані (подія, робота, показник)', () => {
    const f = fixture('2026-09-25T05:00:00Z');
    config(f, { rules: [{ id: 'RM', line_id: 'L1', title: 'Поршень', work_type: 'replace', meter_id: 'M1', interval_meter: 1000 }] });
    const upd = f.store.update.bind(f.store);
    let failOn = null;
    f.store.update = (t, p) => { if (t === failOn) { failOn = null; throw new Error('Service Spreadsheets failed'); } return upd(t, p); };
    failOn = 'lines';
    const e = { id: 'ev1', line_id: 'L1', state: 'run', ts: '2026-09-25T05:00:00Z' };
    assert.equal(f.call('event', e).error, 'SERVER_ERROR');
    const again = f.ok(f.call('event', e));
    assert.equal(again.duplicate, true);
    assert.equal(again.status.state, 'run');
    assert.equal(f.row('lines', 'L1').cur_event, 'ev1');
    f.setNow('2026-09-25T07:00:00Z');
    assert.equal(f.ev('ev2', '2026-09-25T07:00:00Z', 'off', { ref_id: 'x' }).event.cum_h, 2);
    // робота: вставлено, але last_* регламенту не оновлено
    failOn = 'rules';
    const w = { id: 'w1', ts: '2026-09-25T07:00:00Z', line_id: 'L1', rule_id: 'RM', meter_value: 500 };
    assert.equal(f.call('work', w).error, 'SERVER_ERROR');
    assert.equal(f.ok(f.call('work', w)).duplicate, true);
    assert.equal(f.row('rules', 'RM').last_work_id, 'w1');
    assert.equal(f.row('rules', 'RM').last_meter, 500);
    // показник: вставлено, але поточне значення лічильника не оновлено
    failOn = 'meters';
    const rd = { id: 'r1', ts: '2026-09-25T07:00:00Z', meter_id: 'M2', value: 40 };
    assert.equal(f.call('reading', rd).error, 'SERVER_ERROR');
    assert.equal(f.ok(f.call('reading', rd)).meter.value, 40);
    assert.equal(f.ok(f.call('reading', rd)).meter.value, 40, 'третій повтор не додає ще раз');
  });

  test('показник «із минулого» не читає весь журнал показників; значення правильні', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f, { rules: [{ id: 'RM', line_id: 'L1', title: 'Поршень', work_type: 'replace', meter_id: 'M1', interval_meter: 1000 }] });
    f.ok(f.call('reading', { id: 'a1', ts: '2026-09-15T05:00:00Z', meter_id: 'M1', value: 1000 }));
    f.ok(f.call('reading', { id: 'i1', ts: '2026-09-15T05:00:00Z', meter_id: 'M2', value: 100 }));
    f.ok(f.call('reading', { id: 'a2', ts: '2026-09-15T12:00:00Z', meter_id: 'M1', value: 1500 }));
    f.ok(f.call('reading', { id: 'i2', ts: '2026-09-15T12:00:00Z', meter_id: 'M2', value: 50 }));
    const calls = [];
    const oa = f.store.all.bind(f.store);
    f.store.all = (t) => { calls.push(t); return oa(t); };
    f.ok(f.call('reading', { id: 'a0', ts: '2026-09-15T08:00:00Z', meter_id: 'M1', value: 1200 }));
    f.ok(f.call('reading', { id: 'i0', ts: '2026-09-15T08:00:00Z', meter_id: 'M2', value: 7 }));
    f.ok(f.call('checklist', { id: 'ce', ts: '2026-09-15T09:00:00Z', line_id: 'L1', occasion: 'end',
      answers: [{ item_id: 'I6', value: 'ok' }], readings: [{ meter_id: 'M1', value: 1300, mode: 'abs' }] }));
    f.ok(f.call('work', { id: 'w1', ts: '2026-09-15T10:00:00Z', line_id: 'L1', rule_id: 'RM' }));
    assert.ok(!calls.includes('readings'), calls.join(','));
    assert.equal(f.row('meters', 'M1').cur_value, 1500);
    assert.equal(f.row('meters', 'M2').cur_value, 157);
    assert.equal(f.row('works', 'w1').meter_at, 1300);
    assert.equal(f.app.meterValueAt('M1', new Date('2026-09-15T08:30:00Z')), 1200);
    // абсолютний показник «із минулого» після останнього абсолютного → поточне значення змінюється
    f.ok(f.call('reading', { id: 'a3', ts: '2026-09-15T13:00:00Z', meter_id: 'M1', value: 1600 }));
    f.ok(f.call('reading', { id: 'i3', ts: '2026-09-15T14:00:00Z', meter_id: 'M1', value: 10, mode: 'inc' }));
    f.ok(f.call('reading', { id: 'a4', ts: '2026-09-15T13:30:00Z', meter_id: 'M1', value: 1650 }));
    assert.equal(f.row('meters', 'M1').cur_value, 1660);
    f.app.recomputeMeter('M1');
    assert.equal(f.row('meters', 'M1').cur_value, 1660, 'збігається з повним перерахунком');
  });

  test('чек-лист атомарний: невідомий тип обліку показника — показник пропускається до запису', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    f.ev('a', '2026-09-15T05:00:00Z', 'run');
    const r = f.ok(f.call('checklist', { id: 'ce', ts: '2026-09-15T15:00:00Z', line_id: 'L1', occasion: 'end',
      answers: [{ item_id: 'I6', value: 'ok' }], readings: [{ meter_id: 'M2', value: 10, mode: 'shift' }], then_event: { state: 'off' } }));
    assert.equal(r.event.state, 'off');
    assert.equal(r.readings_skipped.length, 1);
    assert.equal(r.readings_skipped[0].mode, 'shift');
    assert.equal(f.row('lines', 'L1').cur_state, 'off');
    // некоректний час then_event — відмова ДО запису чек-листа
    assert.equal(f.call('checklist', { id: 'cx', ts: '2026-09-15T16:00:00Z', line_id: 'L1', occasion: 'start',
      answers: START_OK, then_event: { state: 'run', ts: 'колись' } }).error, 'BAD_REQUEST');
    assert.equal(f.rows('checks').filter((c) => c.id === 'cx').length, 0);
  });

  test('«Не працює» зберігає поточний продукт лінії; перерахунок дає те саме', () => {
    const f = fixture('2026-09-15T20:00:00Z');
    config(f);
    f.ev('e1', '2026-09-15T05:00:00Z', 'run', { product: 'Кетчуп 300 г' });
    const off = f.ev('e2', '2026-09-15T06:00:00Z', 'off');
    assert.equal(off.event.product, '');
    assert.equal(off.status.product, 'Кетчуп 300 г');
    assert.equal(f.row('lines', 'L1').cur_product, 'Кетчуп 300 г');
    f.app.recomputeLine('L1');
    assert.equal(f.row('lines', 'L1').cur_product, 'Кетчуп 300 г');
    assert.equal(f.ev('e3', '2026-09-15T07:00:00Z', 'run', { product: 'Соус 200 г' }).status.product, 'Соус 200 г');
  });

  test('READ-дії (bootstrap / dashboard / plan) нічого не пишуть; відлік рядків з таблиці фіксують запис і задачі хоста', () => {
    const f = utilisationFixture();
    f.store.insert('rules', [{ id: 'R99', line_id: 'L1', title: 'Перевірка ременів', interval_days: 14 }]);
    const writes = [];
    for (const m of ['insert', 'update', 'replace']) {
      const o = f.store[m].bind(f.store);
      f.store[m] = (t, rows) => { writes.push(m + ':' + t); return o(t, rows); };
    }
    for (const a of ['bootstrap', 'dashboard', 'plan', 'line']) {
      const r = f.ok(f.call(a, { line_id: 'L1' }));
      if (a === 'bootstrap') assert.equal(r.due.find((d) => d.rule_id === 'R99').criteria[0].used, 0);
    }
    assert.deepEqual(writes, []);
    assert.equal(f.row('rules', 'R99').base_date, null);
    f.app.dueAlerts(null, []);                       // задача хоста (hourlyJob) — під store.lock
    assert.deepEqual(writes, ['update:rules']);
    assert.equal(isoOf(f.row('rules', 'R99').base_date), '2026-09-15T00:00:00.000Z');
  });

  test('переміщення агрегата на іншу лінію зберігає його напрацювання', () => {
    const f = fixture('2026-09-01T00:00:00Z');
    config(f);
    f.setNow('2026-09-10T00:00:00Z');
    f.ev('a', '2026-09-01T01:00:00Z', 'run');
    f.ev('b', '2026-09-09T09:00:00Z', 'off', { ref_id: 'x' });
    f.save('units', { id: 'U9', line_id: 'L1', name: 'Компресор', hours_offset: 1000 });
    f.setNow('2026-09-12T00:00:00Z');
    f.ev('c', '2026-09-10T00:00:00Z', 'run');
    f.ev('d', '2026-09-11T00:00:00Z', 'off', { ref_id: 'x' });
    const hours = () => f.ok(f.admin('bootstrap')).units.find((u) => u.id === 'U9').hours;
    assert.equal(hours(), 1024);
    const moved = f.save('units', { id: 'U9', line_id: 'L2' });
    assert.equal(moved.hours_offset, 1024);
    assert.equal(hours(), 1024);
    f.ok(f.call('event', { id: 'l2a', ts: '2026-09-11T12:00:00Z', line_id: 'L2', state: 'run' }));
    assert.equal(hours(), 1036, 'далі — мотогодини нової лінії');
  });
});

/* ================================================================== */
/* Регресійні тести за другою рецензією (вимоги замовника, продуктивність Apps Script) */

describe('рецензія 2: сповіщення, чек-листи, відліки, звіт', () => {
  test('отримувачі листів: email керівників і механіків / електриків / контролю якості з «Персонал» (за лініями)', () => {
    const f = utilisationFixture();
    f.setting({ manager_emails: '' });
    f.save('staff', { id: 'B1', name: 'Головний механік', role: 'manager', email: 'Boss@Zavod.ua' });
    f.save('staff', { id: 'B2', name: 'Майстер лінії 2', role: 'Керівник', line_ids: 'L2', email: 'm2@zavod.ua' });
    f.save('staff', { id: 'B3', name: 'Механік лінії 1', role: 'mechanic', line_ids: 'L1', email: 'mech1@zavod.ua' });
    f.save('staff', { id: 'B4', name: 'Електрик', role: 'electrician', email: 'el@zavod.ua' });
    f.save('staff', { id: 'B5', name: 'Технолог', role: 'qa', email: 'qa@zavod.ua' });
    f.save('staff', { id: 'B6', name: 'Колишній керівник', role: 'manager', email: 'old@zavod.ua' });
    f.ok(f.admin('remove', { table: 'staff', id: 'B6' }));
    // S1 (оператор) теж має email — операторам листи не надсилаються
    const due = f.app.dueAlerts(null, []);
    assert.deepEqual(due.map((a) => a.key), ['due:RX:2026-09-01']);
    assert.deepEqual(due[0].to, ['boss@zavod.ua', 'mech1@zavod.ua', 'el@zavod.ua', 'mech@example.com', 'boss@example.com']);
    assert.deepEqual(f.app.buildDigest().to, ['boss@zavod.ua', 'm2@zavod.ua'], 'звіт — усім керівникам');
    assert.deepEqual(f.ok(f.admin('digest_preview')).to, ['boss@zavod.ua', 'm2@zavod.ua']);
    const r1 = f.ev('rp1', '2026-09-14T23:00:00Z', 'repair', { reason: 'Обрив ланцюга' });
    assert.deepEqual(r1._notify[0].to, ['boss@zavod.ua', 'mech1@zavod.ua', 'el@zavod.ua']);
    const r2 = f.ok(f.call('event', { id: 'rp2', ts: '2026-09-14T23:00:00Z', line_id: 'L2', state: 'repair' }));
    assert.deepEqual(r2._notify[0].to, ['boss@zavod.ua', 'm2@zavod.ua', 'el@zavod.ua'], 'механік лише своєї лінії');
    const c = f.ok(f.call('checklist', { id: 'cr', ts: '2026-09-14T23:30:00Z', line_id: 'L1', occasion: 'start',
      answers: START_OK.map((a) => (a.item_id === 'I2' ? { ...a, value: 'fail', note: 'Сухий ланцюг' } : a)) }));
    assert.deepEqual(c._notify[0].to, ['boss@zavod.ua', 'qa@zavod.ua']);
    // разом із «Email керівництва» — без повторів (регістр не важливий)
    f.setting({ manager_emails: 'director@zavod.ua, BOSS@zavod.ua' });
    assert.deepEqual(f.app.buildDigest().to, ['director@zavod.ua', 'boss@zavod.ua', 'm2@zavod.ua']);
  });

  test('«Н/З» на обовʼязкових пунктах без пояснення — зауваження; кількість «Н/З» видно керівнику', () => {
    const f = fixture('2026-09-15T18:00:00Z');
    config(f);
    f.setting({ manager_emails: 'boss@example.com' });
    f.save('items', { id: 'I9', line_id: 'L1', occasions: 'start', section: 'Огляд', text: 'Датчик рівня протерто', type: 'check', required: false });
    const answers = [{ item_id: 'I1', value: 'ok' }, { item_id: 'I2', value: 'Н/З' }, { item_id: 'I3', value: '6,2' },
      { item_id: 'I4', value: 'Міцний' }, { item_id: 'I9', value: 'na' }];
    const r = f.ok(f.call('checklist', { id: 'k1', ts: '2026-09-15T05:00:00Z', line_id: 'L1', occasion: 'start', operator: 'Ігор',
      answers, then_event: { state: 'run' } }));
    assert.equal(r.check.result, 'remarks', 'не «Норма»: змащування пропущено без пояснення');
    assert.deepEqual([r.check.failed, r.check.na, r.check.missing], [1, 2, 0]);
    assert.equal(SCHEMA.checks.cols.find((c) => c.k === 'na').t, 'Н/З');
    assert.equal(f.row('checks', 'k1').na, 2, 'стовпець «Н/З» у журналі чек-листів');
    const n = r._notify.find((x) => x.kind === 'checklist');
    assert.match(n.text, /Ланцюг змащено: Н\/З \(без пояснення\)/);
    assert.ok(!/Датчик рівня/.test(n.text), 'необовʼязковий пункт «Н/З» — не зауваження');
    const det = f.ok(f.call('check_detail', { id: 'k1' })).answers;
    assert.deepEqual(det.filter((a) => a.value === 'Н/З').map((a) => [a.item_id, a.ok]), [['I2', false], ['I9', null]]);
    const day = f.app.compliance('2026-09-15', '2026-09-15', ['L1']).L1[0];
    assert.equal(day.status, 'warn', 'у матриці щоденних перевірок — «Із зауваженнями», а не ✓');
    assert.equal(day.checks[0].na, 2);
    assert.equal(f.app.stats('2026-09-15', '2026-09-15', ['L1']).L1.checks_na, 2);
    assert.ok(f.ok(f.call('dashboard', { days: 1 })).issues.some((i) => i.item_id === 'I2' && i.value === 'Н/З'));
    f.setNow('2026-09-15T20:00:00Z');
    const dg = f.app.buildDigest();
    assert.equal(dg.counts.failed, 1);
    assert.match(dg.text, /Ланцюг змащено: Н\/З \(без пояснення\)/);
    // той самий чек-лист із поясненням — «Норма», але «Н/З» пораховано
    const ok = f.ok(f.call('checklist', { id: 'k2', ts: '2026-09-15T19:00:00Z', line_id: 'L1', occasion: 'start',
      answers: answers.map((a) => (a.item_id === 'I2' ? { ...a, note: 'Ланцюг замінено вчора, змащений' } : a)) }));
    assert.deepEqual([ok.check.result, ok.check.failed, ok.check.na], ['ok', 0, 2]);
  });

  test('«Востаннє виконано» без напрацювання: відлік — з журналу на ту дату (як і для рядка з таблиці)', () => {
    const f = utilisationFixture();
    // журнал: 05.09–14.09 щодня 5 год роботи; M1: 1000 (01.09), 1200 (06.09), 1600 (10.09), 2000 (14.09); зараз 15.09
    const r = f.save('rules', { id: 'T1', line_id: 'L1', title: 'Заміна ременя', interval_days: 60, interval_hours: 100,
      meter_id: 'M1', interval_meter: 5000, last_done_date: '10.09.2026' });
    assert.equal(r.base_hours, f.app.lineCumAt('L1', new Date('2026-09-09T21:00:00Z')));
    assert.deepEqual([r.base_hours, r.base_meter], [25, 1200]);
    const d = f.app.computeDue('T1');
    assert.equal(d.criteria.find((c) => c.kind === 'hours').used, 25, 'напрацювання з журналу, а не 0');
    assert.equal(d.criteria.find((c) => c.kind === 'meter').used, 800);
    assert.match(d.summary, /75 мотогод/);
    f.store.insert('rules', [{ id: 'T1S', line_id: 'L1', title: 'Заміна ременя', interval_days: 60, interval_hours: 100,
      meter_id: 'M1', interval_meter: 5000, base_date: '10.09.2026' }]);
    const s = f.app.dueAll().find((x) => x.rule_id === 'T1S');
    assert.deepEqual(s.criteria.map((c) => c.used), d.criteria.map((c) => c.used), 'застосунок і таблиця збігаються');
    // дата до початку обліку: мотогодини — усі облікові; лічильник — від першого показника (1000), а не від 0
    const r2 = f.save('rules', { id: 'T2', line_id: 'L1', title: 'Давно', interval_hours: 1000, meter_id: 'M1',
      interval_meter: 5000, last_done_date: '01.08.2026' });
    assert.deepEqual([r2.base_hours, r2.base_meter], [0, 1000]);
    assert.deepEqual(f.app.computeDue('T2').criteria.map((c) => c.used), [50, 1000]);
    f.store.insert('rules', [{ id: 'T2S', line_id: 'L1', title: 'Давно', interval_hours: 1000, meter_id: 'M1', interval_meter: 5000, base_date: '01.08.2026' }]);
    f.app.dueAll();
    assert.equal(f.row('rules', 'T2S').base_meter, 1000);
    // напрацювання, вказане вручну, — загальне з того часу (для робіт до початку обліку)
    const r3 = f.save('rules', { id: 'T3', line_id: 'L1', title: 'Вручну', interval_hours: 1000, meter_id: 'M1', interval_meter: 5000,
      last_done_date: '01.08.2026', used_hours: 120, used_meter: 300 });
    assert.deepEqual([r3.base_hours, r3.base_meter], [50 - 120, 1700]);
  });

  test('агрегат, доданий прямо в таблиці: напрацювання — з моменту додавання, а не вся історія лінії', () => {
    const f = fixture('2026-09-01T00:00:00Z');
    config(f);
    f.setNow('2026-09-10T00:00:00Z');
    f.ev('a', '2026-09-01T01:00:00Z', 'run');
    f.ev('b', '2026-09-09T09:00:00Z', 'off', { ref_id: 'x' });                      // 200 мотогод
    f.store.insert('units', [
      { id: 'U15', line_id: 'L1', name: 'Додано в таблиці', hours_offset: 0 },
      { id: 'U16', line_id: 'L1', name: 'Із датою створення', hours_offset: 10, created: '05.09.2026' }]);
    const hours = (id) => f.ok(f.admin('bootstrap')).units.find((u) => u.id === id).hours;
    assert.equal(hours('U15'), 0, 'не 200 год історії лінії');
    assert.equal(hours('U16'), 10 + 200 - 92, 'від «Створено» (05.09 00:00 за Києвом = 92 год лінії)');
    assert.equal(f.row('units', 'U15').base_cum, null, 'READ-дія нічого не пише');
    f.app.dueAlerts(null, []);                                                        // задача хоста фіксує відлік
    assert.equal(f.row('units', 'U15').base_cum, 200);
    assert.equal(isoOf(f.row('units', 'U15').created), '2026-09-10T00:00:00.000Z');
    assert.equal(f.save('units', { id: 'U17', line_id: 'L1', name: 'Через застосунок' }).base_cum, 200, 'як у застосунку');
    f.setNow('2026-09-12T00:00:00Z');
    f.ev('c', '2026-09-10T00:00:00Z', 'run');
    f.ev('d', '2026-09-11T00:00:00Z', 'off', { ref_id: 'x' });
    assert.deepEqual(['U15', 'U16', 'U17'].map(hours), [24, 142, 24]);
    // рядок із таблиці, одразу перенесений на іншу лінію, — зберігає лише власне напрацювання
    f.store.insert('units', [{ id: 'U18', line_id: 'L1', name: 'Перенесуть', hours_offset: 5 }]);
    assert.equal(f.save('units', { id: 'U18', line_id: 'L2' }).hours_offset, 5);
  });

  test('щоденний звіт: «скоро» без хибних «N днів»; одна поломка — один ремонт', () => {
    const f = utilisationFixture();
    f.store.insert('rules', [{ id: 'Y1', line_id: 'L1', title: 'Повірка ваг', interval_days: 365, warn_days: 30, base_date: '10.10.2025' }]);
    f.setNow('2026-09-15T12:00:00Z');
    f.ev('r0', '2026-09-15T05:00:00Z', 'run');
    f.ev('rp', '2026-09-15T08:00:00Z', 'repair', { reason: 'Підтікає клапан' });
    f.ok(f.call('work', { id: 'wr', ts: '2026-09-15T08:40:00Z', started: '2026-09-15T08:00:00Z', line_id: 'L1', work_type: 'repair', title: 'Замінено клапан' }));
    f.ev('rn', '2026-09-15T08:41:00Z', 'run');
    let d = f.app.buildDigest();
    const soon = f.app.dueAll().filter((x) => x.status === 'soon');
    assert.ok(soon.some((x) => x.rule_id === 'Y1' && (x.due_date - f.now) / DAY > 20), 'Y1 «скоро» за власним порогом 30 дн.');
    assert.ok(d.html.includes('Скоро потрібно виконати (' + soon.length + ')'));
    assert.ok(!/Найближчі \d+ дн/.test(d.html + d.text));
    assert.equal(d.counts.repairs, 1, 'подія «Ремонт» і робота «Ремонт» — одна поломка');
    assert.equal(f.app.stats('2026-09-15', '2026-09-15', ['L1']).L1.repairs, 1, 'так само, як KPI на панелі');
    assert.ok(d.html.includes('Замінено клапан') && d.html.includes('Підтікає клапан'), 'у листі — обидва рядки');
    // ремонт, записаний без стану «Ремонт», — окремий випадок
    f.ok(f.call('work', { id: 'wr2', ts: '2026-09-15T11:00:00Z', line_id: 'L1', work_type: 'repair', title: 'Підтягнуто кріплення датчика' }));
    assert.equal(f.app.buildDigest().counts.repairs, 2);
    // робота, на яку посилається подія завершення ремонту, — не окремий випадок
    f.ev('rp2', '2026-09-15T11:10:00Z', 'repair');
    f.ev('rn2', '2026-09-15T11:20:00Z', 'run', { ref_id: 'wr3' });
    f.ok(f.call('work', { id: 'wr3', ts: '2026-09-15T11:30:00Z', line_id: 'L1', work_type: 'repair', title: 'Замінено запобіжник' }));
    assert.equal(f.app.buildDigest().counts.repairs, 3);
  });
});

describe('рецензія 2: анулювання і перегляд чек-листа без читання всієї історії', () => {
  /* 120 днів: щодня чек-лист запуску → простій → робота → чек-лист завершення; ТО за регламентом раз на 10 днів */
  function history() {
    const f = fixture('2026-05-01T00:00:00Z');
    config(f, { rules: [{ id: 'RQ', line_id: 'L1', title: 'Заміна ножа', work_type: 'replace', meter_id: 'M1', interval_meter: 5000 }] });
    for (let d = 0; d < 120; d++) {
      const day = new Date(ms('2026-05-01T00:00:00Z') + d * DAY).toISOString().slice(0, 10);
      f.setNow(`${day}T16:00:00Z`);
      f.ok(f.call('checklist', { id: 'cs' + d, ts: `${day}T05:00:00Z`, line_id: 'L1', occasion: 'start', answers: START_OK, then_event: { state: 'run' } }));
      f.ev('st' + d, `${day}T09:00:00Z`, 'stop', { reason: 'Перерва' });
      f.ev('rn' + d, `${day}T09:30:00Z`, 'run');
      if (d % 10 === 5) f.ok(f.call('work', { id: 'wk' + d, ts: `${day}T12:00:00Z`, line_id: 'L1', rule_id: 'RQ', meter_value: 1000 * d }));
      f.ok(f.call('checklist', { id: 'ce' + d, ts: `${day}T15:00:00Z`, line_id: 'L1', occasion: 'end', answers: [{ item_id: 'I6', value: 'ok' }], then_event: { state: 'off' } }));
    }
    f.setNow('2026-08-29T00:00:00Z');
    return f;
  }
  function spy(f) {
    const log = { all: [], since: {}, findBy: [] };
    const oa = f.store.all.bind(f.store), os = f.store.since.bind(f.store), of = f.store.findBy;
    f.store.all = (t) => { log.all.push(t); return oa(t); };
    if (typeof of === 'function') f.store.findBy = (t, c, v) => { log.findBy.push(t + '.' + c); return of.call(f.store, t, c, v); };
    f.store.since = (t, d) => { const x = new Date(d).getTime(); log.since[t] = Math.min(log.since[t] ?? Infinity, x); return os(t, d); };
    return log;
  }
  const LOGS = ['events', 'checks', 'answers', 'works', 'readings'];
  function sameAsFull(f) {
    const before = JSON.stringify(f.store.all('events'));
    f.app.recomputeLine('L1');
    assert.equal(JSON.stringify(f.store.all('events')), before, 'той самий результат, що й повний перерахунок');
  }

  test('сховище без findBy: запис знаходиться за ts з клієнта, перерахунок — від опорної події у вікні', () => {
    const f = history();
    f.store.findBy = null;
    const st = f.row('events', 'st118'), cs = f.row('checks', 'cs119'), c10 = f.row('checks', 'cs10');
    let log = spy(f);
    f.ok(f.admin('void', { table: 'events', id: 'st118', ts: st.ts.toISOString(), note: 'Помилково' }));
    assert.deepEqual(log.all.filter((t) => LOGS.includes(t)), [], 'жодного читання всього журналу');
    assert.ok(log.since.events >= st.ts.getTime() - 46 * DAY, 'лише вікно перед записом');
    assert.equal(f.row('events', 'rn118').prev_state, 'run');
    assert.equal(f.row('events', 'rn118').cum_h, f.row('events', 'cs118-e').cum_h + 4.5);
    sameAsFull(f);
    // чек-лист запуску: відповіді й позначка запуску — теж без усієї історії
    log = spy(f);
    f.ok(f.admin('void', { table: 'checks', id: 'cs119', ts: cs.ts.toISOString() }));
    assert.deepEqual(log.all.filter((t) => LOGS.includes(t)), []);
    assert.ok(log.since.answers >= cs.ts.getTime() - DAY && log.since.checks >= cs.ts.getTime() - 47 * DAY);
    assert.ok(f.rows('answers').filter((a) => a.check_id === 'cs119').every((a) => a.void));
    assert.equal(f.row('events', 'cs119-e').flag, 'no_checklist');
    sameAsFull(f);
    // перегляд чек-листа за ts — відповіді лише з доби навколо нього
    log = spy(f);
    assert.equal(f.ok(f.call('check_detail', { id: 'cs10', ts: c10.ts.toISOString() })).answers.length, 4);
    assert.deepEqual(log.all.filter((t) => LOGS.includes(t)), []);
    assert.ok(log.since.answers >= c10.ts.getTime() - DAY);
  });

  test('сховище з findBy: давні записи — без читання всього журналу й без відповідей за весь період', () => {
    const f = history();
    const c119 = f.row('checks', 'cs119');
    let log = spy(f);
    const d = f.ok(f.call('check_detail', { id: 'cs3' }));
    assert.equal(d.answers.length, 4);
    assert.deepEqual(log.all.filter((t) => LOGS.includes(t)), []);
    assert.equal(log.since.answers, undefined, 'відповіді — через findBy за ID чек-листа');
    assert.deepEqual(log.findBy, ['checks.id', 'answers.check_id']);
    // свіжий запис з відомим ts — вікном від ts (знизу аркуша це дешевше за пошук по всьому стовпцю)
    delete f.store.all; delete f.store.since; delete f.store.findBy;
    log = spy(f);
    assert.equal(f.ok(f.call('check_detail', { id: 'cs119', ts: c119.ts.toISOString() })).answers.length, 4);
    assert.deepEqual(log.findBy, []);
    assert.ok(log.since.answers >= c119.ts.getTime() - DAY);
    delete f.store.all; delete f.store.since; delete f.store.findBy;
    log = spy(f);
    f.ok(f.admin('void', { table: 'checks', id: 'cs3' }));
    assert.deepEqual(log.all.filter((t) => LOGS.includes(t)), []);
    assert.equal(log.since.answers, undefined);
    assert.ok(f.rows('answers').filter((a) => a.check_id === 'cs3').every((a) => a.void));
    assert.equal(f.row('events', 'cs3-e').flag, 'no_checklist');
    sameAsFull(f);
    // робота за регламентом з показником: запис — через findBy, повʼязаний показник — у вікні біля роботи
    log = spy(f);
    f.ok(f.admin('void', { table: 'works', id: 'wk115' }));
    assert.deepEqual(log.all.filter((t) => ['events', 'checks', 'answers'].includes(t)), []);
    assert.equal(f.row('rules', 'RQ').last_work_id, 'wk105');
    assert.equal(f.row('rules', 'RQ').last_meter, 105000);
    assert.equal(f.row('readings', 'wk115-m').void, true);
    assert.equal(f.row('meters', 'M1').cur_value, 105000);
    // стара подія: перерахунок від опорної події, а не з початку історії
    const st20 = f.row('events', 'st20');
    log = spy(f);
    f.ok(f.admin('void', { table: 'events', id: 'st20' }));
    assert.deepEqual(log.all.filter((t) => LOGS.includes(t)), []);
    assert.ok(log.since.events >= st20.ts.getTime() - 46 * DAY);
    sameAsFull(f);
    assert.equal(f.call('void', { table: 'events', id: 'nope' }, { admin: true }).error, 'NOT_FOUND');
  });
});

describe('рецензія 3: PIN персоналу, ran_since_off, період панелі', () => {
  test('PIN персоналу з таблиці не з 4–8 цифр → config_issues «bad_pin»; апостроф перед PIN відкидається', () => {
    const f = fixture();
    config(f);
    f.store.insert('staff', [
      { id: 'S3', name: 'Петро', role: 'operator', pin: 427 },          // клітинка втратила текстовий формат і нуль
      { id: 'S4', name: 'Іван', role: 'operator', pin: 'ab12' },
      { id: 'S5', name: 'Марія', role: 'operator', pin: '0427' },
      { id: 'S6', name: 'Олег', role: 'operator', pin: "'0427" }         // апостроф, набраний у текстовій клітинці
    ]);
    assert.equal(norm('staff', { pin: "'0427" }).pin, '0427');
    assert.equal(norm('staff', { name: "'Олег" }).name, "'Олег", 'лише для PIN');
    const a = f.ok(f.admin('bootstrap'));
    assert.deepEqual(a.config_issues.map((x) => [x.table, x.sheet, x.id, x.name, x.problem]), [
      ['staff', SCHEMA.staff.sheet, 'S3', 'Петро', 'bad_pin'], ['staff', SCHEMA.staff.sheet, 'S4', 'Іван', 'bad_pin']]);
    assert.equal(findKey(a, 'pin'), null, 'PIN не передається навіть у config_issues');
    const b = f.ok(f.call('bootstrap'));
    assert.equal(b.config_issues, undefined);
    const hash = (id) => b.staff.find((s) => s.id === id).pin_hash;
    assert.equal(hash('S5'), LinesCore.sha256('S5:0427'));
    assert.equal(hash('S6'), LinesCore.sha256('S6:0427'));
    assert.ok(hash('S3'), 'працівник лишається у списку');
    // PIN, заданий через застосунок, — коректний
    f.save('staff', { id: 'S3', pin: '0427' });
    f.save('staff', { id: 'S4', clear_pin: true });
    assert.deepEqual(f.ok(f.admin('bootstrap')).config_issues, []);
    assert.equal(f.ok(f.call('bootstrap')).staff.find((s) => s.id === 'S3').pin_hash, LinesCore.sha256('S3:0427'));
  });

  test('status.ran_since_off збігається з тим, чи буде наступне «Працює» запуском (addEvent)', () => {
    const f = fixture('2026-09-15T04:00:00Z');
    config(f);
    const st = () => f.ok(f.call('bootstrap')).status.L1;
    assert.equal(st().ran_since_off, false, 'подій ще немає');
    const step = (id, iso, state) => { f.setNow(iso); return f.ev(id, iso, state); };
    assert.equal(step('a', '2026-09-15T05:00:00Z', 'setup').status.ran_since_off, false, 'налаштування перед запуском');
    let r = step('b', '2026-09-15T06:00:00Z', 'run');
    assert.equal(r.event.starts, 1);
    assert.equal(r.status.ran_since_off, true);
    assert.equal(step('c', '2026-09-15T07:00:00Z', 'clean').status.ran_since_off, true, 'миття посеред зміни');
    assert.equal(st().ran_since_off, true);
    assert.equal(step('d', '2026-09-15T07:30:00Z', 'run').event.starts, 1, 'повернення після миття — не запуск');
    assert.equal(step('e', '2026-09-15T08:00:00Z', 'stop').status.ran_since_off, true);
    assert.equal(step('f', '2026-09-15T12:00:00Z', 'off').status.ran_since_off, false);
    assert.equal(step('g', '2026-09-15T13:00:00Z', 'maint').status.ran_since_off, false, 'ТО після завершення зміни');
    assert.equal(st().ran_since_off, false);
    assert.equal(step('h', '2026-09-15T14:00:00Z', 'run').event.starts, 2, 'після ТО — новий запуск');
    // ремонт довший за вікно подій статусу: відповідь шукається глибше в журналі
    step('i', '2026-09-15T15:00:00Z', 'repair');
    f.setNow('2026-10-05T10:00:00Z');
    assert.equal(st().ran_since_off, true);
    assert.equal(f.ok(f.call('dashboard', { days: 1 })).status.L1.ran_since_off, true);
    assert.equal(f.app.lineStatus('L1').ran_since_off, true);
    assert.equal(f.ev('j', '2026-10-05T10:00:00Z', 'run').event.starts, 2, 'після ремонту — не запуск');
  });

  describe('dashboard {from, to}: минулий період', () => {
    const NOW = new Date('2026-09-25T10:00:00Z');
    const store = new MemoryStore();
    LinesCore.seedDemo(store, {}, { now: NOW });
    const app = createApp(store, { now: () => NOW });
    const dash = (p) => { const r = app.handle({ action: 'dashboard', ...p }, { device: 'Тест' }); assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300)); return r; };
    const range = (d) => [d.days[0], d.days[d.days.length - 1], d.days.length];

    test('тиждень у минулому: лише його дні, повні доби, межа — початок наступного дня', () => {
      const d = dash({ from: '2026-09-14', to: '2026-09-20' });
      assert.deepEqual(range(d), ['2026-09-14', '2026-09-20', 7]);
      assert.equal(d.from, '2026-09-13T21:00:00.000Z');
      assert.equal(d.to, '2026-09-20T21:00:00.000Z');
      const A = ms(d.from), B = ms(d.to);
      for (const id of ['L1', 'L2', 'L3']) {
        const s = d.stats[id];
        assert.equal(Math.round(Object.values(s.hours).reduce((x, y) => x + y, 0) * 1e3) / 1e3, 168, id + ': 7 × 24 год');
        assert.equal(Math.round(s.total_h * 1e3) / 1e3, 168);
        assert.equal(d.daily[id].length, 7);
        assert.ok(d.daily[id].every((x) => Math.abs(Object.values(x.hours).reduce((a, b) => a + b, 0) - 24) < 1e-3), id + ': доба — 24 год');
        assert.deepEqual(d.compliance[id].map((x) => x.day), d.days);
        assert.equal(d.compliance[id].reduce((n, x) => n + x.starts, 0), s.starts, id + ': запуски в межах періоду');
      }
      assert.ok(d.stats.L1.starts > 0 && d.stats.L1.checks > 0, 'демо-дані в періоді є');
      assert.ok(d.issues.every((x) => ms(x.ts) >= A && ms(x.ts) < B), 'проблеми лише за період');
      // стан ліній і план ТО — поточні
      assert.equal(d.status.L1.state, 'run');
      assert.deepEqual(d.status, dash({ days: 14 }).status);
      assert.deepEqual(d.due, dash({}).due);
    });

    test('період довший за 62 дні обрізається до 62 днів, що закінчуються в «to»', () => {
      const d = dash({ from: '2026-05-01', to: '2026-08-31' });
      assert.deepEqual(range(d), ['2026-07-01', '2026-08-31', 62]);
      assert.equal(d.to, '2026-08-31T21:00:00.000Z');
    });

    test('«to» у майбутньому → до сьогодні (to = now); лише from / лише to; недійсні дати ігноруються', () => {
      let d = dash({ from: '2026-09-20', to: '2026-12-31' });
      assert.deepEqual(range(d), ['2026-09-20', '2026-09-25', 6]);
      assert.equal(d.to, NOW.toISOString());
      assert.deepEqual(range(dash({ from: '2026-09-01' })), ['2026-09-01', '2026-09-25', 25]);
      assert.deepEqual(range(dash({ to: '2026-09-20', days: 7 })), ['2026-09-14', '2026-09-20', 7]);
      assert.deepEqual(range(dash({ to: '2026-09-20' })), ['2026-09-07', '2026-09-20', 14]);
      assert.deepEqual(range(dash({ from: '2026-09-20', to: '2026-09-10', days: 3 })), ['2026-09-08', '2026-09-10', 3], 'from пізніше за to — діє days');
      assert.deepEqual(range(dash({ from: '2026-10-01' })), ['2026-09-12', '2026-09-25', 14], 'from у майбутньому');
      const plain = dash({ days: 14 });
      assert.deepEqual(range(plain), ['2026-09-12', '2026-09-25', 14]);
      assert.equal(plain.to, NOW.toISOString());
      assert.deepEqual(dash({ days: 14, from: '2026-02-30', to: 'вчора' }), plain);
      assert.deepEqual(dash({ days: 14, from: ' 2026-09-12 ', to: '2026-09-25' }), plain);
    });
  });
});

describe('рецензія 4: чинність чек-листа запуску, лічильники, строки, контроль завершення', () => {
  test('start_uncovered: запуск із чек-листом, що вже минув, — не «без чек-листа» (зупинка / ТО до запуску)', () => {
    const f = fixture('2026-09-15T04:00:00Z');
    config(f);
    const st = () => f.ok(f.call('bootstrap')).status.L1;
    // чек-лист без запуску, запуск через 30 хв, простій, відновлення
    f.ok(f.call('checklist', { id: 'c1', ts: '2026-09-15T04:00:00Z', line_id: 'L1', occasion: 'start', answers: START_OK }));
    f.setNow('2026-09-15T04:30:00Z');
    assert.equal(f.ev('r1', '2026-09-15T04:30:00Z', 'run').event.flag, '');
    f.setNow('2026-09-15T06:30:00Z');
    f.ev('p1', '2026-09-15T05:10:00Z', 'stop', { reason: 'Перерва' });
    f.ev('r2', '2026-09-15T06:10:00Z', 'run');
    f.setNow('2026-09-15T16:10:00Z');              // чек-лист старший за 12 год, робота почалася 11 год 40 хв тому
    let s = st();
    assert.equal(s.start_check_valid, false);
    assert.equal(s.flag, '');
    assert.equal(s.start_uncovered, false, 'запуск r1 був із чинним чек-листом');
    assert.equal(f.ok(f.call('dashboard', { days: 1 })).status.L1.start_uncovered, false);
    assert.equal(f.app.lineStatus('L1').start_uncovered, false);
    // той самий запуск, але робота почалася з ТО (off → ТО → Працює)
    const g = fixture('2026-09-15T04:00:00Z');
    config(g);
    g.ok(g.call('checklist', { id: 'c1', ts: '2026-09-15T04:00:00Z', line_id: 'L1', occasion: 'start', answers: START_OK }));
    g.setNow('2026-09-15T05:00:00Z');
    g.ok(g.call('event', { id: 'm1', ts: '2026-09-15T04:10:00Z', line_id: 'L1', state: 'maint' }));
    assert.equal(g.ok(g.call('event', { id: 'r1', ts: '2026-09-15T04:40:00Z', line_id: 'L1', state: 'run' })).event.flag, '');
    g.setNow('2026-09-15T16:20:00Z');
    s = g.ok(g.call('bootstrap')).status.L1;
    assert.deepEqual([s.start_check_valid, s.start_uncovered], [false, false]);
  });

  test('start_uncovered: запуск без чек-листа → true; пізній чек-лист закриває назавжди; нова зміна — заново', () => {
    const f = fixture('2026-09-15T05:00:00Z');
    config(f);
    const st = () => f.ok(f.call('bootstrap')).status.L1;
    assert.equal(f.ev('r1', '2026-09-15T05:00:00Z', 'run').event.flag, 'no_checklist');
    f.setNow('2026-09-15T05:30:00Z');
    f.ev('p1', '2026-09-15T05:20:00Z', 'stop', { reason: 'Перерва' });
    let s = st();
    assert.equal(s.flag, '', 'поточна подія — простій');
    assert.equal(s.start_uncovered, true, 'рахується за подією запуску, а не поточною');
    f.ev('r2', '2026-09-15T05:30:00Z', 'run');
    assert.equal(st().start_uncovered, true);
    // запуск давніший за 12 год — усе одно без чек-листа
    f.setNow('2026-09-15T19:00:00Z');
    assert.equal(st().start_uncovered, true);
    // пізній чек-лист запуску, потім переналаштування (новіший «останній чек-лист») і 12 год потому — питання закрите
    f.ok(f.call('checklist', { id: 'c1', ts: '2026-09-15T19:00:00Z', line_id: 'L1', occasion: 'start', answers: START_OK }));
    assert.equal(f.row('events', 'r1').flag, 'no_checklist', 'запуск лишається «без чек-листа» в історії');
    f.setNow('2026-09-15T20:00:00Z');
    f.ok(f.call('checklist', { id: 'ch', ts: '2026-09-15T20:00:00Z', line_id: 'L1', occasion: 'changeover', answers: [] }));
    f.setNow('2026-09-16T08:00:00Z');
    s = st();
    assert.deepEqual([s.start_check_valid, s.start_uncovered, s.last_check.occasion], [false, false, 'changeover']);
    // завершення і новий запуск без чек-листа
    f.ev('o1', '2026-09-16T08:00:00Z', 'off', { ref_id: 'x' });
    assert.equal(st().start_uncovered, false, 'лінія не працює');
    f.setNow('2026-09-16T09:00:00Z');
    f.ev('s1', '2026-09-16T08:30:00Z', 'setup');
    assert.equal(st().start_uncovered, false, 'налаштування — ще не запуск');
    assert.equal(f.ev('r3', '2026-09-16T09:00:00Z', 'run').status.start_uncovered, true);
    // require_start_checklist вимкнено — не порушення
    f.setting({ require_start_checklist: false });
    assert.equal(st().start_uncovered, false);
  });

  test('миття / налаштування / ТО без запуску → «Не працює» не витрачають чек-лист запуску', () => {
    const f = fixture('2026-09-15T04:00:00Z');
    config(f);
    const st = () => f.ok(f.call('bootstrap')).status.L1;
    f.ok(f.call('checklist', { id: 'c1', ts: '2026-09-15T04:00:00Z', line_id: 'L1', occasion: 'start', answers: START_OK }));
    f.setNow('2026-09-15T05:00:00Z');
    f.ev('w1', '2026-09-15T04:10:00Z', 'clean');
    f.ev('o1', '2026-09-15T04:40:00Z', 'off', { ref_id: 'wk1' });
    let s = st();
    assert.deepEqual([s.state, s.start_check_valid, s.ran_since_off], ['off', true, false], 'миття перед запуском — підготовка');
    f.ev('s1', '2026-09-15T04:50:00Z', 'setup');
    f.ev('o2', '2026-09-15T04:55:00Z', 'off', { ref_id: 'wk2' });
    assert.equal(st().start_check_valid, true, 'налаштування без запуску');
    const r1 = f.ev('r1', '2026-09-15T05:00:00Z', 'run');
    assert.deepEqual([r1.event.flag, r1.event.starts], ['', 1], 'запуск покрито тим самим чек-листом');
    assert.equal(r1.status.start_uncovered, false);
    // після роботи — «Не працює» витрачає чек-лист, навіть через миття (run → clean → off)
    f.setNow('2026-09-15T08:00:00Z');
    f.ev('w2', '2026-09-15T07:00:00Z', 'clean');
    f.ev('o3', '2026-09-15T07:30:00Z', 'off', { ref_id: 'wk3' });
    assert.equal(st().start_check_valid, false);
    assert.equal(f.ev('r2', '2026-09-15T08:00:00Z', 'run').event.flag, 'no_checklist');
    // перерахунок журналу дає ті самі позначки
    const before = JSON.stringify(f.rows('events').map((e) => [e.id, e.flag, e.starts]));
    f.app.recomputeLine('L1');
    assert.equal(JSON.stringify(f.rows('events').map((e) => [e.id, e.flag, e.starts])), before);
    // подія «із минулого» (черга): миття → «Не працює» до запуску не знімає чинність
    const g = fixture('2026-09-15T04:00:00Z');
    config(g);
    g.ok(g.call('checklist', { id: 'c1', ts: '2026-09-15T04:00:00Z', line_id: 'L1', occasion: 'start', answers: START_OK }));
    g.setNow('2026-09-15T06:00:00Z');
    g.ok(g.call('event', { id: 'r1', ts: '2026-09-15T05:00:00Z', line_id: 'L1', state: 'run' }));
    g.ok(g.call('event', { id: 'w1', ts: '2026-09-15T04:10:00Z', line_id: 'L1', state: 'clean' }));
    g.ok(g.call('event', { id: 'o1', ts: '2026-09-15T04:40:00Z', line_id: 'L1', state: 'off', ref_id: 'wk1' }));
    assert.equal(g.row('events', 'r1').flag, '');
    assert.equal(g.ok(g.call('bootstrap')).status.L1.start_check_valid, true);
    // чек-лист, що надійшов пізніше за миття і запуск, знімає «без чек-листа»
    const h = fixture('2026-09-15T04:00:00Z');
    config(h);
    h.setNow('2026-09-15T06:00:00Z');
    h.ok(h.call('event', { id: 'w1', ts: '2026-09-15T04:10:00Z', line_id: 'L1', state: 'clean' }));
    h.ok(h.call('event', { id: 'o1', ts: '2026-09-15T04:40:00Z', line_id: 'L1', state: 'off', ref_id: 'wk1' }));
    assert.equal(h.ok(h.call('event', { id: 'r1', ts: '2026-09-15T05:00:00Z', line_id: 'L1', state: 'run' })).event.flag, 'no_checklist');
    h.ok(h.call('checklist', { id: 'c1', ts: '2026-09-15T04:00:00Z', line_id: 'L1', occasion: 'start', answers: START_OK }));
    assert.equal(h.row('events', 'r1').flag, '');
  });

  test('накопичувальний показник, менший за попередній: відхиляється без «скинуто / замінено»; скидання — новий відлік', () => {
    const f = fixture('2026-09-01T00:00:00Z');
    config(f);
    f.ok(f.call('reading', { id: 'm0', ts: '2026-09-01T00:00:00Z', meter_id: 'M1', value: 1000 }));
    f.save('rules', { id: 'RK', line_id: 'L1', unit_id: 'U1', title: 'Заміна ножа', work_type: 'replace', meter_id: 'M1', interval_meter: 1500 });
    f.setNow('2026-09-10T00:00:00Z');
    f.ok(f.call('reading', { id: 'm1', ts: '2026-09-10T00:00:00Z', meter_id: 'M1', value: 2600 }));
    f.setNow('2026-09-11T00:00:00Z');
    const due = () => f.app.dueAll().find((d) => d.rule_id === 'RK');
    let d = due();
    assert.equal(d.status, 'due');
    assert.match(d.summary, /^перевищено на 100 цикл\.$/);
    // строк — момент, коли показник перейшов 2500 (між 1000 01.09 і 2600 10.09), а не прогноз назад
    assert.equal(d.forecast, false);
    assert.equal(isoOf(d.due_date), new Date(ms('2026-09-01T00:00:00Z') + 9 * DAY * 1500 / 1600).toISOString());
    // помилка вводу: 2 замість 2 600 002
    const bad1 = f.call('reading', { id: 'm2', ts: '2026-09-11T00:00:00Z', meter_id: 'M1', value: 2 });
    assert.equal(bad1.ok, false);
    assert.equal(bad1.error, 'BAD_REQUEST');
    assert.match(bad1.message, /менший за попередній 2\s600/);
    assert.equal(f.row('meters', 'M1').cur_value, 2600);
    assert.equal(f.rows('readings').length, 2);
    // у чек-листі — показник не записується, сам чек-лист зберігається
    const c = f.ok(f.call('checklist', { id: 'c1', ts: '2026-09-11T00:00:00Z', line_id: 'L1', occasion: 'end',
      answers: [{ item_id: 'I6', value: 'ok' }], readings: [{ meter_id: 'M1', value: 2 }] }));
    assert.deepEqual(c.readings_skipped.map((x) => [x.meter_id, x.reason, x.prev]), [['M1', 'lower', 2600]]);
    assert.equal(c.readings, undefined);
    // у роботі — відмова до запису роботи
    const w = f.call('work', { id: 'w1', ts: '2026-09-11T00:00:00Z', line_id: 'L1', rule_id: 'RK', performer: 'Віктор', meter_value: 5 });
    assert.equal(w.error, 'BAD_REQUEST');
    assert.equal(f.rows('works').length, 0);
    assert.equal(due().status, 'due', 'строк не «зник»');
    // показник «із минулого», менший за тодішній, — теж
    assert.equal(f.call('reading', { id: 'm3', ts: '2026-09-10T12:00:00Z', meter_id: 'M1', value: 1500 }).error, 'BAD_REQUEST');
    // лічильник замінили: новий відлік з нуля, напрацювання продовжується
    f.setNow('2026-09-12T00:00:00Z');
    const r = f.ok(f.call('reading', { id: 'm4', ts: '2026-09-12T00:00:00Z', meter_id: 'M1', value: 100, reset: true }));
    assert.equal(r.reading.reset, true);
    assert.equal(f.row('readings', 'm4').reset, true);
    assert.equal(f.store.all('readings').find((x) => x.id === 'm4')['reset'], true);
    assert.equal(f.row('meters', 'M1').cur_value, 100);
    assert.equal(isoOf(f.row('meters', 'M1').reset_ts), '2026-09-12T00:00:00.000Z');
    d = due();
    assert.equal(d.criteria[0].used, 1700, '1 600 до заміни + 100 на новому лічильнику');
    assert.equal(d.status, 'due');
    assert.equal(d.criteria[0].pct, 1.1333);
    // робота з показником після заміни ножа (лічильник скинули разом із ним) → новий відлік
    f.setNow('2026-09-12T01:00:00Z');
    f.ok(f.call('work', { id: 'w2', ts: '2026-09-12T01:00:00Z', line_id: 'L1', rule_id: 'RK', performer: 'Віктор', meter_value: 0, meter_reset: true }));
    assert.equal(f.row('rules', 'RK').last_meter, 0);
    f.setNow('2026-09-13T00:00:00Z');
    f.ok(f.call('reading', { id: 'm5', ts: '2026-09-13T00:00:00Z', meter_id: 'M1', value: 300 }));
    d = due();
    assert.deepEqual([d.status, d.criteria[0].used], ['ok', 300]);
    assert.match(d.summary, /^залишилось 1\s200 цикл\.$/);
    // зниження без позначки, внесене прямо в таблицю: напрацювання не стає відʼємним і не «обнуляється»
    f.store.insert('readings', [{ id: 'hand', ts: '14.09.2026 03:00', meter_id: 'M1', line_id: 'L1', value: 20, mode: 'Накопичувальний показник' }]);
    f.setNow('2026-09-14T01:00:00Z');
    f.ok(f.admin('recompute'));
    assert.equal(isoOf(f.row('meters', 'M1').reset_ts), '2026-09-14T00:00:00.000Z');
    assert.equal(f.row('meters', 'M1').cur_value, 20);
    d = due();
    assert.equal(d.criteria[0].used, 300, 'зниження — нова база без приросту (як середнє)');
    // анулювання помилкового показника повертає все як було
    f.ok(f.admin('void', { table: 'readings', id: 'hand', ts: '2026-09-14T00:00:00Z' }));
    assert.equal(f.row('meters', 'M1').cur_value, 300);
    assert.equal(isoOf(f.row('meters', 'M1').reset_ts), '2026-09-12T01:00:00.000Z', 'останнє скидання — показник роботи w2');
    assert.equal(due().criteria[0].used, 300);
    // приріст за зміну (inc) не перевіряється і не «скидається»
    f.ok(f.call('reading', { id: 'i1', ts: '2026-09-14T01:00:00Z', meter_id: 'M2', value: 5, reset: true }));
    assert.equal(f.row('readings', 'i1').reset, false);
  });

  test('перевищення за лічильником: строк — між останнім показником нижче порогу і першим вище (не назад від «зараз»)', () => {
    const f = fixture('2026-09-20T00:00:00Z');
    config(f, { rules: [{ id: 'R9', line_id: 'L1', title: 'Заміна ножа етикетувальника', work_type: 'replace', meter_id: 'M1', interval_meter: 150000 }] });
    f.ok(f.call('reading', { id: 'a', ts: '2026-09-20T00:00:00Z', meter_id: 'M1', value: 2400000 }));
    f.setNow('2026-09-28T12:20:00Z');
    f.ok(f.call('work', { id: 'knife', ts: '2026-09-28T12:20:00Z', line_id: 'L1', rule_id: 'R9', performer: 'Віктор', meter_value: 2580000 }));
    f.setNow('2026-09-28T16:45:00Z');
    f.ok(f.call('reading', { id: 'b', ts: '2026-09-28T16:45:00Z', meter_id: 'M1', value: 2600000 }));
    f.setNow('2026-09-30T04:15:00Z');
    f.ok(f.call('reading', { id: 'c', ts: '2026-09-30T04:15:00Z', meter_id: 'M1', value: 2790000 }));
    f.setNow('2026-10-01T04:00:00Z');
    const d = f.app.dueAll().find((x) => x.rule_id === 'R9');
    assert.equal(d.status, 'due');
    assert.match(d.summary, /^перевищено на 60\s000 цикл\.$/);
    const a = ms('2026-09-28T16:45:00Z'), b = ms('2026-09-30T04:15:00Z');
    assert.equal(isoOf(d.due_date), new Date(Math.round(a + (b - a) * 130000 / 190000)).toISOString());
    assert.equal(d.forecast, false);
    assert.equal(d.due_basis, 'meter');
    assert.equal(d.overdue_days, 1.5, '29.09 ≈ 20:00 за Києвом → 01.10 07:00');
  });

  test('календарні строки — різниця днів заводу, а не повних діб', () => {
    const f = fixture('2026-09-28T12:00:00Z');   // пн 28.09 15:00 за Києвом
    config(f, { rules: [{ id: 'R10', line_id: 'L1', title: 'Очищення головки', work_type: 'clean', interval_days: 3 }] });
    f.ok(f.call('work', { id: 'w', ts: '2026-09-28T12:00:00Z', line_id: 'L1', rule_id: 'R10', performer: 'Олена' }));
    const at = (iso) => { f.setNow(iso); return f.app.dueAll().find((x) => x.rule_id === 'R10'); };
    assert.equal(at('2026-09-28T12:20:00Z').summary, 'залишилось 3 дн.', 'строк 01.10 — через 3 календарні дні');
    assert.equal(at('2026-09-30T20:00:00Z').summary, 'залишилось 1 дн.', '30.09 23:00 → строк завтра');
    assert.equal(at('2026-10-01T11:00:00Z').summary, 'залишилось менше доби', '01.10 14:00 — строк сьогодні о 15:00');
    let d = at('2026-10-01T13:00:00Z');
    assert.equal(d.status, 'due');
    assert.equal(d.summary, 'строк настав сьогодні');
    assert.equal(at('2026-10-01T21:30:00Z').summary, 'прострочено на 1 дн.', '02.10 00:30 за Києвом — уже наступний день');
    assert.equal(at('2026-10-03T07:00:00Z').summary, 'прострочено на 2 дн.');
    d = at('2026-10-03T07:00:00Z');
    assert.equal(K(f).key(d.due_date), '2026-10-01');
  });

  test('робота без завершення понад long_run_hours: день у контролі — порушення, у звіті — окремий розділ', () => {
    const f = fixture('2026-09-29T04:30:00Z');
    config(f);
    f.setting({ manager_emails: 'boss@example.com' });
    // вт 29.09 07:30 за Києвом — запуск із чек-листом, завершення немає
    f.ok(f.call('checklist', { id: 'c1', ts: '2026-09-29T04:30:00Z', line_id: 'L1', occasion: 'start', answers: START_OK, then_event: { state: 'run' } }));
    f.setNow('2026-09-30T04:00:00Z');                                  // ср 07:00 — щоденний звіт
    const d = f.app.buildDigest();
    assert.equal(d.has_content, true);
    assert.equal(d.counts.long_runs, 1);
    assert.equal(d.counts.running_long, 1);
    assert.equal(d.counts.uncovered, 0);
    assert.match(d.text, /Лінія 1: Без чек-листа або завершення \(запусків: 1 · без завершення понад 16 год: 1 · чек-листів: 1/);
    assert.match(d.text, /БЕЗ ЗАВЕРШЕННЯ ЗМІНИ ПОНАД 16 ГОД \(1\)\n— Лінія 1: Працює без завершення з 29\.09\.2026 07:30 \(23,5 год\)/);
    assert.ok(d.html.includes('Без завершення зміни понад 16 год (1)'));
    // завершили з чек-листом у середу: вівторок лишається порушенням, середа — ні
    f.setNow('2026-09-30T04:15:00Z');
    f.ok(f.call('checklist', { id: 'e1', ts: '2026-09-30T04:15:00Z', line_id: 'L1', occasion: 'end', answers: [{ item_id: 'I6', value: 'ok' }], then_event: { state: 'off' } }));
    const days = f.app.compliance('2026-09-29', '2026-09-30', ['L1']).L1;
    assert.deepEqual(days.map((x) => [x.day, x.status, x.long_runs]), [['2026-09-29', 'miss', 1], ['2026-09-30', 'ok', 0]]);
    // звичайна зміна через північ (коротша за поріг) — не порушення
    f.setNow('2026-10-01T12:00:00Z');
    f.ok(f.call('checklist', { id: 'c2', ts: '2026-09-30T15:00:00Z', line_id: 'L1', occasion: 'start', answers: START_OK, then_event: { state: 'run' } }));
    f.ok(f.call('checklist', { id: 'e2', ts: '2026-10-01T00:00:00Z', line_id: 'L1', occasion: 'end', answers: [{ item_id: 'I6', value: 'ok' }], then_event: { state: 'off' } }));
    assert.equal(f.app.compliance('2026-09-30', '2026-09-30', ['L1']).L1[0].status, 'ok');
    assert.equal(f.app.buildDigest().counts.running_long, 0);
    // довгий ремонт без запуску — не пропущене завершення зміни (у контролі перевірок), але в «зараз» — так
    f.setNow('2026-10-02T12:00:00Z');
    f.ev('rp', '2026-10-01T12:00:00Z', 'repair', { reason: 'Заміна редуктора' });
    assert.deepEqual(f.app.compliance('2026-10-01', '2026-10-01', ['L1']).L1.map((x) => [x.status, x.long_runs]), [['ok', 0]], 'лише чек-лист завершення e2 о 03:00');
    assert.equal(f.app.buildDigest().counts.running_long, 1);
  });

  test('«Сповіщення»: статус українською в таблиці, код — в API', () => {
    const f = fixture();
    config(f);
    f.app.logNotices([{ key: 'k1', kind: 'due', to: ['a@x.ua'], subject: 'Т', status: 'sent' },
      { key: 'k2', kind: 'digest', to: [], subject: 'Т2', status: 'error', error: 'Немає отримувачів' },
      { key: 'k3', kind: 'test', to: [], subject: 'Т3', status: 'preview' }]);
    assert.deepEqual(f.store.all('notices').map((r) => r.status), ['Надіслано', 'Помилка', 'Демо: не надсилалося']);
    assert.deepEqual(f.ok(f.admin('notices')).notices.map((n) => n.status).sort(), ['error', 'preview', 'sent']);
    // старі рядки з англійськими кодами читаються так само
    f.store.insert('notices', [{ id: 'old', ts: new Date(), kind: 'due', key: 'k4', status: 'sent' }]);
    assert.equal(norm('notices', f.store.all('notices').find((r) => r.id === 'old')).status, 'sent');
  });

  test('рядки довідників із таблиці: ID кирилицею редагується; пункт без «Коли» — у config_issues', () => {
    const f = fixture();
    config(f);
    f.store.insert('lines', [{ id: 'Лінія 4', name: 'Лінія 4', active: true }]);
    f.store.insert('items', [{ id: 'I99', line_id: 'L1', occasions: '', text: 'Пункт без «Коли»', type: 'check' },
      { id: 'I98', line_id: 'L1', occasions: 'Колись', text: 'Невідоме «Коли»', type: 'check' },
      { id: 'I97', line_id: 'L1', occasions: '', text: 'Вимкнений', type: 'check', active: false }]);
    const row = f.save('lines', { id: 'Лінія 4', name: 'Лінія №4', kind: 'Фасувальна' });
    assert.equal(row.name, 'Лінія №4');
    assert.equal(f.row('lines', 'Лінія 4').kind, 'Фасувальна');
    const r = f.admin('save', { table: 'lines', row: { id: 'Лінія 5', name: 'Нова' } });
    assert.equal(r.error, 'BAD_REQUEST', 'новий ID — лише латиницею');
    const issues = f.ok(f.admin('bootstrap')).config_issues;
    assert.deepEqual(issues.map((x) => [x.id, x.problem]), [['I99', 'no_occasion'], ['I98', 'no_occasion']]);
  });
});
