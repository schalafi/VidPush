import { Router } from "express";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

/**
 * Temporary public file links for Instagram's `video_url` flow: Meta's
 * servers fetch the bytes themselves, so the file must be reachable at a
 * public HTTPS URL (resumable upload sessions are only available to
 * Facebook-Login-for-Business apps, which VidPush is not).
 *
 * A link is an unguessable token bound to one exact file, valid for 30
 * minutes, and revoked as soon as the publish attempt settles. Anyone holding
 * the link can download that video while it is valid — inherent to Meta
 * fetching it — so links are single-purpose and short-lived by design.
 */
const TTL_MS = 30 * 60 * 1000;

type Link = { filePath: string; mime: string; expiresAt: number };
const links = new Map<string, Link>();

function prune(): void {
  const now = Date.now();
  for (const [token, link] of links) {
    if (link.expiresAt <= now) links.delete(token);
  }
}

/** Public origin the app itself is reachable at (API shares the UI origin). */
export function publicBaseUrl(): string {
  const front = (process.env.FRONTEND_URL ?? "").replace(/\/$/, "");
  if (front.startsWith("https://") && !/localhost|127\.0\.0\.1/.test(front)) return front;
  // Local dev serves the UI from localhost, which Meta cannot reach; the
  // ngrok tunnel forwards to the API server instead.
  const ngrok = (process.env.NGROK_DOMAIN ?? "").replace(/\/$/, "");
  if (ngrok) return `https://${ngrok}`;
  throw new Error(
    "Instagram publishing needs a public file URL: deploy the app or set NGROK_DOMAIN for local development."
  );
}

export function issuePublicFileUrl(base: string, filePath: string): string {
  prune();
  const token = uuidv4();
  const ext = path.extname(filePath).toLowerCase();
  let mime = "video/mp4";
  if (ext === ".mov") mime = "video/quicktime";
  else if (ext === ".jpg" || ext === ".jpeg") mime = "image/jpeg";
  else if (ext === ".png") mime = "image/png";
  else if (ext === ".webp") mime = "image/webp";
  else if (ext === ".gif") mime = "image/gif";
  links.set(token, { filePath, mime, expiresAt: Date.now() + TTL_MS });
  return `${base}/api/upload/public/${token}`;
}

export function revokePublicFileUrl(url: string): void {
  const token = url.split("/").pop();
  if (token) links.delete(token);
}

/**
 * Serves issued links WITHOUT authentication (Meta's servers have no
 * session). Mount this router before the auth middleware. Tokens are map
 * keys only — never interpreted as paths — so there is no traversal risk.
 */
export const publicFileRouter = Router();
publicFileRouter.get("/:token", (req, res) => {
  const token = req.params.token;
  const link = links.get(token);
  if (!link || link.expiresAt <= Date.now() || !fs.existsSync(link.filePath)) {
    links.delete(token);
    res.status(404).end();
    return;
  }
  res.sendFile(path.resolve(link.filePath), { headers: { "Content-Type": link.mime } }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});
