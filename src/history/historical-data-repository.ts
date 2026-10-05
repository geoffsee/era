import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { EMPTY_REVIEW_POOL, epicNumberFromTitle, type HistoricalData, type HistoricalPullRequest } from "./history.ts";

export type {
    HistoricalAuthorOverhead,
    HistoricalData,
    HistoricalPullRequest,
    ReviewPool,
    UnmatchedReview,
} from "./history.ts";
export { EMPTY_REVIEW_POOL, epicNumberFromTitle, isCalibrationSample } from "./history.ts";

type TokenFile = {
    metadata: { repository?: string; total_prs_tracked?: number; generated_at?: string };
    orchestration_and_overhead?: {
        token_usage: {
            uncached_input_tokens: number;
            cache_read_input_tokens: number;
            output_tokens: number;
            total_tokens: number;
        };
    };
    pull_requests: Array<{
        pr_number: number;
        title: string;
        state: string;
        created_at?: string;
        merged_at?: string | null;
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

type ReviewFile = {
    metadata: {
        repository?: string;
        generated_at?: string;
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
    directory = fileURLToPath(new URL("../../historical-data", import.meta.url)),
): Promise<HistoricalPullRequest[]> {
    return (await loadHistoricalData(directory)).pullRequests;
}

export async function loadHistoricalData(
    directory = fileURLToPath(new URL("../../historical-data", import.meta.url)),
): Promise<HistoricalData> {
    const tokenFile = JSON.parse(await readFile(join(directory, "pr_token_usage_dataset.json"), "utf8")) as TokenFile;
    const cicdFile = JSON.parse(await readFile(join(directory, "pr_cicd_dataset.json"), "utf8")) as CicdFile;
    let review: ReviewFile | null = null;
    try {
        review = JSON.parse(await readFile(join(directory, "pr_review_dataset.json"), "utf8")) as ReviewFile;
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (review?.metadata.repository && tokenFile.metadata.repository !== review.metadata.repository) {
        throw new Error("author and review history repository identities do not match");
    }
    const cicdByNumber = new Map(cicdFile.map((row) => [row.pr_number, row]));
    const reviewByNumber = new Map(review?.pull_requests.map((row) => [row.pr_number, row]) ?? []);
    const authorNumbers = new Set(tokenFile.pull_requests.map((pullRequest) => pullRequest.pr_number));
    const overhead = tokenFile.orchestration_and_overhead?.token_usage;

    return {
        repository: tokenFile.metadata.repository,
        generatedAt: tokenFile.metadata.generated_at,
        authorOverhead: overhead
            ? {
                  uncachedInputTokens: overhead.uncached_input_tokens,
                  cacheReadTokens: overhead.cache_read_input_tokens,
                  outputTokens: overhead.output_tokens,
                  totalTokens: overhead.total_tokens,
                  attributedAuthorTokens: tokenFile.pull_requests.reduce(
                      (total, row) => total + row.token_usage.total_tokens,
                      0,
                  ),
              }
            : undefined,
        pullRequests: tokenFile.pull_requests.map((pullRequest) => {
            const cicd = cicdByNumber.get(pullRequest.pr_number);
            const reviewed = reviewByNumber.get(pullRequest.pr_number);
            const usage = pullRequest.token_usage;
            return {
                number: pullRequest.pr_number,
                title: pullRequest.title,
                state: pullRequest.state,
                createdAt: pullRequest.created_at,
                mergedAt: pullRequest.merged_at ?? undefined,
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
                cicdObserved: cicd !== undefined,
                reviewObserved: reviewed !== undefined,
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
