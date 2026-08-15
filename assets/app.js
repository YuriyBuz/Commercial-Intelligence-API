/* =====================================================================
   FOODLINE · Комерційний пульт
   Аналітика продажів, економіки, промо-плану та результатів промо.
   ===================================================================== */

/* ------------------------------ СТАН ------------------------------ */

const APP = {
  cfg: {
    endpoint: '',
    token: '',
    vatIncluded: false,      // виручка у джерелі містить ПДВ
    vatRate: 20,
    moneyRate: 25,           // річна вартість грошей, % — для оцінки відтермінування
    promoShare: 100,         // яку частку глибини знижки фінансує виробник, %
    logistics: 0             // додаткові логістичні витрати, % від виручки
  },
  raw: { sales: null, cost: null, terms: null, promo: null, promoDiag: null, profit: null, profitDiag: null, generated: '' },
  d: {
    sales: [], cost: {}, terms: [], termsMap: {}, promo: [], profit: [],
    skuList: [], chains: [], brands: [], years: [], partners: [],
    promoMonth: {},          // chainKey|sku|ym -> {weeks, depthAvg, depthMax, plan}
    promoWeeks: [],          // відсортований список ISO-тижнів
    matchLog: [], anomalies: []
  },
  f: { years: [], months: [], chains: [], brands: [], skus: [], search: '', chan: 'all' },
  trend: 'linear',
  view: 'overview',
  charts: {}
};

const LS = 'foodline_dash_v1';

/* ------------------------------ УТИЛІТИ ------------------------------ */

const nf0 = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function n0(v) { return isFinite(v) ? nf0.format(Math.round(v)) : '—'; }
function n1(v) { return isFinite(v) ? nf1.format(v) : '—'; }
function n2(v) { return isFinite(v) ? nf2.format(v) : '—'; }
function pct(v, d) { return isFinite(v) ? (d === 1 ? nf1.format(v) : nf0.format(v)) + '%' : '—'; }

