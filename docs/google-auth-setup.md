# VidPush Google sign-in setup

Account ownership, project identifiers, OAuth client details, and setup status
are tracked in [accounts.yaml](accounts.yaml). Update that file as configuration
is completed. It is an inventory; runtime configuration remains in `.env` and
Modal Secrets.

## Setup

1. Sign into Google Cloud as `doublef.corp@gmail.com`. Create or select the
   VidPush project and record its exact project name, ID, and number in
   `accounts.yaml` under `google_cloud.project`.
2. Configure Google Auth Platform branding and audience. If using an external
   testing audience, add `doublef.corp@gmail.com` as a test user.
3. Create a Web application OAuth client for app login, separate from the
   existing YouTube publishing client. Register these exact redirect URIs:

   - Local: `http://localhost:3000/api/auth/login/google/callback`
   - Modal: `https://schalafi-vidpush--vidpush-web.modal.run/api/auth/login/google/callback`

4. Set these values in the ignored local `.env` and in Modal's `vidpush-config`
   Secret in the `vidpush` environment:

   ```dotenv
   APP_AUTH_PROVIDER=google
   GOOGLE_ALLOWED_EMAIL=doublef.corp@gmail.com
   GOOGLE_LOGIN_CLIENT_ID=<login client ID>
   GOOGLE_LOGIN_CLIENT_SECRET=<login client secret>
   GOOGLE_LOGIN_REDIRECT_URI=https://schalafi-vidpush--vidpush-web.modal.run/api/auth/login/google/callback
   FRONTEND_URL=https://schalafi-vidpush--vidpush-web.modal.run
   COOKIE_SECURE=true
   ```

   Locally use the local callback, `FRONTEND_URL=http://localhost:5173`, and
   `COOKIE_SECURE=false`. Never paste a client secret into this document or chat.
5. Build and test, then deploy. Complete a browser sign-in using the owner
   account, verify another account is rejected, and verify sign-out blocks API
   access. Until credentials and callback registration are complete, Google
   login cannot be exercised end to end.

## Authentication behavior

Login requests only `openid email profile`. The Google library validates the
ID token's signature, audience, issuer, and expiry. VidPush additionally checks
its nonce, verified email, and subject, and permits only the configured owner.
OAuth state is single-use, expires after ten minutes, and is bound to the browser
and provider. Identity tokens are not stored as publishing credentials.

Sessions use random opaque cookies with only a hash stored in SQLite. They
expire on the server after seven days and are revoked on sign-out. Changing the
allowed email invalidates prior-owner sessions. Production cookies are HTTP-only,
Secure, and SameSite=Lax. Browser mutations require the configured UI origin.

The single-owner publishing workspace and existing YouTube/TikTok connections
are preserved. Google login does not grant YouTube publishing access; connect
YouTube separately with the existing `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
and `GOOGLE_REDIRECT_URI` settings.

`APP_AUTH_PROVIDER=key` is an explicit local-development fallback. Google mode
rejects access-key unlocking and old deterministic session cookies. Modal's
deployment configuration explicitly selects Google mode.

Official protocol reference: https://developers.google.com/identity/openid-connect/openid-connect
