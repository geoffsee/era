/** Smith Horn token bins and the ACEM / SEEAgent formulas from docs/THEORY.md. */

export const TOKEN_BIN_LIMITS = {
    XS: 50_000,
    S: 100_000,
    M: 200_000,
    L: 400_000,
} as const;

export const POINT_SCALE = [1, 2, 3, 5, 8, 13] as const;

export type TokenSize = "XS" | "S" | "M" | "L" | "XL";

/** Smallest bin whose planned load can hold `tokens`. Above L is XL. */
export function tokenSize(tokens: number): TokenSize {
    if (tokens <= TOKEN_BIN_LIMITS.XS) return "XS";
    if (tokens <= TOKEN_BIN_LIMITS.S) return "S";
    if (tokens <= TOKEN_BIN_LIMITS.M) return "M";
    if (tokens <= TOKEN_BIN_LIMITS.L) return "L";
    return "XL";
}

/** How many ≤L leaves the decomposition rule requires. */
export function partitionCount(tokens: number): number {
    if (!Number.isFinite(tokens) || tokens < 0) {
        throw new Error(`token count must be a non-negative finite number, got ${tokens}`);
    }
    if (tokens <= TOKEN_BIN_LIMITS.L) return 1;
    return Math.ceil(tokens / TOKEN_BIN_LIMITS.L);
}

export function median(values: readonly number[]): number {
    if (values.length === 0) throw new Error("median of an empty sample");
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid]!;
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function quantile(values: readonly number[], p: number): number {
    if (values.length === 0) throw new Error("quantile of an empty sample");
    if (p < 0 || p > 1) throw new Error(`quantile p must be in [0, 1], got ${p}`);
    const sorted = [...values].sort((a, b) => a - b);
    const index = (sorted.length - 1) * p;
    const low = Math.floor(index);
    const high = Math.ceil(index);
    if (low === high) return sorted[low]!;
    const weight = index - low;
    return sorted[low]! * (1 - weight) + sorted[high]! * weight;
}

export function storyPointBreaks(tokens: readonly number[]): number[] {
    return [1, 2, 3, 4, 5].map((step) => quantile(tokens, step / 6));
}

export function storyPointsForTokens(tokens: number, breaks: readonly number[]): number {
    for (let index = 0; index < breaks.length; index++) {
        if (tokens < breaks[index]!) return POINT_SCALE[index]!;
    }
    return POINT_SCALE[POINT_SCALE.length - 1]!;
}

/** CW < 1, = 1, > 1 for simple, medium, and complex stories. */
export function complexityWeight(points: number): number {
    if (points <= 2) return 0.5;
    if (points <= 5) return 1;
    return 1.5;
}

export function nearestOnScale(value: number, scale: readonly number[] = POINT_SCALE): number {
    let best = scale[0]!;
    let bestDistance = Infinity;
    for (const point of scale) {
        const distance = Math.abs(point - value);
        if (distance < bestDistance) {
            best = point;
            bestDistance = distance;
        }
    }
    return best;
}

export type Negotiation = {
    /** Agreed value. This is the anchor after concessions, not the mean of a round. */
    estimate: number;
    rounds: number;
    trace: number[][];
};

function stepToward(current: number, target: number): number {
    const scale: readonly number[] = POINT_SCALE;
    const from = scale.indexOf(current);
    const to = scale.indexOf(nearestOnScale(target, scale));
    if (from < 0 || to < 0 || from === to) return nearestOnScale(current, scale);
    return scale[from + Math.sign(to - from)]!;
}

function soleMode(values: readonly number[]): number | null {
    const counts = new Map<number, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    let bestValue: number | null = null;
    let bestCount = 0;
    let tied = false;
    for (const [value, count] of counts) {
        if (count > bestCount) {
            bestValue = value;
            bestCount = count;
            tied = false;
        } else if (count === bestCount) {
            tied = true;
        }
    }
    if (bestValue === null || tied || bestCount < 2) return null;
    return bestValue;
}

/**
 * Planning-poker rounds. Agent 0 is the historical analog and is the published
 * anchor. Peer agents concede toward that anchor. A strict peer majority pulls
 * the anchor one step toward them. Stop when the range is within epsilon.
 */
export function negotiateEstimates(initial: readonly number[], epsilon = 0, maxRounds = 8): Negotiation {
    if (initial.length < 2) throw new Error("negotiation needs at least two agents");
    let current = initial.map((value) => nearestOnScale(value));
    const trace: number[][] = [current.slice()];
    const spread = () => Math.max(...current) - Math.min(...current);

    for (let round = 1; round <= maxRounds; round++) {
        if (spread() <= epsilon) {
            return { estimate: current[0]!, rounds: round - 1, trace };
        }
        const peers = current.slice(1);
        const peerMode = soleMode(peers);
        const anchor = peerMode !== null && peerMode !== current[0] ? stepToward(current[0]!, peerMode) : current[0]!;
        const next = [anchor, ...peers.map((peer) => (peer === anchor ? peer : stepToward(peer, anchor)))];
        current = next;
        trace.push(current.slice());
        if (spread() <= epsilon) {
            return { estimate: current[0]!, rounds: round, trace };
        }
    }
    return { estimate: current[0]!, rounds: maxRounds, trace };
}

