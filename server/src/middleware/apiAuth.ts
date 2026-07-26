import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";

export const SESSION_COOKIE = "vidpush_session";

function expectedSessionValue(): string {
  const key = process.env.VIDPUSH_API_KEY;
  if (!key) return "";
  return crypto.createHmac("sha256", key).update("vidpush-session-v1").digest("hex");
}

export function requireApiKeyConfigured(): void {
  if (!process.env.VIDPUSH_API_KEY?.trim()) {
    console.error("VIDPUSH_API_KEY is required in .env (see .env.example).");
    process.exit(1);
  }
}

export function isAuthenticated(req: Request): boolean {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== "string") return false;
  const expected = expectedSessionValue();
  if (!expected || token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export function verifyApiKey(candidate: string): boolean {
  const expected = process.env.VIDPUSH_API_KEY ?? "";
  if (!expected || candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

export function sessionCookieValue(): string {
  return expectedSessionValue();
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  };
}

function isPublicPath(req: Request): boolean {
  const { method } = req;
  const path = req.path;

  if (method === "GET" && path === "/api/health") return true;
  if (method === "GET" && path === "/api/auth/session") return true;
  if (method === "POST" && path === "/api/auth/unlock") return true;
  if (method === "GET" && path === "/api/auth/google/callback") return true;
  if (method === "GET" && path === "/api/auth/tiktok/callback") return true;

  return false;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isPublicPath(req)) {
    next();
    return;
  }
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}
