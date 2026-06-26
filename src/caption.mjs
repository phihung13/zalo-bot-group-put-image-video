// src/caption.mjs — viết caption Facebook: Claude vừa ĐỌC ghi chú giáo viên vừa NHÌN ảnh đã chọn.
// Model claude-sonnet-4-6 (vision). Lỗi/tắt AI -> fallback dùng nguyên text giáo viên.
import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

export function hasApiKey() {
  return !!process.env.ANTHROPIC_API_KEY;
}

async function toThumb(input, size = 512) {
  return sharp(input).rotate().resize(size, size, { fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
}

/** Gộp các đoạn text giáo viên gõ thành 1 khối (bỏ rỗng, bỏ trùng liền kề). */
export function combineTexts(texts = []) {
  const lines = [];
  for (const t of texts) {
    const s = (typeof t === "string" ? t : t && t.text) || "";
    const v = s.trim();
    if (v && v !== lines[lines.length - 1]) lines.push(v);
  }
  return lines.join("\n");
}

/** Fallback khi không có AI: dùng nguyên ghi chú giáo viên. */
export function fallbackCaption(texts = []) {
  return combineTexts(texts);
}

const SYSTEM = [
  "Bạn là người viết nội dung cho fanpage Facebook của một trường mầm non Việt Nam.",
  "Giọng văn ấm áp, gần gũi, đáng tin, hướng tới phụ huynh.",
  "LUÔN viết tiếng Việt CÓ DẤU đầy đủ và đúng chính tả.",
  // QUY TẮC AN TOÀN khi tả tranh/sản phẩm của trẻ:
  "Tranh và sản phẩm của trẻ mầm non thường ngây ngô, trừu tượng — người lớn KHÓ đoán đúng.",
  "TUYỆT ĐỐI KHÔNG áp đặt/đoán bức vẽ là con gì hay vật gì cụ thể (ví dụ: cá vàng, con sứa, bông hoa...) trừ khi nhìn RÕ RÀNG chắc chắn.",
  "Khi không chắc, hãy mô tả TRUNG TÍNH: 'tác phẩm đầy màu sắc của bé', 'bức tranh của con', 'sản phẩm sáng tạo'.",
  "Tập trung vào điều QUAN SÁT ĐƯỢC chắc chắn: sự chăm chú, đôi tay tỉ mỉ, nụ cười, niềm vui, sự sáng tạo, không khí lớp học.",
  "Thà viết chung chung còn hơn nói sai chi tiết. Không thêm chi tiết không nhìn thấy rõ.",
  "KHÔNG dùng định dạng markdown: không dùng ** hay * để in đậm/nghiêng — Facebook sẽ hiện nguyên ký tự đó, rất xấu.",
  // Xưng hô thân mật:
  "Xưng hô thân mật như cô giáo gọi học trò của mình: ưu tiên 'con', 'các con' thay cho 'bé', 'bé trai', 'bé gái', 'các bé', 'em' (nghe xa cách như người lạ).",
  "Dùng tự nhiên, linh hoạt — KHÔNG thay máy móc/lặp cứng nhắc; cốt sao câu mượt và ấm áp.",
].join(" ");

/** Bỏ ký tự markdown (**, *, __) — Facebook không hiểu, hiện ra ký tự thừa. */
export function stripMarkdown(s) {
  return String(s || "").replace(/\*+/g, "").replace(/__+/g, "").replace(/[ \t]{2,}/g, " ").trim();
}

/** Gửi 1 bộ ảnh + chỉ dẫn cho Claude vision -> text. null nếu lỗi/từ chối. */
async function askVision(buffers, instruction, { maxTokens = 400, log = () => {} } = {}) {
  if (!hasApiKey() || !buffers.length) return null;
  try {
    const thumbs = await Promise.all(buffers.map((b) => toThumb(b)));
    const content = thumbs.map((t) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: t.toString("base64") } }));
    content.push({ type: "text", text: instruction });
    const client = new Anthropic();
    const resp = await client.messages.create({ model: MODEL, max_tokens: maxTokens, system: SYSTEM, messages: [{ role: "user", content }] });
    if (resp.stop_reason === "refusal") return null;
    const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    return text ? stripMarkdown(text) : null;
  } catch (e) { log(`askVision lỗi: ${e.message}`); return null; }
}

const PER_IMAGE_INSTRUCTION =
  "Viết 1 câu caption NGẮN (tối đa ~20 từ) tiếng Việt có dấu, mô tả khoảnh khắc của bé trong ảnh này, ấm áp tự nhiên. " +
  "KHÔNG bịa chi tiết không thấy. Chỉ trả về đúng 1 câu, không emoji thừa, không tiền tố.";

