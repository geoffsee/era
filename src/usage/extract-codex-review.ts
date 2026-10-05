import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    allocateReviewSessions,
    pullRequestNumbersFromRollout,
    pullRequestNumbersFromText,
    type ReviewSessionInput,
    reviewCicdSecondsByPullRequest,
    reviewTokenCostUsd,
    type TokenSplit,
    usageFromThreadRecord,
    type WorkflowRun,
} from "./review-usage.ts";

const RUN_LIMIT = 500;

const GAPS = [
    "A session that names several pull requests is split evenly. The Codex log does not record a per-pull-request token share.",
    "A spawned subagent with no pull request number inherits its parent's list and is split the same way.",
    "Local test commands inside a review session are not GitHub Actions minutes.",
    "The price is the Standard Codex credit card at $0.04 per credit. The session log does not record Fast or Ultrafast.",
    "Review CI is the wall-clock span of completed Actions runs on earlier SHAs of the pull request's head branch that start during a review session. The final head SHA stays in pr_cicd_dataset.json.",
    "Cache-write tokens are billed as uncached input. The credit card has no cache-write rate.",
];

type ThreadRow = {
    id: string;
    rollout_path: string;
    created_at: number;
    updated_at: number;
    title: string;
    first_user_message: string;
    tokens_used: number;
    model: string | null;
    git_origin_url: string | null;
};

export async function extractCodexReview(input: {
    repository: string;
    codexHome: string;
    historyDirectory: string;
    run?: (command: string[]) => Promise<string>;
}): Promise<void> {
    if (!/^[^/\s]+\/[^/\s]+$/.test(input.repository)) {
        throw new Error(`repository must be owner/name, got ${input.repository}`);
    }
    const statePath = codexStatePath(input.codexHome);
    const backupDirectory = await backupDatabase(statePath);
    const backup = join(backupDirectory, "state.sqlite");
    try {
        const database = new Database(backup);
        const threads = threadsForRepository(database, input.repository);
        const parents = parentIds(database, threads.keys());
        database.close();

        const sessions: ReviewSessionInput[] = [];
        const times = new Map<string, { startedAt: string; endedAt: string }>();
        for (const thread of threads.values()) {
            const rollout = await readRollout(thread.rollout_path);
            const roleText = `${thread.title}\n${thread.first_user_message}`;
            const pullRequests = unique([...pullRequestNumbersFromText(roleText), ...rollout.pullRequests]);
            sessions.push({
                id: thread.id,
                parentId: parents.get(thread.id) ?? null,
                model: thread.model ?? "",
                roleText,
                pullRequests,
                usage: rollout.usage ?? unpricedTotal(thread.tokens_used),
            });
            times.set(thread.id, {
                startedAt: iso(thread.created_at),
                endedAt: iso(Math.max(thread.created_at, thread.updated_at)),
            });
        }

        const allocation = allocateReviewSessions(sessions);
        const gaps = [...GAPS];
        const run = input.run ?? gh;
        const heads = await loadHeads(input.historyDirectory, input.repository, run, gaps, allocation.pullRequests);
        const cicd = new Map<number, number>();
        const windows = allocation.sessions
            .filter((session) => session.pullRequests.length > 0)
            .map((session) => ({
                pullRequests: session.pullRequests,
                startedAt: times.get(session.id)?.startedAt ?? "",
                endedAt: times.get(session.id)?.endedAt ?? "",
            }));
        const branches = new Map<string, { number: number; headBranch: string; headSha: string }[]>();
        for (const head of heads) {
            if (!allocation.pullRequests.some((pullRequest) => pullRequest.prNumber === head.number)) continue;
            const group = branches.get(head.headBranch) ?? [];
            group.push(head);
            branches.set(head.headBranch, group);
        }
        for (const [branch, group] of branches) {
            try {
                const listed = await listRuns(run, input.repository, branch);
                if (listed.length >= RUN_LIMIT)
                    gaps.push(`Actions history for ${branch} stopped at ${RUN_LIMIT} runs.`);
                const seconds = reviewCicdSecondsByPullRequest(listed, windows, group);
                for (const [number, value] of seconds) cicd.set(number, (cicd.get(number) ?? 0) + value);
            } catch (error) {
                gaps.push(
                    `Actions history for ${branch} was not read: ${error instanceof Error ? error.message : "command failed"}.`,
                );
            }
        }

        const dataset = {
            metadata: {
                generated_at: new Date().toISOString(),
                repository: input.repository,
                credit_usd: 0.04,
                speed: "standard",
                sessions_in_repository: threads.size,
                review_sessions: allocation.sessions.length,
                review_loop_tokens: allocation.reviewLoopTokens,
                followup_tokens: allocation.followupTokens,
                inherited_review_tokens: allocation.inheritedReviewTokens,
                unattributed_review_tokens: allocation.unattributedReviewTokens,
                gaps,
            },
            sessions: allocation.sessions.map((session) => ({
                id: session.id,
                parent_id: session.parentId,
                role: session.role,
                model: session.model,
                attribution: session.attribution,
                pull_requests: session.pullRequests,
                started_at: times.get(session.id)?.startedAt ?? "",
                ended_at: times.get(session.id)?.endedAt ?? "",
                uncached_input_tokens: session.usage.uncachedInputTokens,
                cache_read_input_tokens: session.usage.cacheReadTokens,
                output_tokens: session.usage.outputTokens,
                total_tokens: session.usage.totalTokens,
                priced: reviewTokenCostUsd(session.model, session.usage) !== null,
            })),
            pull_requests: allocation.pullRequests.map((pullRequest) => ({
                pr_number: pullRequest.prNumber,
                review_tokens: pullRequest.reviewTokens,
                priced_review_tokens: pullRequest.pricedReviewTokens,
                review_cost_usd: pullRequest.reviewCostUsd,
                review_cicd_seconds: cicd.get(pullRequest.prNumber) ?? 0,
                models: pullRequest.models,
            })),
        };
        await Bun.write(join(input.historyDirectory, "pr_review_dataset.json"), JSON.stringify(dataset, null, 2));
    } finally {
        await rm(backupDirectory, { recursive: true, force: true });
    }
}

