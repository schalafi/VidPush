import assert from "node:assert/strict";
import { test, after, mock } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import express from "express";

const dir = mkdtempSync(`${tmpdir()}/vidpush-thumbnail-`);
process.env.DATA_DIR = dir;
process.env.META_API_VERSION = "v24.0";

const { validateThumbnail } = await import("../src/routes/upload.js");
const { createScheduled, getScheduled, upsertTokens, db } = await import("../src/db.js");
const { dispatchDue } = await import("../src/scheduler.js");
const { uploadToMeta } = await import("../src/services/metaUpload.js");
const { publicFileRouter } = await import("../src/publicFiles.js");
const uploadRoutes = (await import("../src/routes/upload.js")).default;
const scheduledRoutes = (await import("../src/routes/scheduled.js")).default;

const app = express();
app.use("/api/upload/public", publicFileRouter);
app.use("/api/upload", uploadRoutes);
app.use("/api/scheduled", scheduledRoutes);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.on("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const realFetch = globalThis.fetch.bind(globalThis);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function withPublicOrigin() {
  const saved = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = "https://example.modal.run";
  return () => {
    if (saved === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = saved;
  };
}

test("validateThumbnail accepts images up to 2 MB", () => {
  assert.equal(validateThumbnail(undefined), null);
  assert.equal(validateThumbnail({ mimetype: "image/jpeg", size: 500_000 }), null);
  assert.equal(
    validateThumbnail({ mimetype: "text/plain", size: 100 }),
    "Thumbnail must be an image file."
  );
  assert.equal(
    validateThumbnail({ mimetype: "image/png", size: 3 * 1024 * 1024 }),
    "Thumbnail must be up to 2 MB."
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

test("Instagram Reels send the custom thumbnail as cover_url", async () => {
  upsertTokens("default", "instagram", "ig-secret", null, Date.now() + 30 * 86400_000, "ig-account-9", "my_ig");
  const video = `${dir}/cover-clip.mp4`; writeFileSync(video, "fake-mp4");
  const thumb = `${dir}/cover.jpg`; writeFileSync(thumb, "fake-jpeg");
  const covers: (string | null)[] = [];
  // Probed while the link is live: Meta fetches the cover during container
  // creation, and the link is revoked once the publish settles.
  const served: { status: number; contentType: string; text: string }[] = [];
  const stub = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "graph.instagram.com") return realFetch(input, init);
    const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    if (url.pathname.endsWith("/ig-account-9/media")) {
      covers.push(body.get("cover_url"));
      const token = (body.get("cover_url") ?? "").split("/").pop()!;
      const res = await realFetch(`${base}/api/upload/public/${token}`);
      served.push({ status: res.status, contentType: res.headers.get("content-type") ?? "", text: await res.text() });
      return json({ id: "ig-container-1" });
    }
    if (url.pathname.endsWith("/ig-container-1")) return json({ status_code: "FINISHED" });
    if (url.pathname.endsWith("/media_publish")) return json({ id: "ig-post-1" });
    throw new Error(`Unexpected API request: ${url.pathname}`);
  });
  const restoreOrigin = withPublicOrigin();
  try {
    assert.equal(await uploadToMeta("instagram", "default", video, "caption", undefined, thumb), "ig-post-1");
    assert.equal(covers.length, 1);
    assert.match(covers[0] ?? "", /^https:\/\/example\.modal\.run\/api\/upload\/public\/[0-9a-f-]{36}$/);
    // The exact URL sent to Meta served the thumbnail bytes as an image.
    assert.equal(served.length, 1);
    assert.equal(served[0].status, 200);
    assert.match(served[0].contentType, /image\/jpeg/);
    assert.equal(served[0].text, "fake-jpeg");
  } finally {
    stub.mock.restore();
    restoreOrigin();
  }
});

test("a rejected Instagram cover retries without it instead of failing", async () => {
  upsertTokens("default", "instagram", "ig-secret", null, Date.now() + 30 * 86400_000, "ig-account-9", "my_ig");
  const video = `${dir}/cover-clip-2.mp4`; writeFileSync(video, "fake-mp4");
  const thumb = `${dir}/cover-2.jpg`; writeFileSync(thumb, "fake-jpeg");
  let attempts = 0;
  const stub = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "graph.instagram.com") return realFetch(input, init);
    const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    if (url.pathname.endsWith("/ig-account-9/media")) {
      attempts += 1;
      if (body.get("cover_url")) return json({ error: { code: 100, message: "invalid cover" } }, 400);
      return json({ id: "ig-container-2" });
    }
    if (url.pathname.endsWith("/ig-container-2")) return json({ status_code: "FINISHED" });
    if (url.pathname.endsWith("/media_publish")) return json({ id: "ig-post-2" });
    throw new Error(`Unexpected API request: ${url.pathname}`);
  });
  const restoreOrigin = withPublicOrigin();
  try {
    assert.equal(await uploadToMeta("instagram", "default", video, "caption", undefined, thumb), "ig-post-2");
    assert.equal(attempts, 2);
  } finally {
    stub.mock.restore();
    restoreOrigin();
  }
});

