/**
 * Property Routes
 * Handles all property-related API endpoints
 */

const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { runJob } = require("../runSafetyScoreJob");
const { generateAISummary } = require("../aiUtils");

// 1. API GET (MỚI): Dành cho Frontend gọi lấy điểm (Không cần gửi body)
// ---------------------------------------------------------
// --- THÊM ĐOẠN NÀY VÀO server/apiServer.js ---

// 1. API GET (MỚI): Dành cho Widget Frontend (Không cần body)
router.get("/api/v1/properties/:id/safety", async (req, res) => {
  const propertyId = parseInt(req.params.id, 10);
  if (isNaN(propertyId)) {
    return res.status(400).json({ error: "ID phòng trọ không hợp lệ." });
  }

  try {
    // Bước A: Tự lấy thông tin phòng từ DB (Vì GET không gửi kèm thông tin này)
    const propResult = await pool.query("SELECT * FROM properties WHERE id = $1", [propertyId]);
    const propertyData = propResult.rows[0];

    // Bước B: Lấy điểm an toàn
    let result = await pool.query("SELECT * FROM property_safety_scores WHERE property_id = $1", [
      propertyId,
    ]);

    // Nếu chưa có điểm -> Tính toán ngay (Lazy calculation)
    if (result.rowCount === 0) {
      if (!propertyData) {
         // Nếu phòng không tồn tại trong DB thì không thể tính
         return res.status(404).json({ error: "Phòng trọ không tồn tại." });
      }
      try {
        console.log(`[Cache Miss - GET] Đang tính điểm cho ID ${propertyId}...`);
        await runJob(propertyId); 
        result = await pool.query("SELECT * FROM property_safety_scores WHERE property_id = $1", [
          propertyId,
        ]);
      } catch (error) {
        console.error(`[LỖI API] Không thể chạy job an toàn: ${error.message}`);
      }
    }

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Chưa có dữ liệu điểm an toàn." });
    }

    const safetyData = result.rows[0];
    
    // Bước C: Tạo AI Summary nếu chưa có (Hoặc trả về null để Frontend chờ)
    let aiSummary = safetyData.ai_summary;
    const { crime_score, user_score, env_score } = safetyData;

    // Chỉ gọi AI khi có đủ điểm số
    if (!aiSummary && crime_score !== null) {
      const reviewsResult = await pool.query(
        "SELECT safety_rating, cleanliness_rating, amenities_rating, host_rating, review_text FROM reviews WHERE property_id = $1 ORDER BY created_at DESC LIMIT 10",
        [propertyId]
      );
      
      // [QUAN TRỌNG NHẤT]: Truyền mảng rỗng [] thay vì nearbyPlaces
      // Vì API GET không biết nearbyPlaces là gì, truyền [] để AI không bị lỗi.
      aiSummary = await generateAISummary(
        parseFloat(crime_score),
        parseFloat(user_score),
        parseFloat(env_score),
        propertyData || { title: "Phòng trọ", address: "Đà Nẵng" }, 
        [], // <--- KHẮC PHỤC LỖI 500 TẠI ĐÂY
        reviewsResult.rows
      );
    }

    res.status(200).json({
      ...safetyData,
      ai_summary: aiSummary,
      property_lat: propertyData.latitude,
      property_lng: propertyData.longitude, // <--- KHẮC PHỤC LỖI 500 TẠI ĐÂY
      property_address: propertyData.address || propertyData.addressDetails
    });

  } catch (err) {
    console.error(`[LỖI API GET] P_ID ${propertyId}: ${err.message}`);
    res.status(500).json({ error: "Lỗi máy chủ nội bộ: " + err.message });
  }
});
// ---------------------------------------------------------
// 2. API POST (CŨ - GIỮ NGUYÊN): Dành cho Client gửi kèm dữ liệu chi tiết
// ---------------------------------------------------------
router.post("/api/v1/properties/:id/safety", async (req, res) => {
  const propertyId = parseInt(req.params.id, 10);
  if (isNaN(propertyId)) {
    return res.status(400).json({ error: "ID phòng trọ không hợp lệ." });
  }
  
  // POST lấy dữ liệu từ Body
  const { property, nearbyPlaces } = req.body;

  try {
    let result = await pool.query("SELECT * FROM property_safety_scores WHERE property_id = $1", [
      propertyId,
    ]);
    
    if (result.rowCount === 0) {
      try {
        console.log(`[Cache Miss - POST] Đang tính điểm cho ID ${propertyId}...`);
        await runJob(propertyId);
        result = await pool.query("SELECT * FROM property_safety_scores WHERE property_id = $1", [
          propertyId,
        ]);
        if (result.rowCount === 0) {
          return res.status(404).json({ error: "Không tìm thấy điểm an toàn." });
        }
      } catch (error) {
        console.error(`[LỖI API] Không thể chạy job an toàn: ${error.message}`);
      }
    }

    const safetyData = result.rows[0];
    const { crime_score, user_score, env_score } = safetyData;

    let aiSummary = null;
    if (crime_score !== null && user_score !== null && env_score !== null) {
      const reviewsResult = await pool.query(
        "SELECT safety_rating, cleanliness_rating, amenities_rating, host_rating, review_text FROM reviews WHERE property_id = $1 ORDER BY created_at DESC",
        [propertyId]
      );
      
      // POST có ưu thế là nhận được nearbyPlaces từ client (nếu có)
      aiSummary = await generateAISummary(
        parseFloat(crime_score),
        parseFloat(user_score),
        parseFloat(env_score),
        property || { title: "Phòng trọ" }, // Fallback nếu body thiếu property
        nearbyPlaces || [], 
        [],
        reviewsResult.rows
      );
    }

    res.status(200).json({
      ...safetyData,
      ai_summary: aiSummary,
    });
  } catch (err) {
    console.error(`[LỖI API POST] P_ID ${propertyId}: ${err.message}`);
    res.status(500).json({ error: "Lỗi máy chủ nội bộ." });
  }
});

/**
 * Internal sync property endpoint
 */
router.post("/internal/sync/property", async (req, res) => {
  const { id, name, address, latitude, longitude } = req.body;
  try {
    await pool.query(
      `
            INSERT INTO properties (id, name, address, latitude, longitude)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name, address = EXCLUDED.address,
                latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude
        `,
      [id, name, address, latitude, longitude]
    );
    runJob(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
