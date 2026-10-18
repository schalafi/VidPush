import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  connectGoogle,
  connectMeta,
  startFacebookConnection,
  claimFacebookConnection,
  disconnectMeta,
  selectFacebookPage,
  connectTiktok,
  disconnectGoogle,
  disconnectTiktok,
  getAuthStatus,
  getJob,
  getSession,
  logout,
  unlock,
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
  const [sessionChecked, setSessionChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [provider, setProvider] = useState<"google" | "key">("google");
  const [identityEmail, setIdentityEmail] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [unlockErr, setUnlockErr] = useState<string | null>(null);
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authErr, setAuthErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [youtubeOn, setYoutubeOn] = useState(true);
  const [tiktokOn, setTiktokOn] = useState(true);
  const [facebookOn, setFacebookOn] = useState(false);
  const [instagramOn, setInstagramOn] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<UploadJob | null>(null);
  const [drag, setDrag] = useState(false);
  const [facebookConnection, setFacebookConnection] = useState<{ id: string; url: string } | null>(null);
  const [facebookStarting, setFacebookStarting] = useState(false);

  const onConnectFacebook = async () => {
    // Open synchronously from the click so browsers allow the new tab.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    setFacebookStarting(true);
    setBanner(null);
    try {
      const pending = await startFacebookConnection();
      setFacebookConnection(pending);
      if (tab) tab.location.href = pending.url;
    } catch (error) {
      tab?.close();
      setBanner({ kind: "err", text: error instanceof Error ? error.message : "Could not connect Facebook." });
    } finally { setFacebookStarting(false); }
  };

  const refreshAuth = useCallback(async () => {
    try {
      setAuthErr(null);
      const s = await getAuthStatus();
      setAuth(s);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setAuthenticated(false);
        setAuth(null);
        return;
      }
      setAuthErr("Cannot reach API. Is the server running on port 3000?");
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const session = await getSession();
        setAuthenticated(session.authenticated);
        setProvider(session.provider);
        setIdentityEmail(session.user?.email ?? "");
        setSessionChecked(true);
        if (session.authenticated) {
          await refreshAuth();
        }
      } catch {
        setAuthErr("Cannot reach API. Is the server running on port 3000?");
        setSessionChecked(true);
      }
    })();
  }, [refreshAuth]);

  useEffect(() => {
    if (!authenticated) return;
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") void refreshAuth();
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [authenticated, refreshAuth]);

  useEffect(() => {
    if (!authenticated || !facebookConnection) return;
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      try {
        const result = await claimFacebookConnection(facebookConnection.id);
        if (cancelled) return;
        if (result.status === "ready" || result.status === "error") {
          setFacebookConnection(null);
          setBanner(result.status === "ready"
            ? { kind: "info", text: "Facebook authorized. Choose your Page below to finish connecting." }
            : { kind: "err", text: result.error ?? "Facebook connection failed." });
          await refreshAuth();
          return;
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && [401, 410].includes(error.status)) {
          setFacebookConnection(null);
          setBanner({ kind: "err", text: error.message });
          return;
        }
      }
      if (!cancelled) timer = window.setTimeout(poll, 2000);
    };
    timer = window.setTimeout(poll, 1000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [authenticated, facebookConnection, refreshAuth]);

  const onUnlock = async () => {
    if (!accessKey.trim()) return;
    setUnlockBusy(true);
    setUnlockErr(null);
    try {
      await unlock(accessKey.trim());
      setAuthenticated(true);
      setAccessKey("");
      await refreshAuth();
    } catch (e) {
      setUnlockErr(e instanceof ApiError ? e.message : "Unlock failed");
    } finally {
      setUnlockBusy(false);
    }
  };

  const onLock = async () => {
    try {
      await logout();
    } catch {
      setBanner({ kind: "err", text: "Sign-out could not be confirmed. Please try again." });
      return;
    }
    setAuthenticated(false);
    setAuth(null);
    setJob(null);
    setBanner(null);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const login = params.get("login");
    if (login) {
      setUnlockErr(login === "denied" ? "This Google account is not allowed to access VidPush. Use the owner account." : "Google sign-in could not be completed. Please try again.");
      params.delete("login");
      window.history.replaceState({}, "", window.location.pathname + (params.size ? `?${params}` : ""));
    }
    const oauth = params.get("oauth");
    const message = params.get("message");
    if (oauth === "facebook_choose") setBanner({ kind: "info", text: "Facebook authorized. Choose the Page to publish to below." });
    if (oauth === "instagram_ok") setBanner({ kind: "ok", text: "Instagram connected." });
    if (oauth === "facebook_error" || oauth === "instagram_error") setBanner({ kind: "err", text: `Connection failed${message ? `: ${message}` : ""}` });
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
        const states = [j.youtube, j.tiktok, j.facebook, j.instagram];
        const stillRunning = states.some(p => p.status === "queued" || p.status === "uploading");
        if (!stillRunning) {
          window.clearInterval(t);
          cancelled = true;
          const failed = states.some(p => p.status === "error");
          if (failed) {
            setBanner({ kind: "err", text: "Upload finished with errors. Review the results below before retrying." });
          } else {
            setFile(null);
            setTitle("");
            if (fileInput.current) fileInput.current.value = "";
            setBanner({ kind: "ok", text: "Upload complete. Choose another video when you’re ready." });
          }
        }
      } catch {
        /* ignore transient */
      }
    }, 600);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [job?.id]);

  const uploading = busy || Boolean(job && [job.youtube.status, job.tiktok.status, job.facebook.status, job.instagram.status]
    .some(status => status === "queued" || status === "uploading"));

  const selectedCount = [youtubeOn, tiktokOn, facebookOn, instagramOn].filter(Boolean).length;
  const anyOn = selectedCount > 0;

  const selectAll = () => {
    setYoutubeOn(true);
    setTiktokOn(true);
    setFacebookOn(true);
    setInstagramOn(true);
  };

  const deselectAll = () => {
    setYoutubeOn(false);
    setTiktokOn(false);
    setFacebookOn(false);
    setInstagramOn(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (uploading) return;
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
    if (facebookOn && !auth?.facebook.connected) return "Connect Facebook and choose a Page first.";
    if (instagramOn && !auth?.instagram.connected) return "Connect Instagram first.";
    if (!file) return "Choose a video file.";
    if ((facebookOn || instagramOn) && (!/\.(mp4|mov)$/i.test(file.name) || file.size > 1024 ** 3)) return "For Facebook/Instagram, choose an MP4 or MOV up to 1 GB.";
    if (instagramOn && title.length > 2200) return "Instagram captions must be at most 2,200 characters.";
    return null;
  }, [anyOn, auth, file, tiktokOn, youtubeOn, facebookOn, instagramOn, title]);

  const canUpload = !validationMessage && !uploading;

  const onUpload = async () => {
    if (!file || validationMessage || uploading) return;
    setBusy(true);
    setBanner(null);
    setJob(null);
    try {
      const fd = new FormData();
      fd.append("video", file);
      fd.append("youtube", String(youtubeOn));
      fd.append("tiktok", String(tiktokOn));
      fd.append("facebook", String(facebookOn));
      fd.append("instagram", String(instagramOn));
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

  if (!sessionChecked) {
    return (
      <div className="page">
        <p className="subtitle">Loading…</p>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="page">
        <header className="header">
          <div>
            <h1 className="title">VidPush</h1>
            <p className="subtitle">
              Sign in to manage your connected accounts and publish videos.
            </p>
          </div>
        </header>

        {authErr && (
          <div className="banner error" role="alert">
            {authErr}
          </div>
        )}

        <section className="card unlock-card">
          <h2>Sign in</h2>
          {provider === "google" ? <>
            <p className="hint">Use the Google account authorized for VidPush.</p>
            {unlockErr && <div className="banner error" role="alert">{unlockErr}</div>}
            <a className="btn primary" href="/api/auth/login/google/start">Sign in with Google</a>
          </> : <>

          <p className="hint">
            Use the value of <code>VIDPUSH_API_KEY</code> from your local <code>.env</code>.
          </p>
          <div className="field">
            <label htmlFor="access-key">Access key</label>
            <input
              id="access-key"
              type="password"
              value={accessKey}
              onChange={(e) => setAccessKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onUnlock();
              }}
              placeholder="Paste your VIDPUSH_API_KEY"
              autoComplete="off"
            />
          </div>
          {unlockErr && (
            <div className="banner error" role="alert">
              {unlockErr}
            </div>
          )}
          <button
            type="button"
            className="btn primary"
            disabled={unlockBusy || !accessKey.trim()}
            onClick={() => void onUnlock()}
          >
            {unlockBusy ? "Checking…" : "Unlock"}
          </button>
          </>}
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1 className="title">VidPush</h1>
          <p className="subtitle">
            Drop one video and publish to YouTube, TikTok, Facebook, and Instagram.
            Connect each destination separately.
          </p>
        </div>
        <button type="button" className="btn ghost" onClick={() => void onLock()}>
          Sign out{identityEmail ? ` (${identityEmail})` : ""}
        </button>
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
                <button type="button" className="btn primary" disabled={uploading} onClick={() => connectGoogle()}>
                  Connect
                </button>
                <button
                  type="button"
                  className="btn ghost danger"
                  disabled={uploading || !auth?.youtube}
                  onClick={() => void disconnectGoogle().then(refreshAuth).catch(e => setBanner({ kind: "err", text: e.message }))}
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
                <button type="button" className="btn primary" disabled={uploading} onClick={() => connectTiktok()}>
                  Connect
                </button>
                <button
                  type="button"
                  className="btn ghost danger"
                  disabled={uploading || !auth?.tiktok}
                  onClick={() => void disconnectTiktok().then(refreshAuth).catch(e => setBanner({ kind: "err", text: e.message }))}
                >
                  Disconnect
                </button>
              </div>
            </div>
            {(["facebook", "instagram"] as const).map(platform => {
              const connection = auth?.[platform];
              const label = platform === "facebook" ? "Facebook Page" : "Instagram";
              return <div className="account-row" key={platform}>
                <div className="account-meta">
                  <span className="account-name">{label}</span>
                  <span className={`pill ${connection?.connected ? "on" : "off"}`}>
                    {connection?.connected ? connection.name || connection.accountId : connection?.configured ? "Not connected" : "Setup needed"}
                  </span>
                </div>
                <div className="row-actions">
                  <button type="button" className="btn primary" disabled={uploading || !connection?.configured || (platform === "facebook" && facebookStarting)} onClick={() => platform === "facebook" ? void onConnectFacebook() : connectMeta(platform)} aria-label={platform === "facebook" ? "Connect Facebook (opens in a new tab)" : "Connect Instagram"}>Connect{platform === "facebook" ? " ↗" : ""}</button>
                  <button type="button" className="btn ghost danger" disabled={uploading || (!connection?.accountId && !(platform === "facebook" && auth?.facebookPages.length))}
                    onClick={() => void disconnectMeta(platform).then(refreshAuth).catch(e => setBanner({ kind: "err", text: e.message }))}>Disconnect</button>
                </div>
              </div>;
            })}
            {facebookConnection && <div className="field">
              <p>Waiting for Facebook authorization. You can open this link in the browser where you use Facebook. This tab will update automatically.</p>
              <a className="btn" href={facebookConnection.url} target="_blank" rel="noopener noreferrer">Open Facebook authorization ↗</a>
              <button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(facebookConnection.url).then(() => setBanner({ kind: "info", text: "Authorization link copied. Paste it into your other browser. It expires after 10 minutes." })).catch(() => setBanner({ kind: "info", text: "Right-click the authorization link and copy its address." }))}>Copy authorization link</button>
              <p className="hint">Keep this VidPush tab open. Only use the link yourself.</p>
            </div>}
            {Boolean(auth?.facebookPages.length) && <div className="field">
              <label htmlFor="facebook-page">Publish to Facebook Page</label>
              <select id="facebook-page" disabled={uploading} value={auth?.facebook.accountId ?? ""}
                onChange={e => void selectFacebookPage(e.target.value).then(refreshAuth).catch(error => setBanner({ kind: "err", text: error.message }))}>
                <option value="" disabled>Choose a Page</option>
                {auth?.facebookPages.map(page => <option key={page.id} value={page.id}>{page.name}</option>)}
              </select>
            </div>}
          </div>
          <p className="hint">Facebook publishes to a Page. Instagram uses its own professional account and login.</p>
        </section>

        <section className="card">
          <h2>Destinations</h2>
          <div className="master-actions">
            <button type="button" className="btn" disabled={uploading} onClick={selectAll}>
              Select all
            </button>
            <button type="button" className="btn" disabled={uploading} onClick={deselectAll}>
              Deselect all
            </button>
            <span className="hint">{`${selectedCount} selected`}</span>
          </div>
          <div className="toggle-row">
            <span id="yt-label" className="toggle-label">
              YouTube
            </span>
            <label className="switch">
              <input
                type="checkbox"
                disabled={uploading}
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
                disabled={uploading}
                checked={tiktokOn}
                onChange={(e) => setTiktokOn(e.target.checked)}
                aria-labelledby="tt-label"
              />
              <span className="slider" />
            </label>
          </div>

          {([{ id: "facebook", name: "Facebook Reels", on: facebookOn, set: setFacebookOn },
            { id: "instagram", name: "Instagram Reels", on: instagramOn, set: setInstagramOn }]).map(platform =>
            <div className="toggle-row" key={platform.id}>
              <span id={`${platform.id}-label`} className="toggle-label">{platform.name}</span>
              <label className="switch"><input type="checkbox" disabled={uploading} checked={platform.on}
                onChange={e => platform.set(e.target.checked)} aria-labelledby={`${platform.id}-label`} /><span className="slider" /></label>
            </div>)}
          {(facebookOn || instagramOn) && <p className="hint">Selected Meta destinations publish Reels to the accounts shown above. Use a vertical MP4 or MOV. The title becomes the caption.</p>}
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
              ref={fileInput}
              disabled={uploading}
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
          <p className="file-hint">Up to 5 GB; up to 1 GB when Facebook or Instagram is selected. Each platform also checks its video requirements.</p>

          <div className="field">
            <label htmlFor="title-input">Title / caption (optional)</label>
            <input
              disabled={uploading}
              id="title-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Defaults to file name"
              autoComplete="off"
            />
          </div>

          <div className="upload-actions">
            <button type="button" className="btn primary" disabled={!canUpload} onClick={() => void onUpload()}>
              {busy ? "Starting…" : uploading ? "Uploading…" : "Upload"}
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
              {(["facebook", "instagram"] as const).map(platform => <div className="platform-status" key={platform}>
                <strong>{platform === "facebook" ? "Facebook" : "Instagram"}</strong>
                <span className={`status-line ${job[platform].status === "error" ? "err" : ""}`}>{formatPlatformStatus(job[platform])}</span>
              </div>)}
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
