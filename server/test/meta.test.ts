import assert from "node:assert/strict";
import { test, after, mock } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const dir = mkdtempSync(`${tmpdir()}/vidpush-meta-`);
process.env.DATA_DIR = dir;
process.env.META_API_VERSION = "v24.0";
const { db, upsertTokens, getTokens, deleteTokens } = await import("../src/db.js");
const { uploadToMeta, waitForFacebook, waitForInstagram } = await import("../src/services/metaUpload.js");
const { uploadMetaBinary } = await import("../src/services/metaApi.js");
const { metaConnection } = await import("../src/services/metaTokens.js");
const { createJob, updatePlatform, getJob } = await import("../src/jobs.js");
const file = `${dir}/video.mp4`; writeFileSync(file, "test video");
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
test("Facebook and Instagram publish independently using different accounts and tokens", async () => {
  upsertTokens("default", "facebook", "fb-secret", null, Date.now() + 86400_000, "fb-page-1", "My Page");
  upsertTokens("default", "instagram", "ig-secret", null, Date.now() + 30 * 86400_000, "ig-account-2", "my_ig");
  const calls: string[] = [];
  const stub = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); calls.push(url.pathname);
    const headers = new Headers(init?.headers);
    assert.ok(!url.searchParams.has("access_token"), "publishing tokens stay out of URLs");
    if (url.hostname === "rupload.facebook.com") {
      assert.equal(headers.get("offset"), "0");
      assert.equal(headers.get("file_size"), "10");
      assert.equal(headers.get("authorization"), `OAuth ${url.pathname.includes("ig-") ? "ig-secret" : "fb-secret"}`);
      for await (const _chunk of init?.body as any) { /* consume stream like fetch */ }
      return json({ success: true });
    }
    const ig = url.hostname === "graph.instagram.com";
    assert.equal(headers.get("authorization"), `Bearer ${ig ? "ig-secret" : "fb-secret"}`);
    const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    if (url.pathname.endsWith("/ig-account-2/media")) {
      assert.equal(body.get("upload_type"), "resumable");
      assert.equal(body.get("media_type"), "REELS");
      return json({ id: "ig-container", uri: "https://rupload.facebook.com/ig-container" });
    }
    if (url.pathname.endsWith("/ig-container")) return json({ status_code: "FINISHED" });
    if (url.pathname.endsWith("/media_publish")) {
      assert.ok(calls.includes("/v24.0/ig-container"), "processing checked before publication");
      return json({ id: "ig-post" });
    }
    if (url.pathname.endsWith("/fb-page-1/video_reels")) {
      if (body.get("upload_phase") === "start") return json({ video_id: "fb-video", upload_url: "https://rupload.facebook.com/fb-video" });
      assert.equal(body.get("video_state"), "PUBLISHED");
      return json({ success: true });
    }
    if (url.pathname.endsWith("/fb-video")) return json({ status: { video_status: "ready", publishing_phase: { status: "complete" } } });
    throw new Error("Unexpected API request");
  });
  try {
    assert.equal(await uploadToMeta("facebook", "default", file, "caption"), "fb-video");
    assert.equal(await uploadToMeta("instagram", "default", file, "caption"), "ig-post");
    deleteTokens("default", "facebook");
    assert.equal(metaConnection("default", "facebook").connected, false);
    assert.equal(getTokens("default", "instagram")?.open_id, "ig-account-2");
  } finally { stub.mock.restore(); }
});
test("Facebook processing ready is not publication complete", async () => {
  let requests = 0;
  const stub = mock.method(globalThis, "fetch", async () => json({ status: { video_status: "ready", publishing_phase: { status: ++requests === 1 ? "in_progress" : "complete" } } }));
  try { await waitForFacebook("token", "video", async () => {}); assert.equal(requests, 2); }
  finally { stub.mock.restore(); }
});
test("processing errors fail; provider error text does not leak secrets", async () => {
  let stub = mock.method(globalThis, "fetch", async () => json({ status_code: "ERROR" }));
  try { await assert.rejects(waitForInstagram("secret", "container", async () => {}), /could not process/); }
  finally { stub.mock.restore(); }
  stub = mock.method(globalThis, "fetch", async () => json({ error: { code: 190, message: "access_token=private-secret" } }, 400));
  try { await assert.rejects(waitForFacebook("secret", "video", async () => {}), error => error instanceof Error && /Reconnect/.test(error.message) && !error.message.includes("private-secret")); }
  finally { stub.mock.restore(); }
});
test("upload URL cannot forward a token to another host", async () => {
  await assert.rejects(uploadMetaBinary("https://attacker.example/video", "secret", file), /unexpected upload destination/);
  await assert.rejects(uploadMetaBinary("https://rupload.facebook.com.attacker.example/video", "secret", file), /unexpected upload destination/);
});
test("four-platform jobs preserve independent outcomes", () => {
  createJob("job", true, false, true, true);
  updatePlatform("job", "facebook", { status: "error", error: "failed" });
  updatePlatform("job", "instagram", { status: "done", videoId: "ig-post" });
  const job = getJob("job")!;
  assert.equal(job.youtube.status, "queued"); assert.equal(job.tiktok.status, "idle");
  assert.equal(job.facebook.status, "error"); assert.equal(job.instagram.status, "done");
});
