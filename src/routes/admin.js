/**
 * Admin Routes
 * Handles all admin-only API endpoints
 */

const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { runJob } = require("../runSafetyScoreJob");
// Middleware imports
const { adminAuth } = require("../middleware/auth");

// --- HELPER FUNCTION: ĐỒNG BỘ PHÒNG TRỌ (JIT SYNC) ---
// Hàm này đảm bảo Property ID luôn tồn tại trong bảng properties trước khi dùng
async function ensurePropertyExists(propertyId) {
  if (!propertyId) return;

  // 1. Kiểm tra trong DB nội bộ
  const checkRes = await pool.query("SELECT id FROM properties WHERE id = $1", [propertyId]);
  if (checkRes.rows.length > 0) return; // Đã có -> OK

  // 2. Nếu chưa có -> Gọi sang Java Core để lấy thông tin
  console.log(`[SYNC-URGENT] Phòng ID ${propertyId} chưa có. Đang tải từ Core...`);
  try {
    const BASE_API_URL = process.env.BASE_API_URL; // URL Java Core
    const url = `${BASE_API_URL}/api/rooms/${propertyId}`;
    const res = await fetch(url);

    if (!res.ok) throw new Error(`Core API trả về ${res.status}`);

    const json = await res.json();
    // Xử lý cấu trúc response: room nằm trong 'data' hoặc trực tiếp
    const room = json.data || json;

    if (!room || !room.id) throw new Error("Dữ liệu phòng không hợp lệ");

    // Tạo địa chỉ string
    const addressParts = [room.addressDetails, room.ward, room.district, room.city]
      .filter(Boolean)
      .join(", ");

    // 3. Insert vào DB nội bộ
    await pool.query(
      `
            INSERT INTO properties (id, name, address, latitude, longitude)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                address = EXCLUDED.address,
                latitude = EXCLUDED.latitude,
                longitude = EXCLUDED.longitude
        `,
      [room.id, room.title || "Phòng chưa đặt tên", addressParts, room.latitude, room.longitude]
    );

    console.log(`[SYNC-URGENT] Đã đồng bộ xong ID ${propertyId}`);
  } catch (err) {
    console.error(`[SYNC-FAIL] Không thể đồng bộ ID ${propertyId}:`, err.message);
    // Ném lỗi để chặn việc insert incident vào ID không tồn tại
    throw new Error(`Phòng trọ ID ${propertyId} không tồn tại hoặc chưa được đồng bộ.`);
  }
}

/**
 * API Tìm kiếm (Cho Dropdown)
 */
router.get("/admin/properties-search", adminAuth, async (req, res) => {
  const { q, lat, lng, radius } = req.query;
  try {
    let queryText = "";
    let queryValues = [];

    if (lat && lng) {
      queryText = `
                SELECT id, name, address,
                       ST_Distance(
                           ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
                           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
                       ) as dist
                FROM properties
                WHERE ST_DWithin(
                    ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
                    ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                    $3
                )
                ORDER BY dist ASC LIMIT 20;
            `;
      queryValues = [parseFloat(lng), parseFloat(lat), parseInt(radius || 100)];
    } else if (q) {
      queryText = `SELECT id, name, address FROM properties WHERE name ILIKE $1 OR address ILIKE $1 LIMIT 20;`;
      queryValues = [`%${q}%`];
    } else {
      return res.json([]);
    }

    const result = await pool.query(queryText, queryValues);
    res.json(result.rows);
  } catch (err) {
    console.error("[SEARCH ERROR]", err.message);
    res.status(500).json({ error: "Lỗi tìm kiếm." });
  }
});

/**
 * API Thêm sự cố (FIX LỖI FOREIGN KEY)
 */
router.post("/admin/incidents", adminAuth, async (req, res) => {
  const { property_id, incident_type, severity, incident_date, notes, latitude, longitude } =
    req.body;

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  const hasCoordinates = !isNaN(lat) && !isNaN(lng);

  if (!property_id && !hasCoordinates) {
    return res.status(400).json({ error: "Thiếu Property ID hoặc Tọa độ." });
  }
  try {
    // [FIX QUAN TRỌNG] Đảm bảo Property tồn tại trước khi insert Incident
    if (property_id) {
      await ensurePropertyExists(property_id);
    }
    // 1. Insert Sự cố
    const insertQuery = {
      text: `INSERT INTO security_incidents
             (property_id, incident_type, severity, incident_date, notes, latitude, longitude)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      values: [
        property_id || null,
        incident_type,
        severity,
        incident_date,
        notes || null,
        hasCoordinates ? lat : null,
        hasCoordinates ? lng : null,
      ],
    };

    const result = await pool.query(insertQuery);
    const newIncident = result.rows[0];

    // 2. Tìm hàng xóm bị ảnh hưởng (10km)
    const affectedIds = new Set();
    if (property_id) affectedIds.add(property_id);

    if (hasCoordinates) {
      const neighbors = await pool.query({
        text: `SELECT id FROM properties
                   WHERE ST_DWithin(
                     ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
                     ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                     10000
                   )`,
        values: [lng, lat],
      });
      neighbors.rows.forEach((r) => affectedIds.add(r.id));
    }

    // 3. Trigger Job tính điểm
    if (affectedIds.size > 0) {
      console.log(`[TRIGGER] Sự cố ảnh hưởng ${affectedIds.size} phòng. Recalc...`);
      (async () => {
        for (const pid of affectedIds) {
          await runJob(pid).catch((e) => console.error(`Job Fail ID ${pid}:`, e.message));
        }
      })();
    }

    res.status(201).json(newIncident);
  } catch (err) {
    console.error("[INCIDENT ERROR]", err.message);
    res.status(500).json({ error: err.message || "Lỗi Server." });
  }
});

module.exports = router;
