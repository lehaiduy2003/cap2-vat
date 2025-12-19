// server/services/SafetyScoreService.js
const axios = require("axios");
const { pool } = require("../config/db");
const floodService = require("./FloodRiskService"); // Import Service Ngập lụt
require("dotenv").config();

const CONSTANTS = {
  WEIGHTS: { USER: 0.4, CRIME: 0.4, ENV: 0.2 },
  CRIME: {
    MAX_DISTANCE: 5000,
    DECAY_K: 0.001,
    HALF_LIFE_DAYS: 180,
    MAX_PENALTY: 40 
  },
  ENV: { RADIUS: 1000 },
  NOISE: { // Cấu hình Tiếng ồn
    SEARCH_RADIUS: 300, // 300m
    MAX_PENALTY: 3.0,   // Phạt tối đa 3 điểm
    DECAY_K: 0.008,
    API_KEY: process.env.GOOGLE_MAPS_API_KEY
  }
};

class SafetyScoreService {
  
  // 1. User Score (Giữ nguyên)
  async calculateUserScore(client, propertyId) {
    const res = await client.query(
      "SELECT AVG(safety_rating) as avg_rating FROM reviews WHERE property_id = $1",
      [propertyId]
    );
    if (!res.rows[0] || !res.rows[0].avg_rating) return 8.0; 
    return parseFloat(res.rows[0].avg_rating) * 2.0; 
  }

  // 2. Crime Score (Giữ nguyên logic tốt hiện tại)
  async calculateCrimeScore(client, prop) {
    if (!prop.latitude || !prop.longitude) return 10.0;

    const res = await client.query(`
      SELECT severity, incident_date, incident_type,
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
    const severityMap = { low: 2, medium: 5, high: 10 }; 
    const today = new Date();

    for (const row of res.rows) {
      const severity = severityMap[row.severity] || 2;
      const daysOld = (today - new Date(row.incident_date)) / (86400000);
      if (daysOld < 0 || daysOld > 730) continue;
      
      const timeFactor = Math.pow(0.5, daysOld / CONSTANTS.CRIME.HALF_LIFE_DAYS);
      const distFactor = Math.exp(-CONSTANTS.CRIME.DECAY_K * row.dist);

      totalPenalty += severity * timeFactor * distFactor;
    }

    const score = 10.0 - (totalPenalty / CONSTANTS.CRIME.MAX_PENALTY * 10.0);
    return Math.max(0.0, Math.min(10.0, score));
  }

  // 3. Env Score (NÂNG CẤP: Tiện ích - Tiếng ồn - Ngập lụt)
  async calculateEnvScore(client, prop) {
    if (!prop.latitude || !prop.longitude) return 5.0;
    
    try {
      // A. Điểm nền từ tiện ích (Logic cũ)
      const bonusRes = await client.query(`
          SELECT SUM(severity_score) as total_bonus 
          FROM safety_points 
          WHERE ST_DWithin(
              location, 
              ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 
              $3
          )
      `, [prop.longitude, prop.latitude, CONSTANTS.ENV.RADIUS]);

      const bonus = parseFloat(bonusRes.rows[0].total_bonus || 0);
      let baseScore = 5.0 + (bonus * 0.5); 

      // B. [MỚI] Trừ điểm Tiếng ồn (Đường tàu)
      const noisePenalty = await this.getNoisePenaltyFromGoogle(prop.latitude, prop.longitude);
      let tempEnvScore = Math.max(0, Math.min(10, baseScore - noisePenalty));

      // C. [MỚI] Điểm rủi ro Ngập lụt (Từ Service mới)
      const floodScore = await floodService.calculateFloodScore(client, prop);

      // D. Tổng hợp (Trọng số: 60% Môi trường sống + 40% Ngập lụt)
      let finalScore = (tempEnvScore * 0.6) + (floodScore * 0.4);

      // Phạt bổ sung: Nếu ngập nặng (< 4đ) thì trừ thêm 1 điểm cứng
      if (floodScore < 4.0) {
          finalScore -= 1.0;
      }

      return Math.max(0.0, Math.min(10.0, finalScore));

    } catch (err) {
      console.error(`[EnvScore Error] ID ${prop.id}:`, err.message);
      return 5.0;
    }
  }

  // [HÀM MỚI] Gọi Google Maps tìm đường tàu
  async getNoisePenaltyFromGoogle(lat, lng) {
    if (!CONSTANTS.NOISE.API_KEY) return 0;

    try {
        const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json`;
        const response = await axios.get(url, {
            params: {
                location: `${lat},${lng}`,
                radius: CONSTANTS.NOISE.SEARCH_RADIUS, // 300m
                keyword: 'railway', // Tìm từ khóa đường sắt
                key: CONSTANTS.NOISE.API_KEY
            },
            timeout: 2000 // Timeout nhanh
        });

        const results = response.data.results || [];
        if (results.length === 0) return 0;

        // Tìm địa điểm gần nhất để tính mức phạt
        // (Giả sử lấy kết quả đầu tiên)
        // Logic đơn giản: Có đường tàu trong 300m -> Phạt
        // Để chính xác hơn cần tính khoảng cách cụ thể, ở đây ta phạt theo hàm mũ
        return CONSTANTS.NOISE.MAX_PENALTY; 

    } catch (error) {
        return 0; // Lỗi API thì bỏ qua, không trừ điểm
    }
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