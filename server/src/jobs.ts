import type { OauthProvider } from "./db.js";

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
};

const jobs = new Map<string, UploadJob>();

export function createJob(id: string, youtube: boolean, tiktok: boolean): UploadJob {
  const job: UploadJob = {
    id,
    createdAt: Date.now(),
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
  const key = platform === "youtube" ? "youtube" : "tiktok";
  job[key] = { ...job[key], ...patch };
}

/** Prune old jobs to avoid unbounded memory (PoC) */
const MAX_JOBS = 50;
export function pruneJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  const sorted = [...jobs.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  while (sorted.length > MAX_JOBS) {
    const [id] = sorted.shift()!;
    jobs.delete(id);
  }
}
