# RDgold — Bullion Trading App

Full clone of an Indian bullion dealer app: live gold/silver rates, buy/sell booking with 30-second locked quotes, limit orders with auto-fill, margin limits, per-client premiums, rate alerts, admin panel.

## What's inside

```
backend/   Node.js server — rates engine, REST API, WebSocket live feed, admin panel, SQLite DB
app/       Flutter Android app (client-facing)
```

## 1. Run the backend (5 minutes)

Needs Node 20+.

```bash
cd backend
npm install
npm start                       # runs on :8080
```

- Admin panel: http://localhost:8080/admin — login `admin` / `admin1234` (set `ADMIN_PASSWORD` env to change; change it before going live).
- Live rates: free via gold-api.com (XAU/XAG, no key) + open.er-api.com/frankfurter (USDINR). For MCX/IBJA-aligned rates set `METALS_DEV_KEY` (metals.dev, from $1.79/mo).
- Offline dev mode: `SIMULATE_RATES=1 npm start` (random-walk prices).
- Rate formula: `(XAUUSD/31.1035) × USDINR × grams × purity × (1 + 6% duty) + spread + premium`. GST 3% shown separately on buy invoices. Adjust duty/spread live from the admin panel to track MCX.
- Tests: `npm test` (24 end-to-end checks, all passing).

Deploy anywhere Node runs (Railway/Render/a ₹400/mo VPS). Put it behind HTTPS (Caddy/nginx) before real clients use it.

## 2. Build the Android app

Needs Flutter SDK (https://docs.flutter.dev/get-started/install). The repo ships the Dart source; generate the Android wrapper once:

```bash
cd app
flutter create . --platforms=android --project-name rdgold
flutter pub get
flutter run                     # on emulator: backend reachable at 10.0.2.2:8080 (default)
```

Point it at your real server and build the release APK:

```bash
flutter build apk --release --dart-define=SERVER=https://api.yourdomain.com
```

APK lands in `build/app/outputs/flutter-apk/app-release.apk`. (No Flutter installed locally? Push this repo to GitHub and let Codemagic build the APK free.)

## 3. Day-one operating flow

1. Client registers in the app → appears as **pending** in admin.
2. You verify KYC, set **status=active** and a **margin limit** (max open exposure ₹).
3. Client sees live rates (your premiums applied), taps BUY/SELL → gets a 30s locked rate → confirms.
4. Order hits the admin panel; client transfers via RTGS/NEFT (bank details in app) and sends UTR on WhatsApp.
5. You mark the order **Delivered** after settlement. Limit orders fill automatically when your rate crosses the client's level.
6. Tune per-product premiums, per-client premiums, global spread (to track MCX) and the market open/close switch from admin, live.

## Feature checklist vs SPN Gold

Live gold/silver/INR rates ✓ · product-wise buy/sell rates ✓ · rate booking ✓ · limit orders ✓ · modify/cancel pending ✓ · margin limits ✓ · per-client rate templates ✓ · price alerts ✓ · trade history & net position ✓ · bank details screen ✓ · market open/close ✓ · stale-rate indicator ✓ (their app lacks this) · no ads/trackers ✓ (their top complaint).

Not yet included (add later): SMS/WhatsApp OTP (plug MSG91), push notifications (Firebase FCM — alert events already broadcast on the WebSocket), price charts (rate history endpoint exists: `/api/rates/history`), delivery tracking stages, Excel export.

## Legal note (India)

Selling physical bullion to customers is ordinary trade (GST registration + proper invoicing). But offering margin/leveraged positions or unallocated "paper gold" without delivery can fall under forward-contract/derivatives rules (FCRA 1952 / SEBI) — dealers run booking apps as firm sale contracts with delivery. Confirm the model with a CA before launch. Not legal advice.

## 4. Free hosting on GitHub (website + APK downloads)

1. Create a free GitHub account → new public repo named `rdgold`.
2. Push this folder:
   ```bash
   git init && git add -A && git commit -m "RDgold v1"
   git branch -M main
   git remote add origin https://github.com/YOUR-GITHUB/rdgold.git
   git push -u origin main
   ```
3. **Website (free)**: repo → Settings → Pages → Source: "Deploy from a branch" → branch `main`, folder `/docs` → Save. Your site goes live at `https://YOUR-GITHUB.github.io/rdgold/` in ~2 minutes.
4. **APK downloads (free)**: build the APK (`flutter build apk --release --dart-define=SERVER=https://your-backend`), then repo → Releases → "Create a new release" → tag `v1.0.0` → attach `app-release.apk` (rename to `rdgold.apk`) → Publish. The site's download buttons already point to `releases/latest` — just replace `YOUR-GITHUB` with your username in `docs/index.html` (2 places).
5. **Backend**: GitHub can't run servers. Free options: Render.com free web service or Railway trial; set env `JWT_SECRET`, `ADMIN_PASSWORD`, `NODE_ENV=production`. Note Render free tier sleeps after idle (~50s cold start) — fine for testing, pay ~$7/mo or use a cheap VPS for live clients.

Also update the WhatsApp number in `docs/index.html` and the bank details from the admin panel.
