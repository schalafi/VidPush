/** Shared validation for a requested publish time (UTC ms). */

export const FB_MIN_LEAD_MS = 10 * 60 * 1000;
export const FB_MAX_AHEAD_MS = 29 * 24 * 3600 * 1000;
export const HELD_MAX_AHEAD_MS = 90 * 24 * 3600 * 1000;
const MIN_LEAD_MS = 60 * 1000;

export function parsePublishAt(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw new Error("Schedule time must be an ISO date string.");
  const ms = new Date(raw).getTime();
  if (Number.isNaN(ms)) throw new Error("Schedule time is not a valid date.");
  return ms;
}

/** Returns an error message, or null when the time is acceptable. */
export function validatePublishAt(
  publishAtMs: number,
  dests: { facebook: boolean; held: boolean }
): string | null {
  const ahead = publishAtMs - Date.now();
  if (ahead < MIN_LEAD_MS) return "Schedule time must be in the future.";
  if (dests.facebook) {
    if (ahead < FB_MIN_LEAD_MS) return "Facebook needs the scheduled time at least 10 minutes ahead.";
    if (ahead > FB_MAX_AHEAD_MS) return "Facebook can schedule up to 29 days ahead.";
  }
  if (dests.held && ahead > HELD_MAX_AHEAD_MS) {
    return "TikTok and Instagram can be scheduled up to 90 days ahead.";
  }
  return null;
}
