// server/services/SafetyScoreService.js
const { pool } = require("../config/db");

const CONSTANTS = {
  WEIGHTS: { USER: 0.4, CRIME: 0.4, ENV: 0.2 },
  CRIME: {
    MAX_DISTANCE: 5000, // 5km
    DECAY_K: 0.001, // Hệ số suy giảm: e^(-0.001 * distance)
    HALF_LIFE_DAYS: 180,
    MAX_PENALTY: 40 // Điểm phạt tối đa để chuẩn hóa về thang 10
  },
  ENV: { RADIUS: 1000 }
};

class SafetyScoreService {
  // 1. Tính điểm Cộng Đồng (User) - Giữ nguyên logic trung bình
  async calculateUserScore(client, propertyId) {
    const res = await client.query(
      "SELECT AVG(safety_rating) as avg_rating FROM reviews WHERE property_id = $1",
      [propertyId]
    );
    if (!res.rows[0] || !res.rows[0].avg_rating) return 8.0; // Mặc định 8.0 nếu chưa có review
    return parseFloat(res.rows[0].avg_rating) * 2.0; // Quy đổi thang 5 -> 10
  }

  // 2. Tính điểm An Ninh (Crime) - SỬA LỖI TRỒI SỤT
  async calculateCrimeScore(client, prop) {
    if (!prop.latitude || !prop.longitude) return 10.0;

    // Chỉ lấy sự cố trong phạm vi ảnh hưởng
    const res = await client.query(`
      SELECT severity, incident_date,
             ST_Distance(
               ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
               ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
             ) as dist
      FROM security_incidents
      WHERE ST_DWithin(
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
        $3
      )
    `, [prop.longitude, prop.latitude, CONSTANTS.CRIME.MAX_DISTANCE]);

    let totalPenalty = 0;
    const severityMap = { low: 2, medium: 5, high: 10 }; // Trọng số mức độ
    const today = new Date();

    for (const row of res.rows) {
      const severity = severityMap[row.severity] || 2;
      
      // Suy giảm theo thời gian (Time Decay)
      const daysOld = (today - new Date(row.incident_date)) / (86400000);
      if (daysOld < 0 || daysOld > 730) continue;
      const timeFactor = Math.pow(0.5, daysOld / CONSTANTS.CRIME.HALF_LIFE_DAYS);

      // [FIX QUAN TRỌNG] Suy giảm theo khoảng cách (Distance Decay - Continuous)
      // Hàm mũ giúp điểm số không bị nhảy bậc thang khi khoảng cách thay đổi nhỏ
      const distFactor = Math.exp(-CONSTANTS.CRIME.DECAY_K * row.dist);

      totalPenalty += severity * timeFactor * distFactor;
    }

    // Chuẩn hóa: 10 - điểm phạt. Không bao giờ âm.
    const score = 10.0 - (totalPenalty / CONSTANTS.CRIME.MAX_PENALTY * 10.0);
    return Math.max(0.0, Math.min(10.0, score));
  }

  // 3. Tính điểm Môi Trường (Tiện ích)
  async calculateEnvScore(client, prop) {
    if (!prop.latitude || !prop.longitude) return 5.0;
    
    // Tìm các điểm an toàn xung quanh (Đồn CA, chốt dân phòng...)
    const res = await client.query(`
        SELECT SUM(severity_score) as total_bonus 
        FROM safety_points 
        WHERE ST_DWithin(
            location, 
            ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 
            $3
        )
    `, [prop.longitude, prop.latitude, CONSTANTS.ENV.RADIUS]);

    const bonus = parseFloat(res.rows[0].total_bonus || 0);
    // Base 5.0 + bonus. Giới hạn max 10.
    return Math.max(0.0, Math.min(10.0, 5.0 + (bonus * 0.5)));
  }

  calculateOverall(user, crime, env) {
    return (
      (user * CONSTANTS.WEIGHTS.USER) +
      (crime * CONSTANTS.WEIGHTS.CRIME) +
      (env * CONSTANTS.WEIGHTS.ENV)
    ).toFixed(1);
  }
}

module.exports = new SafetyScoreService();