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
set.run('cash_silver_rate', '0');
set.run('gst_pct', '3');
set.run('global_spread_gold', '0');  // INR per 10g adjustment to track MCX
set.run('global_spread_silver', '0');
set.run('market_open', 'true');      // admin kill-switch
set.run('bank_details', JSON.stringify({
  account_name: 'Your Bullion Pvt Ltd', account_no: '0000000000', ifsc: 'HDFC0000000',
  bank: 'HDFC Bank', branch: 'Mumbai', upi: '', whatsapp: '+91', phone: '+91'
}));

const seedProducts = db.prepare(`INSERT OR IGNORE INTO products
  (code,name,metal,purity,unit,unit_grams,min_qty,max_qty,sell_premium,buy_premium)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);
seedProducts.run('GOLD999', 'Gold 999 (10g)', 'gold', 0.999, '10g', 10, 1, 1000, 150, 100);
seedProducts.run('GOLD995', 'Gold 995 (10g)', 'gold', 0.995, '10g', 10, 1, 1000, 100, 80);
seedProducts.run('SILVER999', 'Silver 999 (1kg)', 'silver', 0.999, '1kg', 1000, 1, 500, 300, 200);


// --- migrations: columns added after the first release ---
const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!cols.includes('last_login'))  db.exec("ALTER TABLE users ADD COLUMN last_login TEXT");
if (!cols.includes('login_count')) db.exec("ALTER TABLE users ADD COLUMN login_count INTEGER NOT NULL DEFAULT 0");

export default db;
// Settings are read many times per second (every rate tick, for every product).
// On a remote database each read is a network round trip, so keep them in memory
// and refresh briefly; writes update the cache immediately.
let _settings = null, _settingsAt = 0;
const SETTINGS_TTL_MS = 5000;

function loadSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  _settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  _settingsAt = Date.now();
}

export function getSetting(key) {
  if (!_settings || Date.now() - _settingsAt > SETTINGS_TTL_MS) loadSettings();
  return key in _settings ? _settings[key] : null;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  if (_settings) _settings[key] = String(value);
}
