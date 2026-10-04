// End-to-end smoke test. Run with: SIMULATE_RATES=1 node test/smoke.js
// Starts server in-process on :8099 with a temp DB, exercises every flow.
process.env.SIMULATE_RATES = '1';
process.env.PORT = '8099';
process.env.DB_PATH = '/tmp/bullion-test-' + Date.now() + '.db';
process.env.ADMIN_PASSWORD = 'admin1234';

await import('../src/server.js');
const { __setMcxForTest } = await import('../src/rates.js');
await new Promise(r => setTimeout(r, 1500)); // let rates engine tick

const B = 'http://localhost:8099/api';
let fails = 0;
const ok = (name, cond, extra='') => { console.log((cond?'PASS':'FAIL') + '  ' + name + (extra?'  '+extra:'')); if(!cond) fails++; };
const j = (r) => r.json();
const post = (p, body, tok) => fetch(B+p, {method:'POST', headers:{'Content-Type':'application/json', ...(tok?{Authorization:'Bearer '+tok}:{})}, body:JSON.stringify(body)});
const get = (p, tok) => fetch(B+p, {headers: tok?{Authorization:'Bearer '+tok}:{}});
const patch = (p, body, tok) => fetch(B+p, {method:'PATCH', headers:{'Content-Type':'application/json', Authorization:'Bearer '+tok}, body:JSON.stringify(body)});

// rates public
let r = await j(await get('/rates'));
ok('rates served', r.products?.length === 3 && r.products[0].buy > 0, `gold999 buy=₹${r.products[0].buy}`);
ok('rates not stale', r.stale === false);

// register + login
const DEV = 'device-aaaaaaaa1';
let reg = await j(await post('/register', {phone:'9999990001', name:'Test Trader', password:'secret12', deviceId:DEV}));
ok('register', !!reg.token);
let dup = await post('/register', {phone:'9999990001', name:'X', password:'secret12', deviceId:DEV});
ok('duplicate phone rejected', dup.status === 409);
let badlogin = await post('/login', {phone:'9999990001', password:'wrong', deviceId:DEV});
ok('bad login rejected', badlogin.status === 401);
let login = await j(await post('/login', {phone:'9999990001', password:'secret12', deviceId:DEV}));
const tok = login.token;

// pending user can't trade
let qr = await post('/quote', {productCode:'GOLD999', side:'buy', qty:1}, tok);
ok('pending user blocked from trading', qr.status === 403);

// admin approves + sets margin
let adm = await j(await post('/login', {phone:'admin', password:'admin1234'}));
ok('admin login', !!adm.token);
let users = await j(await get('/admin/users', adm.token));
const uid = users.find(u=>u.phone==='9999990001').id;
await patch('/admin/users/'+uid, {status:'active', margin_limit: 100000000}, adm.token);

// quote + market order
let quote = await j(await (await post('/quote', {productCode:'GOLD999', side:'buy', qty:2}, tok)));
ok('quote issued', !!quote.quoteId && quote.rate > 0, `rate=₹${quote.rate} gst=₹${quote.gstAmount} total=₹${quote.total}`);
ok('gst = 3%', Math.abs(quote.gstAmount - Math.round(quote.rate*2*0.03)) <= 1);
let ord = await j(await post('/orders', {type:'market', quoteId: quote.quoteId, idempotencyKey:'k1'}, tok));
ok('market order executed', ord.status === 'executed' && ord.rate === quote.rate);
let ord2 = await j(await post('/orders', {type:'market', quoteId: quote.quoteId, idempotencyKey:'k1'}, tok));
ok('idempotency: same order returned', ord2.id === ord.id);
let reuse = await post('/orders', {type:'market', quoteId: quote.quoteId, idempotencyKey:'k2'}, tok);
ok('quote reuse rejected', reuse.status === 409);

// margin enforcement
await patch('/admin/users/'+uid, {margin_limit: 1000}, adm.token);
let qdeny = await post('/quote', {productCode:'GOLD999', side:'buy', qty:1}, tok);
ok('margin limit enforced', qdeny.status === 403);
await patch('/admin/users/'+uid, {margin_limit: 100000000}, adm.token);

