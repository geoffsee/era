import { Database } from "bun:sqlite";
import type { SqlDatabase, SqlStatement } from "./ledger.ts";

export class BunSqlDatabase implements SqlDatabase {
    constructor(private readonly database: Database) {}

    prepare(query: string): SqlStatement {
        const statement = this.database.prepare(query);
        const bound = (values: Array<string | number | null>): SqlStatement => ({
            bind: (...next) => bound(next),
            run: () => {
                statement.run(...values);
                return Promise.resolve();
            },
            all: <T>() => Promise.resolve({ results: statement.all(...values) as T[] }),
        });
        return bound([]);
    }
}
