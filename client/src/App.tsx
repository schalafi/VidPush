import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  cancelScheduled,
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
  listScheduled,
  logout,
  unlock,
  updateScheduled,
  uploadVideoXHR,
  type AuthStatus,
  type PlatformState,
  type ScheduledItem,
  type UploadJob,
} from "./api";
import {
  dateToLocalInput,
  formatLocal,
  formatLocalPreview,
  formatSize,
  localInputToUtcMs,
  longUploadWarning,
  SCHEDULE_PRESETS,
  utcMsToLocalInput,
  validateQueueFile,
  validateSchedule,
  type ScheduleDests,
} from "./schedule";
import ThumbnailPicker from "./ThumbnailPicker";
import "./App.css";

const DEST_PREF_KEY = "vidpush.dests";

function readDestPref(key: "youtube" | "tiktok" | "facebook" | "instagram", fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(DEST_PREF_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed[key] === "boolean" ? (parsed[key] as boolean) : fallback;
  } catch {
    return fallback;
  }
}

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

type QueueItem = {
  key: string;
  file: File;
  title: string;
  scheduleLocal: string;
  thumbnail: File | null;
  status: "queued" | "uploading" | "done" | "error";
  progress: number;
  error: string | null;
  jobId: string | null;
  note: string | null;
};

function Thumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  if (!url || failed) return <div className="thumb thumb-fallback" aria-hidden="true">No preview</div>;
  return (
    <video
      className="thumb"
      src={url}
      preload="metadata"
      muted
      playsInline
      onError={() => setFailed(true)}
    />
  );
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
  const [youtubeOn, setYoutubeOn] = useState(() => readDestPref("youtube", true));
  const [tiktokOn, setTiktokOn] = useState(() => readDestPref("tiktok", true));
  const [facebookOn, setFacebookOn] = useState(() => readDestPref("facebook", false));
  const [instagramOn, setInstagramOn] = useState(() => readDestPref("instagram", false));
  useEffect(() => {
    try {
      localStorage.setItem(
        DEST_PREF_KEY,
        JSON.stringify({ youtube: youtubeOn, tiktok: tiktokOn, facebook: facebookOn, instagram: instagramOn })
      );
    } catch {
      /* private mode: keep in-memory state */
    }
  }, [youtubeOn, tiktokOn, facebookOn, instagramOn]);
  const [banner, setBanner] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  const [drag, setDrag] = useState(false);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [jobs, setJobs] = useState<Record<string, UploadJob>>({});
  const [scheduled, setScheduled] = useState<ScheduledItem[]>([]);
  const [scheduledErr, setScheduledErr] = useState<string | null>(null);
  const keySeq = useRef(0);
  const dests: ScheduleDests = { youtube: youtubeOn, tiktok: tiktokOn, facebook: facebookOn, instagram: instagramOn };
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
    setItems([]);
    setJobs({});
    setScheduled([]);
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

  const refreshScheduled = useCallback(async () => {
    try {
      setScheduledErr(null);
      setScheduled(await listScheduled());
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) {
        setScheduledErr("Could not load scheduled videos.");
      }
    }
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    void refreshScheduled();
    const t = window.setInterval(() => void refreshScheduled(), 15000);
    return () => window.clearInterval(t);
  }, [authenticated, refreshScheduled]);

  const itemsRef = useRef<QueueItem[]>([]);
  itemsRef.current = items;

  // Poll every live job until its platforms settle.
  useEffect(() => {
    const t = window.setInterval(async () => {
      const live = itemsRef.current.filter(i => i.jobId && i.status === "uploading");
      if (!live.length) return;
      for (const item of live) {
        try {
          const j = await getJob(item.jobId!);
          setJobs(prev => ({ ...prev, [j.id]: j }));
          const states: [string, PlatformState][] = [["YouTube", j.youtube], ["TikTok", j.tiktok], ["Facebook", j.facebook], ["Instagram", j.instagram]];
          const active = states.filter(([, p]) => p.status === "queued" || p.status === "uploading");
          if (active.length) continue;
          const failed = states.filter(([, p]) => p.status === "error");
          const expired = states.find(([, p]) => p.status === "error" && /login expired|reconnect/i.test(p.error ?? ""));
          if (expired) {
            const [name] = expired;
            setBanner({ kind: "err", text: `Your ${name} login expired. Press Connect next to ${name} to sign in again, then retry.` });
            void refreshAuth();
          }
          const tiktokPrivate = !expired && states.find(([name, p]) =>
            name === "TikTok" && p.status === "error" && /private|SELF_ONLY/i.test(p.error ?? ""));
          if (tiktokPrivate) {
            setBanner({ kind: "err", text: "TikTok refused the upload: set your TikTok account to Private (TikTok app → Settings → Privacy), then press Retry." });
          }
          setItems(prev => prev.map(it => {
            if (it.key !== item.key) return it;
            if (!failed.length) return { ...it, status: "done" as const };
            return {
              ...it,
              status: "error" as const,
              error: failed.map(([, p]) => p.error ?? "Upload failed").join(" "),
            };
          }));
        } catch {
          /* ignore transient */
        }
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  const anyUploading = items.some(i => i.status === "uploading");

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

  const connectionError = (): string | null => {
    if (!anyOn) return "Turn on at least one destination.";
    if (youtubeOn && !auth?.youtube) return "Connect YouTube first.";
    if (tiktokOn && !auth?.tiktok) return "Connect TikTok first.";
    if (facebookOn && !auth?.facebook.connected) return "Connect Facebook and choose a Page first.";
    if (instagramOn && !auth?.instagram.connected) return "Connect Instagram first.";
    return null;
  };

  const patchItem = (key: string, patch: Partial<QueueItem>) =>
    setItems(prev => prev.map(it => (it.key === key ? { ...it, ...patch } : it)));

  const addFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    const fresh: QueueItem[] = [];
    for (const f of Array.from(files)) {
      keySeq.current += 1;
      fresh.push({
        key: `${Date.now()}-${keySeq.current}`,
        file: f,
        title: f.name.replace(/\.[^.]+$/, ""),
        scheduleLocal: "",
        thumbnail: null,
        status: "queued",
        progress: 0,
        error: null,
        jobId: null,
        note: null,
      });
    }
    if (fresh.length) {
      setItems(prev => [...prev, ...fresh]);
      setBanner(null);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    addFiles(e.dataTransfer.files);
  };

  const removeItem = (key: string) =>
    setItems(prev => prev.filter(it => (it.key === key ? it.status !== "uploading" : true)));

  const clearDone = () => setItems(prev => prev.filter(it => it.status === "uploading" || it.status === "queued"));

  const startItem = async (key: string) => {
    const item = itemsRef.current.find(i => i.key === key);
    if (!item || item.status === "uploading") return;
    const conn = connectionError();
    if (conn) {
      setBanner({ kind: "err", text: conn });
      return;
    }
    const hasSchedule = item.scheduleLocal.trim() !== "";
    const publishAtMs = localInputToUtcMs(item.scheduleLocal);
    if (hasSchedule && publishAtMs === null) {
      patchItem(key, { status: "error", error: "Schedule time is not a valid date and time." });
      return;
    }
    const schedErr = validateSchedule(publishAtMs, dests);
    if (schedErr) {
      patchItem(key, { status: "error", error: schedErr });
      return;
    }
    const fileErr = validateQueueFile(item.file, dests, item.title.trim());
    if (fileErr) {
      patchItem(key, { status: "error", error: fileErr });
      return;
    }
    patchItem(key, { status: "uploading", progress: 0, error: null, note: null, jobId: null });
    try {
      const fd = new FormData();
      fd.append("video", item.file);
      fd.append("youtube", String(youtubeOn));
      fd.append("tiktok", String(tiktokOn));
      fd.append("facebook", String(facebookOn));
      fd.append("instagram", String(instagramOn));
      if (item.title.trim()) fd.append("title", item.title.trim());
      if (item.thumbnail) fd.append("thumbnail", item.thumbnail, item.thumbnail.name);
      if (publishAtMs !== null) fd.append("publishAt", new Date(publishAtMs).toISOString());
      const result = await uploadVideoXHR(fd, pct => patchItem(key, { progress: pct }));
      if (result.jobId) {
        const initial = await getJob(result.jobId);
        setJobs(prev => ({ ...prev, [initial.id]: initial }));
        patchItem(key, { jobId: result.jobId });
      }
      const held = result.scheduleIds?.length ?? 0;
      const when = publishAtMs !== null ? formatLocal(publishAtMs) : null;
      let note: string;
      if (result.jobId && held) {
        note = when
          ? `Upload finished. ${held === 1 ? "TikTok/Instagram video" : `${held} videos`} held by VidPush for ${when}.`
          : "Upload finished.";
      } else if (result.jobId && when) {
        note = `Uploaded and scheduled natively for ${when}.`;
      } else if (result.jobId) {
        note = "Upload finished.";
      } else {
        note = when ? `Held by VidPush for ${when}. See Scheduled below.` : "Held by VidPush. See Scheduled below.";
        patchItem(key, { status: "done", progress: 100, note });
      }
      if (result.jobId) patchItem(key, { note });
      if (held) void refreshScheduled();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setAuthenticated(false);
        setAuth(null);
        return;
      }
      const msg = e instanceof Error ? e.message : "Upload failed";
      if (/private|SELF_ONLY/i.test(msg)) {
        setBanner({ kind: "err", text: "TikTok refused the upload: set your TikTok account to Private (TikTok app → Settings → Privacy), then press Retry." });
      }
      patchItem(key, { status: "error", error: msg });
    }
  };

  const startAll = () => {
    const conn = connectionError();
    if (conn) {
      setBanner({ kind: "err", text: conn });
      return;
    }
    const queued = itemsRef.current.filter(i => i.status === "queued" || i.status === "error");
    if (!queued.length) return;
    setBanner({ kind: "info", text: `Uploading ${queued.length === 1 ? "1 video" : `${queued.length} videos`}. Progress shows on each row.` });
    // At most two concurrent uploads; the rest start as slots free.
    let active = 0;
    let index = 0;
    const next = (): void => {
      while (active < 2 && index < queued.length) {
        const item = queued[index++];
        active += 1;
        void startItem(item.key).finally(() => {
          active -= 1;
          next();
        });
      }
    };
    next();
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
            Drop videos and publish to YouTube, TikTok, Facebook, and Instagram.
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
                <button type="button" className="btn primary" disabled={anyUploading} onClick={() => connectGoogle()}>
                  Connect
                </button>
                <button
                  type="button"
                  className="btn ghost danger"
                  disabled={anyUploading || !auth?.youtube}
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
                <button type="button" className="btn primary" disabled={anyUploading} onClick={() => connectTiktok()}>
                  Connect
                </button>
                <button
                  type="button"
                  className="btn ghost danger"
                  disabled={anyUploading || !auth?.tiktok}
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
                  <button type="button" className="btn primary" disabled={anyUploading || !connection?.configured || (platform === "facebook" && facebookStarting)} onClick={() => platform === "facebook" ? void onConnectFacebook() : connectMeta(platform)} aria-label={platform === "facebook" ? "Connect Facebook (opens in a new tab)" : "Connect Instagram"}>Connect{platform === "facebook" ? " ↗" : ""}</button>
                  <button type="button" className="btn ghost danger" disabled={anyUploading || (!connection?.accountId && !(platform === "facebook" && auth?.facebookPages.length))}
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
              <select id="facebook-page" disabled={anyUploading} value={auth?.facebook.accountId ?? ""}
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
            <button type="button" className="btn" disabled={anyUploading} onClick={selectAll}>
              Select all
            </button>
            <button type="button" className="btn" disabled={anyUploading} onClick={deselectAll}>
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
                disabled={anyUploading}
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
                disabled={anyUploading}
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
              <label className="switch"><input type="checkbox" disabled={anyUploading} checked={platform.on}
                onChange={e => platform.set(e.target.checked)} aria-labelledby={`${platform.id}-label`} /><span className="slider" /></label>
            </div>)}
          {(facebookOn || instagramOn) && <p className="hint">Selected Meta destinations publish Reels to the accounts shown above. Use a vertical MP4 or MOV. The title becomes the caption.</p>}
          {tiktokOn && (
            <p className="hint" role="note">
              TikTok note: this app is not reviewed by TikTok, so each video publishes privately
              and your TikTok account must be private when it goes out. Afterwards, switch your
              account to public and set each video to Everyone in the TikTok app.
            </p>
          )}
          {instagramOn && !auth?.instagram.connected && (
            <p className="hint" role="note">
              New to Instagram here? Create a professional (Business or Creator) Instagram account
              linked to a Facebook Page, then press Connect above.
            </p>
          )}
          <h3 className="subhead">Videos</h3>
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
            <strong>Drop videos here</strong>
            <p>or click to browse — one or more at a time</p>
            <input
              ref={fileInput}
              id="file-input"
              type="file"
              accept="video/*"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          <p className="file-hint">Up to 5 GB each; up to 1 GB and MP4/MOV when Facebook or Instagram is selected. Each platform also checks its video requirements.</p>
          <p className="hint" role="note">
            VidPush is built for short clips. Files over 500 MB (or long videos) may not finish
            if the idle server scales down — upload those only if you can retry.
          </p>

          {items.length > 0 && (
            <div className="queue">
              {items.map(item => {
                const job = item.jobId ? jobs[item.jobId] : undefined;
                const states = job
                  ? ([["YouTube", job.youtube], ["TikTok", job.tiktok], ["Facebook", job.facebook], ["Instagram", job.instagram]] as [string, PlatformState][])
                      .filter(([, p]) => p.status !== "idle")
                  : [];
                const locked = item.status === "uploading";
                return (
                  <div className="queue-item" key={item.key}>
                    <Thumb file={item.file} />
                    <div className="queue-main">
                      <div className="queue-head">
                        <strong className="queue-name">{item.file.name}</strong>
                        <span className="hint">{formatSize(item.file.size)}</span>
                      </div>
                      <div className="field">
                        <label htmlFor={`title-${item.key}`}>Title / caption</label>
                        <input
                          id={`title-${item.key}`}
                          disabled={locked}
                          value={item.title}
                          onChange={(e) => patchItem(item.key, { title: e.target.value })}
                          placeholder="Defaults to file name"
                          autoComplete="off"
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`sched-${item.key}`}>
                          Publish at — 24-hour time (HH:MM, e.g. 18:30 = 6:30 PM), your local time. Empty means now.
                        </label>
                        <input
                          id={`sched-${item.key}`}
                          type="datetime-local"
                          disabled={locked}
                          value={item.scheduleLocal}
                          onChange={(e) => patchItem(item.key, { scheduleLocal: e.target.value })}
                        />
                        <div className="preset-row" role="group" aria-label="Quick schedule times for tomorrow">
                          <span className="hint">Tomorrow:</span>
                          {SCHEDULE_PRESETS.map(preset => (
                            <button
                              key={preset.label}
                              type="button"
                              className="btn preset"
                              disabled={locked}
                              onClick={() => patchItem(item.key, { scheduleLocal: preset.apply() })}
                            >
                              {preset.label}
                            </button>
                          ))}
                          <button
                            type="button"
                            className="btn preset"
                            disabled={locked}
                            onClick={() => patchItem(item.key, {
                              scheduleLocal: dateToLocalInput(new Date(Date.now() + 60 * 60 * 1000)),
                            })}
                          >
                            +1h
                          </button>
                          {item.scheduleLocal.trim() && (
                            <button
                              type="button"
                              className="btn ghost preset"
                              disabled={locked}
                              onClick={() => patchItem(item.key, { scheduleLocal: "" })}
                            >
                              Now
                            </button>
                          )}
                        </div>
                        <p className="hint" role="status">
                          {(() => {
                            const ms = localInputToUtcMs(item.scheduleLocal);
                            if (!item.scheduleLocal.trim()) return "Publishes immediately.";
                            if (ms === null) return "That time is not valid yet — keep typing.";
                            return `Goes out ${formatLocalPreview(ms)}.`;
                          })()}
                        </p>
                      </div>
                      <ThumbnailPicker
                        file={item.file}
                        disabled={locked}
                        onThumbnail={(thumb) => patchItem(item.key, { thumbnail: thumb })}
                      />
                      {item.status === "uploading" && (
                        <div className="progress" role="progressbar" aria-valuenow={item.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`Upload progress for ${item.file.name}`}>
                          <div className="progress-track">
                            <div className="progress-bar" style={{ width: `${item.progress}%` }} />
                          </div>
                          <span className="hint">{item.progress}%</span>
                        </div>
                      )}
                      {item.note && <p className="hint">{item.note}</p>}
                      {item.error && <div className="banner error" role="alert">{item.error}</div>}
                      {item.status !== "uploading" && (() => {
                        const warn = longUploadWarning(item.file);
                        return warn ? <p className="hint" role="note">{warn}</p> : null;
                      })()}
                      {states.length > 0 && (
                        <div className="progress-block">
                          {states.map(([name, p]) => (
                            <div className="platform-status" key={name}>
                              <strong>{name}</strong>
                              <span className={`status-line ${p.status === "error" ? "err" : ""}`}>{formatPlatformStatus(p)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="row-actions">
                        {(item.status === "queued" || item.status === "error") && (
                          <button type="button" className="btn primary" onClick={() => void startItem(item.key)}>
                            {item.status === "error" ? "Retry" : item.scheduleLocal.trim() ? "Schedule" : "Upload"}
                          </button>
                        )}
                        {!locked && (
                          <button type="button" className="btn ghost" onClick={() => removeItem(item.key)}>
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="upload-actions">
            <button
              type="button"
              className="btn primary"
              disabled={!items.some(i => i.status === "queued" || i.status === "error")}
              onClick={startAll}
            >
              {anyUploading ? "Uploading…" : "Start all"}
            </button>
            {items.some(i => i.status === "done" || i.status === "error") && (
              <button type="button" className="btn ghost" disabled={anyUploading} onClick={clearDone}>
                Clear finished
              </button>
            )}
          </div>
        </section>
      </div>

      <section className="card scheduled-card">
        <h2>Scheduled</h2>
        <p className="hint">
          YouTube and Facebook schedule directly on the platform at upload time. TikTok and
          Instagram videos are held here by VidPush and publish at their time — the server must
          be running when the time arrives.
        </p>
        {scheduledErr && <div className="banner error" role="alert">{scheduledErr}</div>}
        {scheduled.length === 0 ? (
          <p className="hint">Nothing scheduled yet. Pick a publish time on a video above.</p>
        ) : (
          <div className="scheduled-list">
            {scheduled.map(row => (
              <ScheduledRow key={row.id} row={row} onChanged={() => void refreshScheduled()} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const DEST_LABELS: [keyof ScheduledItem["destinations"], string][] = [
  ["youtube", "YouTube"],
  ["tiktok", "TikTok"],
  ["facebook", "Facebook"],
  ["instagram", "Instagram"],
];

function ScheduledRow({ row, onChanged }: { row: ScheduledItem; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(utcMsToLocalInput(new Date(row.publishAt).getTime()));
  const [title, setTitle] = useState(row.title);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const destNames = DEST_LABELS.filter(([k]) => row.destinations[k]).map(([, label]) => label);

  const onSave = async () => {
    const ms = localInputToUtcMs(value);
    if (ms === null) {
      setErr("Schedule time is not a valid date and time.");
      return;
    }
    if (!title.trim()) {
      setErr("Title cannot be empty.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await updateScheduled(row.id, { publishAt: new Date(ms).toISOString(), title: title.trim() });
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not update the scheduled video");
    } finally {
      setBusy(false);
    }
  };

  const onCancel = async () => {
    const prompt = row.status === "scheduled"
      ? `Cancel the scheduled publish of ${row.originalName}?`
      : `Remove this ${row.status} upload of ${row.originalName} from the list?`;
    if (!window.confirm(prompt)) return;
    setBusy(true);
    setErr(null);
    try {
      await cancelScheduled(row.id);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not remove the scheduled video");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scheduled-row">
      <div className="scheduled-meta">
        <strong className="queue-name">{row.title || row.originalName}</strong>
        <span className="hint">{formatSize(row.size)}</span>
        <span className="dest-badges" aria-label={`Posts to ${destNames.join(", ") || "no destinations"}`}>
          {destNames.length > 0 ? destNames.map(label => (
            <span className="pill on" key={label}>{label}</span>
          )) : <span className="hint">No destinations</span>}
        </span>
        <span className="hint">Publishes {formatLocal(row.publishAt)} (your local time)</span>
        <span className={`pill ${row.status === "scheduled" ? "on" : "off"}`}>{row.status}</span>
        {row.error && <div className="banner error" role="alert">{row.error}</div>}
        {row.destinations.tiktok && row.status === "scheduled" && (
          <p className="hint" role="note">
            TikTok publishes privately (unreviewed app — your account must be private at publish
            time). Afterwards, switch your account to public and set the video to Everyone in the
            TikTok app.
          </p>
        )}
        {editing && (
          <>
            <div className="field">
              <label htmlFor={`edit-title-${row.id}`}>Title / caption</label>
              <input
                id={`edit-title-${row.id}`}
                type="text"
                disabled={busy}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Video title"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label htmlFor={`edit-${row.id}`}>New publish time — 24-hour time (HH:MM), your local time</label>
              <input
                id={`edit-${row.id}`}
                type="datetime-local"
                disabled={busy}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <p className="hint" role="status">
                {(() => {
                  const ms = localInputToUtcMs(value);
                  if (ms === null) return "That time is not valid yet — keep typing.";
                  return `New time: ${formatLocalPreview(ms)}.`;
                })()}
              </p>
            </div>
          </>
        )}
        {err && <div className="banner error" role="alert">{err}</div>}
      </div>
      {(row.status === "scheduled" || row.status === "error" || row.status === "done" || row.status === "cancelled") && (
        <div className="row-actions">
          {row.status !== "scheduled" ? (
            <button type="button" className="btn ghost danger" disabled={busy} onClick={() => void onCancel()}>
              Remove
            </button>
          ) : editing ? (
            <>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void onSave()}>
                Save
              </button>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => { setEditing(false); setErr(null); }}>
                Back
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => { setEditing(true); setErr(null); }}>
                Edit
              </button>
              <button type="button" className="btn ghost danger" disabled={busy} onClick={() => void onCancel()}>
                Cancel
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
