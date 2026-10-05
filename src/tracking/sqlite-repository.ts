import { EntityRepository, type SqlAdapterOptions } from "@di-framework/repo/portable";
import { CompositeSqlAdapter } from "./composite-sql-adapter.ts";
import type { SqlDatabase } from "./ledger.ts";

export type SqliteRepositoryOptions<E> = Omit<SqlAdapterOptions<E>, "idColumn"> & {
    /** Ordered SQLite primary-key columns, including single-column keys. */
    keyColumns: readonly string[];
};

/** SQLite repository for local SQLite and D1 bindings using existing tables. */
export class SqliteRepository<E extends Record<string, unknown>> extends EntityRepository<E, string> {
    private readonly sql: CompositeSqlAdapter<E>;
    private readonly keyCount: number;

    constructor(db: SqlDatabase, { keyColumns, ...mapping }: SqliteRepositoryOptions<E>) {
        const adapter = new CompositeSqlAdapter<E>(db, mapping, keyColumns);
        super(adapter);
        this.sql = adapter;
        this.keyCount = keyColumns.length;
    }

    /** Encode key values in keyColumns order without delimiter collisions. */
    key(...values: Array<string | number>): string {
        if (
            values.length !== this.keyCount ||
            values.some((value) => typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value)))
        )
            throw new Error("Invalid composite identity");
        return JSON.stringify(values);
    }

    findWhere(filter: Record<string, unknown>): Promise<E[]> {
        return this.sql.findWhere(filter);
    }

    count(filter?: Record<string, unknown>): Promise<number> {
        return this.sql.count(filter);
    }

    exists(id: string): Promise<boolean> {
        return this.sql.exists(id);
    }

    saveIfAbsent(entity: E): Promise<boolean> {
        return this.sql.saveIfAbsent(entity);
    }
}
