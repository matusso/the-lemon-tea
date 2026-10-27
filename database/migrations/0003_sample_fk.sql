-- Telemetry rows must not outlive their session (deleting a session or tenant removes its samples).
ALTER TABLE car_samples ADD CONSTRAINT car_samples_session_fk FOREIGN KEY (session_uid) REFERENCES sessions(uid) ON DELETE CASCADE;
ALTER TABLE position_samples ADD CONSTRAINT position_samples_session_fk FOREIGN KEY (session_uid) REFERENCES sessions(uid) ON DELETE CASCADE;
