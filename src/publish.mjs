// src/publish.mjs — đăng 1 draft đã duyệt lên Facebook + comment đầu (nếu có).
import { postToPage } from "./facebook.mjs";

const V = process.env.FB_GRAPH_VERSION || "v21.0";

/** Thêm comment vào 1 bài (chỉ chạy được trên bài ĐÃ công khai). */
export async function addComment(objectId, token, message) {
  const body = new URLSearchParams();
  body.set("message", message);
  body.set("access_token", token);
  const r = await (await fetch(`https://graph.facebook.com/${V}/${objectId}/comments`, { method: "POST", body })).json();
  if (r.error) throw new Error(r.error.message);
  return r.id;
}

/**
 * Đăng draft lên page của route.
 * @param {object} draft  { caption, savedImages, imageCaptions, savedVideos, videoCaptions }
 * @param {object} route  { fanpageId, fanpageToken }
 * @param {object} o      { published, comment, log }
 * @returns {Promise<{links:string[]}>}
 */
export async function publishDraft(draft, route, o = {}) {
  const log = o.log || (() => {});
  const published = o.published !== false; // duyệt xong mặc định đăng công khai
  const res = await postToPage({
    pageId: route.fanpageId, token: route.fanpageToken,
    caption: draft.caption,
    imagePaths: draft.savedImages || [], imageCaptions: draft.imageCaptions || [],
    videoPaths: draft.savedVideos || [], videoCaptions: draft.videoCaptions || [],
    published, log,
  });
  // Comment đầu chỉ áp khi bài đã công khai
  if (published && o.comment && res.links && res.links.length) {
    const postId = res.links[0].split("/").pop();
    try { await addComment(postId, route.fanpageToken, o.comment); log("đã thêm comment đầu"); }
    catch (e) { log("comment lỗi: " + e.message); }
  }
  return res;
}
