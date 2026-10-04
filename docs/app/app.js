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

// one account is tied to one phone: this id identifies the handset
const DEVICE_ID = (() => {
  let d = localStorage.getItem('rdgold.device');
  if (!d) {
    d = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2))
          .replace(/[^A-Za-z0-9_-]/g, '');
    localStorage.setItem('rdgold.device', d);
  }
  return d;
})();

let token   = localStorage.getItem('rdgold.token') || null;
let me      = null;
let snap    = null;     // last rates snapshot
let prevBuy = {};       // per product, last seen buy price
let dirBuy  = {};       // per product, direction of the last move
let ws = null, wsTimer = null, registerMode = false;
let lastTick = 0, watchdog = null;

/* ---------------- api ---------------- */
async function api(path, { method = 'GET', body, auth = true } = {}) {
  const h = { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE_ID };
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
    if (r.status === 401) { signOut(); throw new Error((j && j.error) || 'Session expired. Sign in again.'); }
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
const VIEWS = ['auth', 'rates', 'orders', 'alerts', 'profile', 'admin'];
function show(v) {
  VIEWS.forEach(x => $('v-' + x).classList.toggle('hide', x !== v));
  $('nav').classList.toggle('hide', v === 'auth');
  [...document.querySelectorAll('#nav button')].forEach(b => b.classList.toggle('on', b.dataset.v === v));
  if (v === 'orders') loadOrders();
  if (v === 'alerts') loadAlerts();
  if (v === 'profile') loadProfile();
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
      ? { phone, password, deviceId: DEVICE_ID, name: $('f-name').value.trim(),
          city: $('f-city').value.trim() }
      : { phone, password, deviceId: DEVICE_ID };
    const r = await api(registerMode ? '/api/register' : '/api/login', { method: 'POST', body, auth: false });
    token = r.token; localStorage.setItem('rdgold.token', token);
    me = r.user || null;
    $('f-pass').value = '';
    await afterSignIn(r.note);
  } catch (e) { note('authmsg', e.message); }
  finally { $('b-auth').disabled = false; }
};

