import assert from "node:assert/strict";
import { test } from "node:test";
import {
  startFacebookHandoff,
  acceptFacebookHandoff,
  finishFacebookHandoff,
  readFacebookHandoff,
} from "../src/facebookHandoff.js";

const result = { pages: [], expiresAt: null };

test("Facebook authorization in another browser completes the original tab's handoff", () => {
  const { id, state } = startFacebookHandoff("chrome-session", "default");
  assert.ok(state.startsWith("fbh_"));
  // Provider callback arrives cookieless in the other browser.
  const item = acceptFacebookHandoff(state);
  assert.ok(item);
  finishFacebookHandoff(item, result);
  // Only the initiating session can claim the result.
  assert.equal(readFacebookHandoff(id, "chrome-session")?.status, "ready");
  assert.equal(readFacebookHandoff(id, "other-browser-session"), undefined);
});

test("Facebook handoff links are single-use", () => {
  const { state } = startFacebookHandoff("chrome-session", "default");
  assert.ok(acceptFacebookHandoff(state));
  assert.equal(acceptFacebookHandoff(state), undefined);
  assert.equal(acceptFacebookHandoff("fbh_unknown"), undefined);
});

test("starting a new Facebook connection invalidates the old link", () => {
  const first = startFacebookHandoff("chrome-session", "default");
  startFacebookHandoff("chrome-session", "default");
  assert.equal(readFacebookHandoff(first.id, "chrome-session"), undefined);
});
