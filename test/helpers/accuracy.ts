import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import { ObservationRepository } from "../../src/app/repositories/observation-repository.ts";
import { PredictionRepository } from "../../src/app/repositories/prediction-repository.ts";
import { AccuracyService } from "../../src/app/services/accuracy-service.ts";
import type { SqlDatabase } from "../../src/core/persistence/database.ts";
import { SCHEMA_SQL } from "../../src/core/persistence/schema.ts";
import { BunSqlDatabase } from "../../src/core/persistence/sqlite.ts";
import { env } from "../cloudflare.ts";

const databases: Database[] = [];
afterEach(() => {
    for (const database of databases.splice(0)) database.close();
});

/** Disposable in-memory SQLite with the forecast schema applied; closed after each test. */
export function createTestDatabase(): SqlDatabase {
    const database = new Database(":memory:");
    databases.push(database);
    for (const sql of SCHEMA_SQL) database.run(sql);
    return new BunSqlDatabase(database);
}

/**
 * The production service over its production repositories, bound to one database.
 * That database also becomes the Worker's DB binding for requests sent afterwards.
 */
export function createTestAccuracyService(db: SqlDatabase = createTestDatabase()): AccuracyService {
    env.DB = db;
    return new AccuracyService(new PredictionRepository(db), new ObservationRepository(db));
}
