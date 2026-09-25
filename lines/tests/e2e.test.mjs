/* Наскрізні тести (Playwright, headless Chromium) над локальним емулятором tools/dev-server.mjs:
 * статичні файли застосунку + /exec, що виконує СПРАВЖНІ core.js і Server.gs над таблицею в памʼяті.
 * Запуск: cd lines && npm run test:e2e   (Playwright — глобальний пакет; без нього браузерні тести
 * пропускаються з поясненням). Кожен сценарій — свій сервер на випадковому порту і свій контекст.
 * Сценарії: демо-режим (майстер, повна зміна оператора, гонка черги Api.write, керівник, «Назад» із
 * незбереженого чек-листа, подвійний дотик, 360 px); віддалений режим (майстер з адресою й токеном →
 * рядки в аркушах, «аварія» зʼєднання з чергою та ідемпотентним повтором, резервний канал JSONP і
 * завеликий для нього запис, PWA-старт без мережі, ТО з екрана лінії, анулювання
 * в журналі); у кожному — жодних помилок у консолі браузера. Без браузера: захист службових адрес
 * емулятора (лише цей компʼютер, без CORS, команди — лише POST JSON) і режим «мережі немає». */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDevServer } from '../tools/dev-server.mjs';
import * as H from './e2e-helpers.mjs';

