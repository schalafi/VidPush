import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const dir = mkdtempSync(`${tmpdir()}/vidpush-ytprivacy-`);
process.env.DATA_DIR = dir;

const { uploadToYoutube } = await import("../src/services/youtubeUpload.js");

after(() => { rmSync(dir, { recursive: true, force: true }); });

type Seen = { privacyStatus?: string; publishAt?: string; bodies: unknown[] };

// The recorded read streams would outlive the temp dir removed in after():
// swallow their async open errors and destroy them once the test settles.
function trackStream(seen: Seen, body: unknown): void {
  seen.bodies.push(body);
  (body as { on?: (event: string, cb: () => void) => void }).on?.("error", () => {});
}

function fakeYoutube(seen: Seen) {
  return {
    videos: {
      insert: async (args: {
        requestBody: { status: { privacyStatus: string; publishAt?: string } };
        media: { body: unknown };
      }) => {
        seen.privacyStatus = args.requestBody.status.privacyStatus;
        seen.publishAt = args.requestBody.status.publishAt;
        trackStream(seen, args.media.body);
        return { data: { id: "yt-1" } };
      },
    },
    thumbnails: { set: async () => ({}) },
  };
}

function closeBodies(seen: Seen): void {
  for (const body of seen.bodies) (body as { destroy?: () => void }).destroy?.();
}

test("immediate YouTube upload (no schedule time) is public, not unlisted", async () => {
  const video = `${dir}/now.mp4`; writeFileSync(video, "fake-mp4");
  const seen: Seen = { bodies: [] };
  try {
    assert.equal(
      await uploadToYoutube("u", video, "title", "desc", undefined, undefined, fakeYoutube(seen)),
      "yt-1"
    );
    assert.equal(seen.privacyStatus, "public");
    assert.equal(seen.publishAt, undefined);
  } finally {
    closeBodies(seen);
  }
});

test("scheduled YouTube upload stays private with publishAt", async () => {
  const video = `${dir}/later.mp4`; writeFileSync(video, "fake-mp4");
  const seen: Seen = { bodies: [] };
  const when = Date.now() + 3600_000;
  try {
    assert.equal(
      await uploadToYoutube("u", video, "title", "desc", when, undefined, fakeYoutube(seen)),
      "yt-1"
    );
    assert.equal(seen.privacyStatus, "private");
    assert.equal(seen.publishAt, new Date(when).toISOString());
  } finally {
    closeBodies(seen);
  }
});
