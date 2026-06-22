import { useCallback, useEffect, useMemo, useState } from "react";
import {
  connectGoogle,
  connectTiktok,
  disconnectGoogle,
  disconnectTiktok,
  getAuthStatus,
  getJob,
  uploadVideo,
  type AuthStatus,
  type PlatformState,
  type UploadJob,
} from "./api";
import "./App.css";

function formatPlatformStatus(p: PlatformState): string {
  if (p.status === "idle") return "Not selected";
  if (p.status === "queued") return "Queued";
  if (p.status === "uploading") return "Uploading…";
  if (p.status === "done") {
    if (p.videoId) return `Done (video: ${p.videoId})`;
    if (p.publishId) return `Done (publish: ${p.publishId})`;
    return "Done";
  }
  return p.error ? `Error: ${p.error}` : "Error";
}

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [youtubeOn, setYoutubeOn] = useState(true);
  const [tiktokOn, setTiktokOn] = useState(true);
  const [banner, setBanner] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<UploadJob | null>(null);
  const [drag, setDrag] = useState(false);

  const refreshAuth = useCallback(async () => {
    try {
      setAuthErr(null);
      const s = await getAuthStatus();
      setAuth(s);
    } catch {
      setAuthErr("Cannot reach API. Is the server running on port 3000?");
    }
  }, []);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get("oauth");
    const message = params.get("message");
    if (oauth === "google_ok") setBanner({ kind: "ok", text: "YouTube connected." });
    if (oauth === "tiktok_ok") setBanner({ kind: "ok", text: "TikTok connected." });
    if (oauth === "google_error")
      setBanner({ kind: "err", text: `YouTube OAuth failed${message ? `: ${message}` : ""}` });
    if (oauth === "tiktok_error")
      setBanner({ kind: "err", text: `TikTok OAuth failed${message ? `: ${message}` : ""}` });
    if (oauth) {
      params.delete("oauth");
      params.delete("message");
      const qs = params.toString();
      window.history.replaceState({}, "", qs ? `?${qs}` : window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (!job?.id) return;
    let cancelled = false;
    const t = window.setInterval(async () => {
      try {
        const j = await getJob(job.id);
        if (cancelled) return;
        setJob(j);
        const stillRunning =
          j.youtube.status === "queued" ||
          j.youtube.status === "uploading" ||
          j.tiktok.status === "queued" ||
          j.tiktok.status === "uploading";
        if (!stillRunning) window.clearInterval(t);
      } catch {
        /* ignore transient */
      }
    }, 600);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [job?.id]);

  const bothOn = youtubeOn && tiktokOn;
  const anyOn = youtubeOn || tiktokOn;

  const selectAll = () => {
    setYoutubeOn(true);
    setTiktokOn(true);
  };

  const deselectAll = () => {
    setYoutubeOn(false);
    setTiktokOn(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) {
      setFile(f);
      setBanner(null);
    }
  };

  const validationMessage = useMemo(() => {
    if (!anyOn) return "Turn on at least one destination.";
    if (youtubeOn && !auth?.youtube) return "Connect YouTube first.";
    if (tiktokOn && !auth?.tiktok) return "Connect TikTok first.";
    if (!file) return "Choose a video file.";
    return null;
  }, [anyOn, auth?.tiktok, auth?.youtube, file, tiktokOn, youtubeOn]);

  const canUpload = !validationMessage && !busy;

  const onUpload = async () => {
    if (!file || validationMessage) return;
    setBusy(true);
    setBanner(null);
    setJob(null);
    try {
      const fd = new FormData();
      fd.append("video", file);
      fd.append("youtube", String(youtubeOn));
      fd.append("tiktok", String(tiktokOn));
      if (title.trim()) {
        fd.append("title", title.trim());
      }
      const { jobId } = await uploadVideo(fd);
      const initial = await getJob(jobId);
      setJob(initial);
      setBanner({ kind: "info", text: "Upload started. Progress updates below." });
    } catch (e) {
      setBanner({ kind: "err", text: e instanceof Error ? e.message : "Upload failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1 className="title">VidPush</h1>
          <p className="subtitle">
            Drop one video and publish to YouTube and TikTok with a single flow. Connect each
            platform once on this machine.
          </p>
        </div>
      </header>

      {banner && (
        <div
          className={`banner ${banner.kind === "err" ? "error" : ""} ${banner.kind === "ok" ? "ok" : ""}`}
          role="status"
        >
          {banner.text}
        </div>
      )}

      {authErr && (
        <div className="banner error" role="alert">
          {authErr}
        </div>
      )}

      <div className="grid">
        <section className="card">
          <h2>Accounts</h2>
          <div className="accounts">
            <div className="account-row">
              <div className="account-meta">
                <span className="account-name">YouTube</span>
                <span className={`pill ${auth?.youtube ? "on" : "off"}`}>
                  {auth?.youtube ? "Connected" : "Not connected"}
                </span>
              </div>
              <div className="row-actions">
                <button type="button" className="btn primary" onClick={() => connectGoogle()}>
                  Connect
                </button>
                <button
                  type="button"
                  className="btn ghost danger"
                  disabled={!auth?.youtube}
                  onClick={() => void disconnectGoogle().then(refreshAuth)}
                >
                  Disconnect
                </button>
              </div>
            </div>
            <div className="account-row">
              <div className="account-meta">
                <span className="account-name">TikTok</span>
                <span className={`pill ${auth?.tiktok ? "on" : "off"}`}>
                  {auth?.tiktok ? "Connected" : "Not connected"}
                </span>
              </div>
              <div className="row-actions">
                <button type="button" className="btn primary" onClick={() => connectTiktok()}>
                  Connect
                </button>
                <button
                  type="button"
                  className="btn ghost danger"
                  disabled={!auth?.tiktok}
                  onClick={() => void disconnectTiktok().then(refreshAuth)}
                >
                  Disconnect
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Destinations</h2>
          <div className="master-actions">
            <button type="button" className="btn" onClick={selectAll}>
              Select all
            </button>
            <button type="button" className="btn" onClick={deselectAll}>
              Deselect all
            </button>
            <span className="hint">{bothOn ? "Both on" : anyOn ? "One selected" : "None selected"}</span>
          </div>
          <div className="toggle-row">
            <span id="yt-label" className="toggle-label">
              YouTube
            </span>
            <label className="switch">
              <input
                type="checkbox"
                checked={youtubeOn}
                onChange={(e) => setYoutubeOn(e.target.checked)}
                aria-labelledby="yt-label"
              />
              <span className="slider" />
            </label>
          </div>
          <div className="toggle-row">
            <span id="tt-label" className="toggle-label">
              TikTok
            </span>
            <label className="switch">
              <input
                type="checkbox"
                checked={tiktokOn}
                onChange={(e) => setTiktokOn(e.target.checked)}
                aria-labelledby="tt-label"
              />
              <span className="slider" />
            </label>
          </div>

          <div
            className={`dropzone ${drag ? "drag" : ""}`}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                (e.currentTarget.querySelector("input[type=file]") as HTMLInputElement | null)?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            onClick={() =>
              (document.getElementById("file-input") as HTMLInputElement | null)?.click()
            }
          >
            <strong>{file ? file.name : "Drop video here"}</strong>
            <p>{file ? `${(file.size / (1024 * 1024)).toFixed(2)} MB` : "or click to browse"}</p>
            <input
              id="file-input"
              type="file"
              accept="video/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setFile(f);
              }}
            />
          </div>
          <p className="file-hint">PoC limit: 5 GB per file. Same file is uploaded in parallel to each platform.</p>

          <div className="field">
            <label htmlFor="title-input">Title (optional)</label>
            <input
              id="title-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Defaults to file name"
              autoComplete="off"
            />
          </div>

          <div className="upload-actions">
            <button type="button" className="btn primary" disabled={!canUpload} onClick={() => void onUpload()}>
              {busy ? "Starting…" : "Upload"}
            </button>
            {validationMessage && <span className="hint">{validationMessage}</span>}
          </div>

          {job && (
            <div className="progress-block">
              <div className="platform-status">
                <strong>YouTube</strong>
                <span
                  className={`status-line ${job.youtube.status === "error" ? "err" : ""}`}
                >
                  {formatPlatformStatus(job.youtube)}
                </span>
              </div>
              <div className="platform-status">
                <strong>TikTok</strong>
                <span className={`status-line ${job.tiktok.status === "error" ? "err" : ""}`}>
                  {formatPlatformStatus(job.tiktok)}
                </span>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
