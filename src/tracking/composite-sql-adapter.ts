import { sqlWhere, SqlStorageAdapter, type SqlAdapterOptions } from "@di-framework/repo/portable";
import type { SqlDatabase } from "./ledger.ts";

type Row = Record<string, unknown>;

/** Keeps existing composite SQL identities behind the framework's string-ID contract. */
export class CompositeSqlAdapter<E extends Row> extends SqlStorageAdapter<E, string> {
    private readonly keyColumns: string[];

    constructor(
        private readonly db: SqlDatabase,
        options: SqlAdapterOptions<E>,
        keys: readonly string[],
    ) {
        super(options);
        if (!keys.length || keys.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))
            throw new Error("Composite keys must be SQL identifiers");
        this.keyColumns = [...keys];
    }

    protected async allRows(sql: string, args: unknown[] = []): Promise<Row[]> {
        return (
            await this.db
                .prepare(sql)
                .bind(...bindings(args))
                .all<Row>()
        ).results;
    }

    protected async firstRow(sql: string, args: unknown[] = []): Promise<Row | null> {
        return (await this.allRows(sql, args))[0] ?? null;
    }

    protected async run(sql: string, args: unknown[] = []): Promise<{ changes?: number }> {
        await this.db
            .prepare(sql)
            .bind(...bindings(args))
            .run();
        return {};
    }

    private key(id: string) {
        const values: unknown = JSON.parse(id);
        if (
            !Array.isArray(values) ||
            values.length !== this.keyColumns.length ||
            values.some((v) => typeof v !== "string")
        )
            throw new Error("Invalid composite identity");
        return { sql: this.keyColumns.map((key) => `"${key}" = ?`).join(" AND "), values };
    }

    async findWhere(filter: Record<string, unknown>): Promise<E[]> {
        const where = sqlWhere(filter);
        return (await this.allRows(`SELECT * FROM ${this.table}${where.sql}`, where.args)).map(this.fromRow);
    }

    override async findById(id: string): Promise<E | null> {
        const key = this.key(id);
        const row = await this.firstRow(`SELECT * FROM ${this.table} WHERE ${key.sql}`, key.values);
        return row ? this.fromRow(row) : null;
    }

    override async findMany(ids: string[]): Promise<E[]> {
        const rows = await Promise.all(ids.map((id) => this.findById(id)));
        return rows.filter((row) => row !== null);
    }

    override async exists(id: string): Promise<boolean> {
        return (await this.findById(id)) !== null;
    }

    override async delete(id: string): Promise<boolean> {
        const key = this.key(id);
        const rows = await this.allRows(`DELETE FROM ${this.table} WHERE ${key.sql} RETURNING *`, key.values);
        return rows.length > 0;
    }

    override async save(entity: E): Promise<E> {
        await this.write(entity, false);
        return entity;
    }

    override async saveIfAbsent(entity: E): Promise<boolean> {
        return (await this.write(entity, true)).length > 0;
    }

    private write(entity: E, onlyIfAbsent: boolean): Promise<Row[]> {
        const row = this.toRow(entity);
        const columns = Object.keys(row);
        if (!columns.length || columns.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))
            throw new Error("Row columns must be SQL identifiers");
        const updates = columns.filter((key) => !this.keyColumns.includes(key));
        const conflict =
            onlyIfAbsent || !updates.length
                ? "DO NOTHING"
                : `DO UPDATE SET ${updates.map((key) => `"${key}" = excluded."${key}"`).join(", ")}`;
        return this.allRows(
            `INSERT INTO ${this.table} (${columns.map((key) => `"${key}"`).join(", ")})
             VALUES (${columns.map(() => "?").join(", ")})
             ON CONFLICT (${this.keyColumns.map((key) => `"${key}"`).join(", ")}) ${conflict} RETURNING *`,
            columns.map((key) => row[key]),
        );
    }

    // D1 cannot provide an interactive transaction around an arbitrary async callback.
    // Never imply that read/modify/write callbacks (including inherited CAS) are atomic.
    transaction<T>(_fn: (adapter: this) => Promise<T>): Promise<T> {
        return Promise.reject(new Error("Interactive transactions are not supported by the ledger adapter"));
    }
}

function bindings(values: unknown[]): Array<string | number | null> {
    return values.map((value) => {
        if (value === null || typeof value === "string" || typeof value === "number") return value;
        throw new Error("SQL bindings must be strings, numbers, or null");
    });
}
