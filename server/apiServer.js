const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const express = require('express');
const { Pool } = require('pg'); // Dùng Pool cho server
const cors = require('cors');
const cron = require('node-cron');


const { runJob } = require('./runSafetyScoreJob');

// --- 2. KHỞI TẠO VÀ CẤU HÌNH ---

const app = express();
const PORT = process.env.API_PORT || 3000;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const BASE_API_URL = process.env.BASE_API_URL;

if (!ADMIN_API_KEY) {
    console.error('[LỖI NGHIÊM TRỌNG] ADMIN_API_KEY chưa được thiết lập trong file .env. Server sẽ không khởi động.');
    process.exit(1);
}


const dbConfig = {
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: parseInt(process.env.PGPORT, 10),
};

const pool = new Pool(dbConfig);
pool.on('error', (err) => {
    console.error('[DB POOL] Lỗi kết nối CSDL (Idle Client):', err.message, err.stack);
});

// --- 3. MIDDLEWARE (Phần mềm trung gian) ---

app.use(cors()); // Cho phép cross-origin
app.use(express.json()); // Đọc JSON body

// Phục vụ các file tĩnh (HTML, CSS, JS) từ thư mục 'public'
const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));
console.log(`[SERVER] Phục vụ file tĩnh từ: ${publicPath}`);

// Middleware xác thực Admin
const adminAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey === ADMIN_API_KEY) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized: Thiếu hoặc sai API Key.' });
    }
};

// Middleware xác thực User (Giả lập cho đồ án)
const userAuth = (req, res, next) => {
    const userId = req.headers['x-user-id'];
    if (userId && !isNaN(parseInt(userId, 10))) {
        req.user_id = parseInt(userId, 10);
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized: Thiếu hoặc sai x-user-id header.' });
    }
};
// --- 4. LẬP LỊCH TỰ ĐỘNG (CRON JOB) ---
cron.schedule('*0 1 * * *', () => {
    console.log('[CRON] Lịch 1h: Kích hoạt Job tính điểm TOÀN BỘ hệ thống...');
    runJob(null).catch(err => {
        console.error('[CRON ERROR] Job tự động thất bại:', err);
    });
});
console.log('[SERVER] Đã lập lịch Job chạy mỗi 1h.');
// --- 5. API ENDPOINTS ---
/**
 * API CHO NGƯỜI DÙNG: Lấy điểm an toàn đã tính toán
 */
app.get('/api/v1/properties/:id/safety', async (req, res) => {
    const propertyId = parseInt(req.params.id, 10);
    if (isNaN(propertyId)) {
        return res.status(400).json({ error: 'ID phòng trọ không hợp lệ.' });
    }

    console.log(`[API GET] Nhận yêu cầu cho P_ID: ${propertyId}`);
    try {
        const result = await pool.query(
            'SELECT * FROM property_safety_scores WHERE property_id = $1',
            [propertyId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Không tìm thấy điểm an toàn. (Job chưa chạy?)' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error(`[LỖI API GET] P_ID ${propertyId}: ${err.message}`);
        res.status(500).json({ error: 'Lỗi máy chủ nội bộ.' });
    }
});

/**
 * API CHO NGƯỜI DÙNG: Lấy reviews của một property với phân trang
 */
app.get('/api/v1/reviews/:property_id', async (req, res) => {
    const propertyId = parseInt(req.params.property_id, 10);
    if (isNaN(propertyId)) {
        return res.status(400).json({ error: 'ID phòng trọ không hợp lệ.' });
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const offset = (page - 1) * limit;

    console.log(`[API GET REVIEWS] Nhận yêu cầu cho P_ID: ${propertyId}, page: ${page}, limit: ${limit}`);

    try {
        // Lấy tổng số reviews
        const countResult = await pool.query(
            'SELECT COUNT(*) as total FROM reviews WHERE property_id = $1',
            [propertyId]
        );
        const total = parseInt(countResult.rows[0].total, 10);

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
                hasPrev: page > 1
            }
        });
    } catch (err) {
        console.error(`[LỖI API GET REVIEWS] P_ID ${propertyId}: ${err.message}`);
        res.status(500).json({ error: 'Lỗi máy chủ nội bộ.' });
    }
});
/**
 * API NỘI BỘ: Đồng bộ dữ liệu phòng trọ từ hệ thống Java
 * Java sẽ gọi API này mỗi khi Tạo/Cập nhật phòng trọ
 */