// limit order placement + cancel
let lim = await j(await post('/orders', {type:'limit', productCode:'GOLD999', side:'buy', qty:1, limitRate: 1}, tok));
ok('limit order pending', lim.status === 'pending');
let cancel = await j(await fetch(B+'/orders/'+lim.id, {method:'DELETE', headers:{Authorization:'Bearer '+tok}}));
ok('limit order cancelled', cancel.ok === true);

// limit order that should fill (buy limit above current rate)
r = await j(await get('/rates'));
const cur = r.products.find(p=>p.code==='GOLD999').buy;
let lim2 = await j(await post('/orders', {type:'limit', productCode:'GOLD999', side:'buy', qty:1, limitRate: cur + 10000}, tok));
await new Promise(res => setTimeout(res, 3000));
let orders = await j(await get('/orders', tok));
const filled = orders.find(o=>o.id===lim2.id);
ok('limit order auto-filled', filled.status === 'executed', `filled @₹${filled.rate}`);

// position
let pos = await j(await get('/position', tok));
ok('position computed', pos.positions.length >= 1 && pos.positions[0].net_qty === 3);

// alerts
let al = await j(await post('/alerts', {productCode:'GOLD999', direction:'below', targetRate: cur + 50000}, tok));
await new Promise(res => setTimeout(res, 3000));
let als = await j(await get('/alerts', tok));
ok('alert fired', als.find(a=>a.id===al.id).triggered === 1);

// the market kill-switch is gone: the setting can no longer be flipped from the API
let killSwitch = await patch('/admin/settings', {market_open:'false'}, adm.token);
ok('market_open can no longer be changed', killSwitch.status === 400);
let stillOpen = await j(await get('/rates'));
ok('market stays open', stillOpen.marketOpen === true);

// per-client premium
await patch('/admin/users/'+uid, {premium_gold: 500}, adm.token);
let rPers = await j(await get('/rates', tok));
let rPub = await j(await get('/rates'));
ok('per-client premium applied', rPers.products[0].buy - rPub.products[0].buy >= 490, `Δ=${rPers.products[0].buy - rPub.products[0].buy}`);


// admin auth boundaries
let noadm = await get('/admin/users', tok);
ok('trader blocked from admin', noadm.status === 403);

// quote expiry
const expq = await j(await post('/quote', {productCode:'GOLD999', side:'sell', qty:1}, tok));
// simulate expiry by direct wait is 30s — instead check sell side works
ok('sell quote works', expq.rate > 0 && expq.gstAmount === 0);
let sellOrd = await j(await post('/orders', {type:'market', quoteId: expq.quoteId}, tok));
ok('sell order executed', sellOrd.status === 'executed');

// ---- regression tests for audit fixes ----

// XSS: reject angle brackets in name
let xssReg = await post('/register', {phone:'9999990002', name:'<img src=x onerror=alert(1)>', password:'secret12'});
ok('XSS name rejected at register', xssReg.status === 400);

// IDOR: user B cannot fetch A's order via idempotency key
const DEV3 = 'device-cccccccc3';
await post('/register', {phone:'9999990003', name:'Other Trader', password:'secret12', deviceId:DEV3});
let other = await j(await post('/login', {phone:'9999990003', password:'secret12', deviceId:DEV3}));
let users2 = await j(await get('/admin/users', adm.token));
const uid2 = users2.find(u=>u.phone==='9999990003').id;
await patch('/admin/users/'+uid2, {status:'active', margin_limit: 100000000}, adm.token);
let idorQuote = await j(await post('/quote', {productCode:'GOLD999', side:'buy', qty:1}, other.token));
let idorOrd = await j(await post('/orders', {type:'market', quoteId: idorQuote.quoteId, idempotencyKey:'k1'}, other.token)); // A's key
ok('idempotency key scoped per-user (no IDOR)', idorOrd.id !== ord.id && idorOrd.status === 'executed');

