import assert from "node:assert/strict";
import { test, after, mock } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import express from "express";

const dir = mkdtempSync(`${tmpdir()}/vidpush-thumbnail-`);
process.env.DATA_DIR = dir;
process.env.META_API_VERSION = "v24.0";

const { setYoutubeThumbnail, youtubeThumbnailMimeType } = await import("../src/services/youtubeUpload.js");
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

test("youtube thumbnail mime type follows the file extension", () => {
  assert.equal(youtubeThumbnailMimeType("cover.jpg"), "image/jpeg");
  assert.equal(youtubeThumbnailMimeType("cover.jpeg"), "image/jpeg");
  assert.equal(youtubeThumbnailMimeType("cover.png"), "image/png");
  assert.equal(youtubeThumbnailMimeType("cover.webp"), "image/webp");
  assert.equal(youtubeThumbnailMimeType("cover.gif"), "image/gif");
  // Unknown extensions fall back to jpeg instead of octet-stream, which
  // YouTube rejects for thumbnails.
  assert.equal(youtubeThumbnailMimeType("cover"), "image/jpeg");
});

// The fake clients below never upload, so the recorded read streams would
// outlive the temp dir removed in after(): swallow their async open errors
// and destroy them once the test settles.
function trackStream(store: unknown[], body: unknown): void {
  store.push(body);
  (body as { on?: (event: string, cb: () => void) => void }).on?.("error", () => {});
}
function closeStreams(store: unknown[]): void {
  for (const body of store) (body as { destroy?: () => void }).destroy?.();
}

test("youtube thumbnail set sends an image mime type", async () => {
  const thumb = `${dir}/yt-thumb.jpg`; writeFileSync(thumb, "fake-jpeg");
  const seen: { videoId: string; mimeType: string; bodies: unknown[] } = { videoId: "", mimeType: "", bodies: [] };
  const youtube = {
    thumbnails: {
      set: async (args: { videoId: string; media: { mimeType: string; body: unknown } }) => {
        seen.videoId = args.videoId;
        seen.mimeType = args.media.mimeType;
        trackStream(seen.bodies, args.media.body);
        return {};
      },
    },
  };
  try {
    assert.equal(await setYoutubeThumbnail(youtube, "vid-1", thumb, async () => {}), true);
    assert.equal(seen.videoId, "vid-1");
    assert.equal(seen.mimeType, "image/jpeg");
  } finally {
    closeStreams(seen.bodies);
  }
});

test("youtube thumbnail retries a transient failure instead of dropping it", async () => {
  const thumb = `${dir}/yt-thumb-retry.png`; writeFileSync(thumb, "fake-png");
  const bodies: unknown[] = [];
  let calls = 0;
  const waits: number[] = [];
  const youtube = {
    thumbnails: {
      set: async (args: { videoId: string; media: { mimeType: string; body: unknown } }) => {
        calls += 1;
        trackStream(bodies, args.media.body);
        assert.equal(args.media.mimeType, "image/png");
        if (calls === 1) throw new Error("video not ready");
        return {};
      },
    },
  };
  try {
    assert.equal(await setYoutubeThumbnail(youtube, "vid-2", thumb, async (ms) => { waits.push(ms); }), true);
    assert.equal(calls, 2);
    assert.equal(waits.length, 1);
  } finally {
    closeStreams(bodies);
  }
});

test("youtube thumbnail stays best-effort when every attempt fails", async () => {
  const thumb = `${dir}/yt-thumb-fail.jpg`; writeFileSync(thumb, "fake-jpeg");
  const bodies: unknown[] = [];
  let calls = 0;
  const youtube = {
    thumbnails: {
      set: async (args: { videoId: string; media: { mimeType: string; body: unknown } }) => {
        calls += 1;
        trackStream(bodies, args.media.body);
        throw new Error("backend error");
      },
    },
  };
  try {
    assert.equal(await setYoutubeThumbnail(youtube, "vid-3", thumb, async () => {}), false);
    assert.equal(calls, 4);
  } finally {
    closeStreams(bodies);
  }
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
