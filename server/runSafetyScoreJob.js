// cap2-vat/server/runSafetyScoreJob.js

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Pool } = require('pg'); // Đảm bảo đã import Pool

// --- MỚI: Khởi tạo CSDL (Giống hệt apiServer.js) ---
// Chúng ta cần CSDL để truy vấn bảng admin_safety_reviews
const dbConfig = {
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: parseInt(process.env.PGPORT, 10),
};

const pool = new Pool(dbConfig);
pool.on('error', (err) => {
    console.error('[DB POOL - JOB] Lỗi kết nối CSDL:', err.message, err.stack);
});
// --- KẾT THÚC PHẦN MỚI ---


/**
 * HÀM MỚI: Lấy điểm an toàn do Admin đánh giá thủ công
 * @param {number} propertyId - ID của phòng trọ
 * @param {object} client - Kết nối CSDL (Pool Client)
 * @returns {Promise<number|null>} - Trả về điểm (vd: 85.5) hoặc null nếu không có
 */
async function getAdminScore(propertyId, client) {
    try {
        const query = {
            text: 'SELECT safety_score FROM admin_safety_reviews WHERE property_id = $1',
            values: [propertyId]
        };
        const result = await client.query(query);

        if (result.rowCount > 0) {
            // Chuyển đổi từ kiểu NUMERIC của CSDL sang số (float)
            return parseFloat(result.rows[0].safety_score);
        }
        return null; // Không tìm thấy đánh giá của admin
    } catch (err) {
        console.error(`[JOB] Lỗi khi lấy Admin Score cho P_ID ${propertyId}:`, err.message);
        return null; // Coi như không có điểm nếu bị lỗi
    }
}


/**
 * CẬP NHẬT: Hàm tính điểm tổng
 * Giờ đây hàm này sẽ nhận thêm `adminScore`
 */
function calculateOverallScore(crimeScore, userScore, environmentScore, adminScore) {
    
    // --- CẬP NHẬT LOGIC TÍNH ĐIỂM ---
    
    // Định nghĩa trọng số (weights).
    // Đây là ví dụ, bạn có thể thay đổi các con số này.
    const weights = {
        WITH_ADMIN: {
            crime: 0.30,       // 30%
            user: 0.20,        // 20%
            environment: 0.20, // 20%
            admin: 0.30,       // 30% (Điểm của Admin có trọng số cao)
        },
        WITHOUT_ADMIN: {
            crime: 0.45,       // 45%
            user: 0.25,        // 25%
            environment: 0.30, // 30%
        }
    };

    let overallScore;

    if (adminScore !== null) {
        // TRƯỜNG HỢP 1: CÓ ĐIỂM ADMIN
        console.log(`[JOB] Tính điểm CÓ Admin Score (${adminScore})`);
        const w = weights.WITH_ADMIN;
        overallScore = (crimeScore * w.crime) + 
                       (userScore * w.user) + 
                       (environmentScore * w.environment) + 
                       (adminScore * w.admin);
    } else {
        // TRƯỜNG HỢP 2: KHÔNG CÓ ĐIỂM ADMIN (tính như cũ)
        console.log(`[JOB] Tính điểm KHÔNG có Admin Score`);
        const w = weights.WITHOUT_ADMIN;
        overallScore = (crimeScore * w.crime) + 
                       (userScore * w.user) + 
                       (environmentScore * w.environment);
    }

    // Làm tròn và đảm bảo điểm luôn nằm trong khoảng 0 - 100
    const finalScore = Math.max(0, Math.min(100, overallScore));
    return parseFloat(finalScore.toFixed(1)); // Làm tròn 1 chữ số thập phân
}


// --- CÁC HÀM TÍNH ĐIỂM CON ---
// (Tôi giả định bạn đã có các hàm này)

async function getCrimeScore(propertyId, client) {
    // ... logic của bạn để tính điểm tội phạm (từ security_incidents)
    //
    console.log(`[JOB] (Giả lập) Crime Score = 70.0`);
    return 70.0; // Giả lập
}

async function getUserScore(propertyId, client) {
    // ... logic của bạn để tính điểm user (từ bảng reviews)
    //
    console.log(`[JOB] (Giả lập) User Score = 80.0`);
    return 80.0; // Giả lập
}

async function getEnvironmentScore(propertyId, client) {
    // ... logic của bạn để tính điểm môi trường (từ safety_points)
    //
    console.log(`[JOB] (Giả lập) Environment Score = 75.0`);
    return 75.0; // Giả lập
}

