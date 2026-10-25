import fs from "fs";
import { getYoutubeAuthorizedClient } from "./googleTokens.js";

export async function uploadToYoutube(
  userId: string,
  filePath: string,
  title: string,
  description: string,
  publishAtMs?: number,
  thumbnailPath?: string
): Promise<string> {
  const youtube = await getYoutubeAuthorizedClient(userId);
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
      status: publishAtMs
        ? {
            privacyStatus: "private",
            publishAt: new Date(publishAtMs).toISOString(),
            selfDeclaredMadeForKids: false,
          }
        : {
            privacyStatus: "unlisted",
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
    try {
      await youtube.thumbnails.set({
        videoId: id,
        media: { body: fs.createReadStream(thumbnailPath) },
      });
    } catch (e) {
      console.warn(`YouTube thumbnail for ${id} was not applied:`, e instanceof Error ? e.message : e);
    }
  }
  return id;
}
