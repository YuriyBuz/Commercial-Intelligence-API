#!/usr/bin/env node
/* =====================================================================
   FOODLINE · Лінії — локальний емулятор (tools/dev-server.mjs), без залежностей.
   • роздає папку lines/ як статичний сайт (правильні MIME-типи, без кешування, / → index.html);
   • /exec — сумісна з Apps Script точка API: виконує СПРАВЖНІ core.js (Core.gs) і Server.gs
     через gas-mock (loadGasProject) над таблицею в памʼяті: POST text/plain JSON → doPost,
     GET (зокрема JSONP з callback=) → doGet;
   • службові адреси для тестів: POST /__control, GET /__sheets, /__mails, /__requests —
     лише з цього компʼютера (loopback) і лише з тієї ж адреси (без CORS; чужі Origin /
     Sec-Fetch-Site: cross-site і чужий Host (DNS rebinding) → 403). Команди — лише POST із
     Content-Type: application/json (з чужої сторінки такий запит без preflight не надіслати).

   ЗАПУСК
     npm run dev                                   # = node tools/dev-server.mjs --seed
     node tools/dev-server.mjs [--port 8787] [--host 127.0.0.1] [--seed] [--token dev-token]
                               [--admin-pin 1234] [--latency 0] [--persist data.json] [--verbose]
                               [--expose-control]
     На планшеті / в браузері: майстер → «Google-таблиця підприємства» → адреса http://…/exec і токен.
     --host 0.0.0.0 — щоб відкрити з планшета в тій самій мережі (сервіс-воркер працює лише
     на https або localhost — офлайн-кеш оболонки в такому разі недоступний). Службові адреси /__*
     і тоді відповідають лише цьому компʼютеру; --expose-control — дозволити їх з мережі (обережно:
     /__sheets віддає всю таблицю, зокрема PIN персоналу). Файл --persist статично не роздається.

   У КОДІ (тести)
     import { startDevServer } from '../tools/dev-server.mjs';
     const srv = await startDevServer({ port: 0, seed: true, token: 't', adminPin: '4321', latencyMs: 0,
                                        persistFile: null, quiet: true });
     srv.url, srv.endpoint, srv.token, srv.adminPin, srv.port
     srv.setDown(true|false), srv.setOffline(true|false), srv.blockPost(true|false), srv.loseResponses(n), srv.setLatency(ms),
     srv.reset({seed}), srv.sheets(name?), srv.mails(), srv.requests(), srv.stats(),
     srv.run('hourlyJob'), srv.project → {ctx, inspect}, await srv.close()

   СЛУЖБОВІ АДРЕСИ (працюють і під час «аварії»; POST — з Content-Type: application/json)
     POST /__control  {"down":true|false}   — «аварія»: зʼєднання з /exec обривається (статика працює)
                      {"offline":true|false} — мережі немає зовсім: обриваються й /exec, і статичні файли
                                              (зокрема запити сервіс-воркера — оболонка лише з кешу)
                      {"blockPost":true}    — обривати лише POST (мережа, що блокує POST: клієнт
                                              переходить на резервний канал JSONP GET)
                      {"latency":мс}        — затримка відповіді /exec
                      {"loseResponses":N}   — наступні N записів виконати, але обірвати зʼєднання
                                              замість відповіді (перевірка ідемпотентності повторів)
                      {"reset":true[,"seed":bool]} — нова порожня таблиця (+ setup, + демо-дані)
                      {"run":"hourlyJob"}   — виконати серверну функцію (hourlyJob, dailyJob, refreshPlan,
                                              recomputeAll, checkDueNow, sendDigestNow, seedDemoData, setup)
                      {} або GET /__control — стан (без токена й PIN); GET із параметрами → 405
                      стан: down, offline, block_post, latency, lose_responses, requests,
                            static_served, dropped_static, dropped_exec (лічильники з запуску / reset)
     GET  /__sheets[?name=Журнал стану][&values=1] — дані аркушів (дати — ISO-рядки)
     GET  /__mails     — надіслані листи;  GET /__requests — журнал запитів до /exec (останні 500)
   ===================================================================== */
