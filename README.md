# VidPush (PoC)

Local web app to **drop one video** and upload it to **YouTube** and/or **TikTok** in parallel. OAuth tokens stay on your machine in a SQLite file under `.data/`.

Public info site (Terms/Privacy): [https://schalafi.github.io/VidPush/](https://schalafi.github.io/VidPush/)

---

## Prerequisites

- **Node.js 20+** and **npm** (`node -v`, `npm -v`)
- **Google Cloud** project with [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com) enabled
- **TikTok developer** app (Sandbox) with **Login Kit** + **Content Posting API** (Direct Post on)
- **ngrok** (for TikTok OAuth only — TikTok does not allow `localhost` redirect URIs)

Install ngrok (macOS):

```bash
brew install ngrok
ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN
```

---

## First-time setup (init)

Run these once after cloning the repo.

### 1. Install dependencies

From the repo root (folder with `package.json`):

```bash
cd /path/to/VidPush
npm install
```

### 2. Create your local `.env`

The app reads **`.env`** at the **repo root** (not inside `server/`).

```bash
cp .env.example .env
```

Fill in secrets in `.env` (see [Environment variables](#environment-variables) below).

Generate a local access key (required):

```bash
openssl rand -hex 32
```

Paste the output into `.env` as `VIDPUSH_API_KEY`. You will enter this once in the browser when the app starts — it is **not** shipped in the client or committed to git.

Optional: keep a personal backup in **`.env.local.example`** (gitignored) with your filled values.

**Never commit** `.env`, `.env.local.example`, ngrok authtokens, or Google `client_secret*.json` files.

### 3. Google / YouTube OAuth

In [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials**:

1. Create an **OAuth 2.0 Client ID** (type **Web application**).
2. **Authorized JavaScript origins:** `http://localhost:5173`
3. **Authorized redirect URIs:**

   ```text
   http://localhost:3000/api/auth/google/callback
   ```

4. Copy **Client ID** and **Client secret** into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. If the app is in **Testing** mode, add your Google account under **OAuth consent screen → Test users**.

### 4. TikTok OAuth (Sandbox)

In [TikTok for Developers](https://developers.tiktok.com/) → your app → **Sandbox**:

| Setting | Value |
|--------|--------|
| **Products** | Login Kit + Content Posting API |
| **Direct Post** | ON |
| **Scopes** | `user.info.basic`, `video.publish` |
| **Sandbox → Target users** | Add your TikTok account |
| **App details URLs** | Terms/Privacy/Website → your GitHub Pages URLs |

**Redirect URI (Login Kit → Web):** TikTok requires **HTTPS** — not `localhost`. Use your **private** ngrok domain from `.env`:

```text
https://YOUR-SUBDOMAIN.ngrok-free.dev/api/auth/tiktok/callback
```

In `.env`, set:

- `NGROK_DOMAIN=YOUR-SUBDOMAIN.ngrok-free.dev` (host only — for the start script)
- `TIKTOK_REDIRECT_URI=https://YOUR-SUBDOMAIN.ngrok-free.dev/api/auth/tiktok/callback` (full callback URL)

Register the **same** `TIKTOK_REDIRECT_URI` in the TikTok developer portal, and add `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` from **App details → Credentials**.

Do **not** put your real ngrok subdomain in the public repo — keep it in `.env` only.

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PORT` | API port (default `3000`) |
| `FRONTEND_URL` | UI URL after OAuth (default `http://localhost:5173`) |
| `VIDPUSH_API_KEY` | **Local access key** — unlock the UI (generate with `openssl rand -hex 32`) |
| `NGROK_DOMAIN` | Your reserved ngrok host only (e.g. `abc.ngrok-free.dev`) — **keep in `.env` only** |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | YouTube OAuth |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3000/api/auth/google/callback` |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | TikTok OAuth |
| `TIKTOK_REDIRECT_URI` | **HTTPS ngrok** callback — must match `NGROK_DOMAIN` and TikTok portal |

Template with empty values: [`.env.example`](.env.example) (safe to commit).

---

## Security and local auth

VidPush runs on your machine, but **TikTok OAuth needs a public HTTPS tunnel** (ngrok). While that tunnel is open, strangers could theoretically reach your API if they guess the URL.

### What must stay private (never commit)

| Secret | Where it lives |
|--------|----------------|
| `VIDPUSH_API_KEY` | `.env` only |
| `NGROK_DOMAIN` / `TIKTOK_REDIRECT_URI` | `.env` only |
| `GOOGLE_CLIENT_SECRET`, `TIKTOK_CLIENT_SECRET` | `.env` only |
| ngrok authtoken | `~/.config/ngrok/` (or ngrok config on your Mac) |
| OAuth tokens | `.data/vidpush.db` (gitignored) |

### How auth works

1. You set `VIDPUSH_API_KEY` in `.env` (a long random string).
2. When you open the UI, you see an **Unlock** screen and paste that key **once**.
3. The server checks the key and sets an **httpOnly cookie** (a session) in your browser.
4. All sensitive API routes (upload, connect, disconnect, status) require that cookie.
5. Click **Lock** in the header to clear the session.

The access key is **never** embedded in the React app or the public repo — only you know it from `.env`.

### What stays public (by design)

These paths must work without your cookie so OAuth providers can redirect back:

- `GET /api/auth/google/callback`
- `GET /api/auth/tiktok/callback`
- `GET /api/health` (returns `{"ok":true}` only)

Everything else returns **401 Unauthorized** without a valid session.

### Practical habits

- **Stop ngrok** when you are not connecting TikTok (`Ctrl+C` or quit the start script).
- **Use placeholders** in docs/issues — never paste your real ngrok subdomain or API key.
- **Regenerate** `VIDPUSH_API_KEY` if you think it was leaked.

---

## Run the app (every day)

You need **two terminals** the first time you connect TikTok (or after tokens expire). For uploads only, one terminal is enough if accounts are already connected.

### Terminal 1 — VidPush

```bash
cd /path/to/VidPush
npm run dev
```

Wait until you see **both**:

- `Local: http://localhost:5173/` (UI)
- `VidPush API http://localhost:3000` (API)

Open the UI: [http://localhost:5173](http://localhost:5173)

**First visit each session:** enter your `VIDPUSH_API_KEY` on the Unlock screen.

If the UI shows “Cannot reach API”, wait a second and **refresh** — the client sometimes starts before the API.

### macOS shortcut

Double-click **`Start VidPush.command`** (or run `./scripts/start-vidpush.sh`). It reads `NGROK_DOMAIN` from `.env` and starts ngrok when set.

### Terminal 2 — ngrok (for TikTok Connect)

Only needed when connecting or reconnecting **TikTok** (the start script can do this automatically if `NGROK_DOMAIN` is in `.env`):

```bash
ngrok http --url=YOUR-SUBDOMAIN.ngrok-free.dev 3000
```

Verify the tunnel hits your API:

```text
https://YOUR-SUBDOMAIN.ngrok-free.dev/api/health
```

Should return: `{"ok":true}` (health is public; uploads still require unlock).

### Connect accounts (once per machine)

1. Open [http://localhost:5173](http://localhost:5173) and **Unlock** with your `VIDPUSH_API_KEY`
2. Click **Connect** for **YouTube** (no ngrok needed)
3. Click **Connect** for **TikTok** (ngrok must be running)
4. Both should show **Connected**

### Upload a video

1. Toggle **YouTube** / **TikTok** (or **Select all**)
2. Drop a video or browse for a file
3. Optional: set title
4. Click **Upload** and wait for per-platform status **Done**

Start with a **small MP4** (short clip, under ~50 MB) when testing.

---

## Stop the app

In each terminal where something is running, press **Ctrl+C**:

1. Terminal with `npm run dev` — stops UI + API
2. Terminal with `ngrok` — stops the public tunnel

---

## Quick reference (cheat sheet)

```bash
# First time only
npm install
cp .env.example .env
openssl rand -hex 32   # → paste as VIDPUSH_API_KEY in .env
# edit .env: OAuth keys, NGROK_DOMAIN, TIKTOK_REDIRECT_URI

# Every session
./scripts/start-vidpush.sh              # or npm run dev + ngrok manually
# Browser: unlock with VIDPUSH_API_KEY, then use the app

# Stop
# Ctrl+C in each terminal (or stop Start VidPush.command)
```

---

## Behavior notes (PoC)

- **YouTube**: uploads as **unlisted**; title from the form or filename.
- **TikTok**: **Direct Post** with `privacy_level: SELF_ONLY` by default (only you may see the post in sandbox).
- **Parallel uploads**: both platforms upload at the same time when both toggles are on.
- **Tokens**: stored in `.data/vidpush.db` on your machine.

---

## Project layout

| Path | Purpose |
|------|---------|
| `client/` | Vite + React UI |
| `server/` | Express API, OAuth, uploads |
| `docs/` | Public legal pages (GitHub Pages — not dev run docs) |
| `.data/` | Local SQLite + tokens (gitignored) |
| `.env` | Your secrets (gitignored) |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| **Unauthorized / Unlock screen** | Set `VIDPUSH_API_KEY` in `.env` and restart the server; enter the same value in the UI |
| **Cannot reach API** | Ensure `npm run dev` is running; refresh after API line appears |
| **TikTok: localhost redirect not supported** | Use ngrok HTTPS URL in TikTok portal and `TIKTOK_REDIRECT_URI` |
| **TikTok Connect fails** | ngrok running on port **3000**; sandbox test user added; redirect URI matches exactly |
| **TikTok content-sharing-guidelines / init failed** | Sandbox/unaudited app: set TikTok account to **Private** in the TikTok app (Settings → Privacy), then retry upload with **SELF_ONLY** |
| **Google redirect_uri_mismatch** | Google Console URI must match `GOOGLE_REDIRECT_URI` in `.env` |
| **Missing TIKTOK_CLIENT_KEY** | `.env` at **repo root**; restart `npm run dev` after editing |
| **Proxy ECONNREFUSED on startup** | Harmless race — refresh the browser |

---

## Test checklist

- [ ] `VIDPUSH_API_KEY` set in `.env`; UI unlock works
- [ ] `http://localhost:3000/api/health` → `{"ok":true}`
- [ ] YouTube **Connected** → upload one video → **Done** → check YouTube Studio
- [ ] TikTok **Connected** (with ngrok) → upload one video → **Done** → check TikTok profile
- [ ] Both toggles on → single upload → both **Done**