export function revisionFactor(rejectionRate: number, extraInvocations: number): number {
    return 1 + rejectionRate * extraInvocations;
}

/** CF = 1 + α · (i / N). A context reset is a new segment with i starting over. */
export function contextFactor(alpha: number, position: number, pipelineLength: number): number {
    if (pipelineLength <= 0) throw new Error("pipeline length must be positive");
    return 1 + alpha * (position / pipelineLength);
}

export function baseTokensFromStoryPoints(points: number, gammaPerPoint: number, weight: number): number {
    return points * gammaPerPoint * weight;
}

export function llmCost(input: {
    inputTokens: number;
    outputTokens: number;
    priceInPerToken: number;
    priceOutPerToken: number;
    revisionFactor: number;
    contextFactor: number;
}): number {
    const base = input.inputTokens * input.priceInPerToken + input.outputTokens * input.priceOutPerToken;
    return base * input.revisionFactor * input.contextFactor;
}

/**
 * ACEM cost when the (CF − 1) input share is billed as cache reads.
 * Output is the position-independent completion, not another copy of the prompt cache.
 * `llmCost` is the literal product, which prices that same growth as fresh input.
 */
export function llmCostWithCacheReads(input: {
    inputTokens: number;
    outputTokens: number;
    priceInPerToken: number;
    priceCacheReadPerToken: number;
    priceOutPerToken: number;
    revisionFactor: number;
    contextFactor: number;
}): number {
    const fresh = input.inputTokens * input.priceInPerToken;
    const context = input.inputTokens * Math.max(0, input.contextFactor - 1) * input.priceCacheReadPerToken;
    const output = input.outputTokens * input.priceOutPerToken;
    return (fresh + context + output) * input.revisionFactor;
}

export function hitlCost(input: {
    checkpoints: number;
    reviewHours: number;
    rejectionRate: number;
    reworkHours: number;
    hourlyRate: number;
}): number {
    return (
        input.checkpoints * input.reviewHours * input.hourlyRate +
        input.rejectionRate * input.reworkHours * input.hourlyRate
    );
}

export function infraCost(usage: number, pricePerUnit: number): number {
    return usage * pricePerUnit;
}

export function totalCost(llm: number, hitl: number, infra: number): number {
    return llm + hitl + infra;
}

export function meanAbsoluteError(actual: readonly number[], predicted: readonly number[]): number {
    assertSameLength(actual, predicted);
    let sum = 0;
    for (let index = 0; index < actual.length; index++) {
        sum += Math.abs(actual[index]! - predicted[index]!);
    }
    return sum / actual.length;
}

export function meanMagnitudeRelativeError(actual: readonly number[], predicted: readonly number[]): number {
    assertSameLength(actual, predicted);
    let sum = 0;
    for (let index = 0; index < actual.length; index++) {
        const truth = actual[index]!;
        if (truth === 0) throw new Error("MMRE is undefined when an actual value is 0");
        sum += Math.abs(truth - predicted[index]!) / truth;
    }
    return sum / actual.length;
}

export function predictionWithin(actual: readonly number[], predicted: readonly number[], threshold = 0.5): number {
    assertSameLength(actual, predicted);
    let hits = 0;
    for (let index = 0; index < actual.length; index++) {
        const truth = actual[index]!;
        if (truth === 0) throw new Error("PRED is undefined when an actual value is 0");
        if (Math.abs(truth - predicted[index]!) / truth <= threshold) hits += 1;
    }
    return hits / actual.length;
}

function assertSameLength(actual: readonly number[], predicted: readonly number[]): void {
    if (actual.length === 0) throw new Error("accuracy metrics need at least one pair");
    if (actual.length !== predicted.length) throw new Error("actual and predicted lengths differ");
}

export type PathResult = {
    total: number;
    path: number[];
};

/** Longest path in a DAG. `predecessors` maps a node to the nodes that must finish first. */
export function longestPath(
    nodes: readonly number[],
    predecessors: ReadonlyMap<number, ReadonlySet<number>>,
    weight: (node: number) => number,
): PathResult {
    const memo = new Map<number, PathResult>();
    const visiting = new Set<number>();

    const visit = (node: number): PathResult => {
        const cached = memo.get(node);
        if (cached) return cached;
        if (visiting.has(node)) throw new Error(`dependency cycle at ${node}`);
        visiting.add(node);
        let best: PathResult = { total: weight(node), path: [node] };
        const incoming = [...(predecessors.get(node) ?? [])].sort((a, b) => a - b);
        for (const predecessor of incoming) {
            const upstream = visit(predecessor);
            const candidate: PathResult = {
                total: upstream.total + weight(node),
                path: [...upstream.path, node],
            };
            best = preferPath(best, candidate);
        }
        visiting.delete(node);
        memo.set(node, best);
        return best;
    };

    let best: PathResult = { total: 0, path: [] };
    for (const node of [...nodes].sort((a, b) => a - b)) {
        best = preferPath(best, visit(node));
    }
    return best;
}

function preferPath(current: PathResult, candidate: PathResult): PathResult {
    if (candidate.total > current.total) return candidate;
    if (candidate.total < current.total) return current;
    const currentKey = current.path.join(",");
    const candidateKey = candidate.path.join(",");
    return candidateKey < currentKey ? candidate : current;
}
