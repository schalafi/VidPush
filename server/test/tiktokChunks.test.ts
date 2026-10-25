import assert from "node:assert/strict";
import { test } from "node:test";

const { planTiktokChunks } = await import("../src/services/tiktokUpload.js");

function checkCover(videoSize: number) {
  const { chunkSize, totalChunkCount, ranges } = planTiktokChunks(videoSize);
  assert.equal(ranges.length, totalChunkCount);
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges[ranges.length - 1].end, videoSize - 1);
  for (const r of ranges) {
    // TikTok rejects the init when any chunk exceeds the declared chunk_size.
    assert.ok(r.end - r.start + 1 <= chunkSize, `chunk exceeds chunk_size for ${videoSize}`);
  }
}

test("chunk plan never lets a chunk exceed the declared chunk_size", () => {
  checkCover(100);
  checkCover(5 * 1024 * 1024);
  checkCover(Math.round(14.89 * 1024 * 1024)); // the reported failure size
  checkCover(10 * 1024 * 1024 + 1);
  checkCover(25 * 1024 * 1024);
});

test("a 14.89 MB file uploads in two 10 MB-compatible chunks", () => {
  const { chunkSize, totalChunkCount } = planTiktokChunks(Math.round(14.89 * 1024 * 1024));
  assert.equal(chunkSize, 10 * 1024 * 1024);
  assert.equal(totalChunkCount, 2);
});
