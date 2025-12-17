
-- 1. Bảng báo cáo ngập lụt từ cộng đồng
CREATE TABLE IF NOT EXISTS flood_reports (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(100), -- Người báo cáo (nếu có)
    water_level INTEGER, -- Mức ngập (cm). VD: 20, 50, 100
    description TEXT,
    report_date TIMESTAMP WITH TIME ZONE DEFAULT now(),
    is_verified BOOLEAN DEFAULT false, -- Admin xác thực hoặc nhiều người cùng báo
    location GEOGRAPHY(Point, 4326)
);

-- 2. Index không gian
CREATE INDEX IF NOT EXISTS idx_flood_location ON flood_reports USING GIST(location);

-- 3. Thêm cột cache vào bảng properties để không phải gọi API liên tục
ALTER TABLE properties ADD COLUMN IF NOT EXISTS elevation_meters DECIMAL(5, 2);