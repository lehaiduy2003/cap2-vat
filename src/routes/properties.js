/**
 * Property Routes
 * Handles all property-related API endpoints
 */

const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { runJob } = require("../runSafetyScoreJob");
const { generateAISummary } = require("../aiUtils");

/**
 * Get safety score for a property
 */
router.post("/properties/:id/safety", async (req, res) => {
  const propertyId = parseInt(req.params.id, 10);
  if (isNaN(propertyId)) {
    return res.status(400).json({ error: "ID phòng trọ không hợp lệ." });
  }
  const { property, nearbyPlaces } = req.body;

  try {
    let result = await pool.query("SELECT * FROM property_safety_scores WHERE property_id = $1", [
      propertyId,
    ]);
    if (result.rowCount === 0) {
      try {
        await runJob(propertyId);
        result = await pool.query("SELECT * FROM property_safety_scores WHERE property_id = $1", [
          propertyId,
        ]);
        if (result.rowCount === 0) {
          return res
            .status(404)
            .json({ error: "Không tìm thấy điểm an toàn. (Job chưa chạy hoặc không có dữ liệu)" });
        }
      } catch (error) {
        console.error(`[LỖI API] Không thể chạy job an toàn: ${error.message}`);
      }
    }

    const safetyData = result.rows[0];
    const { crime_score, user_score, env_score } = safetyData;

    // Generate AI summary if scores are available
    let aiSummary = null;
    if (crime_score !== null && user_score !== null && env_score !== null) {
      const crimeScore = parseFloat(crime_score);
      const userScore = parseFloat(user_score);
      const envScore = parseFloat(env_score);

      // Fetch reviews for the property
      const reviewsResult = await pool.query(
        "SELECT safety_rating, cleanliness_rating, amenities_rating, host_rating, review_text FROM reviews WHERE property_id = $1 ORDER BY created_at DESC",
        [propertyId]
      );
      const reviews = reviewsResult.rows;

      aiSummary = await generateAISummary(
        crimeScore,
        userScore,
        envScore,
        property,
        nearbyPlaces,
        reviews
      );
    }

    res.status(200).json({
      ...safetyData,
      ai_summary: aiSummary,
    });
  } catch (err) {
    console.error(`[LỖI API GET] P_ID ${propertyId}: ${err.message}`);
    res.status(500).json({ error: "Lỗi máy chủ nội bộ." });
  }
});

// --- API SAFETY WIDGET (ĐÃ FIX) ---
router.get("/properties/:id/safety", async (req, res) => {
  const propertyId = parseInt(req.params.id, 10);
  const includeAi = req.query.include_ai === "true";

  try {
    // 1. Lấy thông tin phòng
    let propRes = await pool.query("SELECT * FROM properties WHERE id = $1", [propertyId]);
    if (propRes.rowCount === 0) {
      // fetch property via BE api
      await runJob(propertyId);
      propRes = await pool.query("SELECT * FROM properties WHERE id = $1", [propertyId]);
      // Still not found after run job
      if (propRes.rowCount === 0) {
        return res.status(404).json({ error: "Không tìm thấy phòng trọ." });
      }
    }

    const propertyData = propRes.rows[0];

    // Lấy reviews
    const reviews = await pool.query(
      "SELECT safety_rating, cleanliness_rating, amenities_rating, host_rating, review_text FROM reviews WHERE property_id = $1 ORDER BY created_at DESC",
      [propertyId]
    );

    // 2. Lấy điểm số
    let scores = await pool.query("SELECT * FROM property_safety_scores WHERE property_id = $1", [
      propertyId,
    ]);
    if (scores.rowCount === 0) {
      // still no scores even run job
      return res.status(404).json({ error: "Không tìm thấy dữ liệu an toàn cho phòng trọ này." });
    }

    // Fallback nếu tính toán lỗi
    const safetyData = scores.rows[0] || { crime_score: 0, user_score: 0, environment_score: 0 };

    // 3. Logic AI On-demand
    let aiSummary;
    if (includeAi && !aiSummary) {
      aiSummary = await generateAISummary(
        safetyData.crime_score, // Hàm bên kia sẽ tự ép kiểu Number()
        safetyData.user_score,
        safetyData.environment_score,
        propertyData,
        [],
        reviews.rows
      );
    }

    res.json({ ...safetyData, ai_summary: aiSummary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
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