async function afterSignIn(msg) {
  try { me = await api('/api/me'); }
  catch (e) {
    // token no longer valid (e.g. the account was moved to another phone)
    signOut(); note('authmsg', e.message); return;
  }
  loadConfig();
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
      // the server wraps everything as {type, data}
      const body = (m && m.data) ? m.data : m;
      if (m && m.type === 'alert') {
        const a = body || {};
        note('ratemsg', `${a.product || 'Rate'} crossed ${fmt(a.target)} — now ${fmt(a.rate)}.`, 'ok');
        return;
      }
      if (body && body.products) { lastTick = Date.now(); paintRates(body); }
    } catch {}
  };
  ws.onclose = () => { badge('offline'); clearTimeout(wsTimer); wsTimer = setTimeout(connect, 3000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
  pollOnce();
  clearInterval(watchdog);
  watchdog = setInterval(() => {
    if (Date.now() - lastTick > 8000) pollOnce();   // socket quiet → ask over HTTP
  }, 4000);
}
function pollFallback() { pollOnce(); clearTimeout(wsTimer); wsTimer = setTimeout(pollFallback, 2000); }
async function pollOnce() { try { const r = await api('/api/rates'); lastTick = Date.now(); paintRates(r); } catch {} }

function badge(state) {
  const b = $('badge');
  b.className = 'badge' + (state === 'live' ? ' live' : state === 'stale' ? ' stale' : '');
  b.textContent = state;
}
// the server stores times in UTC; everyone here reads IST
const ist = (t, withTime = true) => {
  if (!t) return '—';
  const d = new Date(String(t).replace(' ', 'T').replace(/Z?$/, 'Z'));
  if (isNaN(d)) return String(t);
  return d.toLocaleString('en-IN', withTime
    ? { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }
    : { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
};

const num = n => n == null ? '—' : Math.round(n).toLocaleString('en-IN');

// say plainly where the numbers come from — a futures contract is not spot
function basisLine(d) {
  const s = d.sources || {};
  if (s.basis === 'mcx')   return 'Live Mumbai rate, tracking MCX second by second.';
  if (s.basis === 'india') return 'Indian benchmark rate, moving live with the market.';
  return 'Live international rate converted at today\'s USD/INR.';
}
// "GOLD 04DEC2026" -> "Gold Dec 2026 futures"
function prettyContract(c) {
  const m = String(c).match(/^(\w+)\s+(\d{2})([A-Z]{3})(\d{4})$/);
  if (!m) return c;
  const name = m[1].charAt(0) + m[1].slice(1).toLowerCase();
  const mon = m[3].charAt(0) + m[3].slice(1).toLowerCase();
  return `${name} ${mon} ${m[4]} futures`;
}

function paintRates(d) {
  snap = d;
  badge(d.stale ? 'stale' : (d.marketOpen === false ? 'closed' : 'live'));

  const gstPct = d.gstPct;
  const rows = (d.products || []).map(p => {
    const prev = prevBuy[p.code];
    // green when the rate went up, red when it dropped; colour stays until it moves again
    let dir = dirBuy[p.code] || '';
    if (prev != null && p.buy !== prev) dir = p.buy > prev ? 'up' : 'dn';
    dirBuy[p.code] = dir;
    prevBuy[p.code] = p.buy;
    const arrow = dir === 'up' ? ' <i>▲</i>' : dir === 'dn' ? ' <i>▼</i>' : '';
    const oz   = p.spotUsd ? p.spotUsd.toFixed(2) : '<span class="none">—</span>';
    const gst  = p.buyWithGst ? num(p.buyWithGst) : '<span class="none">—</span>';
    const cash = p.cash ? num(p.cash) : '<span class="none">—</span>';
    return `<tr class="r" data-row="${esc(p.code)}">
      <td><span class="pname">${esc(p.name)}</span></td>
      <td class="main ${dir}">${num(p.buy)}${arrow}</td>
      <td class="gst">${gst}</td>
      <td class="fx">${oz}</td>
      <td class="cash">${cash}</td>
    </tr>`;
  }).join('');

  $('ratecard').innerHTML = rows
    ? `<table class="rtable">
         <thead><tr>
           <th>Product</th><th>₹ ex-GST</th><th>₹ +${gstPct}% GST</th>
           <th>$/oz</th><th>₹ cash</th>
         </tr></thead>
         <tbody>${rows}</tbody>
       </table>
       <div class="muted sm" style="margin-top:10px">${basisLine(d)}</div>
       <div class="muted sm" style="margin-top:6px">Tap any row to call and book. Rates are indicative; the price is fixed on the call.</div>`
    : '<div class="muted sm">No products available.</div>';

  $('ratecard').querySelectorAll('[data-row]').forEach(r => r.onclick = () => openTrade(r.dataset.row, 'buy'));

}

/* ---------------- booking (by phone) ----------------
   Rates are shown live. Orders are agreed on a call, not executed in the app. */
let DEALER_PHONE = window.RDGOLD_PHONE || '';
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
    ${DEALER_PHONE
      ? `<a class="btn gold" id="sh-call" href="tel:${esc(DEALER_PHONE.replace(/[^0-9+]/g, ''))}"
             style="text-align:center;text-decoration:none">Call ${esc(DEALER_PHONE)}</a>`
      : `<div class="msg err">Phone number not set yet. Please call us as usual.</div>`}
    <div style="height:9px"></div>
    ${DEALER_PHONE
      ? `<a class="btn" id="sh-wa" target="_blank" rel="noopener"
             style="text-align:center;text-decoration:none">Send on WhatsApp</a>`
      : ''}
    <div style="height:9px"></div>
    <button class="btn ghost" id="sh-close">Close</button>`;

  const qty = $('sh-qty');
  const refresh = () => {
    const q = parseFloat(qty.value) || 0;
    $('sh-val').textContent = fmt(rate * q);
    const msg = `${side === 'buy' ? 'Buy' : 'Sell'} ${q} ${p.unit} ${p.name} — indicative ${fmt(rate * q)} (rate ${fmt(rate)})`;
    if ($('sh-wa')) $('sh-wa').href = 'https://wa.me/' + DEALER_PHONE.replace(/[^0-9]/g, '') +
                      '?text=' + encodeURIComponent(msg);
  };
  qty.oninput = refresh; refresh();
  $('sh-close').onclick = closeSheet;
}

/* ---------------- orders ---------------- */
async function loadOrders() {
  try {
    const orders = await api('/api/orders');
    const list = Array.isArray(orders) ? orders : (orders.orders || []);
    $('orderlist').innerHTML = list.length ? list.map(o => {
      const cls = o.status === 'executed' || o.status === 'delivered' ? 'g'
                : o.status === 'cancelled' || o.status === 'rejected' ? 'r' : '';
      return `<div class="it">
        <div class="row"><b>${esc(o.productName || o.product)}</b><span class="pill ${cls}">${esc(o.status)}</span></div>
        <div class="row muted sm" style="margin-top:3px">
          <span>${esc(o.side)} · ${o.qty} @ ${fmt(o.rate)}</span>
          <span>${fmt(o.total || o.rate * o.qty)}</span></div>
        <div class="muted sm" style="margin-top:2px">${esc(ist(o.createdAt || o.created_at))}</div>
      </div>`;
    }).join('') : '<div class="muted sm">Nothing booked yet. Call us to book at the live rate.</div>';
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
async function loadConfig() {
  try {
    const c = await api('/api/config', { auth: false });
    DEALER_PHONE = c.dealerPhone || DEALER_PHONE;
  } catch {}
}

function loadProfile() {
  const u = me || {};
  $('p-phone').textContent  = u.phone  || '—';
  $('p-margin').textContent = fmt(u.marginLimit);
  $('p-since').textContent  = ist(u.createdAt, false);
  const st = $('p-status');
  st.textContent = u.status || '—';
  st.className = 'pill' + (u.status === 'active' ? ' g' : u.status === 'blocked' ? ' r' : '');
  $('p-name').value    = u.name    || '';
  $('p-city').value    = u.city    || '';
  $('p-email').value   = u.email   || '';
  $('p-address').value = u.address || '';
}

$('p-save').onclick = async () => {
  $('p-save').disabled = true;
  try {
    me = await api('/api/me', { method: 'PATCH', body: {
      name: $('p-name').value.trim(), city: $('p-city').value.trim(),
      email: $('p-email').value.trim(), address: $('p-address').value.trim() } });
    note('profmsg', 'Details saved.', 'ok');
  } catch (e) { note('profmsg', e.message); }
  finally { $('p-save').disabled = false; }
};

$('p-pass').onclick = async () => {
  const currentPassword = $('p-cur').value, newPassword = $('p-new').value;
  if (!currentPassword || !newPassword) return note('profmsg', 'Fill both password fields.');
  $('p-pass').disabled = true;
  try {
    await api('/api/me', { method: 'PATCH', body: { currentPassword, newPassword } });
    $('p-cur').value = ''; $('p-new').value = '';
    note('profmsg', 'Password updated.', 'ok');
  } catch (e) { note('profmsg', e.message); }
  finally { $('p-pass').disabled = false; }
};

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
          <span class="muted">joined ${esc(ist(u.created_at, false))}</span>
          <span class="muted">${u.last_login ? 'last in ' + esc(ist(u.last_login)) : 'never signed in'}${u.login_count ? ' · ' + u.login_count + 'x' : ''}</span></div>
        <div class="row sm" style="margin-top:3px">
          <span class="muted">${u.device_id ? 'locked to ' + esc(u.device_name || 'a phone') : 'no phone linked yet'}</span>
          ${u.device_id ? `<button class="btn" style="width:auto;padding:4px 10px;font-size:12px" data-act="device" data-id="${u.id}">Reset phone</button>` : ''}
        </div>
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
          <span>${esc(l.phone)}</span><span>${esc(ist(l.ts))}</span></div>
        <div class="muted sm" style="margin-top:2px">${esc(l.ip || '')}</div>
      </div>`).join('') : '<div class="muted sm">No sign-ins recorded yet.</div>';

    const ol = Array.isArray(orders) ? orders : (orders.orders || []);
    $('adm-ordcount').textContent = ol.length + ' total';
    $('adm-orders').innerHTML = ol.length ? ol.slice(0, 80).map(o => {
      const cls = o.status === 'executed' || o.status === 'delivered' ? 'g'
                : o.status === 'cancelled' || o.status === 'rejected' ? 'r' : '';
      return `<div class="it">
        <div class="row"><b>${esc(o.product_code || o.productName || o.product)}</b>
          <span class="pill ${cls}">${esc(o.status)}</span></div>
        <div class="row muted sm" style="margin-top:3px">
          <span>${esc(o.user_name || o.phone || ('client ' + o.user_id))} · ${esc(o.side)} ${o.qty} @ ${fmt(o.rate)}</span>
          <span>${fmt(o.total_amount || o.rate * o.qty)}</span></div>
        <div class="muted sm" style="margin-top:2px">${esc(ist(o.created_at))}${o.note ? ' · ' + esc(o.note) : ''}</div>
        <div class="btn2" style="margin-top:8px">
          <button class="btn" style="padding:6px;font-size:12.5px" data-ord="${o.id}" data-st="delivered">Delivered</button>
          <button class="btn" style="padding:6px;font-size:12.5px" data-ord="${o.id}" data-st="pending">Pending</button>
          <button class="btn" style="padding:6px;font-size:12.5px" data-ord="${o.id}" data-st="cancelled">Cancel</button>
        </div>
      </div>`;
    }).join('') : '<div class="muted sm">No orders yet.</div>';

    $('adm-orders').querySelectorAll('[data-ord]').forEach(b => b.onclick = async () => {
      try {
        await api('/api/admin/orders/' + b.dataset.ord, { method: 'PATCH', body: { status: b.dataset.st } });
        await loadAdmin(); note('admmsg', 'Order updated.', 'ok');
      } catch (e) { note('admmsg', e.message); }
    });

    // booking form: clients and products
    $('bk-user').innerHTML = list.filter(u => u.role !== 'admin')
      .map(u => `<option value="${u.id}">${esc(u.name || u.phone)} · ${esc(u.phone)}</option>`).join('')
      || '<option value="">No clients yet</option>';
    $('bk-prod').innerHTML = ((snap && snap.products) || [])
      .map(p => `<option value="${esc(p.code)}">${esc(p.name)}</option>`).join('');
    fillBookRate();

    const sv = settings || {};
    $('adm-cg').value   = (sv.cash_gold_rate && Number(sv.cash_gold_rate) > 0) ? sv.cash_gold_rate : '';
    $('adm-cg995').value = (sv.cash_gold_995_rate && Number(sv.cash_gold_995_rate) > 0) ? sv.cash_gold_995_rate : '';
    $('adm-cs').value   = (sv.cash_silver_rate && Number(sv.cash_silver_rate) > 0) ? sv.cash_silver_rate : '';
    $('adm-phone').value = sv.dealer_phone || '';
    showBasis();
    $('adm-sg').value   = sv.global_spread_gold ?? '';
    $('adm-mg').value   = sv.margin_gold ?? '';
    $('adm-ms').value   = sv.margin_silver ?? '';
    $('adm-ss').value   = sv.global_spread_silver ?? '';
    $('adm-duty').value = sv.duty_pct ?? '';
    $('adm-gst').value  = sv.gst_pct ?? '';
    note('admmsg', '');
  } catch (e) { note('admmsg', e.message); }
}

