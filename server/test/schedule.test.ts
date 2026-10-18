import assert from "node:assert/strict";
import { test, after, mock } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import express from "express";
import cookieParser from "cookie-parser";

const dir = mkdtempSync(`${tmpdir()}/vidpush-schedule-`);
process.env.DATA_DIR = dir;
process.env.META_API_VERSION = "v24.0";

const { db, upsertTokens, getScheduled, updateScheduledTime, listScheduled } = await import("../src/db.js");
const { parsePublishAt, validatePublishAt } = await import("../src/schedulePolicy.js");
const { dispatchDue } = await import("../src/scheduler.js");
const { uploadToMeta } = await import("../src/services/metaUpload.js");
const uploadRoutes = (await import("../src/routes/upload.js")).default;
const scheduledRoutes = (await import("../src/routes/scheduled.js")).default;

const app = express();
app.use(express.json(), cookieParser());
app.use("/api/upload", uploadRoutes);
app.use("/api/scheduled", scheduledRoutes);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.on("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function uploadForm(fields: Record<string, string>, name = "clip.mp4", bytes = 100): FormData {
  const fd = new FormData();
  fd.append("video", new Blob(["x".repeat(bytes)], { type: "video/mp4" }), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

async function postUpload(fields: Record<string, string>, name = "clip.mp4") {
  const res = await fetch(`${base}/api/upload`, { method: "POST", body: uploadForm(fields, name) });
  const body = (await res.json()) as { jobId?: string; scheduleIds?: string[]; error?: string };
  return { status: res.status, body };
}

test("schedule policy rejects past, malformed, and out-of-window times", () => {
  assert.throws(() => parsePublishAt("not-a-date"), /not a valid date/);
  assert.equal(parsePublishAt(undefined), undefined);
  assert.equal(parsePublishAt(""), undefined);
  assert.equal(validatePublishAt(Date.now() - 1000, { facebook: false, held: true }), "Schedule time must be in the future.");
  assert.equal(
    validatePublishAt(Date.now() + 5 * 60_000, { facebook: true, held: false }),
    "Facebook needs the scheduled time at least 10 minutes ahead."
  );
  assert.equal(
    validatePublishAt(Date.now() + 30 * 24 * 3600_000, { facebook: true, held: false }),
    "Facebook can schedule up to 29 days ahead."
  );
  assert.equal(
    validatePublishAt(Date.now() + 91 * 24 * 3600_000, { facebook: false, held: true }),
    "TikTok and Instagram can be scheduled up to 90 days ahead."
  );
  assert.equal(validatePublishAt(Date.now() + 3600_000, { facebook: false, held: true }), null);
});

test("upload rejects unusable schedule times before touching platforms", async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const r1 = await postUpload({ tiktok: "true", publishAt: past });
  assert.equal(r1.status, 400);
  assert.match(r1.body.error!, /future/);

  const soon = new Date(Date.now() + 5 * 60_000).toISOString();
  const r2 = await postUpload({ facebook: "true", publishAt: soon });
  assert.equal(r2.status, 400);
  assert.match(r2.body.error!, /10 minutes/);

  const r3 = await postUpload({ tiktok: "true", publishAt: "garbage" });
  assert.equal(r3.status, 400);
  assert.match(r3.body.error!, /valid date/);
});

test("immediate upload without publishAt keeps the old response shape", async () => {
  const r = await postUpload({ youtube: "true" });
  assert.equal(r.status, 400); // YouTube not connected in this sandbox
  assert.equal(r.body.error, "Connect YouTube first");
});

const realFetch = globalThis.fetch.bind(globalThis);

function stubTikTok(options: string[]) {
  return mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (!url.hostname.endsWith("tiktokapis.com") && !url.hostname.endsWith("tiktokv.com")) {
      return realFetch(input, init);
    }
    if (init?.method === "PUT") return new Response("", { status: 200 });
    if (url.pathname.endsWith("/creator_info/query/")) {
      return json({ data: { privacy_level_options: options, comment_disabled: true, duet_disabled: true, stitch_disabled: true } });
    }
    if (url.pathname.endsWith("/video/init/")) {
      return json({ data: { publish_id: "pub-1", upload_url: "https://open-upload.tiktokapis.com/video/t1" } });
    }
    if (url.pathname.endsWith("/status/fetch/")) {
      return json({ data: { status: "PUBLISH_COMPLETE" } });
    }
    throw new Error(`Unexpected TikTok request: ${url.pathname}`);
  });
}