import http from 'node:http';
import { isIP } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname, sep } from 'node:path';
import { loadGasProject } from './gas-mock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.gs': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml; charset=utf-8'
};
const NO_CACHE = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache', Expires: '0' };
const RUNNABLE = ['hourlyJob', 'dailyJob', 'refreshPlan', 'recomputeAll', 'checkDueNow', 'sendDigestNow', 'seedDemoData', 'setup'];
const J = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));   // обʼєкти з vm → звичайні
const SERVICE = ['/__control', '/__sheets', '/__mails', '/__requests'];
/* клієнт на цьому ж компʼютері (127.0.0.0/8, ::1, IPv4 у IPv6) */
const isLoopback = (a) => /^(::ffff:)?127\./.test(String(a || '')) || a === '::1';
/* імʼя з заголовка Host: [::1]:8787 → ::1, localhost:8787 → localhost */
function hostName(h) {
  h = String(h || '').trim().toLowerCase();
  if (h[0] === '[') return h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined);
  return h.replace(/:\d*$/, '');
}
const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';

/* ------------------------------ проєкт Apps Script у памʼяті ------------------------------ */
function createProject(o, saved) {
  const p = loadGasProject({ echo: !!o.verbose });
  const { ctx, globals, inspect } = p;
  if (saved && Array.isArray(saved.sheets)) restore(p, saved);
  const props = globals.PropertiesService.getScriptProperties();
  props.setProperty('API_TOKEN', o.token);
  props.setProperty('ADMIN_PIN', o.adminPin);
  const setup = J(ctx.setup());
  if (!setup || !setup.ok) throw new Error('dev-server: setup() не вдалося: ' + JSON.stringify(setup));
  let seed = null;
  if (o.seed) seed = J(ctx.seedDemoData());
  return { ctx, globals, inspect, setup, seed };
}
/* таблиця з файлу: значення клітинок (дати — {"$d": мс}) і властивості скрипту */
function restore(p, saved) {
  const ss = p.globals.SpreadsheetApp.getActiveSpreadsheet();
  const FakeDate = p.globals.Date;
  for (const s of saved.sheets) {
    if (!s || !s.name) continue;
    if (!ss.getSheetByName(s.name)) ss.insertSheet(s.name);
    const I = p.inspect.sheet(s.name);
    (s.values || []).forEach((row, r) => (row || []).forEach((v, c) => {
      if (v === '' || v === null || v === undefined) return;
      I.raw(r + 1, c + 1, v && typeof v === 'object' && '$d' in v ? new FakeDate(v.$d) : v);
    }));
  }
  if (saved.properties) p.globals.PropertiesService.getScriptProperties().setProperties(saved.properties);
}
function snapshot(p) {
  return {
    format: 'foodline-lines-dev/1', saved_at: new Date().toISOString(),
    properties: p.inspect.properties(),
    sheets: p.inspect.sheetNames().map((name) => ({
      name, values: p.inspect.sheet(name).values().map((row) => row.map((v) => (isDate(v) ? { $d: v.getTime() } : v)))
    }))
  };
}
function cellOut(v) { return isDate(v) ? (isNaN(v.getTime()) ? null : v.toISOString()) : v; }
function sheetDump(p, name, withValues) {
  const I = p.inspect.sheet(name);
  if (!I) return null;
  const header = I.header().map(cellOut);
  const out = { name, header, rows: I.records().map((r) => { const o = {}; for (const k of Object.keys(r)) o[k] = cellOut(r[k]); return o; }) };
  if (withValues) out.values = I.values().map((row) => row.map(cellOut));
  return out;
}

