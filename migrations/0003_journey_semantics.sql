ALTER TABLE journey_definitions ADD COLUMN terminal_states_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE journey_definitions ADD COLUMN max_duration_days INTEGER NOT NULL DEFAULT 30 CHECK(max_duration_days BETWEEN 1 AND 30);
