import { graph, uploadMetaBinary, type MetaPlatform } from "./metaApi.js";
import { metaCredentials } from "./metaTokens.js";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// No automatic retry of publishing: a timed-out response can already have published.
export async function waitForInstagram(token: string, container: string, wait = pause): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = await graph<{ status_code: string }>("instagram", container, token, { fields: "status_code" });
    if (state.status_code === "FINISHED") return;
    if (["ERROR", "EXPIRED"].includes(state.status_code)) throw new Error(`Instagram could not process this video (${state.status_code}). Check the Reel format.`);
    await wait(5000);
  }
  throw new Error(`Instagram is still processing container ${container}. Check the account before retrying.`);
}
export async function waitForFacebook(token: string, video: string, wait = pause): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const { status } = await graph<{ status: { video_status: string; publishing_phase?: { status: string }; processing_phase?: { status: string }; uploading_phase?: { status: string } } }>(
      "facebook", video, token, { fields: "status" });
    if (status.video_status === "error" || [status.publishing_phase, status.processing_phase, status.uploading_phase].some(p => p?.status === "error")) {
      throw new Error(`Facebook could not process or publish video ${video}. Check its format and Page permissions.`);
    }
    if (status.publishing_phase?.status === "complete") return;
    await wait(5000);
  }
  throw new Error(`Facebook has not confirmed publication of video ${video}. Check the Page before retrying.`);
}
export async function uploadToMeta(platform: MetaPlatform, userId: string, filePath: string, caption: string): Promise<string> {
  const { token, id } = await metaCredentials(userId, platform);
  if (platform === "instagram") {
    const container = await graph<{ id: string; uri: string }>(platform, `${id}/media`, token,
      { media_type: "REELS", upload_type: "resumable", caption, share_to_feed: "true" }, "POST");
    if (!container.id || !container.uri) throw new Error("Instagram did not return an upload container");
    await uploadMetaBinary(container.uri, token, filePath);
    await waitForInstagram(token, container.id);
    const published = await graph<{ id: string }>(platform, `${id}/media_publish`, token, { creation_id: container.id }, "POST");
    if (!published.id) throw new Error(`Instagram did not confirm publication of ${container.id}. Check the account before retrying.`);
    return published.id;
  }
  const video = await graph<{ video_id: string; upload_url: string }>(platform, `${id}/video_reels`, token, { upload_phase: "start" }, "POST");
  if (!video.video_id || !video.upload_url) throw new Error("Facebook did not return an upload destination");
  await uploadMetaBinary(video.upload_url, token, filePath);
  const finished = await graph<{ success: boolean }>(platform, `${id}/video_reels`, token,
    { upload_phase: "finish", video_id: video.video_id, video_state: "PUBLISHED", description: caption }, "POST");
  if (!finished.success) throw new Error(`Facebook did not confirm publication of ${video.video_id}. Check the Page before retrying.`);
  await waitForFacebook(token, video.video_id);
  return video.video_id;
}
