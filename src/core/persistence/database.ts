export const SQL_DATABASE = "era.sql-database";

export interface SqlStatement {
    bind(...values: Array<string | number | null>): SqlStatement;
    run(): Promise<unknown>;
    all<T>(): Promise<{ results: T[] }>;
}

export interface SqlDatabase {
    prepare(query: string): SqlStatement;
}
