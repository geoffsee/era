import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import { createAccuracyService } from "../../src/app/composition.ts";
import { SCHEMA_SQL } from "../../src/persistence/schema.ts";
import { BunSqlDatabase } from "../../src/persistence/sqlite.ts";

const databases: Database[] = [];
afterEach(() => {
    for (const database of databases.splice(0)) database.close();
});

export function createTestAccuracyService() {
    const database = new Database(":memory:");
    databases.push(database);
    for (const sql of SCHEMA_SQL) database.run(sql);
    return createAccuracyService(new BunSqlDatabase(database));
}
