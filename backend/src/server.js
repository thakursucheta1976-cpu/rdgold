import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import db, { getSetting, setSetting, getSettingFresh, clearSettingsCache, settingsReadCount } from './db.js';
import { startRatesEngine, snapshot, productRates, onTick, rateState, calibrateEtf } from './rates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || !process.env.ADMIN_PASSWORD)) {
  console.error('FATAL: set JWT_SECRET and ADMIN_PASSWORD env vars in production');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const QUOTE_TTL_MS = 30_000;

const app = express();
app.use(express.json());
app.use('/admin', express.static(path.join(__dirname, '..', 'public')));

// ---------- CORS ----------
// The web app runs on a different origin (Pages / Cloudflare) from this API, so
// every endpoint it calls needs CORS. Authenticated routes are restricted to an
// allow-list; the public rate feed stays open so the marketing ticker works anywhere.
const PUBLIC_CORS = new Set(['/api/rates', '/api/rates/history']);
const ALLOWED = (process.env.WEB_ORIGIN || '')
  .split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean);

function originAllowed(o) {
  if (!o) return false;
  const clean = o.replace(/\/+$/, '');
  if (ALLOWED.includes(clean)) return true;
  // local development
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(clean);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const isPublic = PUBLIC_CORS.has(req.path);

  if (isPublic && (req.method === 'GET' || req.method === 'OPTIONS')) {
    res.set('Access-Control-Allow-Origin', '*');
  } else if (originAllowed(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
  } else {
    return next();                       // no CORS headers: browser blocks it
  }

  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Device-Id');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.set('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- health (Render health check) ----------
app.get('/healthz', (req, res) => {
  let rows = null, keys = null;
  try {
    rows = db.prepare('SELECT COUNT(*) c FROM settings').get().c;
    keys = db.prepare('SELECT COUNT(DISTINCT key) c FROM settings').get().c;
  } catch {}
  res.json({ ok: true, stale: rateState.stale, ts: Date.now(),
             settingsRows: rows, settingsKeys: keys,
             settingsReadable: settingsReadCount(),   // must match settingsRows
             marketOpen: getSetting('market_open') === 'true',
             marketOpenFresh: getSettingFresh('market_open') });
});

// ---------- auth ----------
function sign(u, did) { return jwt.sign({ id: u.id, role: u.role, did: did || u.device_id || null },
                                        JWT_SECRET, { expiresIn: '30d' }); }

// one account is locked to one handset. admins are exempt (they use the desk machine too).
const DEVICE_MSG = 'This account is already signed in on another phone. Ask us to reset it.';
function deviceOf(req) {
  const d = String((req.body && req.body.deviceId) || req.headers['x-device-id'] || '').trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(d) ? d : null;
}
function deviceLabel(req) {
  const a = String(req.headers['user-agent'] || '');
  const m = a.match(/\((?:Linux; )?([^);]+)/);
  return (m ? m[1] : a).slice(0, 60) || null;
}
function auth(role = null) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!tok) return res.status(401).json({ error: 'no token' });
    try {
      const p = jwt.verify(tok, JWT_SECRET);
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.id);
      if (!u || u.status === 'blocked') return res.status(403).json({ error: 'blocked' });
      if (role && u.role !== role) return res.status(403).json({ error: 'forbidden' });
      if (u.role !== 'admin' && u.device_id && p.did !== u.device_id)
        return res.status(401).json({ error: DEVICE_MSG });
      req.user = u;
      next();
    } catch { return res.status(401).json({ error: 'bad token' }); }
  };
}

const BAD_CHARS = /[<>"'&\\]/;
app.post('/api/register', (req, res) => {
  const { phone, name, password, pan, gst, city } = req.body || {};
  if (!phone || !name || !password || String(password).length < 6)
    return res.status(400).json({ error: 'phone, name, password(6+) required' });
  if ([name, pan, gst, city].some(v => v && BAD_CHARS.test(String(v))))
    return res.status(400).json({ error: 'invalid characters in name/kyc fields' });
  if (!/^[0-9+]{5,15}$/.test(String(phone).trim()))
    return res.status(400).json({ error: 'invalid phone' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const r = db.prepare(`INSERT INTO users(phone,name,password_hash,kyc_pan,kyc_gst,kyc_city) VALUES (?,?,?,?,?,?)`)
      .run(phone.trim(), name.trim(), hash, pan || null, gst || null, city || null);
    const did = deviceOf(req);
    if (did) db.prepare("UPDATE users SET device_id=?, device_name=?, device_at=datetime('now') WHERE id=?")
               .run(did, deviceLabel(req), r.lastInsertRowid);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
    res.json({ token: sign(u, did), user: pub(u), note: 'Account pending admin approval before trading.' });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'phone already registered' });
    res.status(500).json({ error: 'register failed' });
  }
});

