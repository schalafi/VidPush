# Deploy VidPush to Modal

This deployment serves the UI and API at one HTTPS address. It is a personal,
Google-sign-in-protected application, with one shared set of connected accounts.

Project environment: `vidpush` in workspace `schalafi`.
Application URL: https://schalafi-vidpush--vidpush-web.modal.run
Redeploy with `modal deploy --env vidpush modal_app.py`.
The official CLI is installed with `uv tool install modal`; open a new terminal
if your current shell does not yet find `modal`.

1. Install the Modal Python CLI and authenticate (`modal setup`).
2. Choose the deployment environment. Run `modal profile current` and
   `modal environment list` to confirm the account and environment.
3. Create a Modal Secret named `vidpush-config` in that environment using the
   Modal dashboard. Copy the following values from your local `.env`:
   `GOOGLE_LOGIN_CLIENT_ID`, `GOOGLE_LOGIN_CLIENT_SECRET`,
   `GOOGLE_ALLOWED_EMAIL=doublef.corp@gmail.com`,
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `TIKTOK_CLIENT_KEY`, and `TIKTOK_CLIENT_SECRET`.
4. Add the following URL values to that Secret. For the default environment,
   the expected URL is `https://WORKSPACE--vidpush-web.modal.run`; confirm the
   actual address in deployment output and update the Secret if different:

   ```text
   FRONTEND_URL=https://WORKSPACE--vidpush-web.modal.run
   GOOGLE_LOGIN_REDIRECT_URI=https://WORKSPACE--vidpush-web.modal.run/api/auth/login/google/callback
   GOOGLE_REDIRECT_URI=https://WORKSPACE--vidpush-web.modal.run/api/auth/google/callback
   TIKTOK_REDIRECT_URI=https://WORKSPACE--vidpush-web.modal.run/api/auth/tiktok/callback
   ```

5. From the project root, run `modal deploy modal_app.py`. If using a named
   environment, pass `--env ENVIRONMENT`. Redeploy after updating the Secret.
6. Register the exact Google callback in Google Cloud's OAuth client settings
   and the TikTok callback in TikTok's Login Kit settings. Set the Google
   authorized JavaScript origin to the deployed app URL.
7. Follow [Google sign-in setup](google-auth-setup.md) and register its separate
   login callback. Add Facebook/Instagram settings from [Meta setup](meta-setup.md)
   when those accounts are ready.
8. Open the deployed URL, sign in with the authorized Google account, and connect accounts.
   Local OAuth tokens are intentionally not copied into the deployment.

## CI/CD

Pushing to GitHub does NOT deploy. The [CI workflow](../.github/workflows/ci.yml)
runs `npm test` and `npm run build` on every push and pull request. When tests
pass on a push to `main`, it deploys with `modal deploy --env vidpush
modal_app.py` and then checks `/api/health`.

One-time setup: the `vidpush` environment already exists in the GitHub repo; add
secrets `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` from a Modal token key pair.
Deploys serialize through the `vidpush-deploy` concurrency group, so finish
uploads before merging to `main`.

## Storage and lifecycle

The `vidpush-data` Volume holds the SQLite account database. Modal periodically
commits Volume changes and commits again at shutdown; very recent writes can be
lost on an abrupt failure. Local secrets, the local database, and uploaded videos
are excluded from the image. Temporary uploads remain on container disk and are
deleted after processing.

One container stays running to support the existing background upload workers;
it incurs compute charges while idle. Do not increase the container count while
the app uses SQLite and in-memory OAuth state and jobs. Container replacement,
crashes, or deployments can interrupt uploads and lose job status or an OAuth
handshake. Finish uploads before redeploying. Durable job queues and a managed
database are needed before expanding beyond this personal PoC deployment.

Verify `/api/health`, the sign-in page, unauthorized API rejection, successful
Google login, each configured OAuth connection, and a small video upload after deployment.
Large uploads are also subject to Modal's HTTP request limits.
