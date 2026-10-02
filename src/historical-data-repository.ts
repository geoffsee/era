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

export async function loadHistoricalPullRequests(
    directory = join(import.meta.dir, "..", "historical-data"),
): Promise<HistoricalPullRequest[]> {
    const tokenFile = (await Bun.file(join(directory, "pr_token_usage_dataset.json")).json()) as TokenFile;
    const cicdFile = (await Bun.file(join(directory, "pr_cicd_dataset.json")).json()) as CicdFile;
    const cicdByNumber = new Map(cicdFile.map((row) => [row.pr_number, row]));

    return tokenFile.pull_requests.map((pullRequest) => {
        const cicd = cicdByNumber.get(pullRequest.pr_number);
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
        };
    });
}
