// server/services/FloodRiskService.js
const axios = require("axios");
const { pool } = require("../config/db");

// Cấu hình
const CONSTANTS = {
    FLOOD: {
        SEARCH_RADIUS: 200, // 200m
        HISTORY_PENALTY_PER_REPORT: 2.0 // Trừ 2 điểm/báo cáo
    }
};

class FloodRiskService {
    /**
     * Lấy độ cao từ Open-Meteo API (Miễn phí)
     */
    async getElevation(lat, lng) {
        try {
            const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`;
            const response = await axios.get(url, { timeout: 3000 });
            
            if (response.data && response.data.elevation && response.data.elevation.length > 0) {
                return response.data.elevation[0];
            }
            return null;
        } catch (error) {
            console.error("[Elevation API Error]", error.message);
            return null; 
        }
    }

    /**
     * Tính điểm ngập lụt (0-10)
     */
    async calculateFloodScore(client, prop) {
        if (!prop.latitude || !prop.longitude) return 10.0;

        // 1. Logic độ cao (Giữ nguyên code cũ của bạn về elevation)
        let elevation = prop.elevation_meters;
        if (elevation === null || elevation === undefined) {
             elevation = await this.getElevation(prop.latitude, prop.longitude);
             if (elevation !== null) {
                 client.query("UPDATE properties SET elevation_meters = $1 WHERE id = $2", [elevation, prop.id]).catch(e => console.error(e));
             }
        }

        let score = 10.0;
        
        // Phạt theo địa hình (Độ cao)
        if (elevation !== null) {
            if (elevation < 2.0) score -= 3.0;
            else if (elevation < 5.0) score -= 1.0;
        }

        // 2. [LOGIC MỚI] Phạt theo Lịch sử báo cáo & Mức độ ngập
        try {
            // Thay vì chỉ đếm số lượng, ta lấy chi tiết mức nước của các báo cáo
            const historyRes = await client.query(`
                SELECT water_level
                FROM flood_reports
                WHERE ST_DWithin(
                    location, 
                    ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 
                    $3
                )
                AND report_date > NOW() - INTERVAL '2 years'
            `, [prop.longitude, prop.latitude, 200]); // Bán kính 200m

            if (historyRes.rows.length > 0) {
                let totalPenalty = 0;
                
                // Duyệt qua từng báo cáo để cộng dồn mức phạt
                for (const row of historyRes.rows) {
                    const level = parseInt(row.water_level || 0);
                    
                    if (level > 50) totalPenalty += 2.0;       // Ngập sâu (>50cm): Trừ nặng
                    else if (level >= 30) totalPenalty += 1.0; // Ngập vừa (30-50cm): Trừ vừa
                    else totalPenalty += 0.5;                  // Ngập nhẹ (<30cm): Trừ nhẹ
                }

                // Giới hạn mức phạt tối đa từ báo cáo là 5 điểm (để không bị âm quá nhiều)
                score -= Math.min(totalPenalty, 5.0);
                
                console.log(`[Flood Logic] ID ${prop.id}: Tìm thấy ${historyRes.rows.length} báo cáo. Tổng phạt: -${totalPenalty}`);
            }
        } catch (err) {
            console.error("[Flood DB Error]", err.message);
        }

        return Math.max(0.0, Math.min(10.0, score));
    }
}

module.exports = new FloodRiskService();