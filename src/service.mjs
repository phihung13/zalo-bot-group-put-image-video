// src/service.mjs — SERVICE: zca-js listener -> extract -> batcher -> chuẩn bị bài -> HÀNG CHỜ DUYỆT
// (hoặc tự đăng) + WEB DASHBOARD. Chạy: node --env-file=.env src/service.mjs
import fs from "node:fs";
import path from "node:path";
import { Zalo, ThreadType } from "zca-js";
import qrcode from "qrcode-terminal";
import { extractEvent } from "./extract.mjs";
import { Batcher, MemoryStore } from "./batcher.mjs";
import { loadConfig, routeForThread } from "./config.mjs";
import { processBatch } from "./pipeline.mjs";
import { publishDraft } from "./publish.mjs";
import { startWeb } from "./web.mjs";
import * as store from "./store.mjs";
import * as live from "./live.mjs";
import { styleFor } from "./styles.mjs";
import { CRED_FILE, QR_FILE, dataPath, loadTokensIntoEnv } from "./paths.mjs";

loadTokensIntoEnv(); // nạp token Trang FB đã lưu (data/tokens.json) vào process.env trước khi chạy

// Log ra file + màn hình + dashboard
const _logStream = fs.createWriteStream(dataPath("service.log"), { flags: "a" });
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
console.log = (...a) => { _origLog(...a); try { _logStream.write(a.join(" ") + "\n"); } catch {} };
console.error = (...a) => { _origErr(...a); try { _logStream.write("[ERR] " + a.join(" ") + "\n"); } catch {} };
process.on("uncaughtException", (e) => { console.error("💥 uncaughtException:", e?.stack || e); setTimeout(() => process.exit(1), 300); });
process.on("unhandledRejection", (e) => { console.error("💥 unhandledRejection:", e?.message || e); });

async function login() {
  const zalo = new Zalo({ selfListen: true });
  if (fs.existsSync(CRED_FILE)) {
    try {
      const api = await zalo.login(JSON.parse(fs.readFileSync(CRED_FILE, "utf8")));
      console.log("✅ Đăng nhập lại bằng credentials đã lưu.");
      return api;
    } catch (e) { console.log("⚠️ Creds cũ hỏng:", e.message, "→ quét QR."); }
  }
  console.log("📲 Quét QR (mở qr.png / dashboard tab Cài đặt) bằng tài khoản đã ở trong nhóm:");
  return zalo.loginQR({ qrPath: QR_FILE }, (ev) => {
    if (ev?.type === 0 && ev.data?.code) { qrcode.generate(ev.data.code, { small: true }); try { ev.actions?.saveToFile?.(QR_FILE); } catch {} }
    if (ev?.type === 4 && ev.data) fs.writeFileSync(CRED_FILE, JSON.stringify(ev.data, null, 2));
  });
}