function clientIp(req) {
  const f = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return f || req.socket?.remoteAddress || null;
}
const recordLogin = db.prepare('INSERT INTO logins(user_id,ip,agent,ok) VALUES (?,?,?,?)');

app.post('/api/login', (req, res) => {
  const { phone, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE phone=?').get((phone || '').trim());
  const ip = clientIp(req), agent = (req.headers['user-agent'] || '').slice(0, 200);
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) {
    if (u) { try { recordLogin.run(u.id, ip, agent, 0); } catch {} }   // failed attempt, for the audit trail
    return res.status(401).json({ error: 'invalid credentials' });
  }
  if (u.status === 'blocked') {
    try { recordLogin.run(u.id, ip, agent, 0); } catch {}
    return res.status(403).json({ error: 'account blocked' });
  }
  const did = deviceOf(req);
  if (u.role !== 'admin') {
    if (!did) return res.status(400).json({ error: 'app out of date — reopen the app and try again' });
    if (u.device_id && u.device_id !== did) {
      try { recordLogin.run(u.id, ip, agent, 0); } catch {}
      return res.status(403).json({ error: DEVICE_MSG });
    }
    if (!u.device_id) {
      db.prepare("UPDATE users SET device_id=?, device_name=?, device_at=datetime('now') WHERE id=?")
        .run(did, deviceLabel(req), u.id);
      u.device_id = did;
    }
  }
  try {
    recordLogin.run(u.id, ip, agent, 1);
    db.prepare("UPDATE users SET last_login=datetime('now'), login_count=login_count+1 WHERE id=?").run(u.id);
  } catch {}
  res.json({ token: sign(u, u.device_id), user: pub(u) });
});

function pub(u) {
  return { id: u.id, phone: u.phone, name: u.name, role: u.role, status: u.status,
           marginLimit: u.margin_limit, city: u.kyc_city,
           pan: u.kyc_pan, gst: u.kyc_gst, email: u.email, address: u.address,
           createdAt: u.created_at, lastLogin: u.last_login,
           device: u.device_id ? { name: u.device_name || 'phone', since: u.device_at } : null };
}

// ---------- rates ----------
app.get('/api/rates', (req, res) => {
  // optional auth → personalized rates
  let user = null;
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) { try { const p = jwt.verify(h.slice(7), JWT_SECRET); user = db.prepare('SELECT * FROM users WHERE id=?').get(p.id); } catch {} }
  res.json(snapshot(user));
});

app.get('/api/rates/history', (req, res) => {
  const hours = Math.min(parseInt(req.query.hours || '24'), 168);
  const since = Date.now() - hours * 3600_000;
  res.json(db.prepare('SELECT ts, gold_inr_10g, silver_inr_kg, xauusd, xagusd, usdinr FROM rate_history WHERE ts>? ORDER BY ts').all(since));
});

app.get('/api/config', (req, res) => {
  res.json({ dealerPhone: getSetting('dealer_phone') || '' });
});

app.get('/api/me', auth(), (req, res) => res.json(pub(req.user)));

// clients edit their own details here
app.patch('/api/me', auth(), (req, res) => {
  const b = req.body || {};
  const map = { name: 'name', city: 'kyc_city', pan: 'kyc_pan', gst: 'kyc_gst',
                email: 'email', address: 'address' };
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (b[k] === undefined) continue;
    const v = String(b[k]).trim();
    if (k === 'name' && !v) return res.status(400).json({ error: 'name cannot be empty' });
    if (v.length > 200) return res.status(400).json({ error: `${k} is too long` });
    sets.push(`${col}=?`); vals.push(v || null);
  }
  if (b.newPassword !== undefined) {
    const np = String(b.newPassword || '');
    if (np.length < 6) return res.status(400).json({ error: 'new password must be at least 6 characters' });
    if (!bcrypt.compareSync(String(b.currentPassword || ''), req.user.password_hash))
      return res.status(400).json({ error: 'current password is wrong' });
    sets.push('password_hash=?'); vals.push(bcrypt.hashSync(np, 10));
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.user.id);
  db.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...vals);
  res.json(pub(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)));
});

