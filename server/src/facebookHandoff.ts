import crypto from "node:crypto";
import type { FacebookPage } from "./oauth/meta.js";
type Result = { pages: FacebookPage[]; expiresAt: number | null };
type Handoff = { id: string; state: string; session: string; userId: string; expires: number;
  status: "waiting" | "processing" | "ready" | "error"; result?: Result; error?: string };
const pending = new Map<string, Handoff>();
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
function prune() {
  for (const [id, item] of pending) if (item.expires <= Date.now()) pending.delete(id);
}
export function startFacebookHandoff(session: string, userId: string) {
  prune();
  // One pending connection per initiating session; old links stop working.
  for (const [id, item] of pending) if (item.session === digest(session)) pending.delete(id);
  const item: Handoff = { id: crypto.randomBytes(32).toString("base64url"),
    state: `fbh_${crypto.randomBytes(32).toString("base64url")}`, session: digest(session),
    userId, expires: Date.now() + 10 * 60_000, status: "waiting" };
  pending.set(item.id, item);
  return { id: item.id, state: item.state };
}
export function acceptFacebookHandoff(state: string) {
  prune();
  const item = [...pending.values()].find(item => item.state === state && item.status === "waiting");
  if (item) item.status = "processing"; // Consume before exchanging the authorization code.
  return item;
}
export function finishFacebookHandoff(item: Handoff, result?: Result, error?: string) {
  if (pending.get(item.id) !== item || item.expires <= Date.now()) return;
  item.result = result;
  item.error = error;
  item.status = result ? "ready" : "error";
}
export function readFacebookHandoff(id: string, session: string) {
  prune();
  const item = pending.get(id);
  return item?.session === digest(session) ? item : undefined;
}
export function deleteFacebookHandoff(id: string) { pending.delete(id); }
setInterval(prune, 60_000).unref();
