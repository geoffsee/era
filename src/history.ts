export type HistoricalPullRequest = {
    number: number;
    title: string;
    state: string;
    createdAt?: string;
    mergedAt?: string;
    epic: number | null;
    turns: number;
    uncachedInputTokens: number;
    cacheReadTokens: number;
    totalInputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    totalTokens: number;
    failedJobs: number;
    successfulJobs: number;
    cicdSeconds: number;
    /** Codex review-loop tokens attributed to this pull request. Absent means none were joined. */
    reviewTokens?: number;
    pricedReviewTokens?: number;
    reviewCostUsd?: number;
    reviewCicdSeconds?: number;
    /** False means the CI/review extract did not contain an observation for this PR. */
    cicdObserved?: boolean;
    reviewObserved?: boolean;
};

export type HistoricalAuthorOverhead = {
    uncachedInputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
    attributedAuthorTokens: number;
};

export type UnmatchedReview = {
    reviewTokens: number;
    pricedReviewTokens: number;
    reviewCostUsd: number;
    reviewCicdSeconds: number;
};

export type ReviewPool = {
    unattributedReviewTokens: number;
    followupTokens: number;
    reviewLoopTokens: number;
    inheritedReviewTokens: number;
    gaps: string[];
    /** Review usage for pull requests that are not in the author-token extract. */
    unmatchedReviews: UnmatchedReview[];
};

export const EMPTY_REVIEW_POOL: ReviewPool = {
    unattributedReviewTokens: 0,
    followupTokens: 0,
    reviewLoopTokens: 0,
    inheritedReviewTokens: 0,
    gaps: [],
    unmatchedReviews: [],
};

export function epicNumberFromTitle(title: string): number | null {
    const match = title.match(/\bE(\d+)\.(\d+)\b/);
    return match ? Number(match[1]) : null;
}

export function isCalibrationSample(pullRequest: HistoricalPullRequest): boolean {
    return pullRequest.state === "MERGED" && pullRequest.totalTokens > 0;
}

export type HistoricalData = {
    pullRequests: HistoricalPullRequest[];
    reviewPool: ReviewPool;
    authorOverhead?: HistoricalAuthorOverhead;
    repository?: string;
    generatedAt?: string;
};
