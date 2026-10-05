import {
    type CostGap,
    forecastAuthorOverhead,
    type InfrastructureBilling,
    nonNegative,
    priceInfrastructure,
    priceTokens,
    type TokenQuantities,
    type TokenRateCard,
} from "./accounting.ts";
import { type ForecastPlan, HUMAN_ACTIVITIES, parseForecastPlan, type RemainingWork } from "./forecast-plan.ts";
import {
    EMPTY_REVIEW_POOL,
    type HistoricalAuthorOverhead,
    type HistoricalPullRequest,
    isCalibrationSample,
    type ReviewPool,
} from "./history.ts";
import { type buildDependencyGraph, laneForIssue } from "./roadmap.ts";
import {
    type CalibrationGroup,
    parseRoadmapConfig,
    type RoadmapConfig,
    resolveRoadmap,
    roadmapHistory,
} from "./roadmap-format.ts";
import {
    baseTokensFromStoryPoints,
    complexityWeight,
    contextFactor,
    hitlCost,
    llmCost,
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
    type TokenSize,
    tokenSize,
    totalCost,
} from "./theory.ts";
import { type ChronologicalValidation, chronologicalTokenValidation } from "./validation.ts";

/** Assumed future routing; mixed-model history cannot reconstruct model-specific historical bills. */
export const SONNET_46 = {
    id: "claude-sonnet-4-6",
    inputPerToken: 3 / 1_000_000,
    outputPerToken: 15 / 1_000_000,
    cacheReadPerToken: 0.3 / 1_000_000,
} as const;

export const DEFAULT_AUTHOR_RATE_CARD: TokenRateCard = {
    inputPerToken: SONNET_46.inputPerToken,
    outputPerToken: SONNET_46.outputPerToken,
    cacheReadPerToken: SONNET_46.cacheReadPerToken,
    model: SONNET_46.id,
    currency: "USD",
    asOf: "2026-10-05",
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    provenance: "assumed",
};

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
    authorTokenMix: TokenQuantities;
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
    epicTokens: Map<CalibrationGroup, number>;
    epicPoints: Map<CalibrationGroup, number>;
    reviewCoveredPullRequests: number;
    reviewCoverage: number;
    medianReviewTokenRatio: number;
    medianAbsoluteReviewTokens: number;
    reviewPricePerToken: number;
    medianReviewCicdSeconds: number;
    medianAbsoluteReviewCicdSeconds: number;
    coveredAuthorTokens: number;
    unattributedReviewTokens: number;
    unpairedReviewTokens: number;
    followupTokenShare: number;
    inheritedTokenShare: number;
    epicReviewRatio: Map<CalibrationGroup, number>;
    epicReviewCicdSeconds: Map<CalibrationGroup, number>;
    reviewGaps: string[];
};

export type ChildEstimate = {
    issue: number;
    laneId: string;
    epic: CalibrationGroup | null;
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
    reviewTokens: number;
    reviewLlmCost: number;
    reviewInfraCost: number;
    sizing: {
        basis: "repository-median" | "epic-median" | "comparables";
        sampleCount: number;
        comparablePrs: number[];
        authorBlocks: number;
        source: string;
    };
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
    reviewTokens: number;
    reviewLlmCost: number;
    reviewInfraCost: number;
    reviewPoolTokens: number;
    reviewPoolCost: number;
    totalCost: number;
    /** Priced components only. totalCost is retained as a compatibility alias, not a full delivery total. */
    pricedSubtotalUsd: number;
    authorOverheadTokens: number;
    authorOverheadCost: number;
    allAgentTokens: number;
    costGaps: CostGap[];
    scopeDiagnostics: string[];
    authorRateCard: TokenRateCard;
    historyGeneratedAt?: string;
    humanHours: number;
    explicitHumanActivities: boolean;
    planSource?: string;
    illustrativeTokenCost: number;
    backtest: Backtest;
    tokenValidation: ChronologicalValidation;
    assumptions: Assumptions;
};

