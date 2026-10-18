import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { db } from "../db.js";

export const SESSION_COOKIE = "vidpush_session";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export type Identity = { sub: string; email: string };
export function authProvider(): "google" | "key" {
  return process.env.APP_AUTH_PROVIDER === "key" ? "key" : "google";
}
export function requireAuthConfigured(): void {
  if (process.env.APP_AUTH_PROVIDER && !["google", "key"].includes(process.env.APP_AUTH_PROVIDER)) {
    throw new Error("APP_AUTH_PROVIDER must be google or key");
  }
  const required = authProvider() === "google"
    ? ["GOOGLE_LOGIN_CLIENT_ID", "GOOGLE_LOGIN_CLIENT_SECRET", "GOOGLE_LOGIN_REDIRECT_URI", "GOOGLE_ALLOWED_EMAIL"]
    : ["VIDPUSH_API_KEY"];
  for (const key of required) if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
  if (authProvider() === "google") {
    const callback = new URL(process.env.GOOGLE_LOGIN_REDIRECT_URI!);
    if (callback.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(callback.hostname)) {
      throw new Error("Google login requires HTTPS except on localhost");
    }
  }
}
const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
export function createSession(identity: Identity): string {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  db.prepare("INSERT INTO sessions (token_hash, subject, email, provider, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(hash(token), identity.sub, identity.email, authProvider(), Date.now() + SESSION_MS);
  return token;
}
export function getSessionIdentity(req: Request): Identity | undefined {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== "string" || token.length > 128) return;
  const row = db.prepare("SELECT subject, email, provider FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .get(hash(token), Date.now()) as { subject: string; email: string; provider: string } | undefined;
  if (!row || row.provider !== authProvider()) return;
  if (row.provider === "google" && row.email !== process.env.GOOGLE_ALLOWED_EMAIL?.trim().toLowerCase()) return;
  return { sub: row.subject, email: row.email };
}
export function revokeSession(req: Request): void {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === "string") db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
}
export function isAuthenticated(req: Request): boolean { return Boolean(getSessionIdentity(req)); }
export function verifyApiKey(candidate: string): boolean {
  if (authProvider() !== "key") return false;
  const expected = process.env.VIDPUSH_API_KEY ?? "";
  return Boolean(expected) && Buffer.byteLength(candidate) === Buffer.byteLength(expected)
    && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}
export function sessionCookieOptions() {
  return { httpOnly: true, sameSite: "lax" as const,
    secure: process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production",
    maxAge: SESSION_MS, path: "/" };
}
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    // Browser mutations must originate from our UI, including multipart uploads.
    const allowed = new URL(process.env.FRONTEND_URL ?? "http://localhost:5173").origin;
    if (req.get("origin") !== allowed) {
      res.status(403).json({ error: "Invalid request origin" }); return;
    }
  }
  const publicGet = ["/api/auth/session", "/api/auth/login/google/start"];
  const callbacks = ["/api/auth/login/google", "/api/auth/google", "/api/auth/tiktok", "/api/auth/facebook", "/api/auth/instagram"];
  const callbackBase = callbacks.find(path => req.path === `${path}/callback` || req.path === `${path}/complete`);
  if (req.method === "GET" && callbackBase && req.path.endsWith("/callback")) {
    const frontend = new URL(process.env.FRONTEND_URL ?? "http://localhost:5173");
    // Local OAuth may return through ngrok, while the initiating cookie belongs
    // to localhost. Complete on the configured UI origin so the cookie is present.
    if (frontend.hostname !== req.hostname) {
      const target = new URL(`${callbackBase}/complete`, frontend);
      for (const key of ["code", "state", "error"]) {
        if (typeof req.query[key] === "string") target.searchParams.set(key, req.query[key] as string);
      }
      res.setHeader("Referrer-Policy", "no-referrer");
      res.redirect(target.toString()); return;
    }
  }
  if ((req.method === "GET" && (publicGet.includes(req.path) || callbackBase)) ||
      (req.method === "POST" && ["/api/auth/unlock", "/api/auth/logout"].includes(req.path))) {
    next(); return;
  }
  if (!isAuthenticated(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  next();
}
