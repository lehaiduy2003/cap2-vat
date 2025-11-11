// runSafetyScoreJob.js
// Phiên bản 2.0: Tái cấu trúc thành Module

require("dotenv").config();
const { Client } = require("pg");

// --- Cấu hình Kết nối (Cho Job) ---
const dbConfig = {
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: parseInt(process.env.PGPORT, 10),
};

// --- HẰNG SỐ CỦA THUẬT TOÁN ---

// Trọng số cho điểm tổng
const WEIGHTS = {
  USER_SCORE: 0.4,
  CRIME_SCORE: 0.4,
  ENV_SCORE: 0.2,
};

// Trọng số cho mức độ nghiêm trọng (Tội phạm)
const SEVERITY_WEIGHTS = {
  low: 1.0,
  medium: 4.0,
  high: 8.0,
};

// Chu kỳ bán rã (ngày)
const CRIME_HALF_LIFE_DAYS = 180;

// Bán kính tìm kiếm POI (mét)
const ENV_SEARCH_RADIUS_METERS = 1000; // 1km

// Điểm cơ bản cho Môi trường
const ENV_BASE_SCORE = 5.0;

// ===========================================
// HÀM TÍNH TOÁN 1: ĐIỂM CỘNG ĐỒNG (USER)
// ===========================================
async function calculateUserScore(propertyId, client) {
  const query = {
    text: "SELECT AVG(safety_rating) as avg_rating FROM reviews WHERE property_id = $1",
    values: [propertyId],
  };
  try {
    const res = await client.query(query);
    if (!res.rows[0] || res.rows[0].avg_rating === null) {
      return 5.0; // Điểm trung lập
    }
    const avgRating = parseFloat(res.rows[0].avg_rating);
    // Thêm bước kiểm tra NaN để phòng trường hợp giá trị từ DB không hợp lệ
    if (isNaN(avgRating)) {
      console.warn(
        `[WARN JOB] P_ID ${propertyId}: avg_rating trả về NaN. Giá trị gốc: ${res.rows[0].avg_rating}. Trả về điểm trung lập.`
      );
      return 5.0; // Điểm trung lập
    }
    return avgRating * 2.0; // Chuẩn hóa 1-5 sao -> 0-10 điểm
  } catch (err) {
    console.error(`[LỖI JOB] calculateUserScore P_ID ${propertyId}: ${err.message}`);
    return null; // Trả về null nếu lỗi
  }
}

// ===========================================
// HÀM TÍNH TOÁN 2: ĐIỂM TỘI PHẠM (CRIME)
// ===========================================
async function calculateCrimeScore(propertyId, client) {
  const query = {
    text: "SELECT severity, incident_date FROM security_incidents WHERE property_id = $1",
    values: [propertyId],
  };

  let totalPenalty = 0.0;
  const today = new Date();

  try {
    const res = await client.query(query);
    if (res.rows.length === 0) {
      return 10.0; // An toàn tuyệt đối
    }

    for (const incident of res.rows) {
      const basePenalty = SEVERITY_WEIGHTS[incident.severity] || 0.0;
      const incidentDate = new Date(incident.incident_date);
      const daysOld = (today - incidentDate) / (1000 * 60 * 60 * 24);

      // Bỏ qua nếu quá cũ (2 năm) hoặc ngày trong tương lai
      if (daysOld > 730 || daysOld < 0) continue;

      // Công thức Time Decay
      const decayFactor = 0.5 ** (daysOld / CRIME_HALF_LIFE_DAYS);
      totalPenalty += basePenalty * decayFactor;
    }

    const finalScore = 10.0 - totalPenalty;
    return Math.max(0.0, finalScore); // Đảm bảo không âm
  } catch (err) {
    console.error(`[LỖI JOB] calculateCrimeScore P_ID ${propertyId}: ${err.message}`);
    return null; // Trả về null nếu lỗi
  }
}

// ===========================================
// HÀM TÍNH TOÁN 3: ĐIỂM MÔI TRƯỜNG (ENV)
// ===========================================
async function calculateEnvScore(property, client) {
  // Dùng PostGIS
  const query = {
    text: `
            SELECT SUM(severity_score) AS total_weight_score
            FROM safety_points
            WHERE ST_DWithin(
                location, -- Cột 'geography' của safety_points
                ST_MakePoint($1, $2)::geography, -- Điểm 'geography' của phòng trọ
                $3 -- Bán kính (mét)
            );
        `,
    values: [
      property.longitude, // PostGIS dùng (longitude, latitude)
      property.latitude,
      ENV_SEARCH_RADIUS_METERS,
    ],
  };

  try {
    const res = await client.query(query);
    let totalWeightScore = 0;

    if (res.rows.length > 0 && res.rows[0].total_weight_score !== null) {
      const parsedScore = parseFloat(res.rows[0].total_weight_score);
      if (isNaN(parsedScore)) {
        console.warn(
          `[WARN JOB] P_ID ${property.id}: total_weight_score trả về NaN. Giá trị gốc: ${res.rows[0].total_weight_score}. Sử dụng giá trị 0.`
        );
        totalWeightScore = 0;
      } else {
        totalWeightScore = parsedScore;
      }
    }

    const finalScore = ENV_BASE_SCORE + totalWeightScore;

    // Kẹp điểm trong khoảng [0, 10]
    return Math.max(0.0, Math.min(10.0, finalScore));
  } catch (err) {
    console.error(`[LỖI JOB] calculateEnvScore P_ID ${property.id}: ${err.message}`);
    return null; // Trả về null nếu lỗi
  }
}

