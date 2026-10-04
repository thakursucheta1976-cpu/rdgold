# RDgold — deploy

Two things to put online: the **backend** (Render) and the **website** (GitHub Pages).

---

## 1. Push this folder to GitHub

Double-click `PUSH_TO_GITHUB.bat`. It asks once for a GitHub token
(github.com → Settings → Developer settings → Personal access tokens →
Tokens (classic) → Generate new → tick **repo** → copy).
The token is used for that one push and not saved anywhere.

Result: https://github.com/thakursucheta1976-cpu/rdgold

---

## 2. Website — GitHub Pages (free)

Repo → **Settings → Pages** → Source: *Deploy from a branch* →
Branch `main`, folder **/docs** → Save.

Live in ~1 minute at: **https://thakursucheta1976-cpu.github.io/rdgold/**

---

## 3. Backend — Render

Render → **New → Blueprint** → connect this repo → it reads `render.yaml`.
You only have to type one value: **ADMIN_PASSWORD**.
(`JWT_SECRET` is generated for you. `METALS_DEV_KEY` is optional.)

When it finishes, Render gives you a URL like
`https://rdgold-backend.onrender.com`.

### If your URL is different
Render adds a suffix when the name is taken. If your URL is not exactly
`https://rdgold-backend.onrender.com`, change one line in `docs/index.html`:

```js
|| 'https://rdgold-backend.onrender.com').replace(/\/+$/,'');
   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ put your real URL here
```

You can test any URL without editing anything:
`https://thakursucheta1976-cpu.github.io/rdgold/?api=https://your-url.onrender.com`

### Plan — read this before choosing
`render.yaml` asks for **starter ($7/mo) + a 1 GB disk (~$0.25/mo)**. That is
deliberate:

- Render's **free** tier has **no disk**. The SQLite file lives in the
  container, and the container is wiped on every deploy *and* every wake from
  sleep. **Every client account, order, margin limit and premium would be
  erased.** Fine for a demo. Not fine for a dealer book.
- Free also **sleeps after 15 minutes idle** and takes ~60s to wake. Your rate
  engine stops polling while asleep, so the first app open shows STALE for a
  minute.

To try it free first: delete the whole `disk:` block, set `plan: free`, and
delete the `DB_PATH` env var. Move to starter before any real client touches it.

---

## 4. Point the Android app at the backend

```
flutter create . --platforms=android --project-name rdgold
flutter build apk --release --dart-define=SERVER=https://rdgold-backend.onrender.com
```

Upload `build/app/outputs/flutter-apk/app-release.apk` to a GitHub **Release**.
The site's download buttons already point at `/releases/latest`.

---

## 5. Still to fill in

- `docs/index.html` line ~133: WhatsApp number is still `+91 00000 00000`
- Bank details: set them in the admin panel at `https://your-backend/admin`
  (login `admin` / the ADMIN_PASSWORD you set)
