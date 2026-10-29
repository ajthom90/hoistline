-- Job results: the runner's exit code, and whether the stored output is only the tail.
ALTER TABLE jobs ADD COLUMN exit_code INTEGER;
-- Last 64 KiB of the job's output; output_truncated is 1 once anything before it was dropped.
ALTER TABLE jobs ADD COLUMN output_truncated INTEGER NOT NULL DEFAULT 0;
CREATE INDEX jobs_machine_status ON jobs(machine_id, status);
CREATE INDEX jobs_status ON jobs(status);
