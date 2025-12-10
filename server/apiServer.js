// server/apiServer.js
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const cron = require("node-cron");

const { runJob } = require("./runSafetyScoreJob");
const { generateAISummary } = require("./aiUtils");

const app = express();
const PORT = process.env.API_PORT || 3000;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const BASE_API_URL = process.env.BASE_API_URL; // URL Java Core

const dbConfig = {
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: parseInt(process.env.PGPORT, 10),
};

const pool = new Pool(dbConfig);
pool.on("error", (err) => console.error("[DB POOL ERROR]", err));

app.use(cors());
app.use(express.json());
const publicPath = path.join(__dirname, "../public");
app.use(express.static(publicPath));

// --- MIDDLEWARES ---
const adminAuth = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey && apiKey === ADMIN_API_KEY) next();
  else res.status(401).json({ error: "Unauthorized: Sai API Key." });
};
const userAuth = (req, res, next) => {
  const userId = req.headers["x-user-id"];
  if (userId && !isNaN(parseInt(userId, 10))) {
    req.user_id = parseInt(userId, 10);
    next();
  } else {
    res.status(401).json({ error: "Unauthorized: Thiếu hoặc sai x-user-id header." });
  }
};
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
        const url = `${BASE_API_URL}/api/rooms/${propertyId}`;
        const res = await fetch(url);
        
        if (!res.ok) throw new Error(`Core API trả về ${res.status}`);
        
        const json = await res.json();
        // Xử lý cấu trúc response: room nằm trong 'data' hoặc trực tiếp
        const room = json.data || json;

        if (!room || !room.id) throw new Error("Dữ liệu phòng không hợp lệ");

        // Tạo địa chỉ string
        const addressParts = [room.addressDetails, room.ward, room.district, room.city].filter(Boolean).join(", ");

        // 3. Insert vào DB nội bộ
        await pool.query(`
            INSERT INTO properties (id, name, address, latitude, longitude)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                address = EXCLUDED.address,
                latitude = EXCLUDED.latitude,
                longitude = EXCLUDED.longitude
        `, [room.id, room.title || "Phòng chưa đặt tên", addressParts, room.latitude, room.longitude]);
        
        console.log(`[SYNC-URGENT] Đã đồng bộ xong ID ${propertyId}`);

    } catch (err) {
        console.error(`[SYNC-FAIL] Không thể đồng bộ ID ${propertyId}:`, err.message);
        // Ném lỗi để chặn việc insert incident vào ID không tồn tại
        throw new Error(`Phòng trọ ID ${propertyId} không tồn tại hoặc chưa được đồng bộ.`);
    }
}
app.get("/api/v1/reviews/:property_id", async (req, res) => {
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
// --- CRON JOB ---
cron.schedule("0 0,12 * * *", () => {
    runJob(null).catch((err) => console.error("[CRON] Thất bại:", err));
}, { timezone: "Asia/Ho_Chi_Minh" });


// ================= API ENDPOINTS =================

// 1. API Tìm kiếm (Cho Dropdown)
app.get("/api/v1/admin/properties-search", adminAuth, async (req, res) => {
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

// 2. API Thêm sự cố (FIX LỖI FOREIGN KEY)
app.post("/api/v1/admin/incidents", adminAuth, async (req, res) => {
  const { property_id, incident_type, severity, incident_date, notes, latitude, longitude } = req.body;
  
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
      values: [property_id || null, incident_type, severity, incident_date, notes || null, hasCoordinates ? lat : null, hasCoordinates ? lng : null],
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
            values: [lng, lat]
        });
        neighbors.rows.forEach(r => affectedIds.add(r.id));
    }

    // 3. Trigger Job tính điểm
    if (affectedIds.size > 0) {
        console.log(`[TRIGGER] Sự cố ảnh hưởng ${affectedIds.size} phòng. Recalc...`);
        (async () => {
            for (const pid of affectedIds) {
                await runJob(pid).catch(e => console.error(`Job Fail ID ${pid}:`, e.message));
            }
        })();
    }

    res.status(201).json(newIncident);

  } catch (err) {
    console.error("[INCIDENT ERROR]", err.message);
    res.status(500).json({ error: err.message || "Lỗi Server." });
  }
});
// --- CÁC API CŨ ---
app.post("/api/v1/properties/:id/safety", async (req, res) => {
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

/**
 * API CHO NGƯỜI DÙNG: Lấy reviews của một property với phân trang
 */
app.post("/api/v1/reviews", userAuth, async (req, res) => {
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

app.post("/api/v1/internal/sync/property", async (req, res) => {
    const { id, name, address, latitude, longitude } = req.body;
    try {
        await pool.query(`
            INSERT INTO properties (id, name, address, latitude, longitude)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name, address = EXCLUDED.address,
                latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude
        `, [id, name, address, latitude, longitude]);
        runJob(id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", (req, res) => res.json({ status: "OK" }));

app.listen(PORT, () => {
  console.log(`[SERVER] Running on http://localhost:${PORT}`);
});