async function adminUser(id, act) {
  try {
    if (act === 'device') {
      if (!confirm('Unlink this client from their phone? They can then sign in on a new one.')) return;
      await api('/api/admin/users/' + id, { method: 'PATCH', body: { device_reset: true } });
    } else if (act === 'limit') {
      const v = prompt('Margin limit in rupees for this client:');
      if (v == null) return;
      await api('/api/admin/users/' + id, { method: 'PATCH', body: { margin_limit: Number(v) } });
    } else {
      await api('/api/admin/users/' + id, { method: 'PATCH', body: { status: act } });
    }
    await loadAdmin(); note('admmsg', 'Updated.', 'ok');
  } catch (e) { note('admmsg', e.message); }
}

// prefill the rate box with the live rate for whatever product is selected
function fillBookRate() {
  const code = $('bk-prod').value;
  const p = ((snap && snap.products) || []).find(x => x.code === code);
  if (!p) return;
  $('bk-rate').value = $('bk-side').value === 'buy' ? p.buy : p.sell;
}
$('bk-prod').onchange = fillBookRate;
$('bk-side').onchange = fillBookRate;

$('bk-save').onclick = async () => {
  const body = {
    userId: Number($('bk-user').value), productCode: $('bk-prod').value,
    side: $('bk-side').value, qty: Number($('bk-qty').value),
    rate: Number($('bk-rate').value), note: $('bk-note').value.trim() };
  if (!body.userId) return note('admmsg', 'Pick a client first.');
  if (!(body.qty > 0)) return note('admmsg', 'Quantity must be more than 0.');
  if (!(body.rate > 0)) return note('admmsg', 'Enter the rate you agreed on the call.');
  $('bk-save').disabled = true;
  try {
    await api('/api/admin/orders', { method: 'POST', body });
    $('bk-note').value = '';
    await loadAdmin();
    note('admmsg', 'Order booked for the client.', 'ok');
  } catch (e) { note('admmsg', e.message); }
  finally { $('bk-save').disabled = false; }
};