/** Компактні гроші для KPI */
function money(v) {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return nf2.format(v / 1e9) + ' млрд';
  if (a >= 1e6) return nf2.format(v / 1e6) + ' млн';
  if (a >= 1e4) return nf0.format(v / 1e3) + ' тис';
  return nf0.format(v);
}
function delta(cur, prev) {
  if (!prev) return null;
  return (cur / prev - 1) * 100;
}
function dEl(v, invert) {
  if (v === null || !isFinite(v)) return '<span class="d">—</span>';
  const good = invert ? v < 0 : v > 0;
  const cls = Math.abs(v) < 0.05 ? '' : (good ? 'up' : 'down');
  const sign = v > 0 ? '+' : '';
  return `<span class="d ${cls}">${sign}${n1(v)}% р/р</span>`;
}
function ppEl(v) {
  if (v === null || !isFinite(v)) return '<span class="d">—</span>';
  const cls = Math.abs(v) < 0.05 ? '' : (v > 0 ? 'up' : 'down');
  return `<span class="d ${cls}">${v > 0 ? '+' : ''}${n1(v)} п.п. р/р</span>`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function el(id) { return document.getElementById(id); }
function sum(arr, f) { let s = 0; for (const x of arr) s += f(x) || 0; return s; }
function uniq(arr) { return Array.from(new Set(arr)); }
function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
const MONTH_UA = ['', 'січень', 'лютий', 'березень', 'квітень', 'травень', 'червень',
  'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
const MONTH_SH = ['', 'січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];

const MONTH_LOOKUP = (() => {
  const m = {};
  const ru = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
  ru.forEach((x, i) => m[x] = i + 1);
  MONTH_UA.forEach((x, i) => { if (x) m[x] = i; });
  MONTH_SH.forEach((x, i) => { if (x) m[x] = i; });
  ['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек']
    .forEach((x, i) => m[x] = i + 1);
  return m;
})();

/** Приймає і число, і назву місяця українською чи російською */
function monthNum(v) {
  if (typeof v === 'number' && v >= 1 && v <= 12) return v;
  const n = parseInt(v, 10);
  if (n >= 1 && n <= 12 && String(v).trim() === String(n)) return n;
  const s = String(v || '').toLowerCase().replace(/[.\s]/g, '');
  if (MONTH_LOOKUP[s]) return MONTH_LOOKUP[s];
  for (const k in MONTH_LOOKUP) if (s.startsWith(k)) return MONTH_LOOKUP[k];
  return 0;
}

function ymOf(y, m) { return y + '-' + String(m).padStart(2, '0'); }
function ymLabel(ym) {
  const [y, m] = ym.split('-');
  return MONTH_SH[+m] + ' ' + y.slice(2);
}

/** Лінійна регресія: повертає значення тренду для кожної точки */
function linreg(ys) {
  const pts = ys.map((y, i) => [i, y]).filter(p => isFinite(p[1]));
  if (pts.length < 3) return ys.map(() => null);
  const mx = mean(pts.map(p => p[0])), my = mean(pts.map(p => p[1]));
  let cov = 0, vx = 0;
  pts.forEach(p => { cov += (p[0] - mx) * (p[1] - my); vx += (p[0] - mx) ** 2; });
  if (!vx) return ys.map(() => null);
  const k = cov / vx;
  return ys.map((_, i) => my + k * (i - mx));
}

/** Нахил тренду за період, у відсотках від першого значення */
function trendSlope(ys) {
  const t = linreg(ys);
  const a = t[0], b = t[t.length - 1];
  if (a === null || !a) return null;
  return (b / a - 1) * 100;
}

/** Ковзне середнє з вікном k */
function sma(ys, k) {
  return ys.map((_, i) => {
    if (i < k - 1) return null;
    const w = ys.slice(i - k + 1, i + 1).filter(v => isFinite(v));
    return w.length ? mean(w) : null;
  });
}

/** Готовий датасет лінії тренду для Chart.js */
function trendDataset(label, ys, color, axis) {
  if (APP.trend === 'off') return null;
  const data = APP.trend === 'sma' ? sma(ys, 3) : linreg(ys);
  if (data.every(v => v === null)) return null;
  return {
    type: 'line', label, data,
    borderColor: color, borderWidth: 1.6, borderDash: APP.trend === 'sma' ? [] : [6, 4],
    pointRadius: 0, tension: APP.trend === 'sma' ? .35 : 0, spanGaps: true,
    fill: false, yAxisID: axis || 'y', order: 0
  };
}

const PALETTE = ['#E8A33D', '#6F8FD0', '#86B860', '#D9563F', '#B07AB4', '#55A99B',
  '#D98BA0', '#C9A227', '#7E93A8', '#A8815C', '#8FB3D9', '#CF8B5B'];
function colorFor(i) { return PALETTE[i % PALETTE.length]; }

/* ------------------------------ МЕРЕЖІ ------------------------------ */

const CHAIN_RULES = [
  { key: 'АТБ', re: /атб/i },
  { key: 'Сільпо (Фоззі-Фуд)', re: /фоззі|фоззи|fozzy|сільпо|сильпо/i },
  { key: 'ФОРА', re: /\bфора\b/i },
  { key: 'Новус', re: /новус|novus/i },
  { key: 'Фудмаркет (Велмарт)', re: /фудмаркет|велмарт|volwest|велмат/i },
  { key: 'МЕТРО', re: /метро|metro/i },
  { key: 'Ашан', re: /ашан|auchan/i },
  { key: 'ЕКО-маркет', re: /еко-?маркет/i },
  { key: 'Варус (Омега ТОВ)', re: /варус|омега/i },
  { key: 'Ей Ті Бі', re: /^atb/i }
];
const CHAIN_OTHER = 'Інші канали';

function chainOf(partner) {
  const over = APP.overrides.chain[partner];
  if (over) return over;
  for (const r of CHAIN_RULES) if (r.re.test(partner)) return r.key;
  return CHAIN_OTHER;
}

/* --------------------- НОРМАЛІЗАЦІЯ НАЗВ SKU --------------------- */

const STOP = new Set(['соус', 'соусы', 'шт', 'х', 'x', 'мл', 'л', 'гр', 'г', 'кг', 'ящ',
  'пет', 'new', 'та', 'з', 'и', 'с', 'для', 'the', 'sauce']);

function skuTokens(s) {
  return String(s || '').toLowerCase()
    .replace(/[«»"'()\[\],.\\/№]/g, ' ')
    .replace(/[-–—]/g, ' ')
    .split(/\s+/)
    .filter(w => w && w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));
}

/** Обсяг у мл (рідина) або г (паста) — для перевірки збігу */
function skuVolume(s) {
  const t = String(s || '').toLowerCase().replace(/\u00A0/g, ' ');
  const m = t.match(/(\d+[.,]?\d*)\s*(мл|л\b|гр|г\b|кг)/);
  if (!m) return null;
  let v = parseFloat(m[1].replace(',', '.'));
  const u = m[2];
  if (u === 'л') v *= 1000;
  if (u === 'кг') v *= 1000;
  return Math.round(v);
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  A.forEach(x => { if (B.has(x)) inter++; });
  const uni = A.size + B.size - inter;
  return uni ? inter / uni : 0;
}

/** Підбирає найближчу назву SKU з продажів до назви з промо-плану */
function matchSku(name, index) {
  const over = APP.overrides.sku[name];
  if (over) return { sku: over, score: 1, manual: true };
  if (index.exact[name]) return { sku: index.exact[name], score: 1 };

  const tk = skuTokens(name), vol = skuVolume(name);
  let best = null, bestRank = 0, bestSim = 0;
  for (const c of index.list) {
    const j = jaccard(tk, c.tk);
    let rank = j;
    if (vol && c.vol) rank += (vol === c.vol ? 0.35 : -0.25);
    else if (vol || c.vol) rank -= 0.05;
    if (rank > bestRank) { bestRank = rank; bestSim = j; best = c.sku; }
  }
  return bestRank >= 0.42
    ? { sku: best, score: bestSim }
    : { sku: null, score: bestSim, near: best };
}

/* ------------------------------ ЗАВАНТАЖЕННЯ ------------------------------ */

function jsonp(url, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const cb = 'flcb_' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    const t = setTimeout(() => { cleanup(); reject(new Error('Таймаут запиту')); }, timeout);
    function cleanup() { clearTimeout(t); delete window[cb]; s.remove(); }
    window[cb] = data => { cleanup(); resolve(data); };
    s.onerror = () => { cleanup(); reject(new Error('Не вдалося звернутися до вебдодатку')); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    document.head.appendChild(s);
  });
}

function setStatus(mode, text) {
  const s = el('status');
  s.className = 'status ' + mode;
  el('statusText').textContent = text;
}

/**
 * Дві хвилі: спершу довідники, промо і рентабельність — панель уже працює,
 * потім важкий масив продажів. Так не треба чекати все одним куском.
 */
async function loadFromEndpoint(fresh, onPartial) {
  const c = APP.cfg;
  if (!c.endpoint) { setStatus('err', 'джерело не задано'); return false; }
  const q = a => c.endpoint + '?action=' + a + '&token=' + encodeURIComponent(c.token) + (fresh ? '&fresh=1' : '');
  const t0 = Date.now();
  try {
    setStatus('load', 'довідники, промо, рентабельність…');
    const light = await jsonp(q('light'), 180000);
    if (!light || light.ok === false) {
      throw new Error(light && light.error === 'BAD_TOKEN' ? 'Невірний токен' : (light && light.error) || 'Порожня відповідь');
    }
    ingestPart(light);
    if (onPartial) onPartial();

    setStatus('load', 'продажі, це найдовше…');
    const sales = await jsonp(q('sales'), 300000);
    if (!sales || sales.ok === false) throw new Error((sales && sales.error) || 'Продажі не прийшли');
    ingestPart(sales);
    persist();
    saveCfg();

    setStatus('ok', `${n0(APP.d.sales.length)} рядків · ${((Date.now() - t0) / 1000).toFixed(0)} с · ${new Date().toLocaleTimeString('uk-UA')}`);
    return true;
  } catch (e) {
    setStatus('err', e.message);
    return APP.d.sales.length > 0;
  }
}

/** Доливає частину відповіді у сховище і перебудовує модель */
function ingestPart(r) {
  ['sales', 'cost', 'terms', 'promo', 'promoDiag', 'profit', 'profitDiag'].forEach(k => {
    if (r[k]) APP.raw[k] = r[k];
  });
  if (r.generated) APP.raw.generated = r.generated;
  build();
}

/** Локальна копія — тільки якщо влазить у сховище браузера */
function persist() {
  try {
    const s = JSON.stringify(APP.raw);
    if (s.length > 4.5e6) { localStorage.removeItem(LS + '_data'); return; }
    localStorage.setItem(LS + '_data', s);
  } catch (e) {
    try { localStorage.removeItem(LS + '_data'); } catch (e2) { }
  }
}

function ingest(r) {
  APP.raw = {
    sales: r.sales || null, cost: r.cost || null, terms: r.terms || null,
    promo: r.promo || null, promoDiag: r.promoDiag || null,
    profit: r.profit || null, profitDiag: r.profitDiag || null,
    generated: r.generated || ''
  };
  persist();
  build();
}

/** Бекенд віддає текстові колонки як індекси у словнику — тут розгортаємо назад */
function tableToObjects(t) {
  if (!t || !t.rows) return [];
  const c = t.cols, enc = t.enc || null;
  const dicts = enc ? c.map(name => enc[name] || null) : null;
  return t.rows.map(row => {
    const o = {};
    for (let i = 0; i < c.length; i++) {
      const d = dicts && dicts[i];
      o[c[i]] = d ? (d[row[i]] !== undefined ? d[row[i]] : '') : row[i];
    }
    return o;
  });
}

/* ------------------------------ ПОБУДОВА МОДЕЛІ ------------------------------ */

function build() {
  const R = APP.raw, D = APP.d;

  /* --- собівартість --- */
  D.cost = {};
  tableToObjects(R.cost).forEach(o => {
    D.cost[o.sku] = {
      unit: +o.unitCost || 0, mat: +o.matPerUnit || 0,
      wage: +o.wagePerUnit || 0, extra: +o.extraPerUnit || 0
    };
  });

  /* --- умови мереж --- */
  D.terms = tableToObjects(R.terms);
  D.termsMap = {};
  D.terms.forEach(t => {
    D.termsMap[t.chain] = t;
    // зіставлення з ключем правил
    for (const r of CHAIN_RULES) if (r.re.test(t.chain)) D.termsMap[r.key] = t;
  });

  /* --- продажі --- */
  const vatDiv = APP.cfg.vatIncluded ? (1 + APP.cfg.vatRate / 100) : 1;
  D.sales = tableToObjects(R.sales).map(o => {
    const mo = monthNum(o.month);
    const rev = (+o.revenue || 0) / vatDiv;
    const qty = +o.qty || 0;
    const cost = D.cost[o.sku];
    const unitCost = cost ? cost.unit : null;
    const cogs = unitCost === null ? null : unitCost * qty;
    const ck = chainOf(o.partner);
    const term = D.termsMap[ck];
    const bonusPct = term ? (+term.totalBonus || 0) : 0;
    const delayDays = term ? (+term.delayDays || 0) : 0;
    const bonus = rev * bonusPct / 100;
    const fin = rev * (delayDays / 365) * (APP.cfg.moneyRate / 100);
    const logi = rev * (APP.cfg.logistics / 100);
    const gross = cogs === null ? null : rev - cogs;
    const net = gross === null ? null : gross - bonus - fin - logi;
    return {
      y: +o.year, m: mo, ym: ymOf(+o.year, mo),
      partner: o.partner, chain: ck, brand: o.brand, sku: o.sku,
      division: o.division, manager: o.manager,
      qty, litres: +o.litres || 0, rev, outlets: +o.outlets || 0,
      unitCost, cogs, gross, bonusPct, bonus, fin, logi, net,
      price: qty ? rev / qty : 0
    };
  });

  D.sales = D.sales.filter(r => r.y > 0 && r.m > 0);
  D.years = uniq(D.sales.map(r => r.y)).sort();
  D.chains = uniq(D.sales.map(r => r.chain)).sort();
  D.brands = uniq(D.sales.map(r => r.brand)).sort();
  D.partners = uniq(D.sales.map(r => r.partner)).sort();
  D.skuList = uniq(D.sales.map(r => r.sku)).sort();

  /* --- індекс для зіставлення SKU --- */
  const idx = { exact: {}, list: [] };
  D.skuList.forEach(s => {
    idx.exact[s] = s;
    idx.list.push({ sku: s, tk: skuTokens(s), vol: skuVolume(s) });
  });
  D.skuIndex = idx;

  /* --- рентабельність (факт) --- */
  buildProfit();

  /* --- промо --- */
  buildPromo();

  /* --- аномалії --- */
  detectAnomalies();

  if (!APP.f.years.length) APP.f.years = D.years.slice(-2);
}

/** Аркуш «рент»: ієрархія партнер → бренд → SKU з фактичним маркетингом */
function buildProfit() {
  const D = APP.d;
  const pos = v => Math.abs(+v || 0);
  D.profit = tableToObjects(APP.raw.profit).map(o => {
    const rev = +o.revenue || 0;
    const mkt = pos(o.mktBuyers) + pos(o.mktSuppliers) + pos(o.delivery)
      + pos(o.oneTimeBuyers) + pos(o.oneTimeSuppliers);
    const cogs = pos(o.cogs);
    return {
      y: +o.year, m: +o.month, ym: ymOf(+o.year, +o.month),
      level: +o.level, partner: o.partner || '', brand: o.brand || '', sku: o.sku || '',
      name: o.sku || o.brand || o.partner || '',
      rev, cogs, gross: rev - cogs,
      income: +o.income || 0,
      mktBuyers: pos(o.mktBuyers), mktSuppliers: pos(o.mktSuppliers),
      delivery: pos(o.delivery), oneBuyers: pos(o.oneTimeBuyers), oneSuppliers: pos(o.oneTimeSuppliers),
      mkt,
      ros: rev ? (rev - cogs) / rev * 100 : 0,
      roTotal: rev ? (+o.income || 0) / rev * 100 : 0,
      mktPct: rev ? mkt / rev * 100 : 0
    };
  }).filter(r => r.y > 0 && r.m > 0 && r.name);
  D.profitPartners = uniq(D.profit.filter(r => r.level === 1).map(r => r.partner)).sort();
  D.profitMonths = uniq(D.profit.map(r => r.ym)).sort();
}

function buildPromo() {
  const D = APP.d;
  const rows = tableToObjects(APP.raw.promo);
  const log = {};
  const weeks = new Set();

  D.promo = rows.map(o => {
    const chainKey = chainOfSheet(o.chain);
    const mm = matchSku(o.sku, D.skuIndex);
    if (o.sku) {
      if (!log[o.sku]) log[o.sku] = { promoName: o.sku, sku: mm.sku, score: mm.score, near: mm.near, n: 0, chains: new Set() };
      log[o.sku].n++;
      log[o.sku].chains.add(o.chain);
    }
    if (o.week) weeks.add(o.week);
    return {
      sheet: o.chain, chain: chainKey, brand: o.brand,
      promoSku: o.sku, sku: mm.sku, matchScore: mm.score,
      barcode: o.barcode, article: o.article,
      basePrice: +o.basePrice || 0, outletsPlan: +o.outletsPlan || 0,
      week: o.week, metric: o.metric, text: o.text,
      value: o.value === null || o.value === undefined ? null : +o.value,
      depth: o.depth === null || o.depth === undefined ? null : +o.depth
    };
  });

  D.matchLog = Object.values(log).map(x => ({ ...x, chains: Array.from(x.chains) }))
    .sort((a, b) => a.score - b.score);
  D.promoWeeks = Array.from(weeks).sort();

  /* агрегація промо до місяця */
  /* тиждень вважається промо-тижнем, якщо є назва механіки, умови або промо-ціна */
  const weekCell = {};
  D.promo.forEach(p => {
    if (!p.week || !p.sku) return;
    const k = p.chain + '|' + p.sku + '|' + p.week;
    const c = weekCell[k] || (weekCell[k] = {
      chain: p.chain, sku: p.sku, week: p.week,
      on: false, depth: null, plan: 0, promoPrice: null, basePrice: p.basePrice || 0
    });
    if (p.basePrice && !c.basePrice) c.basePrice = p.basePrice;
    if (p.metric === 'name') { c.on = true; if (p.depth !== null) c.depth = Math.max(c.depth ?? 0, p.depth); }
    else if (p.metric === 'terms') { c.on = true; if (p.depth !== null) c.depth = Math.max(c.depth ?? 0, p.depth); }
    else if (p.metric === 'price') { c.on = true; if (p.value > 0) c.promoPrice = p.value; }
    else if (p.metric === 'plan') { c.plan += p.value || 0; }
  });

  const pm = {};
  Object.values(weekCell).forEach(c => {
    /* якщо умови не заповнені — рахуємо глибину з базової та промо-ціни */
    if (c.depth === null && c.basePrice > 0 && c.promoPrice > 0 && c.promoPrice < c.basePrice) {
      c.depth = Math.round((1 - c.promoPrice / c.basePrice) * 1000) / 10;
      c.depthDerived = true;
    }
    const ym = c.week.slice(0, 7);
    const k = c.chain + '|' + c.sku + '|' + ym;
    const a = pm[k] || (pm[k] = { weeks: 0, depths: [], plan: 0, chain: c.chain, sku: c.sku, ym });
    if (c.on) { a.weeks++; if (c.depth !== null) a.depths.push(c.depth); }
    a.plan += c.plan;
  });
  Object.values(pm).forEach(v => {
    v.depthAvg = v.depths.length ? mean(v.depths) : null;
    v.depthMax = v.depths.length ? Math.max(...v.depths) : null;
  });
  D.promoMonth = pm;
  D.promoWeekCell = weekCell;
}

/** ТМ позиції: спершу з промо-плану, інакше — з номенклатури продажів, інакше — з назви */
function brandOfPromo(p) {
  if (p.brand && p.brand.length > 1) return p.brand;
  if (p.sku) {
    const r = APP.d.sales.find(x => x.sku === p.sku);
    if (r && r.brand) return r.brand;
  }
  const n = String(p.promoSku || '');
  const m = n.match(/^(Bonsai Premium|Bonsai Professional|Bonsai|Peri\s*Peri|Salateria Fresh|Salateria|YKI|Премія|Повна чаша|Special Edition)/i);
  return m ? m[1] : 'Інше';
}

function chainOfSheet(sheet) {
  const over = APP.overrides.chain[sheet];
  if (over) return over;
  for (const r of CHAIN_RULES) if (r.re.test(sheet)) return r.key;
  return sheet;
}

/* ------------------------------ АНОМАЛІЇ ------------------------------ */

function detectAnomalies() {
  const D = APP.d, out = [];

  /* 1. SKU у продажах без собівартості */
  const noCost = D.skuList.filter(s => !D.cost[s]);
  if (noCost.length) {
    const rev = sum(D.sales.filter(r => !r.unitCost && r.unitCost !== 0), r => r.rev);
    out.push({
      lvl: 'warn', t: 'SKU без собівартості',
      d: `${noCost.length} позицій із продажів відсутні в аркуші «Собівартість». Їхня виручка (${money(rev)} ₴) враховується у обороті, але не в марж.`,
      items: noCost.slice(0, 40)
    });
  }

  /* 2. Літраж не відповідає обсягу з назви */
  const byS = {};
  D.sales.forEach(r => {
    if (!r.qty) return;
    if (!byS[r.sku]) byS[r.sku] = { qty: 0, lit: 0 };
    byS[r.sku].qty += r.qty; byS[r.sku].lit += r.litres;
  });
  const bad = [];
  Object.entries(byS).forEach(([sku, v]) => {
    const vol = skuVolume(sku);
    if (!vol || !v.qty) return;
    const actual = v.lit / v.qty;          // л на одиницю
    const expect = vol / 1000;
    if (expect > 0 && (actual / expect > 8 || actual / expect < 0.12)) {
      bad.push({ sku, actual, expect, ratio: actual / expect });
    }
  });
  if (bad.length) {
    out.push({
      lvl: 'err', t: 'Помилка одиниць виміру в колонці «Литров»',
      d: `${bad.length} SKU мають літраж, що розходиться з обсягом у назві більш ніж у 8 разів — найімовірніше, значення записані в мілілітрах замість літрів. Це спотворює будь-який аналіз «за літр».`,
      items: bad.map(b => `${b.sku}: ${n2(b.actual)} л/од замість ~${n2(b.expect)} (×${n0(b.ratio)})`)
    });
  }

  /* 3. Мережі без заповнених умов */
  const noTerms = D.chains.filter(c => c !== CHAIN_OTHER && !D.termsMap[c]);
  const emptyTerms = D.terms.filter(t => !(+t.totalBonus) || /⚠|заповнити/i.test(t.status || ''));
  if (noTerms.length || emptyTerms.length) {
    out.push({
      lvl: 'warn', t: 'Умови мереж неповні',
      d: 'Для цих мереж бонусне навантаження прийнято за 0% — чиста маржа по них завищена.',
      items: uniq(noTerms.concat(emptyTerms.map(t => t.chain + ' (' + t.status + ')')))
    });
  }

  /* 4. Промо-SKU без відповідника у продажах */
  const unmatched = D.matchLog.filter(m => !m.sku);
  if (unmatched.length) {
    out.push({
      lvl: 'warn', t: 'Позиції промо-плану без пари у продажах',
      d: `${unmatched.length} назв із промо-плану не зіставилися автоматично. Вони не потраплять в аналіз ефективності промо, доки не задати відповідність вручну.`,
      items: unmatched.slice(0, 30).map(m => `${m.promoName} → найближче: ${m.near || '—'}`)
    });
  }

  /* 5. Продажі нижче собівартості */
  const below = {};
  D.sales.forEach(r => {
    if (r.unitCost === null || !r.qty || r.rev <= 0) return;
    if (r.price < r.unitCost) {
      const k = r.sku + '|' + r.chain;
      if (!below[k]) below[k] = { sku: r.sku, chain: r.chain, rev: 0, loss: 0 };
      below[k].rev += r.rev;
      below[k].loss += r.cogs - r.rev;
    }
  });
  const bl = Object.values(below).sort((a, b) => b.loss - a.loss);
  if (bl.length) {
    out.push({
      lvl: 'err', t: 'Відвантаження нижче виробничої собівартості',
      d: `${bl.length} комбінацій SKU × мережа продані нижче собівартості. Сукупний валовий збиток: ${money(sum(bl, x => x.loss))} ₴.`,
      items: bl.slice(0, 25).map(x => `${x.sku} → ${x.chain}: −${n0(x.loss)} ₴`)
    });
  }

  /* 6. підозрілі відсотки в довіднику умов */
  const wild = D.terms.filter(t => (+t.totalBonus) > 60 || (+t.retro) > 60);
  if (wild.length) {
    out.push({
      lvl: 'err', t: 'Некоректні відсотки в умовах мереж',
      d: 'Значення понад 60% зазвичай означають, що число введено як 19,71 замість 19,71%. ' +
        'Панель бере його як є, тож маржа по цих мережах порахована неправильно.',
      items: wild.map(t => `${t.chain}: ретро ${n1(+t.retro)}%, разом ${n1(+t.totalBonus)}%`)
    });
  }

  /* 7. факт маркетингу проти довідника */
  if (D.profit && D.profit.length) {
    const byP = {};
    D.profit.filter(r => r.level === 1).forEach(r => {
      const a = byP[r.partner] || (byP[r.partner] = { rev: 0, mkt: 0 });
      a.rev += r.rev; a.mkt += r.mkt;
    });
    const diffs = [];
    Object.entries(byP).forEach(([p, a]) => {
      if (a.rev < 50000) return;
      const t = D.termsMap[chainOf(p)];
      if (!t) return;
      const fact = a.mkt / a.rev * 100, term = +t.totalBonus || 0;
      if (Math.abs(fact - term) > 8) diffs.push({ p, fact, term });
    });
    if (diffs.length) {
      out.push({
        lvl: 'warn', t: 'Довідник умов розходиться з фактом',
        d: `Для ${diffs.length} клієнтів фактичний маркетинг зі звіту відрізняється від умов більш ніж на 8 п.п. Розрахунки граничної знижки спираються на довідник, тож там варто оновити цифри.`,
        items: diffs.sort((a, b) => Math.abs(b.fact - b.term) - Math.abs(a.fact - a.term))
          .slice(0, 25).map(d => `${d.p}: факт ${n1(d.fact)}% проти ${n1(d.term)}% в умовах`)
      });
    }
  }

  /* 8. промо-аркуші, де глибина знижки не читається */
  if (APP.raw.promoDiag && APP.raw.promoDiag.length) {
    const blind = APP.raw.promoDiag.filter(d =>
      !d.skipped && !d.error && (d.cells || 0) > 20 && !(d.withDepth || 0));
    if (blind.length) {
      out.push({
        lvl: 'warn', t: 'Аркуші промо-плану без глибини знижки',
        d: 'У цих аркушах не вдалося прочитати відсоток знижки: немає під-рядка «условия», ' +
          'або відсоток записаний у незвичному форматі. Промо там видно в календарі, ' +
          'але вони не потрапляють у розрахунок граничної знижки та ROI.',
        items: blind.map(d => `${d.sheet}: ${n0(d.cells)} клітинок, з них з глибиною 0`)
      });
    }
  }

  APP.d.anomalies = out;
}

/* ------------------------------ ФІЛЬТРИ ------------------------------ */

function rows() {
  const f = APP.f;
  return APP.d.sales.filter(r => {
    if (f.years.length && !f.years.includes(r.y)) return false;
    if (f.months.length && !f.months.includes(r.m)) return false;
    if (f.chains.length && !f.chains.includes(r.chain)) return false;
    if (f.brands.length && !f.brands.includes(r.brand)) return false;
    if (f.skus.length && !f.skus.includes(r.sku)) return false;
    if (f.chan === 'retail' && r.chain === CHAIN_OTHER) return false;
    if (f.chan === 'other' && r.chain !== CHAIN_OTHER) return false;
    if (f.search) {
      const q = f.search.toLowerCase();
      if (!(r.sku.toLowerCase().includes(q) || r.partner.toLowerCase().includes(q) ||
        r.brand.toLowerCase().includes(q))) return false;
    }
    return true;
  });
}

/** Агрегація довільного зрізу */
function agg(rs, keyFn) {
  const m = new Map();
  for (const r of rs) {
    const k = keyFn(r);
    if (k === null || k === undefined) continue;
    let a = m.get(k);
    if (!a) {
      a = {
        key: k, qty: 0, litres: 0, rev: 0, cogs: 0, gross: 0, bonus: 0, fin: 0,
        net: 0, n: 0, noCost: 0, months: new Set(), skus: new Set(), partners: new Set()
      };
      m.set(k, a);
    }
    a.qty += r.qty; a.litres += r.litres; a.rev += r.rev; a.n++;
    if (r.cogs === null) { a.noCost += r.rev; }
    else { a.cogs += r.cogs; a.gross += r.gross; a.net += r.net; }
    a.bonus += r.bonus; a.fin += r.fin;
    a.months.add(r.ym); a.skus.add(r.sku); a.partners.add(r.partner);
  }
  const out = Array.from(m.values());
  out.forEach(a => {
    a.gm = a.rev ? a.gross / a.rev * 100 : 0;
    a.nm = a.rev ? a.net / a.rev * 100 : 0;
    a.price = a.qty ? a.rev / a.qty : 0;
    a.nMonths = a.months.size; a.nSku = a.skus.size; a.nPartners = a.partners.size;
  });
  return out;
}

/** Один прохід: ключ × місяць -> метрика. Замість вкладених filter() у в'ю. */
function seriesBy(rs, keyFn, valFn) {
  const m = new Map();
  for (const r of rs) {
    const k = keyFn(r);
    if (k === null || k === undefined) continue;
    let mm = m.get(k);
    if (!mm) { mm = new Map(); m.set(k, mm); }
    mm.set(r.ym, (mm.get(r.ym) || 0) + (valFn(r) || 0));
  }
  return m;
}

function totals(rs) {
  const t = agg(rs, () => 'all')[0];
  return t || { qty: 0, litres: 0, rev: 0, cogs: 0, gross: 0, bonus: 0, fin: 0, net: 0, gm: 0, nm: 0, price: 0, noCost: 0, nSku: 0, nPartners: 0 };
}

/* ------------------------------ ГРАФІКИ ------------------------------ */

function initChartDefaults() {
  if (!window.Chart) return;
  Chart.defaults.color = '#9C9083';
  Chart.defaults.font.family = "'IBM Plex Sans', system-ui, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.borderColor = '#2A241E';
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.boxHeight = 10;
  Chart.defaults.plugins.legend.labels.padding = 12;
  Chart.defaults.plugins.tooltip.backgroundColor = '#241F19';
  Chart.defaults.plugins.tooltip.borderColor = '#3A322A';
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleColor = '#EFE7D9';
  Chart.defaults.plugins.tooltip.bodyColor = '#C9BEB0';
  Chart.defaults.plugins.tooltip.padding = 9;
  Chart.defaults.plugins.tooltip.cornerRadius = 3;
  Chart.defaults.maintainAspectRatio = false;
}

function chart(id, cfg) {
  const c = el(id);
  if (!c) return;
  if (!window.Chart) {
    c.parentElement.innerHTML =
      '<div class="empty" style="padding:24px">Бібліотеку графіків не завантажено — перевірте доступ до cdnjs.cloudflare.com</div>';
    return;
  }
  const ds = (cfg.data && cfg.data.datasets) || [];
  let pts = 0;
  ds.forEach(d => {
    (d.data || []).forEach(v => {
      const n = (v && typeof v === 'object') ? (v.y ?? v.x) : v;
      if (n !== null && n !== undefined && isFinite(n) && n !== 0) pts++;
    });
  });
  if (!pts) {
    c.parentElement.innerHTML =
      '<div class="empty" style="padding:28px">Для цього зрізу даних немає</div>';
    return;
  }
  if (APP.charts[id]) { APP.charts[id].destroy(); delete APP.charts[id]; }
  APP.charts[id] = new Chart(c.getContext('2d'), cfg);
  return APP.charts[id];
}
function killCharts() {
  Object.values(APP.charts).forEach(c => c.destroy());
  APP.charts = {};
}

const AX = {
  x: { grid: { color: '#221D18' }, ticks: { maxRotation: 0, autoSkip: true } },
  y: { grid: { color: '#221D18' }, ticks: { callback: v => money(v) } },
  yPct: { grid: { color: '#221D18' }, ticks: { callback: v => v + '%' } }
};

/* ------------------------------ НАСТРОЙКИ ------------------------------ */

APP.overrides = { chain: {}, sku: {} };

function loadCfg() {
  try {
    const s = JSON.parse(localStorage.getItem(LS) || '{}');
    Object.assign(APP.cfg, s.cfg || {});
    APP.overrides = Object.assign({ chain: {}, sku: {} }, s.overrides || {});
    if (s.trend) APP.trend = s.trend;
  } catch (e) { }
}
function saveCfg() {
  try {
    localStorage.setItem(LS, JSON.stringify({ cfg: APP.cfg, overrides: APP.overrides, trend: APP.trend }));
  } catch (e) { }
}
function loadCached() {
  try {
    const s = localStorage.getItem(LS + '_data');
    if (!s) return false;
    APP.raw = JSON.parse(s);
    build();
    setStatus('ok', `${n0(APP.d.sales.length)} рядків · з локальної копії`);
    return true;
  } catch (e) { return false; }
}

/* =====================================================================
   НАВІГАЦІЯ, ФІЛЬТРИ, РОУТЕР
   ===================================================================== */

const VIEWS = [
  { id: 'overview', n: '01', t: 'Огляд', grp: 'Результат' },
  { id: 'clients', n: '02', t: 'Клієнти', grp: 'Результат' },
  { id: 'brands', n: '03', t: 'Бренди / ТМ', grp: 'Результат' },
  { id: 'sku', n: '04', t: 'SKU', grp: 'Результат' },
  { id: 'econ', n: '05', t: 'Економіка SKU', grp: 'Гроші' },
  { id: 'profit', n: '06', t: 'Рентабельність факт', grp: 'Гроші', nofilter: true },
  { id: 'chains', n: '07', t: 'Умови мереж', grp: 'Гроші' },
  { id: 'promoplan', n: '08', t: 'Промо-календар', grp: 'Промо', nofilter: true },
  { id: 'promoeff', n: '09', t: 'Ефективність промо', grp: 'Промо' },
  { id: 'data', n: '10', t: 'Дані та якість', grp: 'Службове', nofilter: true }
];

function renderRail() {
  let h = '', grp = '';
  VIEWS.forEach(v => {
    if (v.grp !== grp) { grp = v.grp; h += `<div class="grp">${esc(grp)}</div>`; }
    h += `<a data-v="${v.id}" class="${APP.view === v.id ? 'on' : ''}" tabindex="0"><span class="n">${v.n}</span>${esc(v.t)}</a>`;
  });
  el('rail').innerHTML = h;
  el('rail').querySelectorAll('a').forEach(a => {
    a.onclick = () => go(a.dataset.v);
    a.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(a.dataset.v); } };
  });
}

function multiSel(id, label, items, selected, onChange) {
  const opts = items.map(i =>
    `<option value="${esc(i)}" ${selected.includes(i) ? 'selected' : ''}>${esc(i)}</option>`).join('');
  return `<div class="f"><label for="${id}">${esc(label)}</label>
    <select id="${id}" multiple size="1" style="height:28px">${opts}</select></div>`;
}

function renderFilters() {
  const D = APP.d, f = APP.f;
  if (!D.sales.length) { el('filters').innerHTML = ''; return; }

  const yChips = D.years.map(y =>
    `<span class="chip ${f.years.includes(y) ? 'on' : ''}" data-y="${y}">${y}</span>`).join('');

  const mChips = MONTH_SH.slice(1).map((m, i) =>
    `<span class="chip mini ${f.months.includes(i + 1) ? 'on' : ''}" data-m="${i + 1}">${m}</span>`).join('');

  el('filters').innerHTML = `
    <div class="f"><label>Роки</label><div class="chipbar" id="fYears">${yChips}</div></div>
    <div class="f"><label>Місяці</label><div class="chipbar" id="fMonths">${mChips}
      <span class="chip mini alt" id="fMonthAll" title="Показати всі місяці">усі</span>
      <span class="chip mini alt" id="fMonthH1" title="Січень – червень">I пів</span>
      <span class="chip mini alt" id="fMonthH2" title="Липень – грудень">II пів</span>
    </div></div>
    <div class="f"><label>Мережа</label>
      <select id="fChain"><option value="">усі</option>
        ${D.chains.map(c => `<option ${f.chains[0] === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select></div>
    <div class="f"><label>ТМ</label>
      <select id="fBrand"><option value="">усі</option>
        ${D.brands.map(b => `<option ${f.brands[0] === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}
      </select></div>
    <div class="f"><label>Канал</label>
      <select id="fChan">
        <option value="all" ${f.chan === 'all' ? 'selected' : ''}>усі</option>
        <option value="retail" ${f.chan === 'retail' ? 'selected' : ''}>лише мережі</option>
        <option value="other" ${f.chan === 'other' ? 'selected' : ''}>дистрибуція та інше</option>
      </select></div>
    <div class="f"><label>Пошук</label>
      <input type="text" id="fSearch" placeholder="SKU, партнер, ТМ" value="${esc(f.search)}" style="width:190px"></div>
    <div class="f"><button class="btn sm ghost" id="fReset">Скинути</button></div>
    <div class="f" style="margin-left:auto">
      <span class="pill" id="fCount"></span>
    </div>`;

  el('fYears').querySelectorAll('.chip').forEach(c => c.onclick = () => {
    const y = +c.dataset.y;
    const i = f.years.indexOf(y);
    if (i >= 0) f.years.splice(i, 1); else f.years.push(y);
    if (!f.years.length) f.years = D.years.slice();
    renderFilters(); render();
  });
  el('fMonths').querySelectorAll('.chip[data-m]').forEach(c => c.onclick = () => {
    const m = +c.dataset.m, i = f.months.indexOf(m);
    if (i >= 0) f.months.splice(i, 1); else f.months.push(m);
    renderFilters(); render();
  });
  el('fMonthAll').onclick = () => { f.months = []; renderFilters(); render(); };
  el('fMonthH1').onclick = () => { f.months = [1, 2, 3, 4, 5, 6]; renderFilters(); render(); };
  el('fMonthH2').onclick = () => { f.months = [7, 8, 9, 10, 11, 12]; renderFilters(); render(); };
  el('fChain').onchange = e => { f.chains = e.target.value ? [e.target.value] : []; render(); updCount(); };
  el('fBrand').onchange = e => { f.brands = e.target.value ? [e.target.value] : []; render(); updCount(); };
  el('fChan').onchange = e => { f.chan = e.target.value; render(); updCount(); };
  let tmr;
  el('fSearch').oninput = e => {
    clearTimeout(tmr);
    tmr = setTimeout(() => { f.search = e.target.value.trim(); render(); updCount(); }, 260);
  };
  el('fReset').onclick = () => {
    APP.f = { years: D.years.slice(-2), months: [], chains: [], brands: [], skus: [], search: '', chan: 'all' };
    renderFilters(); render();
  };
  updCount();
}

function updCount() {
  const c = el('fCount');
  if (!c) return;
  const rs = rows();
  const f = APP.f;
  const per = f.months.length && f.months.length < 12
    ? ' · ' + f.months.slice().sort((a, b) => a - b).map(m => MONTH_SH[m]).join(', ')
    : '';
  c.textContent = `${n0(rs.length)} записів · ${n0(new Set(rs.map(r => r.sku)).size)} SKU · ${money(sum(rs, r => r.rev))} ₴${per}`;
}

function go(v) {
  APP.view = v;
  renderRail();
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function render() {
  killCharts();
  const host = el('view');
  if (!APP.d.sales.length) { host.innerHTML = emptyState(); bindSource(); return; }
  const fn = ({
    overview: viewOverview, clients: viewClients, brands: viewBrands, sku: viewSku,
    econ: viewEcon, profit: viewProfit, chains: viewChains, promoplan: viewPromoPlan,
    promoeff: viewPromoEff, data: viewData
  })[APP.view] || viewOverview;
  const meta = VIEWS.find(v => v.id === APP.view);
  const fb = el('filters');
  if (fb) fb.style.display = (meta && meta.nofilter) ? 'none' : '';

  fn(host);
  updCount();
  countUp();
}

function emptyState() {
  return `<div class="card"><div class="body"><div class="empty">
    <b>Даних ще немає</b>
    Підключіть вебдодаток Apps Script або завантажте вивантаження JSON.
    <div style="margin-top:14px"><button class="btn primary" id="emptyBtn">Налаштувати джерело</button></div>
  </div></div></div>`;
}
function bindSource() {
  const b = el('emptyBtn');
  if (b) b.onclick = openSource;
}

/* ------------------------------ ХЕЛПЕРИ РЕНДЕРУ ------------------------------ */

function card(title, body, hint, cls) {
  return `<div class="card ${cls || ''}"><h3>${esc(title)}${hint ? `<span class="hint">${hint}</span>` : ''}</h3>
    <div class="body${/tblwrap|calwrap|hm\b/.test(body.slice(0, 60)) ? ' flush' : ''}">${body}</div></div>`;
}
function canvas(id, h) { return `<div class="chartbox ${h || 'h220'}"><canvas id="${id}"></canvas></div>`; }

function kpi(label, value, unit, sub, cls) {
  return `<div class="kpi ${cls || ''}"><div class="k">${esc(label)}</div>
    <div class="v">${value}${unit ? `<span class="u">${unit}</span>` : ''}</div>${sub || ''}</div>`;
}

/** Сортована таблиця. cols: [{k,t,f,txt,w}] */
function dataTable(id, cols, data, opts) {
  opts = opts || {};
  const st = dataTable.state[id] || (dataTable.state[id] = { k: opts.sort || cols[1].k, asc: false });
  const arr = data.slice().sort((a, b) => {
    const x = a[st.k], y = b[st.k];
    const r = (typeof x === 'string' || typeof y === 'string')
      ? String(x).localeCompare(String(y), 'uk') : (x || 0) - (y || 0);
    return st.asc ? r : -r;
  });
  const lim = opts.limit || 400;
  const shown = arr.slice(0, lim);
  let h = `<div class="tblwrap"><table class="dt" id="${id}"><thead><tr>`;
  cols.forEach(c => {
    h += `<th data-k="${c.k}" class="${c.txt ? 'txt' : ''} ${st.k === c.k ? 'sorted ' + (st.asc ? 'asc' : '') : ''}"
      ${c.title ? `title="${esc(c.title)}"` : ''}>${esc(c.t)}</th>`;
  });
  h += `</tr></thead><tbody>`;
  shown.forEach(r => {
    h += '<tr>';
    cols.forEach(c => {
      h += `<td class="${c.txt ? 'txt' : ''}">${c.f ? c.f(r[c.k], r) : (r[c.k] ?? '—')}</td>`;
    });
    h += '</tr>';
  });
  if (opts.total) {
    h += '<tr class="tot">';
    cols.forEach(c => h += `<td class="${c.txt ? 'txt' : ''}">${opts.total[c.k] !== undefined ? opts.total[c.k] : ''}</td>`);
    h += '</tr>';
  }
  h += `</tbody></table></div>`;
  if (arr.length > lim) h += `<div class="note" style="padding:6px 10px">Показано ${lim} з ${n0(arr.length)} рядків — уточніть фільтри.</div>`;
  return h;
}
dataTable.state = {};

function bindTables() {
  document.querySelectorAll('table.dt th[data-k]').forEach(th => {
    th.onclick = () => {
      const id = th.closest('table').id;
      const st = dataTable.state[id];
      if (st.k === th.dataset.k) st.asc = !st.asc; else { st.k = th.dataset.k; st.asc = false; }
      render();
    };
  });
}

/** Колір комірки теплокарти */
function heat(v, max, neg) {
  if (!isFinite(v) || !max) return '';
  const a = Math.min(1, Math.abs(v) / max);
  if (neg && v < 0) return `background:rgba(217,86,63,${(0.09 + a * 0.55).toFixed(3)})`;
  return `background:rgba(232,163,61,${(0.07 + a * 0.5).toFixed(3)})`;
}

/* =====================================================================
   01 · ОГЛЯД
   ===================================================================== */

function yoyPair(rs) {
  const ys = uniq(rs.map(r => r.y)).sort();
  if (ys.length < 2) return null;
  const cur = ys[ys.length - 1], prev = ys[ys.length - 2];
  const curMonths = new Set(rs.filter(r => r.y === cur).map(r => r.m));
  return {
    cur, prev,
    a: rs.filter(r => r.y === cur),
    b: rs.filter(r => r.y === prev && curMonths.has(r.m)),
    months: curMonths.size
  };
}

function viewOverview(host) {
  const rs = rows(), T = totals(rs);
  const yy = yoyPair(rs);
  const Ta = yy ? totals(yy.a) : null, Tb = yy ? totals(yy.b) : null;

  const byMPre = agg(rs, r => r.ym).sort((a, b) => a.key.localeCompare(b.key));

  const k = (lab, v, u, cur, prev, cls, inv) =>
    kpi(lab, v, u, yy && prev ? dEl(delta(cur, prev), inv) : '', cls);

  const kpis = `<div class="kpis">
    ${k('Виручка без ПДВ', money(T.rev), '₴', Ta && Ta.rev, Tb && Tb.rev)}
    ${k('Обсяг', money(T.qty), 'од', Ta && Ta.qty, Tb && Tb.qty)}
    ${k('Валова маржа', money(T.gross), '₴', Ta && Ta.gross, Tb && Tb.gross, T.gross > 0 ? 'pos' : 'neg')}
    ${kpi('Валова маржинальність', n1(T.gm), '%', yy ? ppEl(Ta.gm - Tb.gm) : '')}
    ${k('Бонуси мереж', money(T.bonus), '₴', Ta && Ta.bonus, Tb && Tb.bonus, 'neg', true)}
    ${k('Чистий внесок', money(T.net), '₴', Ta && Ta.net, Tb && Tb.net, T.net > 0 ? 'pos' : 'neg')}
    ${kpi('Чиста маржинальність', n1(T.nm), '%', yy ? ppEl(Ta.nm - Tb.nm) : '')}
    ${kpi('Активних SKU', n0(T.nSku), '', `<span class="d">${n0(T.nPartners)} партнерів</span>`)}
    ${(() => {
    const sl = trendSlope(byMPre.map(x => x.rev));
    return kpi('Тренд виручки', sl === null ? '—' : (sl > 0 ? '+' : '') + n0(sl), '%',
      `<span class="d">за ${n0(byMPre.length)} міс. періоду</span>`,
      sl === null ? '' : (sl > 0 ? 'pos' : 'neg'));
  })()}
  </div>`;

  /* динаміка по місяцях */
  const byM = byMPre;

  /* воронка P&L */
  const bridge = wfBridge(T);

  /* канали */
  const byCh = agg(rs, r => r.chain).sort((a, b) => b.rev - a.rev);
  const byBr = agg(rs, r => r.brand).sort((a, b) => b.rev - a.rev);

  host.innerHTML = `
    ${kpis}
    <div class="grid g32" style="margin-top:12px">
      ${card('Виручка та чиста маржинальність по місяцях', canvas('cMonth', 'h300'),
    `<span class="trendsw">
       <span class="chip mini ${APP.trend === 'linear' ? 'on' : ''}" data-t="linear">тренд</span>
       <span class="chip mini ${APP.trend === 'sma' ? 'on' : ''}" data-t="sma">ковзне 3</span>
       <span class="chip mini ${APP.trend === 'off' ? 'on' : ''}" data-t="off">без</span>
     </span>`)}
      ${card('Від виручки до чистого внеску', bridge, 'за обраний період')}
    </div>
    <div class="grid g3" style="margin-top:12px">
      ${card('Структура за мережами', canvas('cChain', 'h260'), 'частка виручки')}
      ${card('Структура за ТМ', canvas('cBrand', 'h260'), 'частка виручки')}
      ${card('Маржинальність каналів', canvas('cChMargin', 'h260'), 'валова / чиста, %')}
    </div>
    <div class="grid g2" style="margin-top:12px">
      ${card('Топ-12 клієнтів', canvas('cTop', 'h360'), 'виручка та чистий внесок')}
      ${card('Обсяг проти маржинальності', canvas('cScatter', 'h360'), 'бульбашка = виручка SKU')}
    </div>`;

  /* --- місячна динаміка --- */
  const revSeries = byM.map(x => x.rev);
  const nmSeries = byM.map(x => x.nm);
  const trendName = APP.trend === 'sma' ? 'ковзне 3 міс.' : 'тренд';
  const mDatasets = [
    { type: 'bar', label: 'Виручка', data: revSeries, backgroundColor: '#8A6224', borderRadius: 1, order: 3 },
    { type: 'bar', label: 'Чистий внесок', data: byM.map(x => x.net), backgroundColor: '#E8A33D', borderRadius: 1, order: 2 },
    {
      type: 'line', label: 'Чиста маржа, %', data: nmSeries, yAxisID: 'y1',
      borderColor: '#86B860', backgroundColor: '#86B860', tension: .3, pointRadius: 2, borderWidth: 2, order: 1
    }
  ];
  const tRev = trendDataset('Виручка · ' + trendName, revSeries, '#5CC8F5');
  const tNm = trendDataset('Маржа · ' + trendName, nmSeries, '#9B7BE8', 'y1');
  if (tRev) mDatasets.push(tRev);
  if (tNm) mDatasets.push(tNm);

  chart('cMonth', {
    data: {
      labels: byM.map(x => ymLabel(x.key)),
      datasets: mDatasets
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: AX.x, y: AX.y,
        y1: { position: 'right', grid: { display: false }, ticks: { callback: v => v + '%' } }
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: c => c.dataset.yAxisID === 'y1'
              ? ` ${c.dataset.label}: ${n1(c.parsed.y)}%`
              : ` ${c.dataset.label}: ${n0(c.parsed.y)} ₴`
          }
        }
      }
    }
  });

  const doughnut = (id, data, lim) => {
    const top = data.slice(0, lim);
    const rest = data.slice(lim);
    const labels = top.map(x => x.key).concat(rest.length ? ['інші'] : []);
    const vals = top.map(x => x.rev).concat(rest.length ? [sum(rest, x => x.rev)] : []);
    chart(id, {
      type: 'doughnut',
      data: {
        labels, datasets: [{
          data: vals, backgroundColor: labels.map((_, i) => colorFor(i)),
          borderColor: '#191613', borderWidth: 2
        }]
      },
      options: {
        cutout: '58%',
        plugins: {
          legend: { position: 'right', labels: { font: { size: 10.5 } } },
          tooltip: {
            callbacks: {
              label: c => ` ${c.label}: ${n0(c.parsed)} ₴ (${n1(c.parsed / vals.reduce((a, b) => a + b, 0) * 100)}%)`
            }
          }
        }
      }
    });
  };
  doughnut('cChain', byCh, 7);
  doughnut('cBrand', byBr, 8);

  chart('cChMargin', {
    type: 'bar',
    data: {
      labels: byCh.slice(0, 9).map(x => x.key),
      datasets: [
        { label: 'Валова, %', data: byCh.slice(0, 9).map(x => x.gm), backgroundColor: '#6F8FD0', borderRadius: 1 },
        { label: 'Чиста, %', data: byCh.slice(0, 9).map(x => x.nm), backgroundColor: '#E8A33D', borderRadius: 1 }
      ]
    },
    options: {
      indexAxis: 'y',
      scales: { x: AX.yPct, y: { grid: { display: false }, ticks: { font: { size: 10 } } } },
      plugins: { tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${n1(c.parsed.x)}%` } } }
    }
  });

  const byP = agg(rs, r => r.partner).sort((a, b) => b.rev - a.rev).slice(0, 12);
  chart('cTop', {
    type: 'bar',
    data: {
      labels: byP.map(x => x.key.length > 26 ? x.key.slice(0, 25) + '…' : x.key),
      datasets: [
        { label: 'Виручка', data: byP.map(x => x.rev), backgroundColor: '#8A6224', borderRadius: 1 },
        { label: 'Чистий внесок', data: byP.map(x => x.net), backgroundColor: '#E8A33D', borderRadius: 1 }
      ]
    },
    options: {
      indexAxis: 'y',
      scales: { x: AX.y, y: { grid: { display: false }, ticks: { font: { size: 10 } } } },
      plugins: { tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${n0(c.parsed.x)} ₴` } } }
    }
  });

  const bySku = agg(rs, r => r.sku).filter(x => x.rev > 0 && x.cogs > 0);
  const maxRev = Math.max(...bySku.map(x => x.rev), 1);

  /* тренд «більший обсяг → яка маржа» будуємо в логарифмі обсягу */
  const sc = bySku.filter(x => x.qty > 0).map(x => ({ lx: Math.log10(x.qty), y: x.gm }))
    .sort((a, b) => a.lx - b.lx);
  let scTrend = null;
  if (APP.trend !== 'off' && sc.length > 4) {
    const mx = mean(sc.map(p => p.lx)), my = mean(sc.map(p => p.y));
    let cov = 0, vx = 0;
    sc.forEach(p => { cov += (p.lx - mx) * (p.y - my); vx += (p.lx - mx) ** 2; });
    if (vx) {
      const kk = cov / vx;
      const x1 = sc[0].lx, x2 = sc[sc.length - 1].lx;
      scTrend = {
        type: 'line', label: 'тренд',
        data: [{ x: 10 ** x1, y: my + kk * (x1 - mx) }, { x: 10 ** x2, y: my + kk * (x2 - mx) }],
        borderColor: '#5CC8F5', borderWidth: 1.6, borderDash: [6, 4], pointRadius: 0, fill: false
      };
    }
  }

  chart('cScatter', {
    type: 'bubble',
    data: {
      datasets: [{
        label: 'SKU',
        data: bySku.map(x => ({
          x: x.qty, y: x.gm, r: 3 + Math.sqrt(x.rev / maxRev) * 18, sku: x.key, rev: x.rev
        })),
        backgroundColor: 'rgba(232,163,61,.35)', borderColor: '#E8A33D', borderWidth: 1
      }].concat(scTrend ? [scTrend] : [])
    },
    options: {
      scales: {
        x: { type: 'logarithmic', grid: { color: '#221D18' }, title: { display: true, text: 'обсяг, од (лог)' }, ticks: { callback: v => money(v) } },
        y: { grid: { color: '#221D18' }, title: { display: true, text: 'валова маржа, %' }, ticks: { callback: v => v + '%' } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => c.raw.sku ? [c.raw.sku, `обсяг: ${n0(c.raw.x)} од`,
            `маржа: ${n1(c.raw.y)}%`, `виручка: ${n0(c.raw.rev)} ₴`] : ''
          }
        }
      }
    }
  });

  bindTrendSwitch();
}

