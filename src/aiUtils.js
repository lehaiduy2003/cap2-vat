// src/aiUtils.js
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ 
    model: process.env.GEMINI_LLM_MODEL || "gemini-1.5-flash" 
});

const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

async function generateAISummary(crimeScore, userScore, envScore, property, nearbyPlaces, reviews = []) {
  try {
    // --- [FIX LỖI QUAN TRỌNG] ÉP KIỂU SỐ AN TOÀN ---
    // Chuyển mọi input thành số (Number). Nếu null/undefined -> thành 0.
    const cScore = Number(crimeScore) || 0;
    const uScore = Number(userScore) || 0;
    const eScore = Number(envScore) || 0;

    // 1. Tối ưu dữ liệu review đầu vào
    const reviewsText = reviews.slice(0, 5).map(r => 
        `- "${r.review_text ? r.review_text.substring(0, 200) : 'Không có nội dung'}" (${r.safety_rating}/5)`
    ).join("\n");

    const prompt = `
      Đóng vai chuyên gia Bất động sản. Hãy viết đoạn nhận xét ngắn gọn (khoảng 150 từ) về độ an toàn của phòng trọ này.
      
      THÔNG TIN:
      - Tên: ${property.title || 'Phòng trọ'}
      - Địa chỉ: ${property.addressDetails || property.address || 'Vietnam'}
      
      ĐIỂM SỐ (Thang 10):
      - An ninh: ${cScore.toFixed(1)} (Dựa trên lịch sử sự cố)
      - Cộng đồng: ${uScore.toFixed(1)} (Dựa trên ${reviews.length} đánh giá)
      - Tiện ích & Môi trường: ${eScore.toFixed(1)} (Gần tiện ích, rủi ro ngập lụt/tiếng ồn)

      REVIEW CỦA NGƯỜI THUÊ:
      ${reviewsText}

      YÊU CẦU OUTPUT:
      - Định dạng Markdown.
      - Đi thẳng vào nhận xét ưu/nhược điểm.
      - Phân tích rủi ro nếu điểm thấp. Khen ngợi nếu điểm cao.
      - Kết luận: Có nên thuê không?
    `;

    const result = await aiModel.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 3024,
      },
      safetySettings,
    });

    return result.response.text();
  } catch (err) {
    console.error("[AI ERROR]", err.message);
    return "Hệ thống AI đang bận hoặc gặp lỗi xử lý dữ liệu. Vui lòng thử lại sau.";
  }
}

module.exports = { generateAISummary };