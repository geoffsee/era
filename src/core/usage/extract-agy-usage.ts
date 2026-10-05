import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type AgentStep,
    attributeConversation,
    emptyRollup,
    formatDuration,
    formatTokenCount,
    modelForStep,
    type UsageRollup,
} from "./agy-usage.ts";

type PullRequestRecord = {
    number: number;
    title: string;
    state: "OPEN" | "CLOSED" | "MERGED";
    author: string;
    headBranch: string;
    headSha: string;
    createdAt: string;
    mergedAt: string | null;
    closedAt: string | null;
    url: string;
};

type StoredJob = {
    type: "CheckRun" | "StatusContext";
    name: string;
    workflow: string;
    status: "QUEUED" | "IN_PROGRESS" | "COMPLETED";
    conclusion: string;
    started_at: string | null;
    completed_at: string | null;
    duration_seconds: number | null;
    duration_formatted: string | null;
    details_url: string | null;
};

type StoredSummary = {
    overall_status: "SUCCESS" | "FAILURE";
    total_jobs_count: number;
    successful_jobs_count: number;
    failed_jobs_count: number;
    cancelled_jobs_count: number;
    skipped_or_neutral_count: number;
    earliest_job_started_at: string | null;
    latest_job_completed_at: string | null;
    total_cicd_duration_seconds: number | null;
    total_cicd_duration_formatted: string | null;
    pr_created_to_cicd_completed_seconds: number | null;
    pr_created_to_cicd_completed_formatted: string | null;
    time_to_merge_seconds: number | null;
    time_to_merge_formatted: string | null;
};

type StoredCicd = {
    pr_number: number;
    title: string;
    state: "OPEN" | "CLOSED" | "MERGED";
    author: string;
    created_at: string;
    merged_at: string | null;
    closed_at: string | null;
    head_branch: string;
    head_sha: string;
    url: string;
    cicd_summary: StoredSummary;
    jobs: StoredJob[];
};

const STATUS = new Set(["QUEUED", "IN_PROGRESS", "COMPLETED"]);

export async function extractAgyUsage(input: {
    repository: string;
    agyHome: string;
    historyDirectory: string;
    run?: (command: string[]) => Promise<string>;
}): Promise<void> {
    if (!/^[^/\s]+\/[^/\s]+$/.test(input.repository)) {
        throw new Error(`repository must be owner/name, got ${input.repository}`);
    }
    const run = input.run ?? gh;
    const repoName = input.repository.slice(input.repository.indexOf("/") + 1);
    const pullRequests = await listPullRequests(run, input.repository);
    const branches = uniqueBranches(pullRequests);

    const conversations = await conversationIds(input.agyHome, repoName);
    const orchestration = emptyRollup();
    const byPullRequest = new Map<number, UsageRollup>();
    for (const conversationId of conversations) {
        const steps = await readSteps(input.agyHome, conversationId);
        const attributed = attributeConversation(steps, branches, input.repository);
        mergeRollup(orchestration, attributed.orchestration);
        for (const [number, rollup] of attributed.byPullRequest) {
            const current = byPullRequest.get(number) ?? emptyRollup();
            mergeRollup(current, rollup);
            byPullRequest.set(number, current);
        }
    }

    const tokenPath = join(input.historyDirectory, "pr_token_usage_dataset.json");
    await Bun.write(
        tokenPath,
        `${JSON.stringify(tokenDocument(input.repository, pullRequests, orchestration, byPullRequest), null, 2)}\n`,
    );

    const cicdPath = join(input.historyDirectory, "pr_cicd_dataset.json");
    const previous = (await Bun.file(cicdPath).exists()) ? ((await Bun.file(cicdPath).json()) as StoredCicd[]) : [];
    const previousByNumber = new Map(previous.map((row) => [row.pr_number, row]));
    const workflows = new Map<number, string>();
    const cicd: StoredCicd[] = [];
    for (const pullRequest of pullRequests) {
        const stored = previousByNumber.get(pullRequest.number);
        if (stored && stored.head_sha === pullRequest.headSha) {
            cicd.push(refreshIdentity(stored, pullRequest));
            continue;
        }
        console.error(`CI ${pullRequest.number} ${pullRequest.headSha.slice(0, 12)}`);
        cicd.push(await fetchCicd(run, input.repository, pullRequest, workflows));
    }
    cicd.sort((left, right) => right.pr_number - left.pr_number);
    await Bun.write(cicdPath, `${JSON.stringify(cicd, null, 2)}\n`);
}

