ALTER TABLE ibx_domain.delivery_zones ADD COLUMN center_lat DECIMAL(9,6);
ALTER TABLE ibx_domain.delivery_zones ADD COLUMN center_lng DECIMAL(9,6);
ALTER TABLE ibx_domain.delivery_zones ADD COLUMN radius_km INTEGER;
