import { Component } from "@di-framework/core/decorators";
import { EntityRepository, Repository } from "@di-framework/repo/portable";
import { CompositeSqlAdapter } from "../persistence/composite-sql-adapter.ts";
import { SQL_DATABASE, type SqlDatabase } from "../persistence/database.ts";
import type { Observation } from "../tracking/model.ts";

@Repository({ singleton: false })
export class ObservationRepository extends EntityRepository<Observation, string> {
    declare protected readonly adapter: CompositeSqlAdapter<Observation>;

    constructor(@Component(SQL_DATABASE) private readonly db: SqlDatabase) {
        super(
            new CompositeSqlAdapter(
                db,
                {
                    table: "observations",
                    entityToRow: ({ observedAt, ...row }) => ({ ...row, observed_at: observedAt }),
                    rowToEntity: (row) => ({
                        repository: row.repository as string,
                        subject: row.subject as string,
                        metric: row.metric as string,
                        actual: row.actual as number,
                        source: row.source as string,
                        observedAt: row.observed_at as string,
                    }),
                },
                ["repository", "subject", "metric"],
            ),
        );
    }

    // Domain query: retain SQL-side repository filtering without loading other repositories.
    findForRepository(repository: string): Promise<Observation[]> {
        return this.adapter.findWhere({ repository });
    }

    async repositoryNames(): Promise<string[]> {
        const rows = await this.db
            .prepare("SELECT DISTINCT repository FROM observations")
            .all<{ repository: string }>();
        return rows.results.map((row) => row.repository);
    }
}
