import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createLedger } from "./composition.ts";
import { CompositeSqlAdapter } from "./composite-sql-adapter.ts";
import { PredictionRepository, SCHEMA_SQL } from "./ledger.ts";
import { BunSqlDatabase } from "./sqlite.ts";

function fixture() {
    const database = new Database(":memory:");
    for (const sql of SCHEMA_SQL) database.run(sql);
    return { database, db: new BunSqlDatabase(database) };
}

const prediction = {
    repository: "acme/app",
    subject: "issue:1",
    model: "first",
    metric: "tokens",
    predicted: 10,
    recordedAt: "2026-10-05T00:00:00.000Z",
};
const id = (model: string, repository = "acme/app") => JSON.stringify([repository, "issue:1", model, "tokens"]);

test("framework repository preserves pre-existing composite rows, upserts, filters and deletes", async () => {
    const { database, db } = fixture();
    try {
        database.run("INSERT INTO predictions VALUES (?, ?, ?, ?, ?, ?)", [
            prediction.repository,
            prediction.subject,
            prediction.model,
            prediction.metric,
            5,
            prediction.recordedAt,
        ]);
        const repository = new PredictionRepository(db);
        expect((await repository.findById(id("first")))?.predicted).toBe(5);
        await repository.save(prediction);
        await repository.save({ ...prediction, model: "second", predicted: 20 });
        await repository.save({ ...prediction, repository: "other/app", predicted: 30 });
        expect(await repository.findById(id("first"))).toEqual(prediction);
        const page = await repository.findPaginated({
            page: 1,
            size: 1,
            filter: { repository: "acme/app" },
            sort: "model:asc",
        });
        expect(page.total).toBe(2);
        expect(page.items).toEqual([prediction]);
        expect(await repository.findMany([id("second"), id("missing")])).toEqual([
            { ...prediction, model: "second", predicted: 20 },
        ]);
        expect(await repository.delete(id("first"))).toBe(true);
        expect(await repository.delete(id("first"))).toBe(false);
        expect((await repository.findAll()).length).toBe(2);
        expect(await repository.findById(id("first", "other/app"))).not.toBeNull();
        const ledger = createLedger(db);
        expect(await ledger.predictions("acme/app")).toEqual([{ ...prediction, model: "second", predicted: 20 }]);
        expect(
            database
                .query("PRAGMA table_info(predictions)")
                .all()
                .map((column) => (column as { name: string }).name),
        ).toEqual(["repository", "subject", "model", "metric", "predicted", "recorded_at"]);
    } finally {
        database.close();
    }
});

test("composite adapter inserts conditionally and refuses non-atomic transaction callbacks", async () => {
    const { database, db } = fixture();
    try {
        const adapter = new CompositeSqlAdapter(db, { table: "observations" }, ["repository", "subject", "metric"]);
        const row = {
            repository: "acme/app",
            subject: "issue:1",
            metric: "tokens",
            actual: 3,
            observed_at: prediction.recordedAt,
            source: "test",
        };
        expect(await adapter.saveIfAbsent(row)).toBe(true);
        expect(await adapter.saveIfAbsent({ ...row, actual: 99 })).toBe(false);
        const key = JSON.stringify([row.repository, row.subject, row.metric]);
        expect(await adapter.exists(key)).toBe(true);
        expect(await adapter.findById(key)).toEqual(row);
        await expect(adapter.findById('["acme/app"]')).rejects.toThrow("Invalid composite identity");
        let called = false;
        await expect(
            adapter.compareAndSwap(key, () => {
                called = true;
                return row;
            }),
        ).rejects.toThrow("Interactive transactions");
        expect(called).toBe(false);
    } finally {
        database.close();
    }
});
