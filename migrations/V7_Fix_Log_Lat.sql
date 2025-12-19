-- 1. Thêm cột location kiểu hình học (Geography) cho bảng properties
ALTER TABLE public.properties 
ADD COLUMN IF NOT EXISTS location geography(Point, 4326);

-- 2. Đổ dữ liệu từ 2 cột lat/long có sẵn sang cột location mới
UPDATE public.properties 
SET location = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
WHERE location IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL;

-- 3. Tạo Index để câu lệnh "tìm gần nhất" (<->) chạy được
CREATE INDEX IF NOT EXISTS idx_properties_location_gist ON public.properties USING GIST (location);