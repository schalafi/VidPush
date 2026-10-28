import { useEffect } from "react";
import type { ScheduleDests } from "./schedule";

const DEST_META: { key: keyof ScheduleDests; label: string }[] = [
  { key: "youtube", label: "YouTube" },
  { key: "tiktok", label: "TikTok" },
  { key: "facebook", label: "Facebook Reels" },
  { key: "instagram", label: "Instagram Reels" },
];

type Props = {
  count: number;
  dests: ScheduleDests;
  connected: ScheduleDests;
  onChange: (dests: ScheduleDests) => void;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Confirms which connected destinations the pending upload(s) go to. */
export default function UploadConfirmDialog({ count, dests, connected, onChange, onConfirm, onCancel }: Props) {
  const selected = DEST_META.filter((m) => dests[m.key]).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm destinations"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{count === 1 ? "Upload 1 video to…" : `Upload ${count} videos to…`}</h3>
        <div className="dest-list">
          {DEST_META.map((m) => (
            <label key={m.key} className={connected[m.key] ? "dest-row" : "dest-row off"}>
              <input
                type="checkbox"
                checked={dests[m.key]}
                disabled={!connected[m.key]}
                onChange={(e) => onChange({ ...dests, [m.key]: e.target.checked })}
              />
              <span>{m.label}</span>
              {!connected[m.key] && <span className="hint">Not connected</span>}
            </label>
          ))}
        </div>
        {selected === 0 && (
          <p className="hint">Select at least one connected destination, or connect one first.</p>
        )}
        <div className="row-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={selected === 0}
            onClick={onConfirm}
          >
            {count === 1 ? "Start upload" : "Start uploads"}
          </button>
        </div>
      </div>
    </div>
  );
}
