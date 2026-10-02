import { epicNumberFromTitle, isCalibrationSample, type HistoricalPullRequest } from "./historical-data-repository.ts";
import { buildDependencyGraph, isEpicTitle, laneForIssue, parseRoadmap } from "./roadmap.ts";
import {
    baseTokensFromStoryPoints,
    complexityWeight,
    contextFactor,
    hitlCost,
    infraCost,
    llmCost,
    llmCostWithCacheReads,
    longestPath,
    meanAbsoluteError,
    meanMagnitudeRelativeError,
    median,
    nearestOnScale,
    negotiateEstimates,
    partitionCount,
    predictionWithin,
    quantile,
    revisionFactor,
    storyPointBreaks,
    storyPointsForTokens,
    tokenSize,
    totalCost,
    type TokenSize,
} from "./theory.ts";

/** Claude Sonnet 4.6 list prices, the only model in the historical token log. USD per token. */
export const SONNET_46 = {
    id: "claude-sonnet-4-6",
    inputPerToken: 3 / 1_000_000,
    outputPerToken: 15 / 1_000_000,
    cacheReadPerToken: 0.3 / 1_000_000,
} as const;

/** GitHub-hosted 2-core Linux runner list price. Public repositories are not billed for standard runners. */
export const LINUX_RUNNER_USD_PER_MINUTE = 0.006;

export const DEFAULT_ASSUMPTIONS = {
    /** HIS-3: one task-level checkpoint per decomposed child issue. */
    checkpointsPerTask: 1,
    reviewHours: 0.5,
    reworkHours: 1,
    /** Loaded hourly rate. The ACEM paper leaves W uncalibrated. */
    hourlyRateUsd: 150,
} as const;

export type Assumptions = {
    checkpointsPerTask: number;
    reviewHours: number;
    reworkHours: number;
    hourlyRateUsd: number;
};

export type Calibration = {
    sampleCount: number;
    medianTotalTokens: number;
    medianUncachedInput: number;
    medianOutputTokens: number;
    medianCacheRead: number;
    medianCicdSeconds: number;
    rejectionRate: number;
    extraInvocations: number;
    revisionFactor: number;
    alpha: number;
    contextFactor: number;
    gammaPerPoint: number;
    outputShareOfBase: number;
    blendedPricePerToken: number;
    medianStoryPoints: number;
    upperStoryPoints: number;
    pointBreaks: number[];
    labels: Map<number, number>;
    epicTokens: Map<number, number>;
    epicPoints: Map<number, number>;
};

export type ChildEstimate = {
    issue: number;
    laneId: string;
    epic: number | null;
    tokens: number;
    size: TokenSize;
    partitions: number;
    storyPoints: number;
    baseTokens: number;
    inputTokens: number;
    outputTokens: number;
    llmCost: number;
    literalLlmCost: number;
    hitlCost: number;
    infraCost: number;
};

export type Backtest = {
    count: number;
    mae: number;
    mmre: number;
    pred: number;
};

export type RoadmapEstimate = {
    issueNumber: number;
    issueTitle: string;
    childCount: number;
    epicCount: number;
    calibration: Calibration;
    children: ChildEstimate[];
    rawTokens: number;
    effectiveTokens: number;
    criticalPath: number[];
    partitions: number;
    storyPoints: number;
    llmCost: number;
    literalLlmCost: number;
    hitlCost: number;
    infraCost: number;
    totalCost: number;
    illustrativeTokenCost: number;
    backtest: Backtest;
    assumptions: Assumptions;
};

