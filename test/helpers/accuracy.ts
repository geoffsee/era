import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import { useContainer } from "@di-framework/core/container";
import { AccuracyService } from "../../src/app/services/accuracy-service.ts";
import { SQL_DATABASE, type SqlDatabase } from "../../src/core/persistence/database.ts";
import { SCHEMA_SQL } from "../../src/core/persistence/schema.ts";
import { BunSqlDatabase } from "../../src/core/persistence/sqlite.ts";

const databases: Database[] = [];
afterEach(() => {
    for (const database of databases.splice(0)) database.close();
});

export function createTestAccuracyService(db?: SqlDatabase) {
    if (!db) {
        const database = new Database(":memory:");
        databases.push(database);
        for (const sql of SCHEMA_SQL) database.run(sql);
        db = new BunSqlDatabase(database);
    }
    const container = useContainer();
    container.registerFactory(SQL_DATABASE, () => db!, { singleton: false });
    return container.construct(AccuracyService);
}
