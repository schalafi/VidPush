export type MetaConnection = { configured: boolean; connected: boolean; accountId: string | null; name: string | null };
export type AuthStatus = {
  userId: string;
  youtube: boolean;
  tiktok: boolean;
  facebook: MetaConnection;
  instagram: MetaConnection;
  facebookPages: { id: string; name: string }[];
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
  facebook: PlatformState;
  instagram: PlatformState;
};

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(path, { credentials: "include", ...init });
  if (res.status === 401) {
    throw new ApiError(401, "Unauthorized");
  }
  return res;
};

export async function getSession(): Promise<{ authenticated: boolean; provider: "google" | "key"; user?: { email: string } }> {
  const res = await fetch("/api/auth/session", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to check session");
  return res.json() as Promise<{ authenticated: boolean; provider: "google" | "key"; user?: { email: string } }>;
}

export async function unlock(apiKey: string): Promise<void> {
  const res = await fetch("/api/auth/unlock", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  if (res.status === 401) {
    throw new ApiError(401, "Invalid access key");
  }
  if (!res.ok) throw new Error("Unlock failed");
}

export async function logout(): Promise<void> {
  const res = await api("/api/auth/logout", { method: "POST" });
  if (!res.ok) throw new Error("Logout failed");
}

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

export function connectMeta(platform: "facebook" | "instagram"): void {
  if (platform === "facebook") {
    window.open("/api/auth/facebook/start", "_blank", "noopener,noreferrer");
    return;
  }
  window.location.href = `/api/auth/${platform}/start`;
}
export async function startFacebookConnection(): Promise<{ id: string; url: string }> {
  const res = await api("/api/auth/facebook/handoff", { method: "POST" });
  if (!res.ok) throw new Error("Could not start Facebook connection.");
  return res.json();
}
export async function claimFacebookConnection(id: string): Promise<{ status: string; error?: string }> {
  const res = await api(`/api/auth/facebook/handoff/${encodeURIComponent(id)}/claim`, { method: "POST" });
  const result = await res.json();
  if (!res.ok) throw new ApiError(res.status, result.error ?? "Could not check Facebook connection.");
  return result;
}
export async function disconnectMeta(platform: "facebook" | "instagram"): Promise<void> {
  const res = await api(`/api/auth/${platform}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to disconnect ${platform}`);
}
export async function selectFacebookPage(pageId: string): Promise<void> {
  const res = await api("/api/auth/facebook/page", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageId }) });
  if (!res.ok) throw new Error("Could not select that Page. Reconnect Facebook and try again.");
}
