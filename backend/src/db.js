// Storage. With TURSO_DATABASE_URL set, the database lives on Turso and survives
// every restart, redeploy and sleep. Without it, a local file (dev + tests).
import Database from 'libsql';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TURSO = process.env.TURSO_DATABASE_URL;
if (TURSO && !process.env.TURSO_AUTH_TOKEN) {
  console.error('FATAL: TURSO_DATABASE_URL is set but TURSO_AUTH_TOKEN is empty.');
  console.error('       Paste the token from Turso into TURSO_AUTH_TOKEN, or clear');
  console.error('       TURSO_DATABASE_URL to go back to the local database.');
  process.exit(1);
}
const db = TURSO
  ? new Database(TURSO, { authToken: process.env.TURSO_AUTH_TOKEN })
  : new Database(process.env.DB_PATH || path.join(__dirname, '..', 'bullion.db'));
console.log(TURSO ? `[db] Turso: ${TURSO.replace(/\/\/.*@/, '//')}` : '[db] local file');

// libsql attaches a _metadata field to every row; keep it out of API responses.
const _prepare = db.prepare.bind(db);
const strip = r => { if (r && typeof r === 'object') delete r._metadata; return r; };
db.prepare = (sql) => {
  const st = _prepare(sql);
  const g = st.get.bind(st), a = st.all.bind(st);
  st.get = (...args) => strip(g(...args));
  st.all = (...args) => { const rows = a(...args); rows.forEach(strip); return rows; };
  return st;
};
if (!TURSO) db.pragma('journal_mode = WAL');
// Turso rejects some pragmas; never let one stop the server booting.
try { db.pragma('foreign_keys = ON'); }
catch (e) { console.warn('[db] foreign_keys pragma skipped:', e.message); }

db.exec(`
CREATE TABLE IF NOT EXISTS logins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  ip TEXT,
  agent TEXT,
  ok INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'trader',         -- trader | admin
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | active | blocked (admin approves KYC)
  kyc_pan TEXT, kyc_gst TEXT, kyc_city TEXT,
  margin_limit REAL NOT NULL DEFAULT 0,        -- max open exposure in INR
  premium_gold REAL NOT NULL DEFAULT 0,        -- per-client premium override (INR per 10g, +/-)
  premium_silver REAL NOT NULL DEFAULT 0,      -- per-client premium override (INR per kg, +/-)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,                   -- GOLD995, GOLD999, SILVER999 ...
  name TEXT NOT NULL,
  metal TEXT NOT NULL,                         -- gold | silver
  purity REAL NOT NULL,                        -- 0.995, 0.999
  unit TEXT NOT NULL,                          -- "10g" | "1kg"
  unit_grams REAL NOT NULL,                    -- 10 or 1000
  min_qty REAL NOT NULL DEFAULT 1,
  max_qty REAL NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1,
  sell_premium REAL NOT NULL DEFAULT 0,        -- dealer premium added when CLIENT BUYS (INR per unit)
  buy_premium REAL NOT NULL DEFAULT 0          -- dealer discount when CLIENT SELLS (INR per unit, subtracted)
);
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,                         -- uuid
  user_id INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  side TEXT NOT NULL,                          -- buy | sell (client's side)
  rate REAL NOT NULL,                          -- locked INR per unit (ex-GST)
  qty REAL NOT NULL,
  expires_at INTEGER NOT NULL,                 -- epoch ms
  used INTEGER NOT NULL DEFAULT 0,
  gst_pct REAL                                 -- GST % locked at quote time
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  side TEXT NOT NULL,                          -- buy | sell
  type TEXT NOT NULL,                          -- market | limit
  qty REAL NOT NULL,
  rate REAL,                                   -- executed rate (market) / trigger rate (limit)
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | executed | cancelled | rejected | delivered
  idempotency_key TEXT,
  quote_id TEXT,
  gst_amount REAL,
  total_amount REAL,                           -- rate*qty (+gst on buy)
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  executed_at TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  product_code TEXT NOT NULL,
  direction TEXT NOT NULL,                     -- above | below
  target_rate REAL NOT NULL,
  triggered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  xauusd REAL, xagusd REAL, usdinr REAL,
  gold_inr_10g REAL, silver_inr_kg REAL
);
CREATE INDEX IF NOT EXISTS idx_rate_history_ts ON rate_history(ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idem ON orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
`);

// seed defaults
const set = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)');
set.run('duty_pct', '6');            // import duty
set.run('cash_gold_rate', '0');      // dealer's own cash rate, 0 = not published
set.run('cash_gold_995_rate', '0'); // optional: own rate for 995, else scaled from 999
set.run('cash_silver_rate', '0');
set.run('gst_pct', '3');
set.run('global_spread_gold', '0');  // INR per 10g adjustment to track MCX
set.run('global_spread_silver', '0');
set.run('margin_gold', '0');     // dealer's own profit, INR per 10g (buy above / sell below)
set.run('margin_silver', '0');   // same, INR per kg
set.run('market_open', 'true');
set.run('price_basis', 'auto');  // auto | mcx | india (NSE anchor) | spot

set.run('dealer_phone', '');         // number clients call / WhatsApp to book

