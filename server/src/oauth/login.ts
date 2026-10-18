import { google } from "googleapis";
import type { Identity } from "../middleware/apiAuth.js";
export function getLoginClient() {
  const { GOOGLE_LOGIN_CLIENT_ID: id, GOOGLE_LOGIN_CLIENT_SECRET: secret, GOOGLE_LOGIN_REDIRECT_URI: uri } = process.env;
  if (!id || !secret || !uri) throw new Error("Google sign-in is not configured");
  return new google.auth.OAuth2(id, secret, uri);
}
export function allowedGoogleIdentity(payload: { sub?: string; email?: string; email_verified?: boolean; nonce?: string } | undefined, nonce: string): Identity | undefined {
  const email = payload?.email?.trim().toLowerCase();
  const allowed = process.env.GOOGLE_ALLOWED_EMAIL?.trim().toLowerCase();
  if (!payload?.sub || !email || !allowed || payload.email_verified !== true || email !== allowed || payload.nonce !== nonce) return;
  return { sub: payload.sub, email };
}
