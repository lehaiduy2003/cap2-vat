// src/services/FloodRiskService.js
const axios = require("axios");

class FloodRiskService {
    // Lấy độ cao từ Open-Meteo
    async getElevation(lat, lng) {
        try {
            const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`;
            const response = await axios.get(url, { timeout: 3000 });
            if (response.data?.elevation?.length > 0) return response.data.elevation[0];
            return null;
        } catch (error) {
            console.error("[Elevation Error]", error.message);
            return null; 
        }
    }

    // Tính điểm ngập lụt (0-10)
    async calculateFloodScore(client, prop) {
        if (!prop.latitude || !prop.longitude) return 10.0;

        // 1. Cập nhật độ cao nếu chưa có
        let elevation = prop.elevation_meters;
        if (elevation === null || elevation === undefined) {
             elevation = await this.getElevation(prop.latitude, prop.longitude);
             if (elevation !== null) {
                 await client.query("UPDATE properties SET elevation_meters = $1 WHERE id = $2", [elevation, prop.id]);
             }
        }

        let score = 10.0;
        
        // 2. Phạt theo địa hình
        if (elevation !== null) {
            if (elevation < 2.0) score -= 3.0; // Thấp dưới 2m -> Trừ 3
            else if (elevation < 5.0) score -= 1.0; 
        }

        // 3. Phạt theo báo cáo từ người dùng (2 năm gần nhất, bán kính 200m)
        try {
            const historyRes = await client.query(`
                SELECT water_level FROM flood_reports
                WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 200)
                AND report_date > NOW() - INTERVAL '2 years'
            `, [prop.longitude, prop.latitude]);

            let totalPenalty = 0;
            for (const row of historyRes.rows) {
                const level = parseInt(row.water_level || 0);
                if (level > 50) totalPenalty += 2.0;       
                else if (level >= 30) totalPenalty += 1.0; 
                else totalPenalty += 0.5;                  
            }
            score -= Math.min(totalPenalty, 5.0); // Max phạt 5 điểm
        } catch (err) { console.error("[Flood DB Error]", err.message); }

        return Math.max(0.0, Math.min(10.0, score));
    }
}

module.exports = new FloodRiskService();