/**
 * Codex review-loop accounting.
 *
 * A session counts when its title or first message asks for a pull-request review,
 * or asks to address review comments. Spawned children inherit that role.
 * Token splits come from the last thread usage record. A session that names several
 * pull requests is split evenly across them: the log does not record a per-pull-request
 * token share. Children that name none inherit the parent list.
 */

export const CREDIT_USD = 0.04;

/** Standard-speed Codex credits per million tokens. USD is credits times CREDIT_USD. */
export const CODEX_CREDIT_RATES: Readonly<Record<string, { input: number; cached: number; output: number }>> = {
    "gpt-6-astra": { input: 250, cached: 25, output: 1250 },
    "gpt-6.1-sol": { input: 50, cached: 2.5, output: 250 },
    "gpt-6-sol": { input: 50, cached: 5, output: 250 },
    "gpt-6-luna": { input: 2.5, cached: 0.25, output: 12.5 },
    "gpt-5.6-sol": { input: 100, cached: 10, output: 500 },
    "gpt-5.6-terra": { input: 50, cached: 5, output: 300 },
    "gpt-5.6-luna": { input: 5, cached: 0.5, output: 30 },
    "gpt-5.5": { input: 125, cached: 12.5, output: 750 },
};

export type ReviewRole = "review" | "followup";

export type TokenSplit = {
    uncachedInputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** False when the input/output split or the model rate is missing. */
    priced: boolean;
};

export type ReviewSessionInput = {
    id: string;
    parentId: string | null;
    model: string;
    /** Title and first user message. Rollout text is not a role signal. */
    roleText: string;
    /** Pull request numbers named by this thread itself. */
    pullRequests: number[];
    usage: TokenSplit;
};

export type SessionAttribution = "named" | "inherited" | "unattributed";

export type AllocatedSession = {
    id: string;
    parentId: string | null;
    model: string;
    role: ReviewRole;
    attribution: SessionAttribution;
    pullRequests: number[];
    usage: TokenSplit;
};

export type PullRequestReview = {
    prNumber: number;
    reviewTokens: number;
    pricedReviewTokens: number;
    reviewCostUsd: number;
    models: string[];
};

export type ReviewAllocation = {
    sessions: AllocatedSession[];
    pullRequests: PullRequestReview[];
    unattributedReviewTokens: number;
    followupTokens: number;
    reviewLoopTokens: number;
    inheritedReviewTokens: number;
};

export function reviewRole(text: string): ReviewRole | null {
    const normalized = text.toLowerCase();
    const aboutPullRequests =
        /pull request/.test(normalized) ||
        /\/pull\/\d+/.test(normalized) ||
        /\bprs?\b/.test(normalized) ||
        /\bpr\s*#?\s*\d+/.test(normalized) ||
        /\*\*#\d+\*\*/.test(text);
    if (!aboutPullRequests) return null;
    const reviewAt = normalized.search(/\breview\b/);
    const addressAt = normalized.search(/address (all )?comments|respond to (the )?review/);
    if (addressAt !== -1 && (reviewAt === -1 || addressAt < reviewAt)) return "followup";
    if (reviewAt !== -1) return "review";
    return null;
}