test("TikTok hold-and-post: schedule, list, edit, dispatch, cancel rules", async () => {
  upsertTokens("default", "tiktok", "tok", "refresh", Date.now() + 3600_000, "open123");
  const stub = stubTikTok(["SELF_ONLY"]);
  try {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const created = await postUpload({ tiktok: "true", title: "Evening clip", publishAt: future });
    assert.equal(created.status, 200);
    assert.equal(created.body.scheduleIds?.length, 1);
    assert.equal(created.body.jobId, undefined); // held-only: nothing runs now
    const id = created.body.scheduleIds![0];

    const row = getScheduled(id)!;
    assert.equal(row.status, "scheduled");
    assert.ok(existsSync(row.file_path), "held file stored under DATA_DIR");

    const list = await (await fetch(`${base}/api/scheduled`)).json() as { items: { id: string }[] };
    assert.ok(list.items.some(i => i.id === id));

    // Edit validation: past is rejected, future is accepted.
    const badPatch = await fetch(`${base}/api/scheduled/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publishAt: new Date(Date.now() - 1000).toISOString() }),
    });
    assert.equal(badPatch.status, 400);
    const later = new Date(Date.now() + 2 * 3600_000).toISOString();
    const goodPatch = await fetch(`${base}/api/scheduled/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publishAt: later }),
    });
    assert.equal(goodPatch.status, 200);
    assert.equal(getScheduled(id)!.publish_at, new Date(later).getTime());

    // Make it due and dispatch: publishes via the normal TikTok flow.
    updateScheduledTime(id, Date.now() - 1000);
    const done = await dispatchDue();
    assert.deepEqual(done, [id]);
    const finished = getScheduled(id)!;
    assert.equal(finished.status, "done");
    assert.ok(finished.job_id);
    assert.ok(!existsSync(finished.file_path), "held file consumed by dispatch");

    // Terminal rows can no longer be edited or cancelled.
    assert.equal((await fetch(`${base}/api/scheduled/${id}`, { method: "DELETE" })).status, 409);
    const editDone = await fetch(`${base}/api/scheduled/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publishAt: later }),
    });
    assert.equal(editDone.status, 409);
  } finally { stub.mock.restore(); }
});

test("dispatch fails loudly when the TikTok account is not private", async () => {
  const stub = stubTikTok(["PUBLIC_TO_EVERYONE"]); // SELF_ONLY unavailable
  try {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const created = await postUpload({ tiktok: "true", publishAt: future });
    const id = created.body.scheduleIds![0];
    updateScheduledTime(id, Date.now() - 1000);
    await dispatchDue();
    const row = getScheduled(id)!;
    assert.equal(row.status, "error");
    assert.match(row.error!, /Private/);
  } finally { stub.mock.restore(); }
});

test("cancel removes a pending item and its file", async () => {
  const stub = stubTikTok(["SELF_ONLY"]);
  try {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const created = await postUpload({ instagram: "true", publishAt: future }, "reel.mp4");
    // Instagram is not connected in this sandbox, so scheduling is refused fast.
    assert.equal(created.status, 400);
    assert.equal(created.body.error, "Connect instagram first");
  } finally { stub.mock.restore(); }

  // Same path with a connected Instagram account cancels cleanly.
  const { upsertTokens: upsert } = await import("../src/db.js");
  upsert("default", "instagram", "ig-secret", null, Date.now() + 30 * 86400_000, "ig-1", "my_ig");
  const future = new Date(Date.now() + 3600_000).toISOString();
  const created = await postUpload({ instagram: "true", publishAt: future }, "reel.mp4");
  assert.equal(created.status, 200);
  const id = created.body.scheduleIds![0];
  const path = getScheduled(id)!.file_path;
  assert.ok(existsSync(path));
  assert.equal((await fetch(`${base}/api/scheduled/${id}`, { method: "DELETE" })).status, 200);
  assert.equal(getScheduled(id)!.status, "cancelled");
  assert.ok(!existsSync(path), "cancelled file deleted");
  assert.ok(!listScheduled("default").some(r => r.id === id && r.status === "scheduled"));
});

test("Facebook finish uses SCHEDULED only when a publish time is given", async () => {
  upsertTokens("default", "facebook", "fb-secret", null, Date.now() + 86400_000, "fb-page-1", "My Page");
  const seen: Record<string, string>[] = [];
  const stub = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "rupload.facebook.com") {
      for await (const _chunk of init?.body as AsyncIterable<unknown>) { /* drain the file stream */ }
      return json({ success: true });
    }
    const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    if (url.pathname.endsWith("/fb-page-1/video_reels")) {
      if (body.get("upload_phase") === "start") return json({ video_id: "fb-video", upload_url: "https://rupload.facebook.com/fb-video" });
      seen.push({ video_state: body.get("video_state")!, scheduled_publish_time: body.get("scheduled_publish_time") ?? "" });
      return json({ success: true });
    }
    if (url.pathname.endsWith("/fb-video")) {
      return json({ status: { video_status: "ready", publishing_phase: { status: "complete" } } });
    }
    throw new Error("Unexpected API request");
  });
  try {
    const { writeFileSync } = await import("node:fs");
    const file = `${dir}/fb.mp4`;
    writeFileSync(file, "test video");
    const at = Date.now() + 3600_000;
    assert.equal(await uploadToMeta("facebook", "default", file, "caption", at), "fb-video");
    assert.equal(await uploadToMeta("facebook", "default", file, "caption"), "fb-video");
    assert.deepEqual(seen, [
      { video_state: "SCHEDULED", scheduled_publish_time: String(Math.floor(at / 1000)) },
      { video_state: "PUBLISHED", scheduled_publish_time: "" },
    ]);
  } finally { stub.mock.restore(); }
});