async function getAISummary(scores) {
    // ... logic của bạn để gọi AI
    console.log(`[JOB] (Giả lập) AI Summary...`);
    return "Đây là khu vực an toàn (AI summary)."; // Giả lập
}


/**
 * CẬP NHẬT: Hàm chính xử lý cho 1 property
 * Hàm này sẽ gọi thêm `getAdminScore`
 */
async function calculateAndSaveScore(propertyId, client) {
    console.log(`[JOB] Bắt đầu tính toán cho P_ID: ${propertyId}...`);
    try {
        // 1. Lấy tất cả điểm thành phần (parallel)
        const [
            crimeScore, 
            userScore, 
            environmentScore,
            adminScore // <-- ĐIỂM MỚI
        ] = await Promise.all([
            getCrimeScore(propertyId, client),
            getUserScore(propertyId, client),
            getEnvironmentScore(propertyId, client),
            getAdminScore(propertyId, client) // <-- GỌI HÀM MỚI
        ]);

        // 2. Tính điểm tổng (ĐÃ CẬP NHẬT)
        const overallScore = calculateOverallScore(
            crimeScore, 
            userScore, 
            environmentScore, 
            adminScore // <-- Truyền điểm mới vào
        );

        // 3. Lấy AI Summary (ví dụ)
        const aiSummary = await getAISummary({
            crime: crimeScore,
            user: userScore,
            env: environmentScore,
            admin: adminScore, // AI cũng có thể cần biết điểm này
            overall: overallScore
        });

        // 4. Lưu vào CSDL (UPSERT)
        const upsertQuery = {
            text: `
                INSERT INTO property_safety_scores 
                    (property_id, overall_score, crime_score, user_score, environment_score, last_updated_at, ai_summary)
                VALUES 
                    ($1, $2, $3, $4, $5, NOW(), $6)
                ON CONFLICT (property_id) 
                DO UPDATE SET
                    overall_score = EXCLUDED.overall_score,
                    crime_score = EXCLUDED.crime_score,
                    user_score = EXCLUDED.user_score,
                    environment_score = EXCLUDED.environment_score,
                    last_updated_at = NOW(),
                    ai_summary = EXCLUDED.ai_summary;
            `,
            values: [propertyId, overallScore, crimeScore, userScore, environmentScore, aiSummary]
        };

        await client.query(upsertQuery);
        console.log(`[JOB] Đã CẬP NHẬT điểm thành công cho P_ID ${propertyId}. Điểm tổng: ${overallScore}`);

    } catch (err) {
        console.error(`[JOB] Lỗi nghiêm trọng khi xử lý P_ID ${propertyId}:`, err.message, err.stack);
        throw err; // Ném lỗi để transaction có thể rollback
    }
}


/**
 * Hàm chính được export (KHÔNG ĐỔI NHIỀU)
 * Hàm này điều phối việc chạy job
 */
async function runJob(specificPropertyId = null) {
    const client = await pool.connect();
    console.log('[JOB] Đã kết nối CSDL.');
    
    try {
        await client.query('BEGIN'); // Bắt đầu transaction

        if (specificPropertyId) {
            // Trường hợp 1: Chỉ chạy cho 1 property (do API trigger)
            console.log(`[JOB] Chạy cho 1 P_ID cụ thể: ${specificPropertyId}`);
            await calculateAndSaveScore(specificPropertyId, client);

        } else {
            // Trường hợp 2: Chạy cho TẤT CẢ properties (do Cron job)
            console.log('[JOB] Chạy cho TẤT CẢ properties...');
            const res = await client.query('SELECT id FROM properties');
            
            for (const row of res.rows) {
                // Chạy tuần tự để tránh quá tải
                await calculateAndSaveScore(row.id, client);
            }
            console.log(`[JOB] Đã hoàn thành job cho ${res.rowCount} properties.`);
        }

        await client.query('COMMIT'); // Lưu lại tất cả thay đổi
        console.log('[JOB] Transaction COMMIT thành công.');

    } catch (err) {
        await client.query('ROLLBACK'); // Hoàn tác nếu có lỗi
        console.error('[JOB] Gặp lỗi, đã ROLLBACK:', err.message);
    } finally {
        client.release(); // Trả kết nối về Pool
        console.log('[JOB] Đã giải phóng kết nối CSDL.');
    }
}

// Export hàm runJob để apiServer.js có thể gọi
module.exports = {
    runJob
};