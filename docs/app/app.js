/* RDgold web app — one app for iPhone and Android.
   Talks to the same backend as everything else. */
'use strict';

const API = (new URLSearchParams(location.search).get('api')
             || localStorage.getItem('rdgold.api')
             || 'https://rdgold-backend.onrender.com').replace(/\/+$/, '');

const $  = id => document.getElementById(id);
const fmt = n => n == null ? '—' : '₹' + Math.round(n).toLocaleString('en-IN');
const esc = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

let token   = localStorage.getItem('rdgold.token') || null;
let me      = null;
let snap    = null;     // last rates snapshot
let prevBuy = {};       // per product, for tick arrows
let ws = null, wsTimer = null, registerMode = false;

/* ---------------- api ---------------- */
async function api(path, { method = 'GET', body, auth = true } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (auth && token) h.Authorization = 'Bearer ' + token;
  let r;
  try {
    r = await fetch(API + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Cannot reach the server. Check your connection.');
  }
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) {
    if (r.status === 401) { signOut(); throw new Error('Session expired. Sign in again.'); }
    throw new Error((j && j.error) || ('Request failed (' + r.status + ')'));
  }
  return j;
}
function note(el, text, kind) {
  const n = $(el);
  if (!n) return;
  n.innerHTML = text ? `<div class="msg ${kind || 'err'}">${esc(text)}</div>` : '';
}

/* ---------------- views ---------------- */
const VIEWS = ['auth', 'rates', 'orders', 'alerts', 'bank', 'admin'];
function show(v) {
  VIEWS.forEach(x => $('v-' + x).classList.toggle('hide', x !== v));
  $('nav').classList.toggle('hide', v === 'auth');
  [...document.querySelectorAll('#nav button')].forEach(b => b.classList.toggle('on', b.dataset.v === v));
  if (v === 'orders') loadOrders();
  if (v === 'alerts') loadAlerts();
  if (v === 'bank')   loadBank();
  if (v === 'admin')  loadAdmin();
}
document.querySelectorAll('#nav button').forEach(b => b.onclick = () => show(b.dataset.v));

/* ---------------- auth ---------------- */
$('b-swap').onclick = () => {
  registerMode = !registerMode;
  $('authTitle').textContent = registerMode ? 'Create account' : 'Sign in';
  $('b-auth').textContent    = registerMode ? 'Create account' : 'Sign in';
  $('b-swap').textContent    = registerMode ? 'I already have an account' : 'Create an account';
  $('regOnly').classList.toggle('hide', !registerMode);
  $('regOnly2').classList.toggle('hide', !registerMode);
  $('f-pass').setAttribute('autocomplete', registerMode ? 'new-password' : 'current-password');
  note('authmsg', '');
};

$('b-auth').onclick = async () => {
  const phone = $('f-phone').value.trim(), password = $('f-pass').value;
  if (!phone || !password) return note('authmsg', 'Phone and password are required.');
  $('b-auth').disabled = true;
  try {
    const body = registerMode
      ? { phone, password, name: $('f-name').value.trim(),
          city: $('f-city').value.trim(), pan: $('f-pan').value.trim(), gst: $('f-gst').value.trim() }
      : { phone, password };
    const r = await api(registerMode ? '/api/register' : '/api/login', { method: 'POST', body, auth: false });
    token = r.token; localStorage.setItem('rdgold.token', token);
    me = r.user || null;
    $('f-pass').value = '';
    await afterSignIn(r.note);
  } catch (e) { note('authmsg', e.message); }
  finally { $('b-auth').disabled = false; }
};

async function afterSignIn(msg) {
  try { me = await api('/api/me'); } catch {}
  $('navAdmin').classList.toggle('hide', !(me && me.role === 'admin'));
  show('rates');
  if (msg) note('ratemsg', msg, 'warn');
  else if (me && me.status !== 'active')
    note('ratemsg', 'Your account is pending approval. You can watch rates; booking unlocks once approved.', 'warn');
  connect();
}
function signOut() {
  token = null; me = null;
  localStorage.removeItem('rdgold.token');
  if (ws) { try { ws.close(); } catch {} ws = null; }
  show('auth');
}
$('b-logout').onclick = signOut;

