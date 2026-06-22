import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { deleteTokens, upsertTokens } from "../db.js";
import { getGoogleAuthUrl, getOAuth2Client } from "../oauth/google.js";
import { exchangeTikTokCode, getTikTokAuthUrl } from "../oauth/tiktok.js";
import { putOAuthState, takeOAuthState } from "../oauthState.js";
import { isYoutubeConnected } from "../services/googleTokens.js";
import { isTiktokConnected } from "../services/tiktokTokens.js";

const router = Router();

function defaultUserId(): string {
  return process.env.DEFAULT_USER_ID ?? "default";
}

function frontendUrl(): string {
  return process.env.FRONTEND_URL ?? "http://localhost:5173";
}

router.get("/status", (_req, res) => {
  const userId = defaultUserId();
  res.json({
    userId,
    youtube: isYoutubeConnected(userId),
    tiktok: isTiktokConnected(userId),
  });
});

router.get("/google/start", (_req, res) => {
  const userId = defaultUserId();
  const state = uuidv4();
  putOAuthState(state, userId);
  const url = getGoogleAuthUrl(state);
  res.redirect(url);
});

router.get("/google/callback", async (req, res) => {
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
  const userId = takeOAuthState(state);
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
  const state = uuidv4();
  putOAuthState(state, userId);
  const url = getTikTokAuthUrl(state);
  res.redirect(url);
});

router.get("/tiktok/callback", async (req, res) => {
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
  const userId = takeOAuthState(state);
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

export default router;
