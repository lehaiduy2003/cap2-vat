// server/services/SafetyScoreService.js
const axios = require("axios");
const { pool } = require("../config/db");
const floodService = require("./FloodRiskService"); // Import module ngập lụt
require("dotenv").config();

// CẤU HÌNH HỆ THỐNG
const CONSTANTS = {
  WEIGHTS: { USER: 0.4, CRIME: 0.4, ENV: 0.2 },
  CRIME: {
    MAX_DISTANCE: 5000, // 5km
    DECAY_K: 0.001,
    HALF_LIFE_DAYS: 180,
    MAX_PENALTY: 40 
  },
  ENV: { 
    RADIUS: 1000 // Bán kính tìm tiện ích
  },
  NOISE: {
    SEARCH_RADIUS: 300, // 300m cho tiếng ồn đô thị
    MAX_PENALTY: 3.0,   // Phạt tối đa 3 điểm
    DECAY_K: 0.008,     // Suy giảm nhanh
    API_KEY: process.env.GOOGLE_MAPS_API_KEY
  }
};

class SafetyScoreService {
  
  // --- 1. User Score (Điểm Cộng đồng) ---
  // Dựa trên trung bình đánh giá sao của người dùng
  async calculateUserScore(client, propertyId) {
    try {
      const res = await client.query(
        "SELECT AVG(safety_rating) as avg_rating FROM reviews WHERE property_id = $1",
        [propertyId]
      );
      // Mặc định 8.0 (Khá tốt) nếu chưa có review để tránh điểm 0 gây hiểu lầm
      if (!res.rows[0] || !res.rows[0].avg_rating) return 8.0; 
      return parseFloat(res.rows[0].avg_rating) * 2.0; // Quy đổi thang 5 -> 10
    } catch (err) {
      console.error(`[UserScore Error] ID ${propertyId}:`, err.message);
      return 5.0; // Fallback an toàn
    }
  }

  // --- 2. Crime Score (Điểm An ninh) ---
  // Dựa trên lịch sử sự cố và khoảng cách (Hàm suy giảm mũ)
  async calculateCrimeScore(client, prop) {
    if (!prop.latitude || !prop.longitude) return 10.0;

    try {
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
      
      // Trọng số loại sự cố (Incident Type Weights)
      const typeWeight = { 
          robbery: 1.5, harassment: 1.5, // Nguy hiểm -> Phạt nặng
          theft: 1.0, 
          noise: 0.5, other: 0.8 
      };
      // Trọng số mức độ (Severity Multiplier)
      const severityMap = { low: 2, medium: 5, high: 10 }; 
      const today = new Date();

      for (const row of res.rows) {
        const typeFactor = typeWeight[row.incident_type] || 1.0;
        const severity = severityMap[row.severity] || 2;
        
        // Time Decay: Sự cố càng lâu càng ít ảnh hưởng
        const daysOld = (today - new Date(row.incident_date)) / (86400000);
        if (daysOld < 0 || daysOld > 730) continue;
        const timeFactor = Math.pow(0.5, daysOld / CONSTANTS.CRIME.HALF_LIFE_DAYS);

        // Distance Decay: Sự cố càng xa càng ít ảnh hưởng (Hàm mũ)
        const distFactor = Math.exp(-CONSTANTS.CRIME.DECAY_K * row.dist);

        totalPenalty += (severity * typeFactor) * timeFactor * distFactor;
      }

      // Chuẩn hóa về thang 10
      const score = 10.0 - (totalPenalty / CONSTANTS.CRIME.MAX_PENALTY * 10.0);
      return Math.max(0.0, Math.min(10.0, score));
    } catch (err) {
      console.error(`[CrimeScore Error] ID ${prop.id}:`, err.message);
      return 10.0;
    }
  }

