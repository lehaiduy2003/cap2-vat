// server/runSafetyScoreJob.js
require("dotenv").config();
const { Client } = require("pg");

const dbConfig = {
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: parseInt(process.env.PGPORT, 10),
};

// --- HẰNG SỐ CẤU HÌNH ---
const WEIGHTS = { USER_SCORE: 0.4, CRIME_SCORE: 0.4, ENV_SCORE: 0.2 };
const SEVERITY_WEIGHTS = { low: 1.0, medium: 4.0, high: 8.0 };
const CRIME_HALF_LIFE_DAYS = 180; // Chu kỳ bán rã của sự cố (ngày)
const ENV_SEARCH_RADIUS_METERS = 1000; // 1km

// ===========================================
// HÀM HỖ TRỢ: ĐỒNG BỘ DỮ LIỆU TỪ API GỐC (JAVA CORE)
// ===========================================
async function syncProperty(propertyId, client) {
  if (!propertyId) return [];

  console.log(`[SYNC] Đang đồng bộ thông tin phòng ID ${propertyId} từ API gốc...`);
  try {
    // Gọi API Java Core (Dựa trên biến môi trường BASE_API_URL)
    const url = `${process.env.BASE_API_URL}/api/rooms/${propertyId}`;
    
    // Node.js 18+ hỗ trợ fetch native
    const res = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) {
      console.warn(`[SYNC FAIL] API trả về lỗi ${res.status} cho ID ${propertyId}`);
      return [];
    }

    const json = await res.json();
    const roomData = json.data || json; 

    if (!roomData || !roomData.id) {
       console.warn(`[SYNC FAIL] Dữ liệu API không hợp lệ cho ID ${propertyId}`);
       return [];
    }

    // Ghép địa chỉ
    const addressParts = [
      roomData.addressDetails,
      roomData.ward,
      roomData.district,
      roomData.city
    ].filter(p => p).join(", ");

    // UPSERT vào DB Local
    const insertQuery = {
      text: `
        INSERT INTO properties (id, name, address, latitude, longitude)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) 
        DO UPDATE SET
          name = EXCLUDED.name,
          address = EXCLUDED.address,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude
        RETURNING *;
      `,
      values: [
        roomData.id,
        roomData.title || "Phòng trọ chưa đặt tên",
        addressParts || "Chưa cập nhật địa chỉ",
        roomData.latitude,
        roomData.longitude
      ]
    };

    const result = await client.query(insertQuery);
    console.log(`[SYNC SUCCESS] Đã cập nhật phòng ID ${roomData.id}: ${roomData.title}`);
    return result.rows;

  } catch (err) {
    console.error(`[SYNC ERROR] Lỗi khi gọi API /api/rooms/${propertyId}:`, err.message);
    return [];
  }
}

// ===========================================
// 1. TÍNH ĐIỂM CỘNG ĐỒNG (USER)
// ===========================================
async function calculateUserScore(propertyId, client) {
  try {
    const res = await client.query(
      "SELECT AVG(safety_rating) as avg_rating FROM reviews WHERE property_id = $1",
      [propertyId]
    );
    if (!res.rows[0] || res.rows[0].avg_rating === null) return 5.0;
    return parseFloat(res.rows[0].avg_rating) * 2.0; // Quy đổi hệ 10
  } catch (err) {
    console.error(`[JOB ERROR] UserScore ID ${propertyId}: ${err.message}`);
    return 5.0;
  }
}

// ===========================================
// 2. TÍNH ĐIỂM TỘI PHẠM (LOGIC KHÔNG GIAN MỚI)
// ===========================================
async function calculateCrimeScore(property, client) {
  // Tìm sự cố gắn ID trực tiếp HOẶC sự cố trong bán kính 10km
  const query = {
    text: `
      SELECT 
        severity, 
        incident_date,
        property_id,
        ST_Distance(
            ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, 
            ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
        ) as distance_meters
      FROM security_incidents 
      WHERE 
        property_id = $1 
        OR (
          latitude IS NOT NULL AND longitude IS NOT NULL
          AND ST_DWithin(
            ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
            ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
            10000 -- Quét tối đa 10km
          )
        )
    `,
    values: [property.id, property.longitude, property.latitude],
  };

  let totalPenalty = 0.0;
  const today = new Date();

  try {
    const res = await client.query(query);
    if (res.rows.length === 0) return 10.0;

    for (const incident of res.rows) {
      // a. Trọng số mức độ
      const baseSeverity = SEVERITY_WEIGHTS[incident.severity] || 0.0;

      // b. Trọng số thời gian (Time Decay)
      const incidentDate = new Date(incident.incident_date);
      const daysOld = (today - incidentDate) / (1000 * 60 * 60 * 24);
      if (daysOld > 730 || daysOld < 0) continue; 
      const timeDecay = 0.5 ** (daysOld / CRIME_HALF_LIFE_DAYS);

      // c. Trọng số khoảng cách (Distance Decay) - Logic yêu cầu
      let distanceWeight = 0;
      const dist = incident.distance_meters;

      if (incident.property_id === property.id) {
          distanceWeight = 1.0; // Tại chỗ
      } else if (dist <= 1000) {
          distanceWeight = 1.0; // < 1km
      } else if (dist <= 5000) {
          distanceWeight = 0.5; // 1km - 5km
      } else if (dist <= 10000) {
          distanceWeight = 0.2; // 5km - 10km
      } else {
          distanceWeight = 0.0;
      }

      totalPenalty += baseSeverity * timeDecay * distanceWeight;
    }

    const finalScore = 10.0 - totalPenalty;
    return Math.max(0.0, finalScore);

  } catch (err) {
    console.error(`[JOB ERROR] CrimeScore ID ${property.id}: ${err.message}`);
    return 10.0;
  }
}

