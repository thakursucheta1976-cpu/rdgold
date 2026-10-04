// Live rates engine.
// Spot: gold-api.com (free, real-time XAU/XAG). FX: open.er-api.com (free USDINR).
// Formula: INR/10g = (XAUUSD/31.1035) * USDINR * 10 * purity * (1+duty%) + spread
// GST (3%) is applied on invoices, shown separately.
import db, { getSetting } from './db.js';

const TROY_OZ = 31.1035;
const state = {
  xauusd: null, xagusd: null, usdinr: null,
  updatedAt: 0, fxUpdatedAt: 0,
  stale: true,
  simulate: process.env.SIMULATE_RATES === '1'
};

async function fetchJson(url, timeoutMs = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function pollSpot() {
  try {
    if (state.simulate) {
      // random walk for offline dev/testing
      state.xauusd = (state.xauusd || 2650) * (1 + (Math.random() - 0.5) * 0.0004);
      state.xagusd = (state.xagusd || 31.5) * (1 + (Math.random() - 0.5) * 0.0006);
      state.updatedAt = Date.now(); state.stale = false;
      return;
    }
    if (process.env.METALS_DEV_KEY) {
      // paid/accurate path: metals.dev includes MCX/IBJA + currency in one call
      const j = await fetchJson(`https://api.metals.dev/v1/latest?api_key=${process.env.METALS_DEV_KEY}&currency=USD&unit=toz`);
      if (j?.metals?.gold) state.xauusd = j.metals.gold;
      if (j?.metals?.silver) state.xagusd = j.metals.silver;
      if (j?.currencies?.INR) { state.usdinr = 1 / j.currencies.INR; state.fxUpdatedAt = Date.now(); }
    } else {
      // free path: gold-api.com (unlimited, no key)
      const [xau, xag] = await Promise.all([
        fetchJson('https://api.gold-api.com/price/XAU'),
        fetchJson('https://api.gold-api.com/price/XAG')
      ]);
      if (xau?.price) state.xauusd = xau.price;
      if (xag?.price) state.xagusd = xag.price;
    }
    state.updatedAt = Date.now();
    state.stale = false;
  } catch (e) {
    if (Date.now() - state.updatedAt > 120_000) state.stale = true;
    console.error('[rates] spot poll failed:', e.message);
  }
}

async function pollFx() {
  try {
    if (state.simulate) { state.usdinr = (state.usdinr || 84.2) * (1 + (Math.random() - 0.5) * 0.0002); state.fxUpdatedAt = Date.now(); return; }
    let inr = null;
    try {
      const j = await fetchJson('https://open.er-api.com/v6/latest/USD');
      inr = j?.rates?.INR;
    } catch {}
    if (!inr) { // fallback FX provider
      const j2 = await fetchJson('https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR');
      inr = j2?.rates?.INR;
    }
    if (inr) { state.usdinr = inr; state.fxUpdatedAt = Date.now(); }
  } catch (e) {
    console.error('[rates] fx poll failed:', e.message);
  }
}

export function baseInr(metal, purity, grams) {
  if (state.xauusd == null || state.usdinr == null || (metal === 'silver' && state.xagusd == null)) return null;
  const duty = parseFloat(getSetting('duty_pct') || '6') / 100;
  const usd = metal === 'gold' ? state.xauusd : state.xagusd;
  const spreadKey = metal === 'gold' ? 'global_spread_gold' : 'global_spread_silver';
  const spread = parseFloat(getSetting(spreadKey) || '0');
  const perUnitSpread = metal === 'gold' ? spread * (grams / 10) : spread * (grams / 1000);
  return (usd / TROY_OZ) * state.usdinr * grams * purity * (1 + duty) + perUnitSpread;
}

// Rates for one product, optionally personalized for a user (per-client premium).
export function productRates(product, user = null) {
  const base = baseInr(product.metal, product.purity, product.unit_grams);
  if (base == null) return null;
  let clientPrem = 0;
  if (user) {
    clientPrem = product.metal === 'gold'
      ? (user.premium_gold || 0) * (product.unit_grams / 10)
      : (user.premium_silver || 0) * (product.unit_grams / 1000);
  }
  const buyRate = Math.round(base + product.sell_premium + clientPrem);   // client buys at this
  const sellRate = Math.round(base - product.buy_premium + clientPrem);   // client sells at this
  return { buyRate, sellRate };
}

export function snapshot(user = null) {
  const products = db.prepare('SELECT * FROM products WHERE active=1').all();
  return {
    ts: state.updatedAt,
    stale: state.stale || (Date.now() - state.updatedAt > 120_000),
    marketOpen: getSetting('market_open') === 'true',
    spot: { xauusd: state.xauusd, xagusd: state.xagusd, usdinr: state.usdinr },
    gstPct: parseFloat(getSetting('gst_pct') || '3'),
    products: products.map(p => {
      const r = productRates(p, user);
      return { code: p.code, name: p.name, metal: p.metal, unit: p.unit,
               minQty: p.min_qty, maxQty: p.max_qty,
               buy: r ? r.buyRate : null, sell: r ? r.sellRate : null };
    })
  };
}

let listeners = [];
export function onTick(fn) { listeners.push(fn); }

const histStmt = db.prepare('INSERT INTO rate_history(ts,xauusd,xagusd,usdinr,gold_inr_10g,silver_inr_kg) VALUES (?,?,?,?,?,?)');
let lastHist = 0;

export function startRatesEngine({ spotMs = 5000, fxMs = 60000 } = {}) {
  pollSpot(); pollFx();
  setInterval(pollSpot, spotMs);
  setInterval(pollFx, fxMs);
  setInterval(() => {
    if (state.xauusd == null) return;
    for (const fn of listeners) { try { fn(); } catch {} }
    if (Date.now() - lastHist > 60_000) {
      lastHist = Date.now();
      histStmt.run(Date.now(), state.xauusd, state.xagusd, state.usdinr,
        baseInr('gold', 0.999, 10), baseInr('silver', 0.999, 1000));
    }
  }, 2000);
}

export { state as rateState };
