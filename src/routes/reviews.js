/**
 * Review Routes
 * Handles all review-related API endpoints
 */

const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { runJob } = require("../runSafetyScoreJob");

// Middleware imports
const { userAuth } = require("../middleware/auth");

/**
 * API CHO NGƯỜI DÙNG: Lấy reviews của một property với phân trang
 */
router.get("/reviews/:property_id", async (req, res) => {
  const propertyId = parseInt(req.params.property_id, 10);
  if (isNaN(propertyId)) {
    return res.status(400).json({ error: "ID phòng trọ không hợp lệ." });
  }

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const offset = (page - 1) * limit;

  try {
    // Lấy tổng số reviews
    const countResult = await pool.query(
      "SELECT COUNT(*) as total FROM reviews WHERE property_id = $1",
      [propertyId]
    );
    const total = parseInt(countResult.rows[0].total, 10) || 0;

    // Lấy reviews với phân trang
    const reviewsResult = await pool.query(
      `SELECT
                r.*,
                CASE
                    WHEN r.user_id = $2 THEN 'Bạn'
                    ELSE 'Người dùng ẩn danh'
                END as reviewer_name
             FROM reviews r
             WHERE property_id = $1
             ORDER BY created_at DESC
             LIMIT $3 OFFSET $4`,
      [propertyId, req.user_id || null, limit, offset]
    );

    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      reviews: reviewsResult.rows,
      pagination: {
        currentPage: page,
        totalPages,
        totalItems: total,
        itemsPerPage: limit,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    });
  } catch (err) {
    console.error(`[LỖI API GET REVIEWS] P_ID ${propertyId}: ${err.message}`);
    res.status(500).json({ error: "Lỗi máy chủ nội bộ." });
  }
});

/**
 * API CHO NGƯỜI DÙNG: Thêm hoặc Sửa review (Upsert)
 */
router.post("/reviews", userAuth, async (req, res) => {
  const {
    property_id,
    rentHistoryId,
    safety_rating,
    cleanliness_rating,
    amenities_rating,
    host_rating,
    review_text,
  } = req.body;
  const user_id = req.user_id;

  const propId = parseInt(property_id, 10);
  if (isNaN(propId)) {
    return res.status(400).json({ error: "ID phòng trọ không hợp lệ." });
  }

  try {
    const query = {
      text: `
                INSERT INTO reviews (
                    property_id, user_id, safety_rating, review_text, created_at,
                    cleanliness_rating, amenities_rating, host_rating
                )
                VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7)
                ON CONFLICT (property_id, user_id)
                DO UPDATE SET
                    safety_rating = EXCLUDED.safety_rating,
                    review_text = EXCLUDED.review_text,
                    created_at = NOW(),
                    cleanliness_rating = EXCLUDED.cleanliness_rating,
                    amenities_rating = EXCLUDED.amenities_rating,
                    host_rating = EXCLUDED.host_rating
                RETURNING *;
            `,
      values: [
        propId,
        user_id,
        parseInt(safety_rating) || 5,
        review_text || null,
        parseInt(cleanliness_rating) || 5,
        parseInt(amenities_rating) || 5,
        parseInt(host_rating) || 5,
      ],
    };

    const result = await pool.query(query);
    const newReview = result.rows[0];

    // Cập nhật bên Java Core (nếu có rentHistoryId)
    if (rentHistoryId && rentHistoryId !== "undefined" && rentHistoryId !== "null") {
      try {
        const BASE_API_URL = process.env.BASE_API_URL;
        await fetch(
          `${BASE_API_URL}/api/rent-histories/reviews/${rentHistoryId}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Authorization: req.headers.authorization,
            },
          }
        );
      } catch (patchError) {
        console.error(
          `[PATCH ERROR] Lỗi khi cập nhật rent history ${rentHistoryId}:`,
          patchError.message
        );
      }
    }

    // Trigger tính lại điểm
    runJob(propId).catch((err) => {
      console.error(`[JOB-RECALC] Lỗi tính lại điểm cho P_ID ${propId}:`, err);
    });

    res.status(201).json(newReview);
  } catch (err) {
    console.error("[LỖI API POST]", err.message);
    res.status(500).json({ error: "Lỗi máy chủ nội bộ khi thêm review." });
  }
});

/**
 * API MỚI (BẠN ĐANG THIẾU): Xóa review của chính mình
 */
router.delete("/reviews/:property_id", userAuth, async (req, res) => {
  const propertyId = parseInt(req.params.property_id, 10);
  const userId = req.user_id;

  if (isNaN(propertyId)) {
    return res.status(400).json({ error: "ID phòng trọ không hợp lệ." });
  }

  try {
    // Xóa review khớp cả PropertyID và UserID (chỉ xóa của chính mình)
    const result = await pool.query(
      "DELETE FROM reviews WHERE property_id = $1 AND user_id = $2 RETURNING *",
      [propertyId, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Không tìm thấy đánh giá của bạn để xóa." });
    }

    // Trigger tính lại điểm an toàn sau khi xóa
    runJob(propertyId).catch((err) => {
      console.error(`[JOB-DELETE] Lỗi tính lại điểm ID ${propertyId}:`, err);
    });

    res.status(200).json({ message: "Đã xóa đánh giá thành công." });
  } catch (err) {
    console.error(`[API DELETE REVIEW] Lỗi: ${err.message}`);
    res.status(500).json({ error: "Lỗi máy chủ nội bộ." });
  }
});

module.exports = router;