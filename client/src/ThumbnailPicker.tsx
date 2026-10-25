import { useEffect, useRef, useState } from "react";

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
 * Lets the user scrub through their own video file and capture one frame
 * as a JPEG thumbnail. The thumbnail is applied to YouTube uploads;
 * other platforms use their default frame.
 */
export default function ThumbnailPicker({ file, disabled, onThumbnail }: Props) {
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

  const capture = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) {
      setErr("Wait for the video to load, then try again.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
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
      setErr(e instanceof Error ? e.message : "Could not capture that frame.");
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    onThumbnail(null);
  };

  return (
    <div className="thumb-picker">
      {url && (
        <video
          ref={videoRef}
          className="thumb-picker-video"
          src={url}
          preload="metadata"
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
      <div className="thumb-picker-row">
        <label className="thumb-picker-label" htmlFor={`scrub-${file.name}`}>
          Frame at {formatCaptureTime(position)}
          {duration > 0 ? ` of ${formatCaptureTime(duration)}` : ""}
        </label>
        <input
          id={`scrub-${file.name}`}
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
      <div className="row-actions thumb-picker-actions">
        <button
          type="button"
          className="btn"
          disabled={disabled || busy || !url}
          onClick={() => void capture()}
        >
          {busy ? "Capturing…" : preview ? "Re-capture frame" : "Use current frame"}
        </button>
        {preview && (
          <button type="button" className="btn ghost" disabled={disabled || busy} onClick={clear}>
            Remove
          </button>
        )}
      </div>
      {err && <div className="banner error" role="alert">{err}</div>}
      {preview ? (
        <figure className="thumb-preview">
          <img src={preview} alt="Selected video thumbnail" />
          <figcaption className="hint">Thumbnail for YouTube. Other platforms use their default frame.</figcaption>
        </figure>
      ) : (
        <p className="hint">Optional. Scrub to a frame and capture it as the YouTube thumbnail.</p>
      )}
    </div>
  );
}
