import { describe, expect, it } from "vitest";
import { friendlyCaptureError, isTaintError, validateThumbnailFile } from "./thumbnail";

describe("isTaintError", () => {
  it("detects the Chrome tainted-canvas toBlob message", () => {
    expect(
      isTaintError(
        new Error("Failed to execute 'toBlob' on 'HTMLCanvasElement': Tainted canvases may not be exported.")
      )
    ).toBe(true);
  });

  it("detects DOM SecurityError", () => {
    expect(isTaintError(new DOMException("The operation is insecure.", "SecurityError"))).toBe(true);
  });

  it("ignores ordinary capture failures", () => {
    expect(isTaintError(new Error("Wait for the video to load, then try again."))).toBe(false);
    expect(isTaintError(null)).toBe(false);
  });
});

describe("friendlyCaptureError", () => {
  it("points tainted-canvas failures at the image-file fallback", () => {
    const msg = friendlyCaptureError(
      new Error("Failed to execute 'toBlob' on 'HTMLCanvasElement': Tainted canvases may not be exported.")
    );
    expect(msg).not.toContain("toBlob");
    expect(msg).toContain("image file");
  });

  it("passes other errors through untouched", () => {
    expect(friendlyCaptureError(new Error("Wait for the video to load, then try again."))).toBe(
      "Wait for the video to load, then try again."
    );
  });
});

describe("validateThumbnailFile", () => {
  const img = (name: string, size: number, type = "image/jpeg") => ({ name, size, type }) as File;

  it("accepts a small JPEG", () => {
    expect(validateThumbnailFile(img("thumb.jpg", 500_000))).toBeNull();
  });

  it("rejects non-images and over-limit files (mirrors the 2 MB server rule)", () => {
    expect(validateThumbnailFile(img("clip.mp4", 100, "video/mp4"))).toContain("image");
    expect(validateThumbnailFile(img("big.jpg", 3 * 1024 * 1024))).toContain("2 MB");
  });
});
