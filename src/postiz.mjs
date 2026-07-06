// ============================================================================
//  CẦU NỐI Zalo → Postiz (Việt Anh Media Hub)
// ----------------------------------------------------------------------------
//  Đẩy 1 bài (caption + ảnh/video đã lưu local) vào Postiz dưới dạng BẢN NHÁP
//  chờ duyệt, qua Public API. KHÔNG đụng pipeline FB/GBP đang chạy — bật/tắt
//  bằng env POSTIZ_ENABLED (cấu hình ngay trên dashboard: /postiz).
//
//  Luồng: upload từng file local -> POST /public/v1/upload (multipart) -> lấy
//  media {id,path} -> POST /public/v1/posts (type:draft) gắn media + caption.
//  Cấu hình: POSTIZ_ENABLED / POSTIZ_API_URL / POSTIZ_API_KEY / POSTIZ_INTEGRATION_ID
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

function apiUrl() {
  return (process.env.POSTIZ_API_URL || 'http://localhost:3000').replace(/\/$/, '');
}

// Lấy danh sách kênh đã kết nối trong Postiz (để chọn integration id).
export async function listIntegrations({ url, key } = {}) {
  const base = (url || apiUrl()).replace(/\/$/, '');
  const apiKey = key || process.env.POSTIZ_API_KEY;
  const res = await fetch(`${base}/public/v1/integrations`, {
    headers: { Authorization: apiKey || '' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`integrations ${res.status}: ${text.slice(0, 200)}`);
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    list = [];
  }
  return Array.isArray(list) ? list : list.integrations || [];
}

/**
 * Trang Facebook đã kết nối trong Media Hub (Add Channel) KÈM page token.
 * Bot dùng token này để đăng thẳng Facebook — user chỉ kết nối Trang MỘT lần
 * ở Media Hub, không phải dán user token riêng cho bot nữa.
 * Trả []: chưa có key / Hub chưa chạy / Hub bản cũ chưa có endpoint.
 */
export async function fetchHubFacebookPages() {
  const apiKey = process.env.POSTIZ_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch(`${apiUrl()}/public/v1/facebook-pages`, {
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const list = await res.json().catch(() => []);
    return Array.isArray(list) ? list.filter((p) => p && p.pageId && p.token) : [];
  } catch {
    return [];
  }
}

// Upload 1 file local vào Postiz, trả về media record {id, path}.
async function uploadLocalFile(base, apiKey, filePath) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(filePath));
  const res = await fetch(`${base}/public/v1/upload`, {
    method: 'POST',
    headers: { Authorization: apiKey }, // KHÔNG set content-type — để fetch tự set multipart boundary
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`upload ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// Đẩy 1 bài nháp vào Postiz.
//   caption       : nội dung bài
//   imagePaths    : mảng đường dẫn FILE ẢNH local (từ draft.savedImages)
//   videoPaths    : mảng đường dẫn FILE VIDEO local (từ draft.savedVideos)
//   imageCaptions : caption riêng TỪNG ảnh (cùng thứ tự imagePaths) → gắn vào alt
//   videoCaptions : caption riêng từng video (cùng thứ tự videoPaths)
//   groupName     : tên nhóm/route (để log)
//   integrationId : kênh Media Hub RIÊNG của nhóm (route.postizIntegrationId);
//                   bỏ trống = dùng kênh mặc định POSTIZ_INTEGRATION_ID
export async function pushToPostiz({
  caption = '',
  imagePaths = [],
  videoPaths = [],
  imageCaptions = [],
  videoCaptions = [],
  groupName = '',
  integrationId = '',
}) {
  if (process.env.POSTIZ_ENABLED !== 'true') return { skipped: 'disabled' };

  const apiKey = process.env.POSTIZ_API_KEY;
  const targetIntegration = integrationId || process.env.POSTIZ_INTEGRATION_ID;
  if (!apiKey || !targetIntegration) {
    return { skipped: 'missing-config' };
  }
  const base = apiUrl();

  // Upload media local -> lấy {id, path}; kèm alt = caption riêng từng ảnh/video
  // (Media Hub hiển thị/sửa alt khi bấm vào ảnh trong composer, và đăng kèm bài).
  const media = [];
  const files = [
    ...(imagePaths || []).map((f, i) => ({ f, alt: (imageCaptions || [])[i] || '' })),
    ...(videoPaths || []).map((f, i) => ({ f, alt: (videoCaptions || [])[i] || '' })),
  ];
  for (const { f, alt } of files) {
    try {
      const m = await uploadLocalFile(base, apiKey, f);
      media.push({ id: m.id, path: m.path, ...(alt ? { alt } : {}) });
    } catch (e) {
      console.warn(`[postiz] upload lỗi (${path.basename(f)}): ${e.message}`);
    }
  }

  const body = {
    type: 'draft', // vào hàng chờ duyệt trong Media Hub
    // +2h: bài "chờ duyệt" nằm ở tương lai gần → hiện trên calendar hôm nay
    // và không rơi khỏi tab Draft (tab này chỉ hiện bài có ngày >= hiện tại).
    date: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
    // Tag "Zalo" để Media Hub nhận diện bài chờ duyệt từ nhóm Zalo
    // (trang Zalo trong Media Hub tự tạo tag này khi bật cầu nối).
    tags: [{ value: 'Zalo', label: 'Zalo' }],
    shortLink: false,
    posts: [
      {
        integration: { id: targetIntegration },
        value: [{ content: caption || '', image: media }],
      },
    ],
  };

  try {
    const res = await fetch(`${base}/public/v1/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: apiKey },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: text.slice(0, 300) };
    }
    // Postiz trả [{postId, integration}] — postId để Hub mở thẳng trình soạn bài.
    let postId = null;
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr) && arr[0]?.postId) postId = arr[0].postId;
    } catch {}
    console.log(`[postiz] ✅ Đã đẩy bản nháp "${groupName}" (${media.length} media) sang Postiz.`);
    return { ok: true, media: media.length, postId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
