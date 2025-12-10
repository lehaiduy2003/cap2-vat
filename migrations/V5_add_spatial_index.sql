-- migrations/V3_add_spatial_index.sql

-- 1. Tạo index GIST cho bảng security_incidents để tìm nhanh sự cố theo tọa độ
CREATE INDEX IF NOT EXISTS idx_incidents_location_gist ON public.security_incidents USING GIST (
    ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)
);

-- 2. Tạo index GIST cho bảng properties để tìm nhanh các nhà trọ lân cận
CREATE INDEX IF NOT EXISTS idx_properties_location_gist ON public.properties USING GIST (
    ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)
);

-- 3. Cho phép cột property_id nhận giá trị NULL
-- (Vì khi Admin ghim map ngoài đường, sự cố đó không thuộc về nhà trọ cụ thể nào)
ALTER TABLE public.security_incidents ALTER COLUMN property_id DROP NOT NULL;