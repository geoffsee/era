import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createAccuracyService } from "../app/composition.ts";
import { CompositeSqlAdapter } from "../persistence/composite-sql-adapter.ts";
import { PredictionRepository } from "./prediction-repository.ts";
import { SCHEMA_SQL } from "../persistence/schema.ts";
import { BunSqlDatabase } from "../persistence/sqlite.ts";

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
        const accuracyService = createAccuracyService(db);
        expect(await accuracyService.predictions("acme/app")).toEqual([
            { ...prediction, model: "second", predicted: 20 },
        ]);
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

test("SQLite adapter supports mapped single-column numeric identities and filtered reads", async () => {
    const database = new Database(":memory:");
    try {
        database.run("CREATE TABLE samples (sample_id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
        const repository = new CompositeSqlAdapter<{ id: number; label: string }>(
            new BunSqlDatabase(database),
            {
                table: "samples",
                entityToRow: ({ id, label }) => ({ sample_id: id, label }),
                rowToEntity: (row) => ({ id: row.sample_id as number, label: row.label as string }),
            },
            ["sample_id"],
        );
        const key = JSON.stringify([7]);
        expect(await repository.saveIfAbsent({ id: 7, label: "first" })).toBe(true);
        expect(await repository.saveIfAbsent({ id: 7, label: "duplicate" })).toBe(false);
        await repository.save({ id: 8, label: "second" });
        expect(await repository.findById(key)).toEqual({ id: 7, label: "first" });
        expect(await repository.exists(key)).toBe(true);
        expect(await repository.count()).toBe(2);
        expect(await repository.count({ label: "first" })).toBe(1);
        expect(await repository.findWhere({ label: "first" })).toEqual([{ id: 7, label: "first" }]);
        expect(await repository.findWhere({ label: "' OR 1=1 --" })).toEqual([]);
        await expect(repository.findById("[]")).rejects.toThrow("Invalid composite identity");
        await expect(repository.findById("[null]")).rejects.toThrow("Invalid composite identity");
        expect(
            () =>
                new CompositeSqlAdapter(
                    new BunSqlDatabase(database),
                    {
                        table: "samples",
                    },
                    ["sample_id", "sample_id"],
                ),
        ).toThrow("Composite keys must be SQL identifiers");
    } finally {
        database.close();
    }
});