function bindTrendSwitch() {
  document.querySelectorAll('.trendsw .chip').forEach(c => c.onclick = () => {
    APP.trend = c.dataset.t;
    saveCfg();
    render();
  });
}

function wfBridge(T) {
  const base = T.rev || 1;
  const steps = [
    { l: 'Виручка без ПДВ', v: T.rev, kind: 'start' },
    { l: 'Виробнича собівартість', v: -T.cogs, kind: 'neg' },
    { l: 'Валова маржа', v: T.gross, kind: 'mid' },
    { l: 'Бонуси мереж', v: -T.bonus, kind: 'neg' },
    { l: 'Вартість відтермінування', v: -T.fin, kind: 'neg' },
    { l: 'Чистий внесок', v: T.net, kind: 'end' }
  ];
  const colors = { start: '#6F8FD0', neg: '#D9563F', mid: '#C9A227', end: '#86B860' };
  let h = '<div class="wf">';
  steps.forEach(s => {
    const w = Math.min(100, Math.abs(s.v) / base * 100);
    h += `<div class="row">
      <div class="lab">${esc(s.l)}</div>
      <div class="track"><div class="seg" style="left:0;width:${w.toFixed(1)}%;background:${colors[s.kind]}"></div></div>
      <div class="val">${s.v < 0 ? '−' : ''}${n0(Math.abs(s.v))}<span style="color:var(--dim)"> ₴</span></div>
    </div>`;
  });
  h += '</div>';
  h += `<div class="note" style="margin-top:10px">
    Валова маржа <b>${n1(T.gm)}%</b> · бонусне навантаження <b>${n1(T.rev ? T.bonus / T.rev * 100 : 0)}%</b>
    · чистий внесок <b>${n1(T.nm)}%</b> від виручки.
    ${T.noCost > 0 ? `<br>Увага: ${money(T.noCost)} ₴ виручки не має собівартості — маржа занижена на цю частину обороту.` : ''}
  </div>`;
  return h;
}

/* =====================================================================
   02 · КЛІЄНТИ
   ===================================================================== */

function viewClients(host) {
  const rs = rows();
  const byP = agg(rs, r => r.partner).sort((a, b) => b.rev - a.rev);
  const T = totals(rs);

  /* Парето */
  let cum = 0;
  const pareto = byP.map(x => { cum += x.rev; return { key: x.key, rev: x.rev, cum: T.rev ? cum / T.rev * 100 : 0 }; });
  const n80 = pareto.findIndex(x => x.cum >= 80) + 1;

  /* YoY по клієнту */
  const yy = yoyPair(rs);
  const prevMap = {};
  if (yy) agg(yy.b, r => r.partner).forEach(x => prevMap[x.key] = x);
  const curMap = {};
  if (yy) agg(yy.a, r => r.partner).forEach(x => curMap[x.key] = x);

  const data = byP.map(x => {
    const p = prevMap[x.key], c = curMap[x.key];
    return {
      partner: x.key, chain: chainOf(x.key),
      rev: x.rev, qty: x.qty, share: T.rev ? x.rev / T.rev * 100 : 0,
      gm: x.gm, bonusPct: x.rev ? x.bonus / x.rev * 100 : 0, nm: x.nm,
      net: x.net, nSku: x.nSku, nMonths: x.nMonths,
      yoy: (yy && p && c) ? delta(c.rev, p.rev) : null
    };
  });

  const cols = [
    { k: 'partner', t: 'Клієнт', txt: true },
    { k: 'chain', t: 'Мережа', txt: true, f: v => `<span class="tag">${esc(v)}</span>` },
    { k: 'rev', t: 'Виручка, ₴', f: v => n0(v) },
    { k: 'share', t: 'Частка', f: v => n1(v) + '%' },
    { k: 'yoy', t: 'Δ р/р', f: v => v === null ? '—' : `<span class="${v > 0 ? 'up' : 'down'}">${v > 0 ? '+' : ''}${n1(v)}%</span>` },
    { k: 'qty', t: 'Обсяг, од', f: v => n0(v) },
    { k: 'gm', t: 'Валова, %', f: v => n1(v) },
    { k: 'bonusPct', t: 'Бонуси, %', f: v => v ? `<span class="down">${n1(v)}</span>` : '0' },
    { k: 'nm', t: 'Чиста, %', f: v => `<span class="${v > 0 ? 'up' : 'down'}">${n1(v)}</span>` },
    { k: 'net', t: 'Чистий внесок, ₴', f: v => n0(v) },
    { k: 'nSku', t: 'SKU', f: v => n0(v) },
    { k: 'nMonths', t: 'Міс.', f: v => n0(v) }
  ];

  const top10 = sum(byP.slice(0, 10), x => x.rev) / (T.rev || 1) * 100;

  host.innerHTML = `
    <div class="kpis">
      ${kpi('Клієнтів у періоді', n0(byP.length))}
      ${kpi('Дають 80% виручки', n0(n80), 'клієнтів', `<span class="d">${n1(n80 / byP.length * 100)}% бази</span>`)}
      ${kpi('Частка топ-10', n1(top10), '%', '', top10 > 70 ? 'neg' : '')}
      ${kpi('Виручка на клієнта', money(T.rev / (byP.length || 1)), '₴')}
      ${kpi('Клієнтів із від\'ємним внеском', n0(data.filter(d => d.net < 0).length), '', '', data.filter(d => d.net < 0).length ? 'neg' : 'pos')}
    </div>
    <div class="grid g2" style="margin-top:12px">
      ${card('Концентрація виручки (Парето)', canvas('cPareto', 'h300'),
    `${n0(n80)} клієнтів дають 80%`)}
      ${card('Виручка проти чистої маржинальності', canvas('cCliBub', 'h300'), 'бульбашка = обсяг')}
    </div>
    <div style="margin-top:12px">
      ${card('Клієнти: повний зріз', dataTable('tCli', cols, data, { sort: 'rev' }),
      'клік по заголовку — сортування')}
    </div>`;

  const P = pareto.slice(0, 30);
  chart('cPareto', {
    data: {
      labels: P.map(x => x.key.length > 20 ? x.key.slice(0, 19) + '…' : x.key),
      datasets: [
        { type: 'bar', label: 'Виручка', data: P.map(x => x.rev), backgroundColor: '#E8A33D', borderRadius: 1 },
        {
          type: 'line', label: 'Накопичено, %', data: P.map(x => x.cum), yAxisID: 'y1',
          borderColor: '#6F8FD0', tension: .25, pointRadius: 0, borderWidth: 2
        }
      ]
    },
    options: {
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 60, minRotation: 60, font: { size: 9 } } },
        y: AX.y,
        y1: { position: 'right', min: 0, max: 100, grid: { display: false }, ticks: { callback: v => v + '%' } }
      }
    }
  });

  const maxQ = Math.max(...data.map(d => d.qty), 1);
  chart('cCliBub', {
    type: 'bubble',
    data: {
      datasets: [{
        data: data.filter(d => d.rev > 0).map(d => ({
          x: d.rev, y: d.nm, r: 3 + Math.sqrt(d.qty / maxQ) * 20, l: d.partner
        })),
        backgroundColor: 'rgba(111,143,208,.32)', borderColor: '#6F8FD0', borderWidth: 1
      }]
    },
    options: {
      scales: {
        x: { type: 'logarithmic', grid: { color: '#221D18' }, ticks: { callback: v => money(v) }, title: { display: true, text: 'виручка, ₴ (лог)' } },
        y: { grid: { color: '#221D18' }, ticks: { callback: v => v + '%' }, title: { display: true, text: 'чиста маржа, %' } }
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => [c.raw.l, `${n0(c.raw.x)} ₴`, `${n1(c.raw.y)}%`] } }
      }
    }
  });
  bindTables();
}

