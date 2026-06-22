# VidPush (PoC)

Local web app to **drop one video** and upload it to **YouTube** and/or **TikTok** in parallel. OAuth tokens stay on your machine in a SQLite file under `.data/`.

## Prerequisites

- Node.js 20+ and npm
- Google Cloud project with **YouTube Data API v3** enabled
- TikTok developer app with **Login Kit** and **Content Posting API** (Direct Post), scopes: `user.info.basic`, `video.publish`

## Setup

1. **Clone / open this folder** and install dependencies:

   ```bash
   npm install
   ```

2. **Environment**: copy `.env.example` to **`.env` in the repo root** (same folder as `package.json`, not inside `server/`) and fill in:

   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — OAuth client (Web application). Authorized redirect URI: `http://localhost:3000/api/auth/google/callback`
   - `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI` — TikTok app. Redirect URI must match the portal and `.env` (default in example: `http://localhost:3000/api/auth/tiktok/callback`)

3. **Google Cloud console**

   - APIs & Services → Enable **YouTube Data API v3**
   - Credentials → OAuth 2.0 Client ID (Web)
   - Add authorized redirect URI exactly as in `.env`
   - Test users: add your Google account if the app is in Testing mode

4. **TikTok Developer Portal**

   - Add **Login Kit** and **Content Posting API**; enable **Direct Post** where required
   - Request `user.info.basic` and `video.publish`; use sandbox / test users until production approval
   - Register the same redirect URI as in `.env`

## Run

From the repo root:

```bash
npm run dev
```

- UI: [http://localhost:5173](http://localhost:5173)
- API: [http://localhost:3000](http://localhost:3000)

Connect YouTube and TikTok, choose destinations (with **Select all** / **Deselect all**), drop a file, then **Upload**. Progress polls per platform until both jobs finish.

## Behavior notes (PoC)

- **YouTube**: uploads as **unlisted** with title from optional field or filename; category “People & Blogs”.
- **TikTok**: uses **Direct Post** (`/v2/post/publish/video/init/`) with `privacy_level: SELF_ONLY` by default (adjust in code if your app allows broader visibility). After the file upload, the server **polls** `/v2/post/publish/status/fetch/` until `PUBLISH_COMPLETE` or failure.
- **Parallel uploads**: each selected platform runs in parallel; temporary files are deleted when jobs complete.
- **Multi-user later**: tokens are keyed by `DEFAULT_USER_ID` (`default` unless you change `.env`).

## Project layout

- `client/` — Vite + React UI
- `server/` — Express API, OAuth callbacks, SQLite (`.data/vidpush.db`), `server/uploads/` temp files

## Troubleshooting

- **“Cannot reach API”** in the UI: start the dev script so the server listens on port 3000.
- **TikTok init / publish errors**: confirm Direct Post + `video.publish` approval, sandbox user, and MP4 specs per TikTok docs.
- **Google `redirect_uri_mismatch`**: redirect URIs must match the OAuth client and `.env` exactly (including `http` and port).