// margin stacking: two quotes within limit individually, second order must be rejected
r = await j(await get('/rates'));
const g = r.products.find(p=>p.code==='GOLD999').buy;
await patch('/admin/users/'+uid2, {margin_limit: Math.round(g*2.5)}, adm.token); // room for ~1.5 more units (already holds 1)
let qa = await j(await post('/quote', {productCode:'GOLD999', side:'buy', qty:1}, other.token));
let qb = await j(await post('/quote', {productCode:'GOLD999', side:'buy', qty:1}, other.token));
let oa = await j(await post('/orders', {type:'market', quoteId: qa.quoteId}, other.token));
let obRes = await post('/orders', {type:'market', quoteId: qb.quoteId}, other.token);
ok('margin re-checked at execution (stacking blocked)', oa.status === 'executed' && obRes.status === 403);

// settings whitelist + validation
let badSet = await patch('/admin/settings', {gst_pct:'oops'}, adm.token);
ok('bad gst_pct rejected', badSet.status === 400);
let unkSet = await patch('/admin/settings', {evil_key:'1'}, adm.token);
ok('unknown setting rejected', unkSet.status === 400);
let unknownSetting = await patch('/admin/settings', {bank_details:'{}'}, adm.token);
ok('removed settings are rejected', unknownSetting.status === 400);

// alert input validation
let badAlert = await post('/alerts', {productCode:'GOLD999', direction:'above', targetRate: true}, tok);
ok('non-numeric alert rejected', badAlert.status === 400);
let badAlert2 = await post('/alerts', {productCode:'NOPE', direction:'above', targetRate: 100}, tok);
ok('unknown product alert rejected', badAlert2.status === 404);

// deactivated product: quote then deactivate then execute must fail
let prods = await j(await get('/admin/products', adm.token));
const g995 = prods.find(p=>p.code==='GOLD995');
let dq = await j(await post('/quote', {productCode:'GOLD995', side:'buy', qty:1}, tok));
await patch('/admin/products/'+g995.id, {active:0}, adm.token);
let dOrd = await post('/orders', {type:'market', quoteId: dq.quoteId}, tok);
ok('order on deactivated product rejected', dOrd.status === 409);
await patch('/admin/products/'+g995.id, {active:1}, adm.token);

// exposure: buy then sell same product should NET (not add)
let posA = await j(await get('/position', tok));
ok('netted exposure (flat-ish after buy+sell)', posA.openExposure < 4 * g, `exposure=₹${Math.round(posA.openExposure)}`);

// admin user PATCH validation
let badMl = await patch('/admin/users/'+uid, {margin_limit:'NaN-ish'}, adm.token);
ok('bad margin_limit rejected', badMl.status === 400);

// /api/me
let me = await j(await get('/me', tok));
ok('/api/me returns profile', me.phone === '9999990001' && me.status === 'active');

// ---- login auditing ----
let lg = await j(await get('/admin/logins', adm.token));
ok('logins recorded', Array.isArray(lg) && lg.length > 0, `${Array.isArray(lg)?lg.length:0} entries`);
ok('login row has who/when', !!(lg[0] && lg[0].phone && lg[0].ts));

await post('/login', {phone:'9999990001', password:'wrong-one'});
let lg2 = await j(await get('/admin/logins', adm.token));
ok('failed attempt recorded', lg2.length > lg.length && lg2[0].ok === 0);

let us = await j(await get('/admin/users', adm.token));
let row = us.find(u => u.phone === '9999990001');
ok('user shows last_login', !!(row && row.last_login), `count=${row && row.login_count}`);

let notadmin = await get('/admin/logins', tok);
ok('logins are admin-only', notadmin.status === 403);