const seedProducts = db.prepare(`INSERT OR IGNORE INTO products
  (code,name,metal,purity,unit,unit_grams,min_qty,max_qty,sell_premium,buy_premium)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);
seedProducts.run('GOLD999', 'Gold 999 (10g)', 'gold', 0.999, '10g', 10, 1, 1000, 150, 100);
seedProducts.run('GOLD995', 'Gold 995 (10g)', 'gold', 0.995, '10g', 10, 1, 1000, 100, 80);
seedProducts.run('SILVER999', 'Silver 999 (1kg)', 'silver', 0.999, '1kg', 1000, 1, 500, 300, 200);


// Orders are booked on the phone now, so there is no kill-switch to flip:
// the market is always open as far as the app is concerned.
// A remote database can end up with more than one row for the same setting
// (the table was created without the key constraint at some point). A plain
// "SELECT key, value" then hands back whichever row comes last, so a freshly
// saved rate looks saved and then vanishes. Keep only the newest row per key.
try {
  const before = db.prepare('SELECT COUNT(*) c FROM settings').get().c;
  const keys   = db.prepare('SELECT COUNT(DISTINCT key) c FROM settings').get().c;
  if (before > keys) {
    db.prepare('DELETE FROM settings WHERE rowid NOT IN (SELECT MAX(rowid) FROM settings GROUP BY key)').run();
    const after = db.prepare('SELECT COUNT(*) c FROM settings').get().c;
    console.log(`[db] cleaned duplicate settings rows: ${before} -> ${after} (${keys} keys)`);
  } else {
    console.log(`[db] settings rows ${before}, keys ${keys} — no duplicates`);
  }
} catch (e) { console.error('[db] could not clean settings:', e.message); }

try {
  const r = db.prepare("UPDATE settings SET value='true' WHERE key='market_open'").run();
  if (!r.changes) db.prepare("INSERT INTO settings(key,value) VALUES('market_open','true')").run();
  const rows = db.prepare("SELECT value FROM settings WHERE key='market_open'").all();
  console.log('[db] market_open =', rows.map(x => x.value).join('/') || 'missing');
} catch (e) { console.error('[db] could not force market_open:', e.message); }

// The dealer's buy/sell gap is set in the admin panel now, so the old
// per-product premiums must not be added on top of it.
try { db.prepare('UPDATE products SET sell_premium=0, buy_premium=0').run(); } catch {}

// --- migrations: columns added after the first release ---
const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!cols.includes('last_login'))  db.exec("ALTER TABLE users ADD COLUMN last_login TEXT");
if (!cols.includes('login_count')) db.exec("ALTER TABLE users ADD COLUMN login_count INTEGER NOT NULL DEFAULT 0");
if (!cols.includes('email'))       db.exec("ALTER TABLE users ADD COLUMN email TEXT");
if (!cols.includes('address'))     db.exec("ALTER TABLE users ADD COLUMN address TEXT");
// one account = one phone = one device. device_id is the handset the account is locked to.
if (!cols.includes('device_id'))   db.exec("ALTER TABLE users ADD COLUMN device_id TEXT");
if (!cols.includes('device_name')) db.exec("ALTER TABLE users ADD COLUMN device_name TEXT");
if (!cols.includes('device_at'))   db.exec("ALTER TABLE users ADD COLUMN device_at TEXT");

export default db;
// Settings are read many times per second (every rate tick, for every product).
// On a remote database each read is a network round trip, so keep them in memory
// and refresh briefly; writes update the cache immediately.
let _settings = null, _settingsAt = 0;
const SETTINGS_TTL_MS = 5000;

// Reading the settings table has to survive whatever shape the driver hands
// back. On the remote database the rows did not come through as plain
// {key, value} objects, so every setting silently fell back to its default:
// the cash rate vanished, the market looked shut, nothing the admin typed stuck.
function readSettingRows(sql, args = []) {
  const rows = db.prepare(sql).all(...args);
  const out = [];
  for (const r of rows) {
    let k, v;
    if (Array.isArray(r)) { k = r[0]; v = r[1]; }
    else { k = r.k ?? r.key ?? r.KEY ?? r.Key; v = r.v ?? r.value ?? r.VALUE ?? r.Value; }
    if (k != null) out.push([String(k), v == null ? null : String(v)]);
  }
  return out;
}

function loadSettings() {
  const pairs = readSettingRows('SELECT key AS k, value AS v FROM settings');
  if (!pairs.length) console.error('[db] WARNING: settings table read came back empty or unreadable');
  _settings = Object.fromEntries(pairs);
  _settingsAt = Date.now();
}

export function getSetting(key) {
  if (!_settings || Date.now() - _settingsAt > SETTINGS_TTL_MS) loadSettings();
  return key in _settings ? _settings[key] : null;
}

export function setSetting(key, value) {
  const want = String(value);
  // update first; insert only when the key is genuinely missing. This can never
  // add a second row for a key, whatever the table's constraints are.
  const r = db.prepare('UPDATE settings SET value=? WHERE key=?').run(want, key);
  if (!r.changes) db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(key, want);

  // verify through the same query the app reads with, so a duplicate row or a
  // write the database quietly dropped shows up as an error instead of a value
  // that looks saved and disappears a few seconds later.
  const rows = readSettingRows('SELECT key AS k, value AS v FROM settings WHERE key=?', [key]);
  const got = rows.length ? rows[rows.length - 1][1] : null;
  if (got !== want) {
    _settings = null;
    throw new Error(`the database did not keep ${key} (wanted "${want}", it has "${got}"${rows.length > 1 ? `, ${rows.length} rows` : ''})`);
  }
  if (_settings) _settings[key] = want;
  return want;
}

// what the database actually holds right now, cache bypassed
export function getSettingFresh(key) {
  const rows = readSettingRows('SELECT key AS k, value AS v FROM settings WHERE key=?', [key]);
  return rows.length ? rows[rows.length - 1][1] : null;
}

// how many settings the app can actually read back — used by the health check
export function settingsReadCount() {
  try { return readSettingRows('SELECT key AS k, value AS v FROM settings').length; }
  catch { return -1; }
}
export function clearSettingsCache() { _settings = null; }