/** Caption riêng cho 1 ẢNH. opts.note = bối cảnh hoạt động (ghi chú cô giáo). */
export async function captionOneImage(buffer, opts = {}) {
  const note = (opts.note || "").trim();
  const instr = note
    ? `Bối cảnh hoạt động hôm nay (giáo viên cung cấp, đáng tin): """${note}"""\n\n${PER_IMAGE_INSTRUCTION}\nCó thể dùng bối cảnh trên cho phù hợp, nhưng vẫn KHÔNG khẳng định chi tiết bức vẽ nếu không nhìn rõ.`
    : PER_IMAGE_INSTRUCTION;
  const r = await askVision([buffer], instr, { maxTokens: 200, log: opts.log });
  return r || "";
}

/**
 * Caption CẢ BỘ ảnh trong 1 lần gọi -> mỗi ảnh 1 câu KHÁC NHAU, có MẠCH chuyện, bám từng ảnh.
 * @param {Buffer[]} buffers theo đúng thứ tự
 * @returns {Promise<string[]>} cùng độ dài, đúng thứ tự (phần tử "" nếu không có AI)
 */
export async function captionImageSet(buffers, opts = {}) {
  const n = buffers.length;
  if (!hasApiKey() || !n) return buffers.map(() => "");
  const note = (opts.note || "").trim();
  try {
    const thumbs = await Promise.all(buffers.map((b) => toThumb(b)));
    const content = [];
    thumbs.forEach((t, i) => {
      content.push({ type: "text", text: `Ảnh ${i + 1}:` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: t.toString("base64") } });
    });
    content.push({
      type: "text",
      text:
        `Trên là ${n} ảnh theo đúng thứ tự của cùng một buổi hoạt động.` +
        (note ? `\n\nBối cảnh (giáo viên cung cấp, đáng tin):\n"""${note}"""` : "") +
        `\n\nViết cho MỖI ảnh MỘT câu caption tiếng Việt có dấu (khoảng 12–22 từ). Yêu cầu BẮT BUỘC:` +
        `\n1) Mỗi caption KHÁC HẲN nhau — KHÔNG lặp lại cụm từ ("tự hào khoe", "nụ cười rạng rỡ", "tác phẩm sáng tạo"...). Mỗi câu một cách diễn đạt riêng.` +
        `\n2) Cả bộ tạo thành MỘT MẠCH như kể lại buổi học theo diễn biến (chuẩn bị → bắt tay vào làm → chăm chú/hợp tác → hoàn thiện → khoe thành quả), bám đúng điều THẤY ở từng ảnh.` +
        `\n3) Tối ưu RIÊNG cho từng ảnh: tả đúng việc bé đang làm hoặc biểu cảm trong CHÍNH ảnh đó (số lượng bé, hành động, khoảnh khắc).` +
        `\n4) KHÔNG khẳng định bức vẽ là con/vật gì nếu không nhìn rõ; chỉ dùng ngữ cảnh giáo viên cho an toàn.` +
        `\n5) KHÔNG markdown, không đánh số đầu câu, không emoji quá nhiều (tối đa 1/câu).` +
        `\nTrả về JSON {"captions": [...]} đúng ${n} phần tử, theo thứ tự ảnh.`,
    });
    const client = new Anthropic();
    const resp = await client.messages.create({
      model: MODEL, max_tokens: 2000, system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: { type: "object", properties: { captions: { type: "array", items: { type: "string" } } }, required: ["captions"], additionalProperties: false } } },
      messages: [{ role: "user", content }],
    });
    if (resp.stop_reason === "refusal") return buffers.map(() => "");
    const txt = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    let arr = [];
    try { arr = (JSON.parse(txt).captions || []).map((s) => stripMarkdown(s)); } catch { arr = []; }
    while (arr.length < n) arr.push("");
    return arr.slice(0, n);
  } catch (e) { opts.log?.(`captionImageSet lỗi: ${e.message}`); return buffers.map(() => ""); }
}

/**
 * Caption cho 1 VIDEO dựa trên các KHUNG HÌNH trích ra (Claude không đọc file video trực tiếp).
 * @param {Buffer[]} frameBuffers
 */
export async function captionFromFrames(frameBuffers, opts = {}) {
  const instr =
    `Đây là ${frameBuffers.length} khung hình trích từ MỘT video hoạt động của bé. ` +
    "Dựa vào các khung, viết 1-2 câu caption tiếng Việt có dấu mô tả nội dung video, ấm áp tự nhiên. " +
    "KHÔNG bịa. Chỉ trả về caption, không tiền tố.";
  const r = await askVision(frameBuffers, instr, { maxTokens: 300, log: opts.log });
  return r || "";
}

/**
 * Viết caption từ ảnh + ghi chú.
 * @param {object} batch  { items: [{buffer,kind,posterUrl,...}], texts: [{text}] }
 * @param {object} o  { log, maxImages, disableAI }
 * @returns {Promise<{caption:string, source:"ai"|"fallback"}>}
 */
