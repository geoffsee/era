import { PredictionRepository } from "../repositories/prediction-repository.ts";
import { ObservationRepository } from "../repositories/observation-repository.ts";
import { Component, Container } from "@di-framework/core/decorators";
import {
    assertFinite,
    assertRepository,
    assertTimestamp,
    assertToken,
    InputError,
    type AccuracyReport,
    type Observation,
    type Prediction,
} from "../../core/tracking/model.ts";
import { scoreRepository } from "../../core/tracking/score.ts";

@Container()
export class AccuracyService {
    constructor(
        @Component(PredictionRepository) private readonly predictionRows: PredictionRepository,
        @Component(ObservationRepository) private readonly observationRows: ObservationRepository,
    ) {}

    async recordPredictions(inputs: readonly unknown[], now = new Date().toISOString()): Promise<number> {
        const rows = inputs.map((input) => parsePrediction(input, now));
        for (const row of rows) await this.predictionRows.save(row);
        return rows.length;
    }

    async recordObservations(inputs: readonly unknown[], now = new Date().toISOString()): Promise<number> {
        const rows = inputs.map((input) => parseObservation(input, now));
        for (const row of rows) await this.observationRows.save(row);
        return rows.length;
    }

    async accuracy(repository: string): Promise<AccuracyReport[]> {
        const name = assertRepository(repository);
        return scoreRepository(name, await this.predictionRows.scoredPairs(name));
    }

    async predictions(repository: string): Promise<Prediction[]> {
        return this.predictionRows.findForRepository(assertRepository(repository));
    }

    async observations(repository: string): Promise<Observation[]> {
        return this.observationRows.findForRepository(assertRepository(repository));
    }

    async repositories(): Promise<string[]> {
        const names = await Promise.all([
            this.predictionRows.repositoryNames(),
            this.observationRows.repositoryNames(),
        ]);
        return [...new Set(names.flat())].sort();
    }
}

function parsePrediction(input: unknown, now: string): Prediction {
    const record = object(input, "prediction");
    return {
        repository: assertRepository(stringField(record, "repository")),
        subject: assertToken(stringField(record, "subject"), "subject"),
        model: assertToken(stringField(record, "model"), "model"),
        metric: assertToken(stringField(record, "metric"), "metric"),
        predicted: assertFinite(record.predicted, "predicted"),
        recordedAt: assertTimestamp(optionalString(record, "recordedAt"), now),
    };
}

function parseObservation(input: unknown, now: string): Observation {
    const record = object(input, "observation");
    return {
        repository: assertRepository(stringField(record, "repository")),
        subject: assertToken(stringField(record, "subject"), "subject"),
        metric: assertToken(stringField(record, "metric"), "metric"),
        actual: assertFinite(record.actual, "actual"),
        observedAt: assertTimestamp(optionalString(record, "observedAt"), now),
        source: optionalString(record, "source") ?? "manual",
    };
}

function object(input: unknown, label: string): Record<string, unknown> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new InputError(`${label} must be an object`);
    }
    return input as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) throw new InputError(`${key} is required`);
    return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new InputError(`${key} must be a string`);
    return value;
}