// ---------- quotes (30s price lock) ----------
app.post('/api/quote', auth(), (req, res) => {
  if (req.user.status !== 'active') return res.status(403).json({ error: 'account not approved for trading yet' });
  if (getSetting('market_open') !== 'true') return res.status(423).json({ error: 'market closed' });
  if (rateState.stale) return res.status(503).json({ error: 'rates stale, try again' });
  const { productCode, side, qty } = req.body || {};
  const p = db.prepare('SELECT * FROM products WHERE code=? AND active=1').get(productCode);
  if (!p) return res.status(404).json({ error: 'unknown product' });
  if (!['buy', 'sell'].includes(side)) return res.status(400).json({ error: 'side must be buy|sell' });
  const q = parseFloat(qty);
  if (!(q >= p.min_qty && q <= p.max_qty)) return res.status(400).json({ error: `qty must be ${p.min_qty}-${p.max_qty}` });
  const r = productRates(p, req.user);
  if (!r) return res.status(503).json({ error: 'rates unavailable' });
  const rate = side === 'buy' ? r.buyRate : r.sellRate;
  const exposure = rate * q;
  if (openExposure(req.user.id) + exposure > req.user.margin_limit)
    return res.status(403).json({ error: `margin limit exceeded (limit ₹${req.user.margin_limit})` });
  const id = crypto.randomUUID();
  const gstPct = parseFloat(getSetting('gst_pct'));
  db.prepare('INSERT INTO quotes(id,user_id,product_id,side,rate,qty,expires_at,gst_pct) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, p.id, side, rate, q, Date.now() + QUOTE_TTL_MS, gstPct);
  res.json({ quoteId: id, product: p.code, side, qty: q, rate, ttlMs: QUOTE_TTL_MS,
             gstPct, gstAmount: side === 'buy' ? Math.round(rate * q * gstPct / 100) : 0,
             total: Math.round(rate * q * (side === 'buy' ? 1 + gstPct / 100 : 1)) });
});

// Exposure: per-product |net notional| of executed orders (ex-GST), plus pending
// limit orders at full notional (worst case). Delivered/settled orders release margin.
function openExposure(userId) {
  const rows = db.prepare(`SELECT product_id,
      ABS(SUM(CASE WHEN side='buy' THEN rate*qty ELSE -rate*qty END)) net
    FROM orders WHERE user_id=? AND status='executed' GROUP BY product_id`).all(userId);
  const pending = db.prepare(`SELECT COALESCE(SUM(rate*qty),0) s FROM orders
    WHERE user_id=? AND status='pending'`).get(userId);
  return rows.reduce((a, r) => a + r.net, 0) + pending.s;
}

// ---------- orders ----------
app.post('/api/orders', auth(), (req, res) => {
  if (req.user.status !== 'active') return res.status(403).json({ error: 'account not approved for trading yet' });
  if (getSetting('market_open') !== 'true') return res.status(423).json({ error: 'market closed' });
  const { type, quoteId, productCode, side, qty, limitRate, idempotencyKey } = req.body || {};
  if (idempotencyKey) {
    const dup = db.prepare('SELECT o.*, p.code product_code, p.name product_name FROM orders o JOIN products p ON p.id=o.product_id WHERE o.idempotency_key=? AND o.user_id=?').get(idempotencyKey, req.user.id);
    if (dup) return res.json(orderPub(dup));
  }
  if (type === 'market') {
    const q = db.prepare('SELECT * FROM quotes WHERE id=? AND user_id=?').get(quoteId, req.user.id);
    if (!q) return res.status(404).json({ error: 'quote not found' });
    if (q.used) return res.status(409).json({ error: 'quote already used' });
    if (Date.now() > q.expires_at) return res.status(410).json({ error: 'quote expired, re-quote' });
    const prod = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(q.product_id);
    if (!prod) return res.status(409).json({ error: 'product no longer available' });
    // re-check margin at execution (quotes can be stacked)
    if (openExposure(req.user.id) + q.rate * q.qty > req.user.margin_limit)
      return res.status(403).json({ error: 'margin limit exceeded' });
    const gstPct = q.gst_pct != null ? q.gst_pct : parseFloat(getSetting('gst_pct'));
    const gst = q.side === 'buy' ? Math.round(q.rate * q.qty * gstPct / 100) : 0;
    const total = Math.round(q.rate * q.qty + gst);
    const tx = db.transaction(() => {
      const u = db.prepare('UPDATE quotes SET used=1 WHERE id=? AND used=0').run(q.id);
      if (u.changes !== 1) throw new Error('QUOTE_USED');
      return db.prepare(`INSERT INTO orders(user_id,product_id,side,type,qty,rate,status,idempotency_key,quote_id,gst_amount,total_amount,executed_at)
        VALUES (?,?,?,?,?,?,'executed',?,?,?,?,datetime('now'))`)
        .run(req.user.id, q.product_id, q.side, 'market', q.qty, q.rate, idempotencyKey || null, q.id, gst, total);
    });
    let r;
    try { r = tx(); } catch (e) {
      if (e.message === 'QUOTE_USED') return res.status(409).json({ error: 'quote already used' });
      throw e;
    }
    const o = db.prepare('SELECT o.*, p.code product_code, p.name product_name FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?').get(r.lastInsertRowid);
    return res.json(orderPub(o));
  }
  if (type === 'limit') {
    const p = db.prepare('SELECT * FROM products WHERE code=? AND active=1').get(productCode);
    if (!p) return res.status(404).json({ error: 'unknown product' });
    if (!['buy', 'sell'].includes(side)) return res.status(400).json({ error: 'side must be buy|sell' });
    const q = parseFloat(qty), lr = parseFloat(limitRate);
    if (!(q >= p.min_qty && q <= p.max_qty) || !(lr > 0)) return res.status(400).json({ error: 'bad qty/limitRate' });
    if (openExposure(req.user.id) + lr * q > req.user.margin_limit)
      return res.status(403).json({ error: 'margin limit exceeded' });
    const r = db.prepare(`INSERT INTO orders(user_id,product_id,side,type,qty,rate,status,idempotency_key)
      VALUES (?,?,?,?,?,?,'pending',?)`).run(req.user.id, p.id, side, 'limit', q, lr, idempotencyKey || null);
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(r.lastInsertRowid);
    return res.json(orderPub(o));
  }
  res.status(400).json({ error: 'type must be market|limit' });
});

app.get('/api/orders', auth(), (req, res) => {
  const rows = db.prepare(`SELECT o.*, p.code product_code, p.name product_name FROM orders o
    JOIN products p ON p.id=o.product_id WHERE o.user_id=? ORDER BY o.id DESC LIMIT 200`).all(req.user.id);
  res.json(rows.map(orderPub));
});

app.delete('/api/orders/:id', auth(), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  if (o.status !== 'pending') return res.status(409).json({ error: 'only pending orders can be cancelled' });
  db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(o.id);
  res.json({ ok: true });
});

