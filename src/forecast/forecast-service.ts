import { estimateRoadmap, type RoadmapEstimate } from "./estimator.ts";
import type { ForecastRequest, JsonEstimate } from "./forecast-contract.ts";
import { parseForecastPlan } from "./forecast-plan.ts";
import { renderEstimate } from "./format.ts";
import { EMPTY_REVIEW_POOL, type HistoricalData } from "../history/history.ts";
import { parseRoadmapConfig, resolveRoadmap } from "../roadmap/roadmap-format.ts";
import { assertRepository, type Prediction } from "../tracking/model.ts";

export class ForecastInputError extends Error {}

export function parseForecastRequest(value: unknown): ForecastRequest {
    const input = object(value, "forecast request");
    const repository = repositoryField(input.repository);
    const roadmap = object(input.roadmap, "roadmap");
    integer(roadmap.number, "roadmap number", 0);
    text(roadmap.title, "roadmap title");
    text(roadmap.body, "roadmap body");
    const roadmapConfig = asInput(() => parseRoadmapConfig(input.roadmapConfig));
    issueStrings(roadmap.titles ?? {}, "roadmap titles");
    if (roadmap.states !== undefined) issueStrings(roadmap.states, "roadmap states");
    const history = parseHistory(input.history, repository);
    const record = recordField(input.record);
    if (record && roadmap.number === 0) throw new ForecastInputError("recording requires a real roadmap issue number");
    const plan = input.plan === undefined ? undefined : asInput(() => parseForecastPlan(input.plan));
    return { repository, roadmap: roadmap as ForecastRequest["roadmap"], history, record, plan, roadmapConfig };
}

export function validateRoadmapRequest(value: unknown) {
    const input = object(value, "roadmap validation request");
    const repository = repositoryField(input.repository);
    const source = object(input.roadmap, "roadmap");
    text(source.body, "roadmap body");
    const titles = source.titles ?? {};
    issueStrings(titles, "roadmap titles");
    return asInput(() => {
        const config = parseRoadmapConfig(input.roadmapConfig);
        const result = resolveRoadmap(
            source.body as string,
            new Map(Object.entries(titles as Record<string, string>).map(([id, title]) => [Number(id), title])),
            config,
        );
        return {
            repository,
            format: config.format,
            roadmap: result.roadmap,
            sourceGates: result.sourceGates,
            diagnostics: result.graph.diagnostics,
            executionDependencies: [...result.graph.predecessors].flatMap(([after, before]) =>
                [...before].map((before) => ({ before, after })),
            ),
        };
    });
}

export function calculateForecast(input: ForecastRequest, now: string) {
    const estimate = asInput(() =>
        estimateRoadmap({
            issueNumber: input.roadmap.number,
            issueTitle: input.roadmap.title,
            issueBody: input.roadmap.body,
            titles: new Map(Object.entries(input.roadmap.titles ?? {}).map(([id, title]) => [Number(id), title])),
            issueStates: input.roadmap.states
                ? new Map(Object.entries(input.roadmap.states).map(([id, state]) => [Number(id), state]))
                : undefined,
            history: input.history.pullRequests,
            reviewPool: input.history.reviewPool,
            authorOverhead: input.history.authorOverhead,
            historyGeneratedAt: input.history.generatedAt,
            plan: input.plan,
            roadmapConfig: input.roadmapConfig,
        }),
    );
    const { labels, epicTokens, epicPoints, epicReviewRatio, epicReviewCicdSeconds, ...calibration } =
        estimate.calibration;
    const serialized: JsonEstimate = {
        ...estimate,
        calibration: {
            ...calibration,
            labels: Object.fromEntries(labels),
            epicTokens: Object.fromEntries(epicTokens),
            epicPoints: Object.fromEntries(epicPoints),
            epicReviewRatio: Object.fromEntries(epicReviewRatio),
            epicReviewCicdSeconds: Object.fromEntries(epicReviewCicdSeconds),
        },
    };
    assertFiniteResult(serialized);
    return {
        repository: input.repository,
        estimate: serialized,
        report: renderEstimate(estimate, input.repository),
        predictions: estimate.issueNumber === 0 ? [] : predictionsFromEstimate(input.repository, estimate, now),
    };
}

/** JSON would silently replace nonfinite numbers with null. Reject them before persistence. */
export function assertFiniteResult(result: unknown): void {
    JSON.stringify(result, (_key, value) => {
        if (typeof value === "number" && !Number.isFinite(value))
            throw new ForecastInputError("forecast quantities must produce finite results");
        return value;
    });
}