/* ---------------- live rates ---------------- */
function connect() {
  if (!token) return;
  if (ws) { try { ws.close(); } catch {} }
  const wsUrl = API.replace(/^http/, 'ws') + '/ws/rates?token=' + encodeURIComponent(token);
  try { ws = new WebSocket(wsUrl); } catch { return pollFallback(); }
  ws.onmessage = ev => {
    try {
      const m = JSON.parse(ev.data);
      if (m && m.products) paintRates(m);
      else if (m && m.type === 'alert') note('ratemsg', m.message || 'Rate alert triggered.', 'ok');
    } catch {}
  };
  ws.onclose = () => { badge('offline'); clearTimeout(wsTimer); wsTimer = setTimeout(connect, 3000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
  pollOnce();
}
function pollFallback() { pollOnce(); clearTimeout(wsTimer); wsTimer = setTimeout(pollFallback, 2000); }
async function pollOnce() { try { paintRates(await api('/api/rates')); } catch {} }

function badge(state) {
  const b = $('badge');
  b.className = 'badge' + (state === 'live' ? ' live' : state === 'stale' ? ' stale' : '');
  b.textContent = state;
}
function paintRates(d) {
  snap = d;
  badge(d.stale ? 'stale' : (d.marketOpen === false ? 'closed' : 'live'));

  const gstPct = d.gstPct;
  $('ratecard').innerHTML = (d.products || []).map(p => {
    const prev = prevBuy[p.code];
    const arrow = (prev == null || p.buy === prev) ? '' : (p.buy > prev ? ' <span class="up">▲</span>' : ' <span class="dn">▼</span>');
    prevBuy[p.code] = p.buy;
    const oz = p.spotUsd ? '$' + p.spotUsd.toFixed(2) + '/oz' : '';
    return `<div class="rate row">
      <div class="nm">${esc(p.name)}<small>per ${esc(p.unit)} · sell ${fmt(p.sell)}</small>
        <small>${oz}</small></div>
      <div style="text-align:right">
        <div class="px">${fmt(p.buy)}${arrow}<small>you buy · ex-GST</small></div>
        <div class="sm" style="margin-top:4px;color:var(--gold-soft);font-variant-numeric:tabular-nums">
          ${fmt(p.buyWithGst)} <span class="muted">inc ${gstPct}% GST</span></div>
        <div class="btn2" style="margin-top:8px">
          <button class="btn gold" style="padding:8px" data-buy="${esc(p.code)}">Buy</button>
          <button class="btn" style="padding:8px" data-sell="${esc(p.code)}">Sell</button>
        </div>
      </div></div>`;
  }).join('') || '<div class="muted sm">No products available.</div>';

  $('ratecard').querySelectorAll('[data-buy]').forEach(b => b.onclick = () => openTrade(b.dataset.buy, 'buy'));
  $('ratecard').querySelectorAll('[data-sell]').forEach(b => b.onclick = () => openTrade(b.dataset.sell, 'sell'));

  const s = d.spot || {};
  $('spotline').innerHTML =
    `Gold <b>$${s.xauusd ? s.xauusd.toFixed(2) : '—'}</b>/oz &nbsp;·&nbsp; ` +
    `Silver <b>$${s.xagusd ? s.xagusd.toFixed(2) : '—'}</b>/oz &nbsp;·&nbsp; ` +
    `USD/INR <b>${s.usdinr ? s.usdinr.toFixed(3) : '—'}</b>`;

  // the feed can be perfectly live while the market is shut, so say which it is
  const mv = d.moved, mb = $('movedline');
  if (mb) {
    const ms = mv ? mv.goldMsAgo : null;
    if (ms == null) { mb.textContent = ''; }
    else if (ms < 120000) { mb.innerHTML = '<span class="up">Prices moving now.</span>'; }
    else {
      const mins = Math.round(ms / 60000);
      const txt = mins >= 60 ? Math.round(mins / 60) + 'h' : mins + 'm';
      mb.innerHTML = '<span class="muted">No movement for ' + txt +
        ' — the bullion market is closed. This is the last traded price.</span>';
    }
  }

  const fx = d.fx;
  if (fx && !fx.live) {
    const hrs = fx.ageMs != null ? Math.round(fx.ageMs / 3600000) : null;
    $('fxline').innerHTML = `<span class="dn">USD/INR is a daily reference rate${hrs != null ? ' (' + hrs + 'h old)' : ''}, not intraday.</span>`;
  } else if (fx) {
    $('fxline').textContent = 'Metals and USD/INR both live.';
  } else $('fxline').textContent = '';
}

/* ---------------- booking (by phone) ----------------
   Rates are shown live. Orders are agreed on a call, not executed in the app. */
const DEALER_PHONE = window.RDGOLD_PHONE || '+910000000000';
const sheet = $('sheet'), sheetInner = $('sheetInner');
function closeSheet() { sheet.classList.add('hide'); sheetInner.innerHTML = ''; }
sheet.onclick = e => { if (e.target === sheet) closeSheet(); };

function openTrade(code, side) {
  const p = (snap.products || []).find(x => x.code === code);
  if (!p) return;
  const rate = side === 'buy' ? p.buy : p.sell;
  sheet.classList.remove('hide');
  sheetInner.innerHTML = `
    <div class="tag">${side === 'buy' ? 'Buy' : 'Sell'}</div>
    <h2 style="margin:6px 0 2px">${esc(p.name)}</h2>
    <div class="muted sm" style="margin-bottom:12px">
      ${fmt(rate)} per ${esc(p.unit)} · live</div>
    <label>Quantity (${p.minQty}–${p.maxQty} ${esc(p.unit)} units)</label>
    <input id="sh-qty" inputmode="decimal" value="1">
    <div class="kv" style="margin-top:10px"><span>Indicative value</span><b id="sh-val">${fmt(rate)}</b></div>
    <div class="msg warn" style="margin-top:10px">
      Indicative only. The rate is fixed with us on the call, not here.</div>
    <a class="btn gold" id="sh-call" href="tel:${esc(DEALER_PHONE)}"
       style="text-align:center;text-decoration:none">Call to book</a>
    <div style="height:9px"></div>
    <a class="btn" id="sh-wa" target="_blank" rel="noopener"
       style="text-align:center;text-decoration:none">Send on WhatsApp</a>
    <div style="height:9px"></div>
    <button class="btn ghost" id="sh-close">Close</button>`;

  const qty = $('sh-qty');
  const refresh = () => {
    const q = parseFloat(qty.value) || 0;
    $('sh-val').textContent = fmt(rate * q);
    const msg = `${side === 'buy' ? 'Buy' : 'Sell'} ${q} ${p.unit} ${p.name} — indicative ${fmt(rate * q)} (rate ${fmt(rate)})`;
    $('sh-wa').href = 'https://wa.me/' + DEALER_PHONE.replace(/[^0-9]/g, '') +
                      '?text=' + encodeURIComponent(msg);
  };
  qty.oninput = refresh; refresh();
  $('sh-close').onclick = closeSheet;
}

/* ---------------- orders ---------------- */
async function loadOrders() {
  try {
    const [pos, orders] = await Promise.all([api('/api/position'), api('/api/orders')]);
    $('expo').textContent   = fmt(pos.openExposure);
    $('mlimit').textContent = fmt(pos.marginLimit);
    $('positions').innerHTML = (pos.positions || []).length
      ? pos.positions.map(p => `<div class="it row"><span>${esc(p.name)}</span>
          <span class="${p.net_qty >= 0 ? 'up' : 'dn'}">${p.net_qty > 0 ? '+' : ''}${p.net_qty}</span></div>`).join('')
      : '<div class="muted sm">No open position.</div>';

    const list = Array.isArray(orders) ? orders : (orders.orders || []);
    $('orderlist').innerHTML = list.length ? list.map(o => {
      const cls = o.status === 'executed' || o.status === 'delivered' ? 'g'
                : o.status === 'cancelled' ? 'r' : '';
      return `<div class="it">
        <div class="row"><b>${esc(o.productName || o.product)}</b><span class="pill ${cls}">${esc(o.status)}</span></div>
        <div class="row muted sm" style="margin-top:3px">
          <span>${esc(o.side)} · ${esc(o.type)} · ${o.qty} @ ${fmt(o.rate)}</span>
          <span>${fmt(o.total || o.rate * o.qty)}</span></div></div>`;
    }).join('') : '<div class="muted sm">No orders yet.</div>';
  } catch (e) { $('orderlist').innerHTML = `<div class="muted sm">${esc(e.message)}</div>`; }
}

/* ---------------- alerts ---------------- */
async function loadAlerts() {
  $('a-prod').innerHTML = ((snap && snap.products) || [])
    .map(p => `<option value="${esc(p.code)}">${esc(p.name)}</option>`).join('');
  try {
    const a = await api('/api/alerts');
    const list = Array.isArray(a) ? a : (a.alerts || []);
    $('alertlist').innerHTML = list.length ? list.map(x =>
      `<div class="it row"><span>${esc(x.product_code || x.productCode)} ${esc(x.direction)} ${fmt(x.target_rate || x.targetRate)}</span>
       <span class="pill ${x.fired ? 'g' : ''}">${x.fired ? 'fired' : 'armed'}</span></div>`).join('')
      : '<div class="muted sm">No alerts.</div>';
  } catch (e) { $('alertlist').innerHTML = `<div class="muted sm">${esc(e.message)}</div>`; }
}
$('b-alert').onclick = async () => {
  $('b-alert').disabled = true;
  try {
    await api('/api/alerts', { method: 'POST', body: {
      productCode: $('a-prod').value, direction: $('a-dir').value,
      targetRate: parseFloat($('a-rate').value) } });
    note('alertmsg', 'Alert created.', 'ok'); $('a-rate').value = ''; loadAlerts();
  } catch (e) { note('alertmsg', e.message); }
  finally { $('b-alert').disabled = false; }
};

/* ---------------- more ---------------- */
async function loadBank() {
  if (me) {
    $('m-name').textContent   = me.name || '—';
    $('m-phone').textContent  = me.phone || '—';
    $('m-status').textContent = me.status || '—';
    $('m-margin').textContent = fmt(me.marginLimit);
  }
  try {
    const b = await api('/api/bank-details', { auth: false });
    const keys = Object.keys(b || {});
    $('bank').innerHTML = keys.length
      ? keys.map(k => `<div class="it row"><span class="muted">${esc(k)}</span><b>${esc(b[k])}</b></div>`).join('')
      : '<div class="muted sm">Not published yet.</div>';
  } catch { $('bank').innerHTML = '<div class="muted sm">Unavailable.</div>'; }
}


/* ---------------- admin ---------------- */
async function loadAdmin() {
  if (!(me && me.role === 'admin')) { note('admmsg', 'Admins only.'); return; }
  try {
    const [users, orders, settings, logins] = await Promise.all([
      api('/api/admin/users'), api('/api/admin/orders'), api('/api/admin/settings'),
      api('/api/admin/logins?limit=60').catch(() => [])
    ]);

    const list = Array.isArray(users) ? users : (users.users || []);
    $('adm-count').textContent = list.length + ' total';
    $('adm-users').innerHTML = list.map(u => `
      <div class="it">
        <div class="row"><b>${esc(u.name || '—')}</b>
          <span class="pill ${u.status === 'active' ? 'g' : u.status === 'blocked' ? 'r' : ''}">${esc(u.status)}</span></div>
        <div class="row muted sm" style="margin-top:3px">
          <span>${esc(u.phone)}${u.kyc_city ? ' · ' + esc(u.kyc_city) : ''}</span>
          <span>limit ${fmt(u.margin_limit)}</span></div>
        <div class="row sm" style="margin-top:3px">
          <span class="muted">joined ${esc((u.created_at || '').slice(0, 16))}</span>
          <span class="muted">${u.last_login ? 'last in ' + esc(String(u.last_login).replace('T',' ').slice(0,16)) : 'never signed in'}${u.login_count ? ' · ' + u.login_count + 'x' : ''}</span></div>
        <div class="btn2" style="margin-top:8px">
          <button class="btn" style="padding:7px;font-size:13px" data-act="active" data-id="${u.id}">Approve</button>
          <button class="btn" style="padding:7px;font-size:13px" data-act="blocked" data-id="${u.id}">Block</button>
          <button class="btn" style="padding:7px;font-size:13px" data-act="limit" data-id="${u.id}">Limit</button>
        </div>
      </div>`).join('') || '<div class="muted sm">No clients yet.</div>';

    $('adm-users').querySelectorAll('[data-act]').forEach(b => b.onclick = () => adminUser(b.dataset.id, b.dataset.act));

    const lg = Array.isArray(logins) ? logins : [];
    $('adm-logins').innerHTML = lg.length ? lg.map(l => `
      <div class="it">
        <div class="row"><b>${esc(l.name || l.phone)}</b>
          <span class="pill ${l.ok ? 'g' : 'r'}">${l.ok ? 'signed in' : 'failed'}</span></div>
        <div class="row muted sm" style="margin-top:3px">
          <span>${esc(l.phone)}</span><span>${esc((l.ts || '').replace('T', ' ').slice(0, 16))} UTC</span></div>
        <div class="muted sm" style="margin-top:2px">${esc(l.ip || '')}</div>
      </div>`).join('') : '<div class="muted sm">No sign-ins recorded yet.</div>';

    const ol = Array.isArray(orders) ? orders : (orders.orders || []);
    $('adm-orders').innerHTML = ol.length ? ol.slice(0, 50).map(o => `
      <div class="it">
        <div class="row"><b>${esc(o.productName || o.product_code || o.product)}</b>
          <span class="pill">${esc(o.status)}</span></div>
        <div class="row muted sm" style="margin-top:3px">
          <span>${esc(o.userName || o.phone || ('user ' + o.user_id))} · ${esc(o.side)} ${o.qty}</span>
          <span>${fmt(o.total || o.total_amount || o.rate * o.qty)}</span></div>
      </div>`).join('') : '<div class="muted sm">No orders.</div>';

    const sv = settings || {};
    $('adm-sg').value   = sv.global_spread_gold ?? '';
    $('adm-ss').value   = sv.global_spread_silver ?? '';
    $('adm-duty').value = sv.duty_pct ?? '';
    $('adm-gst').value  = sv.gst_pct ?? '';
    const open = String(sv.market_open) === 'true';
    const mb = $('adm-market');
    mb.textContent = open ? 'OPEN — tap to close' : 'CLOSED — tap to open';
    mb.className = 'btn' + (open ? ' gold' : '');
    mb.onclick = async () => {
      try { await api('/api/admin/settings', { method: 'PATCH', body: { market_open: open ? 'false' : 'true' } });
            note('admmsg', 'Market ' + (open ? 'closed' : 'opened') + '.', 'ok'); loadAdmin(); }
      catch (e) { note('admmsg', e.message); }
    };
    note('admmsg', '');
  } catch (e) { note('admmsg', e.message); }
}

async function adminUser(id, act) {
  try {
    if (act === 'limit') {
      const v = prompt('Margin limit in rupees for this client:');
      if (v == null) return;
      await api('/api/admin/users/' + id, { method: 'PATCH', body: { margin_limit: Number(v) } });
    } else {
      await api('/api/admin/users/' + id, { method: 'PATCH', body: { status: act } });
    }
    note('admmsg', 'Updated.', 'ok'); loadAdmin();
  } catch (e) { note('admmsg', e.message); }
}

$('adm-save').onclick = async () => {
  $('adm-save').disabled = true;
  try {
    const body = {};
    const map = { 'adm-sg': 'global_spread_gold', 'adm-ss': 'global_spread_silver',
                  'adm-duty': 'duty_pct', 'adm-gst': 'gst_pct' };
    for (const k in map) if ($(k).value !== '') body[map[k]] = $(k).value;
    await api('/api/admin/settings', { method: 'PATCH', body });
    note('admmsg', 'Settings saved.', 'ok');
  } catch (e) { note('admmsg', e.message); }
  finally { $('adm-save').disabled = false; }
};

/* ---------------- install ---------------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; });
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
$('b-install').onclick = async () => {
  if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; }
};
function installUI() {
  if (standalone) { $('installcard').classList.add('hide'); return; }
  if (isIOS) {
    $('installtext').textContent = 'In Safari: tap Share, then Add to Home Screen.';
    $('b-install').classList.add('hide');
  }
}

/* ---------------- boot ---------------- */
installUI();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
if (token) { show('rates'); afterSignIn(); } else { show('auth'); }
