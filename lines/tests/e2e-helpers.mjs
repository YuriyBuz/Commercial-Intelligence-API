/* Помічники наскрізних тестів (tests/e2e.test.mjs): Playwright із глобального встановлення,
 * контекст браузера без мережевих шрифтів, майстер налаштування, PIN керівника, чек-лист,
 * очікування стану лінії, перевірки консолі й горизонтальної прокрутки. */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

/* Playwright: спершу локальний пакет, потім глобальний (npm root -g) → {chromium} | {error} */
export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const tried = [];
  for (const id of ['playwright', 'playwright-core']) {
    try { return require(id); } catch (e) { tried.push(id + ': ' + e.message.split('\n')[0]); }
  }
  try {
    const root = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).toString().trim();
    for (const id of ['playwright', 'playwright-core']) {
      try { return require(join(root, id)); } catch (e) { tried.push(join(root, id) + ': ' + e.message.split('\n')[0]); }
    }
  } catch (e) { tried.push('npm root -g: ' + e.message.split('\n')[0]); }
  return { error: tried.join('; ') };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* новий контекст: без сервіс-воркера (o.serviceWorkers:'allow' — з ним), пояс Києва,
   шрифти Google — порожня відповідь (офлайн-середовище); o.config — налаштування пристрою до завантаження;
   o.hasTouch — сенсорний екран (page.touchscreen.tap) */
