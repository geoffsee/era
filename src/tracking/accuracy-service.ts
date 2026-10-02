import { Component, Container } from "@di-framework/core/decorators";
import type { Ledger } from "./ledger.ts";
import {
    assertFinite,
    assertRepository,
    assertTimestamp,
    assertToken,
    type AccuracyReport,
    type Observation,
    type Prediction,
} from "./model.ts";
import { scoreRepository } from "./score.ts";

export const LEDGER = "ledger";

@Container({ singleton: false })
export class AccuracyService {
    @Component(LEDGER)
    private ledger!: Ledger;

    async recordPredictions(inputs: readonly unknown[], now = new Date().toISOString()): Promise<number> {
        return this.ledger.savePredictions(inputs.map((input) => parsePrediction(input, now)));
    }

    async recordObservations(inputs: readonly unknown[], now = new Date().toISOString()): Promise<number> {
        return this.ledger.saveObservations(inputs.map((input) => parseObservation(input, now)));
    }

    async accuracy(repository: string): Promise<AccuracyReport[]> {
        const name = assertRepository(repository);
        return scoreRepository(name, await this.ledger.pairs(name));
    }

    async predictions(repository: string): Promise<Prediction[]> {
        return this.ledger.predictions(assertRepository(repository));
    }

    async observations(repository: string): Promise<Observation[]> {
        return this.ledger.observations(assertRepository(repository));
    }

    async repositories(): Promise<string[]> {
        return this.ledger.repositories();
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
        throw new Error(`${label} must be an object`);
    }
    return input as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
    return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    return value;
}
