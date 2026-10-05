import { Component, Container } from "@di-framework/core/decorators";
import type { SqlDatabase } from "../../core/persistence/database.ts";
import { ensureForecastSchema } from "../../core/persistence/schema.ts";
import { SQL_DATABASE } from "../configuration.ts";

/** Applies the forecast DDL once per isolate; a failed attempt is retried by the next request. */
@Container()
export class ForecastSchema {
    private ready?: Promise<void>;

    constructor(@Component(SQL_DATABASE) private readonly db: SqlDatabase) {}

    ensure(): Promise<void> {
        this.ready ??= ensureForecastSchema(this.db).catch((error: unknown) => {
            this.ready = undefined;
            throw error;
        });
        return this.ready;
    }
}
