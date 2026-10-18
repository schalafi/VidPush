import { graph, graphBase, metaRequest, type MetaPlatform } from "../services/metaApi.js";
export type FacebookPage = { id: string; name: string; access_token: string; tasks?: string[] };
export function metaConfig(platform: MetaPlatform) {
  const prefix = platform.toUpperCase();
  const id = process.env[`${prefix}_APP_ID`];
  const secret = process.env[`${prefix}_APP_SECRET`];
  const redirect = process.env[`${prefix}_REDIRECT_URI`];
  if (!id || !secret || !redirect) throw new Error(`${platform} connection is not configured yet`);
  return { id, secret, redirect };
}
export function metaConfigured(platform: MetaPlatform): boolean {
  try { metaConfig(platform); return true; } catch { return false; }
}
export function metaAuthUrl(platform: MetaPlatform, state: string): string {
  const config = metaConfig(platform);
  const url = new URL(platform === "facebook"
    ? `https://www.facebook.com/${process.env.META_API_VERSION ?? "v24.0"}/dialog/oauth`
    : "https://www.instagram.com/oauth/authorize");
  url.search = new URLSearchParams({ client_id: config.id, redirect_uri: config.redirect,
    response_type: "code", state, scope: platform === "facebook"
      ? "pages_show_list,pages_read_engagement,pages_manage_posts"
      : "instagram_business_basic,instagram_business_content_publish",
    ...(platform === "instagram" ? { force_authentication: "1", enable_fb_login: "0" } : { auth_type: "rerequest" }),
  }).toString();
  return url.toString();
}
type Token = { access_token: string; expires_in?: number };
export async function exchangeFacebook(code: string): Promise<{ pages: FacebookPage[]; expiresAt: number | null }> {
  const config = metaConfig("facebook");
  const endpoint = `${graphBase("facebook")}/oauth/access_token`;
  const short = await metaRequest<Token>(endpoint, { method: "POST", body: new URLSearchParams({
    client_id: config.id, client_secret: config.secret, redirect_uri: config.redirect, code,
  }) });
  if (!short.access_token) throw new Error("Facebook did not return a token");
  const long = await metaRequest<Token>(endpoint, { method: "POST", body: new URLSearchParams({
    grant_type: "fb_exchange_token", client_id: config.id, client_secret: config.secret, fb_exchange_token: short.access_token,
  }) });
  if (!long.access_token) throw new Error("Facebook did not return a long-lived token");
  const pages: FacebookPage[] = [];
  let after: string | undefined;
  do {
    const result = await graph<{ data: FacebookPage[]; paging?: { next?: string; cursors?: { after?: string } } }>(
      "facebook", "me/accounts", long.access_token, { fields: "id,name,access_token,tasks", limit: "100", ...(after ? { after } : {}) });
    pages.push(...result.data.filter(p => p.access_token && p.tasks?.some(t => ["CREATE_CONTENT", "MANAGE", "PROFILE_PLUS_CREATE_CONTENT", "PROFILE_PLUS_FULL_CONTROL"].includes(t))));
    after = result.paging?.next ? result.paging.cursors?.after : undefined;
  } while (after);
  if (!pages.length) throw new Error("No Facebook Pages with publishing access were granted.");
  return { pages, expiresAt: long.expires_in ? Date.now() + long.expires_in * 1000 : null };
}
export async function exchangeInstagram(code: string) {
  const config = metaConfig("instagram");
  const body = new FormData();
  for (const [key, value] of Object.entries({ client_id: config.id, client_secret: config.secret,
    grant_type: "authorization_code", redirect_uri: config.redirect, code })) body.set(key, value);
  const short = await metaRequest<Token>("https://api.instagram.com/oauth/access_token", { method: "POST", body });
  if (!short.access_token) throw new Error("Instagram did not return a token");
  const url = new URL("https://graph.instagram.com/access_token");
  url.search = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: config.secret, access_token: short.access_token }).toString();
  const long = await metaRequest<Token>(url.toString());
  if (!long.access_token || !long.expires_in) throw new Error("Instagram did not return a long-lived token");
  const account = await graph<{ user_id?: string; id: string; username: string }>("instagram", "me", long.access_token, { fields: "user_id,username" });
  const id = account.user_id ?? account.id;
  if (!id || !account.username) throw new Error("Instagram account could not be identified");
  return { token: long.access_token, expiresAt: Date.now() + long.expires_in * 1000, id: String(id), name: account.username };
}