/* ------------------------------ сервер ------------------------------ */
export async function startDevServer(options = {}) {
  const o = {
    port: 8787, host: '127.0.0.1', seed: false, token: 'dev-token', adminPin: '1234', latencyMs: 0,
    persistFile: null, verbose: false, quiet: false, root: ROOT, exposeControl: false, ...options
  };
  o.root = resolve(String(o.root));
  o.token = String(o.token);
  o.adminPin = String(o.adminPin);
  const persist = o.persistFile ? resolve(String(o.persistFile)) : null;
  let saved = null;
  if (persist && existsSync(persist)) {
    try { saved = JSON.parse(readFileSync(persist, 'utf8')); } catch (e) { throw new Error('dev-server: не вдалося прочитати ' + persist + ': ' + e.message); }
  }
  let project = createProject(o, saved);
  const st = { down: false, offline: false, latencyMs: Math.max(0, Number(o.latencyMs) || 0), lose: 0, blockPost: false, reqs: [], seq: 0,
    staticServed: 0, droppedStatic: 0, droppedExec: 0 };
  const log = (...a) => { if (!o.quiet) console.log(...a); };

  /* збереження таблиці у файл (із затримкою, атомарно) */
  let saveTimer = null;
  function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!persist) return;
    const tmp = persist + '.tmp';
    writeFileSync(tmp, JSON.stringify(snapshot(project)));
    renameSync(tmp, persist);
  }
  function saveSoon() {
    if (!persist || saveTimer) return;
    saveTimer = setTimeout(() => { try { saveNow(); } catch (e) { console.error('dev-server: не збережено', e.message); } }, 300);
  }
  if (persist) saveNow();

  function reset(seed) {
    project = createProject({ ...o, seed: seed === undefined ? o.seed : !!seed }, null);
    Object.assign(st, { reqs: [], down: false, offline: false, lose: 0, blockPost: false, staticServed: 0, droppedStatic: 0, droppedExec: 0 });
    saveSoon();
    return project;
  }
  const stats = () => ({ down: st.down, offline: st.offline, block_post: st.blockPost, latency: st.latencyMs, lose_responses: st.lose,
    requests: st.reqs.length, static_served: st.staticServed, dropped_static: st.droppedStatic, dropped_exec: st.droppedExec });
  function run(name) {
    if (RUNNABLE.indexOf(name) < 0) throw new Error('Невідома функція: ' + name);
    const r = J(project.ctx[name]());
    saveSoon();
    return r;
  }
  const sheets = (name, withValues) => (name ? sheetDump(project, name, withValues)
    : Object.fromEntries(project.inspect.sheetNames().map((n) => [n, sheetDump(project, n, withValues)])));
  const mails = () => J(project.inspect.mails);

  /* ---------- /exec ---------- */
  function paramsOf(url) {
    const parameter = {}, parameters = {};
    for (const [k, v] of url.searchParams) {
      if (!Object.prototype.hasOwnProperty.call(parameter, k)) parameter[k] = v;   // як у GAS: перше значення
      (parameters[k] || (parameters[k] = [])).push(v);
    }
    return { parameter, parameters, queryString: url.search.replace(/^\?/, '') };
  }
  function noteRequest(method, req, text) {
    let res = null;
    try { res = JSON.parse(text.replace(/^\/\*\*\/[\w$]+\(([\s\S]*)\);$/, '$1')); } catch (e) { res = null; }
    const rec = { n: ++st.seq, at: new Date().toISOString(), method, action: req && req.action ? String(req.action) : '',
      device: req && req.device ? String(req.device) : '', ok: !!(res && res.ok), error: res && res.error ? res.error : '' };
    if (req && Array.isArray(req.ops)) {
      rec.ops = req.ops.map((x) => ({ op_id: x && x.op_id, action: x && x.action, id: x && x.id }));
      if (res && Array.isArray(res.results)) rec.results = res.results.map((x) => (x.ok ? (x.duplicate || (x.data && x.data.duplicate) ? 'duplicate' : 'ok') : x.error));
    }
    st.reqs.push(rec);
    if (st.reqs.length > 500) st.reqs.splice(0, st.reqs.length - 500);
    return rec;
  }
  function execute(method, url, body) {
    const ctx = project.ctx, info = paramsOf(url);
    let out, req = null;
    if (method === 'POST') {
      try { req = JSON.parse(body || '{}'); } catch (e) { req = null; }
      out = ctx.doPost({ ...info, postData: { contents: body, type: 'text/plain', length: Buffer.byteLength(body), name: 'postData' },
        contentLength: Buffer.byteLength(body), contextPath: '' });
    } else {
      try { req = { ...info.parameter, ...JSON.parse(info.parameter.payload || '{}') }; } catch (e) { req = { ...info.parameter }; }
      out = ctx.doGet({ ...info, contentLength: -1, contextPath: '' });
    }
    const text = String(out.getContent());
    const mime = String(out.getMimeType() || 'text/plain');
    const rec = noteRequest(method, req, text);
    const a = project.ctx.LinesCore && project.ctx.LinesCore.ACTIONS;
    const write = !!(a && req && req.action && a[req.action] && a[req.action].write);
    if (write) saveSoon();
    if (o.verbose) log('  /exec', method, rec.action, rec.ok ? 'ok' : rec.error, rec.results ? JSON.stringify(rec.results) : '');
    return { text, mime, write, rec };
  }

  function send(res, status, headers, body) {
    res.writeHead(status, { ...NO_CACHE, ...headers });
    res.end(body);
  }
  /* службові відповіді — без CORS: читати їх може лише та сама адреса (не чужа сторінка в браузері) */
  const sendJson = (res, status, obj, headers) => send(res, status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers }, JSON.stringify(obj, null, 1));
  function readBody(req) {
    return new Promise((ok, fail) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
      req.on('error', fail);
    });
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function handleExec(req, res, url) {
    if (req.method === 'OPTIONS') { send(res, 405, { 'Content-Type': 'text/html; charset=utf-8' }, '<html><body>Method Not Allowed</body></html>'); return; }
    if (req.method !== 'GET' && req.method !== 'POST') { send(res, 405, { 'Content-Type': 'text/plain', Allow: 'GET, POST' }, 'Method Not Allowed'); return; }
    const body = req.method === 'POST' ? await readBody(req) : '';
    if (st.down || st.offline || (st.blockPost && req.method === 'POST')) { st.droppedExec++; req.socket.destroy(); return; }
    if (st.latencyMs) {
      await wait(st.latencyMs);
      if (st.down || st.offline) { st.droppedExec++; req.socket.destroy(); return; }
    }
    let r;
    try { r = execute(req.method, url, body); } catch (e) {
      // як у Google: помилка скрипту — HTML-сторінка
      console.error('dev-server: помилка виконання', e);
      send(res, 500, { 'Content-Type': 'text/html; charset=utf-8' }, '<!DOCTYPE html><html><body><p>Script error: ' +
        String(e && e.message || e).replace(/[<>&]/g, '') + '</p></body></html>');
      return;
    }
    // «втрачена відповідь»: запис виконано, але клієнт відповіді не отримає (перевірка ідемпотентності)
    if (r.write && st.lose > 0) { st.lose--; r.rec.lost = true; req.socket.destroy(); return; }
    send(res, 200, { 'Content-Type': r.mime + '; charset=utf-8', 'Access-Control-Allow-Origin': '*' }, r.text);
  }

  /* службові адреси: лише цей компʼютер (або --expose-control), лише своя адреса (Host), без чужих сторінок
     (Origin / Sec-Fetch-Site) → null або {status, error, message} */
  function serviceDenied(req) {
    const deny = (message) => ({ status: 403, error: 'FORBIDDEN', message });
    if (!o.exposeControl && !isLoopback(req.socket.remoteAddress)) {
      return deny('Службові адреси доступні лише з цього компʼютера (дозволити з мережі: --expose-control)');
    }
    const host = req.headers.host;
    if (host !== undefined) {
      const h = hostName(host);
      // імʼя, що не є IP і не localhost, — ознака DNS rebinding (чужий домен, що вказує на цей компʼютер)
      if (!(h === 'localhost' || /\.localhost$/.test(h) || isIP(h) || h === String(o.host).toLowerCase())) return deny('Невідома адреса сервера (Host)');
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== 'http://' + host) return deny('Запит з іншої сторінки (Origin) відхилено');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return deny('Запит з іншого сайту відхилено');
    return null;
  }

  async function handleControl(req, res, url) {
    let cmd = {};
    if (req.method === 'POST') {
      // лише JSON: з чужої сторінки браузер не надішле application/json без preflight (а preflight тут не підтримано)
      if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) {
        sendJson(res, 415, { ok: false, error: 'UNSUPPORTED_MEDIA_TYPE', message: 'Команди — лише POST з Content-Type: application/json' });
        return;
      }
      const b = await readBody(req);
      try { cmd = b ? JSON.parse(b) : {}; } catch (e) { sendJson(res, 400, { ok: false, error: 'BAD_REQUEST', message: 'Тіло має бути JSON' }); return; }
      if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) { sendJson(res, 400, { ok: false, error: 'BAD_REQUEST', message: 'Тіло має бути JSON-обʼєктом' }); return; }
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      // GET — лише стан: команди з адресного рядка (чи <img src>) не виконуються
      if ([...url.searchParams.keys()].length) {
        sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: 'Команди — лише POST з Content-Type: application/json' }, { Allow: 'POST' });
        return;
      }
    } else {
      sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: 'Лише GET (стан) або POST (команди)' }, { Allow: 'GET, POST' });
      return;
    }
    const out = { ok: true };
    try {
      if (cmd.reset) { reset(cmd.seed); out.reset = true; }
      if (cmd.down !== undefined) st.down = !!cmd.down;
      if (cmd.offline !== undefined) st.offline = !!cmd.offline;
      if (cmd.latency !== undefined) st.latencyMs = Math.max(0, Number(cmd.latency) || 0);
      if (cmd.blockPost !== undefined) st.blockPost = !!cmd.blockPost;
      if (cmd.loseResponses !== undefined) st.lose = Math.max(0, Math.floor(Number(cmd.loseResponses) || 0));
      if (cmd.run) out.result = run(String(cmd.run));
    } catch (e) { sendJson(res, 400, { ok: false, error: 'BAD_REQUEST', message: String(e && e.message || e) }); return; }
    // токен і PIN сюди не потрапляють: вони друкуються при старті й повертаються startDevServer()
    Object.assign(out, stats());
    sendJson(res, 200, out);
  }

  async function handleStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' }, 'Method Not Allowed'); return; }
    let path;
    try { path = decodeURIComponent(url.pathname); } catch (e) { send(res, 400, { 'Content-Type': 'text/plain' }, 'Bad Request'); return; }
    if (path.indexOf('\0') >= 0) { send(res, 400, { 'Content-Type': 'text/plain' }, 'Bad Request'); return; }
    let file = resolve(o.root, '.' + path);
    if (file !== o.root && !file.startsWith(o.root + sep)) { send(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden'); return; }
    // файл --persist (токен, PIN, уся таблиця) міг опинитися в корені сайту — не роздаємо
    const secret = (f) => !!persist && (f === persist || f === persist + '.tmp');
    try {
      let s = await stat(file);
      if (s.isDirectory()) { file = join(file, 'index.html'); s = await stat(file); }
      if (secret(file)) throw new Error('persist');
      const buf = await readFile(file);
      const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
      send(res, 200, { 'Content-Type': type, 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff' }, req.method === 'HEAD' ? undefined : buf);
    } catch (e) {
      send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Не знайдено: ' + path);
    }
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { send(res, 400, { 'Content-Type': 'text/plain' }, 'Bad Request'); return; }
    try {
      const p = url.pathname;
      if (SERVICE.includes(p)) {
        const no = serviceDenied(req);
        if (no) { sendJson(res, no.status, { ok: false, error: no.error, message: no.message }); return; }
        if (p !== '/__control' && req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: 'Лише GET' }, { Allow: 'GET' });
          return;
        }
      } else if (st.offline) {
        // «мережі немає»: обриваємо все, крім службових адрес, — і запити сервіс-воркера теж
        if (p === '/exec' || /\/exec\/?$/.test(p)) st.droppedExec++; else st.droppedStatic++;
        req.socket.destroy();
        return;
      }
      if (p === '/exec' || /\/exec\/?$/.test(p)) return await handleExec(req, res, url);
      if (p === '/__control') return await handleControl(req, res, url);
      if (p === '/__sheets') {
        const name = url.searchParams.get('name');
        const d = sheets(name, url.searchParams.has('values'));
        if (name && !d) { sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: 'Немає аркуша «' + name + '»', names: project.inspect.sheetNames() }); return; }
        sendJson(res, 200, name ? { ok: true, sheet: d } : { ok: true, names: project.inspect.sheetNames(), sheets: d });
        return;
      }
      if (p === '/__mails') { sendJson(res, 200, { ok: true, mails: mails() }); return; }
      if (p === '/__requests') { sendJson(res, 200, { ok: true, requests: st.reqs }); return; }
      st.staticServed++;
      return await handleStatic(req, res, url);
    } catch (e) {
      console.error('dev-server:', e);
      if (!res.headersSent) send(res, 500, { 'Content-Type': 'text/plain' }, 'Internal error');
      else res.destroy();
    }
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(o.port, o.host, () => { server.off('error', fail); ok(); });
  });
  const port = server.address().port;
  const shownHost = o.host === '0.0.0.0' || o.host === '::' ? 'localhost' : o.host === '127.0.0.1' ? 'localhost' : o.host;
  const base = 'http://' + (shownHost.indexOf(':') >= 0 ? '[' + shownHost + ']' : shownHost) + ':' + port + '/';

  let closed = false;
  const api = {
    port, url: base, endpoint: base + 'exec', token: o.token, adminPin: o.adminPin,
    get project() { return project; },
    setup: project.setup, seed: project.seed,
    setDown(v) { st.down = !!v; },
    setOffline(v) { st.offline = !!v; },
    stats,
    loseResponses(n) { st.lose = Math.max(0, Math.floor(Number(n) || 0)); },
    blockPost(v) { st.blockPost = !!v; },
    setLatency(ms) { st.latencyMs = Math.max(0, Number(ms) || 0); },
    reset(opts = {}) { reset(opts.seed); },
    run, sheets: (name, withValues) => J(sheets(name, withValues)), mails, requests: () => J(st.reqs), save: saveNow,
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      try { saveNow(); } catch (e) { console.error('dev-server: не збережено', e.message); }
      return new Promise((ok) => { server.close(() => ok()); for (const s of sockets) s.destroy(); });
    }
  };

  log('FOODLINE · Лінії — локальний емулятор Apps Script');
  log('  Застосунок:     ' + base);
  log('  API (/exec):    ' + api.endpoint);
  log('  Токен доступу:  ' + o.token);
  log('  PIN керівника:  ' + o.adminPin);
  if (project.seed) log('  Демо-дані:      ' + (project.seed.ok ? '' : 'не додано — ') + (project.seed.message || JSON.stringify(project.seed)));
  if (persist) log('  Таблиця у файлі: ' + persist + (saved ? ' (завантажено)' : ' (нова)'));
  if (o.host === '0.0.0.0' || o.host === '::') log('  Слухає всі мережеві інтерфейси (порт ' + port + ')');
  log('  Службові адреси' + (o.exposeControl ? ' (УВАГА: доступні з мережі — --expose-control)' : ' (лише з цього компʼютера)') +
    ': POST /__control {down|offline|blockPost|latency|loseResponses|reset|run} · GET /__sheets · /__mails · /__requests');
  return api;
}

