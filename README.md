# Zalo → Facebook Auto-Post

Bot gom ảnh/video giáo viên gửi trong **nhóm Zalo** → lọc & chọn ảnh đẹp bằng AI → viết caption (AI nhìn ảnh) → đăng lên **Facebook Page** tương ứng. Có **web dashboard** duyệt bài, quản lý token, log. Chạy 24/7.

> Trạng thái: **chạy được, chế độ NHÁP/DUYỆT TAY** (chưa tự đăng công khai). 2 nhóm Zalo → 2 Page. Token Facebook vĩnh viễn.

---

## Chạy

```bash
npm start          # chạy service + dashboard (node --env-file=.env src/service.mjs)
npm test           # chạy toàn bộ test (6 file)
npm run groups     # liệt kê nhóm Zalo (lấy threadId thêm route mới)
```

- **Dashboard:** http://localhost:8080 — đăng nhập bằng `DASHBOARD_USER`/`DASHBOARD_PASS` trong `.env`.
- **24/7:** `start.bat` (vòng lặp tự restart khi crash) + Task Scheduler `ZaloAutoPost` (chạy lúc đăng nhập Windows). Mất mạng/đóng kết nối → tự thoát & khởi động lại.
- **Đăng nhập Zalo:** lần đầu quét `qr.png` (in ra khi chạy); phiên lưu ở `zalo-creds.json` (hết hạn thì quét lại). KHÔNG mở Zalo Web cùng lúc.

## Pipeline

`service.mjs` (zca-js listener) → `extract.mjs` (chuẩn hoá tin) → `batcher.mjs` (gom theo debounce: im lặng / lệnh "xong" / trần max) → `pipeline.mjs`:
`download.mjs` (tải) → `curate.mjs` (bỏ trùng pHash + lọc mờ/tối) + `pickbest.mjs` (AI chọn ảnh đẹp trong cụm trùng) → `format.mjs` (sharp ảnh + ffmpeg `spawn` video, mặc định "native" giữ tỉ lệ, cap 2048/1920) → `caption.mjs` (AI nhìn ảnh + đọc ghi chú cô giáo) → **hàng chờ duyệt** (`store.mjs`) → duyệt trên dashboard → `publish.mjs` (`facebook.mjs` Graph API: album + video + comment đầu).

## Cấu hình

- **`config/routes.json`** — map nhóm Zalo → Page (threadId, fanpageId, fanpageTokenEnv, published, enabled, comment, debounceMs). Sửa được qua dashboard (tab Nhóm→Page).
- **`.env`** (gitignored) — secrets:
  - `ANTHROPIC_API_KEY`, `CLAUDE_MODEL=claude-sonnet-4-6`
  - `FB_PAGE_TOKEN_*` (token vĩnh viễn từng page), `FB_APP_ID`, `FB_APP_SECRET`
  - `DASHBOARD_USER`, `DASHBOARD_PASS`, `WEB_PORT`

## Quy tắc caption (đã chốt — xem memory `caption-style`)

- KHÔNG đoán bừa tranh trẻ là con/vật gì khi không chắc → viết trung tính. NHƯNG khi cô giáo có ghi chú thì DÙNG (được nêu chi tiết cô nói).
- Caption từng ảnh phải **khác nhau + có mạch** (hàm `captionImageSet` đưa cả bộ ảnh 1 lần).
- Xưng "con/các con" thân mật (không "bé/các bé"), tự nhiên không cứng.
- Tự lọc bỏ markdown `*`/`**` (FB không hiểu).

## Quyết định kiến trúc lớn (vì sao)

- **Dùng zca-js (tài khoản Zalo thật) thay vì Bot API chính thức:** bot chính thức KHÔNG đọc được tin nhóm khi không tag, chỉ chủ DM được, không nhận video. zca-js đọc mọi tin nhóm + album + video. Đánh đổi: rủi ro khóa account (chấp nhận, đổi acc khác nếu bị). Chi tiết: memory `zalo-bot-api-facts`, `zca-js-facts`.

## CẦN LÀM TIẾP (TODO)

1. **Giao diện (đang làm):** dùng skill **impeccable** (`/impeccable polish`, `/impeccable audit`) tinh chỉnh `public/index.html`. Đã theo anti-slop: Be Vietnam Pro, icon SVG, màu xanh/vàng thương hiệu, sidebar. Ràng buộc: không SaaS slop, không giống app mạng xã hội, WCAG AA + tiếng Việt, chạy tốt trên điện thoại.
2. **Deploy VPS Singapore:** systemd/pm2, copy `zalo-creds.json` lên (đăng nhập QR ở local trước), bảo mật dashboard (HTTPS + firewall + đổi `DASHBOARD_PASS`).
3. **Bật đăng công khai** khi duyệt nháp thấy ổn (dashboard tab Cài đặt tắt "Duyệt tay", hoặc bấm "Đăng công khai" từng bài).
4. (tuỳ chọn) Đăng kèm **Instagram** (page đã nối IG); **lọc ảnh nâng cao** (cổng an toàn AI: loại ảnh không phù hợp đăng công khai / khuôn mặt).

## Lưu ý vận hành

- zca-js không giữ tin cũ: tin gửi lúc service tắt sẽ MẤT → phải chạy 24/7.
- `getGroupChatHistory` trả 404 (không kéo lại được lịch sử).
- Bộ nhớ dự án (tri thức đầy đủ) ở `~/.claude/projects/D--Zalo-bot-group/memory/` — mọi phiên Claude Code tự nạp.