test("held Instagram uploads store the thumbnail and drop it on cancel", async () => {
  upsertTokens("default", "instagram", "ig-secret", null, Date.now() + 30 * 86400_000, "ig-account-9", "my_ig");
  const fd = new FormData();
  fd.append("video", new Blob(["x".repeat(100)], { type: "video/mp4" }), "clip.mp4");
  fd.append("thumbnail", new Blob(["fake-jpeg"], { type: "image/jpeg" }), "cover.jpg");
  fd.append("instagram", "true");
  fd.append("publishAt", new Date(Date.now() + 3600_000).toISOString());
  const res = await fetch(`${base}/api/upload`, { method: "POST", body: fd });
  const body = (await res.json()) as { jobId?: string; scheduleIds?: string[]; error?: string };
  assert.equal(res.status, 200);
  assert.equal(body.jobId, undefined); // held-only: nothing runs now
  assert.equal(body.scheduleIds?.length, 1);
  const row = getScheduled(body.scheduleIds![0])!;
  assert.ok(row.thumb_path);
  assert.ok(existsSync(row.thumb_path!));
  assert.equal((await fetch(`${base}/api/scheduled/${row.id}`, { method: "DELETE" })).status, 200);
  assert.equal(existsSync(row.thumb_path!), false);
});

test("dispatch sends the stored thumbnail as the Instagram cover", async () => {
  upsertTokens("default", "instagram", "ig-secret", null, Date.now() + 30 * 86400_000, "ig-account-9", "my_ig");
  const video = `${dir}/held.mp4`; writeFileSync(video, "fake-mp4");
  const thumb = `${dir}/held.jpg`; writeFileSync(thumb, "fake-jpeg");
  createScheduled({
    id: "held-ig-cover", user_id: "default", file_path: video, original_name: "held.mp4",
    size: 8, title: "held", description: "", destinations: JSON.stringify({ instagram: true }),
    publish_at: Date.now() - 1000, created_at: Date.now() - 2000, thumb_path: thumb,
  });
  const covers: (string | null)[] = [];
  const stub = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "graph.instagram.com") return realFetch(input, init);
    const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    if (url.pathname.endsWith("/ig-account-9/media")) {
      covers.push(body.get("cover_url"));
      return json({ id: "ig-container-3" });
    }
    if (url.pathname.endsWith("/ig-container-3")) return json({ status_code: "FINISHED" });
    if (url.pathname.endsWith("/media_publish")) return json({ id: "ig-post-3" });
    throw new Error(`Unexpected API request: ${url.pathname}`);
  });
  const restoreOrigin = withPublicOrigin();
  try {
    const done = await dispatchDue();
    assert.ok(done.includes("held-ig-cover"));
    assert.equal(covers.length, 1);
    assert.match(covers[0] ?? "", /\/api\/upload\/public\//);
    assert.equal(getScheduled("held-ig-cover")!.status, "done");
    assert.equal(existsSync(thumb), false); // consumed with the video
    assert.equal(existsSync(video), false);
  } finally {
    stub.mock.restore();
    restoreOrigin();
  }
});
