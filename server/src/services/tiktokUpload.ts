import fs from "fs";
import { getValidTikTokAccessToken } from "./tiktokTokens.js";

const INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

const CHUNK_SIZE = 10 * 1024 * 1024;

type InitResponse = {
  data?: {
    publish_id?: string;
    upload_url?: string;
  };
  error?: { code?: string; message?: string; log_id?: string };
};

async function readFileChunks(filePath: string, chunkSize: number): Promise<Buffer[]> {
  const buf = fs.readFileSync(filePath);
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += chunkSize) {
    chunks.push(buf.subarray(i, Math.min(i + chunkSize, buf.length)));
  }
  return chunks;
}

export async function uploadToTiktok(
  userId: string,
  filePath: string,
  title: string
): Promise<{ publishId: string }> {
  const { accessToken } = await getValidTikTokAccessToken(userId);
  const videoSize = fs.statSync(filePath).size;
  const chunks = await readFileChunks(filePath, CHUNK_SIZE);
  const totalChunkCount = chunks.length;

  const declaredChunkSize = totalChunkCount === 1 ? videoSize : CHUNK_SIZE;
  const initBody = {
    post_info: {
      title: title.slice(0, 150),
      privacy_level: "SELF_ONLY",
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
      video_cover_timestamp_ms: 1000,
    },
    source_info: {
      source: "FILE_UPLOAD",
      video_size: videoSize,
      chunk_size: declaredChunkSize,
      total_chunk_count: totalChunkCount,
    },
  };

  const initRes = await fetch(INIT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(initBody),
  });

  const initJson = (await initRes.json()) as InitResponse;
  if (!initRes.ok) {
    const msg = initJson.error?.message ?? JSON.stringify(initJson);
    throw new Error(`TikTok init failed: ${msg}`);
  }
  if (initJson.error?.code && initJson.error.code !== "ok") {
    throw new Error(initJson.error.message ?? initJson.error.code);
  }
  const publishId = initJson.data?.publish_id;
  const uploadUrl = initJson.data?.upload_url;
  if (!publishId || !uploadUrl) {
    throw new Error(`TikTok init failed: ${JSON.stringify(initJson)}`);
  }

  let byteOffset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const start = byteOffset;
    const end = byteOffset + chunk.length - 1;
    byteOffset += chunk.length;

    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${start}-${end}/${videoSize}`,
      },
      body: chunk,
    });

    if (!putRes.ok) {
      const text = await putRes.text();
      throw new Error(`TikTok chunk upload failed: ${putRes.status} ${text}`);
    }
  }

  return { publishId };
}

const TERMINAL_OK = new Set(["PUBLISH_COMPLETE"]);
const TERMINAL_FAIL = new Set(["FAILED"]);

export async function waitForTiktokPublish(
  accessToken: string,
  publishId: string,
  opts?: { maxWaitMs?: number; intervalMs?: number }
): Promise<void> {
  const maxWaitMs = opts?.maxWaitMs ?? 5 * 60 * 1000;
  const intervalMs = opts?.intervalMs ?? 3000;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const s = await fetchTiktokPublishStatus(accessToken, publishId);
    const st = s.status ?? "";
    if (TERMINAL_OK.has(st)) return;
    if (TERMINAL_FAIL.has(st)) {
      throw new Error(s.fail_reason ?? `TikTok publish failed (${st})`);
    }
  }
  throw new Error("TikTok publish timed out waiting for status");
}

export async function fetchTiktokPublishStatus(
  accessToken: string,
  publishId: string
): Promise<{ status?: string; fail_reason?: string }> {
  const res = await fetch(STATUS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ publish_id: publishId }),
  });
  const json = (await res.json()) as {
    data?: { status?: string; fail_reason?: string };
    error?: { code?: string; message?: string };
  };
  if (!res.ok) {
    throw new Error(json.error?.message ?? `TikTok status ${res.status}`);
  }
  if (json.error?.code && json.error.code !== "ok") {
    throw new Error(json.error.message ?? json.error.code);
  }
  return json.data ?? {};
}
