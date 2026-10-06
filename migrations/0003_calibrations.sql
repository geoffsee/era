-- migration:version 3
-- migration:description per-repository calibration factor vectors
-- Columns on predictions are added idempotently by ensureForecastSchema; this table is the new store.
CREATE TABLE IF NOT EXISTS calibrations (
    repository TEXT NOT NULL PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    factors TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
