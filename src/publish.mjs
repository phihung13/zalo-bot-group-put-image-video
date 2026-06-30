// src/publish.mjs — đăng 1 draft đã duyệt lên Facebook + GBP + comment đầu (nếu có).
import { postToPage } from "./facebook.mjs";
import { postToGBP } from "./gbp.mjs";

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

/** Đăng phần Facebook của một draft đã duyệt. */
export async function publishFacebookDraft(draft, route, o = {}) {
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

/** Đăng phần Google Business Profile của một draft đã duyệt. */
export async function publishGbpDraft(draft, route, o = {}) {
  const log = o.log || (() => {});
  if (!route.gbpLocationId) throw new Error("Route chưa có Google Business Profile Location ID");
  await postToGBP({
    locationId: route.gbpLocationId,
    text: (draft.caption || "").slice(0, 1500),
    imagePaths: draft.savedImages || [],
    log,
  });
  return { ok: true, links: [] };
}

/**
 * Đăng draft lên page của route, giữ tương thích cho chế độ tự đăng cũ:
 * Facebook chạy chính, GBP chạy nền nếu route có gbpLocationId.
 */
export async function publishDraft(draft, route, o = {}) {
  const log = o.log || (() => {});
  const res = await publishFacebookDraft(draft, route, o);
  // Đăng GBP song song (nếu route có gbpLocationId + session đã lưu)
  if (route.gbpLocationId) {
    publishGbpDraft(draft, route, { log })
      .then(() => log("✅ GBP: đăng xong"))
      .catch((e) => log("⚠️ GBP lỗi (FB vẫn thành công): " + e.message));
  }
  return res;
}
