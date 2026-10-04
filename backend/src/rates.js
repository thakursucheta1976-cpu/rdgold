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

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: c.signal, headers: opts.headers });
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

    // --- free intraday USD/INR, no key needed ---
    // Yahoo's chart feed carries the spot price and the minute it was quoted.
    // FX trades round the clock Monday to Friday, so a quote more than a few
    // hours old means the market is shut (weekend) rather than the feed being broken.
    try {
      const j = await fetchJson(
        'https://query1.finance.yahoo.com/v8/finance/chart/USDINR=X?interval=1d&range=1d',
        { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RDgold/1.0)' } });
      const m = j?.chart?.result?.[0]?.meta;
      const v = parseFloat(m?.regularMarketPrice);
      if (v > 0 && v > 50 && v < 200) {              // sanity: USD/INR is nowhere near these edges
        const quotedAt = m.regularMarketTime ? m.regularMarketTime * 1000 : Date.now();
        state.usdinr = v;
        state.fxUpdatedAt = Date.now();
        state.fxQuotedAt = quotedAt;
        state.fxSource = 'yahoo';
        // live if the quote itself is fresh; stale quotes are normal at weekends
        state.fxLive = (Date.now() - quotedAt) < 30 * 60_000;
        return;
      }
    } catch (e) { console.error('[rates] yahoo fx failed:', e.message); }

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

// Which number the rupee price is built on: MCX when the exchange is quoting,
// otherwise international spot converted at the live USD/INR.
// tests inject an exchange snapshot here instead of hitting the network
export function __setMcxForTest(m) { state.mcx = m; state.mcxMovedAt = Date.now(); }
export function __setIbjaForTest(b) { state.ibja = b; }

export function priceBasis() {
  // auto = the exchange when we can reach it, otherwise international spot.
  // The NSE-ETF anchor is never picked on its own: an ETF carries its own
  // premium and tracking error, so it is only used if the dealer asks for it.
  const want = getSetting('price_basis') || 'auto';   // 'auto' | 'mcx' | 'india' | 'spot'
  if (want === 'spot') return 'spot';
  const mcxFresh = state.mcx && (Date.now() - state.mcx.at) < 10 * 60_000 && state.mcx.gold;
  if (mcxFresh && (want === 'auto' || want === 'mcx')) return 'mcx';
  // 'mcx' asked for but the exchange is unreachable: use the Indian benchmark
  // before falling all the way back to the international price
  if ((want === 'auto' || want === 'india' || want === 'mcx') && indianLive('gold') != null) return 'india';
  return 'spot';
}

export function baseInr(metal, purity, grams) {
  const spreadKey = metal === 'gold' ? 'global_spread_gold' : 'global_spread_silver';
  const spread = parseFloat(getSetting(spreadKey) || '0');
  const perUnitSpread = metal === 'gold' ? spread * (grams / 10) : spread * (grams / 1000);

  const basis = priceBasis();

  if (basis === 'india') {
    // already a rupee rate for 999 gold per 10g / 999 silver per kg
    const implied = indianLive(metal);
    if (implied != null) {
      const perUnit = metal === 'gold' ? grams / 10 : grams / 1000;
      const ref = 0.999;
      return implied * perUnit * (purity / ref) + perUnitSpread;
    }
  }

  if (basis === 'mcx') {
    // MCX quotes gold per 10g and silver per kg, in rupees, already landed —
    // duty and the dollar are inside that number, so nothing is added here.
    const m = metal === 'gold' ? state.mcx.gold : state.mcx.silver;
    if (m) {
      const perUnit = metal === 'gold' ? grams / 10 : grams / 1000;
      // MCX gold contracts are 995 purity; silver is 999
      const contractPurity = metal === 'gold' ? 0.995 : 0.999;
      return m.price * perUnit * (purity / contractPurity) + perUnitSpread;
    }
  }

  if (state.xauusd == null || state.usdinr == null || (metal === 'silver' && state.xagusd == null)) return null;
  const duty = parseFloat(getSetting('duty_pct') || '6') / 100;
  const usd = metal === 'gold' ? state.xauusd : state.xagusd;
  return (usd / TROY_OZ) * state.usdinr * grams * purity * (1 + duty) + perUnitSpread;
}

// Rates for one product, optionally personalized for a user (per-client premium).
export function productRates(product, user = null) {
  const base = baseInr(product.metal, product.purity, product.unit_grams);
  if (base == null) return null;
  const perUnit = product.metal === 'gold' ? product.unit_grams / 10 : product.unit_grams / 1000;

  // the dealer's own profit: the client buys above the rate and sells below it
  const marginKey = product.metal === 'gold' ? 'margin_gold' : 'margin_silver';
  const margin = parseFloat(getSetting(marginKey) || '0') * perUnit;

  let clientPrem = 0;
  if (user) {
    clientPrem = product.metal === 'gold'
      ? (user.premium_gold || 0) * (product.unit_grams / 10)
      : (user.premium_silver || 0) * (product.unit_grams / 1000);
  }
  const buyRate  = Math.round(base + margin + product.sell_premium + clientPrem);
  const sellRate = Math.round(base - margin - product.buy_premium + clientPrem);
  return { buyRate, sellRate };
}

// The product list barely changes but is read on every tick; cache it briefly too.
let _products = null, _productsAt = 0;
function activeProducts() {
  if (!_products || Date.now() - _productsAt > 5000) {
    _products = db.prepare('SELECT * FROM products WHERE active=1').all();
    _productsAt = Date.now();
  }
  return _products;
}

export function snapshot(user = null) {
  const products = activeProducts();
  return {
    ts: state.updatedAt,
    stale: state.stale || (Date.now() - state.updatedAt > 120_000),
    marketOpen: getSetting('market_open') === 'true',
    spot: { xauusd: state.xauusd, xagusd: state.xagusd, usdinr: state.usdinr },
    spotAgeMs: state.updatedAt ? Date.now() - state.updatedAt : null,
    fx: { source: state.fxSource, live: state.fxLive,
          ageMs: state.fxQuotedAt ? Date.now() - state.fxQuotedAt
               : (state.fxUpdatedAt ? Date.now() - state.fxUpdatedAt : null),
          // a daily reference rate older than 26h means the publisher skipped an update
          stale: !state.fxLive && !!state.fxUpdatedAt && (Date.now() - state.fxUpdatedAt > 26*3600_000) },
    gstPct: parseFloat(getSetting('gst_pct') || '3'),
    // where each number comes from, and whether a second source agrees
    sources: {
      basis: priceBasis(),
      metals: state.simulate ? 'simulated'
            : (process.env.METALS_DEV_KEY ? 'metals.dev' : 'gold-api.com'),
      fx: state.fxSource,
      mcx: state.mcx ? {
        gold: state.mcx.gold, silver: state.mcx.silver,
        ageMs: Date.now() - state.mcx.at,
        movedMsAgo: state.mcxMovedAt ? Date.now() - state.mcxMovedAt : null
      } : null,
      mcxError: state.mcxError || null,
      india: state.ibja ? {
        benchmark: 'IBJA', published: state.ibja.published,
        ibjaGold999: state.ibja.gold999, ibjaGold995: state.ibja.gold995, ibjaSilver: state.ibja.silver,
        liveGold: indianLive('gold') ? Math.round(indianLive('gold')) : null,
        liveSilver: indianLive('silver') ? Math.round(indianLive('silver')) : null,
        ageMs: Date.now() - state.ibja.at
      } : null,
      indiaError: state.ibjaError || null,
      crossCheck: state.check || null,
      suspect: !!state.suspect
    },
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
               spotUsd: p.metal === 'gold' ? state.xauusd : state.xagusd,
               // the dealer's own cash rate, typed in by the admin. 0 means not published.
               cash: (() => {
                 const per = p.metal === 'gold' ? p.unit_grams / 10 : p.unit_grams / 1000;
                 // 995 gold can have its own typed rate; if the admin leaves it blank
                 // it is scaled down from the 999 rate.
                 if (p.metal === 'gold' && Math.abs(p.purity - 0.995) < 0.0005) {
                   const own = parseFloat(getSetting('cash_gold_995_rate') || '0');
                   if (own > 0) return Math.round(own * per);
                 }
                 const v = parseFloat(getSetting(
                   p.metal === 'gold' ? 'cash_gold_rate' : 'cash_silver_rate') || '0');
                 if (!(v > 0)) return null;
                 return Math.round(v * per * (p.purity / 0.999));
               })() };
    })
  };
}