/* =====================================================================
   03 · БРЕНДИ / ТМ
   ===================================================================== */

function viewBrands(host) {
  const rs = rows(), T = totals(rs);
  const byB = agg(rs, r => r.brand).sort((a, b) => b.rev - a.rev);
  const months = uniq(rs.map(r => r.ym)).sort();

  const yy = yoyPair(rs);
  const prev = {}, cur = {};
  if (yy) { agg(yy.b, r => r.brand).forEach(x => prev[x.key] = x); agg(yy.a, r => r.brand).forEach(x => cur[x.key] = x); }

  const data = byB.map(x => ({
    brand: x.key, rev: x.rev, share: T.rev ? x.rev / T.rev * 100 : 0,
    qty: x.qty, litres: x.litres, price: x.price,
    gm: x.gm, nm: x.nm, net: x.net, nSku: x.nSku, nPartners: x.nPartners,
    revPerL: x.litres ? x.rev / x.litres : 0,
    yoy: (yy && prev[x.key] && cur[x.key]) ? delta(cur[x.key].rev, prev[x.key].rev) : null
  }));

  const cols = [
    { k: 'brand', t: 'ТМ', txt: true },
    { k: 'rev', t: 'Виручка, ₴', f: v => n0(v) },
    { k: 'share', t: 'Частка', f: v => `${n1(v)}%<span class="bar" style="width:${Math.min(100, v)}%"></span>` },
    { k: 'yoy', t: 'Δ р/р', f: v => v === null ? '—' : `<span class="${v > 0 ? 'up' : 'down'}">${v > 0 ? '+' : ''}${n1(v)}%</span>` },
    { k: 'qty', t: 'Обсяг, од', f: v => n0(v) },
    { k: 'price', t: 'Ціна/од, ₴', f: v => n2(v) },
    { k: 'revPerL', t: 'Виручка/л, ₴', f: v => n2(v) },
    { k: 'gm', t: 'Валова, %', f: v => n1(v) },
    { k: 'nm', t: 'Чиста, %', f: v => `<span class="${v > 0 ? 'up' : 'down'}">${n1(v)}</span>` },
    { k: 'net', t: 'Чистий внесок, ₴', f: v => n0(v) },
    { k: 'nSku', t: 'SKU', f: v => n0(v) },
    { k: 'nPartners', t: 'Клієнтів', f: v => n0(v) }
  ];

  /* матриця ТМ × мережа */
  const chains = agg(rs, r => r.chain).sort((a, b) => b.rev - a.rev).map(x => x.key);
  const mtx = {};
  agg(rs, r => r.brand + '§' + r.chain).forEach(x => mtx[x.key] = x);
  const maxCell = Math.max(...Object.values(mtx).map(x => x.rev), 1);

  let hm = `<div class="hm"><table class="hmt"><thead><tr><th class="rowh">ТМ / мережа</th>`;
  chains.forEach(c => hm += `<th>${esc(c)}</th>`);
  hm += `<th>Разом</th></tr></thead><tbody>`;
  byB.slice(0, 16).forEach(b => {
    hm += `<tr><td class="rowh" title="${esc(b.key)}">${esc(b.key)}</td>`;
    chains.forEach(c => {
      const cell = mtx[b.key + '§' + c];
      hm += `<td style="${cell ? heat(cell.rev, maxCell) : ''}" title="${cell ? esc(b.key + ' × ' + c) + ': ' + n0(cell.rev) + ' ₴, чиста ' + n1(cell.nm) + '%' : ''}">${cell ? money(cell.rev) : '<span style="color:#3A322A">·</span>'}</td>`;
    });
    hm += `<td style="font-weight:600">${money(b.rev)}</td></tr>`;
  });
  hm += `</tbody></table></div>`;

  host.innerHTML = `
    <div class="kpis">
      ${kpi('ТМ у портфелі', n0(byB.length))}
      ${kpi('Лідер', esc((byB[0] ? byB[0].key : '—').slice(0, 18)), '', byB[0] ? `<span class="d">${n1(byB[0].rev / (T.rev || 1) * 100)}% виручки</span>` : '')}
      ${kpi('Найвища валова', esc((byB.filter(x => x.cogs > 0).sort((a, b) => b.gm - a.gm)[0]?.key || '—').slice(0, 16)), '',
    `<span class="d">${n1(byB.filter(x => x.cogs > 0).sort((a, b) => b.gm - a.gm)[0]?.gm || 0)}%</span>`, 'pos')}
      ${kpi('Найнижча чиста', esc((byB.filter(x => x.cogs > 0).sort((a, b) => a.nm - b.nm)[0]?.key || '—').slice(0, 16)), '',
      `<span class="d">${n1(byB.filter(x => x.cogs > 0).sort((a, b) => a.nm - b.nm)[0]?.nm || 0)}%</span>`, 'neg')}
      ${kpi('Виручка на літр', n2(T.litres ? T.rev / T.litres : 0), '₴/л')}
    </div>
    <div class="grid g32" style="margin-top:12px">
      ${card('Динаміка ТМ по місяцях', canvas('cBrandArea', 'h320'), 'частка виручки')}
      ${card('Позиція ТМ', canvas('cBrandPos', 'h320'), 'обсяг · маржа · виручка')}
    </div>
    <div style="margin-top:12px">
      ${card('ТМ × мережа: виручка', hm, 'інтенсивність кольору = обсяг виручки')}
    </div>
    <div style="margin-top:12px">
      ${card('Бренди: повний зріз', dataTable('tBr', cols, data, { sort: 'rev' }))}
    </div>`;

  const topB = byB.slice(0, 8).map(x => x.key);
  const revBy = seriesBy(rs, r => r.brand, r => r.rev);
  const series = topB.map((b, i) => {
    const mm = revBy.get(b) || new Map();
    return {
      label: b,
      data: months.map(m => mm.get(m) || 0),
      backgroundColor: colorFor(i), borderColor: colorFor(i), fill: true, tension: .25, pointRadius: 0
    };
  });
  chart('cBrandArea', {
    type: 'line',
    data: { labels: months.map(ymLabel), datasets: series },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: AX.x, y: { stacked: true, grid: { color: '#221D18' }, ticks: { callback: v => money(v) } } },
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 10 } } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${n0(c.parsed.y)} ₴` } }
      },
      elements: { line: { borderWidth: 1 } }
    }
  });

  const maxR = Math.max(...byB.map(x => x.rev), 1);
  chart('cBrandPos', {
    type: 'bubble',
    data: {
      datasets: byB.filter(x => x.cogs > 0).slice(0, 14).map((x, i) => ({
        label: x.key,
        data: [{ x: x.qty, y: x.gm, r: 5 + Math.sqrt(x.rev / maxR) * 22 }],
        backgroundColor: colorFor(i) + '66', borderColor: colorFor(i), borderWidth: 1.5
      }))
    },
    options: {
      scales: {
        x: { type: 'logarithmic', grid: { color: '#221D18' }, ticks: { callback: v => money(v) }, title: { display: true, text: 'обсяг, од (лог)' } },
        y: { grid: { color: '#221D18' }, ticks: { callback: v => v + '%' }, title: { display: true, text: 'валова маржа, %' } }
      },
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 9.5 }, boxWidth: 8 } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${n0(c.parsed.x)} од · ${n1(c.parsed.y)}%` } }
      }
    }
  });
  bindTables();
}

/* =====================================================================
   04 · SKU (ABC-XYZ)
   ===================================================================== */

function skuMatrix(rs) {
  const T = totals(rs);
  const byS = agg(rs, r => r.sku).sort((a, b) => b.rev - a.rev);
  const months = uniq(rs.map(r => r.ym)).sort();

  const qtyBy = seriesBy(rs, r => r.sku, r => r.qty);
  const brandBy = new Map();
  for (const r of rs) if (!brandBy.has(r.sku)) brandBy.set(r.sku, r.brand);

  let cum = 0;
  return byS.map(x => {
    cum += x.rev;
    const cumShare = T.rev ? cum / T.rev * 100 : 0;
    const abc = cumShare <= 80 ? 'A' : cumShare <= 95 ? 'B' : 'C';

    const mm = qtyBy.get(x.key) || new Map();
    const series = months.map(m => mm.get(m) || 0);
    const mu = mean(series), sd = stdev(series);
    const cv = mu ? sd / mu * 100 : 0;
    const xyz = cv < 25 ? 'X' : cv < 60 ? 'Y' : 'Z';

    const c = APP.d.cost[x.key];
    return {
      sku: x.key, brand: brandBy.get(x.key) || '',
      rev: x.rev, share: T.rev ? x.rev / T.rev * 100 : 0, cumShare,
      qty: x.qty, litres: x.litres, price: x.price,
      unitCost: c ? c.unit : null,
      unitGross: c ? x.price - c.unit : null,
      gm: x.gm, nm: x.nm, net: x.net,
      abc, xyz, cv, nMonths: x.nMonths, nPartners: x.nPartners,
      series
    };
  });
}

function viewSku(host) {
  const rs = rows();
  const data = skuMatrix(rs);
  const T = totals(rs);
  const cnt = k => data.filter(d => d.abc + d.xyz === k).length;

  const cols = [
    { k: 'sku', t: 'Номенклатура', txt: true },
    { k: 'brand', t: 'ТМ', txt: true, f: v => `<span class="tag">${esc(v)}</span>` },
    {
      k: 'abc', t: 'ABC', f: (v, r) => `<span class="tag ${v === 'A' ? 'a' : v === 'B' ? 'b' : 'c'}">${v}${r.xyz}</span>`,
      title: 'ABC — внесок у виручку, XYZ — стабільність попиту'
    },
    { k: 'rev', t: 'Виручка, ₴', f: v => n0(v) },
    { k: 'share', t: 'Частка', f: v => n1(v) + '%' },
    { k: 'qty', t: 'Обсяг, од', f: v => n0(v) },
    { k: 'price', t: 'Ціна/од, ₴', f: v => n2(v) },
    { k: 'unitCost', t: 'Собів./од, ₴', f: v => v === null ? '<span class="down">нема</span>' : n2(v) },
    { k: 'unitGross', t: 'Маржа/од, ₴', f: v => v === null ? '—' : `<span class="${v > 0 ? 'up' : 'down'}">${n2(v)}</span>` },
    { k: 'gm', t: 'Валова, %', f: v => n1(v) },
    { k: 'nm', t: 'Чиста, %', f: v => `<span class="${v > 0 ? 'up' : 'down'}">${n1(v)}</span>` },
    { k: 'net', t: 'Внесок, ₴', f: v => n0(v) },
    { k: 'cv', t: 'Варіація', f: v => n0(v) + '%', title: 'Коефіцієнт варіації місячних обсягів' },
    { k: 'nPartners', t: 'Клієнтів', f: v => n0(v) }
  ];

  /* матриця ABC×XYZ */
  const grid = ['A', 'B', 'C'].map(a => ['X', 'Y', 'Z'].map(x => {
    const items = data.filter(d => d.abc === a && d.xyz === x);
    return { a, x, n: items.length, rev: sum(items, i => i.rev) };
  }));
  const maxG = Math.max(...grid.flat().map(g => g.rev), 1);
  let gh = `<table class="hmt" style="width:100%"><thead><tr><th class="rowh"></th><th>X · стабільні</th><th>Y · змінні</th><th>Z · епізодичні</th></tr></thead><tbody>`;
  ['A', 'B', 'C'].forEach((a, i) => {
    const lab = { A: 'A · 80% виручки', B: 'B · наступні 15%', C: 'C · останні 5%' }[a];
    gh += `<tr><td class="rowh">${lab}</td>`;
    grid[i].forEach(g => {
      gh += `<td style="${heat(g.rev, maxG)};text-align:center">
        <div style="font-size:15px">${g.n}</div>
        <div style="font-size:9.5px;color:var(--dim)">${money(g.rev)} ₴</div></td>`;
    });
    gh += `</tr>`;
  });
  gh += `</tbody></table>
    <div class="note" style="padding:10px">
      <b>AX</b> — ядро асортименту, тримати запас і не ставити в глибоке промо.
      <b>AZ</b> — великий оборот при рваному попиті: перевірити, чи це не наслідок промо-піків.
      <b>CZ</b> (${cnt('CZ')} поз.) — кандидати на виведення або перехід у виробництво під замовлення.
    </div>`;

  const losers = data.filter(d => d.net < 0).sort((a, b) => a.net - b.net);

  host.innerHTML = `
    <div class="kpis">
      ${kpi('SKU у періоді', n0(data.length))}
      ${kpi('Група A', n0(data.filter(d => d.abc === 'A').length), 'SKU', `<span class="d">80% виручки</span>`)}
      ${kpi('Хвіст C', n0(data.filter(d => d.abc === 'C').length), 'SKU',
    `<span class="d">${n1(sum(data.filter(d => d.abc === 'C'), d => d.rev) / (T.rev || 1) * 100)}% виручки</span>`)}
      ${kpi('Збиткових SKU', n0(losers.length), '', losers.length ? `<span class="d down">${money(sum(losers, l => l.net))} ₴</span>` : '', losers.length ? 'neg' : 'pos')}
      ${kpi('Без собівартості', n0(data.filter(d => d.unitCost === null).length), 'SKU', '', data.some(d => d.unitCost === null) ? 'neg' : '')}
    </div>
    <div class="grid g23" style="margin-top:12px">
      ${card('Матриця ABC × XYZ', gh, 'кількість SKU та їхня виручка')}
      ${card('Карта портфеля', canvas('cSkuMap', 'h340'),
      'вісь X — обсяг, Y — чиста маржа, розмір — виручка')}
    </div>
    ${losers.length ? `<div style="margin-top:12px">${card('SKU, що з\'їдають маржу',
        dataTable('tLose', [
          { k: 'sku', t: 'Номенклатура', txt: true },
          { k: 'rev', t: 'Виручка, ₴', f: v => n0(v) },
          { k: 'price', t: 'Ціна/од', f: v => n2(v) },
          { k: 'unitCost', t: 'Собів./од', f: v => v === null ? '—' : n2(v) },
          { k: 'gm', t: 'Валова, %', f: v => n1(v) },
          { k: 'nm', t: 'Чиста, %', f: v => `<span class="down">${n1(v)}</span>` },
          { k: 'net', t: 'Втрата, ₴', f: v => `<span class="down">${n0(v)}</span>` }
        ], losers, { sort: 'net', limit: 40 }),
        'чистий внесок після бонусів мереж — від\'ємний')}</div>` : ''}
    <div style="margin-top:12px">
      ${card('SKU: повний зріз', dataTable('tSku', cols, data, { sort: 'rev' }))}
    </div>`;

  const maxR = Math.max(...data.map(d => d.rev), 1);
  const grp = { A: [], B: [], C: [] };
  data.filter(d => d.unitCost !== null).forEach(d => grp[d.abc].push({
    x: Math.max(d.qty, 1), y: d.nm, r: 3 + Math.sqrt(d.rev / maxR) * 20, l: d.sku, rev: d.rev
  }));
  chart('cSkuMap', {
    type: 'bubble',
    data: {
      datasets: [
        { label: 'A', data: grp.A, backgroundColor: 'rgba(134,184,96,.35)', borderColor: '#86B860', borderWidth: 1 },
        { label: 'B', data: grp.B, backgroundColor: 'rgba(232,163,61,.3)', borderColor: '#E8A33D', borderWidth: 1 },
        { label: 'C', data: grp.C, backgroundColor: 'rgba(155,143,131,.22)', borderColor: '#6E655B', borderWidth: 1 }
      ]
    },
    options: {
      scales: {
        x: { type: 'logarithmic', grid: { color: '#221D18' }, ticks: { callback: v => money(v) }, title: { display: true, text: 'обсяг, од (лог)' } },
        y: { grid: { color: '#221D18' }, ticks: { callback: v => v + '%' }, title: { display: true, text: 'чиста маржа, %' } }
      },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: { callbacks: { label: c => [c.raw.l, `${n0(c.raw.x)} од · ${n1(c.raw.y)}%`, `${n0(c.raw.rev)} ₴`] } }
      }
    }
  });
  bindTables();
}

/* =====================================================================
   05 · ЕКОНОМІКА SKU
   ===================================================================== */

function finRateOf(chainKey) {
  const t = APP.d.termsMap[chainKey];
  const d = t ? (+t.delayDays || 0) : 0;
  return d / 365 * (APP.cfg.moneyRate / 100);
}
function bonusOf(chainKey) {
  const t = APP.d.termsMap[chainKey];
  return t ? (+t.totalBonus || 0) / 100 : 0;
}

/** Гранична глибина знижки, за якої чистий внесок = 0 */
function breakEven(price, cost, chainKey) {
  if (!price || cost === null) return null;
  const k = 1 - bonusOf(chainKey) - finRateOf(chainKey) - APP.cfg.logistics / 100;
  if (k <= 0) return null;
  const dUs = 1 - cost / (price * k);          // знижка від нашої ціни
  const share = Math.max(1, APP.cfg.promoShare) / 100;
  return { us: dUs * 100, shelf: dUs / share * 100, k };
}

