const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { userAuth } = require("../middleware/auth");


// API: Người dùng báo cáo điểm ngập lụt
router.post("/flood-reports", userAuth, async (req, res) => {
  const { latitude, longitude, water_level, description } = req.body;
  const user_id = req.user_id;

  // Validate dữ liệu
  if (!latitude || !longitude || !water_level) {
    return res.status(400).json({ error: "Thiếu thông tin tọa độ hoặc mức nước." });
  }

  try {
    // Lưu vào bảng flood_reports
    // Sử dụng PostGIS để tạo điểm địa lý từ lat/long
    const query = `
      INSERT INTO flood_reports (user_id, water_level, description, report_date, location)
      VALUES ($1, $2, $3, NOW(), ST_SetSRID(ST_MakePoint($5, $4), 4326))
      RETURNING id;
    `;

    await pool.query(query, [
      user_id,
      parseInt(water_level),
      description,
      parseFloat(latitude),
      parseFloat(longitude),
    ]);

    // [Tùy chọn] Trigger tính lại điểm cho các phòng trọ xung quanh ngay lập tức
    // Tìm các phòng trọ trong bán kính 200m và chạy lại Job
    const nearbyProps = await pool.query(
      `
      SELECT id FROM properties 
      WHERE ST_DWithin(
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
        200
      )
    `,
      [parseFloat(longitude), parseFloat(latitude)]
    );

    // Chạy ngầm (Fire & Forget)
    nearbyProps.rows.forEach((row) => {
      runJob(row.id).catch((e) => console.error(`Recalc failed for prop ${row.id}`));
    });

    res.status(201).json({ success: true, message: "Cảm ơn bạn đã báo cáo điểm ngập!" });
  } catch (err) {
    console.error("[FLOOD REPORT ERROR]", err.message);
    res.status(500).json({ error: "Lỗi server khi lưu báo cáo." });
  }
});
// API: Lấy lịch sử điểm ngập lụt gần vị trí người dùng
router.get("/flood-reports", async (req, res) => {
  const { lat, lng } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ error: "Missing lat/lng" });
  }

  try {
    const query = `
      SELECT 
        id, 
        water_level, 
        description, 
        report_date,
        ST_Distance(
          location, 
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) as distance_meters
      FROM flood_reports
      WHERE ST_DWithin(
        location, 
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 
        100 -- Lấy bán kính 100m xung quanh trọ
      )
      ORDER BY report_date DESC
      LIMIT 20
    `;

    const result = await pool.query(query, [parseFloat(lng), parseFloat(lat)]);

    res.json(result.rows);
  } catch (err) {
    console.error("[GET FLOOD HISTORY ERROR]", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;