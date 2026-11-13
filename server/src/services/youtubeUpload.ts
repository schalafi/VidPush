import fs from "fs";
import path from "path";
import { getYoutubeAuthorizedClient } from "./googleTokens.js";

type ThumbnailClient = {
  thumbnails: {
    set: (args: {
      videoId: string;
      media: { mimeType: string; body: unknown };
    }) => Promise<unknown>;
  };
};

type YoutubeClient = ThumbnailClient & {
  videos: {
    insert: (args: {
      part: string[];
      requestBody: {
        snippet: { title: string; description: string; categoryId: string };
        status: {
          privacyStatus: string;
          publishAt?: string;
          selfDeclaredMadeForKids: boolean;
        };
      };
      media: { body: unknown };
    }) => Promise<{ data: { id?: string | null } }>;
  };
};

const THUMBNAIL_ATTEMPTS = 4;
const THUMBNAIL_RETRY_BASE_MS = 2000;

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Content type for the thumbnail upload, from the file extension. YouTube
 * expects an image type; without one the request defaults to
 * application/octet-stream and the thumbnail is rejected. */
export function youtubeThumbnailMimeType(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
    default:
      return "image/jpeg";
  }
}

/**
 * Best-effort thumbnail apply with retries. The set call lands immediately
 * after videos.insert, when YouTube may not have the video ready yet, so a
 * single attempt can fail while a later one succeeds. Never throws: a
 * thumbnail failure must not fail the already-live upload.
 */
export async function setYoutubeThumbnail(
  youtube: ThumbnailClient,
  videoId: string,
  thumbnailPath: string,
  wait: (ms: number) => Promise<void> = sleep
): Promise<boolean> {
  const mimeType = youtubeThumbnailMimeType(thumbnailPath);
  for (let attempt = 1; attempt <= THUMBNAIL_ATTEMPTS; attempt++) {
    try {
      await youtube.thumbnails.set({
        videoId,
        media: { mimeType, body: fs.createReadStream(thumbnailPath) },
      });
      return true;
    } catch (e) {
      if (attempt === THUMBNAIL_ATTEMPTS) {
        console.warn(
          `YouTube thumbnail for ${videoId} was not applied:`,
          e instanceof Error ? e.message : e
        );
        return false;
      }
      await wait(THUMBNAIL_RETRY_BASE_MS * attempt);
    }
  }
  return false;
}

export async function uploadToYoutube(
  userId: string,
  filePath: string,
  title: string,
  description: string,
  publishAtMs?: number,
  thumbnailPath?: string,
  client?: YoutubeClient
): Promise<string> {
  const youtube: YoutubeClient = client ?? (await getYoutubeAuthorizedClient(userId));
  const stream = fs.createReadStream(filePath);

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: title.slice(0, 100),
        description: description.slice(0, 5000),
        categoryId: "22",
      },
      // Native scheduling: a private video with publishAt goes public automatically.
      // Without a schedule time the video goes out public immediately.
      status: publishAtMs
        ? {
            privacyStatus: "private",
            publishAt: new Date(publishAtMs).toISOString(),
            selfDeclaredMadeForKids: false,
          }
        : {
            privacyStatus: "public",
            selfDeclaredMadeForKids: false,
          },
    },
    media: {
      body: stream,
    },
  });

  const id = res.data.id;
  if (!id) throw new Error("YouTube upload succeeded but no video id returned");
  if (thumbnailPath) {
    // Best effort: the video is already live, so a thumbnail failure must
    // not fail the upload.
    await setYoutubeThumbnail(youtube, id, thumbnailPath);
  }
  return id;
}
