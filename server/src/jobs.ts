import fs from "fs";
import type { OauthProvider } from "./db.js";
import { uploadToYoutube } from "./services/youtubeUpload.js";
import { getValidTikTokAccessToken } from "./services/tiktokTokens.js";
import {
  uploadToTiktok,
  waitForTiktokPublish,
} from "./services/tiktokUpload.js";
import { uploadToMeta } from "./services/metaUpload.js";

export type PlatformState = {
  status: "idle" | "queued" | "uploading" | "done" | "error";
  error?: string;
  videoId?: string;
  publishId?: string;
};

export type UploadJob = {
  id: string;
  createdAt: number;
  youtube: PlatformState;
  tiktok: PlatformState;
  facebook: PlatformState;
  instagram: PlatformState;
};

const jobs = new Map<string, UploadJob>();

export function createJob(id: string, youtube: boolean, tiktok: boolean, facebook = false, instagram = false): UploadJob {
  const job: UploadJob = {
    id,
    createdAt: Date.now(),
    facebook: { status: facebook ? "queued" : "idle" },
    instagram: { status: instagram ? "queued" : "idle" },
    youtube: {
      status: youtube ? "queued" : "idle",
    },
    tiktok: {
      status: tiktok ? "queued" : "idle",
    },
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): UploadJob | undefined {
  return jobs.get(id);
}

export function updatePlatform(
  jobId: string,
  platform: OauthProvider,
  patch: Partial<PlatformState>
): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job[platform] = { ...job[platform], ...patch };
}

/** Prune old jobs to avoid unbounded memory (PoC) */
const MAX_JOBS = 50;
export function pruneJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  const sorted = [...jobs.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  while (sorted.length > MAX_JOBS) {
    const [id] = sorted.shift()!;
    const job = jobs.get(id)!;
    if (![job.youtube, job.tiktok, job.facebook, job.instagram].some(p => ["queued", "uploading"].includes(p.status))) jobs.delete(id);
  }
}

/**
 * Run the platform uploads for a job. Shared by the immediate upload route
 * and the hold-and-post scheduler. publishAtMs schedules natively on
 * platforms that support it (YouTube, Facebook); others ignore it.
 * The file is deleted when all platform uploads settle.
 */
export async function runUploadJob(args: {
  jobId: string;
  userId: string;
  filePath: string;
  thumbnailPath?: string;
  wantYoutube: boolean;
  wantTiktok: boolean;
  wantFacebook: boolean;
  wantInstagram: boolean;
  title: string;
  description: string;
  publishAtMs?: number;
}): Promise<void> {
  const { jobId, userId, filePath, thumbnailPath, wantYoutube, wantTiktok, wantFacebook, wantInstagram, title, description, publishAtMs } = args;

  const tasks: Promise<void>[] = [];

  if (wantYoutube) {
    tasks.push(
      (async () => {
        updatePlatform(jobId, "youtube", { status: "uploading" });
        try {
          const videoId = await uploadToYoutube(userId, filePath, title, description, publishAtMs, thumbnailPath);
          updatePlatform(jobId, "youtube", { status: "done", videoId });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          updatePlatform(jobId, "youtube", { status: "error", error: msg });
        }
      })()
    );
  }

  if (wantTiktok) {
    tasks.push(
      (async () => {
        updatePlatform(jobId, "tiktok", { status: "uploading" });
        try {
          const { publishId } = await uploadToTiktok(userId, filePath, title);
          const { accessToken } = await getValidTikTokAccessToken(userId);
          await waitForTiktokPublish(accessToken, publishId);
          updatePlatform(jobId, "tiktok", { status: "done", publishId });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          updatePlatform(jobId, "tiktok", { status: "error", error: msg });
        }
      })()
    );
  }

  for (const platform of ["facebook", "instagram"] as const) {
    if (!(platform === "facebook" ? wantFacebook : wantInstagram)) continue;
    tasks.push((async () => {
      updatePlatform(jobId, platform, { status: "uploading" });
      try {
        const videoId = await uploadToMeta(platform, userId, filePath, title, platform === "facebook" ? publishAtMs : undefined);
        updatePlatform(jobId, platform, { status: "done", videoId });
      } catch (error) {
        updatePlatform(jobId, platform, { status: "error", error: error instanceof Error ? error.message : "Upload failed" });
      }
    })());
  }
  await Promise.allSettled(tasks);

  fs.unlink(filePath, () => {});
  if (thumbnailPath) fs.unlink(thumbnailPath, () => {});
}
