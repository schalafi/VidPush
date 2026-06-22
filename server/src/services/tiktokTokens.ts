import { getTokens, upsertTokens } from "../db.js";
import { refreshTikTokToken } from "../oauth/tiktok.js";

const BUFFER_MS = 60_000;

export async function getValidTikTokAccessToken(userId: string): Promise<{ accessToken: string; openId: string }> {
  const row = getTokens(userId, "tiktok");
  if (!row) throw new Error("TikTok not connected");

  if (row.expires_at && row.expires_at > Date.now() + BUFFER_MS) {
    return { accessToken: row.access_token, openId: row.open_id ?? "" };
  }

  if (!row.refresh_token) {
    throw new Error("TikTok token expired; reconnect your account");
  }

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
}

export function isTiktokConnected(userId: string): boolean {
  return !!getTokens(userId, "tiktok");
}
