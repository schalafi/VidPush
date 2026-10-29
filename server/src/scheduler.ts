import { v4 as uuidv4 } from "uuid";
import { db, pruneTerminalScheduled, setScheduledJob, setScheduledState, type ScheduledRow } from "./db.js";
import { createJob, getJob, pruneJobs, runUploadJob } from "./jobs.js";

/** Finished rows are kept as proof for this long, then pruned automatically. */
export const TERMINAL_RETENTION_MS = 15 * 24 * 3600 * 1000;

export function pruneOldTerminal(now: number = Date.now()): string[] {
  return pruneTerminalScheduled(now - TERMINAL_RETENTION_MS);
}

/**
 * Hold-and-post for TikTok and Instagram, which have no native scheduling.
 * Polls scheduled_posts and runs due rows through the normal upload flow.
 * Single-writer safe: production runs one container (see modal_app.py).
 */
export async function dispatchDue(now: number = Date.now()): Promise<string[]> {
  pruneOldTerminal(now);
  const due = db
    .prepare("SELECT * FROM scheduled_posts WHERE status = 'scheduled' AND publish_at <= ? ORDER BY publish_at ASC LIMIT 5")
    .all(now) as ScheduledRow[];
  const finished: string[] = [];
  for (const row of due) {
    // Re-check inside the loop so a concurrent dispatch cannot double-publish.
    const fresh = db.prepare("SELECT status FROM scheduled_posts WHERE id = ?").get(row.id) as { status: string } | undefined;
    if (!fresh || fresh.status !== "scheduled") continue;
    setScheduledState(row.id, "uploading");
    const dests = JSON.parse(row.destinations) as { tiktok?: boolean; instagram?: boolean };
    const jobId = uuidv4();
    createJob(jobId, false, !!dests.tiktok, false, !!dests.instagram);
    pruneJobs();
    setScheduledJob(row.id, jobId);
    await runUploadJob({
      jobId,
      userId: row.user_id,
      filePath: row.file_path,
      // A stored thumbnail applies to held Instagram uploads as the Reel
      // cover; the file is deleted with the video when the job settles.
      thumbnailPath: row.thumb_path ?? undefined,
      wantYoutube: false,
      wantTiktok: !!dests.tiktok,
      wantFacebook: false,
      wantInstagram: !!dests.instagram,
      title: row.title,
      description: row.description,
    });
    const job = getJob(jobId);
    const failed = job ? [job.youtube, job.tiktok, job.facebook, job.instagram].find(p => p.status === "error") : undefined;
    setScheduledState(row.id, failed ? "error" : "done", failed?.error ?? null);
    finished.push(row.id);
  }
  return finished;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startScheduler(intervalMs = 15_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void dispatchDue().catch(e => console.error("scheduler dispatch failed", e));
  }, intervalMs);
  timer.unref?.();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
