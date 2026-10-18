import assert from "node:assert/strict";
import { test, after, mock } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import express from "express";
import cookieParser from "cookie-parser";
const dir = mkdtempSync(`${tmpdir()}/vidpush-auth-`);
process.env.DATA_DIR = dir;
process.env.APP_AUTH_PROVIDER = "google";
process.env.GOOGLE_ALLOWED_EMAIL = "owner@example.com";
process.env.GOOGLE_LOGIN_CLIENT_ID = "test-client";
process.env.GOOGLE_LOGIN_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_LOGIN_REDIRECT_URI = "http://localhost/api/auth/login/google/callback";
process.env.FRONTEND_URL = "http://127.0.0.1:5173";
const auth = await import("../src/middleware/apiAuth.js");
const { db } = await import("../src/db.js");
const { allowedGoogleIdentity } = await import("../src/oauth/login.js");
const { beginOAuth, finishOAuth } = await import("../src/oauthState.js");
const routes = (await import("../src/routes/auth.js")).default;
const app = express(); app.use(express.json(), cookieParser(), auth.requireAuth);
app.use("/api/auth", routes);
app.get("/api/private", (_req, res) => res.json({ ok: true }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.on("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
test("owner authorization requires verified email, stable subject, and correct nonce", () => {
  const claims = { sub: "123", email: "OWNER@example.com", email_verified: true, nonce: "n" };
  assert.deepEqual(allowedGoogleIdentity(claims, "n"), { sub: "123", email: "owner@example.com" });
  for (const patch of [{ email: "other@example.com" }, { email_verified: false }, { sub: "" }, { nonce: "wrong" }]) {
    assert.equal(allowedGoogleIdentity({ ...claims, ...patch }, "n"), undefined);
  }
});
test("sessions expire, reject tampering, and are revoked on logout", async () => {
  const token = auth.createSession({ sub: "123", email: "owner@example.com" });
  const cookie = `vidpush_session=${token}`;
  assert.equal((await fetch(`${base}/api/private`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${base}/api/private`, { headers: { cookie: cookie + "x" } })).status, 401);
  assert.equal((await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie, origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie, origin: process.env.FRONTEND_URL! } })).status, 200);
  assert.equal((await fetch(`${base}/api/private`, { headers: { cookie } })).status, 401);
  const expired = auth.createSession({ sub: "123", email: "owner@example.com" });
  db.prepare("UPDATE sessions SET expires_at = 0").run();
  assert.equal((await fetch(`${base}/api/private`, { headers: { cookie: `vidpush_session=${expired}` } })).status, 401);
});
test("Google mode cannot be bypassed with legacy access key or cookie", async () => {
  process.env.VIDPUSH_API_KEY = "some-old-key";
  assert.equal(auth.verifyApiKey("some-old-key"), false);
  assert.equal((await fetch(`${base}/api/auth/unlock`, { method: "POST", headers: { origin: process.env.FRONTEND_URL!, "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: "some-old-key" }) })).status, 401);
});
test("login uses identity scopes and rejects callback with no browser state", async () => {
  const start = await fetch(`${base}/api/auth/login/google/start`, { redirect: "manual" });
  const url = new URL(start.headers.get("location")!);
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.ok(url.searchParams.get("nonce"));
  const response = await fetch(`${base}/api/auth/login/google/callback?code=bad&state=${url.searchParams.get("state")}`, { redirect: "manual" });
  assert.equal(response.headers.get("location"), `${process.env.FRONTEND_URL}/?login=failed`);
  assert.equal(response.headers.get("set-cookie"), null);
});
test("OAuth state is provider-specific, browser-bound, and single use", () => {
  let binding = "";
  const res = { cookie: (_n: string, value: string) => { binding = value; }, clearCookie: () => {} } as any;
  const { state } = beginOAuth(res, "login", "owner");
  const req = { query: { state }, cookies: { vidpush_oauth_login: binding } } as any;
  assert.equal(finishOAuth({ ...req, cookies: {} }, res, "login"), undefined);
  assert.equal(finishOAuth(req, res, "youtube"), undefined);
  assert.equal(finishOAuth(req, res, "login")?.userId, "owner");
  assert.equal(finishOAuth(req, res, "login"), undefined);
});

test("verified Google callback creates a session and cannot be replayed", async () => {
  const { google } = await import("googleapis");
  const start = await fetch(`${base}/api/auth/login/google/start`, { redirect: "manual" });
  const url = new URL(start.headers.get("location")!);
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  const tokenMock = mock.method(google.auth.OAuth2.prototype, "getToken", async () => ({ tokens: { id_token: "signed-test-token" } }));
  const verifyMock = mock.method(google.auth.OAuth2.prototype, "verifyIdToken", async (options: any) => {
    assert.equal(options.audience, "test-client");
    assert.equal(options.idToken, "signed-test-token");
    return { getPayload: () => ({ sub: "123", email: "owner@example.com", email_verified: true, nonce: url.searchParams.get("nonce") }) };
  });
  try {
    const callback = `${base}/api/auth/login/google/callback?code=test&state=${url.searchParams.get("state")}`;
    const response = await fetch(callback, { redirect: "manual", headers: { cookie } });
    assert.equal(response.headers.get("location"), process.env.FRONTEND_URL);
    const sessionCookie = response.headers.getSetCookie().find(value => value.startsWith("vidpush_session="))!.split(";")[0];
    assert.equal((await fetch(`${base}/api/private`, { headers: { cookie: sessionCookie } })).status, 200);
    const replay = await fetch(callback, { redirect: "manual", headers: { cookie } });
    assert.equal(replay.headers.get("location"), `${process.env.FRONTEND_URL}/?login=failed`);
    assert.equal(tokenMock.mock.callCount(), 1);
  } finally { tokenMock.mock.restore(); verifyMock.mock.restore(); }
});

test("tunnel callback completes on the configured UI host before checking browser state", async () => {
  const origin = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = "http://localhost:5173";
  try {
    const response = await fetch(`${base}/api/auth/tiktok/callback?code=test&state=state&redirect=https://evil.example`, { redirect: "manual" });
    assert.equal(response.headers.get("location"), "http://localhost:5173/api/auth/tiktok/complete?code=test&state=state");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  } finally { process.env.FRONTEND_URL = origin; }
});

test("Facebook handoff accepts a second browser but only the initiating session can claim Pages", async () => {
  process.env.FACEBOOK_APP_ID = "fb-test";
  process.env.FACEBOOK_APP_SECRET = "fb-secret";
  process.env.FACEBOOK_REDIRECT_URI = `${base}/api/auth/facebook/callback`;
  const metaRoutes = (await import("../src/routes/metaAuth.js")).default;
  app.use("/api/auth", metaRoutes);
  const cookie = `vidpush_session=${auth.createSession({ sub: "123", email: "owner@example.com" })}`;
  const otherCookie = `vidpush_session=${auth.createSession({ sub: "123", email: "owner@example.com" })}`;
  const headers = { cookie, origin: process.env.FRONTEND_URL! };
  assert.equal((await fetch(`${base}/api/auth/facebook/handoff`, { method: "POST", headers: { origin: headers.origin } })).status, 401);
  assert.equal((await fetch(`${base}/api/auth/facebook/handoff`, { method: "POST", headers: { cookie, origin: "https://evil.example" } })).status, 403);
  const start = await fetch(`${base}/api/auth/facebook/handoff`, { method: "POST", headers });
  const pending = await start.json() as { id: string; url: string };
  const state = new URL(pending.url).searchParams.get("state")!;
  assert.ok(!pending.url.includes(pending.id));
  const claimUrl = `${base}/api/auth/facebook/handoff/${pending.id}/claim`;
  assert.equal((await fetch(claimUrl, { method: "POST", headers: { ...headers, cookie: otherCookie } })).status, 410);
  assert.equal((await (await fetch(claimUrl, { method: "POST", headers })).json() as any).status, "waiting");
  const originalFetch = globalThis.fetch;
  let exchanges = 0;
  const mocked = mock.method(globalThis, "fetch", async (input: any, init: any) => {
    if (String(input).startsWith("https://graph.facebook.com/")) {
      exchanges++;
      return new Response(JSON.stringify(String(input).includes("me/accounts")
        ? { data: [{ id: "page-handoff", name: "Test Page", access_token: "private-page-token", tasks: ["CREATE_CONTENT"] }] }
        : { access_token: "private-token", expires_in: 3600 }), { status: 200 });
    }
    return originalFetch(input, init);
  });
  try {
    const callbackUrl = `${base}/api/auth/facebook/callback?state=${state}&code=valid`;
    const callback = await fetch(callbackUrl, { redirect: "manual" }); // No cookies in browser B.
    assert.equal(callback.status, 200);
    assert.equal(callback.headers.get("location"), null);
    assert.equal(callback.headers.get("set-cookie"), null);
    assert.match(await callback.text(), /Return to your original VidPush tab/);
    assert.equal(db.prepare("SELECT id FROM facebook_pages WHERE id = 'page-handoff'").get(), undefined);
    await fetch(callbackUrl);
    assert.equal(exchanges, 3); // Replay never exchanges again.
    const claimed = await fetch(claimUrl, { method: "POST", headers });
    assert.deepEqual(await claimed.json(), { status: "ready" });
    assert.ok(db.prepare("SELECT id FROM facebook_pages WHERE id = 'page-handoff'").get());
    assert.equal((await fetch(claimUrl, { method: "POST", headers })).status, 410);
  } finally { mocked.mock.restore(); }
});

test("Facebook handoff expires, supersedes old links, and propagates cancellation", async () => {
  const flow = await import("../src/facebookHandoff.js");
  const first = flow.startFacebookHandoff("session", "owner");
  const second = flow.startFacebookHandoff("session", "owner");
  assert.equal(flow.acceptFacebookHandoff(first.state), undefined);
  const item = flow.acceptFacebookHandoff(second.state)!;
  flow.finishFacebookHandoff(item, undefined, "Authorization cancelled");
  assert.equal(flow.readFacebookHandoff(second.id, "session")?.error, "Authorization cancelled");
  assert.equal(flow.readFacebookHandoff(second.id, "other"), undefined);
  const time = mock.method(Date, "now", () => item.expires + 1);
  try { assert.equal(flow.readFacebookHandoff(second.id, "session"), undefined); }
  finally { time.mock.restore(); }
});