const TOKEN = 'e2e-token-0123456789ab', PIN = '4321';
const at = (f) => fileURLToPath(new URL('../' + f, import.meta.url));
const ASSET_V = (/assets\/app\.js\?v=([^"]+)"/.exec(readFileSync(at('index.html'), 'utf8')) || [])[1];
const T = { timeout: 120000 };

const pw = H.loadPlaywright();
let browser = null, skip = '';
if (pw.error) skip = 'Playwright недоступний (' + pw.error + ')';
else {
  try { browser = await pw.chromium.launch({ headless: true }); } catch (e) { skip = 'Chromium не запускається: ' + String(e.message).split('\n')[0]; }
}

/* середовище одного сценарію: сервер(и), контекст, сторінка, помилки консолі */
async function scene(o = {}) {
  const srv = await startDevServer({ port: 0, quiet: true, seed: !!o.seed, token: TOKEN, adminPin: PIN });
  const ctx = await H.newContext(browser, { viewport: o.viewport, serviceWorkers: o.serviceWorkers, hasTouch: o.hasTouch, config: o.config ? o.config(srv) : null });
  const page = await ctx.newPage();
  const errs = H.watch(page, { allow: o.allow });
  return {
    srv, ctx, page, errs,
    async done(failed) {
      await ctx.close().catch(() => {});
      await srv.close();
      if (!failed) assert.deepEqual(errs, [], 'помилки в консолі браузера');
      else if (errs.length) console.log('# консоль браузера:\n# ' + errs.join('\n# '));
    }
  };
}
async function run(o, fn) {
  const s = await scene(o);
  let failed = true;
  try { await fn(s); failed = false; } finally { await s.done(failed); }
}
const tilesOf = (page) => page.$$eval('.ltile', (els) => els.map((e) => ({
  id: e.getAttribute('data-line'), cls: e.className, name: (e.querySelector('h2') || e).textContent.trim(),
  status: (e.querySelector('.lt-status') || e).textContent.replace(/\s+/g, ' ').trim()
})));
const byId = (rows, id) => rows.filter((r) => r.ID === id);
/* екран лінії ігнорує дотики 600 мс після «Відновити» / «Запустити» (захист від подвійного дотику) */
const afterDirectWrite = (page) => page.waitForTimeout(700);
/* SHELL_FILES із sw.js */
const shellFiles = () => [.../var SHELL_FILES = \[([\s\S]*?)\];/.exec(readFileSync(at('sw.js'), 'utf8'))[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

/* HTTP-запит із довільними заголовками (Host, Origin, Sec-Fetch-Site) → {status, headers, text, json} | {error} */
function raw(url, o = {}) {
  return new Promise((ok) => {
    const u = new URL(url);
    const r = http.request({ hostname: o.connect || u.hostname, port: u.port, path: u.pathname + u.search, method: o.method || 'GET',
      headers: { ...(o.body !== undefined ? { 'Content-Length': Buffer.byteLength(o.body) } : {}), ...o.headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        ok({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', (e) => ok({ error: e.code || e.message }));
    r.end(o.body);
  });
}
const JSON_CT = { 'Content-Type': 'application/json' };

/* без браузера: оболонка PWA — одна версія в index.html і sw.js, усі файли оболонки існують */
describe('реліз: версії ресурсів і кеш сервіс-воркера', () => {
  test('?v= в index.html = VERSION у sw.js; SHELL_FILES містить усі скрипти, стилі й іконки', () => {
    const html = readFileSync(at('index.html'), 'utf8'), sw = readFileSync(at('sw.js'), 'utf8');
    const manifest = JSON.parse(readFileSync(at('manifest.webmanifest'), 'utf8'));
    const refs = [...html.matchAll(/(?:src|href)="(assets\/[^"?]+\.(?:js|css))(\?v=([^"]*))?"/g)];
    assert.ok(refs.length >= 10, 'ресурсів в index.html: ' + refs.length);
    const vers = new Set(refs.map((m) => m[3]));
    assert.equal(vers.size, 1, 'одна версія для всіх ресурсів: ' + [...vers].join(', '));
    const v = [...vers][0];
    assert.ok(v, 'ресурси мають ?v=');
    assert.equal(/var VERSION = 'v([^']+)'/.exec(sw)[1], v, 'VERSION у sw.js');
    const shell = [.../var SHELL_FILES = \[([\s\S]*?)\];/.exec(sw)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    for (const m of refs) assert.ok(shell.includes('./' + m[1] + '?v=' + v), 'SHELL_FILES: ' + m[1]);
    for (const f of ['operator.js', 'manager.js', 'operator.css', 'manager.css']) assert.ok(shell.includes('./assets/' + f + '?v=' + v), f);
    const icons = manifest.icons.map((i) => i.src).concat([...html.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="([^"]+)"/g)].map((m) => m[1]));
    for (const i of icons) assert.ok(shell.includes('./' + i), 'іконка в SHELL_FILES: ' + i);
    for (const f of shell) {
      const p = f === './' ? 'index.html' : f.replace(/^\.\//, '').replace(/\?.*$/, '');
      assert.ok(existsSync(at(p)), 'файл існує: ' + p);
    }
  });
});

/* без браузера: службові адреси емулятора не видають токен/PIN і не виконують команди чужих сторінок */
describe('dev-server: службові адреси й режим «мережі немає»', () => {
  test('стан без токена й PIN і без CORS; команди — лише POST application/json з тієї ж адреси', async () => {
    const srv = await startDevServer({ port: 0, quiet: true, seed: true, token: TOKEN, adminPin: PIN });
    try {
      const events = async () => (await H.sheet(srv, 'Журнал стану')).rows.length;
      const n0 = await events();
      assert.ok(n0 > 0, 'демо-дані в «Журнал стану»');
      const C = srv.url + '__control';

      let r = await raw(C);
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
      assert.ok(!('token' in r.json) && !('admin_pin' in r.json), 'без token / admin_pin: ' + r.text);
      assert.ok(!r.text.includes(TOKEN) && !r.text.includes(PIN), 'ні токена, ні PIN у відповіді');
      assert.equal(r.headers['access-control-allow-origin'], undefined, 'службові адреси — без CORS');
      for (const u of ['__sheets?name=' + encodeURIComponent('Персонал') + '&values=1', '__mails', '__requests']) {
        r = await raw(srv.url + u);
        assert.equal(r.status, 200, u);
        assert.equal(r.headers['access-control-allow-origin'], undefined, 'без CORS: ' + u);
      }

      // команди з адресного рядка / <img src> (GET) — 405, нічого не змінюється
      for (const q of ['reset=1', 'down=1', 'offline=1', 'run=seedDemoData', 'loseResponses=5']) {
        r = await raw(C + '?' + q);
        assert.equal(r.status, 405, 'GET ?' + q);
        assert.equal(r.headers.allow, 'POST');
      }
      // text/plain (form enctype=text/plain, fetch no-cors) і без Content-Type — 415
      r = await raw(C, { method: 'POST', body: '{"reset":true}', headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
      assert.equal(r.status, 415);
      r = await raw(C, { method: 'POST', body: '{"reset":true}' });
      assert.equal(r.status, 415, 'без Content-Type');
      // preflight не підтримано → браузер не надішле application/json з чужої сторінки
      r = await raw(C, { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
      assert.ok(r.status >= 400, 'OPTIONS: ' + r.status);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
      // чужа сторінка (Origin / Sec-Fetch-Site) і чужий Host (DNS rebinding) — 403
      const host = new URL(srv.url).host;
      const denied = [
        ['Origin чужий', C, { method: 'POST', body: '{"reset":true}', headers: { ...JSON_CT, Origin: 'http://evil.example' } }],
        ['Origin null', C, { method: 'POST', body: '{"reset":true}', headers: { ...JSON_CT, Origin: 'null' } }],
        ['Sec-Fetch-Site: cross-site', C, { method: 'POST', body: '{"reset":true}', headers: { ...JSON_CT, 'Sec-Fetch-Site': 'cross-site' } }],
        ['Host чужий (POST)', C, { method: 'POST', body: '{"reset":true}', headers: { ...JSON_CT, Host: 'evil.example:' + srv.port, Origin: 'http://evil.example:' + srv.port } }],
        ['Host чужий (GET /__sheets)', srv.url + '__sheets?name=' + encodeURIComponent('Персонал'), { headers: { Host: 'rebind.evil.example:' + srv.port } }],
        ['Sec-Fetch-Site: same-site (GET /__control)', C, { headers: { 'Sec-Fetch-Site': 'same-site' } }]
      ];
      for (const [what, u, o] of denied) {
        r = await raw(u, o);
        assert.equal(r.status, 403, what + ': ' + r.text);
        assert.equal(r.json && r.json.error, 'FORBIDDEN', what);
        assert.ok(!r.text.includes(TOKEN) && !r.text.includes('"PIN"'), what + ': без даних');
      }
      assert.equal(await events(), n0, 'таблицю не скинуто');
      r = await raw(C);
      assert.deepEqual([r.json.down, r.json.offline, r.json.lose_responses], [false, false, 0], 'стан не змінено');

      // та сама адреса: своя Origin, Sec-Fetch-Site: same-origin / none, Host 127.0.0.1 — дозволено
      r = await raw(C, { method: 'POST', body: '{"latency":0}', headers: { 'Content-Type': 'application/json; charset=utf-8', Origin: 'http://' + host, 'Sec-Fetch-Site': 'same-origin' } });
      assert.equal(r.status, 200, r.text);
      r = await raw(C, { headers: { Host: '127.0.0.1:' + srv.port, 'Sec-Fetch-Site': 'none' } });
      assert.equal(r.status, 200, r.text);
      r = await raw(C, { method: 'POST', body: '[1]', headers: JSON_CT });
      assert.equal(r.status, 400, 'тіло — не обʼєкт');
      r = await raw(C, { method: 'PUT', body: '{}', headers: JSON_CT });
      assert.equal(r.status, 405);
      r = await raw(srv.url + '__sheets', { method: 'POST', body: '{}', headers: JSON_CT });
      assert.equal(r.status, 405, 'POST /__sheets');

      // справжня команда: скидання без демо-даних
      const j = await H.control(srv, { reset: true, seed: false });
      assert.equal(j.reset, true);
      assert.ok(!('token' in j) && !('admin_pin' in j));
      assert.equal(await events(), 0, 'нова порожня таблиця');

      // /exec лишається як у Google: CORS * (клієнт звертається з іншого походження)
      r = await raw(srv.endpoint, { method: 'POST', body: JSON.stringify({ action: 'ping', token: TOKEN }), headers: { 'Content-Type': 'text/plain;charset=utf-8', Origin: 'http://tablet.example' } });
      assert.equal(r.status, 200);
      assert.equal(r.headers['access-control-allow-origin'], '*');
      assert.equal(r.json.ok, true);
    } finally { await srv.close(); }
  });

  test('з мережі службові адреси — 403 (без --expose-control), /exec і статика працюють; файл --persist не роздається', async (t) => {
    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    const dir = mkdtempSync(join(tmpdir(), 'fl-dev-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
    const persist = join(dir, 'data.json');
    const srv = await startDevServer({ port: 0, host: '0.0.0.0', quiet: true, token: TOKEN, adminPin: PIN, root: dir, persistFile: persist });
    let exposed = null;
    try {
      assert.ok(existsSync(persist), 'таблицю збережено у файл');
      assert.ok(readFileSync(persist, 'utf8').includes(TOKEN), 'у файлі — токен (тому його й не роздаємо)');
      for (const u of ['data.json', 'data.json.tmp', './data.json', 'x/../data.json', 'data%2Ejson']) {
        const r = await raw(srv.url + u);
        assert.equal(r.status, 404, u);
        assert.ok(!r.text.includes(TOKEN), u + ': без токена');
      }
      assert.equal((await raw(srv.url)).status, 200, 'index.html роздається');
      assert.equal((await raw(srv.url + '__control')).status, 200, 'з цього компʼютера — можна');
      if (!lan) { t.diagnostic('немає мережевого інтерфейсу IPv4 — перевірку «з мережі» пропущено'); return; }

      const fromLan = (u, o = {}) => raw(srv.url + u, { ...o, connect: lan.address, headers: { Host: lan.address + ':' + srv.port, ...o.headers } });
      for (const u of ['__control', '__sheets', '__mails', '__requests']) {
        const r = await fromLan(u);
        assert.equal(r.status, 403, 'з мережі: ' + u);
        assert.match(r.json.message, /--expose-control/);
        assert.ok(!r.text.includes(TOKEN) && !r.text.includes('"PIN"'));
      }
      let r = await fromLan('__control', { method: 'POST', body: '{"reset":true}', headers: JSON_CT });
      assert.equal(r.status, 403, 'з мережі: POST /__control');
      r = await fromLan('exec', { method: 'POST', body: JSON.stringify({ action: 'ping', token: TOKEN }), headers: { 'Content-Type': 'text/plain' } });
      assert.equal(r.status, 200, 'з мережі: /exec');
      assert.equal(r.json.ok, true);
      assert.equal((await fromLan('')).status, 200, 'з мережі: статика');

      // --expose-control: явно дозволено з мережі (але без токена/PIN у відповіді)
      exposed = await startDevServer({ port: 0, host: '0.0.0.0', quiet: true, token: TOKEN, adminPin: PIN, root: dir, exposeControl: true });
      r = await raw(exposed.url + '__control', { connect: lan.address, headers: { Host: lan.address + ':' + exposed.port } });
      assert.equal(r.status, 200, r.text);
      assert.ok(!r.text.includes(TOKEN));
    } finally {
      await srv.close();
      if (exposed) await exposed.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('{offline:true}: обриваються і статичні файли, і /exec; службові адреси працюють; reset знімає', async () => {
    const srv = await startDevServer({ port: 0, quiet: true, token: TOKEN, adminPin: PIN });
    try {
      assert.equal((await raw(srv.url + 'index.html')).status, 200);
      let st = await H.control(srv, { offline: true });
      assert.equal(st.offline, true);
      const s0 = st.static_served;
      for (const u of ['', 'index.html', 'sw.js', 'assets/app.js?v=' + ASSET_V]) assert.ok((await raw(srv.url + u)).error, 'обірвано: /' + u);
      assert.ok((await raw(srv.endpoint, { method: 'POST', body: '{"action":"ping"}', headers: { 'Content-Type': 'text/plain' } })).error, 'обірвано: POST /exec');
      assert.ok((await raw(srv.endpoint + '?action=ping&callback=cb')).error, 'обірвано: GET /exec (JSONP)');
      assert.equal((await raw(srv.url + '__sheets')).status, 200, 'службові адреси працюють');
      st = await H.control(srv);
      assert.deepEqual([st.static_served, st.dropped_static, st.dropped_exec], [s0, 4, 2], JSON.stringify(st));
      assert.equal(srv.stats().dropped_static, 4);

      await H.control(srv, { offline: false });
      assert.equal((await raw(srv.url + 'index.html')).status, 200);
      assert.equal((await H.control(srv)).static_served, s0 + 1);
      srv.setOffline(true);
      assert.ok((await raw(srv.url)).error, 'srv.setOffline(true)');
      await H.control(srv, { reset: true });
      assert.equal((await raw(srv.url)).status, 200, 'reset знімає «мережі немає»');
      assert.deepEqual([srv.stats().offline, srv.stats().dropped_static], [false, 0]);
    } finally { await srv.close(); }
  });
});

if (skip) {
  console.log('# e2e пропущено: ' + skip);
  test('e2e (Playwright + Chromium)', { skip }, () => {});
} else {
  after(async () => { await browser.close(); });

  describe('демо-режим (дані в браузері)', () => {
    test('майстер → 3 лінії → повна зміна оператора на лінії 2 → історія', T, () => run({}, async ({ page, srv }) => {
      await H.setupDemo(page, srv.url);
      const tiles = await tilesOf(page);
      assert.deepEqual(tiles.map((t) => t.id), ['L1', 'L2', 'L3']);
      assert.match(tiles[0].cls, /\bst-run\b/);
      assert.match(tiles[1].cls, /\bst-off\b/);
      assert.match(tiles[2].cls, /\bst-stop\b/);
      assert.match(tiles[0].status, /Працює/);
      assert.match(tiles[1].status, /Не працює/);
      assert.match(tiles[2].status, /Простій/);

      // підготовка і запуск: чек-лист із числом поза нормою (з приміткою)
      await page.click('.ltile[data-line="L2"]');
      await page.waitForSelector('.op-status.st-off');
      await page.click('[data-act=start]');
      await page.waitForSelector('.modal-operator');
      await page.click('.modal-operator [data-staff="S2"]');
      await page.waitForSelector('.op-ck');
      assert.match(await page.evaluate(() => location.hash), /^#\/line\/L2\/check\/start/);
      const n = await H.fillChecklist(page, { bad: { 'Температура продукту': '34,5' }, note: 'Продукт теплий — охолодили, повторний замір' });
      assert.ok(n >= 8, 'пунктів чек-листа: ' + n);
      assert.match(await page.$eval('.op-item[data-item="I209"]', (e) => e.className), /\bis-bad\b/, 'число поза нормою позначено');
      await page.fill('.op-ck input[name=product]', 'Соус «Часниковий» 200 г');
      await page.click('[data-ck=go]');
      await page.waitForSelector('.op-sum-modal');
      assert.match(await page.textContent('.op-sum-modal'), /поза нормою|зауваж/i);
      await page.click('.op-sum-modal .modal-foot .btn.ok');
      let s = await H.waitState(page, 'L2', 'run', { settled: true });
      assert.equal(s.product, 'Соус «Часниковий» 200 г');
      assert.equal(s.operator, 'Ігор Мельник');
      assert.deepEqual([s.last_check.occasion, s.last_check.result], ['start', 'remarks'], 'чек-лист «із зауваженнями»');
      await page.waitForSelector('.op-status.st-run');

      // простій із причиною → відновлення
      await page.click('[data-act=stop]');
      await page.waitForSelector('.op-reasons');
      await page.click('.op-reasons .chip[data-value="Перерва"]');
      await page.click('.modal-foot .btn.primary');
      s = await H.waitState(page, 'L2', 'stop', { settled: true });
      assert.equal(s.reason, 'Перерва');
      await page.waitForSelector('.op-status.st-stop');
      await page.click('[data-act=resume]');
      await H.waitState(page, 'L2', 'run', { settled: true });
      await page.waitForSelector('.op-status.st-run');
      await afterDirectWrite(page);

      // завершення: чек-лист + лічильник продукції → «Не працює»
      await page.click('[data-act=end]');
      await page.waitForSelector('.op-ck');
      assert.match(await page.evaluate(() => location.hash), /\/check\/end/);
      await H.fillChecklist(page);
      await page.fill('.op-mtrs input[name^=mv_]', '12 400');
      await page.click('[data-ck=go]');
      await page.waitForSelector('.op-sum-modal');
      await page.click('.op-sum-modal .modal-foot .btn.primary');
      await H.waitState(page, 'L2', 'off', { settled: true });
      await page.waitForSelector('.op-status.st-off');

      // історія лінії: сьогоднішні записи зміни
      await page.click('.op-quick a[href$="/history"]');
      await page.waitForSelector('.op-hdays');
      await page.waitForSelector('.op-rec[data-rec=check]');
      const recs = await page.$$eval('.op-hgroup', (gs) => {
        const g = gs.find((x) => /сьогодні/i.test(x.textContent)) || gs[0];
        return [...g.querySelectorAll('.op-rec')].map((e) => ({ kind: e.getAttribute('data-rec'), text: e.textContent.replace(/\s+/g, ' ').trim() }));
      });
      const txt = recs.map((r) => r.text).join('\n');
      for (const re of [/Чек-лист запуску/, /Чек-лист завершення/, /Працює/, /Простій/, /Перерва/, /Не працює/, /12[\s  ]?400/]) assert.match(txt, re);
      // відповіді чек-листа запуску: число поза нормою з приміткою
      const startRec = await page.$$('.op-rec[data-rec=check]');
      let found = false;
      for (const r of startRec) {
        if (!/запуску/.test(await r.textContent())) continue;
        await r.click();
        await page.waitForSelector('.op-ans');
        const a = await page.textContent('.op-ans:has(.op-an.bad)').catch(() => '');
        assert.match(a, /34,5/);
        assert.match(a, /охолодили/);
        found = true;
        break;
      }
      assert.ok(found, 'є чек-лист запуску в історії');
      await page.keyboard.press('Escape');
    }));

    test('Api.write під час активного надсилання не чекає страховочного таймера', T, () => run({}, async ({ page, srv }) => {
      await H.setupDemo(page, srv.url);
      const r = await page.evaluate(async () => {
        await Api.write('event', { line_id: 'L3', state: 'setup', operator: 'Тест' });
        const w2 = Api.write('event', { line_id: 'L3', state: 'stop', reason: 'Інше', operator: 'Тест' });
        const t0 = Date.now();
        while (Api.net().pending && Date.now() - t0 < 5000) await new Promise((ok) => setTimeout(ok, 20));
        const res = await w2;
        return { pending: Api.net().pending, ms: Date.now() - t0, queued: res.queued, ok: res.ok, state: App.lineStatus('L3').state };
      });
      assert.equal(r.pending, 0, 'черга спорожніла');
      assert.ok(r.ms < 2000, 'надіслано за ' + r.ms + ' мс');
      assert.equal(r.ok, true);
      assert.equal(r.queued, false);
      assert.equal(r.state, 'stop');
    }));

    test('керівник: PIN → огляд і матриця чек-листів → річний графік → нова лінія, агрегат, пункт, регламент', T, () => run({}, async ({ page, srv }) => {
      await H.setupDemo(page, srv.url);
      await page.goto(srv.url + '#/m');
      await H.enterPin(page, '1234');
      await page.waitForFunction(() => location.hash.indexOf('#/m/overview') === 0);
      await page.waitForSelector('.m-kpi .m-kpi-v');
      await page.waitForSelector('table.m-mx tbody tr');
      const kpis = await page.$$eval('.m-kpi', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
      assert.ok(kpis.length >= 6, 'KPI: ' + kpis.length);
      for (const re of [/Прострочено ТО/, /Скоро ТО/]) assert.ok(kpis.some((k) => re.test(k)), 'KPI ' + re);
      const mx = await page.$$eval('table.m-mx tbody tr', (rows) => rows.map((r) => ({ name: r.querySelector('th').textContent.trim(), cells: r.querySelectorAll('td').length })));
      assert.equal(mx.length, 3);
      assert.ok(mx.every((r) => r.cells >= 14), 'дні матриці: ' + JSON.stringify(mx));

      // ТО і ППР: канонічний id 'maintenance' і псевдонім 'maint'
      await page.goto(srv.url + '#/m/maint?tab=year');
      await page.waitForSelector('table.m-yr td.m-yc.has', { timeout: 20000 });
      const yr = await page.evaluate(() => ({ months: document.querySelectorAll('table.m-yr thead th').length - 1, cells: document.querySelectorAll('table.m-yr td.m-yc.has').length }));
      assert.equal(yr.months, 12);
      assert.ok(yr.cells > 5, 'клітинок із роботами: ' + yr.cells);

      // Обладнання: лінія → агрегат → пункт чек-листа → регламент
      await page.goto(srv.url + '#/m/equipment');
      await page.waitForSelector('[data-m="add-line"]');
      const ok = () => page.click('.m-formm .modal-foot .btn.primary');
      const closed = () => page.waitForSelector('.m-formm', { state: 'detached', timeout: 15000 });
      await page.click('[data-m="add-line"]');
      await page.waitForSelector('.m-formm');
      await page.fill('.m-formm input[name=name]', 'Лінія фасування №4 (банка)');
      await page.fill('.m-formm input[name=kind]', 'Фасувальна');
      await ok();
      await page.waitForFunction(() => /^#\/m\/equipment\/[^/?]+/.test(location.hash));
      await page.waitForSelector('.m-eqtabs');
      const lineId = await page.evaluate(() => decodeURIComponent(location.hash.split('/')[3].split('?')[0]));

      await page.click('[data-m="add-unit"]');
      await page.waitForSelector('.m-formm');
      await page.fill('.m-formm input[name=name]', 'Дозатор для банки');
      await ok(); await closed();
      await page.waitForFunction(() => document.querySelectorAll('.m-eqc tr[data-open^="unit:"]').length === 1);

      await page.click('.m-eqtabs [data-value="items"]');
      await page.waitForSelector('[data-m="add-item"]');
      await page.click('[data-m="add-item"]');
      await page.waitForSelector('.m-formm');
      await page.fill('.m-formm input[name=section]', 'Параметри');
      await page.fill('.m-formm textarea[name=text]', 'Тиск повітря, бар');
      await page.click('.m-formm [data-chips="type"] [data-value="number"]');
      await page.fill('.m-formm input[name=unit_label]', 'бар');
      await page.fill('.m-formm input[name=min]', '5,5');
      await page.fill('.m-formm input[name=max]', '7');
      await ok(); await closed();
      await page.waitForFunction(() => document.querySelectorAll('.m-eqc .m-item').length === 1);

      await page.click('.m-eqtabs [data-value="rules"]');
      await page.waitForSelector('[data-m="add-rule"]');
      await page.click('[data-m="add-rule"]');
      await page.waitForSelector('.m-formm');
      await page.fill('.m-formm input[name=title]', 'Змащення дозатора');
      await page.fill('.m-formm input[name=interval_days]', '30');
      await ok(); await closed();
      await page.waitForSelector('.m-eqc .m-rule');

      await page.goto(srv.url + '#/');
      await page.waitForSelector(`.ltile[data-line="${lineId}"]`, { timeout: 15000 });
      const tiles = await tilesOf(page);
      assert.equal(tiles.length, 4);
      const t = tiles.find((x) => x.id === lineId);
      assert.equal(t.name, 'Лінія фасування №4 (банка)');
      assert.match(t.cls, /\bst-off\b/);
      const cfg = await page.evaluate((id) => ({ items: App.itemsFor(id, 'start').map((i) => [i.text, i.min, i.max]), rules: App.rulesOf(id).map((r) => [r.title, r.interval_days]), units: App.unitsOf(id).length }), lineId);
      assert.deepEqual(cfg.items, [['Тиск повітря, бар', 5.5, 7]]);
      assert.deepEqual(cfg.rules, [['Змащення дозатора', 30]]);
      assert.equal(cfg.units, 1);
    }));

    test('брудний чек-лист: «Назад» браузера → «Залишитися» → збереження → екран лінії; «Назад» застосунку → головний', T, () => run({
      config: () => H.localConfig({ operator: H.operatorFor('S3', 'Наталія Бондар') })
    }, async ({ page, srv }) => {
      const hash = () => page.evaluate(() => location.hash);
      // історія: головний → лінія 3 → чек-лист завершення
      await page.goto(srv.url + '#/');
      await page.waitForSelector('.ltile[data-line="L3"].st-stop', { timeout: 30000 });
      await page.click('.ltile[data-line="L3"]');
      await page.waitForSelector('.op-status.st-stop');
      await page.click('[data-act=end]');
      await page.waitForSelector('.op-ck');
      assert.equal(await hash(), '#/line/L3/check/end');
      await H.fillChecklist(page);
      const prog = await page.textContent('#ckProgT');
      await page.evaluate(() => { window.__ck = document.querySelector('.op-ck'); });
      assert.equal(await page.evaluate(() => App.isDirty()), true, 'чек-лист «брудний»');

      // «Назад» браузера → «Покинути екран?» → «Залишитися»: той самий екран із відповідями
      await page.goBack();
      await page.waitForSelector('.modal-confirm');
      assert.match(await page.textContent('.modal-confirm .modal-foot .btn.ghost'), /Залишитися/);
      await page.click('.modal-confirm .modal-foot .btn.ghost');
      await page.waitForSelector('.modal-confirm', { state: 'detached' });
      await page.waitForTimeout(300);                 // скасування переходу — окремою подією hashchange
      assert.equal(await hash(), '#/line/L3/check/end', 'залишилися на чек-листі');
      assert.ok(await page.evaluate(() => document.querySelector('.op-ck') === window.__ck), 'екран не перемальовано');
      assert.equal(await page.textContent('#ckProgT'), prog, 'відповіді на місці');
      assert.equal(await page.evaluate(() => App.isDirty()), true);

      // збереження → екран лінії (крок назад в історії, а не на головний)
      await page.click('[data-ck=go]');
      await page.waitForSelector('.op-sum-modal');
      await page.click('.op-sum-modal .modal-foot .btn.primary');
      await H.waitState(page, 'L3', 'off', { settled: true });
      await page.waitForSelector('.op-status.st-off');
      assert.equal(await hash(), '#/line/L3', 'після збереження — екран лінії');
      assert.equal(await page.evaluate(() => App.lineStatus('L3').last_check.occasion), 'end');

      // «Назад» у заголовку екрана лінії → головний (запис історії чек-листа не «застряг» попереду)
      await page.click('.page-head [data-back]');
      await page.waitForSelector('.ltile[data-line="L3"].st-off');
      assert.equal(await hash(), '#/');
      assert.equal(await page.$('.modal-confirm'), null, 'без питання «Покинути екран?»');
    }));

    test('подвійний дотик по «Підготовка і запуск»: другий дотик не натискає кнопку у вікні вибору людини, що відкрилося під пальцем', T, () => run({
      hasTouch: true, config: () => H.localConfig()
    }, async ({ page, srv }) => {
      await page.goto(srv.url + '#/line/L2');
      await page.waitForSelector('.op-status.st-off', { timeout: 30000 });
      assert.equal(await page.evaluate(() => App.operator()), null, 'оператора не вибрано');
      const who = async () => page.evaluate(() => ({
        op: App.operator(), q: Api.queue().length, hash: location.hash,
        modals: [...document.querySelectorAll('.modal h2')].map((h) => h.textContent)
      }));
      const b = await page.locator('[data-act=start]').boundingBox();
      const x = b.x + b.width / 2, y = b.y + b.height / 2;

      // дотик → вікно «Хто працює на лінії?» під пальцем → другий дотик у ту саму точку через 150 мс
      await page.touchscreen.tap(x, y);
      await page.waitForSelector('.modal-operator');
      await page.waitForTimeout(150);
      // під пальцем — кнопка вікна (людина, «Інша людина» чи «Скасувати»): без захисту дотик натиснув би її
      const under = await page.evaluate(([x, y]) => {
        const e = document.elementFromPoint(x, y), b = e && e.closest('.modal-operator button');
        return b ? b.textContent.replace(/\s+/g, ' ').trim() : (e ? e.tagName + '.' + e.className : null);
      }, [x, y]);
      assert.ok(await page.evaluate(([x, y]) => !!(document.elementFromPoint(x, y) || document.body).closest('.modal-operator button'), [x, y]),
        'під другим дотиком — кнопка у вікні вибору: ' + under);
      await page.touchscreen.tap(x, y);
      await page.waitForTimeout(700);
      let r = await who();
      assert.equal(r.op, null, 'другий дотик нікого не вибрав');
      assert.deepEqual(r.modals, ['Хто працює на лінії?'], 'вікно вибору відкрите, інших вікон немає (' + under + ')');
      assert.equal(r.hash, '#/line/L2');
      assert.equal(r.q, 0);

      // миша: подвійне клацання — так само
      await page.keyboard.press('Escape');
      await page.waitForSelector('.modal-operator', { state: 'detached' });
      await page.dblclick('[data-act=start]');
      await page.waitForTimeout(700);
      r = await who();
      assert.equal(r.op, null, 'подвійне клацання нікого не вибрало');
      assert.deepEqual(r.modals, ['Хто працює на лінії?']);

      // звичайний дотик по людині після паузи — вибирає
      await page.locator('.modal-operator [data-staff="S2"]').tap();
      await page.waitForSelector('.op-ck');
      r = await who();
      assert.equal(r.op && r.op.name, 'Ігор Мельник');
      assert.match(r.hash, /^#\/line\/L2\/check\/start/);
    }));

    test('360 px: без горизонтальної прокрутки на головному екрані й екранах ліній', T, () => run({ viewport: { width: 360, height: 740 } }, async ({ page, srv }) => {
      await H.setupDemo(page, srv.url);
      const check = async (what) => {
        const o = await H.horizontalOverflow(page);
        assert.ok(o.over <= 1, what + ': ширше за екран на ' + o.over + ' px ' + JSON.stringify(o.wide));
      };
      await check('головний екран');
      for (const id of ['L1', 'L2', 'L3']) {
        await page.goto(srv.url + '#/line/' + id);
        await page.waitForSelector('.op-status');
        await page.waitForSelector('.op-maint');
        await check('лінія ' + id);
      }
      await page.goto(srv.url + '#/line/L2/history');
      await page.waitForSelector('.op-hdays');
      await check('історія лінії L2');
    }));
  });

  describe('віддалений режим (dev-server: Server.gs над таблицею в памʼяті)', () => {
    test('майстер: адреса + токен + перевірка → лінії з таблиці → чек-лист запуску і запуск → рядки в аркушах', T, () => run({ seed: true }, async ({ page, srv }) => {
      const DEV = 'Планшет e2e · лінія 2';
      await H.setupRemote(page, srv.url, srv.endpoint, srv.token, DEV);
      const tiles = await tilesOf(page);
      assert.deepEqual(tiles.map((t) => t.id), ['L1', 'L2', 'L3']);
      assert.match(tiles[1].cls, /\bst-off\b/);
      assert.equal(await page.evaluate(() => App.mode()), 'remote');

      await page.click('.ltile[data-line="L2"]');
      await page.waitForSelector('.op-status.st-off');
      await page.click('[data-act=start]');
      await page.waitForSelector('.modal-operator');
      await page.click('.modal-operator [data-staff="S2"]');
      await page.waitForSelector('.op-ck');
      await H.fillChecklist(page);
      await page.fill('.op-ck input[name=product]', 'Кетчуп «Лагідний» 250 г');
      await page.click('[data-ck=go]');
      await page.waitForSelector('.op-sum-modal');
      await page.click('.op-sum-modal .modal-foot .btn.ok');
      const s = await H.waitState(page, 'L2', 'run', { settled: true });
      await H.waitQueueEmpty(page);

      const ev = byId((await H.sheet(srv, 'Журнал стану')).rows, s.event_id);
      assert.equal(ev.length, 1, 'подія запуску в «Журнал стану»');
      assert.equal(ev[0]['ID лінії'], 'L2');
      assert.equal(ev[0]['Стан'], 'Працює');
      assert.equal(ev[0]['Попередній стан'], 'Не працює');
      assert.equal(ev[0]['Оператор'], 'Ігор Мельник');
      assert.equal(ev[0]['Продукт / формат'], 'Кетчуп «Лагідний» 250 г');
      assert.equal(ev[0]['Пристрій'], DEV);
      assert.ok(!isNaN(Date.parse(ev[0]['Час'])), 'Час — дата');
      assert.equal(s.last_check.occasion, 'start');
      assert.equal(s.last_check.result, 'ok');
      const checks = byId((await H.sheet(srv, 'Чек-листи')).rows, s.last_check.id);
      assert.equal(checks.length, 1, 'чек-лист у «Чек-листи»');
      assert.equal(checks[0]['ID лінії'], 'L2');
      assert.equal(checks[0]['Пристрій'], DEV);
      assert.equal(checks[0]['Коли'], 'Запуск');
      assert.equal(checks[0]['Результат'], 'Норма');
      assert.equal(checks[0]['Оператор'], 'Ігор Мельник');
      const ans = (await H.sheet(srv, 'Чек-листи — відповіді')).rows.filter((r) => r['ID чек-листа'] === checks[0].ID);
      assert.equal(ans.length, checks[0]['Пунктів']);
      assert.ok(ans.some((a) => a['Значення'] === 'Норма'));
    }));

    test('«аварія» зʼєднання: простій і відновлення в черзі → оптимістичний стан → повтор без дублікатів', T, () => run({
      seed: true, allow: H.NET_NOISE,
      config: (srv) => H.remoteConfig(srv.endpoint, srv.token, { device: 'Планшет лінії 1', operator: H.operatorFor('S4', 'Сергій Ткаченко') })
    }, async ({ page, srv }) => {
      await page.goto(srv.url + '#/line/L1');
      await page.waitForSelector('.op-status.st-run', { timeout: 20000 });
      await page.waitForFunction(() => Api.net().online === true);

      await H.control(srv, { down: true });
      await page.click('[data-act=stop]');
      await page.waitForSelector('.op-reasons');
      await page.click('.op-reasons .chip[data-value="Очікування"]');
      await page.click('.modal-foot .btn.primary');
      let s = await H.waitState(page, 'L1', 'stop');
      await page.waitForSelector('.op-status.st-stop');
      await page.waitForFunction(() => Api.net().online === false, null, { timeout: 15000 });
      await page.click('[data-act=resume]');
      s = await H.waitState(page, 'L1', 'run');
      assert.equal(s.pending, 2, 'обидві події в черзі');
      await page.waitForSelector('.op-status.st-run');
      await page.waitForFunction(() => !Api.net().flushing);
      const chip = await page.$eval('#tbNet', (e) => ({ cls: e.className, text: e.textContent.replace(/\s+/g, ' ').trim(), cnt: (e.querySelector('.cnt') || {}).textContent }));
      assert.match(chip.cls, /\bn-bad\b/);
      assert.match(chip.text, /Офлайн/);
      assert.equal(chip.cnt, '2');
      const ids = await page.evaluate(() => Api.queue().map((op) => op.params.id));
      assert.equal(ids.length, 2);
      // на головному екрані — оптимістичний стан і позначка синхронізації
      await page.goto(srv.url + '#/');
      await page.waitForSelector('.ltile[data-line="L1"].st-run.is-pending');
      // вузький екран з індикатором «Офлайн · 2» і позначками черги — без горизонтальної прокрутки
      await page.setViewportSize({ width: 360, height: 740 });
      let o = await H.horizontalOverflow(page);
      assert.ok(o.over <= 1, 'головний екран офлайн, 360 px: ' + JSON.stringify(o));
      await page.goto(srv.url + '#/line/L1');
      await page.waitForSelector('.op-status.st-run');
      o = await H.horizontalOverflow(page);
      assert.ok(o.over <= 1, 'екран лінії офлайн, 360 px: ' + JSON.stringify(o));
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(srv.url + '#/');
      await page.waitForSelector('.ltile[data-line="L1"].is-pending');
      assert.equal((await H.sheet(srv, 'Журнал стану')).rows.filter((r) => ids.includes(r.ID)).length, 0, 'під час аварії на сервер нічого не потрапило');

      // звʼязок відновлено, але першу відповідь на запис «втрачено» (запис виконано) → повтор
      await H.control(srv, { down: false, loseResponses: 1 });
      await page.click('#tbNet');
      await page.waitForSelector('.queue-view');
      for (let i = 0; i < 4; i++) {
        if (await page.evaluate(() => Api.net().pending === 0)) break;
        await page.click('.modal-foot .btn.primary');
        await page.waitForFunction(() => !Api.net().flushing, null, { timeout: 15000 });
      }
      await H.waitQueueEmpty(page);
      await page.keyboard.press('Escape');
      const rows = (await H.sheet(srv, 'Журнал стану')).rows;
      for (const id of ids) assert.equal(byId(rows, id).length, 1, 'рядок ' + id + ' рівно один');
      assert.deepEqual(ids.map((id) => byId(rows, id)[0]['Стан']), ['Простій', 'Працює']);
      assert.equal(byId(rows, ids[0])[0]['Причина'], 'Очікування');
      const reqs = (await (await fetch(srv.url + '__requests')).json()).requests;
      assert.ok(reqs.some((r) => r.lost && r.action === 'batch'), 'була «втрачена» відповідь');
      assert.ok(reqs.some((r) => (r.results || []).includes('duplicate')), 'повтор розпізнано як дублікат');
      await page.waitForSelector('.ltile[data-line="L1"].st-run:not(.is-pending)');
      await page.waitForFunction(() => /\bn-ok\b/.test(document.getElementById('tbNet').className));
    }));

    test('мережа блокує POST → резервний канал JSONP: запис доходить у таблицю', T, () => run({
      seed: true, allow: H.NET_NOISE,
      config: (srv) => H.remoteConfig(srv.endpoint, srv.token, { device: 'Планшет JSONP', operator: H.operatorFor('S1', 'Олена Коваленко') })
    }, async ({ page, srv }) => {
      await H.control(srv, { blockPost: true });
      await page.goto(srv.url + '#/line/L1');
      await page.waitForSelector('.op-status.st-run', { timeout: 20000 });
      await page.waitForFunction(() => Api.net().transport === 'jsonp' && Api.net().online === true, null, { timeout: 15000 });
      await page.click('[data-act=stop]');
      await page.waitForSelector('.op-reasons');
      await page.click('.op-reasons .chip[data-value="Перерва"]');
      await page.click('.modal-foot .btn.primary');
      const s = await H.waitState(page, 'L1', 'stop', { settled: true });
      await H.waitQueueEmpty(page);
      const ev = byId((await H.sheet(srv, 'Журнал стану')).rows, s.event_id);
      assert.equal(ev.length, 1);
      assert.equal(ev[0]['Стан'], 'Простій');
      assert.equal(ev[0]['Пристрій'], 'Планшет JSONP');
      const reqs = (await (await fetch(srv.url + '__requests')).json()).requests;
      assert.ok(reqs.some((r) => r.method === 'GET' && r.action === 'batch' && r.ok), 'пакет записів надіслано GET-запитом (JSONP)');
      assert.ok(!reqs.some((r) => r.method === 'POST'), 'POST не дійшов до сервера');
    }));

    test('JSONP: запис, завеликий для адреси GET, не блокує чергу → POST знову працює → «Надіслати зараз» надсилає його основним каналом', T, () => run({
      seed: true, allow: H.NET_NOISE, config: (srv) => H.remoteConfig(srv.endpoint, srv.token, { device: 'Планшет JSONP' })
    }, async ({ page, srv }) => {
      await page.goto(srv.url + '#/');
      await page.waitForSelector('.ltile[data-line="L2"]', { timeout: 20000 });
      await page.waitForFunction(() => Api.net().online === true && Api.net().transport === 'post');
      srv.blockPost(true);
      await page.evaluate(() => Api.call('ping', {}));
      assert.equal(await page.evaluate(() => Api.net().transport), 'jsonp', 'POST обривається → резервний канал');

      // ~1250 символів кирилиці: у адресі GET це ~7,5 КБ (%XX%XX на літеру) — більше за межу JSONP
      const desc = 'Замінено ущільнювачі клапана дозатора, перевірено тиск і хід поршня. '.repeat(18).slice(0, 1250).trim();
      const w = await page.evaluate((d) => Api.write('work', { line_id: 'L2', work_type: 'repair', title: 'Ремонт дозатора (довгий опис)',
        description: d, performer: 'Віктор Олійник', status: 'done' }, { wait: 1500 }), desc);
      assert.deepEqual([w.ok, w.queued], [true, true], 'великий запис лишився в черзі');
      const e = await page.evaluate(() => Api.write('event', { line_id: 'L2', state: 'clean', reason: 'Миття', operator: 'Тест' }, { wait: 10000 }));
      assert.deepEqual([e.ok, e.queued], [true, false], 'наступний запис підтверджено, не чекаючи великого: ' + JSON.stringify(e));
      const q = await page.evaluate(() => Api.queue().map((op) => ({ action: op.action, id: op.params.id, error: op.last_error && op.last_error.error })));
      assert.deepEqual(q, [{ action: 'work', id: w.op.params.id, error: 'TOO_LARGE' }], 'у черзі — лише великий запис');
      let reqs = (await (await fetch(srv.url + '__requests')).json()).requests;
      const withId = (id) => reqs.filter((r) => (r.ops || []).some((x) => x.id === id));
      assert.ok(withId(e.op.params.id).some((r) => r.method === 'GET' && r.action === 'batch' && r.ok), 'подію надіслано JSONP');
      assert.deepEqual(withId(w.op.params.id), [], 'великий запис на сервер не надсилався');
      assert.equal(byId((await H.sheet(srv, 'Журнал стану')).rows, e.op.params.id).length, 1, 'подія в «Журнал стану»');

      // мережа знову пропускає POST → «Надіслати зараз» (після postReprobeForceMs) перевіряє POST і надсилає великий запис
      srv.blockPost(false);
      await page.evaluate(() => { Api.options.postReprobeForceMs = 1000; });
      await page.waitForTimeout(1100);
      await page.evaluate(() => Api.flush(true));
      await H.waitQueueEmpty(page);
      assert.equal(await page.evaluate(() => Api.net().transport), 'post', 'канал — знову POST');
      reqs = (await (await fetch(srv.url + '__requests')).json()).requests;
      assert.ok(withId(w.op.params.id).some((r) => r.method === 'POST' && r.ok), 'великий запис надіслано POST');
      const works = byId((await H.sheet(srv, 'Журнал робіт')).rows, w.op.params.id);
      assert.equal(works.length, 1, 'рівно один рядок у «Журнал робіт»');
      assert.equal(works[0]['Опис'], desc);
    }));

    test('PWA: сервіс-воркер кешує оболонку → старт без мережі з кешу → запис у черзі → мережа є → рядок у таблиці', T, () => run({
      seed: true, serviceWorkers: 'allow', allow: H.NET_NOISE,
      config: (srv) => H.remoteConfig(srv.endpoint, srv.token, { operator: H.operatorFor('S4', 'Сергій Ткаченко') })
    }, async ({ page, ctx, srv }) => {
      await page.goto(srv.url);
      await page.waitForSelector('.ltile');
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
      const cached = await page.evaluate(async () => {
        const keys = await caches.keys(), shell = keys.find((k) => /^fl-lines-shell-/.test(k));
        return shell ? (await (await caches.open(shell)).keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search) : [];
      });
      // уся оболонка з sw.js (SHELL_FILES) — у кеші
      const shell = shellFiles().map((f) => { const u = new URL(f, srv.url); return u.pathname + u.search; });
      assert.ok(shell.includes('/assets/api.js?v=' + ASSET_V), 'SHELL_FILES з версією ' + ASSET_V);
      assert.deepEqual(shell.filter((u) => !cached.includes(u)), [], 'усі файли оболонки в кеші');

      // мережі немає по-справжньому: context.setOffline не зачіпає запитів сервіс-воркера, тож сервер
      // обриває ВСІ зʼєднання (статика й /exec) — оболонку можна взяти лише з кешу сервіс-воркера
      await H.control(srv, { offline: true });
      await ctx.setOffline(true);                     // navigator.onLine = false на сторінці
      const before = await H.control(srv);
      await page.reload();
      await page.waitForSelector('.ltile[data-line="L1"].st-run', { timeout: 15000 });
      await page.waitForFunction(() => /\bn-bad\b/.test(document.getElementById('tbNet').className));
      assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'сторінкою керує сервіс-воркер');
      const during = await H.control(srv);
      assert.equal(during.static_served, before.static_served, 'жодного статичного файлу з мережі');
      assert.ok(during.dropped_static > before.dropped_static, 'сервіс-воркер спершу пробував мережу — зʼєднання обірвано');
      await page.goto(srv.url + '#/line/L1');
      await page.waitForSelector('.op-status.st-run');
      await page.click('[data-act=stop]');
      await page.waitForSelector('.op-reasons');
      await page.click('.op-reasons .chip[data-value="Перерва"]');
      await page.click('.modal-foot .btn.primary');
      const s = await H.waitState(page, 'L1', 'stop');
      assert.equal(s.pending, 1);
      const id = await page.evaluate(() => Api.queue()[0].params.id);

      assert.equal((await H.control(srv)).static_served, before.static_served, 'офлайн: статика лише з кешу');
      await H.control(srv, { offline: false });
      await ctx.setOffline(false);                    // подія 'online' → надсилання черги
      await H.waitQueueEmpty(page, 30000);
      const ev = byId((await H.sheet(srv, 'Журнал стану')).rows, id);
      assert.equal(ev.length, 1);
      assert.equal(ev[0]['Стан'], 'Простій');
    }));

    test('ТО з екрана лінії: «Позначити виконаним» → строк стає «У нормі», робота в «Журнал робіт»', T, () => run({
      seed: true, config: (srv) => H.remoteConfig(srv.endpoint, srv.token, { operator: H.operatorFor('S4', 'Сергій Ткаченко') })
    }, async ({ page, srv }) => {
      await page.goto(srv.url + '#/');
      await page.waitForSelector('.ltile');
      const d = await page.evaluate(() => App.state.due.filter((x) => x.status === 'due')[0]);
      assert.ok(d, 'у демо-даних є прострочена робота');
      await page.goto(srv.url + '#/line/' + d.line_id);
      const row = `.op-maint .op-due[data-rule="${d.rule_id}"]`;
      await page.waitForSelector(row + '.s-due');
      await page.click(row);
      await page.waitForSelector('.op-due-d');
      await page.click('.modal-foot .btn.primary');
      await page.waitForSelector('.op-wf-modal');
      await page.click('.op-wf-modal .modal-foot .btn.primary');
      await page.waitForSelector('.op-wf-modal', { state: 'detached' });
      await H.waitQueueEmpty(page);
      await page.waitForFunction((id) => App.state.due.some((x) => x.rule_id === id && x.status === 'ok'), d.rule_id, { timeout: 15000 });
      const cls = await page.$eval(`.op-maint .op-due[data-rule="${d.rule_id}"]`, (e) => e.className).catch(() => 'прихований');
      assert.doesNotMatch(cls, /\bs-due\b/);
      const works = (await H.sheet(srv, 'Журнал робіт')).rows.filter((r) => r['ID регламенту'] === d.rule_id && r['Виконавець'] === 'Сергій Ткаченко');
      assert.equal(works.length, 1);
      assert.equal(works[0]['Що зроблено'], d.title);
      // сервер теж вважає роботу виконаною
      const b = await (await fetch(srv.endpoint, { method: 'POST', body: JSON.stringify({ action: 'bootstrap', token: srv.token }) })).json();
      assert.equal(b.due.find((x) => x.rule_id === d.rule_id).status, 'ok');
    }));

    test('керівник анулює подію в журналі → рядок перекреслено, у таблиці «Анульовано»', T, () => run({
      seed: true, config: (srv) => H.remoteConfig(srv.endpoint, srv.token, { device: 'Кабінет керівника' })
    }, async ({ page, srv }) => {
      await page.goto(srv.url + '#/m/journal');
      await H.enterPin(page, PIN);
      await page.waitForSelector('.m-jtbl tr[data-open]', { timeout: 20000 });
      const idx = await page.$$eval('.m-jtbl tr[data-open]', (rows) => {
        const r = rows.find((x) => x.querySelector('.m-kind.k-events') && !x.classList.contains('is-void'));
        return r ? r.getAttribute('data-open') : null;
      });
      assert.ok(idx !== null, 'у журналі є події');
      await page.click(`.m-jtbl tr[data-open="${idx}"]`);
      await page.waitForSelector('.modal .m-danger-t');
      const id = (await page.textContent('.modal .kv .mono')).trim();
      await page.click('.modal .m-danger-t');
      await page.waitForSelector('textarea[name=void_note]');
      await page.fill('textarea[name=void_note]', 'Помилковий запис (e2e)');
      await page.click('.modal-overlay:last-child .modal-foot .btn.danger');
      await page.waitForSelector('.modal', { state: 'detached', timeout: 15000 });
      await page.waitForSelector('.m-jtbl tr.is-void', { timeout: 15000 });
      const deco = await page.$eval('.m-jtbl tr.is-void td', (td) => getComputedStyle(td).textDecorationLine);
      assert.match(deco, /line-through/);
      const ev = byId((await H.sheet(srv, 'Журнал стану')).rows, id);
      assert.equal(ev.length, 1, 'подія ' + id);
      assert.equal(ev[0]['Анульовано'], true);
      assert.equal(ev[0]['Причина анулювання'], 'Помилковий запис (e2e)');
    }));
  });
}