export function calibrate(
    history: readonly HistoricalPullRequest[],
    pool: ReviewPool = EMPTY_REVIEW_POOL,
    rates: TokenRateCard = DEFAULT_AUTHOR_RATE_CARD,
): Calibration {
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
    const outputShares = outputTokens.map((tokens, index) =>
        baseTokens[index]! > 0 ? tokens / baseTokens[index]! : 0,
    );
    const gammas = sample.map((pullRequest, index) => {
        const points = labels.get(pullRequest.number)!;
        return baseTokens[index]! / (points * complexityWeight(points));
    });

    const observedCi = sample.filter((pullRequest) => pullRequest.cicdObserved !== false);
    const failed = sum(observedCi.map((pullRequest) => pullRequest.failedJobs));
    const finished = sum(observedCi.map((pullRequest) => pullRequest.failedJobs + pullRequest.successfulJobs));
    const rejectionRate = finished === 0 ? 0 : failed / finished;
    const dirtyTurns = observedCi
        .filter((pullRequest) => pullRequest.failedJobs > 0)
        .map((pullRequest) => pullRequest.turns);
    const cleanTurns = observedCi
        .filter((pullRequest) => pullRequest.failedJobs === 0)
        .map((pullRequest) => pullRequest.turns);
    const extraInvocations =
        dirtyTurns.length === 0 || cleanTurns.length === 0
            ? 0
            : Math.max(0, median(dirtyTurns) / median(cleanTurns) - 1);

    const ratios = sample
        .filter((pullRequest) => pullRequest.uncachedInputTokens > 0)
        .map((pullRequest) => pullRequest.totalInputTokens / pullRequest.uncachedInputTokens);
    const alpha = ratios.length === 0 ? 0 : Math.max(0, median(ratios) - 1);
    // Legacy formula evaluates context at the segment end; it does not alter the priced subtotal.
    const factor = contextFactor(alpha, 1, 1);

    let billed = 0;
    let consumed = 0;
    for (const pullRequest of sample) {
        if (
            pullRequest.uncachedInputTokens + pullRequest.cacheReadTokens + pullRequest.outputTokens !==
            pullRequest.totalTokens
        ) {
            throw new Error(`token categories do not reconcile for historical PR #${pullRequest.number}`);
        }
        billed += priceTokens(pullRequest, rates);
        consumed += pullRequest.totalTokens;
    }

    const pointValues = [...labels.values()];
    const tokensByEpic = new Map<CalibrationGroup, number[]>();
    const pointsByEpic = new Map<CalibrationGroup, number[]>();
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
        authorTokenMix: {
            uncachedInputTokens: sum(sample.map((row) => row.uncachedInputTokens)) / consumed,
            cacheReadTokens: sum(sample.map((row) => row.cacheReadTokens)) / consumed,
            outputTokens: sum(sample.map((row) => row.outputTokens)) / consumed,
        },
        sampleCount: sample.length,
        medianTotalTokens: median(totals),
        medianUncachedInput: median(sample.map((pullRequest) => pullRequest.uncachedInputTokens)),
        medianOutputTokens: median(outputTokens),
        medianCacheRead: median(sample.map((pullRequest) => pullRequest.cacheReadTokens)),
        medianCicdSeconds:
            observedCi.length === 0 ? 0 : median(observedCi.map((pullRequest) => pullRequest.cicdSeconds)),
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
        ...reviewCalibration(history, sample, pool),
    };
}

function reviewCalibration(
    history: readonly HistoricalPullRequest[],
    sample: readonly HistoricalPullRequest[],
    pool: ReviewPool,
): Pick<
    Calibration,
    | "reviewCoveredPullRequests"
    | "reviewCoverage"
    | "medianReviewTokenRatio"
    | "medianAbsoluteReviewTokens"
    | "reviewPricePerToken"
    | "medianReviewCicdSeconds"
    | "medianAbsoluteReviewCicdSeconds"
    | "coveredAuthorTokens"
    | "unattributedReviewTokens"
    | "unpairedReviewTokens"
    | "followupTokenShare"
    | "inheritedTokenShare"
    | "epicReviewRatio"
    | "epicReviewCicdSeconds"
    | "reviewGaps"