// plain-English line about where today's prices are coming from
function showBasis() {
  const s = (snap && snap.sources) || {};
  const el = $('adm-basis');
  if (!el) return;
  if (s.basis === 'mcx' && s.mcx) {
    el.innerHTML = `<b>MCX live</b> — gold ${fmt(s.mcx.gold && s.mcx.gold.price)}, silver ${fmt(s.mcx.silver && s.mcx.silver.price)}.`;
  } else if (s.basis === 'india' && s.india) {
    el.innerHTML = `<b>Indian benchmark, live</b> — IBJA ${fmt(s.india.ibjaGold999)} per 10g
      (${esc(s.india.published || 'today')}), moving with the market to ${fmt(s.india.liveGold)} now.`;
  } else {
    const why = s.mcxError ? `MCX unreachable (${esc(s.mcxError)})` : 'MCX unreachable';
    el.innerHTML = `<b>International spot</b> — ${why}. Set your carry &amp; premium below to match your board.`;
  }
}

$('adm-cash-save').onclick = async () => {
  $('adm-cash-save').disabled = true;
  try {
    // blank means "stop showing a cash rate", so send 0 rather than skipping it
    const r = await api('/api/admin/settings', { method: 'PATCH', body: {
      cash_gold_rate:     $('adm-cg').value    === '' ? 0 : $('adm-cg').value,
      cash_gold_995_rate: $('adm-cg995').value === '' ? 0 : $('adm-cg995').value,
      cash_silver_rate:   $('adm-cs').value    === '' ? 0 : $('adm-cs').value } });
    // show what the database really kept, not what we hoped it kept
    const s = (r && r.saved) || {};
    const show = v => (v && Number(v) > 0) ? fmt(Number(v)) : 'off';
    note('admmsg', `Saved. Gold 999 ${show(s.cash_gold_rate)} · 995 ${show(s.cash_gold_995_rate)} · silver ${show(s.cash_silver_rate)}`, 'ok');
  } catch (e) { note('admmsg', 'Not saved — ' + e.message); }
  finally { $('adm-cash-save').disabled = false; }
};

$('adm-save').onclick = async () => {
  $('adm-save').disabled = true;
  try {
    const body = {};
    const map = { 'adm-sg': 'global_spread_gold', 'adm-ss': 'global_spread_silver',
                  'adm-mg': 'margin_gold', 'adm-ms': 'margin_silver',
                  'adm-duty': 'duty_pct', 'adm-gst': 'gst_pct' };
    for (const k in map) if ($(k).value !== '') body[map[k]] = $(k).value;
    body.dealer_phone = $('adm-phone').value.trim();
    await api('/api/admin/settings', { method: 'PATCH', body });
    DEALER_PHONE = body.dealer_phone || DEALER_PHONE;
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
