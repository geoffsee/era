CREATE TABLE IF NOT EXISTS auth_records (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    value TEXT NOT NULL CHECK(json_valid(value)),
    expires_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS auth_record_expiry ON auth_records(kind, expires_at);
CREATE INDEX IF NOT EXISTS auth_key_owner ON auth_records(kind, json_extract(value, '$.userId'));