export function calibrate(history: readonly HistoricalPullRequest[]): Calibration {
    const sample = history.filter(isCalibrationSample);
    if (sample.length === 0) throw new Error("no merged pull requests with token usage");

    const totals = sample.map((pullRequest) => pullRequest.totalTokens);
    const breaks = storyPointBreaks(totals);
    const labels = new Map<number, number>();
    for (const pullRequest of sample) {
        labels.set(pullRequest.number, storyPointsForTokens(pullRequest.totalTokens, breaks));
    }

    const baseTokens = sample.map((pullRequest) => positionIndependentBase(pullRequest));
    const outputTokens = sample.map((pullRequest) => billedOutput(pullRequest));
    const outputShares = sample.map((pullRequest, index) => outputTokens[index]! / baseTokens[index]!);
    const gammas = sample.map((pullRequest, index) => {
        const points = labels.get(pullRequest.number)!;
        return baseTokens[index]! / (points * complexityWeight(points));
    });

    const failed = sum(sample.map((pullRequest) => pullRequest.failedJobs));
    const finished = sum(sample.map((pullRequest) => pullRequest.failedJobs + pullRequest.successfulJobs));
    const rejectionRate = finished === 0 ? 0 : failed / finished;
    const dirtyTurns = sample
        .filter((pullRequest) => pullRequest.failedJobs > 0)
        .map((pullRequest) => pullRequest.turns);
    const cleanTurns = sample
        .filter((pullRequest) => pullRequest.failedJobs === 0)
        .map((pullRequest) => pullRequest.turns);
    const extraInvocations =
        dirtyTurns.length === 0 || cleanTurns.length === 0
            ? 0
            : Math.max(0, median(dirtyTurns) / median(cleanTurns) - 1);

    const ratios = sample
        .filter((pullRequest) => pullRequest.uncachedInputTokens > 0)
        .map((pullRequest) => pullRequest.totalInputTokens / pullRequest.uncachedInputTokens);
    const alpha = Math.max(0, median(ratios) - 1);
    // Each child issue is its own agent session, so the segment ends at i = N.
    const factor = contextFactor(alpha, 1, 1);

    let billed = 0;
    let consumed = 0;
    for (const pullRequest of sample) {
        billed +=
            pullRequest.uncachedInputTokens * SONNET_46.inputPerToken +
            pullRequest.cacheReadTokens * SONNET_46.cacheReadPerToken +
            billedOutput(pullRequest) * SONNET_46.outputPerToken;
        consumed += pullRequest.totalTokens;
    }

    const pointValues = [...labels.values()];
    const tokensByEpic = new Map<number, number[]>();
    const pointsByEpic = new Map<number, number[]>();
    for (const pullRequest of sample) {
        if (pullRequest.epic === null) continue;
        const tokens = tokensByEpic.get(pullRequest.epic) ?? [];
        tokens.push(pullRequest.totalTokens);
        tokensByEpic.set(pullRequest.epic, tokens);
        const points = pointsByEpic.get(pullRequest.epic) ?? [];
        points.push(labels.get(pullRequest.number)!);
        pointsByEpic.set(pullRequest.epic, points);
    }

    return {
        sampleCount: sample.length,
        medianTotalTokens: median(totals),
        medianUncachedInput: median(sample.map((pullRequest) => pullRequest.uncachedInputTokens)),
        medianOutputTokens: median(outputTokens),
        medianCacheRead: median(sample.map((pullRequest) => pullRequest.cacheReadTokens)),
        medianCicdSeconds: median(sample.map((pullRequest) => pullRequest.cicdSeconds)),
        rejectionRate,
        extraInvocations,
        revisionFactor: revisionFactor(rejectionRate, extraInvocations),
        alpha,
        contextFactor: factor,
        gammaPerPoint: median(gammas),
        outputShareOfBase: median(outputShares),
        blendedPricePerToken: consumed === 0 ? 0 : billed / consumed,
        medianStoryPoints: nearestOnScale(median(pointValues)),
        upperStoryPoints: nearestOnScale(quantile(pointValues, 0.75)),
        pointBreaks: breaks,
        labels,
        epicTokens: new Map([...tokensByEpic].map(([epic, tokens]) => [epic, median(tokens)])),
        epicPoints: new Map([...pointsByEpic].map(([epic, points]) => [epic, nearestOnScale(median(points))])),
    };
}

export function estimateRoadmap(input: {
    issueNumber: number;
    issueTitle: string;
    issueBody: string;
    titles: ReadonlyMap<number, string>;
    history: readonly HistoricalPullRequest[];
    assumptions?: Assumptions;
}): RoadmapEstimate {
    const assumptions = input.assumptions ?? DEFAULT_ASSUMPTIONS;
    const parsed = parseRoadmap(input.issueBody);
    const graph = buildDependencyGraph(parsed.lanes, parsed.gates);
    const calibration = calibrate(input.history);

    const children: ChildEstimate[] = [];
    let epicCount = 0;
    for (const issue of graph.nodes) {
        const title = input.titles.get(issue) ?? "";
        if (isEpicTitle(title)) {
            epicCount += 1;
            continue;
        }
        children.push(estimateChild(issue, title, graph.lanes, calibration, assumptions));
    }

    const weights = new Map<number, number>(graph.nodes.map((issue) => [issue, 0]));
    for (const child of children) weights.set(child.issue, child.tokens);
    const critical = longestPath(graph.nodes, graph.predecessors, (issue) => weights.get(issue) ?? 0);
    const criticalWork = critical.path.filter((issue) => (weights.get(issue) ?? 0) > 0);

    const rawTokens = sum(children.map((child) => child.tokens));
    const llm = sum(children.map((child) => child.llmCost));
    const literalLlm = sum(children.map((child) => child.literalLlmCost));
    const hitl = sum(children.map((child) => child.hitlCost));
    const infra = sum(children.map((child) => child.infraCost));

    return {
        issueNumber: input.issueNumber,
        issueTitle: input.issueTitle,
        childCount: children.length,
        epicCount,
        calibration,
        children,
        rawTokens,
        effectiveTokens: critical.total,
        criticalPath: criticalWork,
        partitions: sum(children.map((child) => child.partitions)),
        storyPoints: sum(children.map((child) => child.storyPoints)),
        llmCost: llm,
        literalLlmCost: literalLlm,
        hitlCost: hitl,
        infraCost: infra,
        totalCost: totalCost(llm, hitl, infra),
        illustrativeTokenCost: rawTokens * calibration.blendedPricePerToken,
        backtest: leaveOneOut(input.history, calibration),
        assumptions,
    };
}