export async function writeCaption(batch, o = {}) {
  const texts = batch?.texts || [];
  const noteText = combineTexts(texts);
  const styleGuide = (o.styleGuide || "").trim(); // bài mẫu của trang -> AI bắt chước giọng
  const maxImages = o.maxImages || 6;

  // gom buffer ảnh (chỉ ảnh; video bỏ qua phần nhìn)
  const imageItems = (batch?.items || []).filter((it) => it.kind === "image" && it.buffer).slice(0, maxImages);

  if (o.disableAI || !hasApiKey() || imageItems.length === 0) {
    return { caption: fallbackCaption(texts), source: "fallback" };
  }

  try {
    const thumbs = await Promise.all(imageItems.map((it) => toThumb(it.buffer)));
    const content = [];
    thumbs.forEach((t) => content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: t.toString("base64") } }));
    content.push({
      type: "text",
      text:
        `Đây là ${thumbs.length} ảnh hoạt động của các bé hôm nay tại trường.` +
        (noteText
          ? `\n\nGHI CHÚ CỦA GIÁO VIÊN (nguồn thông tin CHÍNH, ĐÁNG TIN — hãy bám theo):\n"""${noteText}"""`
          : "\n\n(Không có ghi chú kèm theo.)") +
        (styleGuide
          ? `\n\nViết MỘT bài đăng Facebook MỚI cho bộ ảnh hôm nay, theo ĐÚNG PHONG CÁCH của trang này.` +
            `\nDưới đây là BÀI MẪU THẬT của trang — hãy bám sát GIỌNG VĂN, CẤU TRÚC (tiêu đề/mở bài/thân/kết), cách dùng EMOJI và độ dài Y NHƯ mẫu:` +
            `\n\n=== BÀI MẪU ===\n${styleGuide}\n=== HẾT MẪU ===` +
            `\n\n- Viết nội dung MỚI bám ảnh & ghi chú HÔM NAY (chủ đề/hoạt động khác mẫu) — TUYỆT ĐỐI KHÔNG chép nội dung bài mẫu.` +
            `\n- Bài mẫu có thể kèm phần LIÊN HỆ/ĐỊA CHỈ/HOTLINE/HASHTAG ở cuối — BỎ QUA phần đó, chỉ học PHẦN THÂN BÀI; hệ thống tự chèn liên hệ + hashtag sau.`
          : `\n\nHãy viết MỘT bài đăng Facebook cho fanpage trường mầm non, theo CẤU TRÚC:` +
            `\n1) DÒNG TIÊU ĐỀ giật tít gửi "ba mẹ", VIẾT HOA phần chính, 1–3 emoji.` +
            `\n2) Đoạn MỞ "Ba mẹ ơi, ..." dẫn vào hoạt động.` +
            `\n3) 3–4 GẠCH ĐẦU DÒNG: emoji + cụm IN HOA nêu lợi ích + giải thích (thẩm mỹ/sáng tạo, vận động tinh, tập trung/tự hào, hợp tác).` +
            `\n4) Câu TRIẾT LÝ thương hiệu "Tại trường ...".` +
            `\n5) LỜI MỜI cuối: xem album + thả tim, theo dõi Fanpage.` +
            `\n- Không hashtag. Độ dài ~150–300 từ.`) +
        `\n\nQUY TẮC CHUNG:` +
        (noteText
          ? `\n- DÙNG ghi chú giáo viên làm nội dung chính; giáo viên nói gì coi là ĐÚNG (vd hoạt động làm con sứa).`
          : `\n- Không có ghi chú: mô tả TRUNG TÍNH điều thấy chắc, KHÔNG đoán bức vẽ là con/vật gì.`) +
        `\n- Tiếng Việt CÓ DẤU đầy đủ; ấm áp; xưng "con/các con".` +
        `\n- KHÔNG markdown (không * hay **) — nhấn mạnh bằng VIẾT HOA. KHÔNG khẳng định bức vẽ nếu không nhìn rõ. KHÔNG bịa.` +
        `\n- KHÔNG tự thêm số điện thoại / địa chỉ / tên cơ sở ở cuối — hệ thống tự chèn chân bài. (Hashtag/Google Maps cũng nằm ở chân bài.)` +
        `\n- KHÔNG nhắc đây là AI.` +
        `\n\nChỉ trả về DUY NHẤT nội dung THÂN BÀI (KHÔNG kèm phần liên hệ/hashtag ở cuối), không giải thích.`,
    });

    const client = new Anthropic();
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });

    if (resp.stop_reason === "refusal") {
      o.log?.("caption: AI từ chối -> fallback");
      return { caption: fallbackCaption(texts), source: "fallback" };
    }
    const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (!text) return { caption: fallbackCaption(texts), source: "fallback" };
    return { caption: stripMarkdown(text), source: "ai" };
  } catch (e) {
    o.log?.(`caption lỗi (${e.message}) -> fallback dùng nguyên text`);
    return { caption: fallbackCaption(texts), source: "fallback" };
  }
}
