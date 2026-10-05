export type Lane = {
    id: string;
    name: string;
    state: string;
    issues: number[];
    /** Arrow groups. Each group is an ordered list of parallel stages. */
    chains: number[][][];
};

export type Gate = {
    id: string;
    name: string;
    requires: string[];
    unlocks: string[];
};

export type DependencyGraph = {
    nodes: number[];
    predecessors: Map<number, Set<number>>;
    lanes: Lane[];
    /** Dependencies that could not be represented faithfully in the issue-level DAG. */
    diagnostics: string[];
};

export function isEpicTitle(title: string): boolean {
    return /^\[Epic\b/i.test(title.trim());
}

export function parseRoadmap(body: string): { lanes: Lane[]; gates: Gate[] } {
    const lanes: Lane[] = [];
    const gates: Gate[] = [];
    for (const line of body.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("|")) continue;
        const cells = splitRow(trimmed);
        const head = cells[0] ?? "";
        const laneMatch = head.match(/^(T\d+)\s+(.*)$/);
        if (laneMatch && cells.length >= 4) {
            const membership = cells[3] ?? "";
            lanes.push({
                id: laneMatch[1]!,
                name: laneMatch[2]!.trim(),
                state: (cells[1] ?? "").trim().toLowerCase(),
                issues: unique(issueNumbers(membership)),
                chains: arrowChains(membership),
            });
            continue;
        }
        const gateMatch = head.match(/^([CG]\d+[a-z]?)\s+(.*)$/);
        if (gateMatch && cells.length >= 3) {
            gates.push({
                id: gateMatch[1]!,
                name: gateMatch[2]!.trim(),
                requires: referenceTokens(cells[1] ?? ""),
                unlocks: referenceTokens(cells[2] ?? ""),
            });
        }
    }
    if (lanes.length === 0) throw new Error("roadmap issue body has no lane table");
    if (gates.length === 0) throw new Error("roadmap issue body has no gate table");
    if (new Set(lanes.map((lane) => lane.id)).size !== lanes.length) throw new Error("roadmap has duplicate lane IDs");
    if (new Set(gates.map((gate) => gate.id)).size !== gates.length) throw new Error("roadmap has duplicate gate IDs");
    return { lanes, gates };
}

/**
 * Issue-level DAG for remaining lanes. Complete lanes (T00) are out of the graph.
 * A gate that only releases a later milestone of one of its inputs does not add an edge.
 * An edge that would cycle back to an upstream milestone is dropped.
 */
