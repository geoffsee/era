import { Container } from "@di-framework/core/decorators";
import type { Observation, Prediction, ScoredPair } from "./model.ts";

export interface Ledger {
    savePredictions(predictions: readonly Prediction[]): Promise<number>;
    saveObservations(observations: readonly Observation[]): Promise<number>;
    pairs(repository: string): Promise<ScoredPair[]>;
    predictions(repository: string): Promise<Prediction[]>;
    observations(repository: string): Promise<Observation[]>;
    repositories(): Promise<string[]>;
}

@Container({ singleton: false })
export class MemoryLedger implements Ledger {
    private readonly predictionRows = new Map<string, Prediction>();
    private readonly observationRows = new Map<string, Observation>();

    savePredictions(predictions: readonly Prediction[]): Promise<number> {
        for (const prediction of predictions) {
            this.predictionRows.set(predictionKey(prediction), prediction);
        }
        return Promise.resolve(predictions.length);
    }

    saveObservations(observations: readonly Observation[]): Promise<number> {
        for (const observation of observations) {
            this.observationRows.set(observationKey(observation), observation);
        }
        return Promise.resolve(observations.length);
    }

    pairs(repository: string): Promise<ScoredPair[]> {
        const scored: ScoredPair[] = [];
        for (const prediction of this.predictionRows.values()) {
            if (prediction.repository !== repository) continue;
            const observation = this.observationRows.get(
                observationKey({
                    repository: prediction.repository,
                    subject: prediction.subject,
                    metric: prediction.metric,
                }),
            );
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
        return Promise.resolve(scored);
    }

    predictions(repository: string): Promise<Prediction[]> {
        return Promise.resolve([...this.predictionRows.values()].filter((row) => row.repository === repository));
    }

    observations(repository: string): Promise<Observation[]> {
        return Promise.resolve([...this.observationRows.values()].filter((row) => row.repository === repository));
    }

    repositories(): Promise<string[]> {
        const names = new Set<string>();
        for (const row of this.predictionRows.values()) names.add(row.repository);
        for (const row of this.observationRows.values()) names.add(row.repository);
        return Promise.resolve([...names].sort());
    }
}

function predictionKey(prediction: Pick<Prediction, "repository" | "subject" | "model" | "metric">): string {
    return `${prediction.repository}\n${prediction.subject}\n${prediction.model}\n${prediction.metric}`;
}

function observationKey(observation: Pick<Observation, "repository" | "subject" | "metric">): string {
    return `${observation.repository}\n${observation.subject}\n${observation.metric}`;
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

export interface SqlStatement {
    bind(...values: Array<string | number | null>): SqlStatement;
    run(): Promise<unknown>;
    all<T>(): Promise<{ results: T[] }>;
}

export interface SqlDatabase {
    prepare(query: string): SqlStatement;
}

type PredictionRow = {
    repository: string;
    subject: string;
    model: string;
    metric: string;
    predicted: number;
    recorded_at: string;
};

type ObservationRow = {
    repository: string;
    subject: string;
    metric: string;
    actual: number;
    observed_at: string;
    source: string;
};

export class D1Ledger implements Ledger {
    constructor(private readonly db: SqlDatabase) {}

    async ensureSchema(): Promise<void> {
        for (const statement of SCHEMA_SQL) {
            await this.db.prepare(statement).run();
        }
    }

    async savePredictions(predictions: readonly Prediction[]): Promise<number> {
        for (const prediction of predictions) {
            await this.db
                .prepare(
                    `INSERT INTO predictions (repository, subject, model, metric, predicted, recorded_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (repository, subject, model, metric)
                 DO UPDATE SET predicted = excluded.predicted, recorded_at = excluded.recorded_at`,
                )
                .bind(
                    prediction.repository,
                    prediction.subject,
                    prediction.model,
                    prediction.metric,
                    prediction.predicted,
                    prediction.recordedAt,
                )
                .run();
        }
        return predictions.length;
    }

    async saveObservations(observations: readonly Observation[]): Promise<number> {
        for (const observation of observations) {
            await this.db
                .prepare(
                    `INSERT INTO observations (repository, subject, metric, actual, observed_at, source)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (repository, subject, metric)
                 DO UPDATE SET actual = excluded.actual, observed_at = excluded.observed_at, source = excluded.source`,
                )
                .bind(
                    observation.repository,
                    observation.subject,
                    observation.metric,
                    observation.actual,
                    observation.observedAt,
                    observation.source,
                )
                .run();
        }
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

    async predictions(repository: string): Promise<Prediction[]> {
        const result = await this.db
            .prepare(
                `SELECT repository, subject, model, metric, predicted, recorded_at
             FROM predictions WHERE repository = ?1`,
            )
            .bind(repository)
            .all<PredictionRow>();
        return result.results.map((row) => ({
            repository: row.repository,
            subject: row.subject,
            model: row.model,
            metric: row.metric,
            predicted: row.predicted,
            recordedAt: row.recorded_at,
        }));
    }

    async observations(repository: string): Promise<Observation[]> {
        const result = await this.db
            .prepare(
                `SELECT repository, subject, metric, actual, observed_at, source
             FROM observations WHERE repository = ?1`,
            )
            .bind(repository)
            .all<ObservationRow>();
        return result.results.map((row) => ({
            repository: row.repository,
            subject: row.subject,
            metric: row.metric,
            actual: row.actual,
            observedAt: row.observed_at,
            source: row.source,
        }));
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