function codexStatePath(codexHome: string): string {
    const names = readdirSync(codexHome).flatMap((name) => {
        const match = /^state_(\d+)\.sqlite$/.exec(name);
        return match ? [{ name, version: Number(match[1]) }] : [];
    });
    const match = names.sort((left, right) => left.version - right.version).at(-1);
    if (!match) throw new Error(`no Codex state database in ${codexHome}`);
    return join(codexHome, match.name);
}

async function backupDatabase(statePath: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "codex-state-"));
    const backup = join(directory, "state.sqlite");
    const proc = Bun.spawn(["sqlite3", statePath, `.backup ${backup}`], { stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0) {
        await rm(directory, { recursive: true, force: true });
        throw new Error(stderr.trim() || "sqlite backup failed");
    }
    return directory;
}

function threadsForRepository(database: Database, repository: string): Map<string, ThreadRow> {
    const origins = [`https://github.com/${repository}.git`, `git@github.com:${repository}.git`];
    const rows = database
        .query(
            `SELECT id, rollout_path, created_at, updated_at, title, first_user_message, tokens_used, model, git_origin_url
             FROM threads WHERE git_origin_url IN (?, ?)`,
        )
        .all(...origins) as ThreadRow[];
    return new Map(rows.map((row) => [row.id, row]));
}

function parentIds(database: Database, ids: Iterable<string>): Map<string, string> {
    const wanted = new Set(ids);
    const rows = database.query(`SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges`).all() as Array<{
        parent_thread_id: string;
        child_thread_id: string;
    }>;
    const parents = new Map<string, string>();
    for (const row of rows) {
        if (wanted.has(row.child_thread_id) && wanted.has(row.parent_thread_id)) {
            parents.set(row.child_thread_id, row.parent_thread_id);
        }
    }
    return parents;
}

