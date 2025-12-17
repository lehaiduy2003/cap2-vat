// server/aiUtils.js
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

// --- CẤU HÌNH GEMINI ---
if (!process.env.GEMINI_API_KEY) {
  console.error("⚠️ [WARNING] Thiếu GEMINI_API_KEY. Các tính năng AI sẽ không hoạt động.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Sử dụng model Flash cho tốc độ nhanh và chi phí thấp, hoặc Pro cho độ chính xác cao
const aiModel = genAI.getGenerativeModel({ 
    model: process.env.GEMINI_LLM_MODEL || "gemini-1.5-flash",
    // Bắt buộc output JSON cho các hàm phân tích dữ liệu
    generationConfig: { responseMimeType: "application/json" } 
});

// Model dành cho text generation (Summary) - trả về text tự do
const aiTextModel = genAI.getGenerativeModel({ 
    model: process.env.GEMINI_LLM_MODEL || "gemini-1.5-flash"
});

const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

/**
 * 1. TẠO NHẬN XÉT TỔNG QUAN (SUMMARY)
 * Chức năng: Viết đoạn văn ngắn gọn, súc tích cho người dùng đọc.
 */
async function generateAISummary(crimeScore, userScore, envScore, property, nearbyPlaces, reviews = []) {
  try {
    // Tối ưu input: Chỉ lấy tối đa 10 review mới nhất để tiết kiệm token
    const reviewsText = reviews.slice(0, 10).map(r => 
        `- "${r.review_text ? r.review_text.substring(0, 150).replace(/\n/g, " ") : '...'}" (${r.safety_rating}/5)`
    ).join("\n");

    const prompt = `
      Đóng vai một chuyên gia Bất động sản và An ninh khu vực.
      Hãy viết một đoạn đánh giá ngắn gọn (khoảng 150-200 từ) về phòng trọ này dựa trên các dữ liệu sau:
      
      **THÔNG TIN CƠ BẢN:**
      - Tiêu đề: ${property.title}
      - Địa chỉ: ${property.addressDetails || property.address || 'Đà Nẵng'}
      
      **ĐIỂM SỐ AN TOÀN (Thang 10):**
      - An ninh: ${crimeScore.toFixed(1)}/10 (Dựa trên lịch sử sự cố công an ghi nhận)
      - Cộng đồng: ${userScore.toFixed(1)}/10 (Dựa trên ${reviews.length} đánh giá từ người thuê cũ)
      - Tiện ích & Môi trường: ${envScore.toFixed(1)}/10 (Gần trường, trạm xá, mức độ yên tĩnh)

      **Ý KIẾN NGƯỜI THUÊ CŨ:**
      ${reviewsText || "Chưa có đánh giá nào."}

      **YÊU CẦU OUTPUT:**
      - Định dạng: Markdown (dùng bold, list).
      - Giọng văn: Khách quan, chuyên nghiệp, đi thẳng vào vấn đề.
      - Cấu trúc:
        1. **Tổng quan:** Nhận xét chung về mức độ an toàn.
        2. **Ưu điểm:** Nêu bật các điểm số cao (ví dụ: gần tiện ích, ít tội phạm).
        3. **Lưu ý:** Cảnh báo các rủi ro nếu điểm thấp (ví dụ: tiếng ồn, khu vực vắng vẻ) hoặc các vấn đề người thuê cũ phàn nàn.
      - Kết luận: Có đáng sống không?
    `;

    const result = await aiTextModel.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048, 
      },
      safetySettings,
    });

    return result.response.text();
  } catch (err) {
    console.error("[AI SUMMARY ERROR]", err.message);
    return "Hệ thống AI đang bận hoặc gặp sự cố. Vui lòng tham khảo các chỉ số điểm bên trên.";
  }
}

/**
 * 2. PHÂN TÍCH TIẾNG ỒN TỪ REVIEW (NOISE ANALYSIS) - [NEW FEATURE]
 * Chức năng: Đọc hiểu review để tìm ra các vấn đề tiếng ồn mà bản đồ không thấy được
 * (Ví dụ: Karaoke, Công trình, Hàng xóm cãi nhau).
 * * Trả về Object: { hasNoiseIssue: boolean, noiseScore: number, source: string, reason: string }
 */
async function analyzeNoiseFromReviews(reviews) {
  // Nếu ít review hoặc review trống thì bỏ qua để tiết kiệm tiền
  if (!reviews || reviews.length === 0) {
    return { hasNoiseIssue: false, noiseScore: 0, source: null };
  }

  // Lọc lấy các review có nội dung text
  const validReviews = reviews
    .filter(r => r.review_text && r.review_text.length > 5)
    .map(r => r.review_text)
    .join("\n---\n");

  if (!validReviews) return { hasNoiseIssue: false, noiseScore: 0, source: null };

  const prompt = `
    Nhiệm vụ: Phân tích danh sách các đánh giá phòng trọ dưới đây để tìm vấn đề về TIẾNG ỒN (Noise Pollution).
    
    Danh sách đánh giá:
    """
    ${validReviews}
    """

    Hãy trả về kết quả dưới dạng JSON chính xác với cấu trúc sau:
    {
      "hasNoiseIssue": boolean, // true nếu có nhiều người phàn nàn về tiếng ồn
      "noiseScore": number, // Thang điểm 0-10 (0 = Rất yên tĩnh, 10 = Cực kỳ ồn ào không thể ngủ)
      "source": string, // Nguồn gây ồn chính (VD: "Hàng xóm hát Karaoke", "Tiếng xe cộ", "Công trình xây dựng", "Không rõ")
      "reason": string // Trích dẫn ngắn gọn hoặc tóm tắt lý do
    }

    Lưu ý: Nếu không có ai nhắc đến tiếng ồn, hãy trả về noiseScore = 0.
  `;

  try {
    // Dùng model được cấu hình trả về JSON (generationConfig ở trên)
    const result = await aiModel.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      safetySettings,
    });

    const responseText = result.response.text();
    
    // Parse JSON từ kết quả AI
    // (Đôi khi AI trả về markdown ```json ... ```, cần xử lý sạch)
    const jsonString = responseText.replace(/```json|```/g, "").trim();
    const data = JSON.parse(jsonString);

    console.log(`[AI Noise Analysis] Score: ${data.noiseScore}, Source: ${data.source}`);
    return data;

  } catch (err) {
    console.error("[AI NOISE ANALYSIS ERROR]", err.message);
    // Fallback an toàn
    return { hasNoiseIssue: false, noiseScore: 0, source: "Lỗi phân tích" };
  }
}

module.exports = {
  generateAISummary,
  analyzeNoiseFromReviews,
  aiModel
};