/* ------------------------------ командний рядок ------------------------------ */
function parseArgs(argv) {
  const o = {};
  const val = (i, name) => { if (i >= argv.length || /^--/.test(argv[i])) throw new Error('Для ' + name + ' потрібне значення'); return argv[i]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const k = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const next = () => (inline !== undefined ? inline : val(++i, k));
    switch (k) {
      case '--port': case '-p': o.port = Number(next()); break;
      case '--host': o.host = next(); break;
      case '--seed': o.seed = true; break;
      case '--token': o.token = next(); break;
      case '--admin-pin': case '--pin': o.adminPin = next(); break;
      case '--latency': o.latencyMs = Number(next()); break;
      case '--persist': o.persistFile = next(); break;
      case '--verbose': case '-v': o.verbose = true; break;
      case '--expose-control': o.exposeControl = true; break;
      case '--quiet': case '-q': o.quiet = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error('Невідомий параметр: ' + a);
    }
  }
  if (o.port !== undefined && !(o.port >= 0 && o.port < 65536)) throw new Error('Невірний порт');
  return o;
}
const HELP = `Локальний емулятор FOODLINE · Лінії (статичні файли + Apps Script /exec над таблицею в памʼяті)

  node tools/dev-server.mjs [параметри]
    --port N          порт (типово 8787; 0 — будь-який вільний)
    --host H          адреса (типово 127.0.0.1; 0.0.0.0 — доступ з мережі)
    --seed            заповнити демо-даними (seedDemoData)
    --token T         токен доступу (типово dev-token)
    --admin-pin P     PIN керівника (типово 1234)
    --latency MS      затримка відповіді /exec, мс
    --persist FILE    зберігати таблицю у JSON-файлі між запусками
    --verbose         друкувати запити й журнал сервера
    --expose-control  службові адреси /__* доступні з мережі (типово — лише з цього компʼютера)
    --quiet           без повідомлень`;

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message + '\n\n' + HELP); process.exit(2); }
  if (args.help) { console.log(HELP); process.exit(0); }
  startDevServer(args).then((srv) => {
    const stop = () => { srv.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }, (e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}
