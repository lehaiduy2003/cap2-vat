-- 1. Tạo index GIST cho bảng security_incidents để tìm nhanh theo tọa độ
-- Giúp tăng tốc query: tìm các vụ trộm xung quanh nhà trọ
CREATE INDEX IF NOT EXISTS idx_incidents_location_gist ON public.security_incidents USING GIST (
    ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)
);

-- 2. Tạo index GIST cho bảng properties để tìm nhanh các nhà "hàng xóm"
-- Giúp tăng tốc query: khi ghim map, tìm các nhà trọ xung quanh để tính lại điểm
CREATE INDEX IF NOT EXISTS idx_properties_location_gist ON public.properties USING GIST (
    ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)
);

-- 3. Cho phép property_id được NULL (vì sự cố ghim map ngoài đường có thể không gắn với nhà nào)
ALTER TABLE public.security_incidents ALTER COLUMN property_id DROP NOT NULL;
-- 4. Tạo index B-tree cho cột property_id trong bảng security_incidents để tăng tốc join