app.post('/api/v1/internal/sync/property', adminAuth, async (req, res) => {
    // 1. Lấy dữ liệu Java gửi lên
    const { id, latitude, longitude, name, address } = req.body;

    // 2. Validate (phòng thủ)
    if (!id || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Thiếu id, latitude, hoặc longitude.' });
    }

    try {
        // 3. UPSERT vào bảng 'properties' (CSDL PostgreSQL của Node)
        // Đây chính là hành động "đồng bộ"
        const query = {
            text: `
                INSERT INTO properties (id, name, address, latitude, longitude)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (id) -- Giả sử 'id' là khóa chính/duy nhất
                DO UPDATE SET
                    name = EXCLUDED.name,
                    address = EXCLUDED.address,
                    latitude = EXCLUDED.latitude,
                    longitude = EXCLUDED.longitude;
            `,
            values: [id, name || null, address || null, latitude, longitude]
        };
        
        await pool.query(query);
        console.log(`[SYNC] Đã đồng bộ P_ID ${id} từ hệ thống Java.`);

        // 4. (TỐI ƯU) Kích hoạt tính điểm ngay cho phòng này
        
        runJob(id).catch(err => {
            console.error(`[JOB-RECALC] Lỗi tính lại điểm cho P_ID ${id} sau khi sync:`, err);
        });

        res.status(200).json({ message: `Đã đồng bộ P_ID ${id}` });

    } catch (err) {
        console.error(`[LỖI SYNC] P_ID ${id}:`, err.message);
        res.status(500).json({ error: 'Lỗi máy chủ nội bộ khi đồng bộ.' });
    }
});
/**
 * API CHO ADMIN: Thêm một sự cố an ninh
 */
app.post('/api/v1/admin/incidents', adminAuth, async (req, res) => {
    const { property_id, incident_type, severity, incident_date, notes } = req.body;

    // Validate (phòng thủ)
    if (!property_id || !incident_type || !severity || !incident_date) {
        return res.status(400).json({ error: 'Dữ liệu không hợp lệ. Thiếu các trường bắt buộc.' });
    }
    const validTypes = ['theft', 'robbery', 'harassment', 'noise', 'accident', 'other'];
    const validSeverities = ['low', 'medium', 'high'];
    if (!validTypes.includes(incident_type) || !validSeverities.includes(severity)) {
        return res.status(400).json({ error: 'Giá trị "incident_type" hoặc "severity" không hợp lệ.' });
    }

    try {
        const query = {
            text: `INSERT INTO security_incidents (property_id, incident_type, severity, incident_date, notes)
                   VALUES ($1, $2, $3, $4, $5) RETURNING *;`,
            values: [property_id, incident_type, severity, incident_date, notes || null]
        };
        const result = await pool.query(query);
        const newIncident = result.rows[0];

        console.log(`[API ADMIN] Đã thêm sự cố ${newIncident.id} cho P_ID ${property_id}.`);
        res.status(201).json(newIncident); // Phản hồi 201 Created

        // Tối ưu: Kích hoạt tính điểm lại (chạy nền, không await)
        console.log(`[JOB-TRIGGER] Kích hoạt tính điểm lại cho P_ID ${property_id}...`);
        runJob(property_id).catch(err => {
            console.error(`[JOB-RECALC] Lỗi tính lại điểm cho P_ID ${property_id}:`, err);
        });

    } catch (err) {
        console.error('[LỖI API POST]', err.message);
        res.status(500).json({ error: 'Lỗi máy chủ nội bộ khi thêm sự cố.' });
    }
});

