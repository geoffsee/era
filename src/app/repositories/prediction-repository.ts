import { Component } from "@di-framework/core/decorators";
import { EntityRepository, Repository } from "@di-framework/repo/portable";
import { CompositeSqlAdapter } from "../../core/persistence/composite-sql-adapter.ts";
import type { SqlDatabase } from "../../core/persistence/database.ts";
import { SQL_DATABASE } from "../configuration.ts";
import type { LedgerPair, Prediction, ScoredPair } from "../../core/tracking/model.ts";

@Repository()
export class PredictionRepository extends EntityRepository<Prediction, string> {
    declare protected readonly adapter: CompositeSqlAdapter<Prediction>;

    constructor(@Component(SQL_DATABASE) private readonly db: SqlDatabase) {
        super(
            new CompositeSqlAdapter(
                db,
                {
                    table: "predictions",
                    entityToRow: ({ recordedAt, snapshotId, lane, ...row }) => ({
                        ...row,
                        recorded_at: recordedAt,
                        snapshot_id: snapshotId ?? null,
                        lane: lane ?? null,
                    }),
                    rowToEntity: (row) => ({
                        repository: row.repository as string,
                        subject: row.subject as string,
                        model: row.model as string,
                        metric: row.metric as string,
                        predicted: row.predicted as number,
                        recordedAt: row.recorded_at as string,
                        ...(row.snapshot_id ? { snapshotId: row.snapshot_id as string } : {}),
                        ...(row.lane ? { lane: row.lane as string } : {}),
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

    /** Joined predictions and observations, including lane and observation time. */
    async ledgerPairs(repository: string): Promise<LedgerPair[]> {
        const result = await this.db
            .prepare(
                `SELECT p.repository, p.subject, p.model, p.metric, p.predicted, p.lane, o.actual, o.observed_at
             FROM predictions p
             JOIN observations o
               ON o.repository = p.repository AND o.subject = p.subject AND o.metric = p.metric
             WHERE p.repository = ?1`,
            )
            .bind(repository)
            .all<{
                repository: string;
                subject: string;
                model: string;
                metric: string;
                predicted: number;
                lane: string | null;
                actual: number;
                observed_at: string;
            }>();
        return result.results.map((row) => ({
            repository: row.repository,
            subject: row.subject,
            model: row.model,
            metric: row.metric,
            predicted: row.predicted,
            actual: row.actual,
            observedAt: row.observed_at,
            ...(row.lane ? { lane: row.lane } : {}),
        }));
    }
}