// ---- GST-inclusive price, international leg, movement tracking ----
let gq = await j(await get('/rates'));
let g9 = gq.products.find(p => p.code === 'GOLD999');
ok('GST-inclusive price present', g9.buyWithGst > g9.buy, `${g9.buy} -> ${g9.buyWithGst}`);
const expected = Math.round(g9.buy * (1 + gq.gstPct / 100));
ok('GST maths correct', g9.buyWithGst === expected, `expected ${expected}`);
ok('gold carries its USD spot', g9.spotUsd > 0, `XAU ${g9.spotUsd}`);
let s9 = gq.products.find(p => p.code === 'SILVER999');
ok('silver carries its own USD spot', s9.spotUsd > 0 && s9.spotUsd !== g9.spotUsd, `XAG ${s9.spotUsd}`);
ok('silver priced separately from gold', s9.buy > 0 && s9.buy !== g9.buy);
ok('movement is reported', gq.moved && typeof gq.moved.goldMsAgo === 'number', `${gq.moved && gq.moved.goldMsAgo}ms`);

// ---- dealer's own cash rate, set by the admin ----
let c0 = await j(await get('/rates'));
ok('cash rate hidden until published', c0.products.every(p => p.cash === null));

await patch('/admin/settings', { cash_gold_rate: 101500, cash_silver_rate: 152000 }, adm.token);
let c1 = await j(await get('/rates'));
let cg = c1.products.find(p => p.code === 'GOLD999');
let cs = c1.products.find(p => p.code === 'SILVER999');
ok('cash gold shows per 10g', cg.cash === 101500, `got ${cg.cash}`);
ok('cash silver shows per kg', cs.cash === 152000, `got ${cs.cash}`);
let c995 = c1.products.find(p => p.code === 'GOLD995');
ok('cash scales down for 995 purity', c995.cash < cg.cash && c995.cash > cg.cash * 0.99,
   `999 ${cg.cash} vs 995 ${c995.cash}`);

let badCash = await patch('/admin/settings', { cash_gold_rate: 'not-a-number' }, adm.token);
ok('bad cash rate rejected', badCash.status === 400);

let notAdminCash = await patch('/admin/settings', { cash_gold_rate: 1 }, tok);
ok('only admins set the cash rate', notAdminCash.status === 403);

await patch('/admin/settings', { cash_gold_rate: 0, cash_silver_rate: 0 }, adm.token);
let c2 = await j(await get('/rates'));
ok('cash rate can be switched off', c2.products.every(p => p.cash === null));

// ---- rate freshness is reported, not hidden ----
let fr = await j(await get('/rates'));
ok('spot age reported', typeof fr.spotAgeMs === 'number' && fr.spotAgeMs < 10000, `age=${fr.spotAgeMs}ms`);
ok('fx block present', !!fr.fx && 'live' in fr.fx && 'source' in fr.fx, `source=${fr.fx && fr.fx.source}`);
ok('fx marked live in simulate mode', fr.fx.live === true);
ok('fx age reported', typeof fr.fx.ageMs === 'number');

// engine ticks at ~1s: two reads a second apart must show a newer timestamp
const t0 = (await j(await get('/rates'))).ts;
await new Promise(r => setTimeout(r, 2200));
const t1 = (await j(await get('/rates'))).ts;
ok('rates refresh within ~1s', t1 > t0, `+${t1 - t0}ms`);

// ---- deploy readiness: CORS + health ----
let hz = await fetch('http://localhost:8099/healthz');
ok('healthz responds', hz.status === 200 && (await hz.json()).ok === true);

let cr = await fetch(B+'/rates', { headers: { Origin: 'https://thefactual.github.io' } });
ok('CORS header on /api/rates', cr.headers.get('access-control-allow-origin') !== null,
   'allow-origin=' + cr.headers.get('access-control-allow-origin'));

let pf = await fetch(B+'/rates', { method:'OPTIONS', headers:{ Origin:'https://thefactual.github.io',
   'Access-Control-Request-Method':'GET' } });
ok('CORS preflight 204', pf.status === 204 && pf.headers.get('access-control-allow-origin') !== null);

let ch = await fetch(B+'/rates/history?hours=1', { headers:{ Origin:'https://thefactual.github.io' } });
ok('CORS header on /api/rates/history', ch.headers.get('access-control-allow-origin') !== null);

