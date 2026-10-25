import assert from "node:assert/strict";
import { test, after, mock } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import express from "express";

const dir = mkdtempSync(`${tmpdir()}/vidpush-tiktokprivacy-`);
process.env.DATA_DIR = dir;

const { db, upsertTokens } = await import("../src/db.js");
const uploadRoutes = (await import("../src/routes/upload.js")).default;

const app = express();
app.use("/api/upload", uploadRoutes);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.on("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const realFetch = globalThis.fetch.bind(globalThis);

function stubCreatorInfo(options: string[]) {
  return mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname.endsWith("tiktokapis.com") && url.pathname.endsWith("/creator_info/query/")) {
      return new Response(JSON.stringify({
        data: { privacy_level_options: options, comment_disabled: true, duet_disabled: true, stitch_disabled: true },
        error: { code: "ok" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(input, init);
  });
}

function immediateTikTokUpload() {
  const fd = new FormData();
  fd.append("video", new Blob(["x".repeat(100)], { type: "video/mp4" }), "clip.mp4");
  fd.append("tiktok", "true");
  return fetch(`${base}/api/upload`, { method: "POST", body: fd });
}

test("immediate TikTok upload fails fast when the account is not private", async () => {
  upsertTokens("default", "tiktok", "tok", "refresh", Date.now() + 3600_000, "open123");
  const stub = stubCreatorInfo(["PUBLIC_TO_EVERYONE"]); // SELF_ONLY unavailable
  try {
    const res = await immediateTikTokUpload();
    const body = (await res.json()) as { jobId?: string; error?: string };
    assert.equal(res.status, 400);
    assert.match(body.error!, /Private/);
    assert.equal(body.jobId, undefined);
  } finally { stub.mock.restore(); }
});
