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
 * API CHO NGƯỜI DÙNG: Thêm review cho một property
 */
router.post("/reviews", userAuth, async (req, res) => {
  // 1. Lấy dữ liệu từ body (THÊM CÁC TRƯỜNG MỚI)
  const {
    property_id,
    rentHistoryId,
    safety_rating,
    cleanliness_rating, // <-- MỚI
    amenities_rating, // <-- MỚI
    host_rating, // <-- MỚI
    review_text,
  } = req.body;
  const user_id = req.user_id; // Lấy từ middleware 'userAuth'

  // 2. Validate dữ liệu
  const ratingSa = parseInt(safety_rating, 10);
  const ratingCl = parseInt(cleanliness_rating, 10); // <-- MỚI
  const ratingAm = parseInt(amenities_rating, 10); // <-- MỚI
  const ratingHo = parseInt(host_rating, 10); // <-- MỚI
  const propId = parseInt(property_id, 10);

  // Validate tất cả các trường 1-5 sao
  const allRatings = [ratingSa, ratingCl, ratingAm, ratingHo];
  if (isNaN(propId) || allRatings.some((r) => isNaN(r) || r < 1 || r > 5)) {
    return res.status(400).json({
      error: 'Dữ liệu không hợp lệ. "property_id" và tất cả các mục 1-5 sao là bắt buộc.',
    });
  }

  // 2.5. Kiểm tra xem property có tồn tại không
  try {
    const propertyCheck = await pool.query("SELECT id FROM properties WHERE id = $1", [propId]);
    if (propertyCheck.rowCount === 0) {
      try {
        // Kích hoạt tính điểm lại ngay cho phòng này
        await runJob(propId);
      } catch (syncError) {
        return res.status(404).json({
          error: "Phòng trọ không tồn tại hoặc không thể đồng bộ.",
        });
      }
    }
  } catch (err) {
    console.error("[LỖI CHECK PROPERTY]", err.message);
    return res.status(500).json({ error: "Lỗi máy chủ nội bộ khi kiểm tra phòng trọ." });
  }

  // 3. INSERT vào CSDL (CẬP NHẬT QUERY)
  try {
    const query = {
      text: `
                INSERT INTO reviews (
                    property_id, user_id, safety_rating, review_text, created_at,
                    cleanliness_rating, amenities_rating, host_rating -- <-- CỘT MỚI
                )
                VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7) -- <-- VALUES MỚI
                ON CONFLICT (property_id, user_id)
                DO UPDATE SET
                    safety_rating = EXCLUDED.safety_rating,
                    review_text = EXCLUDED.review_text,
                    created_at = NOW(),
                    cleanliness_rating = EXCLUDED.cleanliness_rating, -- <-- CẬP NHẬT MỚI
                    amenities_rating = EXCLUDED.amenities_rating,     -- <-- CẬP NHẬT MỚI
                    host_rating = EXCLUDED.host_rating                -- <-- CẬP NHẬT MỚI
                RETURNING *;
            `,
      values: [
        propId,
        user_id,
        ratingSa,
        review_text || null,
        ratingCl,
        ratingAm,
        ratingHo, // <-- THAM SỐ MỚI
      ],
    };

    const result = await pool.query(query);
    const newReview = result.rows[0];

    try {
      const BASE_API_URL = process.env.BASE_API_URL; // URL Java Core
      const patchResponse = await fetch(
        `${BASE_API_URL}/api/rent-histories/reviews/${rentHistoryId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: req.headers.authorization, // Forward the auth token
          },
        }
      );
      if (!patchResponse.ok) {
        console.error(
          `[PATCH FAILED] Không thể cập nhật rent history ${rentHistoryId}: ${patchResponse.status}`
        );
      }
    } catch (patchError) {
      console.error(
        `[PATCH ERROR] Lỗi khi cập nhật rent history ${rentHistoryId}:`,
        patchError.message
      );
    }

    // 4. Phản hồi cho User ngay lập tức
    res.status(201).json(newReview);

    // 5. [TỐI ƯU] Kích hoạt tính toán lại điểm (KHÔNG THAY ĐỔI)
    // Job này vẫn chỉ quan tâm 'safety_rating'.
    runJob(propId).catch((err) => {
      console.error(`[JOB-RECALC] Lỗi tính lại điểm cho P_ID ${propId}:`, err);
    });
  } catch (err) {
    console.error("[LỖI API POST]", err.message);
    if (err.code === "23505") {
      return res.status(409).json({ error: "Bạn đã review phòng trọ này rồi." });
    }
    res.status(500).json({ error: "Lỗi máy chủ nội bộ khi thêm review." });
  }
});

module.exports = router;