let evil = await fetch(B+'/me', { headers:{ Origin:'https://evil.example', Authorization:'Bearer '+tok } });
ok('unknown origin gets no CORS on private endpoints', evil.headers.get('access-control-allow-origin') === null);

let good = await fetch(B+'/me', { headers:{ Origin:'http://localhost:8091', Authorization:'Bearer '+tok } });
ok('app origin allowed on private endpoints', good.headers.get('access-control-allow-origin') === 'http://localhost:8091');

let lpf = await fetch(B+'/login', { method:'OPTIONS', headers:{ Origin:'http://localhost:8091',
  'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type' } });
ok('login preflight passes for the app origin', lpf.status === 204 &&
   (lpf.headers.get('access-control-allow-headers')||'').toLowerCase().includes('content-type'));

let evilpf = await fetch(B+'/login', { method:'OPTIONS', headers:{ Origin:'https://evil.example',
  'Access-Control-Request-Method':'POST' } });
ok('login preflight refused for unknown origin', evilpf.headers.get('access-control-allow-origin') === null);

let pubAny = await fetch(B+'/rates', { headers:{ Origin:'https://anything.example' } });
ok('public rates still open to any origin', pubAny.headers.get('access-control-allow-origin') === '*');

// ---- profile + dealer phone ----
let cfg0 = await j(await get('/config'));
ok('config endpoint public', typeof cfg0.dealerPhone === 'string');
ok('no bank details anywhere', cfg0.bank === undefined && (await get('/bank-details')).status === 404);

let setPh = await patch('/admin/settings', { dealer_phone: '+919876543210' }, adm.token);
ok('admin can set dealer phone', setPh.status === 200);
let badPh = await patch('/admin/settings', { dealer_phone: 'call-me' }, adm.token);
ok('bad dealer phone rejected', badPh.status === 400);
let cfg1 = await j(await get('/config'));
ok('dealer phone published', cfg1.dealerPhone === '+919876543210');

let prof = await j(await patch('/me', { name:'Updated Name', city:'Pune', email:'t@x.com',
  pan:'ABCDE1234F', gst:'27ABCDE1234F1Z5', address:'Zaveri Bazaar' }, tok));
ok('profile saved', prof.name === 'Updated Name' && prof.city === 'Pune' &&
   prof.email === 't@x.com' && prof.address === 'Zaveri Bazaar');

let blank = await patch('/me', { name:'' }, tok);
ok('empty name rejected', blank.status === 400);
let nothing = await patch('/me', {}, tok);
ok('empty profile patch rejected', nothing.status === 400);

let badPw = await patch('/me', { currentPassword:'wrong', newPassword:'newsecret1' }, tok);
ok('password change needs the current password', badPw.status === 400);
let shortPw = await patch('/me', { currentPassword:'secret12', newPassword:'123' }, tok);
ok('short password rejected', shortPw.status === 400);
let okPw = await patch('/me', { currentPassword:'secret12', newPassword:'newsecret1' }, tok);
ok('password changed', okPw.status === 200);
let reLogin = await post('/login', { phone:'9999990001', password:'newsecret1', deviceId:DEV });
ok('login works with the new password', reLogin.status === 200);
let oldLogin = await post('/login', { phone:'9999990001', password:'secret12', deviceId:DEV });
ok('old password no longer works', oldLogin.status === 401);

let noAuth = await fetch(B+'/me', { method:'PATCH', headers:{'Content-Type':'application/json'}, body:'{"name":"hacker"}' });
ok('profile edit needs a token', noAuth.status === 401);

// ---- one account, one phone ----
let noDev = await post('/login', { phone:'9999990001', password:'newsecret1' });
ok('login without a device id refused', noDev.status === 400);

let otherDev = await post('/login', { phone:'9999990001', password:'newsecret1', deviceId:'device-bbbbbbbb2' });
ok('second phone refused', otherDev.status === 403);

let sameDev = await j(await post('/login', { phone:'9999990001', password:'newsecret1', deviceId:DEV }));
ok('same phone still works', !!sameDev.token);

