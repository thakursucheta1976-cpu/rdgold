// Live rates engine.
// Spot: gold-api.com (free, real-time XAU/XAG). FX: open.er-api.com (free USDINR).
// Formula: INR/10g = (XAUUSD/31.1035) * USDINR * 10 * purity * (1+duty%) + spread
// GST (3%) is applied on invoices, shown separately.
import db, { getSetting } from './db.js';

const TROY_OZ = 31.1035;
const state = {
  xauusd: null, xagusd: null, usdinr: null,
  updatedAt: 0, fxUpdatedAt: 0,
  fxSource: null, fxLive: false,
  xauMovedAt: 0, xagMovedAt: 0, feedUpdatedAt: null,
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
      state.xauMovedAt = state.xagMovedAt = Date.now();
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
      if (xau?.price) {
        if (xau.price !== state.xauusd) state.xauMovedAt = Date.now();
        state.xauusd = xau.price;
        state.feedUpdatedAt = xau.updatedAt || null;
      }
      if (xag?.price) {
        if (xag.price !== state.xagusd) state.xagMovedAt = Date.now();
        state.xagusd = xag.price;
      }
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
    if (state.simulate) {
      state.usdinr = (state.usdinr || 84.2) * (1 + (Math.random() - 0.5) * 0.0002);
      state.fxUpdatedAt = Date.now(); state.fxSource = 'simulated'; state.fxLive = true; return;
    }

    // --- live providers (sub-minute). Used only if a key is configured. ---
    if (process.env.TWELVEDATA_KEY) {
      try {
        const j = await fetchJson(`https://api.twelvedata.com/price?symbol=USD/INR&apikey=${process.env.TWELVEDATA_KEY}`);
        const v = parseFloat(j?.price);
        if (v > 0) { state.usdinr = v; state.fxUpdatedAt = Date.now(); state.fxSource = 'twelvedata'; state.fxLive = true; return; }
      } catch (e) { console.error('[rates] twelvedata fx failed:', e.message); }
    }
    if (process.env.METALS_DEV_KEY) {
      try {
        const j = await fetchJson(`https://api.metals.dev/v1/latest?api_key=${process.env.METALS_DEV_KEY}&currency=USD&unit=toz`);
        if (j?.currencies?.INR) {
          state.usdinr = 1 / j.currencies.INR; state.fxUpdatedAt = Date.now();
          state.fxSource = 'metals.dev'; state.fxLive = true; return;
        }
      } catch (e) { console.error('[rates] metals.dev fx failed:', e.message); }
    }

    // --- fallback: central-bank reference rates. These publish ONCE A DAY. ---
    let inr = null;
    try { inr = (await fetchJson('https://open.er-api.com/v6/latest/USD'))?.rates?.INR; } catch {}
    if (!inr) {
      try { inr = (await fetchJson('https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR'))?.rates?.INR; } catch {}
    }
    if (inr) {
      state.usdinr = inr; state.fxUpdatedAt = Date.now();
      state.fxSource = 'daily-reference'; state.fxLive = false;
    }
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
    spotAgeMs: state.updatedAt ? Date.now() - state.updatedAt : null,
    fx: { source: state.fxSource, live: state.fxLive,
          ageMs: state.fxUpdatedAt ? Date.now() - state.fxUpdatedAt : null,
          // a daily reference rate older than 26h means the publisher skipped an update
          stale: !state.fxLive && !!state.fxUpdatedAt && (Date.now() - state.fxUpdatedAt > 26*3600_000) },
    gstPct: parseFloat(getSetting('gst_pct') || '3'),
    // how long since the international price actually changed. Metals stop moving
    // when the market is shut (weekends, holidays) — that is not a stale feed.
    moved: { goldMsAgo: state.xauMovedAt ? Date.now() - state.xauMovedAt : null,
             silverMsAgo: state.xagMovedAt ? Date.now() - state.xagMovedAt : null,
             feedUpdatedAt: state.feedUpdatedAt },
    products: products.map(p => {
      const r = productRates(p, user);
      const gst = parseFloat(getSetting('gst_pct') || '3');
      return { code: p.code, name: p.name, metal: p.metal, unit: p.unit,
               minQty: p.min_qty, maxQty: p.max_qty,
               buy: r ? r.buyRate : null, sell: r ? r.sellRate : null,
               buyWithGst: r ? Math.round(r.buyRate * (1 + gst / 100)) : null,
               spotUsd: p.metal === 'gold' ? state.xauusd : state.xagusd };
    })
  };
}

let listeners = [];
export function onTick(fn) { listeners.push(fn); }

const histStmt = db.prepare('INSERT INTO rate_history(ts,xauusd,xagusd,usdinr,gold_inr_10g,silver_inr_kg) VALUES (?,?,?,?,?,?)');
let lastHist = 0;

export function startRatesEngine({ spotMs = 1000, fxMs = 60000, tickMs = 1000 } = {}) {
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
  }, tickMs);
}

export { state as rateState };
