const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

// --- AI CONFIGURATION ---
if (!process.env.GEMINI_API_KEY) {
  console.error(
    "[LỖI NGHIÊM TRỌNG] GEMINI_API_KEY chưa được thiết lập. AI services sẽ không khả dụng."
  );
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({
  model: process.env.GEMINI_LLM_MODEL || "gemini-2.0-flash",
});

// Cache for AI summaries with expiration
const aiSummaryCache = new Map();
const CACHE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// Cấu hình an toàn (bỏ qua các chặn mặc định)
const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

/**
 * Hàm gọi AI để tạo nhận xét tổng quan về khu vực
 * Đã thêm xử lý markdown để đảm bảo văn bản được định dạng đúng.
 */
async function generateAISummary(
  crimeScore,
  userScore,
  envScore,
  property,
  nearbyPlaces,
  reviews = []
) {
  const cacheKey = `${property.id}_${crimeScore.toFixed(1)}_${userScore.toFixed(
    1
  )}_${envScore.toFixed(1)}_${reviews.length}`;
  if (aiSummaryCache.has(cacheKey)) {
    const cached = aiSummaryCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_EXPIRY_MS) {
      return cached.value;
    } else {
      aiSummaryCache.delete(cacheKey);
    }
  }

  // Extract nearby places by type (max 3 per type)
  const schools = nearbyPlaces.filter((p) => p.type === "school").slice(0, 3);
  const universities = nearbyPlaces.filter((p) => p.type === "university").slice(0, 3);
  const fire_stations = nearbyPlaces.filter((p) => p.type === "fire_station").slice(0, 3);
  const hospitals = nearbyPlaces.filter((p) => p.type === "hospital").slice(0, 3);
  const supermarkets = nearbyPlaces.filter((p) => p.type === "supermarket").slice(0, 3);
  const police = nearbyPlaces.filter((p) => p.type === "police").slice(0, 3);
  const train_stations = nearbyPlaces.filter((p) => p.type === "train_station").slice(0, 3);
  const gas_stations = nearbyPlaces.filter((p) => p.type === "gas_station").slice(0, 3);
  const parks = nearbyPlaces.filter((p) => p.type === "park").slice(0, 3);

  const prompt = `
        Bạn là một chuyên gia bất động sản và tư vấn thuê phòng trọ có kinh nghiệm, với kiến thức sâu rộng về thị trường Việt Nam.

        **THÔNG TIN PHÒNG TRỌ:**
        - Tiêu đề: ${property.title}
        - Mô tả: ${property.description}
        - Giá thuê: ${property.price.toLocaleString("vi-VN")} VND/tháng
        - Diện tích: ${property.roomSize} m²
        - Số phòng ngủ: ${property.numBedrooms}, Số phòng tắm: ${property.numBathrooms}
        - Địa chỉ: ${property.location.formattedAddress}

        **ĐÁNH GIÁ AN TOÀN:**
        - Điểm An ninh (Tội phạm): ${crimeScore.toFixed(1)}/10
        - Điểm Cộng đồng (Review): ${userScore.toFixed(1)}/10
        - Điểm Môi trường (Tiện ích): ${envScore.toFixed(1)}/10

        **CÁC ĐỊA ĐIỂM LÂN CẬN:**
        ${
          schools.length > 0
            ? `- Trường học: ${schools
                .map((s) => `${s.name} (${s.distanceInMeters.toFixed(0)}m)`)
                .join(", ")}`
            : ""
        }
        ${
          universities.length > 0
            ? `- Trường đại học: ${universities
                .map((u) => `${u.name} (${u.distanceInMeters.toFixed(0)}m)`)
                .join(", ")}`
            : ""
        }
        ${
          fire_stations.length > 0
            ? `- Trạm cứu hỏa: ${fire_stations
                .map((f) => `${f.name} (${f.distanceInMeters.toFixed(0)}m)`)
                .join(", ")}`
            : ""
        }
        ${
          hospitals.length > 0
            ? `- Bệnh viện: ${hospitals
                .map((h) => `${h.name} (${h.distanceInMeters.toFixed(0)}m)`)
                .join(", ")}`
            : ""
        }
        ${
          supermarkets.length > 0
            ? `- Siêu thị: ${supermarkets
                .map((s) => `${s.name} (${s.distanceInMeters.toFixed(0)}m)`)
                .join(", ")}`
            : ""
        }
        ${
          police.length > 0
            ? `- Đồn cảnh sát: ${police
                .map((p) => `${p.name} (${p.distanceInMeters.toFixed(0)}m)`)
                .join(", ")}`
            : ""
        }
        ${
          train_stations.length > 0
            ? `- Ga tàu: ${train_stations
                .map((t) => `${t.name} (${t.distanceInMeters.toFixed(0)}m)`)
                .join(", ")}`
            : ""
        }
        ${
          gas_stations.length > 0
            ? `- Trạm xăng: ${gas_stations
                .map((g) => `${g.name} (${g.distanceInMeters.toFixed(0)}m)`)
                .join(", ")}`
            : ""
        }
        ${
          parks.length > 0
            ? `- Công viên: ${parks
                .map((p) => `${p.name} (${p.distanceInMeters.toFixed(0)}m)`)
                .join(", ")}`
            : ""
        } 

        **REVIEWS TỪ NGƯỜI THUÊ:**
        ${
          reviews.length > 0
            ? reviews
                .slice(0, 5)
                .map(
                  (r) =>
                    `- An toàn: ${r.safety_rating}/5, Sạch sẽ: ${
                      r.cleanliness_rating || "N/A"
                    }/5, Tiện nghi: ${r.amenities_rating || "N/A"}/5, Chủ nhà: ${
                      r.host_rating || "N/A"
                    }/5\n  Nội dung: "${r.review_text || "Không có nhận xét"}"`
                )
                .join("\n\n")
            : "Không có review nào."
        }

        **HƯỚNG DẪN TẠO NHẬN XÉT CHI TIẾT:**

        Hãy viết một nhận xét tổng quan sâu sắc và khách quan về phòng trọ này, dựa trên:
        1. **Phân tích giá trị thực tế**: So sánh giá với mặt bằng chung khu vực. Ví dụ: Ở trung tâm thành phố lớn như Hà Nội/Hồ Chí Minh, phòng 30m² full nội thất thường có giá từ 4-8 triệu/tháng tùy vị trí. Đánh giá xem giá có hợp lý không.

        2. **Đánh giá vị trí chi tiết**: Phân tích ưu/nhược điểm vị trí cụ thể. Ví dụ: Đường Hoàng Diệu là tuyến phố trung tâm thuận tiện nhưng có thể ồn ào, đông đúc. Đề cập đến giao thông công cộng, thời gian di chuyển đến trung tâm thương mại, sân bay, etc.

        3. **An ninh và cộng đồng**: Phân tích sâu điểm số và các review thực tế. Điểm an ninh cao cho thấy khu vực an toàn, nhưng hãy kiểm tra review để xác nhận. Phân tích review chi tiết về an toàn, sạch sẽ, tiện nghi, chủ nhà để đưa ra đánh giá khách quan hơn.

        4. **Tiện ích và môi trường sống**: Đánh giá đầy đủ tiện ích xung quanh. Trường học gần tốt cho gia đình có con, nhưng có thể ồn. Bệnh viện gần là lợi thế lớn cho sức khỏe.

        5. **Đối tượng phù hợp**: Gợi ý cụ thể cho sinh viên (gần trường), nhân viên văn phòng (giao thông thuận tiện), cặp đôi trẻ (khu vực sôi động), gia đình nhỏ (an toàn, tiện ích).

        6. **Chi phí ẩn và rủi ro**: Cảnh báo về tiền điện/nước/thuê xe, phí quản lý, hợp đồng thuê. Đề cập rủi ro như ngập nước mùa mưa, ô nhiễm tiếng ồn, thay đổi dân cư.

        7. **Khuyến nghị kiểm tra**: Gợi ý kiểm tra thực tế: tình trạng phòng, chủ nhà, hàng xóm, hợp đồng.

        **CẤU TRÚC NHẬN XÉT:**
        - **Tóm tắt ngắn gọn** (1-2 câu): Tổng quan nhanh về ưu điểm chính
        - **Phân tích chi tiết** (3-5 câu): Giá trị, vị trí, an ninh, tiện ích
        - **Khuyến nghị** (1-2 câu): Đối tượng phù hợp và lưu ý quan trọng

        Giọng văn chuyên nghiệp, trung thực, cân bằng giữa ưu và nhược điểm. Sử dụng kiến thức thị trường chung để làm giàu phân tích, không chỉ dựa vào dữ liệu có sẵn.
    `;

  try {
    const result = await aiModel.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 1024,
      },
      safetySettings,
    });

    const response = result.response;
    // Xử lý nếu AI từ chối (dù đã set threshold)
    if (!response.candidates || response.candidates.length === 0) {
      throw new Error("AI response was blocked or empty.");
    }
    const text = response.text();
    const trimmedText = text.trim();

    // Return the AI response as markdown (AI generates markdown format)
    const markdownText = trimmedText;

    aiSummaryCache.set(cacheKey, { value: markdownText, timestamp: Date.now() });
    return markdownText;
  } catch (err) {
    console.error(`[LỖI AI] Không thể tạo nhận xét: ${err.message}`);
    return null; // Trả về null nếu AI lỗi
  }
}
module.exports = {
  generateAISummary,
  aiModel,
  safetySettings,
};
