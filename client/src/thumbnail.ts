/** Small pure helpers for the thumbnail picker (kept DOM-free for testing). */

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/** True when the error is the browser refusing to export a tainted canvas. */
export function isTaintError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === "SecurityError") return true;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /taint/i.test(msg);
}

/**
 * Maps a frame-capture failure to the message shown in the picker. Tainted
 * canvases get an actionable message pointing at the image-file fallback
 * instead of the raw DOMException text.
 */
export function friendlyCaptureError(e: unknown): string {
  if (isTaintError(e)) {
    return "This browser blocked reading that video frame. Upload an image file instead.";
  }
  if (e instanceof Error && e.message) return e.message;
  return "Could not capture that frame.";
}

/**
 * Client-side check mirroring the server's thumbnail rule (image, up to
 * 2 MB). Returns null when the file is acceptable.
 */
export function validateThumbnailFile(file: { type: string; size: number }): string | null {
  if (!file.type.startsWith("image/")) return "Thumbnail must be an image file (JPG or PNG).";
  if (file.size > MAX_THUMBNAIL_BYTES) return "Thumbnail must be up to 2 MB (YouTube limit).";
  return null;
}