  // --- 3. Environment Score (Điểm Môi trường) ---
  // Tích hợp: Tiện ích (+) - Tiếng ồn (-) - Ngập lụt (Kết hợp)
  async calculateEnvScore(client, prop) {
    if (!prop.latitude || !prop.longitude) return 5.0;
    
    try {
      // A. Tính điểm Cơ bản (Tiện ích - Tiếng ồn)
      // ---------------------------------------------------------
      // 1. Điểm Cộng từ Tiện ích (Bonus)
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
      let baseScore = 5.0 + (bonus * 0.5); // Điểm nền (Base)

      // 2. Điểm Trừ từ Tiếng ồn (Penalty) - Google Maps
      const noisePenalty = await this.getNoisePenaltyFromGoogle(prop.latitude, prop.longitude);
      if (noisePenalty > 0) {
        console.log(`[Noise] ID ${prop.id}: -${noisePenalty.toFixed(2)} điểm (Gần nguồn ồn)`);
      }

      let tempEnvScore = Math.max(0, Math.min(10, baseScore - noisePenalty));

      // B. Tính điểm Rủi ro Ngập lụt (Flood Risk)
      // ---------------------------------------------------------
      // Gọi service chuyên biệt để tính toán dựa trên độ cao & lịch sử
      const floodScore = await floodService.calculateFloodScore(client, prop);

      // C. Tổng hợp Điểm Môi trường cuối cùng
      // ---------------------------------------------------------
      // Công thức: 60% (Không gian sống/Tiện ích) + 40% (Rủi ro Ngập lụt)
      let finalScore = (tempEnvScore * 0.6) + (floodScore * 0.4);

      // Phạt bổ sung: Nếu khu vực là "rốn ngập" (điểm ngập < 4), trừ thêm 1 điểm cứng
      // để đảm bảo dù tiện ích có tốt đến đâu cũng không kéo điểm lên quá cao.
      if (floodScore < 4.0) {
          finalScore -= 1.0;
          console.log(`[Env Penalty] ID ${prop.id}: Trừ thêm 1.0 do nguy cơ ngập cao.`);
      }

      return Math.max(0.0, Math.min(10.0, finalScore));

    } catch (err) {
      console.error(`[EnvScore Error] ID ${prop.id}:`, err.message);
      return 5.0; // Fallback
    }
  }

  /**
   * Gọi Google Places API để tìm nguồn ồn (Ga tàu, Đường ray)
   * Trả về điểm phạt (0.0 -> 3.0)
   */
  async getNoisePenaltyFromGoogle(lat, lng) {
    if (!CONSTANTS.NOISE.API_KEY) return 0;

    try {
        const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json`;
        const response = await axios.get(url, {
            params: {
                location: `${lat},${lng}`,
                radius: CONSTANTS.NOISE.SEARCH_RADIUS, // 300m
                keyword: 'railway', // Tìm ga tàu/đường sắt
                key: CONSTANTS.NOISE.API_KEY
            },
            timeout: 3000 // Timeout nhanh (3s)
        });

        const results = response.data.results || [];
        if (results.length === 0) return 0;

        // Lấy địa điểm ồn gần nhất
        const nearest = results[0];
        const distance = this.calculateDistance(
            lat, lng, 
            nearest.geometry.location.lat, 
            nearest.geometry.location.lng
        );

        // Công thức phạt suy giảm theo khoảng cách
        const decayFactor = Math.exp(-CONSTANTS.NOISE.DECAY_K * distance);
        return decayFactor * CONSTANTS.NOISE.MAX_PENALTY;

    } catch (error) {
        // Lỗi API không ảnh hưởng luồng chính
        return 0; 
    }
  }

  // Hàm Haversine tính khoảng cách mét
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; 
    const toRad = x => x * Math.PI / 180;
    
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
  }

  // Tính điểm tổng thể (Overall)
  calculateOverall(user, crime, env) {
    return (
      (user * CONSTANTS.WEIGHTS.USER) +
      (crime * CONSTANTS.WEIGHTS.CRIME) +
      (env * CONSTANTS.WEIGHTS.ENV)
    ).toFixed(1);
  }
}

module.exports = new SafetyScoreService();