async function conversationIds(agyHome: string, repoName: string): Promise<string[]> {
    const database = await openDatabase(join(agyHome, "conversation_summaries.db"));
    try {
        const rows = database
            .query("SELECT conversation_id, parent_conversation_id, workspace_uris FROM conversation_summaries")
            .all() as Array<{
            conversation_id: string;
            parent_conversation_id: string;
            workspace_uris: string;
        }>;
        const wanted = new Set(
            rows.filter((row) => row.workspace_uris.includes(repoName)).map((row) => row.conversation_id),
        );
        let grew = true;
        while (grew) {
            grew = false;
            for (const row of rows) {
                if (!row.parent_conversation_id || wanted.has(row.conversation_id)) continue;
                if (wanted.has(row.parent_conversation_id)) {
                    wanted.add(row.conversation_id);
                    grew = true;
                }
            }
        }
        return [...wanted];
    } finally {
        database.close();
    }
}

async function readSteps(agyHome: string, conversationId: string): Promise<AgentStep[]> {
    const path = join(agyHome, "conversations", `${conversationId}.db`);
    if (!existsSync(path)) return [];
    const database = await openDatabase(path);
    try {
        const rows = database
            .query("SELECT idx, step_type, metadata, step_payload FROM steps ORDER BY idx")
            .all() as Array<{
            idx: number;
            step_type: number;
            metadata: Uint8Array | null;
            step_payload: Uint8Array | null;
        }>;
        const models = new Map<number, string>();
        const generations = database.query("SELECT data FROM gen_metadata").all() as Array<{
            data: Uint8Array | null;
        }>;
        for (const generation of generations) {
            if (!generation.data) continue;
            const attributed = modelForStep(generation.data);
            if (attributed) models.set(attributed.stepIndex, attributed.model);
        }
        return rows.map((row) => ({
            type: row.step_type,
            metadata: row.metadata,
            payload: row.step_payload,
            model: models.get(row.idx) ?? null,
        }));
    } finally {
        database.close();
    }
}

async function openDatabase(path: string): Promise<Database> {
    try {
        const database = new Database(path);
        database.query("SELECT 1").get();
        return database;
    } catch {
        const directory = await mkdtemp(join(tmpdir(), "agy-usage-"));
        const backup = join(directory, "backup.sqlite");
        const proc = Bun.spawn(["sqlite3", path, `.backup '${backup}'`], { stdout: "pipe", stderr: "pipe" });
        const stderr = await new Response(proc.stderr).text();
        if ((await proc.exited) !== 0) {
            await rm(directory, { recursive: true, force: true });
            throw new Error(stderr.trim() || `sqlite3 backup failed for ${path}`);
        }
        const database = new Database(backup);
        const originalClose = database.close.bind(database);
        database.close = () => {
            originalClose();
            void rm(directory, { recursive: true, force: true });
        };
        return database;
    }
}

function uniqueBranches(pullRequests: readonly PullRequestRecord[]): Map<string, number> {
    const seen = new Map<string, number | null>();
    for (const pullRequest of pullRequests) {
        const current = seen.get(pullRequest.headBranch);
        if (current === undefined) seen.set(pullRequest.headBranch, pullRequest.number);
        else seen.set(pullRequest.headBranch, null);
    }
    const branches = new Map<string, number>();
    for (const [branch, number] of seen) {
        if (number !== null) branches.set(branch, number);
    }
    return branches;
}

function mergeRollup(into: UsageRollup, from: UsageRollup): void {
    into.turns += from.turns;
    into.uncachedInputTokens += from.uncachedInputTokens;
    into.cacheReadTokens += from.cacheReadTokens;
    into.outputTokens += from.outputTokens;
    into.thinkingTokens += from.thinkingTokens;
    for (const model of from.models) into.models.add(model);
}

