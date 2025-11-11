CREATE TABLE incidents (
    incident_id SERIAL PRIMARY KEY,
    room_id INT NOT NULL, 
    incident_type VARCHAR(50) NOT NULL,
    severity VARCHAR(50) NOT NULL,
    date_occurred DATE NOT NULL,
    notes TEXT,
    reported_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_incidents_room_id ON incidents(room_id);