function orderPub(o) {
  return { id: o.id, product: o.product_code || o.product_id, productName: o.product_name,
           side: o.side, type: o.type, qty: o.qty, rate: o.rate, status: o.status,
           gst: o.gst_amount, total: o.total_amount, createdAt: o.created_at, executedAt: o.executed_at };
}

// position summary
app.get('/api/position', auth(), (req, res) => {
  const rows = db.prepare(`SELECT p.code, p.name,
      SUM(CASE WHEN o.side='buy' THEN o.qty ELSE -o.qty END) net_qty,
      SUM(CASE WHEN o.side='buy' THEN o.rate*o.qty ELSE -o.rate*o.qty END) net_value
    FROM orders o JOIN products p ON p.id=o.product_id
    WHERE o.user_id=? AND o.status IN ('executed','delivered') GROUP BY p.id`).all(req.user.id);
  res.json({ positions: rows, openExposure: openExposure(req.user.id), marginLimit: req.user.margin_limit });
});

// ---------- alerts ----------
app.post('/api/alerts', auth(), (req, res) => {
  const { productCode, direction } = req.body || {};
  const raw = req.body?.targetRate;
  const targetRate = (typeof raw === 'number' || typeof raw === 'string') ? Number(raw) : NaN;
  if (!['above', 'below'].includes(direction) || !Number.isFinite(targetRate) || targetRate <= 0)
    return res.status(400).json({ error: 'bad alert' });
  if (!db.prepare('SELECT 1 FROM products WHERE code=?').get(productCode))
    return res.status(404).json({ error: 'unknown product' });
  const r = db.prepare('INSERT INTO alerts(user_id,product_code,direction,target_rate) VALUES (?,?,?,?)')
    .run(req.user.id, productCode, direction, targetRate);
  res.json({ id: r.lastInsertRowid });
});
app.get('/api/alerts', auth(), (req, res) =>
  res.json(db.prepare('SELECT * FROM alerts WHERE user_id=? ORDER BY id DESC').all(req.user.id)));
