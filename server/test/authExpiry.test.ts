import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const dir = mkdtempSync(`${tmpdir()}/vidpush-authexpiry-`);
process.env.DATA_DIR = dir;

const { db, deleteTokens, getTokens, upsertTokens } = await import("../src/db.js");
const { isLoginRevoked, verifyYoutubeLogin } = await import("../src/services/googleTokens.js");
const { isTiktokLoginRevoked, verifyTiktokLogin } = await import("../src/services/tiktokTokens.js");

after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

test("revoked-grant errors are recognized, transient ones are not", () => {
  assert.equal(isLoginRevoked(new Error("invalid_grant")), true);
  assert.equal(isLoginRevoked(new Error("Error: invalid_grant - Token has been expired or revoked")), true);
  assert.equal(isLoginRevoked(new Error("socket hang up")), false);
  assert.equal(isTiktokLoginRevoked(new Error("invalid_grant")), true);
  assert.equal(isTiktokLoginRevoked(new Error("refresh_token expired")), true);
  assert.equal(isTiktokLoginRevoked(new Error("TikTok refresh failed: 500")), false);
});

test("verified login reports disconnected only for dead logins", async () => {
  assert.equal(await verifyYoutubeLogin("default"), false);
  assert.equal(await verifyTiktokLogin("default"), false);

  upsertTokens("default", "youtube", "fresh", "refresh", Date.now() + 3600_000, null);
  upsertTokens("default", "tiktok", "fresh", "refresh", Date.now() + 3600_000, "open123");
  assert.equal(await verifyYoutubeLogin("default"), true);
  assert.equal(await verifyTiktokLogin("default"), true);
});

test("expired login without a refresh token is forgotten", async () => {
  // NOTE: upsert keeps an existing refresh token on null, so delete first to
  // plant a row that genuinely never had one (e.g. no offline access grant).
  deleteTokens("default", "youtube");
  deleteTokens("default", "tiktok");
  upsertTokens("default", "youtube", "stale", null, Date.now() - 1000, null);
  upsertTokens("default", "tiktok", "stale", null, Date.now() - 1000, "open123");
  assert.equal(await verifyYoutubeLogin("default"), false);
  assert.equal(await verifyTiktokLogin("default"), false);
  assert.equal(getTokens("default", "youtube"), undefined);
  assert.equal(getTokens("default", "tiktok"), undefined);
});