export function buildDependencyGraph(
    lanes: readonly Lane[],
    gates: readonly Gate[],
    titles: ReadonlyMap<number, string> = new Map(),
): DependencyGraph {
    const active = lanes.filter((lane) => lane.state !== "complete");
    const nodes = unique(active.flatMap((lane) => lane.issues)).sort((a, b) => a - b);
    const nodeSet = new Set(nodes);
    const predecessors = new Map<number, Set<number>>(nodes.map((node) => [node, new Set()]));
    const successors = new Map<number, Set<number>>(nodes.map((node) => [node, new Set()]));
    const diagnostics = new Set<string>();

    const addEdge = (before: number, after: number) => {
        if (before === after) return;
        if (!nodeSet.has(before) || !nodeSet.has(after)) return;
        if (predecessors.get(after)!.has(before)) return;
        if (reaches(after, before, successors)) {
            diagnostics.add(`Dropped dependency #${before} → #${after}: it would create a cycle.`);
            return;
        }
        predecessors.get(after)!.add(before);
        successors.get(before)!.add(after);
    };

    for (const lane of active) {
        for (const stages of lane.chains) {
            for (let index = 0; index < stages.length - 1; index++) {
                for (const before of stages[index]!) {
                    for (const after of stages[index + 1]!) addEdge(before, after);
                }
            }
        }
    }

    const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
    const gateById = new Map(gates.map((gate) => [gate.id, gate]));
    const knownIssues = new Set(lanes.flatMap((lane) => lane.issues));

    const acceptanceIssues = (issue: number): Set<number> => {
        if (!nodeSet.has(issue) && knownIssues.has(issue)) return new Set([issue]);
        const title = titles.get(issue) ?? "";
        if (!isEpicTitle(title)) return new Set([issue]);
        const epic = title.match(/^\[Epic\s+E(\d+)\b/i)?.[1];
        const children =
            epic === undefined
                ? []
                : nodes.filter((number) => {
                      const childTitle = titles.get(number) ?? "";
                      return (
                          !isEpicTitle(childTitle) && Number(childTitle.match(/\bE(\d+)\.\d+\b/)?.[1]) === Number(epic)
                      );
                  });
        if (children.length > 0) return new Set(children);
        diagnostics.add(`Epic #${issue} has no mapped remaining children; its acceptance dependency is unresolved.`);
        return new Set([issue]);
    };

    const requirementIssues = (token: string, stack: readonly string[]): Set<number> => {
        if (stack.includes(token)) {
            diagnostics.add(`Unresolved gate cycle: ${[...stack, token].join(" → ")}.`);
            return new Set();
        }
        if (token.startsWith("#")) {
            const issue = Number(token.slice(1).split(":")[0]);
            if (token.includes(":")) {
                diagnostics.add(
                    `Milestone ${token} is preserved in the source but approximated by whole-issue #${issue} acceptance.`,
                );
            }
            if (!knownIssues.has(issue))
                diagnostics.add(`Dependency ${token} is outside lane membership; completion is unresolved.`);
            return acceptanceIssues(issue);
        }
        if (token.startsWith("T")) {
            const lane = laneById.get(token);
            if (!lane) diagnostics.add(`Unresolved lane dependency ${token}.`);
            return new Set(lane?.issues.flatMap((issue) => [...acceptanceIssues(issue)]) ?? []);
        }
        const gate = gateById.get(token);
        const issues = new Set<number>();
        if (!gate) {
            diagnostics.add(`Unresolved gate dependency ${token}.`);
            return issues;
        }
        for (const requirement of gate.requires) {
            for (const issue of requirementIssues(requirement, [...stack, token])) issues.add(issue);
        }
        return issues;
    };

    for (const gate of gates) {
        const required = new Set<number>();
        for (const requirement of gate.requires) {
            for (const issue of requirementIssues(requirement, [])) required.add(issue);
        }
        for (const unlock of gate.unlocks) {
            const unlocked = unlock.startsWith("#")
                ? [...acceptanceIssues(Number(unlock.slice(1).split(":")[0]))]
                : unlock.startsWith("T")
                  ? (laneById.get(unlock)?.issues ?? [])
                  : [];
            if (unlock.includes(":")) {
                diagnostics.add(
                    `Milestone ${unlock} is preserved in the source but approximated by whole-issue entry.`,
                );
            }
            if (unlock.startsWith("T") && !laneById.has(unlock)) diagnostics.add(`Unresolved lane unlock ${unlock}.`);
            if (unlock.startsWith("#") && !knownIssues.has(Number(unlock.slice(1).split(":")[0])))
                diagnostics.add(`Unlock ${unlock} is outside lane membership; completion is unresolved.`);
            if (/^[CG]/.test(unlock)) diagnostics.add(`Gate unlock ${unlock} is not represented as an execution edge.`);
            for (const after of unlocked) {
                if (required.has(after)) continue;
                for (const before of required) addEdge(before, after);
            }
        }
    }

    return { nodes, predecessors, lanes: active, diagnostics: [...diagnostics] };
}

export function laneForIssue(lanes: readonly Lane[], issue: number): Lane | undefined {
    return lanes.find((lane) => lane.issues.includes(issue));
}

function splitRow(line: string): string[] {
    return line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());
}

export function referenceTokens(cell: string): string[] {
    const tokens: string[] = [];
    for (const part of cell.split(",")) {
        const match = part.match(/\b[CG]\d+[a-z]?\b|\bT\d+\b|#\d+(?::[\w-]+)?/);
        if (match) tokens.push(match[0]);
    }
    return tokens;
}

function issueNumbers(text: string): number[] {
    const found: number[] = [];
    const withoutRanges = text.replace(
        /#(\d+)\s*[\u2013\u2014-]\s*#(\d+)/g,
        (_match, startText: string, endText: string) => {
            const start = Number(startText);
            const end = Number(endText);
            const low = Math.min(start, end);
            const high = Math.max(start, end);
            for (let number = low; number <= high; number++) found.push(number);
            return " ";
        },
    );
    for (const match of withoutRanges.matchAll(/#(\d+)/g)) found.push(Number(match[1]));
    return found;
}

function arrowChains(cell: string): number[][][] {
    const chains: number[][][] = [];
    for (const part of cell.split(";")) {
        if (!part.includes("→")) continue;
        const stages = part
            .split("→")
            .map(issueNumbers)
            .filter((stage) => stage.length > 0);
        if (stages.length >= 2) chains.push(stages);
    }
    return chains;
}

function unique(values: readonly number[]): number[] {
    return [...new Set(values)];
}

function reaches(from: number, to: number, successors: ReadonlyMap<number, ReadonlySet<number>>): boolean {
    const stack = [from];
    const seen = new Set<number>();
    while (stack.length > 0) {
        const node = stack.pop()!;
        if (node === to) return true;
        if (seen.has(node)) continue;
        seen.add(node);
        for (const successor of successors.get(node) ?? []) stack.push(successor);
    }
    return false;
}