function viewEcon(host) {
  const rs = rows();
  const chains = APP.d.chains.filter(c => c !== CHAIN_OTHER);
  const selChain = APP.econChain && chains.includes(APP.econChain) ? APP.econChain : (chains[0] || CHAIN_OTHER);
  const chRows = rs.filter(r => r.chain === selChain);

  const byS = agg(chRows, r => r.sku).sort((a, b) => b.rev - a.rev);

  /* найглибше заплановане промо по SKU в цій мережі */
  const planned = {};
  Object.values(APP.d.promoWeekCell || {}).forEach(c => {
    if (c.chain !== selChain || !c.sku || c.depth === null) return;
    if (!planned[c.sku] || c.depth > planned[c.sku]) planned[c.sku] = c.depth;
  });

  const data = byS.map(x => {
    const c = APP.d.cost[x.key];
    const be = c ? breakEven(x.price, c.unit, selChain) : null;
    const plan = planned[x.key] ?? null;
    return {
      sku: x.key, rev: x.rev, qty: x.qty, price: x.price,
      cost: c ? c.unit : null, mat: c ? c.mat : null, wage: c ? c.wage : null, extra: c ? c.extra : null,
      unitGross: c ? x.price - c.unit : null,
      gm: x.gm, nm: x.nm,
      be: be ? be.shelf : null,
      plan,
      gap: (be && plan !== null) ? be.shelf - plan : null
    };
  });

  const risky = data.filter(d => d.gap !== null && d.gap < 0).sort((a, b) => a.gap - b.gap);
  const t = APP.d.termsMap[selChain];

  const cols = [
    { k: 'sku', t: 'Номенклатура', txt: true },
    { k: 'qty', t: 'Обсяг, од', f: v => n0(v) },
    { k: 'price', t: 'Ціна/од, ₴', f: v => n2(v) },
    { k: 'cost', t: 'Собів./од, ₴', f: v => v === null ? '—' : n2(v) },
    { k: 'unitGross', t: 'Валова/од, ₴', f: v => v === null ? '—' : `<span class="${v > 0 ? 'up' : 'down'}">${n2(v)}</span>` },
    { k: 'gm', t: 'Валова, %', f: v => n1(v) },
    { k: 'nm', t: 'Чиста, %', f: v => `<span class="${v > 0 ? 'up' : 'down'}">${n1(v)}</span>` },
    {
      k: 'be', t: 'Гранична знижка', f: v => v === null ? '—' : `<b>${n1(v)}%</b>`,
      title: 'Глибина полиці, за якої чистий внесок дорівнює нулю'
    },
    { k: 'plan', t: 'План промо', f: v => v === null ? '—' : n0(v) + '%' },
    {
      k: 'gap', t: 'Запас', f: v => v === null ? '—' :
        `<span class="${v >= 0 ? 'up' : 'down'}">${v > 0 ? '+' : ''}${n1(v)} п.п.</span>`
    }
  ];

  const assumptions = `
    <div class="grid g2" style="gap:10px">
      <div class="field"><label>Виручка у джерелі</label>
        <select id="aVat">
          <option value="0" ${!APP.cfg.vatIncluded ? 'selected' : ''}>без ПДВ</option>
          <option value="1" ${APP.cfg.vatIncluded ? 'selected' : ''}>з ПДВ (${APP.cfg.vatRate}%)</option>
        </select></div>
      <div class="field"><label>Вартість грошей, % річних</label>
        <input type="number" id="aRate" value="${APP.cfg.moneyRate}" min="0" max="100" step="1"></div>
      <div class="field"><label>Частка знижки, яку фінансує виробник, %</label>
        <input type="number" id="aShare" value="${APP.cfg.promoShare}" min="1" max="100" step="5"></div>
      <div class="field"><label>Логістика та інше, % від виручки</label>
        <input type="number" id="aLog" value="${APP.cfg.logistics}" min="0" max="30" step="0.5"></div>
    </div>
    <div class="note">Ці припущення впливають на чисту маржу, граничну знижку та ROI промо в усіх розділах.
    Собівартість береться з аркуша «Собівартість» як сума матеріалів, відрядної оплати та додаткових витрат на одиницю.</div>`;

  const termCard = t ? `<dl class="kv">
      <dt>Ретро-бонус</dt><dd>${n1(+t.retro)}%</dd>
      <dt>Маркетинговий бюджет</dt><dd>${n1(+t.mb)}%</dd>
      <dt>Компенсація</dt><dd>${n1(+t.compensation)}%</dd>
      <dt>Логістичний бонус</dt><dd>${n1(+t.lb)}%</dd>
      <dt>Додатковий бюджет</dt><dd>${n1(+t.extraBudget)}%</dd>
      <dt style="color:var(--ink)">Разом бонуси</dt><dd style="color:var(--amber)">${n1(+t.totalBonus)}%</dd>
      <dt>Відтермінування</dt><dd>${n0(+t.delayDays)} дн</dd>
      <dt>Вартість відтермінування</dt><dd>${n2(finRateOf(selChain) * 100)}%</dd>
      <dt style="color:var(--ink)">Разом навантаження</dt><dd style="color:var(--chili)">${n1((bonusOf(selChain) + finRateOf(selChain) + APP.cfg.logistics / 100) * 100)}%</dd>
    </dl>` : `<div class="warnbox">Для мережі «${esc(selChain)}» умови не заповнені — розрахунок веде себе так, наче бонусів немає, тож маржа завищена.</div>`;

  host.innerHTML = `
    <div class="split" style="margin-bottom:12px">
      <span class="pill">Мережа для розрахунку</span>
      <select id="econChain">${chains.concat([CHAIN_OTHER]).map(c =>
    `<option ${c === selChain ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <span class="pill">${n0(byS.length)} SKU · ${money(sum(chRows, r => r.rev))} ₴</span>
    </div>
    <div class="grid g3">
      ${card('Умови мережі', termCard, esc(selChain))}
      ${card('Припущення розрахунку', assumptions)}
      ${card('Скільки витримує полиця', canvas('cBE', 'h260'), 'гранична знижка проти планової')}
    </div>
    ${risky.length ? `<div style="margin-top:12px">${card('Промо, що не окупається',
      `<div class="warnbox" style="margin:12px 12px 0">${risky.length} позицій заплановані глибше за граничну знижку.
        На цих механіках чистий внесок стає від'ємним ще до врахування логістики промо-обсягів.</div>` +
      dataTable('tRisk', [
        { k: 'sku', t: 'Номенклатура', txt: true },
        { k: 'price', t: 'Ціна/од, ₴', f: v => n2(v) },
        { k: 'cost', t: 'Собів./од, ₴', f: v => n2(v) },
        { k: 'be', t: 'Гранична', f: v => n1(v) + '%' },
        { k: 'plan', t: 'Планова', f: v => `<span class="down">${n0(v)}%</span>` },
        { k: 'gap', t: 'Перебір', f: v => `<span class="down">${n1(Math.abs(v))} п.п.</span>` },
        { k: 'qty', t: 'Обсяг, од', f: v => n0(v) }
      ], risky, { sort: 'gap', limit: 40 }), 'ризик за обраною мережею')}</div>` : ''}
    <div style="margin-top:12px">
      ${card('Юніт-економіка по SKU', dataTable('tEcon', cols, data, { sort: 'rev' }), esc(selChain))}
    </div>`;

  el('econChain').onchange = e => { APP.econChain = e.target.value; render(); };
  el('aVat').onchange = e => { APP.cfg.vatIncluded = e.target.value === '1'; saveCfg(); build(); render(); };
  ['aRate', 'aShare', 'aLog'].forEach(id => {
    el(id).onchange = e => {
      const v = parseFloat(e.target.value) || 0;
      if (id === 'aRate') APP.cfg.moneyRate = v;
      if (id === 'aShare') APP.cfg.promoShare = Math.max(1, v);
      if (id === 'aLog') APP.cfg.logistics = v;
      saveCfg(); build(); render();
    };
  });

  const top = data.filter(d => d.be !== null).sort((a, b) => b.rev - a.rev).slice(0, 14);
  chart('cBE', {
    type: 'bar',
    data: {
      labels: top.map(d => d.sku.length > 24 ? d.sku.slice(0, 23) + '…' : d.sku),
      datasets: [
        { label: 'Гранична знижка', data: top.map(d => d.be), backgroundColor: '#86B860', borderRadius: 1 },
        { label: 'Планова глибина', data: top.map(d => d.plan ?? 0), backgroundColor: '#D9563F', borderRadius: 1 }
      ]
    },
    options: {
      indexAxis: 'y',
      scales: { x: AX.yPct, y: { grid: { display: false }, ticks: { font: { size: 9 } } } },
      plugins: { tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${n1(c.parsed.x)}%` } } }
    }
  });
  bindTables();
}

/* =====================================================================
   06 · УМОВИ МЕРЕЖ
   ===================================================================== */

function viewChains(host) {
  const rs = rows();
  const byC = agg(rs, r => r.chain).sort((a, b) => b.rev - a.rev);

  const data = byC.map(x => {
    const t = APP.d.termsMap[x.key];
    const fin = finRateOf(x.key);
    return {
      chain: x.key,
      retro: t ? +t.retro : null, mb: t ? +t.mb : null, comp: t ? +t.compensation : null,
      lb: t ? +t.lb : null, extra: t ? +t.extraBudget : null,
      bonus: t ? +t.totalBonus : 0, delay: t ? +t.delayDays : 0,
      finPct: fin * 100, load: (t ? +t.totalBonus : 0) + fin * 100,
      status: t ? t.status : 'немає в довіднику',
      rev: x.rev, qty: x.qty, gross: x.gross, gm: x.gm, net: x.net, nm: x.nm,
      bonusUah: x.rev * (t ? +t.totalBonus : 0) / 100,
      finUah: x.rev * fin,
      wc: x.rev * (t ? +t.delayDays : 0) / 365,
      perPoint: x.rev / 100
    };
  });

  const cols = [
    { k: 'chain', t: 'Мережа', txt: true },
    { k: 'rev', t: 'Виручка, ₴', f: v => n0(v) },
    { k: 'retro', t: 'Ретро', f: v => v === null ? '—' : n1(v) + '%' },
    { k: 'mb', t: 'МБ', f: v => v === null ? '—' : n1(v) + '%' },
    { k: 'comp', t: 'Компенс.', f: v => v === null ? '—' : n1(v) + '%' },
    { k: 'lb', t: 'ЛБ', f: v => v === null ? '—' : n1(v) + '%' },
    { k: 'extra', t: 'Дод.', f: v => v === null ? '—' : n1(v) + '%' },
    { k: 'bonus', t: 'Разом бонуси', f: v => `<b>${n1(v)}%</b>` },
    { k: 'delay', t: 'Відтерм., дн', f: v => n0(v) },
    { k: 'finPct', t: 'Ціна грошей', f: v => n2(v) + '%' },
    { k: 'load', t: 'Навантаження', f: v => `<span class="${v > 30 ? 'down' : ''}">${n1(v)}%</span>` },
    { k: 'gm', t: 'Валова, %', f: v => n1(v) },
    { k: 'nm', t: 'Чиста, %', f: v => `<span class="${v > 0 ? 'up' : 'down'}">${n1(v)}</span>` },
    { k: 'bonusUah', t: 'Бонуси, ₴', f: v => n0(v) },
    { k: 'wc', t: 'Заморожено, ₴', f: v => n0(v), title: 'Середній залишок дебіторки при цьому обороті' },
    { k: 'perPoint', t: '1 п.п. ретро, ₴', f: v => n0(v) }
  ];

  const T = totals(rs);
  const totalBonus = sum(data, d => d.bonusUah);
  const totalWc = sum(data, d => d.wc);

  host.innerHTML = `
    <div class="kpis">
      ${kpi('Бонуси мереж', money(totalBonus), '₴', `<span class="d">${n1(totalBonus / (T.rev || 1) * 100)}% виручки</span>`, 'neg')}
      ${kpi('Заморожено в дебіторці', money(totalWc), '₴', `<span class="d">середній залишок</span>`)}
      ${kpi('Вартість відтермінування', money(sum(data, d => d.finUah)), '₴', `<span class="d">${APP.cfg.moneyRate}% річних</span>`)}
      ${kpi('Найважча мережа', esc((data.slice().sort((a, b) => b.load - a.load)[0]?.chain || '—').slice(0, 16)), '',
    `<span class="d">${n1(data.slice().sort((a, b) => b.load - a.load)[0]?.load || 0)}% навантаження</span>`, 'neg')}
      ${kpi('Мереж без умов', n0(data.filter(d => d.retro === null).length), '', '', data.some(d => d.retro === null) ? 'neg' : 'pos')}
    </div>
    <div class="grid g2" style="margin-top:12px">
      ${card('Структура бонусного навантаження', canvas('cBonus', 'h320'), '% від виручки')}
      ${card('Що залишається виробнику', canvas('cChainNet', 'h320'), 'валова → чиста маржа')}
    </div>
    <div style="margin-top:12px">
      ${card('Умови та їхня ціна', dataTable('tChains', cols, data, { sort: 'rev' }),
      'колонка «1 п.п. ретро» — скільки коштує кожен відсоток у переговорах')}
    </div>
    <div style="margin-top:12px">
      ${card('Як читати', `<div class="note">
        <b>Навантаження</b> — сума всіх бонусів плюс вартість відтермінування за поточної ставки ${APP.cfg.moneyRate}% річних.
        Це те, що мережа фактично забирає з кожної гривні відвантаження, ще до промо-знижок.<br><br>
        <b>1 п.п. ретро</b> — скільки коштує один відсотковий пункт при поточному обороті. Це орієнтир для торгу:
        якщо мережа просить +2 п.п. ретро в обмін на розширення матриці, приріст обороту має перекрити цю суму.<br><br>
        <b>Заморожено</b> — середній залишок дебіторки за формулою оборот × дні / 365. Це робочий капітал,
        який не працює, і саме він робить довгі відтермінування дорожчими, ніж здається.
      </div>`)}
    </div>`;

  const D = data.filter(d => d.retro !== null);
  chart('cBonus', {
    type: 'bar',
    data: {
      labels: D.map(d => d.chain),
      datasets: [
        { label: 'Ретро', data: D.map(d => d.retro), backgroundColor: '#E8A33D' },
        { label: 'Маркетинговий бюджет', data: D.map(d => d.mb), backgroundColor: '#6F8FD0' },
        { label: 'Компенсація', data: D.map(d => d.comp), backgroundColor: '#86B860' },
        { label: 'Логістичний бонус', data: D.map(d => d.lb), backgroundColor: '#B07AB4' },
        { label: 'Додатковий бюджет', data: D.map(d => d.extra), backgroundColor: '#55A99B' },
        { label: 'Ціна відтермінування', data: D.map(d => d.finPct), backgroundColor: '#D9563F' }
      ]
    },
    options: {
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { font: { size: 9.5 }, maxRotation: 45, minRotation: 45 } },
        y: { stacked: true, grid: { color: '#221D18' }, ticks: { callback: v => v + '%' } }
      },
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 10 } } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${n1(c.parsed.y)}%` } }
      }
    }
  });

  const D2 = data.filter(d => d.rev > 0).slice(0, 12);
  chart('cChainNet', {
    type: 'bar',
    data: {
      labels: D2.map(d => d.chain),
      datasets: [
        { label: 'Валова маржа, %', data: D2.map(d => d.gm), backgroundColor: '#6F8FD0', borderRadius: 1 },
        { label: 'Чиста маржа, %', data: D2.map(d => d.nm), backgroundColor: '#E8A33D', borderRadius: 1 }
      ]
    },
    options: {
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 9.5 }, maxRotation: 45, minRotation: 45 } },
        y: AX.yPct
      },
      plugins: { tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${n1(c.parsed.y)}%` } } }
    }
  });
  bindTables();
}

/* =====================================================================
   07 · ПРОМО-КАЛЕНДАР  (сигнатурний блок)
   ===================================================================== */

function promoSheets() { return uniq(APP.d.promo.map(p => p.sheet)).sort(); }

function viewPromoPlan(host) {
  const P = APP.d.promo;
  if (!P.length) {
    host.innerHTML = card('Промо-календар', `<div class="empty">
      <b>Промо-план не завантажено</b>
      Бекенд не повернув жодного рядка з таблиці «ПРОМО ПЛАН».
      Перевірте діагностику парсера в розділі «Дані та якість».</div>`);
    return;
  }

  // \b не спрацьовує на кирилиці, тому межу слова описуємо явно
  const HEADERISH = /^(наименование|наименовани|назва|номенклатура|код товара|код товару|артикул|штрих|товар|итого|разом|всього|прогноз|план|ціна|цена|механ|мережа|бренд)(\s|$|[:.,()])/i;

  /* скільки рядків має кожен аркуш — щоб порожні не стояли першими */
  const sheetStat = {};
  P.forEach(p => {
    if (!p.sheet) return;
    const a = sheetStat[p.sheet] || (sheetStat[p.sheet] = { n: 0, years: {} });
    a.n++;
    if (p.week) { const y = p.week.slice(0, 4); a.years[y] = (a.years[y] || 0) + 1; }
  });
  const sheets = Object.keys(sheetStat).sort((a, b) => sheetStat[b].n - sheetStat[a].n);
  const sel = sheets.includes(APP.promoSheet) ? APP.promoSheet : sheets[0];

  /* роки — тільки ті, що реально є в цьому аркуші; за замовчуванням найнаповненіший */
  const yStat = sheetStat[sel].years;
  const years = Object.keys(yStat).sort();
  const yr = years.includes(APP.promoYear) ? APP.promoYear
    : years.slice().sort((a, b) => yStat[b] - yStat[a])[0];

  const rowsAll = P.filter(p => p.sheet === sel && p.week && p.week.slice(0, 4) === yr
    && p.promoSku && !HEADERISH.test(p.promoSku));

  /* ТМ, наявні в цьому аркуші */
  const brandOfSku = new Map();
  rowsAll.forEach(p => { if (!brandOfSku.has(p.promoSku)) brandOfSku.set(p.promoSku, brandOfPromo(p)); });
  const brandList = uniq(Array.from(brandOfSku.values())).sort((a, b) => a.localeCompare(b, 'uk'));
  const selBrand = brandList.includes(APP.promoBrand) ? APP.promoBrand : '';

  const rowsP = selBrand ? rowsAll.filter(p => brandOfSku.get(p.promoSku) === selBrand) : rowsAll;
  const weeks = uniq(rowsAll.map(p => p.week)).sort();

  if (!weeks.length) {
    host.innerHTML = `
      <div class="split" style="margin-bottom:12px">
        <span class="pill">Мережа</span>
        <select id="pSheet">${sheets.map(x =>
      `<option ${x === sel ? 'selected' : ''}>${esc(x)} · ${n0(sheetStat[x].n)}</option>`).join('')}</select>
      </div>` +
      card('Промо-календар', `<div class="empty">
        <b>У цьому аркуші немає тижнів</b>
        Парсер не знайшов рядка з датами тижнів на аркуші «${esc(sel)}».
        Подивіться діагностику в розділі «Дані та якість» — там видно, який рядок узято за шапку.</div>`);
    el('pSheet').onchange = e => {
      APP.promoSheet = e.target.value.split(' · ')[0]; APP.promoYear = null; render();
    };
    return;
  }

  /* SKU у порядку виручки */
  const revBySku = {};
  agg(APP.d.sales.filter(r => r.chain === chainOfSheet(sel)), r => r.sku)
    .forEach(x => revBySku[x.key] = x.rev);
  const firstOf = new Map();
  rowsP.forEach(p => { if (!firstOf.has(p.promoSku)) firstOf.set(p.promoSku, p); });

  /* сортуємо ТМ за виручкою, всередині ТМ — SKU за виручкою */
  const revOfBrand = {};
  Array.from(firstOf.keys()).forEach(k => {
    const b = brandOfSku.get(k) || 'Інше';
    revOfBrand[b] = (revOfBrand[b] || 0) + (revBySku[firstOf.get(k).sku] || 0);
  });
  const skus = Array.from(firstOf.keys()).sort((a, b) => {
    const ba = brandOfSku.get(a) || 'Інше', bb = brandOfSku.get(b) || 'Інше';
    if (ba !== bb) {
      const d = (revOfBrand[bb] || 0) - (revOfBrand[ba] || 0);
      return d || ba.localeCompare(bb, 'uk');
    }
    return (revBySku[firstOf.get(b).sku] || 0) - (revBySku[firstOf.get(a).sku] || 0);
  });

  /* карта комірок: одна клітинка = SKU × тиждень, зібрана з усіх під-рядків */
  const cell = {};
  rowsP.forEach(p => {
    const k = p.promoSku + '|' + p.week;
    const c = cell[k] || (cell[k] = {
      depth: null, plan: 0, start: false, promo: false, sku: p.sku,
      basePrice: 0, promoPrice: null, label: '', terms: '', notes: []
    });
    if (p.basePrice && !c.basePrice) c.basePrice = p.basePrice;

    if (p.metric === 'name') {
      c.promo = true;
      if (p.text && !c.label) c.label = p.text;
      if (p.depth !== null) c.depth = Math.max(c.depth ?? 0, p.depth);
    } else if (p.metric === 'terms') {
      c.promo = true;
      if (p.text) c.terms = p.text;
      if (p.depth !== null) c.depth = Math.max(c.depth ?? 0, p.depth);
    } else if (p.metric === 'price') {
      c.promo = true;
      if (p.value > 0) c.promoPrice = p.value;
    } else if (p.metric === 'plan') {
      c.plan += p.value || 0;
    } else if (p.metric === 'start') {
      c.start = true;
      if (p.text) c.notes.push('старт відвантажень: ' + p.text);
    } else if (p.text) {
      c.notes.push(p.text);
    }
  });

  /* глибина з цін, якщо умови порожні */
  Object.values(cell).forEach(c => {
    if (c.depth === null && c.basePrice > 0 && c.promoPrice > 0 && c.promoPrice < c.basePrice) {
      c.depth = Math.round((1 - c.promoPrice / c.basePrice) * 1000) / 10;
      c.derived = true;
    }
    if (!c.label && c.terms) c.label = c.terms;
    if (!c.label && c.promo) c.label = 'промо';
  });

  /* заголовки з групуванням по місяцях */
  let monHdr = '<tr><th class="sku" rowspan="2">Номенклатура</th>';
  let wkHdr = '<tr>';
  let curM = '', span = 0, buf = [];
  weeks.forEach((w, i) => {
    const m = w.slice(0, 7);
    if (m !== curM) { if (curM) buf.push([curM, span]); curM = m; span = 1; }
    else span++;
    if (i === weeks.length - 1) buf.push([curM, span]);
  });
  buf.forEach(([m, sp]) => monHdr += `<th class="mon" colspan="${sp}">${MONTH_SH[+m.slice(5)]}</th>`);
  monHdr += '</tr>';
  let prevM = '';
  weeks.forEach(w => {
    const m1 = w.slice(0, 7) !== prevM; prevM = w.slice(0, 7);
    wkHdr += `<th class="wk ${m1 ? 'm1' : ''}" title="${w}">${w.slice(8, 10)}</th>`;
  });
  wkHdr += '</tr>';

  const ribbon = APP.promoMode !== 'grid';
  const depthClass = d => d === null ? 'd2' : d < 15 ? 'd1' : d < 22 ? 'd2' : d < 28 ? 'd3' : d < 35 ? 'd4' : 'd5';

  /* акції = послідовні тижні з однаковою механікою */
  const events = [];
  skus.forEach(s => {
    let run = null;
    weeks.forEach((w, i) => {
      const c = cell[s + '|' + w];
      const on = c && c.promo;
      const label = on ? (c.label || 'СЦ') : null;
      if (on && run && run.label === label && run.end === i - 1) {
        run.end = i; run.weeks++;
        if (c.depth !== null && (run.depth === null || c.depth > run.depth)) { run.depth = c.depth; run.derived = !!c.derived; }
        if (c.start) run.start = true;
        if (c.terms && !run.terms) run.terms = c.terms;
        if (c.promoPrice && !run.promoPrice) run.promoPrice = c.promoPrice;
        run.plan += c.plan || 0;
      } else {
        if (run) events.push(run);
        run = on ? {
          sku: s, brand: brandOfSku.get(s) || 'Інше',
          matched: firstOf.get(s) && firstOf.get(s).sku,
          label, depth: c.depth, derived: !!c.derived, start: !!c.start,
          terms: c.terms || '', promoPrice: c.promoPrice || null, basePrice: c.basePrice || 0,
          plan: c.plan || 0,
          from: w, toWeek: w, begin: i, end: i, weeks: 1
        } : null;
      }
      if (run && on) run.toWeek = w;
      if (!on && run) { events.push(run); run = null; }
      if (i === weeks.length - 1 && run) { events.push(run); run = null; }
    });
  });
  const runIndex = {};
  events.forEach(e => { runIndex[e.sku + '|' + e.begin] = e; });

  const closed = APP.promoClosed || (APP.promoClosed = new Set());
  const colspanAll = weeks.length + 1;

  let body = '', prevBrand = null;
  skus.forEach(s => {
    const brand = brandOfSku.get(s) || 'Інше';
    if (brand !== prevBrand) {
      prevBrand = brand;
      const inBrand = skus.filter(x => (brandOfSku.get(x) || 'Інше') === brand);
      const ev = events.filter(e => (brandOfSku.get(e.sku) || 'Інше') === brand);
      const ds = ev.map(e => e.depth).filter(d => d !== null);
      const isClosed = closed.has(brand);
      body += `<tr class="grp" data-b="${esc(brand)}" title="Клік — згорнути або розгорнути">
        <td class="sku grp" colspan="${colspanAll}">
          <span class="fold">${isClosed ? '▸' : '▾'}</span>
          <b>${esc(brand)}</b>
          <span class="gs">${inBrand.length} SKU · ${ev.length} акцій${ds.length ? ' · сер. глибина ' + n1(mean(ds)) + '%' : ''}</span>
        </td></tr>`;
    }
    if (closed.has(brand)) return;

    const first = firstOf.get(s);
    const matched = first && first.sku;
    body += `<tr><td class="sku" title="${esc(s)}${matched ? '\n→ ' + esc(matched) : '\n(без пари у продажах)'}">${matched ? '' : '<span style="color:var(--chili)">◦ </span>'}${esc(s)}</td>`;
    prevM = '';
    for (let i = 0; i < weeks.length; i++) {
      const w = weeks[i];
      const m1 = w.slice(0, 7) !== prevM; prevM = w.slice(0, 7);
      const c = cell[s + '|' + w];
      const run = runIndex[s + '|' + i];

      if (ribbon && run) {
        const bits = [s, run.label];
        if (run.depth !== null) bits.push('глибина: ' + n1(run.depth) + '%' + (run.derived ? ' (з цін)' : ''));
        if (run.terms) bits.push('умови: ' + run.terms);
        if (run.promoPrice) bits.push('промо-ціна: ' + n2(run.promoPrice) + ' ₴' +
          (run.basePrice ? ' проти ' + n2(run.basePrice) : ''));
        if (run.plan) bits.push('план: ' + n0(run.plan) + ' од');
        bits.push(`${run.from} – ${run.toWeek} · ${run.weeks} тиж.`);
        const cap = run.depth !== null ? `${run.label} · −${n0(run.depth)}%` : run.label;
        body += `<td class="run ${depthClass(run.depth)}${run.start ? ' start' : ''}" colspan="${run.weeks}" title="${esc(bits.join('\n'))}">${esc(cap)}</td>`;
        for (let k = 1; k < run.weeks; k++) { prevM = weeks[i + k].slice(0, 7); }
        i += run.weeks - 1;
        continue;
      }
      if (ribbon && c && c.promo) continue;

      let cls = 'c' + (m1 ? ' m1' : '');
      let title = '';
      if (c) {
        if (c.promo) cls += ' ' + depthClass(c.depth);
        if (c.plan) cls += ' plan';
        if (c.start) cls += ' start';
        title = `${s}\n${w}\n${c.notes.join('\n')}`;
      }
      body += `<td class="${cls}" title="${esc(title)}"></td>`;
    }
    body += '</tr>';
  });

  const cal = `<div class="calwrap"><table class="cal${ribbon ? ' ribbon' : ''}">
    <thead>${monHdr}${wkHdr}</thead><tbody>${body}</tbody></table></div>`;

  /* метрики тиску */
  const cells = Object.values(cell);
  const promoCells = cells.filter(c => c.promo);
  const depths = promoCells.map(c => c.depth).filter(d => d !== null);
  const load = weeks.length && skus.length ? promoCells.length / (weeks.length * skus.length) * 100 : 0;
  const noDepth = promoCells.length - depths.length;
  const planTotal = sum(cells, c => c.plan);

  const perSku = skus.map(s => {
    const cs = weeks.map(w => cell[s + '|' + w]).filter(c => c && c.promo);
    const ds = cs.map(c => c.depth).filter(d => d !== null);
    const f = firstOf.get(s);
    return {
      sku: s, brand: brandOfSku.get(s) || 'Інше',
      matched: f && f.sku ? 'так' : 'ні',
      weeks: cs.length, share: weeks.length ? cs.length / weeks.length * 100 : 0,
      avgDepth: ds.length ? mean(ds) : null, maxDepth: ds.length ? Math.max(...ds) : null,
      plan: sum(weeks.map(w => cell[s + '|' + w]).filter(Boolean), c => c.plan),
      basePrice: (weeks.map(w => cell[s + '|' + w]).find(c => c && c.basePrice) || {}).basePrice || 0,
      rev: revBySku[f && f.sku] || 0
    };
  });

  /* тиждень за тижнем: скільки SKU в промо */
  const perWeek = weeks.map(w => ({
    w, n: skus.filter(s => cell[s + '|' + w] && cell[s + '|' + w].promo).length,
    d: mean(skus.map(s => cell[s + '|' + w]).filter(c => c && c.depth !== null).map(c => c.depth))
  }));

  host.innerHTML = `
    <div class="split" style="margin-bottom:12px">
      <span class="pill">Мережа</span>
      <select id="pSheet">${sheets.map(x =>
    `<option ${x === sel ? 'selected' : ''}>${esc(x)} · ${n0(sheetStat[x].n)}</option>`).join('')}</select>
      <span class="pill">Рік</span>
      <select id="pYear">${years.map(y =>
    `<option ${y === yr ? 'selected' : ''}>${y} · ${n0(yStat[y])}</option>`).join('')}</select>
      <span class="pill">ТМ</span>
      <select id="pBrand">
        <option value="">усі (${brandList.length})</option>
        ${brandList.map(b => `<option value="${esc(b)}" ${b === selBrand ? 'selected' : ''}>${esc(b)}</option>`).join('')}
      </select>
      <span class="pill">${skus.length} SKU · ${weeks.length} тижнів</span>
      <button class="btn sm ${ribbon ? 'primary' : ''}" id="pRibbon">Стрічка з назвами</button>
      <button class="btn sm ${ribbon ? '' : 'primary'}" id="pGrid">Щільна сітка</button>
      <button class="btn sm ghost" id="pFold">${APP.promoFolded ? 'Розгорнути ТМ' : 'Згорнути ТМ'}</button>
    </div>
    <div class="kpis">
      ${kpi('Промо-тиск', n1(load), '%', `<span class="d">${n0(promoCells.length)} з ${n0(weeks.length * skus.length)} клітинок</span>`, load > 40 ? 'neg' : '')}
      ${kpi('Середня глибина', depths.length ? n1(mean(depths)) : '—', '%',
    `<span class="d">макс ${depths.length ? n0(Math.max(...depths)) : '—'}%${noDepth ? ' · без глибини ' + n0(noDepth) : ''}</span>`,
    depths.length ? '' : 'neg')}
      ${kpi('SKU у промо', n0(perSku.filter(s => s.weeks).length), 'з ' + skus.length)}
      ${kpi('Плановий обсяг', money(planTotal), 'од', `<span class="d">за промо-планом</span>`)}
      ${kpi('Акцій у плані', n0(events.length), '', `<span class="d">сер. ${n1(events.length ? mean(events.map(e => e.weeks)) : 0)} тиж.</span>`)}
      ${kpi('Пік тижня', n0(Math.max(...perWeek.map(w => w.n), 0)), 'SKU одночасно')}
      ${kpi('Тижнів без промо', n0(perWeek.filter(w => !w.n).length), 'з ' + weeks.length, '',
    perWeek.filter(w => !w.n).length < weeks.length * 0.3 ? 'neg' : 'pos')}
    </div>
    <div style="margin-top:12px">
      ${card('Календар промо-активності', cal,
      `<span class="calscale">глибина:
        <i style="background:rgba(232,163,61,.28)"></i>&lt;15%
        <i style="background:rgba(232,163,61,.48)"></i>15–22
        <i style="background:rgba(232,163,61,.72)"></i>22–28
        <i style="background:#E8A33D"></i>28–35
        <i style="background:#D9563F"></i>&gt;35%
        · <i style="background:#1A1713;box-shadow:inset 2px 0 0 #86B860"></i>старт відвантажень
       </span>`)}
    </div>
    <div style="margin-top:12px">
      ${card('Зведення по торгових марках', (() => {
      const g = brandList.map(b => {
        const inB = skus.filter(x => (brandOfSku.get(x) || 'Інше') === b);
        const ev = events.filter(e => e.brand === b);
        const ds = ev.map(e => e.depth).filter(d => d !== null);
        const wk = uniq(ev.flatMap(e => {
          const out = [];
          for (let i = e.begin; i <= e.end; i++) out.push(i);
          return out;
        })).length;
        return {
          brand: b, skus: inB.length, events: ev.length,
          avgDepth: ds.length ? mean(ds) : null,
          maxDepth: ds.length ? Math.max(...ds) : null,
          weeks: wk, share: weeks.length ? wk / weeks.length * 100 : 0,
          plan: sum(perSku.filter(x => x.brand === b), x => x.plan)
        };
      }).filter(x => x.skus);
      return dataTable('tBrandSum', [
        { k: 'brand', t: 'ТМ', txt: true },
        { k: 'skus', t: 'SKU', f: v => n0(v) },
        { k: 'events', t: 'Акцій', f: v => n0(v) },
        { k: 'weeks', t: 'Тижнів з промо', f: v => n0(v) },
        { k: 'share', t: 'Частка року', f: v => `${n1(v)}%<span class="bar" style="width:${Math.min(100, v)}%"></span>` },
        { k: 'avgDepth', t: 'Сер. глибина', f: v => v === null ? '—' : n1(v) + '%' },
        { k: 'maxDepth', t: 'Макс', f: v => v === null ? '—' : n0(v) + '%' },
        { k: 'plan', t: 'План, од', f: v => v ? n0(v) : '—' }
      ], g, { sort: 'events' });
    })(), 'клік по рядку ТМ у календарі згортає групу')}
    </div>
    <div class="grid g2" style="margin-top:12px">
      ${card('Промо-тиск по тижнях', canvas('cWeek', 'h260'), 'кількість SKU та середня глибина')}
      ${card('Найбільш «промотовані» позиції', canvas('cSkuLoad', 'h260'), 'частка тижнів у промо')}
    </div>
    <div style="margin-top:12px">
      ${card('Перелік акцій', dataTable('tEvents', [
        { k: 'label', t: 'Механіка', txt: true },
        { k: 'brand', t: 'ТМ', txt: true, f: v => `<span class="tag">${esc(v)}</span>` },
        { k: 'sku', t: 'Номенклатура', txt: true },
        {
          k: 'depth', t: 'Глибина', f: (v, r) => v === null ? '—'
            : `<b>${n1(v)}%</b>${r.derived ? '<span class="tag x" style="margin-left:4px">з цін</span>' : ''}`,
          title: 'З рядка «условия», або порахована з базової та промо-ціни'
        },
        { k: 'terms', t: 'Умови', txt: true, f: v => v ? esc(v) : '—' },
        { k: 'basePrice', t: 'Базова ціна', f: v => v ? n2(v) : '—' },
        { k: 'promoPrice', t: 'Промо-ціна', f: v => v ? n2(v) : '—' },
        { k: 'plan', t: 'План, од', f: v => v ? n0(v) : '—' },
        { k: 'from', t: 'Старт', f: v => v.slice(8, 10) + '.' + v.slice(5, 7) },
        { k: 'toWeek', t: 'Фініш', f: v => v.slice(8, 10) + '.' + v.slice(5, 7) },
        { k: 'weeks', t: 'Тижнів', f: v => n0(v) },
        { k: 'matched', t: 'Пара у продажах', txt: true, f: v => v ? esc(v) : '<span class="tag c">нема</span>' }
      ], events, { sort: 'from', limit: 500 }),
      `${events.length} акцій у ${esc(sel)} за ${yr} рік`)}
    </div>
    <div style="margin-top:12px">
      ${card('Промо-план по SKU', dataTable('tPlan', [
        { k: 'brand', t: 'ТМ', txt: true, f: v => `<span class="tag">${esc(v)}</span>` },
        { k: 'sku', t: 'Номенклатура промо-плану', txt: true },
        { k: 'matched', t: 'Пара', f: v => v === 'так' ? '<span class="tag a">є</span>' : '<span class="tag c">нема</span>' },
        { k: 'weeks', t: 'Тижнів', f: v => n0(v) },
        { k: 'share', t: 'Частка року', f: v => `${n1(v)}%<span class="bar" style="width:${Math.min(100, v)}%"></span>` },
        { k: 'avgDepth', t: 'Сер. глибина', f: v => v === null ? '—' : n1(v) + '%' },
        { k: 'maxDepth', t: 'Макс', f: v => v === null ? '—' : n0(v) + '%' },
        { k: 'plan', t: 'План, од', f: v => v ? n0(v) : '—' },
        { k: 'basePrice', t: 'Базова ціна', f: v => v ? n2(v) : '—' },
        { k: 'rev', t: 'Факт виручка, ₴', f: v => v ? n0(v) : '—' }
      ], perSku, { sort: 'weeks' }))}
    </div>`;

  el('pSheet').onchange = e => {
    APP.promoSheet = e.target.value.split(' · ')[0]; APP.promoYear = null; render();
  };
  el('pYear').onchange = e => { APP.promoYear = e.target.value.split(' · ')[0]; render(); };
  el('pBrand').onchange = e => { APP.promoBrand = e.target.value; render(); };
  el('pFold').onclick = () => {
    APP.promoFolded = !APP.promoFolded;
    APP.promoClosed = APP.promoFolded ? new Set(brandList) : new Set();
    render();
  };
  document.querySelectorAll('tr.grp[data-b]').forEach(tr => tr.onclick = () => {
    const b = tr.dataset.b;
    if (!APP.promoClosed) APP.promoClosed = new Set();
    if (APP.promoClosed.has(b)) APP.promoClosed.delete(b); else APP.promoClosed.add(b);
    render();
  });
  el('pRibbon').onclick = () => { APP.promoMode = 'ribbon'; render(); };
  el('pGrid').onclick = () => { APP.promoMode = 'grid'; render(); };

  chart('cWeek', {
    data: {
      labels: perWeek.map(w => w.w.slice(8, 10) + '.' + w.w.slice(5, 7)),
      datasets: [
        { type: 'bar', label: 'SKU у промо', data: perWeek.map(w => w.n), backgroundColor: '#E8A33D', borderRadius: 1 },
        {
          type: 'line', label: 'Середня глибина, %', data: perWeek.map(w => isFinite(w.d) ? w.d : null),
          yAxisID: 'y1', borderColor: '#D9563F', tension: .3, pointRadius: 0, borderWidth: 2, spanGaps: true
        }
      ]
    },
    options: {
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 8.5 }, maxRotation: 90, minRotation: 90 } },
        y: { grid: { color: '#221D18' }, ticks: { precision: 0 } },
        y1: { position: 'right', grid: { display: false }, ticks: { callback: v => v + '%' } }
      }
    }
  });

  const topL = perSku.filter(s => s.weeks).sort((a, b) => b.share - a.share).slice(0, 14);
  chart('cSkuLoad', {
    type: 'bar',
    data: {
      labels: topL.map(s => s.sku.length > 26 ? s.sku.slice(0, 25) + '…' : s.sku),
      datasets: [
        { label: 'Частка тижнів у промо, %', data: topL.map(s => s.share), backgroundColor: '#B07AB4', borderRadius: 1 },
        { label: 'Середня глибина, %', data: topL.map(s => s.avgDepth || 0), backgroundColor: '#55A99B', borderRadius: 1 }
      ]
    },
    options: {
      indexAxis: 'y',
      scales: { x: AX.yPct, y: { grid: { display: false }, ticks: { font: { size: 9 } } } },
      plugins: { tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${n1(c.parsed.x)}%` } } }
    }
  });
  bindTables();
}