> {
    const covered = sample.filter((pullRequest) => (pullRequest.reviewTokens ?? 0) > 0);
    const unmatched = covered.length === 0 ? pool.unmatchedReviews : [];
    const ratios = covered.map((pullRequest) => (pullRequest.reviewTokens ?? 0) / pullRequest.totalTokens);
    const pricedTokens = sum(
        covered.length > 0
            ? covered.map((pullRequest) => pullRequest.pricedReviewTokens ?? 0)
            : unmatched.map((pullRequest) => pullRequest.pricedReviewTokens),
    );
    const pricedCost = sum(
        covered.length > 0
            ? covered.map((pullRequest) => pullRequest.reviewCostUsd ?? 0)
            : unmatched.map((pullRequest) => pullRequest.reviewCostUsd),
    );
    const ratiosByEpic = new Map<CalibrationGroup, number[]>();
    const cicdByEpic = new Map<CalibrationGroup, number[]>();
    let unpairedReviewTokens = 0;
    for (const pullRequest of history) {
        const reviewTokens = pullRequest.reviewTokens ?? 0;
        if (reviewTokens <= 0 || isCalibrationSample(pullRequest)) continue;
        unpairedReviewTokens += reviewTokens;
    }
    for (const pullRequest of covered) {
        if (pullRequest.epic === null) continue;
        const ratio = (pullRequest.reviewTokens ?? 0) / pullRequest.totalTokens;
        const ratiosForEpic = ratiosByEpic.get(pullRequest.epic) ?? [];
        ratiosForEpic.push(ratio);
        ratiosByEpic.set(pullRequest.epic, ratiosForEpic);
        const cicdForEpic = cicdByEpic.get(pullRequest.epic) ?? [];
        cicdForEpic.push(pullRequest.reviewCicdSeconds ?? 0);
        cicdByEpic.set(pullRequest.epic, cicdForEpic);
    }
    return {
        reviewCoveredPullRequests: covered.length,
        reviewCoverage: sample.length === 0 ? 0 : covered.length / sample.length,
        medianReviewTokenRatio: ratios.length === 0 ? 0 : median(ratios),
        medianAbsoluteReviewTokens:
            unmatched.length === 0 ? 0 : median(unmatched.map((pullRequest) => pullRequest.reviewTokens)),
        reviewPricePerToken: pricedTokens === 0 ? 0 : pricedCost / pricedTokens,
        medianReviewCicdSeconds:
            covered.length === 0 ? 0 : median(covered.map((pullRequest) => pullRequest.reviewCicdSeconds ?? 0)),
        medianAbsoluteReviewCicdSeconds:
            unmatched.length === 0 ? 0 : median(unmatched.map((pullRequest) => pullRequest.reviewCicdSeconds)),
        coveredAuthorTokens: sum(covered.map((pullRequest) => pullRequest.totalTokens)),
        unattributedReviewTokens: pool.unattributedReviewTokens,
        unpairedReviewTokens,
        followupTokenShare: pool.reviewLoopTokens === 0 ? 0 : pool.followupTokens / pool.reviewLoopTokens,
        inheritedTokenShare: pool.reviewLoopTokens === 0 ? 0 : pool.inheritedReviewTokens / pool.reviewLoopTokens,
        epicReviewRatio: new Map([...ratiosByEpic].map(([epic, values]) => [epic, median(values)])),
        epicReviewCicdSeconds: new Map([...cicdByEpic].map(([epic, values]) => [epic, median(values)])),
        reviewGaps: pool.gaps,
    };
}

