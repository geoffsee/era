import type { SqlDatabase } from "./database.ts";

export const SCHEMA_SQL = [
    `CREATE TABLE IF NOT EXISTS predictions (
        repository TEXT NOT NULL,
        subject TEXT NOT NULL,
        model TEXT NOT NULL,
        metric TEXT NOT NULL,
        predicted REAL NOT NULL,
        recorded_at TEXT NOT NULL,
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
] as const;

export async function ensureForecastSchema(db: SqlDatabase): Promise<void> {
    for (const statement of SCHEMA_SQL) await db.prepare(statement).run();
}