let admNoDev = await post('/login', { phone:'admin', password:'admin1234' });
ok('admin is exempt from the device lock', admNoDev.status === 200);

let listed = await j(await get('/admin/users', adm.token));
ok('admin sees the linked phone', !!listed.find(u => u.phone === '9999990001').device_id);

await patch('/admin/users/'+uid, { device_reset: true }, adm.token);
let afterReset = await j(await post('/login', { phone:'9999990001', password:'newsecret1', deviceId:'device-bbbbbbbb2' }));
ok('after a reset the new phone can sign in', !!afterReset.token);

let oldTok = await get('/me', sameDev.token);
ok('the old phone is signed out', oldTok.status === 401);
let newTok = await get('/me', afterReset.token);
ok('the new phone works', newTok.status === 200);

// ---- the dealer books orders for clients ----
let bk = await j(await post('/admin/orders', { userId: uid, productCode:'GOLD999', side:'buy',
  qty: 2, rate: 118900, note:'booked on call' }, adm.token));
ok('admin books an order for a client', !!bk.id);

const ctok = afterReset.token;   // the trader's current token after the device reset
let clientOrders = await j(await get('/orders', ctok));
const booked = clientOrders.find(o => o.id === bk.id);
ok('the client sees it in their orders', !!booked && booked.qty === 2 && booked.status === 'executed');

let badQty = await post('/admin/orders', { userId: uid, productCode:'GOLD999', side:'buy', qty: 0, rate: 1 }, adm.token);
ok('zero quantity rejected', badQty.status === 400);
let badProd = await post('/admin/orders', { userId: uid, productCode:'NOPE', side:'buy', qty: 1, rate: 1 }, adm.token);
ok('unknown product rejected', badProd.status === 400);
let badUser = await post('/admin/orders', { userId: 999999, productCode:'GOLD999', side:'buy', qty: 1, rate: 1 }, adm.token);
ok('unknown client rejected', badUser.status === 400);
let notAdmin = await post('/admin/orders', { userId: uid, productCode:'GOLD999', side:'buy', qty: 1, rate: 1 }, ctok);
ok('only admins can book for a client', notAdmin.status === 403);

await patch('/admin/orders/'+bk.id, { status:'delivered' }, adm.token);
let after = await j(await get('/orders', ctok));
ok('status update reaches the client', after.find(o => o.id === bk.id).status === 'delivered');

// ---- cash rates: 999, 995 and silver, and proof they were really stored ----
let cashSave = await j(await patch('/admin/settings',
  { cash_gold_rate: 118900, cash_gold_995_rate: 0, cash_silver_rate: 148500 }, adm.token));
ok('settings reply says what was stored', cashSave.saved.cash_gold_rate === '118900');

let withCash = await j(await get('/rates'));
const x999 = withCash.products.find(p => p.code === 'GOLD999');
const x995 = withCash.products.find(p => p.code === 'GOLD995');
const cSil = withCash.products.find(p => p.code === 'SILVER999');
ok('cash shows for gold 999', x999.cash === 118900);
ok('cash for 995 is scaled from 999 when left blank', x995.cash === Math.round(118900 * (0.995 / 0.999)));
ok('cash shows for silver', cSil.cash === 148500);

await patch('/admin/settings', { cash_gold_995_rate: 118300 }, adm.token);
let own = await j(await get('/rates'));
ok('995 uses its own rate once typed', own.products.find(p => p.code === 'GOLD995').cash === 118300);

await patch('/admin/settings', { cash_gold_995_rate: 0 }, adm.token);
let back = await j(await get('/rates'));
ok('clearing 995 falls back to the scaled rate',
   back.products.find(p => p.code === 'GOLD995').cash === Math.round(118900 * (0.995 / 0.999)));

await patch('/admin/settings', { cash_gold_rate: 0, cash_silver_rate: 0 }, adm.token);
let noCash = await j(await get('/rates'));
ok('cash can be switched off again', noCash.products.every(p => p.cash === null));

