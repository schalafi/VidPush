import { Router } from "express";
import fs from "fs";
import multer from "multer";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import { createJob, getJob, pruneJobs, updatePlatform } from "../jobs.js";
import { isYoutubeConnected } from "../services/googleTokens.js";
import { isTiktokConnected } from "../services/tiktokTokens.js";
import { uploadToYoutube } from "../services/youtubeUpload.js";
import {
  uploadToTiktok,
  waitForTiktokPublish,
} from "../services/tiktokUpload.js";
import { getValidTikTokAccessToken } from "../services/tiktokTokens.js";

import { metaConnection } from "../services/metaTokens.js";
import { uploadToMeta } from "../services/metaUpload.js";

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

router.post("/", upload.single("video"), (req, res) => {
  const userId = defaultUserId();
  if (!req.file?.path) {
    res.status(400).json({ error: "Missing video file (field name: video)" });
    return;
  }

  const wantYoutube = parseBool(req.body.youtube);
  const wantTiktok = parseBool(req.body.tiktok);
  const wantFacebook = parseBool(req.body.facebook);
  const wantInstagram = parseBool(req.body.instagram);
  const titleRaw = typeof req.body.title === "string" ? req.body.title.trim() : "";
  const baseTitle =
    titleRaw ||
    path.basename(req.file.originalname, path.extname(req.file.originalname)) ||
    "VidPush upload";
  const description =
    typeof req.body.description === "string" ? req.body.description : "";

  if (!wantYoutube && !wantTiktok && !wantFacebook && !wantInstagram) {
    fs.unlink(req.file.path, () => {});
    res.status(400).json({ error: "Select at least one destination" });
    return;
  }

  if (wantYoutube && !isYoutubeConnected(userId)) {
    fs.unlink(req.file.path, () => {});
    res.status(400).json({ error: "Connect YouTube first" });
    return;
  }

  if (wantTiktok && !isTiktokConnected(userId)) {
    fs.unlink(req.file.path, () => {});
    res.status(400).json({ error: "Connect TikTok first" });
    return;
  }

  for (const platform of ["facebook", "instagram"] as const) {
    if ((platform === "facebook" ? wantFacebook : wantInstagram) && !metaConnection(userId, platform).connected) {
      fs.unlink(req.file.path, () => {});
      res.status(400).json({ error: `Connect ${platform} first` }); return;
    }
  }
  if ((wantFacebook || wantInstagram) && (req.file.size > 1024 * 1024 * 1024 || !/\.(mp4|mov)$/i.test(req.file.originalname))) {
    fs.unlink(req.file.path, () => {});
    res.status(400).json({ error: "Facebook/Instagram uploads require an MP4 or MOV file up to 1 GB." }); return;
  }
  if (wantInstagram && baseTitle.length > 2200) {
    fs.unlink(req.file.path, () => {});
    res.status(400).json({ error: "Instagram captions must be at most 2,200 characters." }); return;
  }
  const jobId = uuidv4();
  createJob(jobId, wantYoutube, wantTiktok, wantFacebook, wantInstagram);
  pruneJobs();

  const filePath = req.file.path;

  void runUploadJob({
    jobId,
    userId,
    filePath,
    wantYoutube,
    wantTiktok,
    wantFacebook,
    wantInstagram,
    title: baseTitle,
    description,
  });

  res.json({ jobId });
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

async function runUploadJob(args: {
  jobId: string;
  userId: string;
  filePath: string;
  wantYoutube: boolean;
  wantTiktok: boolean;
  wantFacebook: boolean;
  wantInstagram: boolean;
  title: string;
  description: string;
}): Promise<void> {
  const { jobId, userId, filePath, wantYoutube, wantTiktok, wantFacebook, wantInstagram, title, description } = args;

  const tasks: Promise<void>[] = [];

  if (wantYoutube) {
    tasks.push(
      (async () => {
        updatePlatform(jobId, "youtube", { status: "uploading" });
        try {
          const videoId = await uploadToYoutube(userId, filePath, title, description);
          updatePlatform(jobId, "youtube", { status: "done", videoId });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          updatePlatform(jobId, "youtube", { status: "error", error: msg });
        }
      })()
    );
  }

  if (wantTiktok) {
    tasks.push(
      (async () => {
        updatePlatform(jobId, "tiktok", { status: "uploading" });
        try {
          const { publishId } = await uploadToTiktok(userId, filePath, title);
          const { accessToken } = await getValidTikTokAccessToken(userId);
          await waitForTiktokPublish(accessToken, publishId);
          updatePlatform(jobId, "tiktok", { status: "done", publishId });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          updatePlatform(jobId, "tiktok", { status: "error", error: msg });
        }
      })()
    );
  }

  for (const platform of ["facebook", "instagram"] as const) {
    if (!(platform === "facebook" ? wantFacebook : wantInstagram)) continue;
    tasks.push((async () => {
      updatePlatform(jobId, platform, { status: "uploading" });
      try {
        const videoId = await uploadToMeta(platform, userId, filePath, title);
        updatePlatform(jobId, platform, { status: "done", videoId });
      } catch (error) {
        updatePlatform(jobId, platform, { status: "error", error: error instanceof Error ? error.message : "Upload failed" });
      }
    })());
  }
  await Promise.allSettled(tasks);

  fs.unlink(filePath, () => {});
}