async function main() {
  let cfg = loadConfig();
  const reloadConfig = () => { cfg = loadConfig(); console.log("  [cfg] đã nạp lại routes:", [...cfg.byThread.keys()].join(", ")); };
  const getRoute = (tid) => { const r = routeForThread(cfg, tid); return r && r.enabled !== false ? r : undefined; };

  const status = { zaloConnected: false, relogging: false, ownId: null };
  let currentApi = null;
  const threadTypeOf = new Map();

  const batcher = new Batcher({
    store: new MemoryStore(),
    getRoute,
    log: (m) => console.log("  [batcher]", m),
    preExpiryMs: Number(process.env.PRE_EXPIRY_MS || 3600000), // chỉ-có-chữ, 1h không ảnh -> bỏ
    onDiscard: (tid) => live.clear(tid), // xoá phiên "đang ghi nhận" trên màn Lắng nghe

    onClose: async (batch, reason) => {
      const route = getRoute(batch.threadId);
      if (!route) return;
      live.processing(batch.threadId, "Bắt đầu xử lý");
      try {
        // CHUẨN BỊ bài (gom -> lọc -> AI chọn -> format -> caption). KHÔNG đăng ở đây.
        const res = await processBatch(batch, reason, {
          log: (m) => console.log("  [pipeline]", m), perItemCaption: true,
          styleGuide: styleFor(route.fanpageId),
          onStage: (stage, extra) => live.processing(batch.threadId, stage, extra),
        });
        if (!res.savedImages.length && !res.savedVideos.length) { live.done(batch.threadId, null); return; }
        const draft = {
          id: path.basename(res.dir), threadId: batch.threadId, routeLabel: route.label,
          fanpageId: route.fanpageId, fanpageTokenEnv: route.fanpageTokenEnv,
          dir: res.dir, savedImages: res.savedImages, savedVideos: res.savedVideos,
          imageUrls: res.savedImages.map((p) => "/output/" + path.relative(dataPath("output"), p).replace(/\\/g, "/")),
          videoUrls: (res.savedVideos || []).map((p) => "/output/" + path.relative(dataPath("output"), p).replace(/\\/g, "/")),
          imageCaptions: res.imageCaptions, videoCaptions: res.videoCaptions,
          comment: route.comment || "", published: route.published,
          caption: res.caption + (route.captionFooter ? "\n\n" + String(route.captionFooter).trim() : ""),
          droppedCount: res.droppedCount, createdAt: Date.now(), reason,
        };
        if (store.getSettings().approval) {
          store.addPending(draft);
          live.done(batch.threadId, draft.id);
          store.pushLog(`Bài mới CHỜ DUYỆT: ${route.label} (${res.savedImages.length} ảnh)`);
          console.log(`  [pipeline] -> HÀNG CHỜ DUYỆT (mở dashboard để duyệt)`);
        } else {
          live.done(batch.threadId, null);
          const r = await publishDraft(draft, route, { published: route.published, comment: route.comment, log: (m) => console.log("  [fb]", m) });
          store.addPosted({ ...draft, postedAt: Date.now(), published: route.published, links: r.links });
          store.pushLog(`TỰ ĐĂNG: ${route.label} → ${r.links.join(" ")}`);
        }
      } catch (e) { console.error("💥 xử lý batch lỗi:", e?.message || e); store.pushLog("Xử lý batch lỗi: " + (e?.message || e)); }
    },
  });

  // Gắn toàn bộ listener cho 1 phiên api (dùng lại được khi đổi tài khoản)
  function attachListeners(api) {
    api.listener.on("message", async (m) => {
      try {
        const ev = extractEvent(m);
        if (ev.threadId) threadTypeOf.set(ev.threadId, m.type);
        if (store.getSettings().paused) return; // tạm dừng
        if (["image", "video", "text", "command"].includes(ev.kind)) {
          const rt = getRoute(ev.threadId);
          if (rt) {
            console.log(`📥 ${ev.kind} [${ev.msgType}] từ "${ev.senderName}" (nhóm ${ev.threadId})`);
            if (ev.kind !== "command") live.event(ev.threadId, rt.label, ev, rt);
          }
          await batcher.add(ev);
        } else if (getRoute(ev.threadId)) {
          console.log(`⏭️  bỏ qua tin hệ thống [${ev.msgType}] trong nhóm ${ev.threadId}`);
        }
      } catch (e) { console.error("xử lý message lỗi:", e.message); }
    });
    api.listener.on("connected", () => { status.zaloConnected = true; try { fs.rmSync(QR_FILE, { force: true }); } catch {} console.log("🔌 Listener ĐÃ KẾT NỐI."); });
    api.listener.on("disconnected", (code, reason) => { status.zaloConnected = false; console.log(`🔌 Mất kết nối (code ${code}) — tự thử lại... ${reason || ""}`); });
    api.listener.on("error", (e) => console.error("⚠️ listener error:", e?.message || e));
    api.listener.on("closed", (code, reason) => {
      status.zaloConnected = false;
      if (status.relogging) { console.log("🔌 Listener cũ đã đóng (đang đổi tài khoản — KHÔNG thoát)."); return; }
      console.error(`🔌 Listener ĐÓNG (code ${code} ${reason || ""}) → thoát để khởi động lại.`);
      setTimeout(() => process.exit(1), 500);
    });
    api.listener.start();
  }

  async function setApi(api) {
    currentApi = api;
    try { const oid = await api.getOwnId?.(); if (oid) status.ownId = String(oid); } catch {}
    attachListeners(api);
  }

  // Đổi tài khoản Zalo NGAY trong tiến trình (không khởi động lại service)
  async function reloginZalo() {
    if (status.relogging) return { already: true };
    status.relogging = true; status.zaloConnected = false; status.ownId = null;
    try { currentApi?.listener?.stop?.(); } catch {}
    try { fs.rmSync(CRED_FILE, { force: true }); } catch {}
    try { fs.rmSync(QR_FILE, { force: true }); } catch {}
    store.pushLog("Đổi tài khoản Zalo: dừng phiên cũ, chờ quét QR (không khởi động lại).");
    console.log("♻️  Đổi tài khoản: dừng listener cũ, chờ quét QR mới...");
    try {
      const zalo = new Zalo({ selfListen: true });
      const api = await zalo.loginQR({ qrPath: QR_FILE }, (ev) => {
        if (ev?.type === 0 && ev.data?.code) { qrcode.generate(ev.data.code, { small: true }); try { ev.actions?.saveToFile?.(QR_FILE); } catch {} }
        if (ev?.type === 4 && ev.data) fs.writeFileSync(CRED_FILE, JSON.stringify(ev.data, null, 2));
      });
      await setApi(api);
      store.pushLog("Đã đăng nhập Zalo tài khoản mới.");
      console.log("✅ Đăng nhập Zalo mới xong.");
    } catch (e) {
      console.error("đổi tài khoản lỗi:", e?.message || e);
      store.pushLog("Đổi tài khoản Zalo lỗi: " + (e?.message || e));
    } finally { status.relogging = false; }
  }

  startWeb({ status, reloadConfig, getZalo: () => currentApi, relogin: reloginZalo, getLive: () => live.snapshot(),
    closeNow: (tid) => batcher.close(String(tid), "manual") }); // web dashboard

  console.log(`📋 ${cfg.byThread.size} route. Theo dõi:`, [...cfg.byThread.keys()]);

  const api = await login();
  await setApi(api);

  console.log("\n🟢 SERVICE 24/7 đang chạy. Mở dashboard ở http://localhost:" + (process.env.WEB_PORT || 8080));
  console.log("   (Đừng mở Zalo Web cùng lúc.)\n");
}

main().catch((e) => { console.error("💥 Service chết:", e); process.exit(1); });