// ===========================================
// 3. TÍNH ĐIỂM MÔI TRƯỜNG (POI)
// ===========================================
async function calculateEnvScore(property, client) {
  const query = {
    text: `
        SELECT SUM(severity_score) AS total_weight_score
        FROM safety_points
        WHERE ST_DWithin(
            location,
            ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
            $3
        );
    `,
    values: [property.longitude, property.latitude, ENV_SEARCH_RADIUS_METERS],
  };

  try {
    const res = await client.query(query);
    const totalWeightScore = parseFloat(res.rows[0].total_weight_score || 0);
    const finalScore = 5.0 + totalWeightScore;
    return Math.max(0.0, Math.min(10.0, finalScore));
  } catch (err) {
    console.error(`[JOB ERROR] EnvScore ID ${property.id}: ${err.message}`);
    return 5.0;
  }
}

// ===========================================
// MAIN JOB (XỬ LÝ SONG SONG - BATCH)
// ===========================================
async function runJob(targetPropertyId = null) {
  const client = new Client(dbConfig);
  try {
    await client.connect();

    let properties = [];
    
    // 1. Lấy danh sách cần tính
    if (targetPropertyId) {
      // Tìm DB Local
      const res = await client.query("SELECT * FROM properties WHERE id = $1", [targetPropertyId]);
      properties = res.rows;

      // [QUAN TRỌNG] Nếu không có, gọi Sync từ Java Core
      if (properties.length === 0) {
        console.log(`[JOB INFO] Phòng ID ${targetPropertyId} chưa có. Syncing...`);
        properties = await syncProperty(targetPropertyId, client);
      }
    } else {
      // Cron Job: Lấy hết
      const res = await client.query("SELECT * FROM properties");
      properties = res.rows;
    }

    if (properties.length === 0) {
        console.log(`[JOB WARNING] Không có dữ liệu để xử lý.`);
        return; 
    }

    console.log(`[JOB] Đang tính điểm cho ${properties.length} phòng trọ...`);

    // 2. Chạy Batch (50 phòng/lần)
    const BATCH_SIZE = 50; 
    for (let i = 0; i < properties.length; i += BATCH_SIZE) {
        const batch = properties.slice(i, i + BATCH_SIZE);
        
        await Promise.all(batch.map(async (prop) => {
            try {
                if (prop.latitude == null || prop.longitude == null) return;

                const [userScore, crimeScore, envScore] = await Promise.all([
                    calculateUserScore(prop.id, client),
                    calculateCrimeScore(prop, client),
                    calculateEnvScore(prop, client)
                ]);

                const overallScore = (userScore * WEIGHTS.USER_SCORE) + 
                                     (crimeScore * WEIGHTS.CRIME_SCORE) + 
                                     (envScore * WEIGHTS.ENV_SCORE);

                await client.query(`
                    INSERT INTO property_safety_scores 
                        (property_id, overall_score, user_score, crime_score, environment_score, last_updated_at)
                    VALUES ($1, $2, $3, $4, $5, NOW())
                    ON CONFLICT (property_id) DO UPDATE SET
                        overall_score = EXCLUDED.overall_score,
                        user_score = EXCLUDED.user_score,
                        crime_score = EXCLUDED.crime_score,
                        environment_score = EXCLUDED.environment_score,
                        last_updated_at = NOW();
                `, [prop.id, overallScore.toFixed(1), userScore.toFixed(1), crimeScore.toFixed(1), envScore.toFixed(1)]);
                
            } catch (pErr) {
                console.error(`Lỗi xử lý ID ${prop.id}:`, pErr.message);
            }
        }));
    }
    console.log(`[JOB] Hoàn thành.`);
  } catch (err) {
    console.error("[JOB FATAL ERROR]", err);
  } finally {
    await client.end();
  }
}

module.exports = { runJob };