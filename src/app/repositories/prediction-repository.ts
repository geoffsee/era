import { Component } from "@di-framework/core/decorators";
import { EntityRepository, Repository } from "@di-framework/repo/portable";
import { CompositeSqlAdapter } from "../../core/persistence/composite-sql-adapter.ts";
import { SQL_DATABASE, type SqlDatabase } from "../../core/persistence/database.ts";
import type { Prediction, ScoredPair } from "../../core/tracking/model.ts";

@Repository({ singleton: false })
export class PredictionRepository extends EntityRepository<Prediction, string> {
    declare protected readonly adapter: CompositeSqlAdapter<Prediction>;

    constructor(@Component(SQL_DATABASE) private readonly db: SqlDatabase) {
        super(
            new CompositeSqlAdapter(
                db,
                {
                    table: "predictions",
                    entityToRow: ({ recordedAt, ...row }) => ({ ...row, recorded_at: recordedAt }),
                    rowToEntity: (row) => ({
                        repository: row.repository as string,
                        subject: row.subject as string,
                        model: row.model as string,
                        metric: row.metric as string,
                        predicted: row.predicted as number,
                        recordedAt: row.recorded_at as string,
                    }),
                },
                ["repository", "subject", "model", "metric"],
            ),
        );
    }

    // Domain query: retain SQL-side repository filtering without loading other repositories.
    findForRepository(repository: string): Promise<Prediction[]> {
        return this.adapter.findWhere({ repository });
    }

    async repositoryNames(): Promise<string[]> {
        const rows = await this.db.prepare("SELECT DISTINCT repository FROM predictions").all<{ repository: string }>();
        return rows.results.map((row) => row.repository);
    }
    async scoredPairs(repository: string): Promise<ScoredPair[]> {
        const result = await this.db
            .prepare(
                `SELECT p.repository, p.subject, p.model, p.metric, p.predicted, o.actual
             FROM predictions p
             JOIN observations o
               ON o.repository = p.repository AND o.subject = p.subject AND o.metric = p.metric
             WHERE p.repository = ?1`,
            )
            .bind(repository)
            .all<ScoredPair>();
        return result.results;
    }
}
