import { getTokens, upsertTokens } from "../db.js";
import { metaRequest, type MetaPlatform } from "./metaApi.js";
export function metaConnection(userId: string, platform: MetaPlatform) {
  const row = getTokens(userId, platform);
  return { connected: Boolean(row?.open_id && row.access_token && (!row.expires_at || row.expires_at > Date.now())),
    accountId: row?.open_id ?? null, name: row?.account_name ?? null };
}
export async function metaCredentials(userId: string, platform: MetaPlatform) {
  const row = getTokens(userId, platform);
  if (!row?.open_id || !row.access_token || (row.expires_at && row.expires_at <= Date.now())) {
    throw new Error(`Reconnect ${platform} before uploading`);
  }
  if (platform === "instagram" && row.expires_at && row.expires_at < Date.now() + 7 * 24 * 3600_000) {
    const url = new URL("https://graph.instagram.com/refresh_access_token");
    url.search = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: row.access_token }).toString();
    const refreshed = await metaRequest<{ access_token: string; expires_in: number }>(url.toString());
    if (!refreshed.access_token || !refreshed.expires_in) throw new Error("Reconnect Instagram to renew publishing access");
    upsertTokens(userId, platform, refreshed.access_token, null, Date.now() + refreshed.expires_in * 1000, row.open_id, row.account_name);
    return { token: refreshed.access_token, id: row.open_id };
  }
  return { token: row.access_token, id: row.open_id };
}
