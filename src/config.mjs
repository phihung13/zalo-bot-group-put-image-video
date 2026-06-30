// src/config.mjs — nạp routes.json, tách map nhóm->fanpage khỏi code.
// Token KHÔNG nằm trong file; đọc từ env theo tên fanpageTokenEnv.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.resolve(__dirname, "../config/routes.json");

export function loadConfig(file = process.env.ROUTES_FILE || DEFAULT_FILE) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { raw = { defaults: {}, routes: [] }; } // chưa có file (vd lần đầu trên container/volume rỗng) -> cấu hình rỗng
  const defaults = {
    debounceMs: Number(raw.defaults?.debounceMs ?? 600000),
    maxWaitMs: Number(raw.defaults?.maxWaitMs ?? 1800000),
    published: raw.defaults?.published ?? false, // mặc định ĐĂNG NHÁP (an toàn) — bật true để công khai
    facebookAutoPublish: raw.defaults?.facebookAutoPublish ?? false,
    gbpAutoPublish: raw.defaults?.gbpAutoPublish ?? false,
  };

  const byThread = new Map();
  for (const r of raw.routes || []) {
    if (!r.threadId) throw new Error(`routes.json: thiếu threadId ở route ${JSON.stringify(r.label || r)}`);
    byThread.set(String(r.threadId), {
      threadId: String(r.threadId),
      label: r.label || r.threadId,
      fanpageId: r.fanpageId,
      fanpageToken: r.fanpageTokenEnv ? process.env[r.fanpageTokenEnv] : undefined,
      fanpageTokenEnv: r.fanpageTokenEnv,
      allowSenders: Array.isArray(r.allowSenders) ? r.allowSenders.map(String) : [],
      debounceMs: Number(r.debounceMs ?? defaults.debounceMs),
      maxWaitMs: Number(r.maxWaitMs ?? defaults.maxWaitMs),
      published: r.published ?? defaults.published, // true = đăng công khai; false = nháp
      facebookAutoPublish: r.facebookAutoPublish ?? false, // true = bỏ qua duyệt, đăng Facebook công khai ngay
      gbpAutoPublish: r.gbpAutoPublish ?? false, // true = bỏ qua duyệt, đăng Google Business ngay
      enabled: r.enabled !== false, // false = tạm tắt nhóm này
      comment: r.comment || "", // comment đầu tự động (SĐT/địa chỉ...)
      captionFooter: r.captionFooter || "", // chân bài cố định (hotline/địa chỉ) chèn cuối caption
      gbpLocationId: r.gbpLocationId || "", // Google Business Profile location ID; rỗng = không đăng GBP
    });
  }
  return { defaults, byThread, file };
}

/** Route cho 1 nhóm, hoặc undefined nếu nhóm không được cấu hình (bỏ qua). */
export function routeForThread(cfg, threadId) {
  return cfg.byThread.get(String(threadId));
}

/** Người gửi có được phép trong route này không. allowSenders rỗng = cho phép tất cả. */
export function isSenderAllowed(route, senderId) {
  if (!route) return false;
  if (!route.allowSenders.length) return true;
  return route.allowSenders.includes(String(senderId));
}
