# VidPush

Single-owner web app: sign in with Google, drop one video, and publish to
YouTube, TikTok, Facebook Reels, and Instagram Reels. Each destination has its
own connection and upload result. Facebook and Instagram may use different
accounts.

- App: https://schalafi-vidpush--vidpush-web.modal.run/
- Public information / terms / privacy: https://schalafi.github.io/VidPush/
- [Account and cloud project registry (YAML)](docs/accounts.yaml)
- [Google sign-in setup](docs/google-auth-setup.md)
- [Facebook and Instagram setup](docs/meta-setup.md)
- [Modal deployment](docs/modal.md)

## Local setup

Node.js 22+ and npm are required.

```bash
npm install
cp .env.example .env
# Fill in the Google login credentials as documented above.
npm run dev
```

Open http://localhost:5173. The API listens on port 3000. Google login is
restricted to `doublef.corp@gmail.com` through `GOOGLE_ALLOWED_EMAIL`.
Use a dedicated login OAuth client and register
`http://localhost:3000/api/auth/login/google/callback`.

For explicit local access-key mode, set `APP_AUTH_PROVIDER=key` and generate
`VIDPUSH_API_KEY` with `openssl rand -hex 32`. Google mode rejects key-based
unlocking. Production deployment selects Google login.

## Connect destinations

### YouTube

Enable YouTube Data API v3 in Google Cloud. Create a Web application OAuth client,
add your account as a test user if appropriate, and configure:

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback`

Register the exact callback in Google Cloud. This authorization is separate from
VidPush sign-in. Click **Connect** for YouTube after signing in. Uploads use
**unlisted** visibility.

### TikTok

Enable Login Kit and Content Posting API with Direct Post. For sandbox use,
add your account as a target user and request `user.info.basic,video.publish`.
Configure `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, and
`TIKTOK_REDIRECT_URI`. TikTok needs a registered HTTPS callback, such as
`https://YOUR-HOST/api/auth/tiktok/callback`.

For local OAuth, set `NGROK_DOMAIN` privately in `.env`, register its exact
callback, and use `./scripts/start-vidpush.sh` or double-click
`Start VidPush.command`. The launcher starts VidPush and ngrok. Do not commit
your private ngrok hostname or token. Stop the tunnel when it is not needed.

Sandbox direct posting uses **SELF_ONLY**. Unaudited accounts may need private
account settings. Confirm TikTok's current app access requirements in its portal.

### Facebook and Instagram

Follow [the separate account setup guide](docs/meta-setup.md). Facebook needs a
Page with publishing access; choose the Page explicitly after connecting.
Instagram uses its own Business or Creator login. Configure each app's credentials
and callbacks. The UI shows **Setup needed** until configuration is present.

## Publish

1. Sign in and connect the destinations you want.
2. Select destinations and verify the displayed Facebook Page / Instagram name.
3. Drop or choose a video. An optional title is used as the Meta Reel caption.
4. Press **Upload** and review each platform's result.

Meta destinations publish Reels, not private drafts. The shared file limit is
5 GB, or 1 GB when Meta is selected; Meta inputs must be MP4 or MOV. Providers
also validate video encoding and duration. No transcoding is included.

Successful uploads clear the file and title. Failed results remain for review.
Deselect successful destinations before retrying to avoid duplicate publication.

## Checks

```bash
npm test
npm run build
git diff --check
```

Tests mock external providers; real login and publishing require configured
credentials and connected accounts. `/api/health` is public; sensitive APIs
require a session. Browser writes must match `FRONTEND_URL`.

## Storage and security

Publishing credentials and hashed session tokens are stored in SQLite under
`.data/` (or `DATA_DIR`). This remains one owner's shared publishing workspace.
Sessions expire after seven days and are revoked on sign-out. OAuth state is
short-lived, single-use, provider-specific, and bound to the initiating browser.
Production cookies are secure and HTTP-only.

Keep `.env`, client secrets, access keys, OAuth tokens, `.data`, and uploaded
videos out of Git. `.env.example` contains only configuration examples. Record
account/project ownership in `docs/accounts.yaml`, never secret values.

Upload jobs and pending OAuth flows are in memory. A restart/deployment can
interrupt them. Run one server/container; finish uploads before redeploying.
Temporary files are deleted after all selected destinations finish.

## Project layout

| Path | Purpose |
| --- | --- |
| `client/` | React / Vite frontend |
| `server/` | Express API, authentication, OAuth, upload workers |
| `server/test/` | Authentication and publishing tests |
| `docs/` | Setup guides and public legal pages |
| `modal_app.py` | Modal deployment |
| `.data/` | Ignored local database |

If the UI cannot reach the API, check startup configuration and port 3000.
A Google redirect mismatch means the callback does not exactly match the OAuth
client's registered URI. Use the login callback for sign-in and the original
Google callback for YouTube connections.