// ===========================================
// HÀM CHÍNH (MAIN JOB)
// ===========================================

/**
 * Chạy Job tính điểm an toàn.
 * @param {number | null} targetPropertyId - Nếu là số, chỉ chạy cho 1 P_ID. Nếu null, chạy cho tất cả.
 */
async function runJob(targetPropertyId = null) {
  const client = new Client(dbConfig);

  try {
    await client.connect();

    // 1. Lấy danh sách phòng trọ cần xử lý
    let propertiesQuery;
    if (targetPropertyId) {
      propertiesQuery = {
        text: "SELECT * FROM properties WHERE id = $1",
        values: [targetPropertyId],
      };
    } else {
      propertiesQuery = "SELECT * FROM properties";
    }

    let properties = await client.query(propertiesQuery);
    if (properties.rowCount === 0) {
      const syncedProperties = await syncProperty(targetPropertyId, client);
      if (!syncedProperties || syncedProperties.length === 0) {
        console.warn(`[JOB WARNING] Không tìm thấy phòng trọ nào để xử lý. Kết thúc Job.`);
        return; // Kết thúc Job nếu không lấy được phòng trọ
      }
      properties = { rows: syncedProperties };
    }

    // 2. Lặp qua từng phòng và tính điểm
    for (const prop of properties.rows) {
      const userScore = await calculateUserScore(prop.id, client);
      const crimeScore = await calculateCrimeScore(prop.id, client);
      const envScore = await calculateEnvScore(prop, client);

      // 3. Xử lý lỗi (Rất quan trọng)
      // Nếu 1 trong 3 hàm con bị lỗi hoặc trả về NaN, bỏ qua phòng này
      if (
        userScore === null ||
        crimeScore === null ||
        envScore === null ||
        isNaN(userScore) ||
        isNaN(crimeScore) ||
        isNaN(envScore)
      ) {
        console.warn(
          `-> [BỎ QUA] P_ID ${prop.id} do không thể tính toán đủ 3 thành phần điểm hoặc có giá trị NaN. userScore: ${userScore}, crimeScore: ${crimeScore}, envScore: ${envScore}`
        );
        continue; // Sang phòng tiếp theo
      }

      // 4. Tính điểm tổng hợp
      const overallScore =
        userScore * WEIGHTS.USER_SCORE +
        crimeScore * WEIGHTS.CRIME_SCORE +
        envScore * WEIGHTS.ENV_SCORE;

      // 5. Lưu kết quả vào DB (UPSERT)
      const upsertQuery = {
        text: `
            INSERT INTO property_safety_scores 
                (property_id, overall_score, user_score, crime_score, environment_score, last_updated_at)
            VALUES 
                ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (property_id) 
            DO UPDATE SET
                overall_score = EXCLUDED.overall_score,
                user_score = EXCLUDED.user_score,
                crime_score = EXCLUDED.crime_score,
                environment_score = EXCLUDED.environment_score,
                last_updated_at = NOW();
        `,
        values: [
          prop.id,
          overallScore.toFixed(1),
          userScore.toFixed(1),
          crimeScore.toFixed(1),
          envScore.toFixed(1),
        ],
      };

      await client.query(upsertQuery);
    }
  } catch (err) {
    // Lỗi kết nối hoặc lỗi truy vấn 'properties'
    console.error(`[JOB ERROR] Job thất bại: ${err.message}`, err.stack);
  } finally {
    await client.end();
  }
}

async function syncProperty(propertyId, client) {
  // Kiểm tra nếu property đã tồn tại
  try {
    let url;
    if (propertyId) {
      url = `${process.env.BASE_API_URL}/api/rooms/${propertyId}`;
    } else {
      url = `${process.env.BASE_API_URL}/api/rooms?limit=1000`; // Giới hạn 1000 phòng trọ cho mỗi lần đồng bộ
    }

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    const json = await res.json();
    const data = json.data; // Giả sử response có { data: [roomDTO] }
    const rooms = Array.isArray(data) ? data : [data];

    if (rooms.length === 0) return; // Kết thúc Job nếu không lấy được phòng trọ

    const values = rooms.map((room) => {
      const addressParts = [room.addressDetails, room.ward, room.district, room.city]
        .filter((part) => part)
        .join(", ");
      room.address = addressParts;
      return `(${room.id}, '${room.title}', '${room.address}', ${room.latitude}, ${room.longitude})`;
    });
    const syncQuery = {
      text: `
            INSERT INTO properties (id, name, address, latitude, longitude)
            VALUES ${values.join(", ")}
            ON CONFLICT (id)
            DO UPDATE SET
                name = EXCLUDED.name,
                address = EXCLUDED.address,
                latitude = EXCLUDED.latitude,
                longitude = EXCLUDED.longitude
            RETURNING *;
          `,
    };
    const result = await client.query(syncQuery);
    return result.rows; // Return the array of updated properties
  } catch (syncError) {
    console.error(`[SYNC FAILED] Không thể đồng bộ P_ID ${propertyId}:`, syncError.message);
    return; // Kết thúc Job nếu không lấy được phòng trọ
  }
}
module.exports = {
  runJob,
};
