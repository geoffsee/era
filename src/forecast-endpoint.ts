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
import { parseRoadmapConfig, roadmapHistory } from "./roadmap-format.ts";
import { assertAccess, HttpError, type Identity } from "./tracking/auth.ts";
import { tokenBacktest } from "./tracking/backtest.ts";
import type { Ledger } from "./tracking/ledger.ts";
import { scoreRepository } from "./tracking/score.ts";

export async function handleForecastRequest(
    request: Request,
    identity: Identity | undefined,
    ledger: Ledger,
): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/v1/estimates", "/v1/backtests", "/v1/roadmap-validations"].includes(path))
        return undefined;
    if (!identity) throw new HttpError("unauthorized", 401);
    const content = object(await readJson(request), "request");
    const repository = repositoryField(content.repository);
    assertAccess(identity, repository);
    if (path === "/v1/roadmap-validations") return Response.json(validateRoadmapRequest(content));
    const now = new Date().toISOString();
    if (path === "/v1/estimates") {
        const input = parseForecastRequest(content);
        const result = calculateForecast(input, now);
        const stored = input.record ? await storage(() => ledger.savePredictions(result.predictions)) : 0;
        return Response.json({ ...result, stored });
    }
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
              predictions: await storage(() => ledger.savePredictions(batch.predictions)),
              observations: await storage(() => ledger.saveObservations(batch.observations)),
          }
        : { predictions: 0, observations: 0 };
    const reports = record
        ? scoreRepository(repository, await storage(() => ledger.pairs(repository)))
        : previewReports;
    return Response.json({ repository, ...batch, reports, stored });
}

async function storage<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch {
        throw new HttpError("forecast storage is unavailable", 503);
    }
}

async function readJson(request: Request): Promise<unknown> {
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
        throw new HttpError("content-type must be application/json", 415);
    const limit = 2 * 1024 * 1024;
    if (Number(request.headers.get("content-length")) > limit)
        throw new HttpError("forecast request is limited to 2 MiB", 413);
    const reader = request.body?.getReader();
    if (!reader) throw new ForecastInputError("JSON body is required");
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) {
                await reader.cancel();
                throw new HttpError("forecast request is limited to 2 MiB", 413);
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
    } finally {
        reader.releaseLock();
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new ForecastInputError("body must be valid JSON");
    }
}
