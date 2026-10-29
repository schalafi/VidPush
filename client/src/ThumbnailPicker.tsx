import { useEffect, useId, useRef, useState } from "react";
import { friendlyCaptureError, validateThumbnailFile } from "./thumbnail";

/** Format seconds as M:SS for the scrubber readout. */
export function formatCaptureTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

type Props = {
  file: File;
  disabled?: boolean;
  onThumbnail: (thumb: File | null) => void;
};

/**
 * Thumbnail side panel: the current selection on top, then frame capture
 * and image upload as the two ways to set it. The thumbnail is applied to
 * YouTube and Instagram uploads; TikTok and Facebook pick their own frame.
 */
export default function ThumbnailPicker({ file, disabled, onThumbnail }: Props) {
  const scrubId = useId();
  const [url, setUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    setPreview(null);
    setPosition(0);
    setDuration(0);
    setErr(null);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // Revoke the previous preview URL when it is replaced.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const seekTo = (sec: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    const clamped = Math.min(Math.max(0, sec), v.duration);
    v.currentTime = clamped;
    setPosition(clamped);
  };

  /** Settle the video on the scrubbed frame so the capture matches the picker. */
  const settleSeek = (v: HTMLVideoElement, target: number) =>
    new Promise<void>((resolve) => {
      if (!Number.isFinite(v.duration) || Math.abs(v.currentTime - target) < 0.05) {
        resolve();
        return;
      }
      const done = () => {
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(done, 1500);
      v.addEventListener("seeked", done, { once: true });
      v.currentTime = Math.min(Math.max(0, target), v.duration);
    });

  const capture = async () => {
    const v = videoRef.current;
    // HAVE_METADATA (1) exposes dimensions but no frame data yet; drawing
    // needs HAVE_CURRENT_DATA (2), otherwise the canvas gets a blank frame.
    if (!v || !v.videoWidth || v.readyState < 2) {
      setErr("Wait for the video to load, then try again.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await settleSeek(v, position);
      const scale = Math.min(1, 1280 / v.videoWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(v.videoWidth * scale);
      canvas.height = Math.round(v.videoHeight * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("This browser could not read a video frame.");
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.85)
      );
      if (!blob) throw new Error("This browser could not read a video frame.");
      const thumb = new File([blob], `${file.name.replace(/\.[^.]+$/, "")}-thumb.jpg`, {
        type: "image/jpeg",
      });
      if (preview) URL.revokeObjectURL(preview);
      setPreview(URL.createObjectURL(thumb));
      onThumbnail(thumb);
    } catch (e) {
      setErr(friendlyCaptureError(e));
    } finally {
      setBusy(false);
    }
  };

  const useImageFile = (chosen: File | undefined) => {
    if (!chosen) return;
    const invalid = validateThumbnailFile(chosen);
    if (invalid) {
      setErr(invalid);
      return;
    }
    setErr(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(chosen));
    onThumbnail(chosen);
  };

  const clear = () => {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    onThumbnail(null);
  };

  return (
    <section className="thumb-side" aria-label="Video thumbnail">
      <h4 className="thumb-side-title">Thumbnail</h4>
      <p className="hint">Applies to YouTube and Instagram. TikTok and Facebook pick their own frame.</p>
      {preview ? (
        <img className="thumb-current" src={preview} alt="Selected video thumbnail" />
      ) : (
        <div className="thumb-placeholder">No custom thumbnail — each platform will pick one</div>
      )}
      {url && (
        <video
          ref={videoRef}
          className="thumb-side-video"
          src={url}
          preload="auto"
          muted
          playsInline
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration || 0);
            setPosition(e.currentTarget.currentTime || 0);
          }}
          onSeeked={(e) => setPosition(e.currentTarget.currentTime)}
          onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        />
      )}
      <div className="thumb-side-row">
        <label className="thumb-side-label" htmlFor={scrubId}>
          Frame at {formatCaptureTime(position)}
          {duration > 0 ? ` of ${formatCaptureTime(duration)}` : ""}
        </label>
        <input
          id={scrubId}
          type="range"
          min={0}
          max={duration > 0 ? duration : 0}
          step={0.1}
          value={Math.min(position, duration || 0)}
          disabled={disabled || busy || !(duration > 0)}
          onChange={(e) => seekTo(Number(e.target.value))}
          aria-label="Scrub video to choose a thumbnail frame"
        />
      </div>
      <div className="row-actions thumb-side-actions">
        <button
          type="button"
          className="btn"
          disabled={disabled || busy || !url}
          onClick={() => void capture()}
        >
          {busy ? "Capturing…" : preview ? "Re-capture" : "Capture frame"}
        </button>
        <label className={`btn ghost${disabled || busy ? " disabled" : ""}`}>
          Upload image
          <input
            type="file"
            accept="image/*"
            hidden
            disabled={disabled || busy}
            onChange={(e) => {
              useImageFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
        {preview && (
          <button type="button" className="btn ghost" disabled={disabled || busy} onClick={clear}>
            Remove
          </button>
        )}
      </div>
      {err && <div className="banner error" role="alert">{err}</div>}
    </section>
  );
}