let listeners = [];
export function onTick(fn) { listeners.push(fn); }

const histStmt = db.prepare('INSERT INTO rate_history(ts,xauusd,xagusd,usdinr,gold_inr_10g,silver_inr_kg) VALUES (?,?,?,?,?,?)');
let lastHist = 0;


// ---------------------------------------------------------------------------
// MCX — the official Indian exchange. Gold and silver futures in rupees, live
// through the trading session (about 9am to 11:30pm IST, Monday to Friday).
// This is what Indian dealers actually quote against, so it is pulled straight
// rather than worked out from dollars.
// ---------------------------------------------------------------------------
async function fetchMcx() {
  const BROWSER = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br'
  };
  // the exchange's edge rejects a bare request, so do what a browser does:
  // load the page first, keep its cookies, then call the feed the page calls.
  let cookie = state.mcxCookie || '';
  if (!cookie) {
    const page = await fetch('https://www.mcxindia.com/market-data/market-watch', {
      headers: { ...BROWSER, 'Accept': 'text/html,application/xhtml+xml' }
    });
    const set = page.headers.getSetCookie ? page.headers.getSetCookie() : [];
    cookie = set.map(c => c.split(';')[0]).join('; ');
    if (cookie) state.mcxCookie = cookie;
    if (!page.ok && !cookie) throw new Error('page HTTP ' + page.status);
  }
  const r = await fetch('https://www.mcxindia.com/backpage.aspx/GetMarketWatch', {
    method: 'POST',
    headers: {
      ...BROWSER,
      'Content-Type': 'application/json; charset=UTF-8',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://www.mcxindia.com/market-data/market-watch',
      'Origin': 'https://www.mcxindia.com',
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: '{}'
  });
  if (!r.ok) { state.mcxCookie = null; throw new Error('HTTP ' + r.status); }
  const j = await r.json();
  const rows = typeof j.d === 'string' ? JSON.parse(j.d) : (j.d || []);
  const pick = (symbol) => rows
    .filter(x => x.Symbol === symbol && x.InstrumentName === 'FUTCOM' && Number(x.LTP) > 0)
    .sort((a, b) => new Date(a.ExpiryDate) - new Date(b.ExpiryDate))[0];
  const gold = pick('GOLD') || pick('GOLDM');
  const silver = pick('SILVER') || pick('SILVERM');
  if (!gold && !silver) throw new Error('no gold or silver rows');
  return {
    gold:   gold   ? { price: Number(gold.LTP),   contract: `${gold.Symbol} ${gold.ExpiryDate}` }     : null,
    silver: silver ? { price: Number(silver.LTP), contract: `${silver.Symbol} ${silver.ExpiryDate}` } : null,
    at: Date.now()
  };
}