export async function newContext(browser, o = {}) {
  const ctx = await browser.newContext({
    viewport: o.viewport || { width: 1280, height: 800 }, serviceWorkers: o.serviceWorkers || 'block', locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv', deviceScaleFactor: 1, reducedMotion: 'reduce', hasTouch: !!o.hasTouch
  });
  await ctx.route(/^https:\/\/fonts\.googleapis\.com\//, (r) => r.fulfill({ status: 200, contentType: 'text/css', headers: { 'Access-Control-Allow-Origin': '*' }, body: '' }));
  await ctx.route(/^https:\/\/fonts\.gstatic\.com\//, (r) => r.fulfill({ status: 200, contentType: 'font/woff2', headers: { 'Access-Control-Allow-Origin': '*' }, body: '' }));
  if (o.config) {
    /* try: скрипт виконується й у кадрах sandbox="" (перегляд листа в налаштуваннях) — там localStorage недоступний */
    await ctx.addInitScript((c) => { try { if (!localStorage.getItem('fl_lines_v1')) localStorage.setItem('fl_lines_v1', JSON.stringify(c)); } catch (e) { /* кадр без сховища */ } }, o.config);
  }
  return ctx;
}

/* збирає помилки сторінки: console.error / warning, неперехоплені винятки, діалоги браузера.
 * allow — регулярні вирази очікуваних повідомлень (напр., обрив зʼєднання під час «аварії»). */
export function watch(page, o = {}) {
  const errs = [];
  const allow = PW_NOISE.concat(o.allow || []);
  const ok = (t) => allow.some((re) => re.test(t));
  page.on('console', (m) => {
    const t = m.type();
    if (t !== 'error' && t !== 'warning') return;
    const text = t + ': ' + m.text();
    if (!ok(text)) errs.push(text);
  });
  page.on('pageerror', (e) => { if (!PW_FRAME_NOISE.some((re) => re.test(e.message))) errs.push('pageerror: ' + e.message + '\n' + (e.stack || '')); });
  page.on('dialog', (d) => { errs.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
  return errs;
}
/* наслідок serviceWorkers:'block' у Playwright: register() повертає undefined і пише попередження */
const PW_NOISE = [/Service Worker registration blocked by Playwright/, /Service worker: Cannot read properties of undefined \(reading 'waiting'\)/];
/* serviceWorkers:'block' підміняє navigator.serviceWorker у КОЖНОМУ кадрі, зокрема в sandbox="" (перегляд листа) — там читати його заборонено */
const PW_FRAME_NOISE = [/Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed/];
/* повідомлення браузера про обірване зʼєднання (не помилки застосунку) */
export const NET_NOISE = [/Failed to load resource: net::ERR_/, /net::ERR_EMPTY_RESPONSE/, /net::ERR_CONNECTION/];

/* майстер: демо-режим */
export async function setupDemo(page, base, device = 'Планшет тест') {
  await page.goto(base);
  await page.waitForSelector('.wiz');
  await page.click('[data-mode=local]');
  await page.click('[data-w=next]');
  await page.waitForSelector('.wiz .box.ok', { timeout: 30000 });
  await page.click('[data-w=next]');
  await page.fill('input[name=device]', device);
  await page.click('[data-w=next]');
  await page.waitForSelector('.ltile', { timeout: 30000 });
}
/* майстер: Google-таблиця (адреса /exec + токен + «Перевірити зв’язок») */
export async function setupRemote(page, base, endpoint, token, device = 'Планшет лінії 2') {
  await page.goto(base);
  await page.waitForSelector('.wiz');
  await page.click('[data-mode=remote]');
  await page.click('[data-w=next]');
  await page.fill('input[name=endpoint]', endpoint);
  await page.fill('input[name=token]', token);
  await page.click('[data-w=test]');
  await page.waitForSelector('.conn-result .box.ok', { timeout: 20000 });
  await page.click('[data-w=next]');
  await page.fill('input[name=device]', device);
  await page.click('[data-w=next]');
  await page.waitForSelector('.ltile', { timeout: 30000 });
}
/* налаштований планшет без майстра (конфігурація в localStorage до завантаження) */
export function remoteConfig(endpoint, token, extra = {}) {
  return { mode: 'remote', endpoint, token, device: 'Планшет тест', theme: 'dark', pinned_line: '', ...extra };
}
/* демо-режим без майстра (дані засіваються в браузері під час першого запуску) */
export function localConfig(extra = {}) {
  return { mode: 'local', device: 'Планшет тест', theme: 'dark', pinned_line: '', ...extra };
}
export function operatorFor(staffId, name) {
  return { staff_id: staffId, name, role: 'operator', since: new Date().toISOString() };
}

/* PIN керівника на екранній клавіатурі */
export async function enterPin(page, pin) {
  await page.waitForSelector('.modal-keypad');
  for (const k of String(pin)) await page.click(`.modal-keypad .kp-key[data-k="${k}"]`);
  await page.click('.modal-keypad .modal-foot .btn.primary');
  await page.waitForSelector('.modal-keypad', { state: 'detached', timeout: 15000 });
}

/* заповнити чек-лист: усе в нормі; bad = {частина тексту пункту: значення} — число поза нормою з приміткою */
export async function fillChecklist(page, o = {}) {
  const items = await page.$$eval('.op-ck .op-item[data-item]', (els) => els.map((e) => ({
    id: e.getAttribute('data-item'), cls: e.className, text: (e.querySelector('.op-item-t') || e).textContent
  })));
  for (const it of items) {
    const sel = `.op-ck .op-item[data-item="${it.id}"]`;
    const bad = o.bad && Object.keys(o.bad).find((k) => it.text.includes(k));
    if (/\bt-check\b/.test(it.cls)) {
      await page.click(sel + ' .op-tri-b[data-v=ok]');
    } else if (/\bt-number\b/.test(it.cls)) {
      const v = bad ? o.bad[bad] : await page.$eval(sel + ' input', (i) => (i.dataset.target ? String(i.dataset.target).replace('.', ',') : '100'));
      await page.fill(sel + ' input', String(v));
      if (bad) {
        if (await page.$(sel + ' .op-item-note[hidden]')) await page.click(sel + ' [data-note-add]');
        await page.fill(sel + ' textarea[name^="n_"]', o.note || 'Підрегулювали, повторний замір');
      }
    } else if (/\bt-select\b/.test(it.cls)) {
      await page.click(sel + ' .chip:not(.tone-danger)');
    } else if (/\bt-text\b/.test(it.cls)) {
      await page.fill(sel + ' textarea[name^="v_"]', 'Усе гаразд');
    }
  }
  return items.length;
}

export const lineStatus = (page, id) => page.evaluate((id) => {
  const s = App.lineStatus(id);
  return { state: s.state, pending: s.pending, product: s.product, flag: s.flag, reason: s.reason, operator: s.operator, event_id: s.event_id,
    last_check: s.last_check ? { id: s.last_check.id, occasion: s.last_check.occasion, result: s.last_check.result } : null };
}, id);
/* дочекатися стану лінії (з оптимістичним накладанням черги) */
export async function waitState(page, id, state, o = {}) {
  await page.waitForFunction(([id, st, settled]) => {
    const s = App.lineStatus(id);
    return s.state === st && (!settled || !s.pending);
  }, [id, state, !!o.settled], { timeout: o.timeout || 15000 });
  return lineStatus(page, id);
}
/* дочекатися, поки черга записів спорожніє (записи підтверджено сервером) */
export async function waitQueueEmpty(page, timeout = 15000) {
  await page.waitForFunction(() => Api.net().pending === 0 && !Api.net().flushing, null, { timeout });
}

/* немає горизонтальної прокрутки сторінки */
export async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const d = document.documentElement, w = d.clientWidth;
    const over = d.scrollWidth - w;
    const wide = over > 1 ? [...document.querySelectorAll('body *')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.right > w + 1 && getComputedStyle(e).position !== 'fixed';
    }).slice(0, 5).map((e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : '') + ' → ' + Math.round(e.getBoundingClientRect().right)) : [];
    return { over, wide };
  });
}

/* службові адреси dev-server (команди — лише POST з Content-Type: application/json); {} — стан */
export async function control(srv, cmd = {}) {
  const r = await fetch(srv.url + '__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (!j.ok) throw new Error('__control ' + JSON.stringify(cmd) + ': ' + JSON.stringify(j));
  return j;
}
export async function sheet(srv, name) {
  const r = await fetch(srv.url + '__sheets?name=' + encodeURIComponent(name));
  const j = await r.json();
  if (!j.ok) throw new Error('Немає аркуша ' + name + ': ' + JSON.stringify(j));
  return j.sheet;
}
