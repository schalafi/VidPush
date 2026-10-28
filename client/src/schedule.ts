/** Local-timezone scheduling helpers. The datetime-local picker yields local
 * wall time; the server receives UTC ISO and stores UTC ms. */

export const FB_MIN_LEAD_MS = 10 * 60 * 1000;
export const FB_MAX_AHEAD_MS = 29 * 24 * 3600 * 1000;
export const HELD_MAX_AHEAD_MS = 90 * 24 * 3600 * 1000;
const MIN_LEAD_MS = 60 * 1000;

/** "2026-10-20T14:30" (local) -> UTC ms, or null when empty/invalid. */
export function localInputToUtcMs(local: string): number | null {
  if (!local.trim()) return null;
  const ms = new Date(local).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** UTC ms -> "YYYY-MM-DDTHH:MM" in the browser's local timezone. */
export function utcMsToLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** UTC ms (or ISO) -> human local string. */
export function formatLocal(ms: number | string): string {
  return new Date(ms).toLocaleString();
}

/**
 * Unambiguous preview shown next to the 24-hour datetime-local input.
 * Uses the browser locale 12-hour rendering plus the zone name, e.g.
 * "Sat, Oct 25, 6:30 PM (America/Los_Angeles)".
 */
export function formatLocalPreview(ms: number): string {
  const d = new Date(ms);
  const when = d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone ? `${when} (${zone})` : when;
}

/** Tomorrow's date at a 24-hour-clock hour in local time. */
export function tomorrowAtHour(hour24: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour24, minute, 0, 0);
  return d;
}

/** Date -> "YYYY-MM-DDTHH:MM" value for a datetime-local input. */
export function dateToLocalInput(d: Date): string {
  return utcMsToLocalInput(d.getTime());
}

/** Quick-pick schedule presets that fill the datetime-local input. */
export const SCHEDULE_PRESETS = [
  { label: "12 AM", apply: () => dateToLocalInput(tomorrowAtHour(0)) },
  { label: "6 AM", apply: () => dateToLocalInput(tomorrowAtHour(6)) },
  { label: "12 PM", apply: () => dateToLocalInput(tomorrowAtHour(12)) },
  { label: "6 PM", apply: () => dateToLocalInput(tomorrowAtHour(18)) },
] as const;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export type ScheduleDests = { youtube: boolean; tiktok: boolean; facebook: boolean; instagram: boolean };

/**
 * Defaults for the upload confirm dialog: keep the user's sidebar toggles,
 * but drop destinations that are not connected.
 */
export function initialConfirmDests(prefs: ScheduleDests, connected: ScheduleDests): ScheduleDests {
  return {
    youtube: prefs.youtube && connected.youtube,
    tiktok: prefs.tiktok && connected.tiktok,
    facebook: prefs.facebook && connected.facebook,
    instagram: prefs.instagram && connected.instagram,
  };
}

/** Client mirror of the server policy: error message or null when acceptable. */
export function validateSchedule(publishAtMs: number | null, dests: ScheduleDests): string | null {
  if (publishAtMs === null) return null;
  const ahead = publishAtMs - Date.now();
  if (ahead < MIN_LEAD_MS) return "Schedule time must be in the future.";
  if (dests.facebook) {
    if (ahead < FB_MIN_LEAD_MS) return "Facebook needs the scheduled time at least 10 minutes ahead.";
    if (ahead > FB_MAX_AHEAD_MS) return "Facebook can schedule up to 29 days ahead.";
  }
  if ((dests.tiktok || dests.instagram) && ahead > HELD_MAX_AHEAD_MS) {
    return "TikTok and Instagram can be scheduled up to 90 days ahead.";
  }
  return null;
}

/** Size above which a file gets a long-video caution (VidPush targets short clips). */
export const LONG_UPLOAD_WARN_BYTES = 500 * 1024 * 1024;

/** Non-blocking caution for unusually large files. Null when no caution applies. */
export function longUploadWarning(file: File): string | null {
  if (file.size > LONG_UPLOAD_WARN_BYTES) {
    return `${file.name}: VidPush is built for short clips — this large file may not finish if the idle server scales down. Upload it anyway only if you can retry.`;
  }
  return null;
}

/** Per-file pre-check before upload. Null means the file may be sent. */
export function validateQueueFile(
  file: File,
  dests: ScheduleDests,
  title: string
): string | null {
  const looksVideo = file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name);
  if (!looksVideo) return `${file.name}: this does not look like a video file. Choose an MP4, MOV, WebM, or MKV.`;
  if (file.size === 0) return `${file.name}: the file is empty.`;
  if ((dests.facebook || dests.instagram) && (!/\.(mp4|mov)$/i.test(file.name) || file.size > 1024 ** 3)) {
    return `${file.name}: Facebook/Instagram need an MP4 or MOV up to 1 GB.`;
  }
  if (file.size > 5 * 1024 ** 3) return `${file.name}: files must be up to 5 GB.`;
  if (dests.instagram && title.length > 2200) return "Instagram captions must be at most 2,200 characters.";
  return null;
}
