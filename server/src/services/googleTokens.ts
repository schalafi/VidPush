import { google } from "googleapis";
import { getOAuth2Client } from "../oauth/google.js";
import { getTokens, upsertTokens } from "../db.js";

const BUFFER_MS = 60_000;

export async function getYoutubeAuthorizedClient(userId: string) {
  const row = getTokens(userId, "youtube");
  if (!row) throw new Error("YouTube not connected");

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token ?? undefined,
  });

  if (!row.expires_at || row.expires_at < Date.now() + BUFFER_MS) {
    if (!row.refresh_token) {
      throw new Error("YouTube token expired; reconnect your account");
    }
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
  }

  return google.youtube({ version: "v3", auth: oauth2 });
}

export function isYoutubeConnected(userId: string): boolean {
  return !!getTokens(userId, "youtube");
}
