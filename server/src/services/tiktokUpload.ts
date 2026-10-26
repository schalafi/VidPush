import fs from "fs";
import { getValidTikTokAccessToken } from "./tiktokTokens.js";

const INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const CREATOR_INFO_URL = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

const CHUNK_SIZE = 10 * 1024 * 1024;

type ByteRange = { start: number; end: number };

/**
 * TikTok FILE_UPLOAD chunk plan per media transfer guide:
 * - total_chunk_count = floor(video_size / chunk_size), minimum 1.
 * - Each chunk must be at least 5 MB and no more than 64 MB, except the
 *   final chunk, which absorbs the trailing bytes and may exceed chunk_size
 *   (up to 128 MB). So a 14.89 MB file with 10 MB chunks is ONE chunk, and
 *   a 50,000,123-byte file with 10,000,000-byte chunks is 5 chunks with the
 *   last carrying 10,000,123 bytes.
 * - A lone chunk must declare chunk_size equal to the whole file (the same
 *   rule as the documented < 5 MB whole upload): TikTok rejects init with
 *   "The chunk size is invalid" when one chunk declares 10 MB but carries
 *   e.g. 14.89 MB. Multi-chunk plans keep chunk_size at 10 MB with the
 *   trailing bytes merged into the final chunk.
 * - Splitting with ceil would send an invalid total_chunk_count and a small
 *   (< 5 MB) tail chunk that TikTok rejects at init.
 */
export function planTiktokChunks(videoSize: number): {
  chunkSize: number;
  totalChunkCount: number;
  ranges: ByteRange[];
} {
  if (videoSize <= 0) {
    throw new Error("Video file is empty");
  }

  const totalChunkCount = Math.max(1, Math.floor(videoSize / CHUNK_SIZE));
  // Single-chunk uploads declare the full file size; multi-chunk uploads
  // declare the fixed chunk size and merge the tail into the final chunk.
  const chunkSize = totalChunkCount === 1 ? videoSize : CHUNK_SIZE;
  const ranges: ByteRange[] = [];

  for (let i = 0; i < totalChunkCount; i++) {
    const start = i * chunkSize;
    const end = i === totalChunkCount - 1 ? videoSize - 1 : start + chunkSize - 1;
    ranges.push({ start, end });
  }

  return { chunkSize, totalChunkCount, ranges };
}

function readFileRange(filePath: string, start: number, end: number): Buffer {
  const length = end - start + 1;
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

type InitResponse = {
  data?: {
    publish_id?: string;
    upload_url?: string;
  };
  error?: { code?: string; message?: string; log_id?: string };
};

type CreatorInfo = {
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec?: number;
};

type TikTokApiError = { code?: string; message?: string; log_id?: string };

function formatTikTokError(prefix: string, err?: TikTokApiError): string {
  const code = err?.code;
  if (code === "unaudited_client_can_only_post_to_private_accounts") {
    return (
      `${prefix}: Unaudited/sandbox apps can only direct-post when your TikTok account is set to ` +
      `Private in the TikTok app (Settings → Privacy). Use privacy SELF_ONLY, then retry. ` +
      `See https://developers.tiktok.com/doc/content-sharing-guidelines`
    );
  }
  if (code === "privacy_level_option_mismatch") {
    return (
      `${prefix}: privacy_level is not allowed for this account. Reconnect TikTok after setting ` +
      `the account to Private, or choose a level returned by creator_info/query.`
    );
  }
  const detail = err?.message ?? code ?? "unknown error";
  return code ? `${prefix} (${code}): ${detail}` : `${prefix}: ${detail}`;
}

function assertTikTokOk(res: Response, json: { error?: TikTokApiError }, prefix: string): void {
  if (!res.ok) {
    throw new Error(formatTikTokError(prefix, json.error));
  }
  if (json.error?.code && json.error.code !== "ok") {
    throw new Error(formatTikTokError(prefix, json.error));
  }
}

export async function fetchCreatorInfo(accessToken: string): Promise<CreatorInfo> {
  const res = await fetch(CREATOR_INFO_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
  });
  const json = (await res.json()) as {
    data?: CreatorInfo;
    error?: TikTokApiError;
  };
  assertTikTokOk(res, json, "TikTok creator_info failed");
  if (!json.data?.privacy_level_options?.length) {
    throw new Error("TikTok creator_info returned no privacy_level_options");
  }
  return json.data;
}

/** Prefer SELF_ONLY for unaudited/sandbox direct post; must be in creator's allowed list. */
export function pickPrivacyLevel(options: string[]): string {
  if (options.includes("SELF_ONLY")) return "SELF_ONLY";
  throw new Error(
    "TikTok direct post requires SELF_ONLY for sandbox/unaudited apps. Set your TikTok account to " +
      `Private in the TikTok app, then reconnect. Allowed now: ${options.join(", ")}`
  );
}

export async function uploadToTiktok(
  userId: string,
  filePath: string,
  title: string
): Promise<{ publishId: string }> {
  const { accessToken } = await getValidTikTokAccessToken(userId);
  const videoSize = fs.statSync(filePath).size;
  const { chunkSize, totalChunkCount, ranges } = planTiktokChunks(videoSize);

  const creator = await fetchCreatorInfo(accessToken);
  const privacyLevel = pickPrivacyLevel(creator.privacy_level_options);

  const initBody = {
    post_info: {
      title: title.slice(0, 150),
      privacy_level: privacyLevel,
      disable_duet: creator.duet_disabled,
      disable_comment: creator.comment_disabled,
      disable_stitch: creator.stitch_disabled,
      video_cover_timestamp_ms: 1000,
    },
    source_info: {
      source: "FILE_UPLOAD",
      video_size: videoSize,
      chunk_size: chunkSize,
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
  assertTikTokOk(initRes, initJson, "TikTok init failed");
  const publishId = initJson.data?.publish_id;
  const uploadUrl = initJson.data?.upload_url;
  if (!publishId || !uploadUrl) {
    throw new Error(`TikTok init failed: ${JSON.stringify(initJson)}`);
  }

  for (const { start, end } of ranges) {
    const chunk = readFileRange(filePath, start, end);

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
