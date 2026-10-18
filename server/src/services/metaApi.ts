import fs from "node:fs";
export type MetaPlatform = "facebook" | "instagram";
export function graphBase(platform: MetaPlatform): string {
  const version = process.env.META_API_VERSION ?? "v24.0";
  if (!/^v\d+\.0$/.test(version)) throw new Error("Invalid META_API_VERSION");
  return `https://graph.${platform}.com/${version}`;
}
export async function metaRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(60_000) }); }
  catch { throw new Error("Meta could not be reached. Check connection status before retrying."); }
  let body: { error?: { code?: number }; [key: string]: unknown };
  try { body = await response.json() as typeof body; }
  catch { throw new Error(`Meta returned an unreadable response (HTTP ${response.status}).`); }
  if (!response.ok || body.error) {
    if (body.error?.code === 190) throw new Error("This connection expired or was revoked. Reconnect the account.");
    // Provider errors may include request URLs/tokens. Never expose raw payloads.
    throw new Error(`Meta rejected the request (HTTP ${response.status}, code ${body.error?.code ?? "unknown"}). Check permissions and video requirements.`);
  }
  return body as T;
}
export function graph<T>(platform: MetaPlatform, path: string, token: string, params: Record<string, string> = {}, method = "GET"): Promise<T> {
  const url = new URL(`${graphBase(platform)}/${path}`);
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}` } };
  if (method === "GET") url.search = new URLSearchParams(params).toString();
  else init.body = new URLSearchParams(params);
  return metaRequest<T>(url.toString(), init);
}
export async function uploadMetaBinary(uri: string, token: string, filePath: string): Promise<void> {
  const url = new URL(uri);
  if (url.protocol !== "https:" || url.hostname !== "rupload.facebook.com" || url.port || url.username || url.password) {
    throw new Error("Meta returned an unexpected upload destination");
  }
  const size = fs.statSync(filePath).size;
  const stream = fs.createReadStream(filePath);
  try {
    const result = await metaRequest<{ success?: boolean }>(uri, {
      method: "POST", headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(size),
        "Content-Type": "application/octet-stream", "Content-Length": String(size) },
      body: stream as unknown as BodyInit, duplex: "half", signal: AbortSignal.timeout(20 * 60_000),
    } as RequestInit);
    if (result.success === false) throw new Error("Meta did not accept the video upload");
  } finally { stream.destroy(); }
}