async function readRollout(path: string): Promise<{ usage: TokenSplit | null; pullRequests: number[] }> {
    const file = Bun.file(path);
    if (!(await file.exists())) return { usage: null, pullRequests: [] };
    const reader = file.stream().getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: TokenSplit | null = null;
    const pullRequests = new Set<number>();
    const consume = (line: string) => {
        if (line.includes("exec")) {
            for (const number of pullRequestNumbersFromRollout(line)) pullRequests.add(number);
        }
        if (!line.includes("token_usage_record")) return;
        try {
            const record = JSON.parse(line) as {
                type?: string;
                payload?: {
                    thread_token_usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
                };
            };
            const threadUsage = record.type === "token_usage_record" ? record.payload?.thread_token_usage : undefined;
            if (threadUsage) usage = usageFromThreadRecord(threadUsage);
        } catch {
            // A non-JSON line that mentions the record name carries no usage.
        }
    };
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
            consume(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
        }
    }
    if (buffer.length > 0) consume(buffer);
    return { usage, pullRequests: [...pullRequests] };
}

async function loadHeads(
    directory: string,
    repository: string,
    run: (command: string[]) => Promise<string>,
    gaps: string[],
    pullRequests: ReadonlyArray<{ prNumber: number }>,
): Promise<Array<{ number: number; headBranch: string; headSha: string }>> {
    const recorded = new Map<number, { headBranch: string; headSha: string }>();
    const cicdPath = join(directory, "pr_cicd_dataset.json");
    if (await Bun.file(cicdPath).exists()) {
        const rows = (await Bun.file(cicdPath).json()) as Array<{
            pr_number: number;
            head_branch: string;
            head_sha: string;
        }>;
        for (const row of rows) recorded.set(row.pr_number, { headBranch: row.head_branch, headSha: row.head_sha });
    }
    const live = new Map<number, string>();
    try {
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
            "number,headRefName",
        ]);
        const rows = JSON.parse(stdout) as Array<{ number: number; headRefName: string }>;
        if (rows.length >= 500) gaps.push("The pull request list stopped at 500, so later heads were not read.");
        for (const row of rows) live.set(row.number, row.headRefName);
    } catch (error) {
        gaps.push(`Pull request heads were not listed: ${error instanceof Error ? error.message : "command failed"}.`);
    }
    const heads: Array<{ number: number; headBranch: string; headSha: string }> = [];
    let missing = 0;
    for (const pullRequest of pullRequests) {
        const snapshot = recorded.get(pullRequest.prNumber);
        const headBranch = live.get(pullRequest.prNumber) ?? snapshot?.headBranch;
        if (!headBranch) {
            missing += 1;
            continue;
        }
        heads.push({
            number: pullRequest.prNumber,
            headBranch,
            headSha: snapshot?.headSha ?? "",
        });
    }
    if (missing > 0) {
        gaps.push(`${missing} reviewed pull requests had no head branch, so their Actions runs were not measured.`);
    }
    return heads;
}

async function listRuns(
    run: (command: string[]) => Promise<string>,
    repository: string,
    branch: string,
): Promise<WorkflowRun[]> {
    const stdout = await run([
        "gh",
        "run",
        "list",
        "--repo",
        repository,
        "--branch",
        branch,
        "--limit",
        String(RUN_LIMIT),
        "--json",
        "headBranch,headSha,createdAt,updatedAt,status",
    ]);
    const rows = JSON.parse(stdout) as Array<{
        headBranch: string;
        headSha: string;
        createdAt: string;
        updatedAt: string;
        status: string;
    }>;
    return rows;
}

async function gh(command: string[]): Promise<string> {
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0) throw new Error(stderr.trim() || `${command[0]} failed`);
    return stdout;
}

function unpricedTotal(tokens: number): TokenSplit {
    const totalTokens = Math.max(0, Math.round(tokens));
    return {
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens,
        priced: false,
    };
}

function iso(seconds: number): string {
    return new Date(seconds * 1000).toISOString();
}

function unique(values: number[]): number[] {
    return [...new Set(values)].sort((left, right) => left - right);
}

if (import.meta.main) {
    const repository = process.argv[2];
    const codexHome = process.argv[3] ?? join(process.env.HOME ?? "", ".codex");
    const historyDirectory = process.argv[4] ?? join(import.meta.dir, "../..", "historical-data");
    if (!repository) {
        console.error("usage: bun src/usage/extract-codex-review.ts owner/name [codex-home] [historical-data]");
        process.exit(1);
    }
    await extractCodexReview({ repository, codexHome, historyDirectory });
    console.log(`Wrote ${join(historyDirectory, "pr_review_dataset.json")}`);
}