function tokenDocument(
    repository: string,
    pullRequests: readonly PullRequestRecord[],
    orchestration: UsageRollup,
    byPullRequest: ReadonlyMap<number, UsageRollup>,
): unknown {
    const rows = pullRequests
        .map((pullRequest) => {
            const rollup = byPullRequest.get(pullRequest.number) ?? emptyRollup();
            return {
                pr_number: pullRequest.number,
                title: pullRequest.title,
                state: pullRequest.state,
                head_branch: pullRequest.headBranch,
                created_at: pullRequest.createdAt,
                merged_at: pullRequest.mergedAt,
                closed_at: pullRequest.closedAt,
                url: pullRequest.url,
                agent_turns_count: rollup.turns,
                models_used: [...rollup.models].sort(),
                token_usage: tokenUsage(rollup),
            };
        })
        .sort((left, right) => right.pr_number - left.pr_number);
    const active = rows.filter((row) => row.token_usage.total_tokens > 0 || row.agent_turns_count > 0).length;
    const turns = orchestration.turns + rows.reduce((sum, row) => sum + row.agent_turns_count, 0);
    const consumed = totalTokens(orchestration) + rows.reduce((sum, row) => sum + row.token_usage.total_tokens, 0);
    return {
        metadata: {
            generated_at: new Date().toISOString(),
            repository,
            total_prs_tracked: rows.length,
            prs_with_token_activity: active,
            total_agent_turns: turns,
            total_tokens_consumed: consumed,
            formatted_grand_total_tokens: formatTokenCount(consumed),
        },
        orchestration_and_overhead: {
            category: "General Orchestration & Workspace Setup",
            agent_turns_count: orchestration.turns,
            models_used: [...orchestration.models].sort(),
            token_usage: tokenUsage(orchestration),
        },
        pull_requests: rows,
    };
}

function tokenUsage(rollup: UsageRollup): {
    uncached_input_tokens: number;
    cache_read_input_tokens: number;
    total_input_tokens: number;
    output_tokens: number;
    thinking_tokens: number;
    total_tokens: number;
    formatted_total_tokens: string;
    formatted_input_tokens: string;
    formatted_cache_read_tokens: string;
    formatted_output_tokens: string;
} {
    const input = rollup.uncachedInputTokens + rollup.cacheReadTokens;
    const total = input + rollup.outputTokens;
    return {
        uncached_input_tokens: rollup.uncachedInputTokens,
        cache_read_input_tokens: rollup.cacheReadTokens,
        total_input_tokens: input,
        output_tokens: rollup.outputTokens,
        thinking_tokens: rollup.thinkingTokens,
        total_tokens: total,
        formatted_total_tokens: formatTokenCount(total),
        formatted_input_tokens: formatTokenCount(input),
        formatted_cache_read_tokens: formatTokenCount(rollup.cacheReadTokens),
        formatted_output_tokens: formatTokenCount(rollup.outputTokens),
    };
}

function totalTokens(rollup: UsageRollup): number {
    return rollup.uncachedInputTokens + rollup.cacheReadTokens + rollup.outputTokens;
}

function refreshIdentity(stored: StoredCicd, pullRequest: PullRequestRecord): StoredCicd {
    const summary = { ...stored.cicd_summary };
    const created = Date.parse(pullRequest.createdAt);
    const merged = pullRequest.mergedAt === null ? null : Date.parse(pullRequest.mergedAt);
    summary.time_to_merge_seconds = merged === null ? null : Math.round((merged - created) / 1000);
    summary.time_to_merge_formatted =
        summary.time_to_merge_seconds === null ? null : formatDuration(summary.time_to_merge_seconds);
    const latest = summary.latest_job_completed_at === null ? null : Date.parse(summary.latest_job_completed_at);
    summary.pr_created_to_cicd_completed_seconds = latest === null ? null : Math.round((latest - created) / 1000);
    summary.pr_created_to_cicd_completed_formatted =
        summary.pr_created_to_cicd_completed_seconds === null
            ? null
            : formatDuration(summary.pr_created_to_cicd_completed_seconds);
    return {
        ...stored,
        title: pullRequest.title,
        state: pullRequest.state,
        author: pullRequest.author,
        created_at: pullRequest.createdAt,
        merged_at: pullRequest.mergedAt,
        closed_at: pullRequest.closedAt,
        head_branch: pullRequest.headBranch,
        url: pullRequest.url,
        cicd_summary: summary,
    };
}

