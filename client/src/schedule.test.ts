import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  dateToLocalInput,
  formatLocalPreview,
  formatSize,
  initialConfirmDests,
  localInputToUtcMs,
  longUploadWarning,
  SCHEDULE_PRESETS,
  tomorrowAtHour,
  utcMsToLocalInput,
  validateQueueFile,
  validateSchedule,
} from "./schedule";

const dests = { youtube: false, tiktok: true, facebook: false, instagram: false };
const noDests = { youtube: false, tiktok: false, facebook: false, instagram: false };

describe("localInputToUtcMs", () => {
  it("returns null for empty input (publish now)", () => {
    expect(localInputToUtcMs("")).toBeNull();
    expect(localInputToUtcMs("   ")).toBeNull();
  });

  it("parses local wall time and round-trips through utcMsToLocalInput", () => {
    const ms = localInputToUtcMs("2026-10-20T14:30");
    assert.ok(ms !== null);
    expect(new Date(ms).getMinutes()).toBe(30);
    expect(utcMsToLocalInput(ms)).toBe("2026-10-20T14:30");
  });

  it("returns null for garbage", () => {
    expect(localInputToUtcMs("not-a-date")).toBeNull();
  });
});

describe("validateSchedule", () => {
  it("allows empty (publish now)", () => {
    expect(validateSchedule(null, dests)).toBeNull();
  });

  it("rejects past times", () => {
    expect(validateSchedule(Date.now() - 60_000, dests)).toBe("Schedule time must be in the future.");
  });

  it("enforces the Facebook 10-minute lead", () => {
    const fb = { ...noDests, facebook: true };
    expect(validateSchedule(Date.now() + 5 * 60_000, fb)).toBe(
      "Facebook needs the scheduled time at least 10 minutes ahead."
    );
    expect(validateSchedule(Date.now() + 30 * 24 * 3600_000, fb)).toBe(
      "Facebook can schedule up to 29 days ahead."
    );
    expect(validateSchedule(Date.now() + 3600_000, fb)).toBeNull();
  });

  it("caps held TikTok/Instagram items at 90 days", () => {
    expect(validateSchedule(Date.now() + 91 * 24 * 3600_000, dests)).toBe(
      "TikTok and Instagram can be scheduled up to 90 days ahead."
    );
    expect(validateSchedule(Date.now() + 3600_000, dests)).toBeNull();
  });
});

describe("validateQueueFile", () => {
  const mp4 = (name: string, size: number, type = "video/mp4") =>
    ({ name, size, type }) as File;

  it("rejects non-video files by name", () => {
    expect(validateQueueFile(mp4("notes.txt", 100, "text/plain"), noDests, "t")).toBe(
      "notes.txt: this does not look like a video file. Choose an MP4, MOV, WebM, or MKV."
    );
  });

  it("rejects empty files", () => {
    expect(validateQueueFile(mp4("clip.mp4", 0), noDests, "t")).toBe("clip.mp4: the file is empty.");
  });

  it("applies the Meta MP4/MOV 1 GB rule only when Meta is selected", () => {
    const big = mp4("clip.mkv", 2 * 1024 ** 3);
    expect(validateQueueFile(big, { ...noDests, facebook: true }, "t")).toBe(
      "clip.mkv: Facebook/Instagram need an MP4 or MOV up to 1 GB."
    );
    expect(validateQueueFile(big, noDests, "t")).toBeNull();
  });

  it("caps general files at 5 GB", () => {
    expect(validateQueueFile(mp4("big.mp4", 6 * 1024 ** 3), noDests, "t")).toBe(
      "big.mp4: files must be up to 5 GB."
    );
  });
});

describe("longUploadWarning", () => {
  const mp4 = (name: string, size: number) => ({ name, size, type: "video/mp4" }) as File;

  it("stays silent for short clips", () => {
    expect(longUploadWarning(mp4("clip.mp4", 50 * 1024 * 1024))).toBeNull();
  });

  it("warns for unusually large files without blocking them", () => {
    const warn = longUploadWarning(mp4("long.mp4", 600 * 1024 * 1024));
    assert.ok(warn !== null);
    expect(warn).toContain("short clips");
  });
});

describe("schedule presets", () => {
  it("offers tomorrow 12 AM / 6 AM / 12 PM / 6 PM quick picks", () => {
    expect(SCHEDULE_PRESETS.map(p => p.label)).toEqual(["12 AM", "6 AM", "12 PM", "6 PM"]);
  });

  it("tomorrowAtHour lands on tomorrow at the requested 24-hour hour", () => {
    const d = tomorrowAtHour(18);
    const now = new Date();
    const expected = new Date(now);
    expected.setDate(expected.getDate() + 1);
    expect(d.getFullYear()).toBe(expected.getFullYear());
    expect(d.getMonth()).toBe(expected.getMonth());
    expect(d.getDate()).toBe(expected.getDate());
    expect(d.getHours()).toBe(18);
    expect(d.getMinutes()).toBe(0);
  });

  it("preset values round-trip through the datetime-local parser", () => {
    for (const preset of SCHEDULE_PRESETS) {
      const value = preset.apply();
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      assert.ok(localInputToUtcMs(value) !== null);
    }
  });

  it("dateToLocalInput matches utcMsToLocalInput", () => {
    const d = new Date(2026, 9, 25, 18, 30);
    expect(dateToLocalInput(d)).toBe(utcMsToLocalInput(d.getTime()));
  });

  it("formatLocalPreview names a time that disambiguates 24h input", () => {
    const ms = localInputToUtcMs("2026-10-25T18:30");
    assert.ok(ms !== null);
    const preview = formatLocalPreview(ms);
    expect(preview).toContain("6:30");
    expect(preview).toMatch(/PM/i);
  });
});

describe("initialConfirmDests", () => {
  const allOn = { youtube: true, tiktok: true, facebook: true, instagram: true };
  const allConnected = { youtube: true, tiktok: true, facebook: true, instagram: true };

  it("keeps the user's toggles for connected destinations", () => {
    expect(initialConfirmDests(allOn, allConnected)).toEqual(allOn);
  });

  it("drops toggled-on destinations that are not connected", () => {
    expect(
      initialConfirmDests(allOn, { ...allConnected, facebook: false, instagram: false })
    ).toEqual({ youtube: true, tiktok: true, facebook: false, instagram: false });
  });

  it("never enables a destination the user toggled off", () => {
    expect(
      initialConfirmDests({ ...allOn, youtube: false }, allConnected)
    ).toEqual({ youtube: false, tiktok: true, facebook: true, instagram: true });
  });
});

describe("formatSize", () => {
  it("formats bytes through gigabytes", () => {
    expect(formatSize(500)).toBe("500 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.00 MB");
    expect(formatSize(2 * 1024 ** 3)).toBe("2.00 GB");
  });
});
