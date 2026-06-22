import fs from "fs";
import { getYoutubeAuthorizedClient } from "./googleTokens.js";

export async function uploadToYoutube(
  userId: string,
  filePath: string,
  title: string,
  description: string
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
      status: {
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
  return id;
}