let diag = await j(await get('/admin/diag', adm.token));
ok('diagnostics prove the database keeps writes', diag.writesPersist === true, diag.database);
let diagClient = await get('/admin/diag', ctok);
ok('diagnostics are admin only', diagClient.status === 403);

// ---- a settings row can never be duplicated (the live-database bug) ----
db_dupe: {
  // write the same key many times; there must still be exactly one row for it
  for (let i = 0; i < 5; i++) await patch('/admin/settings', { cash_gold_rate: 100000 + i }, adm.token);
  let hz = await (await fetch('http://localhost:8099/healthz')).json();
  ok('no duplicate settings rows after repeated saves', hz.settingsRows === hz.settingsKeys,
     `${hz.settingsRows} rows / ${hz.settingsKeys} keys`);
  ok('market stays open', hz.marketOpen === true);

  // and the value that survives is the last one written
  let r2 = await j(await get('/rates'));
  ok('the last saved cash rate is the one in use',
     r2.products.find(p => p.code === 'GOLD999').cash === 100004);
  await patch('/admin/settings', { cash_gold_rate: 0 }, adm.token);
}

// ---- every number says where it came from ----
let src = (await j(await get('/rates'))).sources;
ok('the snapshot names its metals source', typeof src.metals === 'string' && src.metals.length > 0, src.metals);
ok('the snapshot names its fx source', typeof src.fx === 'string' && src.fx.length > 0, src.fx);
ok('a feed disagreement flag is present', typeof src.suspect === 'boolean');

// ---- pricing off MCX, the official Indian exchange ----
__setMcxForTest({ gold:   { price: 150250, contract: 'GOLD 04DEC2026' },
                  silver: { price: 225545, contract: 'SILVER 04DEC2026' },
                  at: Date.now() });
await patch('/admin/settings', { price_basis: 'mcx', global_spread_gold: 0, global_spread_silver: 0,
                                 cash_gold_rate: 0, cash_gold_995_rate: 0, cash_silver_rate: 0 }, adm.token);
let mcxRates = await j(await get('/rates'));
ok('the snapshot says it is pricing off MCX', mcxRates.sources.basis === 'mcx', mcxRates.sources.basis);
ok('MCX contracts are named', mcxRates.sources.mcx.gold.contract === 'GOLD 04DEC2026');

const m995 = mcxRates.products.find(p => p.code === 'GOLD995');
const m999 = mcxRates.products.find(p => p.code === 'GOLD999');
const mSil = mcxRates.products.find(p => p.code === 'SILVER999');
// the MCX gold contract is 995, so 995 tracks it and 999 sits a touch above
ok('995 matches the MCX contract', Math.abs(m995.buy - 150250) <= 300, `${m995.buy} vs 150250`);
ok('999 is scaled up from the 995 contract', m999.buy > m995.buy && m999.buy < m995.buy * 1.01,
   `${m999.buy} vs ${m995.buy}`);
ok('silver matches the MCX contract', Math.abs(mSil.buy - 225545) <= 600, `${mSil.buy} vs 225545`);

// a stale exchange feed must not be used
__setMcxForTest({ gold: { price: 150250, contract: 'GOLD 04DEC2026' }, silver: null, at: Date.now() - 20 * 60_000 });
let staleMcx = await j(await get('/rates'));
ok('a stale MCX feed falls back to international spot', staleMcx.sources.basis === 'spot');

// and the dealer can choose to price off spot instead
__setMcxForTest({ gold: { price: 150250, contract: 'GOLD 04DEC2026' }, silver: null, at: Date.now() });
await patch('/admin/settings', { price_basis: 'spot' }, adm.token);
ok('the dealer can switch back to spot', (await j(await get('/rates'))).sources.basis === 'spot');
let badBasis = await patch('/admin/settings', { price_basis: 'nonsense' }, adm.token);
ok('an unknown basis is rejected', badBasis.status === 400);
await patch('/admin/settings', { price_basis: 'mcx' }, adm.token);

console.log(fails === 0 ? '\nALL TESTS PASSED' : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