export function estimateRoadmap(input: {
    issueNumber: number;
    issueTitle: string;
    issueBody: string;
    titles: ReadonlyMap<number, string>;
    history: readonly HistoricalPullRequest[];
    assumptions?: Assumptions;
    reviewPool?: ReviewPool;
    authorOverhead?: HistoricalAuthorOverhead;
    authorRateCard?: TokenRateCard;
    infrastructureBilling?: InfrastructureBilling;
    historyGeneratedAt?: string;
    plan?: ForecastPlan;
    issueStates?: ReadonlyMap<number, string>;
    roadmapConfig?: RoadmapConfig;
}): RoadmapEstimate {
    const plan = input.plan ? parseForecastPlan(input.plan) : undefined;
    const assumptions = input.assumptions ?? DEFAULT_ASSUMPTIONS;
    for (const [name, value] of Object.entries(assumptions)) nonNegative(value, name);
    const authorRateCard = plan?.authorRateCard ?? input.authorRateCard ?? DEFAULT_AUTHOR_RATE_CARD;
    const config = parseRoadmapConfig(input.roadmapConfig);
    const resolved = resolveRoadmap(input.issueBody, input.titles, config);
    const graph = resolved.graph;
    const items = new Map(resolved.roadmap.items.map((item) => [item.issue, item]));
    const history = roadmapHistory(input.history, config);
    for (const id of Object.keys(plan?.work ?? {})) {
        if (!graph.nodes.includes(Number(id)))
            throw new Error(`work plan #${id} is outside remaining roadmap membership`);
        if (items.get(Number(id))?.kind === "epic")
            throw new Error(`work plan #${id} is an epic tracker; size its delivery children`);
    }
    const calibration = calibrate(history, input.reviewPool ?? EMPTY_REVIEW_POOL, authorRateCard);

    const children: ChildEstimate[] = [];
    let epicCount = 0;
    for (const issue of graph.nodes) {
        const item = items.get(issue)!;
        const title = item.title;
        if (!title?.trim()) throw new Error(`Missing issue title for #${issue}`);
        if (item.kind === "epic") {
            epicCount += 1;
            continue;
        }
        const work = plan?.work?.[String(issue)];
        if (item.acceptance && work && !work.accepted)
            throw new Error(`Work plan #${issue} conflicts with roadmap acceptance evidence`);
        if (work?.accepted || item.acceptance) {
            graph.diagnostics.push(`Excluded accepted delivery #${issue}: ${item.acceptance?.source ?? work?.source}`);
            continue;
        }
        if (input.issueStates?.get(issue)?.toLowerCase() === "closed") {
            graph.diagnostics.push(
                `Issue #${issue} is closed but has no explicit acceptance evidence; its remaining load is still estimated.`,
            );
        }
        const peers = work?.comparablePrs?.map((number) => {
            const peer = history.find((candidate) => candidate.number === number && isCalibrationSample(candidate));
            if (!peer) throw new Error(`Comparable PR #${number} for issue #${issue} has no merged author usage`);
            return peer;
        });
        children.push(
            estimateChild(
                issue,
                item.calibrationGroup ?? null,
                graph.lanes,
                peers ? calibrate(peers, EMPTY_REVIEW_POOL, authorRateCard) : calibration,
                assumptions,
                authorRateCard,
                work,
                plan?.humanActivities !== undefined,
                history,
                calibration,
            ),
        );
    }

    const weights = new Map<number, number>(graph.nodes.map((issue) => [issue, 0]));
    for (const child of children) weights.set(child.issue, child.tokens);
    const critical = longestPath(graph.nodes, graph.predecessors, (issue) => weights.get(issue) ?? 0);
    const criticalWork = critical.path.filter((issue) => (weights.get(issue) ?? 0) > 0);

    const rawTokens = sum(children.map((child) => child.tokens));
    const llm = sum(children.map((child) => child.llmCost));
    const literalLlm = sum(children.map((child) => child.literalLlmCost));
    const hitl =
        plan?.humanActivities !== undefined
            ? sum(plan.humanActivities.map((activity) => activity.hours * activity.usdPerHour))
            : sum(children.map((child) => child.hitlCost));
    const humanHours =
        plan?.humanActivities !== undefined
            ? sum(plan.humanActivities.map((activity) => activity.hours))
            : children.length *
              (assumptions.checkpointsPerTask * assumptions.reviewHours +
                  calibration.rejectionRate * assumptions.reworkHours);
    const billing = plan?.infrastructureBilling ?? input.infrastructureBilling;
    const infra = priceInfrastructure(billing);
    const reviewTokens = sum(children.map((child) => child.reviewTokens));
    const reviewLlm = sum(children.map((child) => child.reviewLlmCost));
    const reviewInfra = sum(children.map((child) => child.reviewInfraCost));
    const poolTokens = calibration.unattributedReviewTokens + calibration.unpairedReviewTokens;
    const reviewPoolDenominator =
        calibration.coveredAuthorTokens || sum(input.history.filter(isCalibrationSample).map((row) => row.totalTokens));
    const reviewPoolTokens = poolTokens * (rawTokens / reviewPoolDenominator);
    const reviewPoolCost = reviewPoolTokens * calibration.reviewPricePerToken;
    const overhead = forecastAuthorOverhead(rawTokens, input.authorOverhead, authorRateCard);
    const authorOverheadTokens = overhead?.tokens ?? 0;
    const authorOverheadCost = overhead?.cost ?? 0;
    const pricedSubtotalUsd =
        totalCost(llm, hitl, infra) + reviewLlm + reviewInfra + reviewPoolCost + authorOverheadCost;
    const costGaps: CostGap[] = [
        {
            category: "live-infrastructure",
            detail: "Disposable hosts, reboot/soak occupancy, performance hosts, storage, transfer, publication and separately billed tools are unpriced.",
        },
        {
            category: "cache-writes",
            detail: "The author extract has no separate cache-write quantity; distinct cache-write charges are unpriced.",
        },
    ];
    const missingHuman =
        plan?.humanActivities === undefined
            ? HUMAN_ACTIVITIES.filter((activity) => activity !== "review")
            : HUMAN_ACTIVITIES.filter((activity) => !plan.humanActivities!.some((row) => row.activity === activity));
    if (missingHuman.length > 0)
        costGaps.push({
            category: "human-delivery",
            detail: `Unpriced human activities: ${missingHuman.join(", ")}. Provided activities are assumptions; missing hours are not zero.`,
        });
    if (!overhead)
        costGaps.push({
            category: "author-orchestration",
            detail: "Author orchestration usage or its allocation denominator is unavailable.",
        });
    if (!billing)
        costGaps.push({
            category: "infrastructure",
            detail: "Runner billing applicability and billable job quantities are unavailable. Historical CI spans are not priced as runner minutes.",
        });
    if (calibration.reviewPricePerToken === 0)
        costGaps.push({
            category: "agent-review",
            detail: "Review usage/pricing observations are unavailable; missing joins do not establish zero review cost.",
        });
    if (calibration.reviewPricePerToken > 0 && calibration.reviewCoverage < 1)
        costGaps.push({
            category: "review-coverage",
            detail: `Review calibration covers ${calibration.reviewCoveredPullRequests}/${calibration.sampleCount} merged PRs; remaining review loads are imputed, and missing workflows may change cost.`,
        });
    for (const detail of calibration.reviewGaps) costGaps.push({ category: "review-source", detail });
    costGaps.push({
        category: "billing-agreement",
        detail: `Future author routing/rates are ${authorRateCard.provenance}; historical review dollar rates, subscription allowances, credit conversion and account-specific terms are not verified for the forecast.`,
    });

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
        reviewTokens,
        reviewLlmCost: reviewLlm,
        reviewInfraCost: reviewInfra,
        reviewPoolTokens,
        reviewPoolCost,
        totalCost: pricedSubtotalUsd,
        pricedSubtotalUsd,
        authorOverheadTokens,
        authorOverheadCost,
        allAgentTokens: rawTokens + reviewTokens + reviewPoolTokens + authorOverheadTokens,
        costGaps,
        scopeDiagnostics: graph.diagnostics,
        authorRateCard,
        historyGeneratedAt: input.historyGeneratedAt,
        humanHours,
        explicitHumanActivities: plan?.humanActivities !== undefined,
        planSource: plan?.source,
        illustrativeTokenCost: rawTokens * calibration.blendedPricePerToken,
        backtest: leaveOneOut(history, calibration),
        tokenValidation: chronologicalTokenValidation(history),
        assumptions,
    };
}