async function pollMcx() {
  if (state.simulate) return;
  try {
    const m = await fetchMcx();
    // sanity: gold per 10g and silver per kg live in known ranges. A number far
    // outside them means the feed changed shape, not that the price moved.
    if (m.gold && (m.gold.price < 20000 || m.gold.price > 2000000)) m.gold = null;
    if (m.silver && (m.silver.price < 20000 || m.silver.price > 5000000)) m.silver = null;
    if (!m.gold && !m.silver) throw new Error('values out of range');
    if (m.gold && state.mcx?.gold?.price !== m.gold.price) state.mcxMovedAt = Date.now();
    state.mcx = m;
    state.mcxError = null;
  } catch (e) {
    state.mcxError = e.message;
    console.error('[rates] mcx poll failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// IBJA — the India Bullion and Jewellers Association benchmark, the rate banks
// and NBFCs price gold against. It is published twice a day (AM and PM), so it
// sets the LEVEL; the live international feed supplies the movement in between.
// Together: an Indian rate that is correct at the benchmark and ticks live.
// ---------------------------------------------------------------------------
const TROY = 31.1034768;
const num = (t) => parseFloat(String(t).replace(/,/g, ''));

export function parseIbja(html) {
  const text = String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;?/gi, ' ')
    .replace(/\s+/g, ' ');
  const per10g = (purity) => {
    const m = text.match(new RegExp(purity + '\\s*Purity\\s*([\\d,]+)\\s*\\(\\s*1\\s*Gram'));
    return m ? Math.round(num(m[1]) * 10) : null;
  };
  const gold999 = per10g('999'), gold995 = per10g('995');
  // the history table reads: date | 999 | 995 | 916 | 750 | 585 | Silver 999 | Platinum
  const row = text.match(/(\d{2}\/\d{2}\/\d{4})\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)/);
  const silver = row ? Math.round(num(row[7])) : null;
  const when = text.match(/(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}\s+[AP]M)/);
  if (!gold999 && !silver) return null;
  // sanity: a 10g gold rate and a 1kg silver rate live in known ranges
  return {
    gold999: gold999 > 20000 && gold999 < 2000000 ? gold999 : null,
    gold995: gold995 > 20000 && gold995 < 2000000 ? gold995 : null,
    silver:  silver  > 20000 && silver  < 5000000 ? silver  : null,
    published: when ? when[1] : null
  };
}

