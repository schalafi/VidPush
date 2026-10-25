import { deleteTokens, getTokens, upsertTokens } from "../db.js";
import { refreshTikTokToken } from "../oauth/tiktok.js";

const BUFFER_MS = 60_000;

/** True when TikTok rejected the grant itself: revoked or expired login. */
export function isTiktokLoginRevoked(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /invalid_grant|invalid_refresh_token|refresh_token.*(expired|invalid|revoked)/i.test(msg);
}

export async function getValidTikTokAccessToken(userId: string): Promise<{ accessToken: string; openId: string }> {
  const row = getTokens(userId, "tiktok");
  if (!row) throw new Error("TikTok not connected");

  if (row.expires_at && row.expires_at > Date.now() + BUFFER_MS) {
    return { accessToken: row.access_token, openId: row.open_id ?? "" };
  }

  if (!row.refresh_token) {
    deleteTokens(userId, "tiktok");
    throw new Error("TikTok login expired; reconnect your account");
  }

  try {
    const data = await refreshTikTokToken(row.refresh_token);
    const expiresAt = Date.now() + data.expires_in * 1000;
    upsertTokens(
      userId,
      "tiktok",
      data.access_token,
      data.refresh_token ?? row.refresh_token,
      expiresAt,
      data.open_id ?? row.open_id
    );
    return { accessToken: data.access_token, openId: data.open_id };
  } catch (e) {
    if (isTiktokLoginRevoked(e)) {
      deleteTokens(userId, "tiktok");
      throw new Error("TikTok login expired; reconnect your account");
    }
    throw e;
  }
}

export function isTiktokConnected(userId: string): boolean {
  return !!getTokens(userId, "tiktok");
}

/** Verified check for /status: true only when the stored login still works. */
export async function verifyTiktokLogin(userId: string): Promise<boolean> {
  const row = getTokens(userId, "tiktok");
  if (!row) return false;
  if (row.expires_at && row.expires_at > Date.now() + BUFFER_MS) return true;
  try {
    await getValidTikTokAccessToken(userId);
    return true;
  } catch (e) {
    if (isTiktokLoginRevoked(e)) return false;
    if (e instanceof Error && /not connected|login expired/i.test(e.message)) return false;
    return isTiktokConnected(userId);
  }
}
