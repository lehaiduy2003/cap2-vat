// cap2-vat/migrations/run.js
// --- ĐÂY LÀ PHIÊN BẢN NÂNG CẤP ---
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Pool } = require('pg');
const fs = require('fs');

// --- 1. Cấu hình CSDL (Lấy từ .env) ---
const dbConfig = {
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: parseInt(process.env.PGPORT, 10),
};

const pool = new Pool(dbConfig);
pool.on('error', (err) => {
    console.error('[DB POOL] Lỗi kết nối CSDL:', err.message);
    process.exit(-1);
});

// Tên bảng dùng để theo dõi các migrations đã chạy
const MIGRATIONS_TABLE = 'schema_migrations';

/**
 * Đảm bảo bảng theo dõi (log) tồn tại
 */
async function ensureMigrationsTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS public.${MIGRATIONS_TABLE} (
            version VARCHAR(255) PRIMARY KEY NOT NULL,
            run_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

/**
 * Lấy danh sách các migrations đã chạy từ CSDL
 */
async function getRunMigrations(client) {
    try {
        const result = await client.query(`SELECT version FROM public.${MIGRATIONS_TABLE}`);
        // Dùng Set để tra cứu nhanh hơn
        return new Set(result.rows.map(r => r.version));
    } catch (err) {
        // Lỗi có thể xảy ra nếu bảng chưa tồn tại (chạy lần đầu tiên)
        return new Set();
    }
}

/**
 * Hàm chạy migration chính
 */
async function run() {
    console.log('[MIGRATE] Bắt đầu quá trình migration...');
    const client = await pool.connect();
    
    try {
        // 1. Đảm bảo bảng log tồn tại
        await ensureMigrationsTable(client);

        // 2. Lấy các migration đã chạy từ CSDL
        const runMigrations = await getRunMigrations(client);
        console.log(`[MIGRATE] Đã chạy ${runMigrations.size} migrations trước đó.`);

        // 3. Đọc tất cả file .sql từ thư mục
        const migrationDir = __dirname;
        const allFiles = fs.readdirSync(migrationDir)
            .filter(file => file.endsWith('.sql'))
            .sort(); // Sắp xếp để đảm bảo V1 chạy trước V2

        // 4. Lọc ra những file mới chưa chạy
        const newMigrations = allFiles.filter(file => !runMigrations.has(file));

        if (newMigrations.length === 0) {
            console.log('[MIGRATE] CSDL đã được cập nhật. Không có gì để chạy.');
            return;
        }

        console.log(`[MIGRATE] Tìm thấy ${newMigrations.length} migration mới:`, newMigrations);

        // 5. Chạy từng file migration mới
        for (const file of newMigrations) {
            console.log(`[MIGRATE] Đang chạy: ${file}...`);
            const sql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
            
            // Chạy trong một transaction để đảm bảo an toàn
            try {
                await client.query('BEGIN');
                
                // Thực thi file SQL
                await client.query(sql);
                
                // Ghi lại vào bảng log
                await client.query(`INSERT INTO public.${MIGRATIONS_TABLE} (version) VALUES ($1)`, [file]);
                
                await client.query('COMMIT');
                console.log(`[MIGRATE] Áp dụng thành công: ${file}`);
            } catch (txError) {
                await client.query('ROLLBACK');
                console.error(`[MIGRATE] LỖI khi chạy ${file}. Đã rollback.`, txError.message);
                // Dừng lại ngay nếu có lỗi
                throw txError;
            }
        }

        console.log('[MIGRATE] Tất cả migration mới đã được áp dụng thành công.');

    } catch (err) {
        console.error('[MIGRATE] Lỗi nghiêm trọng, tiến trình dừng lại.', err.message);
    } finally {
        await client.release();
        await pool.end();
        console.log('[MIGRATE] Đã đóng kết nối CSDL.');
    }
}

// Kích hoạt hàm
run();