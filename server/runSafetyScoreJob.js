// server/runSafetyScoreJob.js
const { pool } = require("./config/db");
const safetyService = require("./services/SafetyScoreService");

// Xử lý từng lô 50 phòng để không sập server
const BATCH_SIZE = 50; 

async function runJob(targetPropertyId = null) {
  const client = await pool.connect();
  try {
    if (targetPropertyId) {
      // --- MODE 1: XỬ LÝ ĐƠN (Khi user review) ---
      // Lấy thông tin phòng (Cần lat/long để tính toán)
      const res = await client.query("SELECT id, latitude, longitude FROM properties WHERE id = $1", [targetPropertyId]);
      if (res.rows.length > 0) {
          await processProperty(client, res.rows[0]);
      }
    } else {
      // --- MODE 2: XỬ LÝ TOÀN BỘ (Cron Job) ---
      // Dùng Keyset Pagination để tiết kiệm RAM
      let lastId = 0;
      let hasMore = true;

      while (hasMore) {
        const res = await client.query(`
            SELECT id, latitude, longitude 
            FROM properties 
            WHERE id > $1 
            ORDER BY id ASC LIMIT $2
        `, [lastId, BATCH_SIZE]);

        if (res.rows.length === 0) break;

        // Xử lý song song batch hiện tại
        await Promise.all(res.rows.map(p => processProperty(client, p)));

        lastId = res.rows[res.rows.length - 1].id;
        console.log(`[Job] Đã xử lý đến ID: ${lastId}`);
      }
    }
  } catch (err) {
    console.error("[JOB FATAL ERROR]", err);
  } finally {
    client.release();
  }
}

// Hàm xử lý logic cốt lõi
async function processProperty(client, prop) {
    if (!prop.latitude || !prop.longitude) return;

    try {
        const [user, crime, env] = await Promise.all([
            safetyService.calculateUserScore(client, prop.id),
            safetyService.calculateCrimeScore(client, prop),
            safetyService.calculateEnvScore(client, prop)
        ]);

        const overall = safetyService.calculateOverall(user, crime, env);

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
        `, [prop.id, overall, user.toFixed(1), crime.toFixed(1), env.toFixed(1)]);
        
    } catch (e) {
        console.error(`[CALC ERROR] ID ${prop.id}:`, e.message);
    }
}

module.exports = { runJob };