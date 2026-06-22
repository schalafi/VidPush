const AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";

const SCOPES = ["user.info.basic", "video.publish"].join(",");

function requireTikTokEnv() {
  const key = process.env.TIKTOK_CLIENT_KEY;
  const secret = process.env.TIKTOK_CLIENT_SECRET;
  const redirect = process.env.TIKTOK_REDIRECT_URI;
  if (!key || !secret || !redirect) {
    throw new Error("Missing TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, or TIKTOK_REDIRECT_URI");
  }
  return { key, secret, redirect };
}

export function getTikTokAuthUrl(state: string): string {
  const { key, redirect } = requireTikTokEnv();
  const params = new URLSearchParams({
    client_key: key,
    response_type: "code",
    scope: SCOPES,
    redirect_uri: redirect,
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export type TikTokTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  open_id: string;
  scope: string;
  token_type: string;
};

type TikTokTokenError = { error?: string; error_description?: string };

export async function exchangeTikTokCode(code: string): Promise<TikTokTokenResponse> {
  const { key, secret, redirect } = requireTikTokEnv();
  const body = new URLSearchParams({
    client_key: key,
    client_secret: secret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirect,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as TikTokTokenResponse & TikTokTokenError;
  if (!res.ok || !json.access_token) {
    throw new Error(
      json.error_description ?? json.error ?? `TikTok token exchange failed: ${res.status}`
    );
  }
  return json;
}

export async function refreshTikTokToken(refreshToken: string): Promise<TikTokTokenResponse> {
  const { key, secret } = requireTikTokEnv();
  const body = new URLSearchParams({
    client_key: key,
    client_secret: secret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as TikTokTokenResponse & TikTokTokenError;
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description ?? json.error ?? `TikTok refresh failed: ${res.status}`);
  }
  return json;
}
