import type { SqlDatabase } from "./database.ts";

export const SCHEMA_SQL = [
    `CREATE TABLE IF NOT EXISTS predictions (
        repository TEXT NOT NULL,
        subject TEXT NOT NULL,
        model TEXT NOT NULL,
        metric TEXT NOT NULL,
        predicted REAL NOT NULL,
        recorded_at TEXT NOT NULL,
        snapshot_id TEXT,
        lane TEXT,
        PRIMARY KEY (repository, subject, model, metric)
    )`,
    `CREATE TABLE IF NOT EXISTS observations (
        repository TEXT NOT NULL,
        subject TEXT NOT NULL,
        metric TEXT NOT NULL,
        actual REAL NOT NULL,
        observed_at TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (repository, subject, metric)
    )`,
    `CREATE TABLE IF NOT EXISTS calibrations (
        repository TEXT NOT NULL PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        factors TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )`,
] as const;

export async function ensureForecastSchema(db: SqlDatabase): Promise<void> {
    for (const statement of SCHEMA_SQL) await db.prepare(statement).run();
    // Databases created before the calibration columns existed keep their original CREATE.
    await addColumn(db, "predictions", "snapshot_id", "TEXT");
    await addColumn(db, "predictions", "lane", "TEXT");
}

async function addColumn(db: SqlDatabase, table: string, column: string, definition: string): Promise<void> {
    const info = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    if (info.results.some((row) => row.name === column)) return;
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}
