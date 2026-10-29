import { Router } from "express";
import fs from "fs";
import multer from "multer";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import { createJob, getJob, pruneJobs, runUploadJob } from "../jobs.js";
import { createScheduled, dataDir } from "../db.js";
import { isYoutubeConnected } from "../services/googleTokens.js";
import { getValidTikTokAccessToken, isTiktokConnected } from "../services/tiktokTokens.js";
import { fetchCreatorInfo, pickPrivacyLevel } from "../services/tiktokUpload.js";

import { metaConnection } from "../services/metaTokens.js";
import { parsePublishAt, validatePublishAt } from "../schedulePolicy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, "..", "..", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${uuidv4()}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 },
});

const router = Router();

function defaultUserId(): string {
  return process.env.DEFAULT_USER_ID ?? "default";
}

function parseBool(v: unknown): boolean {
  if (v === true || v === "true" || v === "1") return true;
  return false;
}

export function scheduledDir(): string {
  const dir = path.join(dataDir(), "scheduled-uploads");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function validateThumbnail(file: { mimetype: string; size: number } | undefined): string | null {
  if (!file) return null;
  if (!file.mimetype.startsWith("image/")) return "Thumbnail must be an image file.";
  if (file.size > 2 * 1024 * 1024) return "Thumbnail must be up to 2 MB.";
  return null;
}

const videoUpload = upload.fields([
  { name: "video", maxCount: 1 },
  { name: "thumbnail", maxCount: 1 },
]);

router.post("/", videoUpload, async (req, res) => {
  const userId = defaultUserId();
  const files = req.files as { video?: Express.Multer.File[]; thumbnail?: Express.Multer.File[] } | undefined;
  const video = files?.video?.[0];
  const thumbnail = files?.thumbnail?.[0];
  if (!video?.path) {
    if (thumbnail?.path) fs.unlink(thumbnail.path, () => {});
    res.status(400).json({ error: "Missing video file (field name: video)" });
    return;
  }
  const reqFile = video;
  const cleanup = () => {
    fs.unlink(reqFile.path, () => {});
    if (thumbnail?.path) fs.unlink(thumbnail.path, () => {});
  };

  const wantYoutube = parseBool(req.body.youtube);
  const wantTiktok = parseBool(req.body.tiktok);
  const wantFacebook = parseBool(req.body.facebook);
  const wantInstagram = parseBool(req.body.instagram);
  const titleRaw = typeof req.body.title === "string" ? req.body.title.trim() : "";
  const baseTitle =
    titleRaw ||
    path.basename(reqFile.originalname, path.extname(reqFile.originalname)) ||
    "VidPush upload";
  const description =
    typeof req.body.description === "string" ? req.body.description : "";

  let publishAtMs: number | undefined;
  try {
    publishAtMs = parsePublishAt(req.body.publishAt);
  } catch (e) {
    cleanup();
    res.status(400).json({ error: e instanceof Error ? e.message : "Invalid schedule time" });
    return;
  }

  // TikTok and Instagram have no native scheduling: with a publish time they
  // are held server-side and dispatched later. YouTube/Facebook schedule
  // natively at upload time, so they always run immediately.
  const heldTiktok = wantTiktok && publishAtMs !== undefined;
  const heldInstagram = wantInstagram && publishAtMs !== undefined;
  const nowTiktok = wantTiktok && !heldTiktok;
  const nowInstagram = wantInstagram && !heldInstagram;

  if (!wantYoutube && !wantTiktok && !wantFacebook && !wantInstagram) {
    cleanup();
    res.status(400).json({ error: "Select at least one destination" });
    return;
  }

  if (publishAtMs !== undefined) {
    const err = validatePublishAt(publishAtMs, { facebook: wantFacebook, held: heldTiktok || heldInstagram });
    if (err) {
      cleanup();
      res.status(400).json({ error: err });
      return;
    }
  }

  if (wantYoutube && !isYoutubeConnected(userId)) {
    cleanup();
    res.status(400).json({ error: "Connect YouTube first" });
    return;
  }

  if (wantTiktok && !isTiktokConnected(userId)) {
    cleanup();
    res.status(400).json({ error: "Connect TikTok first" });
    return;
  }

  if (nowTiktok) {
    // Fail fast when the account cannot direct-post (not set to Private):
    // creator_info is the same gate the background job would hit minutes
    // later, so reject now with the actionable message instead. Scheduled
    // (held) uploads skip this — the account may be switched before go-time.
    try {
      const { accessToken } = await getValidTikTokAccessToken(userId);
      pickPrivacyLevel((await fetchCreatorInfo(accessToken)).privacy_level_options);
    } catch (e) {
      if (e instanceof Error && /SELF_ONLY|Private/i.test(e.message)) {
        cleanup();
        res.status(400).json({ error: e.message });
        return;
      }
      // Transient lookup failure: let the job try for real.
    }
  }

  for (const platform of ["facebook", "instagram"] as const) {
    if ((platform === "facebook" ? wantFacebook : wantInstagram) && !metaConnection(userId, platform).connected) {
      cleanup();
      res.status(400).json({ error: `Connect ${platform} first` }); return;
    }
  }
  if ((wantFacebook || wantInstagram) && (reqFile.size > 1024 * 1024 * 1024 || !/\.(mp4|mov)$/i.test(reqFile.originalname))) {
    cleanup();
    res.status(400).json({ error: "Facebook/Instagram uploads require an MP4 or MOV file up to 1 GB." }); return;
  }
  if (wantInstagram && baseTitle.length > 2200) {
    cleanup();
    res.status(400).json({ error: "Instagram captions must be at most 2,200 characters." }); return;
  }
  const thumbErr = validateThumbnail(thumbnail);
  if (thumbErr) {
    cleanup();
    res.status(400).json({ error: thumbErr }); return;
  }

  const scheduleIds: string[] = [];
  // Thumbnails apply to YouTube and Instagram (as the Reel cover). TikTok
  // and Facebook pick their own frame, so a thumbnail chosen for those
  // destinations alone is validated but then discarded.
  let storedThumbPath: string | null = null;
  if ((heldTiktok || heldInstagram) && publishAtMs !== undefined) {
    const id = uuidv4();
    const safe = reqFile.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const dest = path.join(scheduledDir(), `${id}-${safe}`);
    try {
      fs.copyFileSync(reqFile.path, dest);
      if (heldInstagram && thumbnail?.path) {
        const thumbSafe = thumbnail.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
        storedThumbPath = path.join(scheduledDir(), `${id}-thumb-${thumbSafe}`);
        fs.copyFileSync(thumbnail.path, storedThumbPath);
      }
    } catch {
      cleanup();
      if (storedThumbPath) fs.unlink(storedThumbPath, () => {});
      res.status(500).json({ error: "Could not store the video for scheduled publishing" });
      return;
    }
    createScheduled({
      id,
      user_id: userId,
      file_path: dest,
      original_name: reqFile.originalname,
      size: reqFile.size,
      title: baseTitle,
      description,
      destinations: JSON.stringify({ tiktok: heldTiktok, instagram: heldInstagram }),
      publish_at: publishAtMs,
      created_at: Date.now(),
      thumb_path: storedThumbPath,
    });
    scheduleIds.push(id);
  }

  if (!wantYoutube && !nowTiktok && !wantFacebook && !nowInstagram) {
    // Held-only: nothing to run now; the temp upload is just a copy source.
    cleanup();
    res.json({ scheduleIds });
    return;
  }

  const jobId = uuidv4();
  createJob(jobId, wantYoutube, nowTiktok, wantFacebook, nowInstagram);
  pruneJobs();

  const filePath = reqFile.path;
  // The temp thumbnail is consumed by runUploadJob when YouTube or an
  // immediate Instagram upload uses it; otherwise delete it here so unused
  // thumbnails do not accumulate in the upload directory.
  const thumbnailPath = wantYoutube || nowInstagram ? thumbnail?.path : undefined;
  if (thumbnail?.path && !thumbnailPath) fs.unlink(thumbnail.path, () => {});

  void runUploadJob({
    jobId,
    userId,
    filePath,
    thumbnailPath,
    wantYoutube,
    wantTiktok: nowTiktok,
    wantFacebook,
    wantInstagram: nowInstagram,
    title: baseTitle,
    description,
    publishAtMs,
  });

  res.json(scheduleIds.length ? { jobId, scheduleIds } : { jobId });
});

router.get("/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

export default router;
