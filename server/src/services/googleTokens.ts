import { google } from "googleapis";
import { getOAuth2Client } from "../oauth/google.js";
import { deleteTokens, getTokens, upsertTokens } from "../db.js";

const BUFFER_MS = 60_000;

/** True when Google rejected the grant itself: the login was revoked or
 * expired and refreshing will never succeed. Anything else is transient. */
export function isLoginRevoked(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /invalid_grant/i.test(msg);
}

export async function getYoutubeAuthorizedClient(userId: string) {
  const row = getTokens(userId, "youtube");
  if (!row) throw new Error("YouTube not connected");

  const expired = !row.expires_at || row.expires_at < Date.now() + BUFFER_MS;
  if (expired && !row.refresh_token) {
    // Determinable locally: no grant to refresh with, so fail without
    // touching OAuth config or the network.
    deleteTokens(userId, "youtube");
    throw new Error("YouTube login expired; reconnect your account");
  }

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token ?? undefined,
  });

  if (expired) {
    try {
      const { credentials } = await oauth2.refreshAccessToken();
      const expiresAt = credentials.expiry_date ?? Date.now() + 3600 * 1000;
      upsertTokens(
        userId,
        "youtube",
        credentials.access_token!,
        credentials.refresh_token ?? row.refresh_token,
        expiresAt,
        null
      );
      oauth2.setCredentials(credentials);
    } catch (e) {
      if (isLoginRevoked(e)) {
        // Forget the dead grant so status checks report disconnected and
        // the UI asks for a fresh login instead of failing at upload time.
        deleteTokens(userId, "youtube");
        throw new Error("YouTube login expired; reconnect your account");
      }
      throw e;
    }
  }

  return google.youtube({ version: "v3", auth: oauth2 });
}

export function isYoutubeConnected(userId: string): boolean {
  return !!getTokens(userId, "youtube");
}

/**
 * Verified check for /status and pre-upload gates: true only when the
 * stored login still works. Refreshes an expired access token when the
 * grant allows it; forgets revoked grants. Transient network failures
 * keep the previous connected state instead of flapping the UI.
 */
export async function verifyYoutubeLogin(userId: string): Promise<boolean> {
  const row = getTokens(userId, "youtube");
  if (!row) return false;
  if (row.expires_at && row.expires_at > Date.now() + BUFFER_MS) return true;
  try {
    await getYoutubeAuthorizedClient(userId);
    return true;
  } catch (e) {
    if (isLoginRevoked(e)) return false;
    if (e instanceof Error && /not connected|login expired/i.test(e.message)) return false;
    return isYoutubeConnected(userId);
  }
}