async function fetchCicd(
    run: (command: string[]) => Promise<string>,
    repository: string,
    pullRequest: PullRequestRecord,
    workflows: Map<number, string>,
): Promise<StoredCicd> {
    const checkRuns = await checkRunsFor(run, repository, pullRequest.headSha);
    const statuses = await statusesFor(run, repository, pullRequest.headSha);
    const jobs: StoredJob[] = [];
    for (const checkRun of checkRuns) {
        const runId = actionsRunId(checkRun.details_url);
        let workflow = "External / Unspecified";
        if (runId !== null) {
            const cached = workflows.get(runId);
            if (cached !== undefined) workflow = cached;
            else {
                workflow = await workflowName(run, repository, runId);
                workflows.set(runId, workflow);
            }
        }
        jobs.push(jobFromCheck(checkRun, workflow));
    }
    for (const status of statuses) jobs.push(jobFromStatus(status));
    return {
        pr_number: pullRequest.number,
        title: pullRequest.title,
        state: pullRequest.state,
        author: pullRequest.author,
        created_at: pullRequest.createdAt,
        merged_at: pullRequest.mergedAt,
        closed_at: pullRequest.closedAt,
        head_branch: pullRequest.headBranch,
        head_sha: pullRequest.headSha,
        url: pullRequest.url,
        cicd_summary: summarize(jobs, pullRequest.createdAt, pullRequest.mergedAt),
        jobs,
    };
}

function jobFromCheck(
    checkRun: {
        name: string;
        status: string | null;
        conclusion: string | null;
        started_at: string | null;
        completed_at: string | null;
        details_url: string | null;
    },
    workflow: string,
): StoredJob {
    const started = checkRun.started_at;
    const completed = checkRun.completed_at;
    const duration = started && completed ? Math.round((Date.parse(completed) - Date.parse(started)) / 1000) : null;
    const durationSeconds = duration !== null && duration >= 0 ? duration : null;
    return {
        type: "CheckRun",
        name: checkRun.name,
        workflow,
        status: jobStatus(checkRun.status),
        conclusion: (checkRun.conclusion ?? "PENDING").toUpperCase(),
        started_at: started,
        completed_at: completed,
        duration_seconds: durationSeconds,
        duration_formatted: durationSeconds === null ? null : formatDuration(durationSeconds),
        details_url: checkRun.details_url,
    };
}

function jobFromStatus(status: {
    context: string;
    state: string;
    updated_at: string | null;
    target_url: string | null;
}): StoredJob {
    return {
        type: "StatusContext",
        name: status.context,
        workflow: "Status Context",
        status: "COMPLETED",
        conclusion: status.state.toUpperCase(),
        started_at: null,
        completed_at: status.updated_at,
        duration_seconds: null,
        duration_formatted: null,
        details_url: status.target_url,
    };
}

function summarize(jobs: readonly StoredJob[], createdAt: string, mergedAt: string | null): StoredSummary {
    let successful = 0;
    let failed = 0;
    let cancelled = 0;
    let skipped = 0;
    let earliest: number | null = null;
    let latest: number | null = null;
    let earliestText: string | null = null;
    let latestText: string | null = null;
    for (const job of jobs) {
        if (job.conclusion === "SUCCESS") successful += 1;
        else if (job.conclusion === "FAILURE") failed += 1;
        else if (job.conclusion === "CANCELLED") cancelled += 1;
        else if (job.conclusion === "SKIPPED" || job.conclusion === "NEUTRAL" || job.conclusion === "PENDING") {
            skipped += 1;
        }
        if (!job.started_at) continue;
        const started = Date.parse(job.started_at);
        if (earliest === null || started < earliest) {
            earliest = started;
            earliestText = job.started_at;
        }
        if (!job.completed_at) continue;
        const completed = Date.parse(job.completed_at);
        if (!Number.isFinite(completed)) continue;
        if (latest === null || completed > latest) {
            latest = completed;
            latestText = job.completed_at;
        }
    }
    const span = earliest === null || latest === null ? null : Math.round((latest - earliest) / 1000);
    const created = Date.parse(createdAt);
    const createdSpan = latest === null ? null : Math.round((latest - created) / 1000);
    const merged = mergedAt === null ? null : Math.round((Date.parse(mergedAt) - created) / 1000);
    return {
        overall_status: failed > 0 ? "FAILURE" : "SUCCESS",
        total_jobs_count: jobs.length,
        successful_jobs_count: successful,
        failed_jobs_count: failed,
        cancelled_jobs_count: cancelled,
        skipped_or_neutral_count: skipped,
        earliest_job_started_at: earliestText,
        latest_job_completed_at: latestText,
        total_cicd_duration_seconds: span,
        total_cicd_duration_formatted: span === null ? null : formatDuration(span),
        pr_created_to_cicd_completed_seconds: createdSpan,
        pr_created_to_cicd_completed_formatted: createdSpan === null ? null : formatDuration(createdSpan),
        time_to_merge_seconds: merged,
        time_to_merge_formatted: merged === null ? null : formatDuration(merged),
    };
}