/* =====================================================================
   08 · ЕФЕКТИВНІСТЬ ПРОМО
   ===================================================================== */

function promoEffect() {
  const D = APP.d;
  const out = [];
  const share = Math.max(1, APP.cfg.promoShare) / 100;

  /* факт по мережа×sku×місяць */
  const fact = {};
  D.sales.forEach(r => {
    const k = r.chain + '|' + r.sku;
    if (!fact[k]) fact[k] = {};
    const f = fact[k][r.ym] || (fact[k][r.ym] = { qty: 0, rev: 0, cogs: 0, gross: 0 });
    f.qty += r.qty; f.rev += r.rev;
    if (r.cogs !== null) { f.cogs += r.cogs; f.gross += r.gross; }
  });

  Object.entries(fact).forEach(([k, byM]) => {
    const [chain, sku] = k.split('|');
    const months = Object.keys(byM).sort();
    if (months.length < 4) return;

    const withP = [], without = [];
    months.forEach(m => {
      const pm = D.promoMonth[chain + '|' + sku + '|' + m];
      const on = pm && pm.weeks > 0;
      (on ? withP : without).push({ m, ...byM[m], weeks: on ? pm.weeks : 0, depth: on ? pm.depthAvg : null });
    });
    if (!withP.length || without.length < 2) return;

    const base = median(without.map(x => x.qty));
    if (base <= 0) return;
    const basePrice = mean(without.map(x => x.qty ? x.rev / x.qty : 0).filter(Boolean));
    const cost = D.cost[sku] ? D.cost[sku].unit : null;

    const promoQty = sum(withP, x => x.qty);
    const incQty = promoQty - base * withP.length;
    const depth = mean(withP.map(x => x.depth).filter(d => d !== null && isFinite(d)));
    const promoPrice = mean(withP.map(x => x.qty ? x.rev / x.qty : 0).filter(Boolean));

    const invest = isFinite(depth) ? promoQty * basePrice * (depth / 100) * share : null;
    const incGross = cost === null ? null : incQty * (promoPrice - cost);
    const roi = (invest && incGross !== null) ? (incGross - invest) / invest * 100 : null;

    out.push({
      chain, sku,
      months: months.length, promoMonths: withP.length, baseMonths: without.length,
      base, promoAvg: promoQty / withP.length,
      uplift: base ? (promoQty / withP.length / base - 1) * 100 : null,
      incQty, depth: isFinite(depth) ? depth : null,
      basePrice, promoPrice,
      priceDrop: basePrice ? (1 - promoPrice / basePrice) * 100 : null,
      invest, incGross, roi,
      rev: sum(months.map(m => byM[m]), x => x.rev)
    });
  });
  return out.sort((a, b) => b.rev - a.rev);
}