function estimateChild(
    issue: number,
    epic: CalibrationGroup | null,
    lanes: ReturnType<typeof buildDependencyGraph>["lanes"],
    calibration: Calibration,
    assumptions: Assumptions,
    rates: TokenRateCard,
    work: RemainingWork | undefined,
    explicitHumanActivities: boolean,
    history: readonly HistoricalPullRequest[],
    repositoryCalibration: Calibration,
): ChildEstimate {
    const typicalTokens =
        !work?.comparablePrs && epic !== null && calibration.epicTokens.has(epic)
            ? calibration.epicTokens.get(epic)!
            : calibration.medianTotalTokens;
    const authorBlocks = work?.authorBlocks ?? 1;
    const tokens = typicalTokens * authorBlocks;
    const analogPoints =
        !work?.comparablePrs && epic !== null && calibration.epicPoints.has(epic)
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
    const reviewCalibration = calibration.reviewCoveredPullRequests > 0 ? calibration : repositoryCalibration;
    const reviewRatio =
        epic !== null && reviewCalibration.epicReviewRatio.has(epic)
            ? reviewCalibration.epicReviewRatio.get(epic)!
            : reviewCalibration.medianReviewTokenRatio;
    const reviewTokens =
        reviewRatio > 0 ? tokens * reviewRatio : reviewCalibration.medianAbsoluteReviewTokens * authorBlocks;
    const priced = {
        inputTokens,
        outputTokens,
        priceInPerToken: rates.inputPerToken,
        priceOutPerToken: rates.outputPerToken,
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
        llmCost: priceTokens(
            {
                uncachedInputTokens: tokens * calibration.authorTokenMix.uncachedInputTokens,
                cacheReadTokens: tokens * calibration.authorTokenMix.cacheReadTokens,
                outputTokens: tokens * calibration.authorTokenMix.outputTokens,
            },
            rates,
        ),
        literalLlmCost: llmCost(priced),
        hitlCost: explicitHumanActivities
            ? 0
            : hitlCost({
                  checkpoints: assumptions.checkpointsPerTask,
                  reviewHours: assumptions.reviewHours,
                  rejectionRate: repositoryCalibration.rejectionRate,
                  reworkHours: assumptions.reworkHours,
                  hourlyRate: assumptions.hourlyRateUsd,
              }),
        infraCost: 0,
        reviewTokens,
        reviewLlmCost: reviewTokens * reviewCalibration.reviewPricePerToken,
        reviewInfraCost: 0,
        sizing: {
            basis: work?.comparablePrs
                ? "comparables"
                : epic !== null && calibration.epicTokens.has(epic)
                  ? "epic-median"
                  : "repository-median",
            sampleCount:
                work?.comparablePrs?.length ??
                history.filter(
                    (row) =>
                        isCalibrationSample(row) &&
                        (epic === null || !calibration.epicTokens.has(epic) || row.epic === epic),
                ).length,
            comparablePrs: work?.comparablePrs ?? [],
            authorBlocks,
            source: work?.source ?? "Historical merged PR usage; remaining activity count assumed to be one typical PR",
        },
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
    return pullRequest.outputTokens;
}

function sum(values: readonly number[]): number {
    return values.reduce((total, value) => total + value, 0);
}
