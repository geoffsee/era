import { AccuracyService } from "./accuracy-service.ts";
import { Component, Container } from "@di-framework/core/decorators";
import {
    assertFiniteResult,
    calculateForecast,
    ForecastInputError,
    object,
    parseForecastRequest,
    parseHistory,
    recordField,
    repositoryField,
    validateRoadmapRequest,
} from "./forecast-service.ts";
import { parseRoadmapConfig, roadmapHistory } from "../../core/roadmap/roadmap-format.ts";
import { assertAccess, HttpError, type Identity } from "../../core/auth/access.ts";
import { tokenBacktest } from "../../core/tracking/backtest.ts";
import { scoreRepository } from "../../core/tracking/score.ts";

@Container({ singleton: false })
export class ForecastService {
    constructor(@Component(AccuracyService) private readonly accuracyService: AccuracyService) {}

    validate(value: unknown, identity: Identity | undefined) {
        return validateRoadmapRequest(authorizedContent(value, identity));
    }

    async estimate(value: unknown, identity: Identity | undefined) {
        const input = parseForecastRequest(authorizedContent(value, identity));
        const result = calculateForecast(input, new Date().toISOString());
        const stored = input.record
            ? await storage(() => this.accuracyService.recordPredictions(result.predictions))
            : 0;
        return { ...result, stored };
    }

    async backtest(value: unknown, identity: Identity | undefined) {
        const content = authorizedContent(value, identity);
        const repository = repositoryField(content.repository);
        const now = new Date().toISOString();
        const history = parseHistory(content.history, repository);
        try {
            history.pullRequests = roadmapHistory(history.pullRequests, parseRoadmapConfig(content.roadmapConfig));
        } catch (error) {
            throw new ForecastInputError(error instanceof Error ? error.message : "Invalid roadmap configuration");
        }
        const record = recordField(content.record);
        if (history.pullRequests.filter((row) => row.state === "MERGED" && row.totalTokens > 0).length < 2)
            throw new ForecastInputError("backtest requires at least two merged PRs with tokens");
        const batch = tokenBacktest(repository, history.pullRequests, now);
        const actual = new Map(batch.observations.map((row) => [row.subject, row.actual]));
        const previewReports = scoreRepository(
            repository,
            batch.predictions.map((row) => ({ ...row, actual: actual.get(row.subject)! })),
        );
        assertFiniteResult({ ...batch, reports: previewReports });
        const stored = record
            ? {
                  predictions: await storage(() => this.accuracyService.recordPredictions(batch.predictions)),
                  observations: await storage(() => this.accuracyService.recordObservations(batch.observations)),
              }
            : { predictions: 0, observations: 0 };
        const reports = record ? await storage(() => this.accuracyService.accuracy(repository)) : previewReports;
        return { repository, ...batch, reports, stored };
    }
}
function authorizedContent(value: unknown, identity: Identity | undefined) {
    if (!identity) throw new HttpError("unauthorized", 401);
    const content = object(value, "request");
    assertAccess(identity, repositoryField(content.repository));
    return content;
}

async function storage<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch {
        throw new HttpError("forecast storage is unavailable", 503);
    }
}
