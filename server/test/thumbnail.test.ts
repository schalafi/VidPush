import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import express from "express";

const dir = mkdtempSync(`${tmpdir()}/vidpush-thumbnail-`);
process.env.DATA_DIR = dir;

const { validateThumbnail } = await import("../src/routes/upload.js");
const { upsertTokens, db } = await import("../src/db.js");
const uploadRoutes = (await import("../src/routes/upload.js")).default;

const app = express();
app.use("/api/upload", uploadRoutes);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.on("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

test("validateThumbnail accepts images up to 2 MB", () => {
  assert.equal(validateThumbnail(undefined), null);
  assert.equal(validateThumbnail({ mimetype: "image/jpeg", size: 500_000 }), null);
  assert.equal(
    validateThumbnail({ mimetype: "text/plain", size: 100 }),
    "Thumbnail must be an image file."
  );
  assert.equal(
    validateThumbnail({ mimetype: "image/png", size: 3 * 1024 * 1024 }),
    "Thumbnail must be up to 2 MB (YouTube limit)."
  );
});

test("upload rejects a non-image thumbnail before storing anything", async () => {
  upsertTokens("default", "tiktok", "tok", "refresh", Date.now() + 3600_000, "open123");
  const fd = new FormData();
  fd.append("video", new Blob(["x".repeat(100)], { type: "video/mp4" }), "clip.mp4");
  fd.append("thumbnail", new Blob(["not-an-image"], { type: "text/plain" }), "note.txt");
  fd.append("tiktok", "true");
  fd.append("publishAt", new Date(Date.now() + 3600_000).toISOString());
  const res = await fetch(`${base}/api/upload`, { method: "POST", body: fd });
  const body = (await res.json()) as { error?: string };
  assert.equal(res.status, 400);
  assert.equal(body.error, "Thumbnail must be an image file.");
});
