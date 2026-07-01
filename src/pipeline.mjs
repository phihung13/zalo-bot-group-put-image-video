// src/pipeline.mjs — xử lý 1 batch đã chốt: tải → lọc(AI) → format FB → caption(AI) → lưu + báo lại.
// reply được TIÊM vào (không phụ thuộc zca-js) -> test được. Lỗi 1 batch KHÔNG làm sập service.
import fs from "node:fs";
import path from "node:path";
import { downloadAll } from "./download.mjs";
import { curate } from "./curate.mjs";
import { pickBest } from "./pickbest.mjs";
import { formatImage, formatVideo, extractFrames } from "./format.mjs";
import { writeCaption, captionImageSet, captionFromFrames, combineTexts, generateHashtags } from "./caption.mjs";
import { dataPath } from "./paths.mjs";

const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_");

/** Đảm bảo mỗi item có .buffer: cái nào có sẵn thì giữ, thiếu thì tải từ url. */
async function ensureBuffers(items, log) {
  const have = items.filter((i) => i.buffer);
  const need = items.filter((i) => !i.buffer && i.url);
  const dl = need.length ? await downloadAll(need, { log }) : [];
  return [...have, ...dl];
}

/**
 * @param {object} batch  { threadId, items:[{kind,url|buffer,...}], texts }
 * @param {string} reason
 * @param {object} opts { log, reply, outputDir, mode, maxKeep, disableAI }
 */