function jobStatus(status: string | null): "QUEUED" | "IN_PROGRESS" | "COMPLETED" {
    const normalized = (status ?? "QUEUED").toUpperCase();
    if (STATUS.has(normalized)) return normalized as "QUEUED" | "IN_PROGRESS" | "COMPLETED";
    throw new Error(`unexpected check status ${status}`);
}

function actionsRunId(detailsUrl: string | null): number | null {
    const match = detailsUrl?.match(/\/actions\/runs\/(\d+)\/job\/\d+/);
    return match ? Number(match[1]) : null;
}

async function listPullRequests(
    run: (command: string[]) => Promise<string>,
    repository: string,
): Promise<PullRequestRecord[]> {
    const stdout = await run([
        "gh",
        "pr",
        "list",
        "--repo",
        repository,
        "--state",
        "all",
        "--limit",
        "500",
        "--json",
        "number,title,state,author,headRefName,headRefOid,createdAt,mergedAt,closedAt,url",
    ]);
    const rows = JSON.parse(stdout) as Array<{
        number: number;
        title: string;
        state: "OPEN" | "CLOSED" | "MERGED";
        author: { login: string };
        headRefName: string;
        headRefOid: string;
        createdAt: string;
        mergedAt: string | null;
        closedAt: string | null;
        url: string;
    }>;
    return rows.map((row) => ({
        number: row.number,
        title: row.title,
        state: row.state,
        author: row.author.login,
        headBranch: row.headRefName,
        headSha: row.headRefOid,
        createdAt: row.createdAt,
        mergedAt: row.mergedAt,
        closedAt: row.closedAt,
        url: row.url,
    }));
}

async function checkRunsFor(
    run: (command: string[]) => Promise<string>,
    repository: string,
    sha: string,
): Promise<
    Array<{
        name: string;
        status: string | null;
        conclusion: string | null;
        started_at: string | null;
        completed_at: string | null;
        details_url: string | null;
    }>
> {
    const collected = [];
    for (let page = 1; page < 20; page += 1) {
        const body = JSON.parse(
            await run(["gh", "api", `repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}`]),
        ) as {
            check_runs: Array<{
                name: string;
                status: string | null;
                conclusion: string | null;
                started_at: string | null;
                completed_at: string | null;
                details_url: string | null;
            }>;
        };
        collected.push(...body.check_runs);
        if (body.check_runs.length < 100) break;
    }
    return collected;
}

async function statusesFor(
    run: (command: string[]) => Promise<string>,
    repository: string,
    sha: string,
): Promise<Array<{ context: string; state: string; updated_at: string | null; target_url: string | null }>> {
    const body = JSON.parse(await run(["gh", "api", `repos/${repository}/commits/${sha}/status`])) as {
        statuses: Array<{ context: string; state: string; updated_at: string | null; target_url: string | null }>;
    };
    return body.statuses;
}

async function workflowName(
    run: (command: string[]) => Promise<string>,
    repository: string,
    runId: number,
): Promise<string> {
    try {
        const body = JSON.parse(await run(["gh", "api", `repos/${repository}/actions/runs/${runId}`])) as {
            name?: string;
        };
        return body.name ?? "External / Unspecified";
    } catch {
        return "External / Unspecified";
    }
}

async function gh(command: string[]): Promise<string> {
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0) throw new Error(stderr.trim() || `${command[0]} failed`);
    return stdout;
}

if (import.meta.main) {
    const repository = process.argv[2];
    const agyHome = process.argv[3] ?? join(process.env.HOME ?? "", ".gemini", "antigravity-cli");
    const historyDirectory = process.argv[4] ?? join(import.meta.dir, "../../..", "historical-data");
    if (!repository) {
        console.error("usage: bun src/usage/extract-agy-usage.ts owner/name [agy-home] [historical-data]");
        process.exit(1);
    }
    await extractAgyUsage({ repository, agyHome, historyDirectory });
    console.log(`Wrote ${join(historyDirectory, "pr_token_usage_dataset.json")}`);
    console.log(`Wrote ${join(historyDirectory, "pr_cicd_dataset.json")}`);
}
