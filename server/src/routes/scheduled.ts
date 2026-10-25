import { Router } from "express";
import fs from "fs";
import {
  deleteScheduled,
  getScheduled,
  listScheduled,
  setScheduledState,
  updateScheduledTime,
  type ScheduledRow,
} from "../db.js";
import { parsePublishAt, validatePublishAt } from "../schedulePolicy.js";

const router = Router();

function defaultUserId(): string {
  return process.env.DEFAULT_USER_ID ?? "default";
}

function shape(row: ScheduledRow) {
  return {
    id: row.id,
    originalName: row.original_name,
    size: row.size,
    title: row.title,
    destinations: JSON.parse(row.destinations) as {
      youtube?: boolean;
      tiktok?: boolean;
      facebook?: boolean;
      instagram?: boolean;
    },
    publishAt: new Date(row.publish_at).toISOString(),
    status: row.status,
    jobId: row.job_id,
    error: row.error,
    createdAt: row.created_at,
  };
}

function owned(row: ScheduledRow | undefined, userId: string): row is ScheduledRow {
  return !!row && row.user_id === userId;
}

router.get("/", (req, res) => {
  const userId = defaultUserId();
  res.json({ items: listScheduled(userId).map(shape) });
});

router.patch("/:id", (req, res) => {
  const userId = defaultUserId();
  const row = getScheduled(req.params.id);
  if (!owned(row, userId)) {
    res.status(404).json({ error: "Scheduled video not found" });
    return;
  }
  if (row.status !== "scheduled") {
    res.status(409).json({ error: `Only pending items can be edited (status: ${row.status})` });
    return;
  }
  let publishAtMs: number | undefined;
  try {
    publishAtMs = parsePublishAt(req.body.publishAt);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Invalid schedule time" });
    return;
  }
  if (publishAtMs === undefined) {
    res.status(400).json({ error: "Schedule time is required" });
    return;
  }
  const dests = JSON.parse(row.destinations) as { facebook?: boolean };
  const err = validatePublishAt(publishAtMs, { facebook: !!dests.facebook, held: true });
  if (err) {
    res.status(400).json({ error: err });
    return;
  }
  updateScheduledTime(row.id, publishAtMs);
  res.json(shape({ ...row, publish_at: publishAtMs }));
});

router.delete("/:id", (req, res) => {
  const userId = defaultUserId();
  const row = getScheduled(req.params.id);
  if (!owned(row, userId)) {
    res.status(404).json({ error: "Scheduled video not found" });
    return;
  }
  if (row.status === "error") {
    // Failed uploads are terminal and their file is already consumed by the
    // dispatch, so remove the row outright to clear it from the list.
    deleteScheduled(row.id);
    fs.unlink(row.file_path, () => {});
    res.json({ ok: true });
    return;
  }
  if (row.status !== "scheduled") {
    res.status(409).json({ error: `Only pending or failed items can be removed (status: ${row.status})` });
    return;
  }
  setScheduledState(row.id, "cancelled");
  fs.unlink(row.file_path, () => {});
  res.json({ ok: true });
});

export default router;