export async function processBatch(batch, reason, opts = {}) {
  const log = opts.log || (() => {});
  const onStage = opts.onStage || (() => {}); // báo tiến trình cho màn "Lắng nghe"
  const reply = opts.reply || (async () => {});
  const mode = opts.mode || "native";
  const stamp = sanitize(batch.startedAt || (batch.items[0] && batch.items[0].ts) || "batch");
  const dir = path.join(opts.outputDir || dataPath("output"), `${sanitize(batch.threadId)}_${stamp}`);
  fs.mkdirSync(dir, { recursive: true });

  const imageItems = batch.items.filter((i) => i.kind === "image");
  const videoItems = batch.items.filter((i) => i.kind === "video");

  // 1) tải (item đã có buffer thì khỏi tải)
  onStage("Đang tải ảnh/video về", { images: imageItems.length, videos: videoItems.length });
  const images = await ensureBuffers(imageItems, log);

  // 2) lọc: dedup + mờ/tối + AI chọn ảnh đẹp trong cụm trùng
  onStage("AI đang lọc ảnh (bỏ trùng/mờ/tối)", { received: images.length });
  const usePick = opts.disableAI ? null : (members) => pickBest(members, { log });
  const { kept, dropped } = await curate(images, { pickBest: usePick, maxKeep: opts.maxKeep || Infinity });
  onStage("Đã chọn ảnh", { kept: kept.length, dropped: dropped.length });

  // 3) format ảnh giữ lại + lưu
  const savedImages = [];
  for (let i = 0; i < kept.length; i++) {
    try {
      const out = await formatImage(kept[i].buffer, { mode });
      const f = path.join(dir, `anh_${String(i + 1).padStart(2, "0")}.jpg`);
      fs.writeFileSync(f, out);
      savedImages.push(f);
    } catch (e) { log(`format ảnh lỗi, bỏ: ${e.message}`); }
  }

  // 4) video: tải + format (skip cái lỗi, không sập)
  const savedVideos = [];
  const videos = await ensureBuffers(videoItems, log);
  for (let i = 0; i < videos.length; i++) {
    const raw = path.join(dir, `_raw_${i + 1}.mp4`);
    const outP = path.join(dir, `video_${String(i + 1).padStart(2, "0")}.mp4`);
    try {
      fs.writeFileSync(raw, videos[i].buffer);
      await formatVideo(raw, outP, { mode, log });
      savedVideos.push(outP);
    } catch (e) { log(`format video lỗi, bỏ: ${e.message}`); }
    finally { fs.rmSync(raw, { force: true }); }
  }

  // 5) caption tổng (message của bài): AI nhìn ảnh + đọc ghi chú; fallback nguyên text
  onStage("AI đang nghĩ nội dung bài đăng", { kept: savedImages.length });
  const cap = await writeCaption(
    { items: kept.map((k) => ({ kind: "image", buffer: k.buffer })), texts: batch.texts },
    { log, disableAI: opts.disableAI, guide: opts.guide },
  );
  fs.writeFileSync(path.join(dir, "caption.txt"), cap.caption || "");

  // 5a) hashtag (AI): 5 cái bám nội dung + định hướng Trang -> service ráp XUỐNG CUỐI (sau chân bài)
  let hashtags = "";
  if (opts.autoHashtags !== false && !opts.disableAI) {
    onStage("AI đang tạo hashtag", {});
    const noteForTags = combineTexts(batch.texts);
    hashtags = await generateHashtags([cap.caption, noteForTags].filter(Boolean).join("\n"), { guide: opts.guide, log });
  }

  // 5b) caption RIÊNG từng ảnh + từng video (video: trích khung hình cho AI "xem")
  const perItem = opts.perItemCaption !== false && !opts.disableAI;
  const noteText = combineTexts(batch.texts);
  // Caption CẢ BỘ trong 1 lần -> mỗi ảnh khác nhau, có mạch chuyện
  if (perItem && kept.length) onStage("AI đang chú thích từng ảnh", { kept: savedImages.length });
  const imageCaptions = perItem ? await captionImageSet(kept.map((k) => k.buffer), { log, note: noteText }) : [];
  const videoCaptions = [];
  if (perItem && savedVideos.length) onStage("AI đang xem video", { videos: savedVideos.length });
  if (perItem) for (const vp of savedVideos) {
    // 1 khung/10s: video 1 phút -> 6 khung, 2 phút -> 12 khung (giới hạn 2..30 khung)
    try { videoCaptions.push(await captionFromFrames(await extractFrames(vp, { perSeconds: 10 }), { log })); }
    catch (e) { log(`caption video lỗi: ${e.message}`); videoCaptions.push(""); }
  }

  // 5c) IN BẢN NHÁP rõ ràng ra terminal + lưu file
  const preview = [];
  preview.push("📋 ========== BẢN NHÁP ==========");
  preview.push(`(nhóm ${batch.threadId} — ${reason})`);
  preview.push(`📝 Caption bài:\n${cap.caption}`);
  if (hashtags) preview.push(`#️⃣ Hashtag: ${hashtags}`);
  savedImages.forEach((f, i) => preview.push(`🖼️  Ảnh ${i + 1}: ${imageCaptions[i] || "(không có)"}`));
  savedVideos.forEach((f, i) => preview.push(`🎬 Video ${i + 1}: ${videoCaptions[i] || "(không có)"}`));
  preview.push(`📁 File: ${dir}`);
  preview.push("================================");
  const previewText = preview.join("\n");
  log("\n" + previewText + "\n");
  fs.writeFileSync(path.join(dir, "ban-nhap.txt"), previewText);

  // 6) đăng Facebook (nếu được tiêm opts.post) — lỗi đăng KHÔNG làm sập batch
  let fbLinks = [];
  if (opts.post && (savedImages.length || savedVideos.length)) {
    try {
      const r = await opts.post({ caption: cap.caption, imagePaths: savedImages, imageCaptions, videoPaths: savedVideos, videoCaptions });
      fbLinks = (r && r.links) || [];
    } catch (e) { log(`đăng FB lỗi: ${e.message}`); }
  }

  // 7) tóm tắt + báo lại nhóm
  const summary =
    `✅ Đã xử lý xong (${reason}): ${savedImages.length} ảnh` +
    (savedVideos.length ? ` + ${savedVideos.length} video` : "") +
    (dropped.length ? ` — bỏ ${dropped.length} ảnh trùng/xấu` : "") +
    (fbLinks.length ? `\n🔗 Đã đăng: ${fbLinks.join(" , ")}` : "") +
    `\n📝 Caption (${cap.source}):\n${cap.caption}` +
    (fbLinks.length ? "" : `\n📁 ${dir}`);
  log(summary);
  try { await reply(summary); } catch (e) { log(`reply lỗi: ${e.message}`); }

  onStage("Đã tạo bản nháp", { kept: savedImages.length, videos: savedVideos.length, dropped: dropped.length, caption: cap.caption });

  return { dir, savedImages, savedVideos, imageCaptions, videoCaptions, caption: cap.caption, captionSource: cap.source, hashtags, droppedCount: dropped.length, fbLinks, reason };
}