function estimateChild(
    issue: number,
    title: string,
    lanes: ReturnType<typeof buildDependencyGraph>["lanes"],
    calibration: Calibration,
    assumptions: Assumptions,
): ChildEstimate {
    const epic = epicNumberFromTitle(title);
    const tokens =
        epic !== null && calibration.epicTokens.has(epic)
            ? calibration.epicTokens.get(epic)!
            : calibration.medianTotalTokens;
    const analogPoints =
        epic !== null && calibration.epicPoints.has(epic)
            ? calibration.epicPoints.get(epic)!
            : calibration.medianStoryPoints;
    const storyPoints = negotiateEstimates([
        analogPoints,
        calibration.medianStoryPoints,
        calibration.upperStoryPoints,
    ]).estimate;

    const weight = complexityWeight(storyPoints);
    const base = baseTokensFromStoryPoints(storyPoints, calibration.gammaPerPoint, weight);
    const outputTokens = base * calibration.outputShareOfBase;
    const inputTokens = base - outputTokens;
    const scale = tokens / calibration.medianTotalTokens;
    const priced = {
        inputTokens,
        outputTokens,
        priceInPerToken: SONNET_46.inputPerToken,
        priceOutPerToken: SONNET_46.outputPerToken,
        revisionFactor: calibration.revisionFactor,
        contextFactor: calibration.contextFactor,
    };

    return {
        issue,
        laneId: laneForIssue(lanes, issue)?.id ?? "",
        epic,
        tokens,
        size: tokenSize(tokens),
        partitions: partitionCount(tokens),
        storyPoints,
        baseTokens: base,
        inputTokens,
        outputTokens,
        llmCost: llmCostWithCacheReads({
            ...priced,
            priceCacheReadPerToken: SONNET_46.cacheReadPerToken,
        }),
        literalLlmCost: llmCost(priced),
        hitlCost: hitlCost({
            checkpoints: assumptions.checkpointsPerTask,
            reviewHours: assumptions.reviewHours,
            rejectionRate: calibration.rejectionRate,
            reworkHours: assumptions.reworkHours,
            hourlyRate: assumptions.hourlyRateUsd,
        }),
        infraCost: infraCost((calibration.medianCicdSeconds * scale) / 60, LINUX_RUNNER_USD_PER_MINUTE),
    };
}

function leaveOneOut(history: readonly HistoricalPullRequest[], calibration: Calibration): Backtest {
    const sample = history.filter(isCalibrationSample);
    if (sample.length < 2) return { count: 0, mae: 0, mmre: 0, pred: 0 };
    const actual: number[] = [];
    const predicted: number[] = [];
    for (const held of sample) {
        const others = sample.filter((pullRequest) => pullRequest.number !== held.number);
        actual.push(calibration.labels.get(held.number)!);
        predicted.push(predictPoints(held, others, calibration.labels));
    }
    return {
        count: sample.length,
        mae: meanAbsoluteError(actual, predicted),
        mmre: meanMagnitudeRelativeError(actual, predicted),
        pred: predictionWithin(actual, predicted, 0.5),
    };
}

function predictPoints(
    target: HistoricalPullRequest,
    others: readonly HistoricalPullRequest[],
    labels: ReadonlyMap<number, number>,
): number {
    const otherLabels = others.map((pullRequest) => labels.get(pullRequest.number)!);
    const central = nearestOnScale(median(otherLabels));
    const upper = nearestOnScale(quantile(otherLabels, 0.75));
    const peers =
        target.epic === null
            ? []
            : others
                  .filter((pullRequest) => pullRequest.epic === target.epic)
                  .map((pullRequest) => labels.get(pullRequest.number)!);
    const analog = peers.length > 0 ? nearestOnScale(median(peers)) : central;
    return negotiateEstimates([analog, central, upper]).estimate;
}

function positionIndependentBase(pullRequest: HistoricalPullRequest): number {
    return pullRequest.uncachedInputTokens + billedOutput(pullRequest);
}

function billedOutput(pullRequest: HistoricalPullRequest): number {
    return pullRequest.outputTokens + pullRequest.thinkingTokens;
}

function sum(values: readonly number[]): number {
    return values.reduce((total, value) => total + value, 0);
}