export function parseHistory(value: unknown, repository: string): HistoricalData {
    const history = object(value, "history");
    if (history.repository !== repository)
        throw new ForecastInputError("historical repository does not match requested repository");
    const rows = array(history.pullRequests, "historical pullRequests");
    const ids = new Set<number>();
    for (const value of rows) {
        const row = object(value, "historical PR");
        const number = integer(row.number, "historical PR number");
        if (ids.has(number)) throw new ForecastInputError(`duplicate historical PR #${number}`);
        ids.add(number);
        text(row.title, "historical PR title");
        if (!["MERGED", "OPEN", "CLOSED"].includes(row.state as string))
            throw new ForecastInputError("historical PR state must be MERGED, OPEN or CLOSED");
        if (typeof row.epic === "string") {
            text(row.epic, "historical PR epic");
            if (/^\d+$/.test(row.epic)) throw new ForecastInputError("Use a number for a numeric historical PR epic");
        } else if (row.epic !== null) integer(row.epic, "historical PR epic");
        for (const key of [
            "turns",
            "uncachedInputTokens",
            "cacheReadTokens",
            "totalInputTokens",
            "outputTokens",
            "thinkingTokens",
            "totalTokens",
            "failedJobs",
            "successfulJobs",
            "cicdSeconds",
        ])
            quantity(row[key], key);
        if (
            row.totalInputTokens !== (row.uncachedInputTokens as number) + (row.cacheReadTokens as number) ||
            row.totalTokens !== (row.totalInputTokens as number) + (row.outputTokens as number) ||
            (row.thinkingTokens as number) > (row.outputTokens as number)
        )
            throw new ForecastInputError(`historical PR #${number} token categories do not reconcile`);
        for (const key of ["reviewTokens", "pricedReviewTokens", "reviewCostUsd", "reviewCicdSeconds"])
            if (row[key] !== undefined) quantity(row[key], key);
        if (((row.pricedReviewTokens as number) ?? 0) > ((row.reviewTokens as number) ?? 0))
            throw new ForecastInputError("priced review tokens exceed observed review tokens");
        for (const key of ["cicdObserved", "reviewObserved"])
            if (row[key] !== undefined && typeof row[key] !== "boolean")
                throw new ForecastInputError(`${key} must be boolean`);
        for (const key of ["createdAt", "mergedAt"]) if (row[key] !== undefined) text(row[key], key);
    }
    if (history.generatedAt !== undefined) text(history.generatedAt, "history generatedAt");
    if (history.authorOverhead !== undefined) {
        const overhead = object(history.authorOverhead, "authorOverhead");
        for (const key of [
            "uncachedInputTokens",
            "cacheReadTokens",
            "outputTokens",
            "totalTokens",
            "attributedAuthorTokens",
        ])
            quantity(overhead[key], key);
        if (
            overhead.totalTokens !==
            (overhead.uncachedInputTokens as number) +
                (overhead.cacheReadTokens as number) +
                (overhead.outputTokens as number)
        )
            throw new ForecastInputError("author overhead categories do not reconcile");
    }
    const pool = object(history.reviewPool ?? EMPTY_REVIEW_POOL, "reviewPool");
    for (const key of ["unattributedReviewTokens", "followupTokens", "reviewLoopTokens", "inheritedReviewTokens"])
        quantity(pool[key], key);
    if (!Array.isArray(pool.gaps) || pool.gaps.some((value) => typeof value !== "string"))
        throw new ForecastInputError("review gaps must be strings");
    for (const value of array(pool.unmatchedReviews, "unmatchedReviews", true)) {
        const row = object(value, "unmatched review");
        for (const key of ["reviewTokens", "pricedReviewTokens", "reviewCostUsd", "reviewCicdSeconds"])
            quantity(row[key], key);
        if ((row.pricedReviewTokens as number) > (row.reviewTokens as number))
            throw new ForecastInputError("priced unmatched review tokens exceed observed tokens");
    }
    return { ...history, reviewPool: pool } as HistoricalData;
}

export function recordField(value: unknown): boolean {
    if (value !== undefined && typeof value !== "boolean") throw new ForecastInputError("record must be boolean");
    return value === true;
}

export function repositoryField(value: unknown): string {
    text(value, "repository");
    return asInput(() => assertRepository(value as string));
}

export function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new ForecastInputError(`${label} must be an object`);
    return value as Record<string, unknown>;
}

function text(value: unknown, label: string): void {
    if (typeof value !== "string" || !value.trim()) throw new ForecastInputError(`${label} must be a nonempty string`);
}

function quantity(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        throw new ForecastInputError(`${label} must be finite and nonnegative`);
    return value;
}

function integer(value: unknown, label: string, minimum = 1): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
        throw new ForecastInputError(`${label} must be an integer >= ${minimum}`);
    return value;
}

function array(value: unknown, label: string, empty = false): unknown[] {
    if (!Array.isArray(value) || (!empty && value.length === 0) || value.length > 1000)
        throw new ForecastInputError(`${label} must contain ${empty ? "0" : "1"}–1000 rows`);
    return value;
}

function issueStrings(value: unknown, label: string): void {
    const entries = Object.entries(object(value, label));
    if (entries.length > 1000) throw new ForecastInputError(`${label} is limited to 1000 rows`);
    for (const [id, name] of entries) {
        if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
            throw new ForecastInputError(`invalid issue ID ${id}`);
        text(name, label);
    }
}

function asInput<T>(fn: () => T): T {
    try {
        return fn();
    } catch (error) {
        throw new ForecastInputError(error instanceof Error ? error.message : "invalid forecast input");
    }
}

function predictionsFromEstimate(repository: string, estimate: RoadmapEstimate, recordedAt: string): Prediction[] {
    const row = (subject: number, model: string, metric: string, predicted: number): Prediction => ({
        repository,
        subject: `issue:${subject}`,
        model,
        metric,
        predicted,
        recordedAt,
    });
    return [
        row(estimate.issueNumber, "token-threshold", "tokens", estimate.rawTokens),
        row(estimate.issueNumber, "token-threshold", "tokens_effective", estimate.effectiveTokens),
        row(estimate.issueNumber, "seeagent", "story_points", estimate.storyPoints),
        row(estimate.issueNumber, "delivery-cost-v2", "usd_subtotal", estimate.pricedSubtotalUsd),
        ...estimate.children.flatMap((child) => [
            row(child.issue, "token-threshold", "tokens", child.tokens),
            row(child.issue, "seeagent", "story_points", child.storyPoints),
        ]),
    ];
}
