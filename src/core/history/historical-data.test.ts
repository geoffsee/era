import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHistoricalData, loadHistoricalPullRequests } from "../../app/repositories/historical-data-repository.ts";

const dataDirectory = join(import.meta.dir, "../../..", "historical-data");
const localHistoryTest = test.skipIf(
    !existsSync(join(dataDirectory, "pr_token_usage_dataset.json")) ||
        !existsSync(join(dataDirectory, "pr_cicd_dataset.json")),
);

type JsonSchema = {
    $ref?: string;
    $defs?: Record<string, JsonSchema>;
    type?: string;
    additionalProperties?: boolean;
    required?: string[];
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema;
    anyOf?: JsonSchema[];
    enum?: unknown[];
    minimum?: number;
    pattern?: string;
    format?: string;
    uniqueItems?: boolean;
    minLength?: number;
};

function definition(root: JsonSchema, ref: string): JsonSchema {
    const name = ref.slice("#/$defs/".length);
    const schema = root.$defs?.[name];
    if (!schema) throw new Error(`missing ${ref}`);
    return schema;
}

function validate(root: JsonSchema, schema: JsonSchema, value: unknown, path: string): void {
    if (schema.$ref) {
        validate(root, definition(root, schema.$ref), value, path);
        return;
    }
    if (schema.anyOf) {
        const errors: string[] = [];
        for (const branch of schema.anyOf) {
            try {
                validate(root, branch, value, path);
                return;
            } catch (error) {
                errors.push(error instanceof Error ? error.message : String(error));
            }
        }
        throw new Error(errors.join("; "));
    }
    if (schema.enum && !schema.enum.includes(value)) {
        throw new Error(`${path}: ${JSON.stringify(value)} is outside ${schema.enum.join(", ")}`);
    }
    if (schema.type === "object") {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(`${path}: expected an object`);
        }
        const record = value as Record<string, unknown>;
        for (const key of schema.required ?? []) {
            if (!Object.hasOwn(record, key)) throw new Error(`${path}: missing ${key}`);
        }
        if (schema.additionalProperties === false) {
            for (const key of Object.keys(record)) {
                if (!schema.properties?.[key]) throw new Error(`${path}: unexpected ${key}`);
            }
        }
        for (const [key, property] of Object.entries(schema.properties ?? {})) {
            if (Object.hasOwn(record, key)) validate(root, property, record[key], `${path}.${key}`);
        }
        return;
    }
    if (schema.type === "array") {
        if (!Array.isArray(value)) throw new Error(`${path}: expected an array`);
        if (schema.uniqueItems && new Set(value).size !== value.length) {
            throw new Error(`${path}: duplicate items`);
        }
        const items = schema.items;
        if (items) {
            for (let index = 0; index < value.length; index++) {
                validate(root, items, value[index], `${path}[${index}]`);
            }
        }
        return;
    }
    if (schema.type === "integer") {
        if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${path}: expected an integer`);
        if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path}: below ${schema.minimum}`);
        return;
    }
    if (schema.type === "string") {
        if (typeof value !== "string") throw new Error(`${path}: expected a string`);
        if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${path}: too short`);
        if (schema.pattern && !new RegExp(schema.pattern).test(value))
            throw new Error(`${path}: fails ${schema.pattern}`);
        if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) throw new Error(`${path}: invalid date`);
        if (schema.format === "uri") {
            try {
                new URL(value);
            } catch {
                throw new Error(`${path}: invalid uri`);
            }
        }
        return;
    }
    if (schema.type === "null") {
        if (value !== null) throw new Error(`${path}: expected null`);
    }
}

function formatDuration(seconds: number): string {
    const rounded = Math.round(seconds);
    const secondsPart = rounded % 60;
    const minutes = Math.floor(rounded / 60);
    if (minutes === 0) return `${secondsPart}s`;
    const hours = Math.floor(minutes / 60);
    const minutesPart = minutes % 60;
    if (hours === 0) return `${minutesPart}m ${secondsPart}s`;
    return `${hours}h ${minutesPart}m ${secondsPart}s`;
}

type TokenUsage = {
    uncached_input_tokens: number;
    cache_read_input_tokens: number;
    total_input_tokens: number;
    output_tokens: number;
    thinking_tokens: number;
    total_tokens: number;
};

function expectTokenIdentities(usage: TokenUsage): void {
    expect(usage.total_input_tokens).toBe(usage.uncached_input_tokens + usage.cache_read_input_tokens);
    expect(usage.total_tokens).toBe(usage.total_input_tokens + usage.output_tokens);
    expect(usage.thinking_tokens).toBeLessThanOrEqual(usage.output_tokens);
}

const sampleTokens = {
    metadata: {
        generated_at: "2026-10-02T00:00:00.000Z",
        repository: "octo/example",
        total_prs_tracked: 1,
        prs_with_token_activity: 1,
        total_agent_turns: 3,
        total_tokens_consumed: 130,
    },
    orchestration_and_overhead: {
        category: "General Orchestration & Workspace Setup",
        agent_turns_count: 1,
        models_used: ["claude-sonnet-4-6"],
        token_usage: {
            uncached_input_tokens: 10,
            cache_read_input_tokens: 20,
            total_input_tokens: 30,
            output_tokens: 5,
            thinking_tokens: 1,
            total_tokens: 35,
        },
    },
    pull_requests: [
        {
            pr_number: 7,
            title: "[E1.01] Example",
            state: "MERGED",
            head_branch: "feat/example",
            created_at: "2026-10-02T00:00:00Z",
            merged_at: "2026-10-02T00:01:00Z",
            closed_at: "2026-10-02T00:01:00Z",
            url: "https://github.com/octo/example/pull/7",
            agent_turns_count: 2,
            models_used: ["claude-sonnet-4-6"],
            token_usage: {
                uncached_input_tokens: 40,
                cache_read_input_tokens: 50,
                total_input_tokens: 90,
                output_tokens: 5,
                thinking_tokens: 2,
                total_tokens: 95,
            },
        },
    ],
};

const sampleCicd = [
    {
        pr_number: 7,
        title: "[E1.01] Example",
        state: "MERGED",
        author: "octo",
        created_at: "2026-10-02T00:00:00Z",
        merged_at: "2026-10-02T00:01:00Z",
        closed_at: "2026-10-02T00:01:00Z",
        head_branch: "feat/example",
        head_sha: "0123456789abcdef0123456789abcdef01234567",
        url: "https://github.com/octo/example/pull/7",
        cicd_summary: {
            overall_status: "SUCCESS",
            total_jobs_count: 2,
            successful_jobs_count: 1,
            failed_jobs_count: 0,
            cancelled_jobs_count: 0,
            skipped_or_neutral_count: 1,
            earliest_job_started_at: "2026-10-02T00:00:10.000Z",
            latest_job_completed_at: "2026-10-02T00:00:30.000Z",
            total_cicd_duration_seconds: 20,
            total_cicd_duration_formatted: "20s",
            pr_created_to_cicd_completed_seconds: 30,
            pr_created_to_cicd_completed_formatted: "30s",
            time_to_merge_seconds: 60,
            time_to_merge_formatted: "1m 0s",
        },
        jobs: [
            {
                type: "CheckRun",
                name: "Tests",
                workflow: "CI",
                status: "COMPLETED",
                conclusion: "SUCCESS",
                started_at: "2026-10-02T00:00:10Z",
                completed_at: "2026-10-02T00:00:30Z",
                duration_seconds: 20,
                duration_formatted: "20s",
                details_url: "https://github.com/octo/example/actions/runs/1/job/2",
            },
            {
                type: "StatusContext",
                name: "CodeRabbit",
                workflow: "Status Context",
                status: "COMPLETED",
                conclusion: "PENDING",
                started_at: null,
                completed_at: "2026-10-02T00:00:40Z",
                duration_seconds: null,
                duration_formatted: null,
                details_url: null,
            },
        ],
    },
];

describe("historical data schemas", () => {
    test("a minimal pair validates and joins on pr_number", async () => {
        const tokenSchema = (await Bun.file(
            join(dataDirectory, "pr_token_usage_dataset.schema.json"),
        ).json()) as JsonSchema;
        const cicdSchema = (await Bun.file(join(dataDirectory, "pr_cicd_dataset.schema.json")).json()) as JsonSchema;
        validate(tokenSchema, tokenSchema, sampleTokens, "$");
        validate(cicdSchema, cicdSchema, sampleCicd, "$");

        const directory = await mkdtemp(join(tmpdir(), "era-history-"));
        try {
            await Bun.write(join(directory, "pr_token_usage_dataset.json"), JSON.stringify(sampleTokens));
            await Bun.write(join(directory, "pr_cicd_dataset.json"), JSON.stringify(sampleCicd));
            const [pullRequest] = await loadHistoricalPullRequests(directory);
            expect(pullRequest).toMatchObject({
                number: 7,
                epic: 1,
                state: "MERGED",
                turns: 2,
                uncachedInputTokens: 40,
                cacheReadTokens: 50,
                totalInputTokens: 90,
                outputTokens: 5,
                thinkingTokens: 2,
                totalTokens: 95,
                failedJobs: 0,
                successfulJobs: 1,
                cicdSeconds: 20,
                reviewTokens: 0,
                cicdObserved: true,
                reviewObserved: false,
                createdAt: "2026-10-02T00:00:00Z",
                mergedAt: "2026-10-02T00:01:00Z",
            });
            await Bun.write(
                join(directory, "pr_review_dataset.json"),
                JSON.stringify({
                    metadata: {
                        unattributed_review_tokens: 5,
                        followup_tokens: 1,
                        review_loop_tokens: 9,
                        inherited_review_tokens: 0,
                        gaps: [],
                    },
                    pull_requests: [
                        {
                            pr_number: 7,
                            review_tokens: 4,
                            priced_review_tokens: 4,
                            review_cost_usd: 0.2,
                            review_cicd_seconds: 15,
                        },
                    ],
                }),
            );
            const joined = await loadHistoricalData(directory);
            expect(joined.pullRequests[0]).toMatchObject({
                reviewTokens: 4,
                reviewCostUsd: 0.2,
                reviewCicdSeconds: 15,
                reviewObserved: true,
            });
            expect(joined.reviewPool.unattributedReviewTokens).toBe(5);
            expect(joined.authorOverhead).toMatchObject({ totalTokens: 35, attributedAuthorTokens: 95 });
            expect(joined.repository).toBe("octo/example");
            expect(joined.generatedAt).toBe("2026-10-02T00:00:00.000Z");
            await Bun.write(join(directory, "pr_cicd_dataset.json"), "[]");
            expect((await loadHistoricalData(directory)).pullRequests[0]?.cicdObserved).toBe(false);
            await Bun.write(
                join(directory, "pr_review_dataset.json"),
                JSON.stringify({
                    metadata: { repository: "foreign/repo" },
                    pull_requests: [],
                }),
            );
            await expect(loadHistoricalData(directory)).rejects.toThrow("repository identities do not match");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    localHistoryTest("the local extracts follow the schema and the aggregation rules", async () => {
        const tokenSchema = (await Bun.file(
            join(dataDirectory, "pr_token_usage_dataset.schema.json"),
        ).json()) as JsonSchema;
        const cicdSchema = (await Bun.file(join(dataDirectory, "pr_cicd_dataset.schema.json")).json()) as JsonSchema;
        const tokens = await Bun.file(join(dataDirectory, "pr_token_usage_dataset.json")).json();
        const cicd = await Bun.file(join(dataDirectory, "pr_cicd_dataset.json")).json();
        validate(tokenSchema, tokenSchema, tokens, "$");
        validate(cicdSchema, cicdSchema, cicd, "$");

        expectTokenIdentities(tokens.orchestration_and_overhead.token_usage);
        let turns = tokens.orchestration_and_overhead.agent_turns_count;
        let consumed = tokens.orchestration_and_overhead.token_usage.total_tokens;
        let active = 0;
        for (const pullRequest of tokens.pull_requests) {
            expectTokenIdentities(pullRequest.token_usage);
            expect(pullRequest.state === "MERGED").toBe(pullRequest.merged_at !== null);
            const quiet = pullRequest.token_usage.total_tokens === 0 && pullRequest.agent_turns_count === 0;
            expect(pullRequest.models_used.length === 0).toBe(quiet);
            if (!quiet) active += 1;
            turns += pullRequest.agent_turns_count;
            consumed += pullRequest.token_usage.total_tokens;
        }
        expect(tokens.metadata.total_prs_tracked).toBe(tokens.pull_requests.length);
        expect(tokens.metadata.prs_with_token_activity).toBe(active);
        expect(tokens.metadata.total_agent_turns).toBe(turns);
        expect(tokens.metadata.total_tokens_consumed).toBe(consumed);

        const tokenNumbers = tokens.pull_requests.map((pullRequest: { pr_number: number }) => pullRequest.pr_number);
        const cicdNumbers = cicd.map((pullRequest: { pr_number: number }) => pullRequest.pr_number);
        expect(new Set(tokenNumbers)).toEqual(new Set(cicdNumbers));
        expect(new Set(tokenNumbers).size).toBe(tokenNumbers.length);

        for (const pullRequest of cicd) {
            expect(pullRequest.state === "MERGED").toBe(pullRequest.merged_at !== null);
            const tallies = { SUCCESS: 0, FAILURE: 0, CANCELLED: 0, skipped: 0, other: 0 };
            let earliest: number | null = null;
            let latest: number | null = null;
            for (const job of pullRequest.jobs) {
                const conclusion = String(job.conclusion);
                if (conclusion === "SUCCESS" || conclusion === "FAILURE" || conclusion === "CANCELLED") {
                    tallies[conclusion] += 1;
                } else if (
                    job.conclusion === "SKIPPED" ||
                    job.conclusion === "NEUTRAL" ||
                    job.conclusion === "PENDING"
                ) {
                    tallies.skipped += 1;
                } else {
                    tallies.other += 1;
                }
                if (job.started_at && job.completed_at) {
                    const seconds = Math.round((Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000);
                    expect(job.duration_seconds).toBe(seconds >= 0 ? seconds : null);
                } else {
                    expect(job.duration_seconds).toBeNull();
                }
                if (job.duration_seconds === null) expect(job.duration_formatted).toBeNull();
                else expect(job.duration_formatted).toBe(formatDuration(job.duration_seconds));
                if (job.type === "StatusContext") expect(job.workflow).toBe("Status Context");
                if (!job.started_at) continue;
                const started = Date.parse(job.started_at);
                const completed = Date.parse(job.completed_at);
                if (earliest === null || started < earliest) earliest = started;
                if (Number.isFinite(completed) && (latest === null || completed > latest)) latest = completed;
            }
            const summary = pullRequest.cicd_summary;
            expect(summary.total_jobs_count).toBe(pullRequest.jobs.length);
            expect(summary.successful_jobs_count).toBe(tallies.SUCCESS);
            expect(summary.failed_jobs_count).toBe(tallies.FAILURE);
            expect(summary.cancelled_jobs_count).toBe(tallies.CANCELLED);
            expect(summary.skipped_or_neutral_count).toBe(tallies.skipped);
            expect(tallies.SUCCESS + tallies.FAILURE + tallies.CANCELLED + tallies.skipped + tallies.other).toBe(
                pullRequest.jobs.length,
            );
            expect(summary.overall_status).toBe(summary.failed_jobs_count > 0 ? "FAILURE" : "SUCCESS");
            const span = earliest === null || latest === null ? null : Math.round((latest - earliest) / 1000);
            expect(summary.total_cicd_duration_seconds).toBe(span);
            if (summary.total_cicd_duration_seconds === null) expect(summary.total_cicd_duration_formatted).toBeNull();
            else
                expect(summary.total_cicd_duration_formatted).toBe(formatDuration(summary.total_cicd_duration_seconds));
            const created = Date.parse(pullRequest.created_at);
            const createdSpan = latest === null ? null : Math.round((latest - created) / 1000);
            expect(summary.pr_created_to_cicd_completed_seconds).toBe(createdSpan);
            if (pullRequest.merged_at === null) {
                expect(summary.time_to_merge_seconds).toBeNull();
            } else {
                expect(summary.time_to_merge_seconds).toBe(
                    Math.round((Date.parse(pullRequest.merged_at) - created) / 1000),
                );
            }
        }

        const reviewPath = join(dataDirectory, "pr_review_dataset.json");
        if (!(await Bun.file(reviewPath).exists())) return;
        const reviewSchema = (await Bun.file(
            join(dataDirectory, "pr_review_dataset.schema.json"),
        ).json()) as JsonSchema;
        const review = await Bun.file(reviewPath).json();
        validate(reviewSchema, reviewSchema, review, "$");
        const sessionTokens = review.sessions.reduce(
            (total: number, session: { total_tokens: number }) => total + session.total_tokens,
            0,
        );
        const attributedTokens = review.pull_requests.reduce(
            (total: number, pullRequest: { review_tokens: number }) => total + pullRequest.review_tokens,
            0,
        );
        expect(sessionTokens).toBe(review.metadata.review_loop_tokens);
        expect(attributedTokens + review.metadata.unattributed_review_tokens).toBe(review.metadata.review_loop_tokens);
    });
});
