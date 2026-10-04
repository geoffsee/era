import { join } from "node:path";

export type HistoricalPullRequest = {
    number: number;
    title: string;
    state: string;
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

type TokenFile = {
    metadata: { repository?: string; total_prs_tracked?: number };
    pull_requests: Array<{
        pr_number: number;
        title: string;
        state: string;
        agent_turns_count: number;
        token_usage: {
            uncached_input_tokens: number;
            cache_read_input_tokens: number;
            total_input_tokens: number;
            output_tokens: number;
            thinking_tokens: number;
            total_tokens: number;
        };
    }>;
};

type CicdFile = Array<{
    pr_number: number;
    cicd_summary: {
        failed_jobs_count: number;
        successful_jobs_count: number;
        total_cicd_duration_seconds: number | null;
    };
}>;

export function epicNumberFromTitle(title: string): number | null {
    const match = title.match(/\bE(\d+)\.(\d+)\b/);
    return match ? Number(match[1]) : null;
}

export function isCalibrationSample(pullRequest: HistoricalPullRequest): boolean {
    return pullRequest.state === "MERGED" && pullRequest.totalTokens > 0;
}

type ReviewFile = {
    metadata: {
        unattributed_review_tokens: number;
        followup_tokens: number;
        review_loop_tokens: number;
        inherited_review_tokens: number;
        gaps: string[];
    };
    pull_requests: Array<{
        pr_number: number;
        review_tokens: number;
        priced_review_tokens: number;
        review_cost_usd: number;
        review_cicd_seconds: number;
    }>;
};

export async function loadHistoricalPullRequests(
    directory = join(import.meta.dir, "..", "historical-data"),
): Promise<HistoricalPullRequest[]> {
    return (await loadHistoricalData(directory)).pullRequests;
}

export async function loadHistoricalData(directory = join(import.meta.dir, "..", "historical-data")): Promise<{
    pullRequests: HistoricalPullRequest[];
    reviewPool: ReviewPool;
}> {
    const tokenFile = (await Bun.file(join(directory, "pr_token_usage_dataset.json")).json()) as TokenFile;
    const cicdFile = (await Bun.file(join(directory, "pr_cicd_dataset.json")).json()) as CicdFile;
    const reviewFile = Bun.file(join(directory, "pr_review_dataset.json"));
    const review = (await reviewFile.exists()) ? ((await reviewFile.json()) as ReviewFile) : null;
    const cicdByNumber = new Map(cicdFile.map((row) => [row.pr_number, row]));
    const reviewByNumber = new Map(review?.pull_requests.map((row) => [row.pr_number, row]) ?? []);
    const authorNumbers = new Set(tokenFile.pull_requests.map((pullRequest) => pullRequest.pr_number));

    return {
        pullRequests: tokenFile.pull_requests.map((pullRequest) => {
            const cicd = cicdByNumber.get(pullRequest.pr_number);
            const reviewed = reviewByNumber.get(pullRequest.pr_number);
            const usage = pullRequest.token_usage;
            return {
                number: pullRequest.pr_number,
                title: pullRequest.title,
                state: pullRequest.state,
                epic: epicNumberFromTitle(pullRequest.title),
                turns: pullRequest.agent_turns_count,
                uncachedInputTokens: usage.uncached_input_tokens,
                cacheReadTokens: usage.cache_read_input_tokens,
                totalInputTokens: usage.total_input_tokens,
                outputTokens: usage.output_tokens,
                thinkingTokens: usage.thinking_tokens,
                totalTokens: usage.total_tokens,
                failedJobs: cicd?.cicd_summary.failed_jobs_count ?? 0,
                successfulJobs: cicd?.cicd_summary.successful_jobs_count ?? 0,
                cicdSeconds: cicd?.cicd_summary.total_cicd_duration_seconds ?? 0,
                reviewTokens: reviewed?.review_tokens ?? 0,
                pricedReviewTokens: reviewed?.priced_review_tokens ?? 0,
                reviewCostUsd: reviewed?.review_cost_usd ?? 0,
                reviewCicdSeconds: reviewed?.review_cicd_seconds ?? 0,
            };
        }),
        reviewPool: review
            ? {
                  unattributedReviewTokens: review.metadata.unattributed_review_tokens,
                  followupTokens: review.metadata.followup_tokens,
                  reviewLoopTokens: review.metadata.review_loop_tokens,
                  inheritedReviewTokens: review.metadata.inherited_review_tokens,
                  gaps: review.metadata.gaps,
                  unmatchedReviews: review.pull_requests
                      .filter((row) => !authorNumbers.has(row.pr_number))
                      .map((row) => ({
                          reviewTokens: row.review_tokens,
                          pricedReviewTokens: row.priced_review_tokens,
                          reviewCostUsd: row.review_cost_usd,
                          reviewCicdSeconds: row.review_cicd_seconds,
                      })),
              }
            : EMPTY_REVIEW_POOL,
    };
}
