export type AuthStatus = {
  userId: string;
  youtube: boolean;
  tiktok: boolean;
};

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

const api = (path: string, init?: RequestInit) => fetch(path, init);

export async function getAuthStatus(): Promise<AuthStatus> {
  const res = await api("/api/auth/status");
  if (!res.ok) throw new Error("Failed to load auth status");
  return res.json() as Promise<AuthStatus>;
}

export function connectGoogle(): void {
  window.location.href = "/api/auth/google/start";
}

export function connectTiktok(): void {
  window.location.href = "/api/auth/tiktok/start";
}

export async function disconnectGoogle(): Promise<void> {
  const res = await api("/api/auth/google", { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to disconnect YouTube");
}

export async function disconnectTiktok(): Promise<void> {
  const res = await api("/api/auth/tiktok", { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to disconnect TikTok");
}

export async function uploadVideo(form: FormData): Promise<{ jobId: string }> {
  const res = await api("/api/upload", { method: "POST", body: form });
  const json = (await res.json()) as { jobId?: string; error?: string };
  if (!res.ok) throw new Error(json.error ?? "Upload failed to start");
  if (!json.jobId) throw new Error("No job id");
  return { jobId: json.jobId };
}

export async function getJob(jobId: string): Promise<UploadJob> {
  const res = await api(`/api/upload/jobs/${jobId}`);
  if (!res.ok) throw new Error("Job not found");
  return res.json() as Promise<UploadJob>;
}