function viewPromoEff(host) {
  const data = promoEffect();
  if (!data.length) {
    host.innerHTML = card('Ефективність промо', `<div class="empty">
      <b>Недостатньо даних для порівняння</b>
      Потрібно щонайменше 2 місяці без промо та 1 з промо на комбінацію мережа × SKU,
      а також успішне зіставлення назв промо-плану з номенклатурою продажів.</div>`);
    return;
  }

  const sel = data.filter(d => d.roi !== null);
  const good = sel.filter(d => d.roi > 0), bad = sel.filter(d => d.roi <= 0);
  const totInv = sum(sel, d => d.invest), totInc = sum(sel, d => d.incGross);

  const cols = [
    { k: 'sku', t: 'Номенклатура', txt: true },
    { k: 'chain', t: 'Мережа', txt: true, f: v => `<span class="tag">${esc(v)}</span>` },
    { k: 'promoMonths', t: 'Міс. з промо', f: v => n0(v) },
    { k: 'base', t: 'База, од/міс', f: v => n0(v) },
    { k: 'promoAvg', t: 'Промо, од/міс', f: v => n0(v) },
    { k: 'uplift', t: 'Приріст', f: v => v === null ? '—' : `<span class="${v > 0 ? 'up' : 'down'}">${v > 0 ? '+' : ''}${n0(v)}%</span>` },
    { k: 'depth', t: 'Глибина', f: v => v === null ? '—' : n1(v) + '%' },
    { k: 'priceDrop', t: 'Падіння ціни', f: v => v === null ? '—' : n1(v) + '%', title: 'Фактичне падіння середньої ціни відвантаження' },
    { k: 'incQty', t: 'Дод. обсяг, од', f: v => `<span class="${v > 0 ? 'up' : 'down'}">${n0(v)}</span>` },
    { k: 'invest', t: 'Інвестиція, ₴', f: v => v === null ? '—' : n0(v) },
    { k: 'incGross', t: 'Дод. маржа, ₴', f: v => v === null ? '—' : `<span class="${v > 0 ? 'up' : 'down'}">${n0(v)}</span>` },
    { k: 'roi', t: 'ROI', f: v => v === null ? '—' : `<span class="${v > 0 ? 'up' : 'down'}">${v > 0 ? '+' : ''}${n0(v)}%</span>` }
  ];

  /* залежність приросту від глибини */
  const pts = sel.filter(d => d.depth !== null && d.uplift !== null && isFinite(d.uplift));
  let slope = null, r2 = null;
  if (pts.length > 4) {
    const xs = pts.map(p => p.depth), ys = pts.map(p => p.uplift);
    const mx = mean(xs), my = mean(ys);
    const cov = sum(pts.map((_, i) => (xs[i] - mx) * (ys[i] - my)), v => v);
    const vx = sum(xs.map(x => (x - mx) ** 2), v => v);
    slope = vx ? cov / vx : null;
    if (slope !== null) {
      const pred = xs.map(x => my + slope * (x - mx));
      const ssRes = sum(ys.map((y, i) => (y - pred[i]) ** 2), v => v);
      const ssTot = sum(ys.map(y => (y - my) ** 2), v => v);
      r2 = ssTot ? 1 - ssRes / ssTot : null;
    }
  }

  host.innerHTML = `
    <div class="kpis">
      ${kpi('Пар мережа × SKU', n0(data.length), '', `<span class="d">${n0(sel.length)} з повним розрахунком</span>`)}
      ${kpi('Промо в плюс', n0(good.length), '', `<span class="d">${n1(sel.length ? good.length / sel.length * 100 : 0)}% випадків</span>`, 'pos')}
      ${kpi('Промо в мінус', n0(bad.length), '', `<span class="d">${money(sum(bad, d => d.invest - d.incGross))} ₴ втрат</span>`, 'neg')}
      ${kpi('Інвестовано у знижку', money(totInv), '₴')}
      ${kpi('Додаткова маржа', money(totInc), '₴', dEl(totInv ? (totInc / totInv - 1) * 100 : null), totInc > totInv ? 'pos' : 'neg')}
      ${kpi('Сукупний ROI', totInv ? n0((totInc - totInv) / totInv * 100) : '—', '%', '', totInc > totInv ? 'pos' : 'neg')}
    </div>

    <div class="grid g2" style="margin-top:12px">
      ${card('Приріст обсягу проти глибини знижки', canvas('cElast', 'h300'),
    slope !== null ? `нахил ${n1(slope)} % обсягу на 1 п.п. знижки · R² ${n2(r2)}` : 'мало спостережень')}
      ${card('Куди йдуть гроші промо', canvas('cRoi', 'h300'), 'інвестиція проти додаткової маржі')}
    </div>

    <div style="margin-top:12px">
      ${card('Ефективність по парах', dataTable('tEff', cols, data, { sort: 'rev' }),
      'сортування за виручкою; клік по заголовку змінює порядок')}
    </div>

    <div style="margin-top:12px">
      ${card('Як рахується та де межі методу', `<div class="note">
        <b>База</b> — медіана місячних обсягів у місяцях без промо для конкретної пари мережа × SKU.
        Медіана, а не середнє, щоб один аномальний місяць не зсував орієнтир.<br><br>
        <b>Приріст</b> — наскільки середній промо-місяць вищий за базу. <b>Додатковий обсяг</b> — різниця
        фактичного та базового обсягу за всі промо-місяці.<br><br>
        <b>Інвестиція</b> — увесь промо-обсяг × базова ціна × глибина × частка фінансування виробником
        (${APP.cfg.promoShare}%, змінюється в розділі «Економіка SKU»).<br><br>
        <b>Чого метод не бачить:</b> перетікання попиту з сусідніх місяців (закупівля про запас перед промо
        і провал після), канібалізацію між SKU однієї ТМ, сезонність, і той факт, що продажі тут —
        це відвантаження мережі, а не sell-out із полиці. Тому цифри читаються як напрямок, а не як точна сума.
        Пари з 1–2 промо-місяцями ненадійні за визначенням.
      </div>`)}
    </div>`;

  chart('cElast', {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'пара мережа × SKU',
          data: pts.map(p => ({ x: p.depth, y: p.uplift, l: p.sku, c: p.chain })),
          backgroundColor: pts.map(p => p.roi > 0 ? 'rgba(134,184,96,.55)' : 'rgba(217,86,63,.55)'),
          borderColor: pts.map(p => p.roi > 0 ? '#86B860' : '#D9563F'), borderWidth: 1, pointRadius: 5
        }
      ].concat(slope !== null ? [{
        type: 'line', label: 'тренд',
        data: [{ x: Math.min(...pts.map(p => p.depth)), y: 0 }, { x: Math.max(...pts.map(p => p.depth)), y: 0 }]
          .map(pt => ({ x: pt.x, y: mean(pts.map(p => p.uplift)) + slope * (pt.x - mean(pts.map(p => p.depth))) })),
        borderColor: '#E8A33D', borderWidth: 2, pointRadius: 0, borderDash: [5, 4]
      }] : [])
    },
    options: {
      scales: {
        x: { grid: { color: '#221D18' }, ticks: { callback: v => v + '%' }, title: { display: true, text: 'глибина знижки' } },
        y: { grid: { color: '#221D18' }, ticks: { callback: v => v + '%' }, title: { display: true, text: 'приріст обсягу' } }
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => c.raw.l ? [c.raw.l, c.raw.c, `${n1(c.raw.x)}% знижки → ${n0(c.raw.y)}% приросту`] : '' } }
      }
    }
  });

  const topR = sel.slice().sort((a, b) => b.invest - a.invest).slice(0, 14);
  chart('cRoi', {
    type: 'bar',
    data: {
      labels: topR.map(d => (d.sku.length > 22 ? d.sku.slice(0, 21) + '…' : d.sku)),
      datasets: [
        { label: 'Інвестиція у знижку', data: topR.map(d => d.invest), backgroundColor: '#D9563F', borderRadius: 1 },
        { label: 'Додаткова маржа', data: topR.map(d => d.incGross), backgroundColor: '#86B860', borderRadius: 1 }
      ]
    },
    options: {
      indexAxis: 'y',
      scales: { x: AX.y, y: { grid: { display: false }, ticks: { font: { size: 9 } } } },
      plugins: { tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${n0(c.parsed.x)} ₴` } } }
    }
  });
  bindTables();
}

/* =====================================================================
   09 · ДАНІ ТА ЯКІСТЬ
   ===================================================================== */

/** Позначає обраний варіант у готовому рядку <option>, не ламаючись на спецсимволах */
function withSelected(optionsHtml, value) {
  const needle = 'value="' + esc(value) + '"';
  const i = optionsHtml.indexOf(needle);
  if (i < 0) return optionsHtml;
  return optionsHtml.slice(0, i + needle.length) + ' selected' + optionsHtml.slice(i + needle.length);
}

function viewData(host) {
  const R = APP.raw, D = APP.d;

  const stats = `<dl class="kv">
    <dt>Продажі, агрегованих рядків</dt><dd>${n0(D.sales.length)}</dd>
    <dt>Вихідних рядків у джерелі</dt><dd>${R.sales && R.sales.sourceRows ? n0(R.sales.sourceRows) : '—'}</dd>
    <dt>Позицій собівартості</dt><dd>${n0(Object.keys(D.cost).length)}</dd>
    <dt>Мереж в умовах</dt><dd>${n0(D.terms.length)}</dd>
    <dt>Рядків промо-плану</dt><dd>${n0(D.promo.length)}</dd>
    <dt>Рядків рентабельності</dt><dd>${n0(D.profit.length)}</dd>
    <dt>Період продажів</dt><dd>${D.years.length ? D.years[0] + '–' + D.years[D.years.length - 1] : '—'}</dd>
    <dt>Оновлено</dt><dd>${R.generated ? new Date(R.generated).toLocaleString('uk-UA') : '—'}</dd>
  </dl>
  <div class="split" style="margin-top:12px">
    <button class="btn primary" id="dReload">Оновити з джерела</button>
    <button class="btn" id="dSource">Налаштування підключення</button>
    <button class="btn" id="dExport">Вивантажити JSON</button>
    <button class="btn ghost" id="dClear">Очистити локальну копію</button>
  </div>`;

  /* аномалії */
  let an = '';
  if (!D.anomalies.length) an = '<div class="okbox">Критичних розбіжностей не знайдено.</div>';
  D.anomalies.forEach((a, i) => {
    an += `<div class="${a.lvl === 'err' ? 'warnbox' : 'infobox'}" style="margin-bottom:10px">
      <div style="font-weight:600;margin-bottom:3px">${a.lvl === 'err' ? '⚠ ' : ''}${esc(a.t)}</div>
      <div style="color:var(--muted);font-size:11.5px">${a.d}</div>
      ${a.items && a.items.length ? `<details style="margin-top:6px">
        <summary style="cursor:pointer;color:var(--amber);font-size:11.5px">показати позиції (${a.items.length})</summary>
        <div style="font-family:var(--f-mono);font-size:10.5px;color:var(--muted);margin-top:5px;max-height:200px;overflow:auto">
          ${a.items.map(x => esc(x)).join('<br>')}</div></details>` : ''}
    </div>`;
  });

  /* діагностика парсера промо */
  let diag = '<div class="note" style="padding:12px">Бекенд не повернув діагностику.</div>';
  if (R.promoDiag && R.promoDiag.length) {
    const m = (d, k) => (d.metrics && d.metrics[k]) || 0;
    diag = `<div class="tblwrap"><table class="dt"><thead><tr>
      <th class="txt">Аркуш</th><th>Секцій</th><th>Тижнів</th><th>SKU</th>
      <th>Назви</th><th>Умови</th><th>З глибиною</th><th>Ціни</th><th>Плани</th><th>Старти</th>
      </tr></thead><tbody>` +
      R.promoDiag.map(d => {
        if (d.skipped || d.error) {
          return `<tr><td class="txt">${esc(d.sheet)} <span class="tag c">пропущено</span></td>
            <td colspan="9" class="txt" style="color:var(--dim)">${esc(d.reason || d.error || (d.hidden ? 'прихований' : 'порожній'))}</td></tr>`;
        }
        const nm = m(d, 'name'), tr = m(d, 'terms'), wd = d.withDepth || 0;
        return `<tr>
          <td class="txt">${esc(d.sheet)}</td>
          <td>${d.sections ? d.sections.length : 1}</td>
          <td>${n0(d.weeks || 0)}</td>
          <td>${n0(d.skus || 0)}</td>
          <td>${n0(nm)}</td>
          <td class="${tr ? '' : 'down'}">${n0(tr)}</td>
          <td class="${wd ? 'up' : 'down'}">${n0(wd)}</td>
          <td>${n0(m(d, 'price'))}</td>
          <td>${n0(m(d, 'plan'))}</td>
          <td>${n0(m(d, 'start'))}</td></tr>` +
          (d.sections || []).map(x => `<tr>
            <td class="txt" style="padding-left:22px;color:var(--dim)">секція, рядок ${x.headerRow} · ${x.year}</td>
            <td colspan="9" class="txt" style="color:var(--dim);font-size:11px">
              тижнів ${x.weeks} · назва — колонка ${x.nameCol}
              · мітки під-рядків — ${x.labelCol ? 'колонка ' + x.labelCol : '<span style="color:var(--chili)">не знайдено</span>'}
              · базова ціна — ${x.priceCol ? 'колонка ' + x.priceCol : 'немає'}
              · клітинок ${n0(x.cells)}</td></tr>`).join('');
      }).join('') +
      '</tbody></table></div>' +
      `<div class="note" style="padding:10px 12px">Колонка <b>«З глибиною»</b> — скільки клітинок дали відсоток знижки.
       Якщо там нуль, а «Умови» не нульові — у тому аркуші відсоток записаний у форматі, який парсер не впізнав.
       Якщо нуль і там, і там — у аркуші немає під-рядка «условия», і глибина рахується з базової та промо-ціни.</div>`;
  }

  /* зіставлення SKU */
  const ml = D.matchLog.slice(0, 300);
  const skuOpts = ['<option value="">— не зіставляти —</option>']
    .concat(D.skuList.map(s => `<option value="${esc(s)}">${esc(s)}</option>`)).join('');
  let match = `<div class="tblwrap"><table class="dt"><thead><tr>
    <th class="txt">Назва у промо-плані</th><th>Мережі</th><th>Точність</th>
    <th class="txt">Номенклатура продажів</th></tr></thead><tbody>`;
  ml.forEach(m => {
    const cur = APP.overrides.sku[m.promoName] || m.sku || '';
    match += `<tr>
      <td class="txt">${esc(m.promoName)}</td>
      <td>${m.chains.length}</td>
      <td>${m.manual ? '<span class="tag x">вручну</span>' :
        m.sku ? `<span class="tag ${m.score > .8 ? 'a' : 'b'}">${n2(m.score)}</span>`
          : '<span class="tag c">нема</span>'}</td>
      <td class="txt"><select class="mSel" data-p="${esc(m.promoName)}" style="width:100%;font-size:11px">
        ${withSelected(skuOpts, cur)}
      </select></td></tr>`;
  });
  match += '</tbody></table></div>';

  /* зіставлення мереж */
  const chainNames = uniq(D.partners.concat(promoSheets()));
  const chainOpts = ['<option value="">авто</option>']
    .concat(D.terms.map(t => `<option value="${esc(t.chain)}">${esc(t.chain)}</option>`))
    .concat([`<option value="${CHAIN_OTHER}">${CHAIN_OTHER}</option>`]).join('');
  const unmappedPartners = D.partners.filter(p => chainOf(p) === CHAIN_OTHER);
  let chmap = `<div class="note" style="padding:10px 12px">
      ${n0(unmappedPartners.length)} партнерів віднесено до «${CHAIN_OTHER}» — для них бонусне навантаження дорівнює нулю.
      Якщо серед них є мережа з довідника умов, задайте відповідність тут.</div>
    <div class="tblwrap" style="max-height:420px"><table class="dt"><thead><tr>
      <th class="txt">Партнер / аркуш промо</th><th>Зараз</th><th class="txt">Призначити мережу</th>
    </tr></thead><tbody>`;
  chainNames.forEach(p => {
    const cur = APP.overrides.chain[p] || '';
    chmap += `<tr><td class="txt">${esc(p)}</td>
      <td><span class="tag ${chainOf(p) === CHAIN_OTHER ? '' : 'a'}">${esc(chainOf(p))}</span></td>
      <td class="txt"><select class="cSel" data-p="${esc(p)}" style="width:100%;font-size:11px">
        ${withSelected(chainOpts, cur)}
      </select></td></tr>`;
  });
  chmap += '</tbody></table></div>';

  let pfd = '<div class="note" style="padding:12px">Аркуш рентабельності не завантажено.</div>';
  if (R.profitDiag) {
    const d = R.profitDiag;
    pfd = d.error
      ? `<div class="warnbox">${esc(d.error)}</div>`
      : `<dl class="kv">
          <dt>Аркуш</dt><dd>${esc(d.sheet)}</dd>
          <dt>Рядок шапки</dt><dd>${d.headerRow}</dd>
          <dt>Колонка назви</dt><dd>${d.nameCol}</dd>
          <dt>Рядків рівня «клієнт»</dt><dd>${n0(d.counts.partner)}</dd>
          <dt>Рівня «ТМ»</dt><dd>${n0(d.counts.brand)}</dd>
          <dt>Рівня «номенклатура»</dt><dd>${n0(d.counts.sku)}</dd>
          <dt>Пропущено</dt><dd>${n0(d.counts.skipped)}</dd>
        </dl>
        <div class="note" style="margin-top:8px">Рівень визначається за назвою: рядки з обсягом у назві —
        номенклатура, з «ТОВ», «ФОП», «ГРУП» — клієнт, решта — торгова марка.
        Якщо клієнтів підозріло багато або мало, перевірте назви в аркуші.</div>`;
  }

  host.innerHTML = `
    <div class="grid g2">
      ${card('Підключення та обсяг даних', stats)}
      ${card('Що варто перевірити у джерелі', an || '', 'автоматичні перевірки')}
    </div>
    <div style="margin-top:12px">
      ${card('Як парсер прочитав аркуш рентабельності', pfd, 'рівні ієрархії')}
    </div>
    <div style="margin-top:12px">
      ${card('Як парсер прочитав промо-план', diag,
    'якщо аркуш пропущено або знайдено мало тижнів — структуру треба вирівняти')}
    </div>
    <div class="grid g2" style="margin-top:12px">
      ${card('Зіставлення номенклатури', match, 'промо-план ↔ продажі')}
      ${card('Зіставлення мереж', chmap, 'партнер ↔ довідник умов')}
    </div>`;

  el('dReload').onclick = () => loadFromEndpoint(true).then(() => render());
  el('dSource').onclick = openSource;
  el('dExport').onclick = () => {
    const blob = new Blob([JSON.stringify(APP.raw)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'foodline-data-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
  };
  el('dClear').onclick = () => {
    if (!confirm('Видалити локальну копію даних і кеш застосунку з цього браузера?')) return;
    try { localStorage.removeItem(LS + '_data'); } catch (e) { }
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage('clearCache');
    }
    setTimeout(() => location.reload(), 300);
  };
  document.querySelectorAll('.mSel').forEach(s => s.onchange = e => {
    const p = e.target.dataset.p;
    if (e.target.value) APP.overrides.sku[p] = e.target.value;
    else delete APP.overrides.sku[p];
    saveCfg(); buildPromo(); detectAnomalies(); render();
  });
  document.querySelectorAll('.cSel').forEach(s => s.onchange = e => {
    const p = e.target.dataset.p;
    if (e.target.value) APP.overrides.chain[p] = e.target.value;
    else delete APP.overrides.chain[p];
    saveCfg(); build(); render();
  });
}

/* =====================================================================
   ДЖЕРЕЛО ДАНИХ
   ===================================================================== */

function openSource() {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="box">
    <h3>Джерело даних</h3>
    <div class="bd">
      <div class="field">
        <label>URL вебдодатку Apps Script</label>
        <input type="url" id="sUrl" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(APP.cfg.endpoint)}">
      </div>
      <div class="field">
        <label>Токен</label>
        <input type="text" id="sTok" placeholder="значення API_TOKEN зі скрипта" value="${esc(APP.cfg.token)}">
      </div>
      <div class="split">
        <button class="btn primary" id="sTest">Підключитися</button>
        <button class="btn" id="sPing">Перевірити зв'язок</button>
        <span id="sMsg" class="pill" style="display:none"></span>
      </div>
      <hr style="border:0;border-top:1px solid var(--line);margin:16px 0">
      <div class="field">
        <label>Або завантажити файл вивантаження</label>
        <input type="file" id="sFile" accept=".json,application/json">
      </div>
      <div class="field">
        <label>Або вставити JSON</label>
        <textarea id="sJson" placeholder='{"sales":{"cols":[…],"rows":[…]}, "cost":…, "terms":…, "promo":…}'></textarea>
        <button class="btn" id="sPaste" style="margin-top:6px">Прийняти JSON</button>
      </div>
      <div class="note">Дані зберігаються лише у цьому браузері. Нічого не надсилається нікуди, окрім вашого власного вебдодатку.</div>
      <div class="split" style="margin-top:14px;justify-content:flex-end">
        <button class="btn ghost" id="sClose">Закрити</button>
      </div>
    </div></div>`;
  document.body.appendChild(m);
  const close = () => m.remove();
  m.onclick = e => { if (e.target === m) close(); };
  el('sClose').onclick = close;

  const msg = (t, ok) => {
    const s = el('sMsg');
    s.style.display = 'inline-block';
    s.textContent = t;
    s.style.color = ok ? 'var(--wasabi)' : 'var(--chili)';
  };

  el('sPing').onclick = async () => {
    APP.cfg.endpoint = el('sUrl').value.trim();
    APP.cfg.token = el('sTok').value.trim();
    saveCfg();
    msg('перевіряю…', true);
    try {
      const r = await jsonp(APP.cfg.endpoint + '?action=ping&token=' + encodeURIComponent(APP.cfg.token), 20000);
      msg(r && r.ok ? 'зв\'язок є, версія ' + (r.version || '?') : 'відповідь: ' + (r && r.error), !!(r && r.ok));
    } catch (e) { msg(e.message, false); }
  };

  el('sTest').onclick = async () => {
    APP.cfg.endpoint = el('sUrl').value.trim();
    APP.cfg.token = el('sTok').value.trim();
    saveCfg();
    msg('завантажую…', true);
    const ok = await loadFromEndpoint(true, () => { close(); renderFilters(); render(); });
    if (ok) { renderFilters(); render(); }
    else msg(el('statusText').textContent, false);
  };

  el('sFile').onchange = e => {
    const f = e.target.files[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        ingest(JSON.parse(fr.result));
        setStatus('ok', `${n0(APP.d.sales.length)} рядків · з файлу`);
        close(); renderFilters(); render();
      } catch (err) { msg('файл не розібрано: ' + err.message, false); }
    };
    fr.readAsText(f);
  };

  el('sPaste').onclick = () => {
    try {
      ingest(JSON.parse(el('sJson').value));
      setStatus('ok', `${n0(APP.d.sales.length)} рядків · вставлено`);
      close(); renderFilters(); render();
    } catch (err) { msg('JSON не розібрано: ' + err.message, false); }
  };
}

/* =====================================================================
   РУХ ІНТЕРФЕЙСУ
   ===================================================================== */

const CALM_KEY = LS + '_calm';

function calmOn() {
  try { return localStorage.getItem(CALM_KEY) === '1'; } catch (e) { return false; }
}
function setCalm(v) {
  document.body.classList.toggle('calm', v);
  try { localStorage.setItem(CALM_KEY, v ? '1' : '0'); } catch (e) { }
  const b = el('btnCalm');
  if (b) b.textContent = v ? 'Рух' : 'Спокій';
  if (v) stopStars(); else startStars();
}

/* --- амбієнтне тло: повільний дрейф частинок і горизонт --- */
let starTimer = null, starParts = [];

function placeStars() {
  const c = el('stars');
  if (!c) return null;
  // критичне позиціювання ставимо з коду, щоб застарілий кеш CSS не ламав верстку
  const st = c.style;
  st.position = 'fixed'; st.left = '0'; st.top = '0';
  st.width = '100%'; st.height = '100%';
  st.zIndex = '0'; st.pointerEvents = 'none'; st.display = 'block';
  return c;
}

function startStars() {
  const c = placeStars();
  if (!c || starTimer || calmOn()) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let ctx = null;
  try { ctx = c.getContext('2d'); } catch (e) { return; }
  if (!ctx || typeof ctx.setTransform !== 'function' || typeof ctx.arc !== 'function') return;
  let w = 0, h = 0, dpr = Math.min(2, window.devicePixelRatio || 1);

  function size() {
    w = c.clientWidth; h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  size();
  window.addEventListener('resize', size);

  starParts = Array.from({ length: 70 }, () => ({
    x: Math.random(), y: Math.random(),
    z: 0.25 + Math.random() * 0.75,
    r: 0.4 + Math.random() * 1.1
  }));

  /* неонові траси: ортогональні шляхи з рухомим імпульсом — як на схемі станції */
  const TRACE_COLORS = ['92,200,245', '232,163,61', '155,123,232'];
  const traces = Array.from({ length: 7 }, (_, i) => {
    const y0 = 0.08 + Math.random() * 0.84;
    const x1 = 0.18 + Math.random() * 0.3;
    const y1 = y0 + (Math.random() - 0.5) * 0.34;
    const x2 = x1 + 0.16 + Math.random() * 0.34;
    return {
      pts: [[0, y0], [x1, y0], [x1, y1], [x2, y1], [x2, y1 + (Math.random() - 0.5) * 0.2], [1.02, y1 + (Math.random() - 0.5) * 0.2]],
      c: TRACE_COLORS[i % TRACE_COLORS.length],
      speed: 0.035 + Math.random() * 0.05,
      phase: Math.random()
    };
  });

  function pathPoint(pts, t) {
    const segs = pts.length - 1;
    const f = Math.min(0.9999, Math.max(0, t)) * segs;
    const i = Math.floor(f), k = f - i;
    const a = pts[i], b = pts[i + 1];
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  }

  let t = 0;
  function frame() {
    if (document.hidden) { starTimer = requestAnimationFrame(frame); return; }
    t += 0.0016;
    ctx.clearRect(0, 0, w, h);

    /* статичні траси */
    ctx.lineWidth = 1;
    for (const tr of traces) {
      ctx.strokeStyle = `rgba(${tr.c},.055)`;
      ctx.beginPath();
      tr.pts.forEach((p, i) => i ? ctx.lineTo(p[0] * w, p[1] * h) : ctx.moveTo(p[0] * w, p[1] * h));
      ctx.stroke();
    }

    /* імпульс, що біжить трасою */
    for (const tr of traces) {
      const pos = (t * tr.speed * 10 + tr.phase) % 1;
      for (let k = 0; k < 9; k++) {
        const pt = pathPoint(tr.pts, pos - k * 0.012);
        if (pt[0] < -0.02 || pt[0] > 1.04) continue;
        const a = (1 - k / 9) * 0.5;
        ctx.fillStyle = `rgba(${tr.c},${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(pt[0] * w, pt[1] * h, 1.5 - k * 0.12, 0, 6.283);
        ctx.fill();
      }
    }

    /* далекі частинки */
    for (const s of starParts) {
      s.y -= 0.00013 * s.z;
      if (s.y < -0.02) { s.y = 1.02; s.x = Math.random(); }
      const px = s.x * w, py = s.y * h;
      const a = 0.09 + s.z * 0.26 + Math.sin(t * 9 + s.x * 40) * 0.05;
      ctx.fillStyle = `rgba(214,224,236,${Math.max(0, a).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(px, py, s.r * s.z, 0, 6.283); ctx.fill();
    }
    starTimer = requestAnimationFrame(frame);
  }
  starTimer = requestAnimationFrame(frame);
}

function stopStars() {
  if (starTimer) { cancelAnimationFrame(starTimer); starTimer = null; }
  const c = el('stars');
  if (!c) return;
  try {
    const ctx = c.getContext('2d');
    if (ctx && ctx.clearRect) ctx.clearRect(0, 0, c.width, c.height);
  } catch (e) { }
}

/* --- показники набігають, а не з'являються різко --- */
function countUp() {
  if (calmOn()) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelectorAll('.kpi .v').forEach((node, idx) => {
    const raw = node.childNodes[0];
    if (!raw || raw.nodeType !== 3) return;
    const text = raw.nodeValue.trim();
    const m = text.match(/^(-?[\d\s\u00A0]+(?:,\d+)?)(.*)$/);
    if (!m) return;
    const target = parseFloat(m[1].replace(/[\s\u00A0]/g, '').replace(',', '.'));
    if (!isFinite(target) || Math.abs(target) < 0.001) return;
    const tail = m[2] || '';
    const dec = (m[1].split(',')[1] || '').length;
    const fmt = dec === 0 ? nf0 : (dec === 1 ? nf1 : nf2);
    const dur = 620, t0 = performance.now(), delay = idx * 45;
    function step(now) {
      const p = Math.min(1, Math.max(0, (now - t0 - delay) / dur));
      const e = 1 - Math.pow(1 - p, 3);
      raw.nodeValue = fmt.format(target * e) + tail;
      if (p < 1) requestAnimationFrame(step);
      else raw.nodeValue = text;
    }
    raw.nodeValue = fmt.format(0) + tail;
    requestAnimationFrame(step);
  });
}

/* --- підсвітка кнопок під курсором --- */
function bindGlow() {
  document.addEventListener('pointermove', e => {
    const b = e.target.closest && e.target.closest('.btn');
    if (!b) return;
    const r = b.getBoundingClientRect();
    b.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
    b.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
  }, { passive: true });
}

function dismissBoot() {
  const b = el('boot');
  if (!b) return;
  b.classList.add('out');
  setTimeout(() => b.remove(), 520);
}

/* =====================================================================
   ВСТАНОВЛЕННЯ ЯК ДОДАТКА
   ===================================================================== */

function initPWA() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;

  navigator.serviceWorker.register('sw.js').then(reg => {
    // якщо прилетіла нова версія — тихо підміняємо і повідомляємо
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          setStatus('ok', 'доступна нова версія — оновіть сторінку');
        }
      });
    });
  }).catch(() => { });

  // кнопка встановлення з'являється лише коли браузер це дозволяє
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    APP.installPrompt = e;
    const b = el('btnInstall');
    if (b) {
      b.style.display = '';
      b.onclick = async () => {
        b.style.display = 'none';
        APP.installPrompt.prompt();
        await APP.installPrompt.userChoice;
        APP.installPrompt = null;
      };
    }
  });
  window.addEventListener('appinstalled', () => {
    const b = el('btnInstall');
    if (b) b.style.display = 'none';
  });
}