// what 10g of pure gold / 1kg of pure silver costs on the international market
// right now, in rupees, before any Indian duty or premium
function intlInr(metal) {
  if (state.usdinr == null) return null;
  if (metal === 'gold')   return state.xauusd == null ? null : (state.xauusd / TROY) * state.usdinr * 10;
  return state.xagusd == null ? null : (state.xagusd / TROY) * state.usdinr * 1000;
}

async function pollIbja() {
  if (state.simulate) return;
  try {
    const r = await fetch('https://www.ibjarates.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
                 'Accept': 'text/html,application/xhtml+xml' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const parsed = parseIbja(await r.text());
    if (!parsed) throw new Error('could not read the rates board');

    // lock the gap between the benchmark and the international price at this moment
    const ig = intlInr('gold'), is = intlInr('silver');
    state.ibja = {
      ...parsed,
      at: Date.now(),
      offsetGold:   parsed.gold999 != null && ig != null ? parsed.gold999 - ig : (state.ibja?.offsetGold ?? null),
      offsetSilver: parsed.silver  != null && is != null ? parsed.silver  - is : (state.ibja?.offsetSilver ?? null)
    };
    state.ibjaError = null;
  } catch (e) {
    state.ibjaError = e.message;
  }
}

// the Indian rate right now: benchmark level + live international movement
export function indianLive(metal) {
  const intl = intlInr(metal);
  if (intl == null || !state.ibja) return null;
  let o = metal === 'gold' ? state.ibja.offsetGold : state.ibja.offsetSilver;
  if (o == null) {
    // the benchmark may have arrived before the international feed did —
    // lock the gap the first moment both are in hand
    const bench = metal === 'gold' ? state.ibja.gold999 : state.ibja.silver;
    if (bench == null) return null;
    o = bench - intl;
    if (metal === 'gold') state.ibja.offsetGold = o; else state.ibja.offsetSilver = o;
  }
  if (Date.now() - (state.ibja?.at || 0) > 36 * 3600_000) return null;   // benchmark too old
  return intl + o;
}

// A second, independent source so a wrong price cannot pass unnoticed.
// COMEX futures are not spot — they normally trade a little above it — so this
// is a sanity check, never a price we quote from.
async function pollCrossCheck() {
  if (state.simulate) return;
  const grab = async (sym) => {
    const j = await fetchJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RDgold/1.0)' } });
    const m = j?.chart?.result?.[0]?.meta;
    const v = parseFloat(m?.regularMarketPrice);
    return v > 0 ? { price: v, at: m.regularMarketTime ? m.regularMarketTime * 1000 : Date.now() } : null;
  };
  try {
    const [g, si] = await Promise.all([grab('GC=F').catch(() => null), grab('SI=F').catch(() => null)]);
    const gap = (a, b) => (a && b) ? Math.abs(a - b) / b : null;
    state.check = {
      source: 'COMEX futures (GC=F / SI=F)',
      gold: g ? g.price : null, silver: si ? si.price : null,
      at: g ? g.at : null,
      goldGapPct: g && state.xauusd ? +(gap(g.price, state.xauusd) * 100).toFixed(2) : null,
      silverGapPct: si && state.xagusd ? +(gap(si.price, state.xagusd) * 100).toFixed(2) : null
    };
    // futures sit within a few percent of spot. A bigger gap means one of the
    // two feeds is wrong, and a wrong feed must never look confident.
    state.suspect = (state.check.goldGapPct != null && state.check.goldGapPct > 4) ||
                    (state.check.silverGapPct != null && state.check.silverGapPct > 6);
    if (state.suspect) console.error('[rates] feeds disagree:', JSON.stringify(state.check));
  } catch (e) { console.error('[rates] cross-check failed:', e.message); }
}

export function startRatesEngine({ spotMs = 1000, fxMs = 60000, tickMs = 1000 } = {}) {
  pollSpot(); pollFx(); pollCrossCheck(); pollMcx(); pollIbja();
  setInterval(pollSpot, spotMs);
  setInterval(pollFx, fxMs);
  setInterval(pollCrossCheck, 60_000);
  setInterval(pollMcx, 5_000);          // the exchange moves all session; keep up with it
  setInterval(pollIbja, 10 * 60_000);   // the benchmark changes twice a day
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