export function pullRequestNumbersFromText(text: string): number[] {
    return uniqueNumbers([
        ...matches(text, /github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/g),
        ...matches(text, /\*\*#(\d+)\*\*/g),
        ...matches(text, /\bPR\s*#\s*(\d+)/gi),
    ]);
}

export function pullRequestNumbersFromRollout(text: string): number[] {
    const found = [...matches(text, /\bgh pr (?:view|checks|diff|comment|review|edit|merge|ready)\s+(\d+)/g)];
    if (/gh api/.test(text)) found.push(...matches(text, /\bpulls\/(\d+)/g));
    if (/\bgh pr\b/.test(text)) {
        for (const match of text.matchAll(/for n in ((?:\d+\s+){0,40}\d+)/g)) {
            const start = Math.max(0, (match.index ?? 0) - 80);
            const windowText = text.slice(start, (match.index ?? 0) + match[0].length + 80);
            if (/e\.g\./.test(windowText)) continue;
            found.push(...matches(match[1] ?? "", /(\d+)/g));
        }
    }
    return uniqueNumbers(found);
}

export function usageFromThreadRecord(usage: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
}): TokenSplit {
    const cacheReadTokens = wholeTokens(usage.cached_input_tokens);
    const uncachedInputTokens = Math.max(0, wholeTokens(usage.input_tokens) - cacheReadTokens);
    const outputTokens = wholeTokens(usage.output_tokens);
    return {
        uncachedInputTokens,
        cacheReadTokens,
        outputTokens,
        totalTokens: uncachedInputTokens + cacheReadTokens + outputTokens,
        priced: true,
    };
}

/** List price for a known model. Cache writes stay in the uncached input; the credit card has no write rate. */
export function reviewTokenCostUsd(model: string, usage: TokenSplit): number | null {
    if (!usage.priced) return null;
    const rate = CODEX_CREDIT_RATES[model];
    if (!rate) return null;
    const credits =
        (usage.uncachedInputTokens * rate.input +
            usage.cacheReadTokens * rate.cached +
            usage.outputTokens * rate.output) /
        1_000_000;
    return credits * CREDIT_USD;
}

export function allocateReviewSessions(sessions: readonly ReviewSessionInput[]): ReviewAllocation {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const allocated: AllocatedSession[] = [];
    for (const session of sessions) {
        const role = resolveRole(session, byId, new Set());
        if (!role || session.usage.totalTokens <= 0) continue;
        const { pullRequests, attribution } = resolvePullRequests(session, byId, new Set());
        allocated.push({
            id: session.id,
            parentId: session.parentId,
            model: session.model,
            role,
            attribution,
            pullRequests,
            usage: session.usage,
        });
    }

    const buckets = new Map<number, Map<string, TokenSplit>>();
    let unattributedReviewTokens = 0;
    let followupTokens = 0;
    let reviewLoopTokens = 0;
    let inheritedReviewTokens = 0;

    for (const session of allocated) {
        reviewLoopTokens += session.usage.totalTokens;
        if (session.role === "followup") followupTokens += session.usage.totalTokens;
        if (session.attribution === "inherited") inheritedReviewTokens += session.usage.totalTokens;
        if (session.pullRequests.length === 0) {
            unattributedReviewTokens += session.usage.totalTokens;
            continue;
        }
        const shares = session.pullRequests.map((_, index) =>
            splitShare(session.usage, session.pullRequests.length, index),
        );
        session.pullRequests.forEach((prNumber, index) => {
            const share = shares[index]!;
            const models = buckets.get(prNumber) ?? new Map<string, TokenSplit>();
            const current = models.get(session.model) ?? emptySplit();
            models.set(session.model, addSplit(current, share));
            buckets.set(prNumber, models);
        });
    }

    const pullRequests = [...buckets.entries()]
        .sort(([left], [right]) => left - right)
        .map(([prNumber, models]) => {
            let reviewTokens = 0;
            let pricedReviewTokens = 0;
            let reviewCostUsd = 0;
            for (const [model, usage] of models) {
                reviewTokens += usage.totalTokens;
                const cost = reviewTokenCostUsd(model, usage);
                if (cost === null) continue;
                pricedReviewTokens += usage.totalTokens;
                reviewCostUsd += cost;
            }
            return {
                prNumber,
                reviewTokens,
                pricedReviewTokens,
                reviewCostUsd,
                models: [...models.keys()].sort(),
            };
        });

    return {
        sessions: allocated,
        pullRequests,
        unattributedReviewTokens,
        followupTokens,
        reviewLoopTokens,
        inheritedReviewTokens,
    };
}

export type WorkflowRun = {
    headBranch: string;
    headSha: string;
    createdAt: string;
    updatedAt: string;
    status: string;
};

export type ReviewWindow = {
    pullRequests: number[];
    startedAt: string;
    endedAt: string;
};

export type PullRequestHead = {
    number: number;
    headBranch: string;
    headSha: string;
};

/**
 * Extra Actions span, in whole seconds, beyond the final head SHA.
 * Runs on one SHA collapse to a single wall-clock span. The final head is excluded
 * because pr_cicd_dataset already counts it.
 */
export function reviewCicdSecondsByPullRequest(
    runs: readonly WorkflowRun[],
    windows: readonly ReviewWindow[],
    heads: readonly PullRequestHead[],
): Map<number, number> {
    const result = new Map<number, number>();
    for (const head of heads) {
        const groups = new Map<string, WorkflowRun[]>();
        for (const run of runs) {
            if (run.headBranch !== head.headBranch || run.headSha === head.headSha || run.status !== "completed") {
                continue;
            }
            const group = groups.get(run.headSha) ?? [];
            group.push(run);
            groups.set(run.headSha, group);
        }
        let seconds = 0;
        for (const group of groups.values()) {
            const start = Math.min(...group.map((run) => Date.parse(run.createdAt)));
            const end = Math.max(...group.map((run) => Date.parse(run.updatedAt)));
            if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
            const inside = windows.some((window) => {
                if (!window.pullRequests.includes(head.number)) return false;
                const opened = Date.parse(window.startedAt);
                const closed = Date.parse(window.endedAt);
                return start >= opened && start <= closed;
            });
            if (!inside) continue;
            seconds += Math.round((end - start) / 1000);
        }
        if (seconds > 0) result.set(head.number, seconds);
    }
    return result;
}

function resolveRole(
    session: ReviewSessionInput,
    byId: ReadonlyMap<string, ReviewSessionInput>,
    visiting: Set<string>,
): ReviewRole | null {
    const own = reviewRole(session.roleText);
    if (own) return own;
    if (!session.parentId || visiting.has(session.id)) return null;
    const parent = byId.get(session.parentId);
    if (!parent) return null;
    visiting.add(session.id);
    return resolveRole(parent, byId, visiting);
}

function resolvePullRequests(
    session: ReviewSessionInput,
    byId: ReadonlyMap<string, ReviewSessionInput>,
    visiting: Set<string>,
): { pullRequests: number[]; attribution: SessionAttribution } {
    if (session.pullRequests.length > 0) {
        return { pullRequests: uniqueNumbers(session.pullRequests.map(String)), attribution: "named" };
    }
    if (!session.parentId || visiting.has(session.id)) return { pullRequests: [], attribution: "unattributed" };
    const parent = byId.get(session.parentId);
    if (!parent) return { pullRequests: [], attribution: "unattributed" };
    visiting.add(session.id);
    const inherited = resolvePullRequests(parent, byId, visiting);
    if (inherited.pullRequests.length === 0) return { pullRequests: [], attribution: "unattributed" };
    return { pullRequests: inherited.pullRequests, attribution: "inherited" };
}

function splitShare(usage: TokenSplit, parts: number, index: number): TokenSplit {
    const share = {
        uncachedInputTokens: splitEvenly(usage.uncachedInputTokens, parts)[index]!,
        cacheReadTokens: splitEvenly(usage.cacheReadTokens, parts)[index]!,
        outputTokens: splitEvenly(usage.outputTokens, parts)[index]!,
        totalTokens: 0,
        priced: usage.priced,
    };
    share.totalTokens = share.uncachedInputTokens + share.cacheReadTokens + share.outputTokens;
    return share;
}

export function splitEvenly(total: number, parts: number): number[] {
    if (!Number.isInteger(total) || total < 0)
        throw new Error(`token count must be a non-negative integer, got ${total}`);
    if (!Number.isInteger(parts) || parts <= 0) throw new Error(`split parts must be a positive integer, got ${parts}`);
    const base = Math.floor(total / parts);
    const remainder = total % parts;
    return Array.from({ length: parts }, (_, index) => base + (index < remainder ? 1 : 0));
}

function emptySplit(): TokenSplit {
    return { uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, priced: true };
}

function addSplit(left: TokenSplit, right: TokenSplit): TokenSplit {
    return {
        uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
        cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
        outputTokens: left.outputTokens + right.outputTokens,
        totalTokens: left.totalTokens + right.totalTokens,
        priced: left.priced && right.priced,
    };
}

function wholeTokens(value: number): number {
    if (!Number.isFinite(value) || value < 0)
        throw new Error(`token count must be a non-negative number, got ${value}`);
    return Math.round(value);
}

function matches(text: string, pattern: RegExp): string[] {
    return [...text.matchAll(pattern)].map((match) => match[1] ?? "");
}

function uniqueNumbers(values: readonly string[]): number[] {
    const numbers = new Set<number>();
    for (const value of values) {
        const number = Number(value);
        if (Number.isInteger(number) && number > 0 && number < 1_000_000) numbers.add(number);
    }
    return [...numbers].sort((left, right) => left - right);
}