/** Відкриття розділу з ярлика маніфесту: ?view=promoplan */
function viewFromUrl() {
  try {
    const v = new URLSearchParams(location.search).get('view');
    if (v && VIEWS.some(x => x.id === v)) return v;
  } catch (e) { }
  return null;
}

/* =====================================================================
   СТАРТ
   ===================================================================== */

function boot() {
  initChartDefaults();
  loadCfg();
  renderRail();

  document.body.classList.toggle('calm', calmOn());
  const bc = el('btnCalm');
  if (bc) {
    bc.textContent = calmOn() ? 'Рух' : 'Спокій';
    bc.onclick = () => setCalm(!document.body.classList.contains('calm'));
  }
  bindGlow();
  placeStars();
  startStars();
  initPWA();
  const urlView = viewFromUrl();
  if (urlView) APP.view = urlView;
  const bootEl = el('boot');
  if (bootEl) {
    bootEl.onclick = dismissBoot;
    setTimeout(dismissBoot, calmOn() ? 0 : 1750);
  }

  el('btnSource').onclick = openSource;
  const refresh = () => { renderFilters(); render(); };
  el('btnReload').onclick = () => loadFromEndpoint(true, refresh).then(ok => { if (ok) refresh(); });

  const hasCache = loadCached();
  if (hasCache) { renderFilters(); render(); }
  else { setStatus('', 'не підключено'); render(); }

  if (APP.cfg.endpoint) {
    loadFromEndpoint(false, refresh).then(ok => { if (ok) refresh(); });
  }
}

document.addEventListener('DOMContentLoaded', boot);

/* =====================================================================
   06 · РЕНТАБЕЛЬНІСТЬ (ФАКТ) — з аркуша «рент»
   ===================================================================== */

function viewProfit(host) {
  const P = APP.d.profit;
  if (!P.length) {
    host.innerHTML = card('Рентабельність факт', `<div class="empty">
      <b>Аркуш «рент» не завантажено</b>
      Оновіть дані з джерела. Якщо аркуш є, а рядків немає — подивіться діагностику
      в розділі «Дані та якість».</div>`);
    return;
  }

  const months = APP.d.profitMonths;
  const selM = APP.profitMonth && months.includes(APP.profitMonth) ? APP.profitMonth : 'all';
  const scope = selM === 'all' ? P : P.filter(r => r.ym === selM);

  const L1 = scope.filter(r => r.level === 1);
  const L2 = scope.filter(r => r.level === 2);
  const L3 = scope.filter(r => r.level === 3);

  const roll = (arr, keyFn) => {
    const m = new Map();
    arr.forEach(r => {
      const k = keyFn(r);
      let a = m.get(k);
      if (!a) {
        a = {
          key: k, rev: 0, cogs: 0, gross: 0, income: 0, mkt: 0,
          mktBuyers: 0, mktSuppliers: 0, delivery: 0, oneBuyers: 0, oneSuppliers: 0, n: 0
        };
        m.set(k, a);
      }
      a.rev += r.rev; a.cogs += r.cogs; a.gross += r.gross; a.income += r.income;
      a.mkt += r.mkt; a.mktBuyers += r.mktBuyers; a.mktSuppliers += r.mktSuppliers;
      a.delivery += r.delivery; a.oneBuyers += r.oneBuyers; a.oneSuppliers += r.oneSuppliers; a.n++;
    });
    const out = Array.from(m.values());
    out.forEach(a => {
      a.ros = a.rev ? a.gross / a.rev * 100 : 0;
      a.roTotal = a.rev ? a.income / a.rev * 100 : 0;
      a.mktPct = a.rev ? a.mkt / a.rev * 100 : 0;
    });
    return out.sort((x, y) => y.rev - x.rev);
  };

  const byP = roll(L1, r => r.partner);
  const T = roll(L1, () => 'all')[0] || { rev: 0, gross: 0, income: 0, mkt: 0, ros: 0, roTotal: 0, mktPct: 0 };

  const losers = byP.filter(p => p.income <= 0);
  const skuLoss = roll(L3, r => r.partner + ' · ' + r.sku).filter(x => x.income < 0);

  /* факт проти довідника умов */
  const cmp = byP.map(p => {
    const ck = chainOf(p.key);
    const t = APP.d.termsMap[ck];
    return {
      partner: p.key, chain: ck,
      factPct: p.mktPct,
      termPct: t ? +t.totalBonus : null,
      gap: t ? p.mktPct - (+t.totalBonus) : null,
      rev: p.rev, mkt: p.mkt
    };
  }).filter(x => x.termPct !== null).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

  const colsP = [
    { k: 'key', t: 'Клієнт', txt: true },
    { k: 'rev', t: 'Виручка, ₴', f: v => n0(v) },
    { k: 'gross', t: 'Валовий, ₴', f: v => n0(v) },
    { k: 'ros', t: 'Рент. продажу, %', f: v => n1(v) },
    { k: 'mkt', t: 'Маркетинг, ₴', f: v => `<span class="down">${n0(v)}</span>` },
    { k: 'mktPct', t: 'Навантаження, %', f: v => `<span class="${v > 25 ? 'down' : ''}">${n1(v)}</span>` },
    { k: 'income', t: 'Дохід, ₴', f: v => `<span class="${v > 0 ? 'up' : 'down'}">${n0(v)}</span>` },
    { k: 'roTotal', t: 'Рент. загальна, %', f: v => `<span class="${v > 0 ? 'up' : 'down'}">${n1(v)}</span>` },
    { k: 'mktBuyers', t: 'Марк. покупці', f: v => n0(v) },
    { k: 'oneBuyers', t: 'Разовий', f: v => n0(v) },
    { k: 'delivery', t: 'Доставка', f: v => n0(v) }
  ];

  const colsS = [
    { k: 'key', t: 'Клієнт · номенклатура', txt: true },
    { k: 'rev', t: 'Виручка, ₴', f: v => n0(v) },
    { k: 'ros', t: 'Рент. продажу, %', f: v => n1(v) },
    { k: 'mkt', t: 'Маркетинг, ₴', f: v => n0(v) },
    { k: 'mktPct', t: 'Навантаження, %', f: v => n1(v) },
    { k: 'income', t: 'Дохід, ₴', f: v => `<span class="${v > 0 ? 'up' : 'down'}">${n0(v)}</span>` },
    { k: 'roTotal', t: 'Рент. загальна, %', f: v => `<span class="${v > 0 ? 'up' : 'down'}">${n1(v)}</span>` }
  ];

  /* теплокарта клієнт × місяць */
  const mtx = {};
  roll(P.filter(r => r.level === 1), r => r.partner + '§' + r.ym).forEach(x => mtx[x.key] = x);
  let hm = `<div class="hm"><table class="hmt"><thead><tr><th class="rowh">Клієнт / місяць</th>`;
  months.forEach(m => hm += `<th>${ymLabel(m)}</th>`);
  hm += `<th>Разом</th></tr></thead><tbody>`;
  byP.slice(0, 18).forEach(p => {
    hm += `<tr><td class="rowh" title="${esc(p.key)}">${esc(p.key)}</td>`;
    months.forEach(m => {
      const c = mtx[p.key + '§' + m];
      const v = c ? c.roTotal : null;
      hm += `<td style="${v === null ? '' : heat(v, 40, true)}" title="${c ? esc(p.key) + ' · ' + ymLabel(m) + ': дохід ' + n0(c.income) + ' ₴' : ''}">${v === null ? '<span style="color:#3A322A">·</span>' : `<span class="${v > 0 ? '' : 'down'}">${n1(v)}</span>`}</td>`;
    });
    hm += `<td style="font-weight:600" class="${p.roTotal > 0 ? '' : 'down'}">${n1(p.roTotal)}</td></tr>`;
  });
  hm += `</tbody></table></div>`;

  host.innerHTML = `
    <div class="split" style="margin-bottom:12px">
      <span class="pill">Період</span>
      <select id="pfMonth">
        <option value="all" ${selM === 'all' ? 'selected' : ''}>усі місяці (${months.length})</option>
        ${months.map(m => `<option value="${m}" ${m === selM ? 'selected' : ''}>${ymLabel(m)}</option>`).join('')}
      </select>
      <span class="pill">${byP.length} клієнтів · ${L3.length} рядків номенклатури</span>
    </div>

    <div class="kpis">
      ${kpi('Виручка', money(T.rev), '₴')}
      ${kpi('Валовий прибуток', money(T.gross), '₴', `<span class="d">рент. продажу ${n1(T.ros)}%</span>`, 'pos')}
      ${kpi('Маркетинг', money(T.mkt), '₴', `<span class="d down">${n1(T.mktPct)}% виручки</span>`, 'neg')}
      ${kpi('Дохід', money(T.income), '₴', `<span class="d">рент. загальна ${n1(T.roTotal)}%</span>`, T.income > 0 ? 'pos' : 'neg')}
      ${kpi('Зʼїдено маркетингом', n1(T.ros - T.roTotal), 'п.п.', `<span class="d">від рентабельності продажу</span>`, 'neg')}
      ${kpi('Клієнтів у нулі або мінусі', n0(losers.length), '', losers.length ? `<span class="d down">${money(sum(losers, l => l.income))} ₴</span>` : '', losers.length ? 'neg' : 'pos')}
    </div>

    <div class="grid g32" style="margin-top:12px">
      ${card('Що залишається після маркетингу', canvas('cPfBridge', 'h320'),
    'рентабельність продажу проти загальної')}
      ${card('З чого складається маркетинг', canvas('cPfMkt', 'h320'), 'частки від виручки клієнта')}
    </div>

    ${cmp.length ? `<div style="margin-top:12px">${card('Факт проти довідника умов',
      `<div class="infobox" style="margin:12px 12px 0">Ліворуч — скільки насправді пішло на клієнта за звітом,
        праворуч — скільки закладено в аркуші «Умови мереж». Різниця показує, наскільки договірні відсотки
        відображають реальні витрати.</div>` +
      dataTable('tCmp', [
        { k: 'partner', t: 'Клієнт', txt: true },
        { k: 'chain', t: 'Мережа в довіднику', txt: true, f: v => `<span class="tag">${esc(v)}</span>` },
        { k: 'rev', t: 'Виручка, ₴', f: v => n0(v) },
        { k: 'factPct', t: 'Факт, %', f: v => `<b>${n1(v)}</b>` },
        { k: 'termPct', t: 'Довідник, %', f: v => n1(v) },
        {
          k: 'gap', t: 'Різниця', f: v =>
            `<span class="${v > 0 ? 'down' : 'up'}">${v > 0 ? '+' : ''}${n1(v)} п.п.</span>`
        },
        { k: 'mkt', t: 'Маркетинг, ₴', f: v => n0(v) }
      ], cmp, { sort: 'gap', limit: 30 }), 'де умови розходяться з життям')}</div>` : ''}

    <div style="margin-top:12px">
      ${card('Рентабельність загальна: клієнт × місяць', hm,
      'червоне — місяці, у яких клієнт не окупив маркетинг')}
    </div>

    ${skuLoss.length ? `<div style="margin-top:12px">${card('Позиції з відʼємним доходом',
        dataTable('tPfLoss', colsS, skuLoss, { sort: 'income', limit: 40 }),
        `${skuLoss.length} комбінацій клієнт × SKU · разом ${money(sum(skuLoss, x => x.income))} ₴`)}</div>` : ''}

    <div style="margin-top:12px">
      ${card('Клієнти: факт по звіту', dataTable('tPf', colsP, byP, { sort: 'rev' }))}
    </div>

    <div style="margin-top:12px">
      ${card('Номенклатура по клієнтах', dataTable('tPfSku', colsS, roll(L3, r => r.partner + ' · ' + r.sku), { sort: 'rev', limit: 300 }))}
    </div>`;

  el('pfMonth').onchange = e => { APP.profitMonth = e.target.value; render(); };

  const top = byP.slice(0, 12);
  chart('cPfBridge', {
    data: {
      labels: top.map(p => p.key.length > 22 ? p.key.slice(0, 21) + '…' : p.key),
      datasets: [
        { type: 'bar', label: 'Рентабельність продажу, %', data: top.map(p => p.ros), backgroundColor: '#6F8FD0', borderRadius: 1 },
        { type: 'bar', label: 'Рентабельність загальна, %', data: top.map(p => p.roTotal), backgroundColor: '#E8A33D', borderRadius: 1 },
        {
          type: 'line', label: 'Маркетинг, % виручки', data: top.map(p => p.mktPct),
          borderColor: '#D9563F', borderWidth: 2, pointRadius: 3, tension: .25
        }
      ]
    },
    options: {
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 9 }, maxRotation: 45, minRotation: 45 } },
        y: AX.yPct
      },
      plugins: { tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${n1(c.parsed.y)}%` } } }
    }
  });

  const t2 = byP.slice(0, 12);
  chart('cPfMkt', {
    type: 'bar',
    data: {
      labels: t2.map(p => p.key.length > 22 ? p.key.slice(0, 21) + '…' : p.key),
      datasets: [
        { label: 'Маркетинг покупці', data: t2.map(p => p.rev ? p.mktBuyers / p.rev * 100 : 0), backgroundColor: '#E8A33D' },
        { label: 'Маркетинг постачальники', data: t2.map(p => p.rev ? p.mktSuppliers / p.rev * 100 : 0), backgroundColor: '#55A99B' },
        { label: 'Разовий маркетинг', data: t2.map(p => p.rev ? p.oneBuyers / p.rev * 100 : 0), backgroundColor: '#B07AB4' },
        { label: 'Тариф доставки', data: t2.map(p => p.rev ? p.delivery / p.rev * 100 : 0), backgroundColor: '#6F8FD0' }
      ]
    },
    options: {
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { font: { size: 9 }, maxRotation: 45, minRotation: 45 } },
        y: { stacked: true, grid: { color: '#221D18' }, ticks: { callback: v => v + '%' } }
      },
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 10 } } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${n1(c.parsed.y)}%` } }
      }
    }
  });
  bindTables();
}
