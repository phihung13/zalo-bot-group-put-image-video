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
//   caption    : nội dung
//   imagePaths : mảng đường dẫn FILE ẢNH local (từ draft.savedImages)
//   videoPaths : mảng đường dẫn FILE VIDEO local (từ draft.savedVideos)
//   groupName  : tên nhóm/route (để log)
export async function pushToPostiz({ caption = '', imagePaths = [], videoPaths = [], groupName = '' }) {
  if (process.env.POSTIZ_ENABLED !== 'true') return { skipped: 'disabled' };

  const apiKey = process.env.POSTIZ_API_KEY;
  const integrationId = process.env.POSTIZ_INTEGRATION_ID;
  if (!apiKey || !integrationId) {
    return { skipped: 'missing-config' };
  }
  const base = apiUrl();

  // Upload media local -> lấy {id, path}
  const media = [];
  for (const f of [...(imagePaths || []), ...(videoPaths || [])]) {
    try {
      const m = await uploadLocalFile(base, apiKey, f);
      media.push({ id: m.id, path: m.path });
    } catch (e) {
      console.warn(`[postiz] upload lỗi (${path.basename(f)}): ${e.message}`);
    }
  }

  const body = {
    type: 'draft', // vào hàng chờ duyệt trong Postiz
    date: new Date().toISOString(),
    tags: [],
    shortLink: false,
    posts: [
      {
        integration: { id: integrationId },
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
    console.log(`[postiz] ✅ Đã đẩy bản nháp "${groupName}" (${media.length} media) sang Postiz.`);
    return { ok: true, media: media.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
