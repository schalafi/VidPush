import assert from "node:assert/strict";
import { test } from "node:test";

const { planTiktokChunks } = await import("../src/services/tiktokUpload.js");

const MB = 1024 * 1024;

/**
 * TikTok media transfer guide: total_chunk_count = floor(video_size /
 * chunk_size); trailing bytes merge into the final chunk (which may exceed
 * chunk_size, up to 128 MB). Every chunk must be >= 5 MB, so no small tail
 * chunk may be sent.
 */
function checkCover(videoSize: number) {
  const { chunkSize, totalChunkCount, ranges } = planTiktokChunks(videoSize);
  assert.equal(ranges.length, totalChunkCount);
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges[ranges.length - 1].end, videoSize - 1);
  for (let i = 0; i < ranges.length; i++) {
    assert.equal(ranges[i].start, i === 0 ? 0 : ranges[i - 1].end + 1);
    const len = ranges[i].end - ranges[i].start + 1;
    if (i < ranges.length - 1) {
      // Non-final chunks are exactly chunk_size.
      assert.equal(len, chunkSize);
    } else if (totalChunkCount > 1) {
      // Trailing bytes merge into the final chunk: it carries at least a
      // full chunk, never a small tail.
      assert.ok(len >= chunkSize, `final chunk smaller than chunk_size for ${videoSize}`);
      assert.ok(len <= 128 * MB, `final chunk exceeds 128 MB for ${videoSize}`);
    }
    if (videoSize >= 5 * MB) {
      assert.ok(len >= 5 * MB, `chunk under 5 MB for ${videoSize}`);
    }
  }
  assert.equal(totalChunkCount, Math.max(1, Math.floor(videoSize / chunkSize)));
}

test("chunk plan follows floor(video_size / chunk_size) with merged tail", () => {
  checkCover(100);
  checkCover(5 * MB);
  checkCover(7 * MB);
  checkCover(Math.round(14.89 * MB)); // reported failure size
  checkCover(Math.round(23.76 * MB)); // reported failure size
  checkCover(10 * MB + 1); // must not produce a 1-byte tail chunk
  checkCover(20 * MB);
  checkCover(25 * MB);
  checkCover(50_000_123);
});

test("a 14.89 MB file uploads in one merged chunk, not two", () => {
  const size = Math.round(14.89 * MB);
  const { chunkSize, totalChunkCount, ranges } = planTiktokChunks(size);
  assert.equal(chunkSize, 10 * MB);
  assert.equal(totalChunkCount, 1);
  assert.deepEqual(ranges, [{ start: 0, end: size - 1 }]);
});

test("a 23.76 MB file uploads in two chunks with the tail merged", () => {
  const size = Math.round(23.76 * MB);
  const { chunkSize, totalChunkCount, ranges } = planTiktokChunks(size);
  assert.equal(chunkSize, 10 * MB);
  assert.equal(totalChunkCount, 2);
  assert.deepEqual(ranges, [
    { start: 0, end: 10 * MB - 1 },
    { start: 10 * MB, end: size - 1 },
  ]);
});
