import crypto from "crypto";
import type { Request, Response } from "express";
import { sessionCookieOptions } from "./middleware/apiAuth.js";
const store = new Map<string, { userId: string; provider: string; binding: string; nonce: string; created: number }>();
const TTL_MS = 10 * 60 * 1000;
const cookieName = (provider: string) => `vidpush_oauth_${provider}`;
export function beginOAuth(res: Response, provider: string, userId: string) {
  const state = crypto.randomBytes(32).toString("base64url");
  const binding = crypto.randomBytes(32).toString("base64url");
  const nonce = crypto.randomBytes(32).toString("base64url");
  store.set(state, { userId, provider, binding, nonce, created: Date.now() });
  res.cookie(cookieName(provider), binding, { ...sessionCookieOptions(), maxAge: TTL_MS });
  return { state, nonce };
}
export function finishOAuth(req: Request, res: Response, provider: string) {
  const state = req.query.state;
  const value = typeof state === "string" ? store.get(state) : undefined;
  if (!value || value.provider !== provider || value.binding !== req.cookies?.[cookieName(provider)]) return;
  store.delete(state as string);
  res.clearCookie(cookieName(provider), { path: "/" });
  if (Date.now() - value.created > TTL_MS) return;
  return value;
}
setInterval(() => {
  for (const [key, value] of store) if (Date.now() - value.created > TTL_MS) store.delete(key);
}, 60_000).unref();
