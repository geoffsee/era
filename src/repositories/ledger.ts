import { Component } from "@di-framework/core/decorators";
import { InMemoryRepository, Repository } from "@di-framework/repo/portable";
import { SqliteRepository } from "./sqlite-repository.ts";
import type { Observation, Prediction, ScoredPair } from "../tracking/model.ts";

import { SQL_DATABASE, type SqlDatabase } from "../persistence/database.ts";

export interface Ledger {
    savePredictions(predictions: readonly Prediction[]): Promise<number>;
    saveObservations(observations: readonly Observation[]): Promise<number>;
    pairs(repository: string): Promise<ScoredPair[]>;
    predictions(repository: string): Promise<Prediction[]>;
    observations(repository: string): Promise<Observation[]>;
    repositories(): Promise<string[]>;
}

@Repository({ singleton: false })
export class MemoryLedger implements Ledger {
    private readonly predictionRows = new InMemoryRepository<{ id: string; value: Prediction }, string>();
    private readonly observationRows = new InMemoryRepository<{ id: string; value: Observation }, string>();

    async savePredictions(predictions: readonly Prediction[]): Promise<number> {
        for (const prediction of predictions) {
            await this.predictionRows.save({ id: predictionKey(prediction), value: prediction });
        }
        return predictions.length;
    }

    async saveObservations(observations: readonly Observation[]): Promise<number> {
        for (const observation of observations) {
            await this.observationRows.save({ id: observationKey(observation), value: observation });
        }
        return observations.length;
    }

    async pairs(repository: string): Promise<ScoredPair[]> {
        const scored: ScoredPair[] = [];
        for (const prediction of (await this.predictionRows.findAll()).map((row) => row.value)) {
            if (prediction.repository !== repository) continue;
            const observation = (
                await this.observationRows.findById(
                    observationKey({
                        repository: prediction.repository,
                        subject: prediction.subject,
                        metric: prediction.metric,
                    }),
                )
            )?.value;
            if (!observation) continue;
            scored.push({
                repository,
                subject: prediction.subject,
                model: prediction.model,
                metric: prediction.metric,
                predicted: prediction.predicted,
                actual: observation.actual,
            });
        }
        return scored;
    }

    async predictions(repository: string): Promise<Prediction[]> {
        return Promise.resolve(
            [...(await this.predictionRows.findAll()).map((row) => row.value)].filter(
                (row) => row.repository === repository,
            ),
        );
    }

    async observations(repository: string): Promise<Observation[]> {
        return Promise.resolve(
            [...(await this.observationRows.findAll()).map((row) => row.value)].filter(
                (row) => row.repository === repository,
            ),
        );
    }

    async repositories(): Promise<string[]> {
        const names = new Set<string>();
        for (const row of (await this.predictionRows.findAll()).map((row) => row.value)) names.add(row.repository);
        for (const row of (await this.observationRows.findAll()).map((row) => row.value)) names.add(row.repository);
        return [...names].sort();
    }
}

function predictionKey(prediction: Pick<Prediction, "repository" | "subject" | "model" | "metric">): string {
    return JSON.stringify([prediction.repository, prediction.subject, prediction.model, prediction.metric]);
}

function observationKey(observation: Pick<Observation, "repository" | "subject" | "metric">): string {
    return JSON.stringify([observation.repository, observation.subject, observation.metric]);
}

export const SCHEMA_SQL = [
    `CREATE TABLE IF NOT EXISTS predictions (
        repository TEXT NOT NULL,
        subject TEXT NOT NULL,
        model TEXT NOT NULL,
        metric TEXT NOT NULL,
        predicted REAL NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (repository, subject, model, metric)
    )`,
    `CREATE TABLE IF NOT EXISTS observations (
        repository TEXT NOT NULL,
        subject TEXT NOT NULL,
        metric TEXT NOT NULL,
        actual REAL NOT NULL,
        observed_at TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (repository, subject, metric)
    )`,
] as const;

@Repository({ singleton: false })
export class PredictionRepository extends SqliteRepository<Prediction> {
    constructor(@Component(SQL_DATABASE) db: SqlDatabase) {
        super(db, {
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
            keyColumns: ["repository", "subject", "model", "metric"],
        });
    }
}

@Repository({ singleton: false })
export class ObservationRepository extends SqliteRepository<Observation> {
    constructor(@Component(SQL_DATABASE) db: SqlDatabase) {
        super(db, {
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
            keyColumns: ["repository", "subject", "metric"],
        });
    }
}

@Repository({ singleton: false })
export class D1Ledger implements Ledger {
    constructor(
        @Component(SQL_DATABASE) private readonly db: SqlDatabase,
        @Component(PredictionRepository) private readonly predictionRows: PredictionRepository,
        @Component(ObservationRepository) private readonly observationRows: ObservationRepository,
    ) {}

    async ensureSchema(): Promise<void> {
        for (const statement of SCHEMA_SQL) {
            await this.db.prepare(statement).run();
        }
    }

    async savePredictions(predictions: readonly Prediction[]): Promise<number> {
        for (const prediction of predictions) await this.predictionRows.save(prediction);
        return predictions.length;
    }

    async saveObservations(observations: readonly Observation[]): Promise<number> {
        for (const observation of observations) await this.observationRows.save(observation);
        return observations.length;
    }

    async pairs(repository: string): Promise<ScoredPair[]> {
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

    predictions(repository: string): Promise<Prediction[]> {
        return this.predictionRows.findWhere({ repository });
    }

    observations(repository: string): Promise<Observation[]> {
        return this.observationRows.findWhere({ repository });
    }

    async repositories(): Promise<string[]> {
        const result = await this.db
            .prepare(
                `SELECT repository FROM predictions
             UNION
             SELECT repository FROM observations
             ORDER BY repository`,
            )
            .bind()
            .all<{ repository: string }>();
        return result.results.map((row) => row.repository);
    }
}
