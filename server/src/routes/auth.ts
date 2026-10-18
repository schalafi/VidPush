import { Router } from "express";
import { db, deleteTokens, upsertTokens } from "../db.js";
import {
  isAuthenticated,
  sessionCookieOptions,
  createSession,
  getSessionIdentity,
  revokeSession,
  authProvider,
  SESSION_COOKIE,
  verifyApiKey,
} from "../middleware/apiAuth.js";
import { getGoogleAuthUrl, getOAuth2Client } from "../oauth/google.js";
import { exchangeTikTokCode, getTikTokAuthUrl } from "../oauth/tiktok.js";
import { beginOAuth, finishOAuth } from "../oauthState.js";
import { getLoginClient, allowedGoogleIdentity } from "../oauth/login.js";
import { isYoutubeConnected } from "../services/googleTokens.js";
import { isTiktokConnected } from "../services/tiktokTokens.js";

import { metaConnection } from "../services/metaTokens.js";
import { metaConfigured } from "../oauth/meta.js";

const router = Router();

function defaultUserId(): string {
  return process.env.DEFAULT_USER_ID ?? "default";
}

function frontendUrl(): string {
  return process.env.FRONTEND_URL ?? "http://localhost:5173";
}

router.get("/session", (req, res) => {
  res.json({ authenticated: isAuthenticated(req), provider: authProvider(), user: getSessionIdentity(req) });
});

router.post("/unlock", (req, res) => {
  const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey : "";
  if (!verifyApiKey(apiKey)) {
    res.status(401).json({ error: "Invalid access key" });
    return;
  }
  revokeSession(req);
  res.cookie(SESSION_COOKIE, createSession({ sub: "local-key", email: "" }), sessionCookieOptions());
  res.json({ ok: true });
});

router.post("/logout", (req, res) => {
  revokeSession(req);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

router.get("/status", (_req, res) => {
  const userId = defaultUserId();
  res.json({
    userId,
    youtube: isYoutubeConnected(userId),
    tiktok: isTiktokConnected(userId),
    facebook: { ...metaConnection(userId, "facebook"), configured: metaConfigured("facebook") },
    instagram: { ...metaConnection(userId, "instagram"), configured: metaConfigured("instagram") },
    facebookPages: db.prepare("SELECT id, name FROM facebook_pages WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)").all(userId, Date.now()),
  });
});

router.get("/google/start", (_req, res) => {
  const userId = defaultUserId();
  const { state } = beginOAuth(res, "youtube", userId);
  const url = getGoogleAuthUrl(state);
  res.redirect(url);
});

router.get(["/google/callback", "/google/complete"], async (req, res) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const err = req.query.error as string | undefined;
  if (err) {
    res.redirect(`${frontendUrl()}/?oauth=google_error&message=${encodeURIComponent(err)}`);
    return;
  }
  if (!code || !state) {
    res.redirect(`${frontendUrl()}/?oauth=google_error&message=missing_code`);
    return;
  }
  const userId = finishOAuth(req, res, "youtube")?.userId;
  if (!userId) {
    res.redirect(`${frontendUrl()}/?oauth=google_error&message=invalid_state`);
    return;
  }
  try {
    const oauth2 = getOAuth2Client();
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.access_token) throw new Error("No access token from Google");
    const expiresAt = tokens.expiry_date ?? Date.now() + 3600 * 1000;
    upsertTokens(
      userId,
      "youtube",
      tokens.access_token,
      tokens.refresh_token ?? null,
      expiresAt,
      null
    );
    res.redirect(`${frontendUrl()}/?oauth=google_ok`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "google_token_failed";
    res.redirect(`${frontendUrl()}/?oauth=google_error&message=${encodeURIComponent(msg)}`);
  }
});

router.get("/tiktok/start", (_req, res) => {
  const userId = defaultUserId();
  const { state } = beginOAuth(res, "tiktok", userId);
  const url = getTikTokAuthUrl(state);
  res.redirect(url);
});

router.get(["/tiktok/callback", "/tiktok/complete"], async (req, res) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const oauthErr = req.query.error as string | undefined;
  if (oauthErr) {
    res.redirect(
      `${frontendUrl()}/?oauth=tiktok_error&message=${encodeURIComponent(oauthErr)}`
    );
    return;
  }
  if (!code || !state) {
    res.redirect(`${frontendUrl()}/?oauth=tiktok_error&message=missing_code`);
    return;
  }
  const userId = finishOAuth(req, res, "tiktok")?.userId;
  if (!userId) {
    res.redirect(`${frontendUrl()}/?oauth=tiktok_error&message=invalid_state`);
    return;
  }
  try {
    const data = await exchangeTikTokCode(code);
    const expiresAt = Date.now() + data.expires_in * 1000;
    upsertTokens(
      userId,
      "tiktok",
      data.access_token,
      data.refresh_token ?? null,
      expiresAt,
      data.open_id ?? null
    );
    res.redirect(`${frontendUrl()}/?oauth=tiktok_ok`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "tiktok_token_failed";
    res.redirect(`${frontendUrl()}/?oauth=tiktok_error&message=${encodeURIComponent(msg)}`);
  }
});

router.delete("/google", (_req, res) => {
  deleteTokens(defaultUserId(), "youtube");
  res.json({ ok: true });
});

router.delete("/tiktok", (_req, res) => {
  deleteTokens(defaultUserId(), "tiktok");
  res.json({ ok: true });
});

router.get("/login/google/start", (_req, res) => {
  if (authProvider() !== "google") { res.status(404).end(); return; }
  try {
    const client = getLoginClient();
    const { state, nonce } = beginOAuth(res, "login", "owner");
    res.redirect(client.generateAuthUrl({ scope: ["openid", "email", "profile"], state, nonce, prompt: "select_account" }));
  } catch {
    res.redirect(`${frontendUrl()}/?login=unavailable`);
  }
});
router.get(["/login/google/callback", "/login/google/complete"], async (req, res) => {
  const pending = finishOAuth(req, res, "login");
  if (authProvider() !== "google" || !pending || typeof req.query.code !== "string" || req.query.error) {
    res.redirect(`${frontendUrl()}/?login=failed`); return;
  }
  try {
    const client = getLoginClient();
    const { tokens } = await client.getToken(req.query.code);
    if (!tokens.id_token) throw new Error("Missing ID token");
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_LOGIN_CLIENT_ID });
    const identity = allowedGoogleIdentity(ticket.getPayload(), pending.nonce);
    if (!identity) { res.redirect(`${frontendUrl()}/?login=denied`); return; }
    revokeSession(req);
    res.cookie(SESSION_COOKIE, createSession(identity), sessionCookieOptions());
    res.redirect(frontendUrl());
  } catch {
    res.redirect(`${frontendUrl()}/?login=failed`);
  }
});

export default router;