app.post('/api/v1/reviews', userAuth, async (req, res) => {
    // 1. Lấy dữ liệu từ body (THÊM CÁC TRƯỜNG MỚI)
    const { 
        property_id, 
        rentHistoryId,
        safety_rating, 
        cleanliness_rating, // <-- MỚI
        amenities_rating,   // <-- MỚI
        host_rating,        // <-- MỚI
        review_text 
    } = req.body;
    
    const user_id = req.user_id; // Lấy từ middleware 'userAuth'

    // 2. Validate dữ liệu
    const ratingSa = parseInt(safety_rating, 10);
    const ratingCl = parseInt(cleanliness_rating, 10); // <-- MỚI
    const ratingAm = parseInt(amenities_rating, 10);   // <-- MỚI
    const ratingHo = parseInt(host_rating, 10);        // <-- MỚI
    const propId = parseInt(property_id, 10);

    // Validate tất cả các trường 1-5 sao
    const allRatings = [ratingSa, ratingCl, ratingAm, ratingHo];
    if (isNaN(propId) || allRatings.some(r => isNaN(r) || r < 1 || r > 5)) {
        return res.status(400).json({ 
            error: 'Dữ liệu không hợp lệ. "property_id" và tất cả các mục 1-5 sao là bắt buộc.' 
        });
    }

    // 2.5. Kiểm tra xem property có tồn tại không
    try {
        const propertyCheck = await pool.query(
            'SELECT id FROM properties WHERE id = $1',
            [propId]
        );
        if (propertyCheck.rowCount === 0) {
            try {
                const roomResponse = await fetch(`${BASE_API_URL}/api/rooms/${propId}`, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        // Có thể cần thêm auth header nếu cần
                    }
                });
                if (!roomResponse.ok) {
                    throw new Error(`HTTP error! status: ${roomResponse.status}`);
                }
                const roomData = await roomResponse.json();
                const room = roomData.data; // Giả sử response có { data: roomDTO }

                // Đồng bộ vào VAT DB
                const addressParts = [room.addressDetails, room.ward, room.district, room.city].filter(part => part && part.trim());
                const fullAddress = addressParts.join(', ');
                
                const syncQuery = {
                    text: `
                        INSERT INTO properties (id, name, address, latitude, longitude)
                        VALUES ($1, $2, $3, $4, $5)
                        ON CONFLICT (id)
                        DO UPDATE SET
                            name = EXCLUDED.name,
                            address = EXCLUDED.address,
                            latitude = EXCLUDED.latitude,
                            longitude = EXCLUDED.longitude;
                    `,
                    values: [
                        room.id,
                        room.title,
                        fullAddress,
                        room.latitude,
                        room.longitude
                    ]
                };
                await pool.query(syncQuery);

                // Kích hoạt tính điểm
                runJob(propId).catch(err => {
                    console.error(`[JOB-RECALC] Lỗi tính lại điểm cho P_ID ${propId}:`, err);
                });

            } catch (syncError) {
                console.error(`[SYNC FAILED] Không thể đồng bộ P_ID ${propId}:`, syncError.message);
                return res.status(404).json({ 
                    error: 'Phòng trọ không tồn tại hoặc không thể đồng bộ.' 
                });
            }
        }
    } catch (err) {
        console.error('[LỖI CHECK PROPERTY]', err.message);
        return res.status(500).json({ error: 'Lỗi máy chủ nội bộ khi kiểm tra phòng trọ.' });
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
                propId, user_id, ratingSa, review_text || null,
                ratingCl, ratingAm, ratingHo // <-- THAM SỐ MỚI
            ]
        };

        const result = await pool.query(query);
        const newReview = result.rows[0];
        
        console.log(`[API USER] User ${user_id} đã review (tổng quan) P_ID ${propId}.`);

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
          } else {
            console.log(
              `[PATCH SUCCESS] Đã cập nhật trạng thái review cho rent history ${rentHistoryId}`
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
        console.log(`[JOB-TRIGGER] Kích hoạt tính điểm lại cho P_ID ${propId}...`);
        runJob(propId).catch(err => {
            console.error(`[JOB-RECALC] Lỗi tính lại điểm cho P_ID ${propId}:`, err);
        });

    } catch (err) {
        console.error('[LỖI API POST]', err.message);
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Bạn đã review phòng trọ này rồi.' });
        }
        res.status(500).json({ error: 'Lỗi máy chủ nội bộ khi thêm review.' });
    }
});


// --- 6. ROUTE DỰ PHÒNG VÀ KHỞI ĐỘNG ---

// Endpoint "Health Check"
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'API Server is running healthy.' });
});

// Chuyển hướng các trang frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'property-detail.html'));
});
app.get('/admin', (req, res) => {
    res.sendFile(path.join(publicPath, 'admin.html'));
});
app.get('/review', (req, res) => {
    res.sendFile(path.join(publicPath, 'review.html'));
});

// Khởi động Server
app.listen(PORT, () => {
    console.log(`[SERVER] API Server đang lắng nghe tại http://localhost:${PORT}`);
    console.log(`[SERVER] Đang sử dụng CSDL: ${dbConfig.database} trên ${dbConfig.host}`);
    console.log('[SERVER] Các trang có sẵn: / (Chi tiết), /admin, /review');
});