app.delete('/api/alerts/:id', auth(), (req, res) => {
  db.prepare('DELETE FROM alerts WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------- admin ----------
app.get('/api/admin/users', auth('admin'), (req, res) =>
  res.json(db.prepare(`SELECT id,phone,name,role,status,margin_limit,premium_gold,premium_silver,
      kyc_pan,kyc_city,created_at,last_login,login_count,
      device_id,device_name,device_at FROM users ORDER BY id DESC`).all()));

// who signed in, when, from where
app.get('/api/admin/logins', auth('admin'), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100'), 500);
  res.json(db.prepare(`SELECT l.id, l.ts, l.ip, l.agent, l.ok, u.name, u.phone
    FROM logins l JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT ?`).all(limit));
});

app.patch('/api/admin/users/:id', auth('admin'), (req, res) => {
  const allowed = ['status', 'margin_limit', 'premium_gold', 'premium_silver', 'role'];
  const sets = [], vals = [];
  for (const k of allowed) if (k in req.body) {
    let v = req.body[k];
    if (k === 'status' && !['pending', 'active', 'blocked'].includes(v)) return res.status(400).json({ error: 'bad status' });
    if (k === 'role' && !['trader', 'admin'].includes(v)) return res.status(400).json({ error: 'bad role' });
    if (['margin_limit', 'premium_gold', 'premium_silver'].includes(k)) {
      v = Number(v);
      if (!Number.isFinite(v)) return res.status(400).json({ error: `bad ${k}` });
    }
    sets.push(`${k}=?`); vals.push(v);
  }
  // "reset device" lets a client sign in on a new handset — the old one is logged out
  if (req.body.device_reset) {
    sets.push('device_id=?', 'device_name=?', 'device_at=?'); vals.push(null, null, null);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.id);
  db.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...vals);
  res.json({ ok: true });
});

app.get('/api/admin/orders', auth('admin'), (req, res) =>
  res.json(db.prepare(`SELECT o.*, u.name user_name, u.phone, p.code product_code FROM orders o
    JOIN users u ON u.id=o.user_id JOIN products p ON p.id=o.product_id ORDER BY o.id DESC LIMIT 500`).all()));

// the dealer books what was agreed on the call, for any client
app.post('/api/admin/orders', auth('admin'), (req, res) => {
  const { userId, productCode, side, qty, rate, status, note } = req.body || {};
  const u = db.prepare('SELECT id FROM users WHERE id=?').get(userId);
  if (!u) return res.status(400).json({ error: 'pick a client' });
  const p = db.prepare('SELECT * FROM products WHERE code=? AND active=1').get(String(productCode || ''));
  if (!p) return res.status(400).json({ error: 'pick a product' });
  if (!['buy', 'sell'].includes(side)) return res.status(400).json({ error: 'side must be buy or sell' });
  const q = Number(qty), r = Number(rate);
  if (!(q > 0)) return res.status(400).json({ error: 'quantity must be more than 0' });
  if (!(r > 0)) return res.status(400).json({ error: 'rate must be more than 0' });
  const st = status || 'executed';
  if (!['executed', 'pending', 'delivered'].includes(st)) return res.status(400).json({ error: 'bad status' });
  if (note && BAD_CHARS.test(String(note))) return res.status(400).json({ error: 'invalid characters in note' });
  const gstPct = parseFloat(getSetting('gst_pct') || '3');
  const gst = side === 'buy' ? Math.round(r * q * gstPct / 100) : 0;
  const info = db.prepare(`INSERT INTO orders(user_id,product_id,side,type,qty,rate,status,
      gst_amount,total_amount,note,executed_at)
      VALUES (?,?,?,'market',?,?,?,?,?,?,datetime('now'))`)
    .run(u.id, p.id, side, q, r, st, gst, Math.round(r * q) + gst, (note || 'booked on call').slice(0, 200));
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.patch('/api/admin/orders/:id', auth('admin'), (req, res) => {
  const { status } = req.body || {};
  if (!['pending', 'executed', 'cancelled', 'rejected', 'delivered'].includes(status)) return res.status(400).json({ error: 'bad status' });
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/products', auth('admin'), (req, res) =>
  res.json(db.prepare('SELECT * FROM products').all()));
app.patch('/api/admin/products/:id', auth('admin'), (req, res) => {
  const allowed = ['sell_premium', 'buy_premium', 'active', 'min_qty', 'max_qty'];
  const sets = [], vals = [];
  for (const k of allowed) if (k in req.body) {
    const v = Number(req.body[k]);
    if (!Number.isFinite(v)) return res.status(400).json({ error: `bad ${k}` });
    sets.push(`${k}=?`); vals.push(v);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.id);
  db.prepare(`UPDATE products SET ${sets.join(',')} WHERE id=?`).run(...vals);
  res.json({ ok: true });
});

app.get('/api/admin/settings', auth('admin'), (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});
const NUMERIC_SETTINGS = ['duty_pct', 'gst_pct', 'global_spread_gold', 'global_spread_silver',
                          'margin_gold', 'margin_silver', 'etf_factor_gold', 'etf_factor_silver',
                          'cash_gold_rate', 'cash_gold_995_rate', 'cash_silver_rate'];
const ALLOWED_SETTINGS = [...NUMERIC_SETTINGS, 'dealer_phone', 'price_basis'];
app.patch('/api/admin/settings', auth('admin'), (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!ALLOWED_SETTINGS.includes(k)) return res.status(400).json({ error: `unknown setting ${k}` });
    if (NUMERIC_SETTINGS.includes(k) && !Number.isFinite(Number(v))) return res.status(400).json({ error: `bad ${k}` });
    if (k === 'price_basis' && !['auto', 'mcx', 'india', 'spot'].includes(String(v)))
      return res.status(400).json({ error: 'price_basis must be auto, mcx, india or spot' });
    if (k === 'dealer_phone') {
      const t = String(v).trim();
      if (t && !/^\+?[0-9][0-9 -]{6,18}$/.test(t)) return res.status(400).json({ error: 'bad dealer_phone' });
    }
  }
  const saved = {};
  try {
    for (const [k, v] of Object.entries(req.body || {})) saved[k] = setSetting(k, v);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  // echo back what is really stored, so the app shows the truth and not a hope
  const stored = {};
  for (const k of Object.keys(saved)) stored[k] = getSettingFresh(k);
  res.json({ ok: true, saved: stored });
});

// tie the Indian live anchor to the rate the dealer is actually quoting today
app.post('/api/admin/calibrate', auth('admin'), (req, res) => {
  const { metal, rate } = req.body || {};
  if (!['gold', 'silver'].includes(metal)) return res.status(400).json({ error: 'metal must be gold or silver' });
  const r = Number(rate);
  if (!(r > 0)) return res.status(400).json({ error: 'enter the rate to match' });
  try { res.json(calibrateEtf(metal, r)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// does this database actually keep what we write? (admin only)
app.get('/api/admin/diag', auth('admin'), (req, res) => {
  const key = '_diag_write_test', want = String(Date.now());
  let write = 'ok', readBack = null, err = null;
  try { setSetting(key, want); readBack = getSettingFresh(key); }
  catch (e) { write = 'failed'; err = e.message; readBack = getSettingFresh(key); }
  clearSettingsCache();
  res.json({
    database: process.env.TURSO_DATABASE_URL ? 'turso (remote)' : 'local file',
    writesPersist: readBack === want, write, err,
    settings: db.prepare('SELECT key, value FROM settings ORDER BY key').all(),
    serverTimeUtc: new Date().toISOString()
  });
});

// ---------- websocket live rates ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/rates' });
wss.on('connection', (ws, req) => {
  // optional token → personalized rates + targeted alerts
  ws.userId = null;
  try {
    const url = new URL(req.url, 'http://x');
    const tok = url.searchParams.get('token');
    if (tok) {
      const p = jwt.verify(tok, JWT_SECRET);
      const u = db.prepare('SELECT id,role,device_id FROM users WHERE id=?').get(p.id);
      // same device rule as the HTTP side: a token from another handset gets public rates only
      if (u && (u.role === 'admin' || !u.device_id || u.device_id === p.did)) ws.userId = u.id;
    }
  } catch {}
  ws.send(JSON.stringify({ type: 'rates', data: snapForWs(ws) }));
});
function snapForWs(ws) {
  const u = ws.userId ? db.prepare('SELECT * FROM users WHERE id=?').get(ws.userId) : null;
  return snapshot(u);
}
onTick(() => {
  const generic = JSON.stringify({ type: 'rates', data: snapshot() });
  for (const c of wss.clients) {
    if (c.readyState !== 1) continue;
    c.send(c.userId ? JSON.stringify({ type: 'rates', data: snapForWs(c) }) : generic);
  }
  matchLimitOrders();
  fireAlerts();
  sweepQuotes();
});

let lastSweep = 0;
function sweepQuotes() {
  if (Date.now() - lastSweep < 300_000) return;
  lastSweep = Date.now();
  db.prepare('DELETE FROM quotes WHERE expires_at < ?').run(Date.now() - 3600_000);
}

// limit order matching: client-buy fills when market buy-rate <= limit; client-sell when sell-rate >= limit
function matchLimitOrders() {
  if (getSetting('market_open') !== 'true') return;
  if (rateState.stale || Date.now() - rateState.updatedAt > 120_000) return; // never fill on stale prices
  const pending = db.prepare(`SELECT o.*, p.code FROM orders o JOIN products p ON p.id=o.product_id
    WHERE o.status='pending' AND o.type='limit' AND p.active=1`).all();
  if (!pending.length) return;
  const gstPct = parseFloat(getSetting('gst_pct'));
  for (const o of pending) {
    const p = db.prepare('SELECT * FROM products WHERE id=?').get(o.product_id);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(o.user_id);
    const r = productRates(p, u);
    if (!r) continue;
    const fill = o.side === 'buy' ? (r.buyRate <= o.rate ? r.buyRate : null)
                                  : (r.sellRate >= o.rate ? r.sellRate : null);
    if (fill != null) {
      const gst = o.side === 'buy' ? Math.round(fill * o.qty * gstPct / 100) : 0;
      db.prepare(`UPDATE orders SET status='executed', rate=?, gst_amount=?, total_amount=?, executed_at=datetime('now') WHERE id=? AND status='pending'`)
        .run(fill, gst, Math.round(fill * o.qty + gst), o.id);
    }
  }
}

function fireAlerts() {
  const alerts = db.prepare('SELECT * FROM alerts WHERE triggered=0').all();
  if (!alerts.length) return;
  for (const a of alerts) {
    const p = db.prepare('SELECT * FROM products WHERE code=?').get(a.product_code);
    if (!p) continue;
    const r = productRates(p, null);
    if (!r) continue;
    const hit = a.direction === 'above' ? r.buyRate >= a.target_rate : r.buyRate <= a.target_rate;
    if (hit) {
      db.prepare('UPDATE alerts SET triggered=1 WHERE id=?').run(a.id);
      const msg = JSON.stringify({ type: 'alert', data: { product: a.product_code, direction: a.direction, target: a.target_rate, rate: r.buyRate } });
      for (const c of wss.clients) if (c.readyState === 1 && c.userId === a.user_id) c.send(msg); // targeted only
    }
  }
}

// ---------- bootstrap admin ----------
function ensureAdmin() {
  const exists = db.prepare("SELECT 1 FROM users WHERE role='admin'").get();
  if (!exists) {
    const pw = process.env.ADMIN_PASSWORD || 'admin1234';
    db.prepare(`INSERT INTO users(phone,name,password_hash,role,status,margin_limit) VALUES ('admin','Administrator',?,'admin','active',1e12)`)
      .run(bcrypt.hashSync(pw, 10));
    console.log('[init] admin user created (login: admin) — password from ADMIN_PASSWORD env var.');
  }
}

const PORT = process.env.PORT || 8080;
ensureAdmin();
startRatesEngine();
server.listen(PORT, () => console.log(`Bullion backend on :${PORT} (simulate=${rateState.simulate})`));
