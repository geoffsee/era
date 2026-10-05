import { epicNumberFromTitle, type HistoricalPullRequest } from "./history.ts";
import { buildDependencyGraph, type DependencyGraph, isEpicTitle, parseRoadmap } from "./roadmap.ts";

export type WorkState = "planned" | "active" | "complete";
export type CalibrationGroup = string | number;
export type RoadmapItem = {
    issue: number;
    title: string;
    kind: "work" | "epic";
    state: WorkState;
    group?: string;
    parent?: number;
    calibrationGroup?: CalibrationGroup;
    acceptance?: { source: string };
};
export type NormalizedRoadmap = {
    version: 1;
    items: RoadmapItem[];
    dependencies: Array<{ before: number; after: number }>;
    milestones: Array<{ id: string; requires: number[]; unlocks: number[] }>;
};
type Columns = {
    issues: string;
    title?: string;
    group?: string;
    state?: string;
    dependencies?: string;
    parent?: string;
    kind?: string;
    calibrationGroup?: string;
    acceptance?: string;
};
export type RoadmapConfig = {
    format: "legacy" | "markdown-table" | "normalized-json";
    section?: string;
    columns?: Columns;
    states?: Record<string, WorkState>;
    kinds?: Record<string, "work" | "epic">;
    issueReferences?: "github";
    /** Explicit PR membership avoids relying on historical title conventions. */
    historicalGroups?: Record<string, CalibrationGroup>;
};
export type ResolvedRoadmap = {
    roadmap: NormalizedRoadmap;
    graph: DependencyGraph;
    sourceGates?: ReturnType<typeof parseRoadmap>["gates"];
};

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} field ${key}`);
}
function text(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim() || value.length > 2000)
        throw new Error(`${label} must be a nonempty string of at most 2000 characters`);
    return value.trim();
}
function id(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
        throw new Error("Issue references must be positive safe integers");
    return value;
}
function rows(value: unknown, label: string, limit = 1000): unknown[] {
    if (!Array.isArray(value) || value.length > limit)
        throw new Error(`${label} must be an array of at most ${limit} entries`);
    return value;
}
function cohort(value: unknown): CalibrationGroup {
    if (typeof value === "number") return id(value);
    const name = text(value, "calibration group");
    // Numeric strings would collide with numeric legacy keys in JSON reports.
    if (/^\d+$/.test(name)) throw new Error("Use a number for a numeric calibration group");
    return name;
}
export function parseRoadmapConfig(value: unknown): RoadmapConfig {
    if (value === undefined) return { format: "legacy" };
    const config = object(value, "roadmap configuration");
    keys(
        config,
        ["format", "section", "columns", "states", "kinds", "issueReferences", "historicalGroups"],
        "roadmap configuration",
    );
    if (!["legacy", "markdown-table", "normalized-json"].includes(config.format as string))
        throw new Error("roadmap format must be legacy, markdown-table or normalized-json");
    if (config.issueReferences !== undefined && config.issueReferences !== "github")
        throw new Error("issueReferences must be github");
    if (
        config.format !== "markdown-table" &&
        ["section", "columns", "states", "kinds", "issueReferences"].some((key) => config[key] !== undefined)
    )
        throw new Error("Table mappings require markdown-table format");
    if (config.section !== undefined) text(config.section, "section");
    if (config.format === "markdown-table") {
        const columns = object(config.columns, "columns");
        keys(
            columns,
            ["issues", "title", "group", "state", "dependencies", "parent", "kind", "calibrationGroup", "acceptance"],
            "columns",
        );
        text(columns.issues, "issues column");
        for (const column of Object.values(columns)) text(column, "column heading");
        if (new Set(Object.values(columns)).size !== Object.values(columns).length)
            throw new Error("Each mapped field needs a distinct column");
        for (const [field, allowed] of [
            ["states", ["planned", "active", "complete"]],
            ["kinds", ["work", "epic"]],
        ] as const) {
            if (config[field] === undefined) continue;
            const mapping = object(config[field], field);
            if (Object.keys(mapping).length > 100) throw new Error(`${field} has too many mappings`);
            for (const [key, value] of Object.entries(mapping)) {
                text(key, field);
                if (!allowed.includes(value as never)) throw new Error(`Invalid ${field} mapping for ${key}`);
            }
        }
    }
    if (config.historicalGroups !== undefined) {
        const groups = object(config.historicalGroups, "historicalGroups");
        if (Object.keys(groups).length > 1000) throw new Error("historicalGroups is limited to 1000 PRs");
        for (const [key, value] of Object.entries(groups)) {
            if (!/^[1-9]\d*$/.test(key)) throw new Error(`Invalid historical PR ${key}`);
            id(Number(key));
            cohort(value);
        }
    }
    return config as RoadmapConfig;
}
export function roadmapHistory(
    history: readonly HistoricalPullRequest[],
    config: RoadmapConfig,
): HistoricalPullRequest[] {
    for (const key of Object.keys(config.historicalGroups ?? {}))
        if (!history.some((row) => row.number === Number(key)))
            throw new Error(`Historical group refers to missing PR #${key}`);
    return history.map((row) => ({
        ...row,
        epic: config.historicalGroups?.[String(row.number)] ?? (config.format === "legacy" ? row.epic : null),
    }));
}

export function resolveRoadmap(
    body: string,
    titles: ReadonlyMap<number, string>,
    configValue?: unknown,
): ResolvedRoadmap {
    const config = parseRoadmapConfig(configValue);
    if (body.length > 2 * 1024 * 1024) throw new Error("Roadmap source is limited to 2 MiB");
    if (config.format === "legacy") {
        const parsed = parseRoadmap(body);
        const graph = buildDependencyGraph(parsed.lanes, parsed.gates, titles);
        const items = graph.nodes.map((issue) => {
            const title = text(titles.get(issue), `Missing issue title for #${issue}`);
            const group = graph.lanes.find((lane) => lane.issues.includes(issue))?.id;
            const epic = epicNumberFromTitle(title);
            return {
                issue,
                title,
                kind: isEpicTitle(title) ? ("epic" as const) : ("work" as const),
                state: "planned" as const,
                group,
                ...(epic === null ? {} : { calibrationGroup: epic }),
            };
        });
        return {
            graph,
            sourceGates: parsed.gates,
            roadmap: {
                version: 1,
                items,
                dependencies: [...graph.predecessors].flatMap(([after, before]) =>
                    [...before].map((before) => ({ before, after })),
                ),
                milestones: [],
            },
        };
    }
    let value: unknown;
    if (config.format === "normalized-json") {
        try {
            value = JSON.parse(body);
        } catch {
            throw new Error("Normalized roadmap body must be valid JSON");
        }
    } else value = parseTable(body, titles, config);
    const roadmap = parseNormalized(value);
    return { roadmap, graph: normalizedGraph(roadmap) };
}

function parseNormalized(value: unknown): NormalizedRoadmap {
    const input = object(value, "normalized roadmap");
    keys(input, ["version", "items", "dependencies", "milestones"], "normalized roadmap");
    if (input.version !== 1) throw new Error("Normalized roadmap version must be 1");
    const items = rows(input.items, "items").map((value) => {
        const item = object(value, "item");
        keys(item, ["issue", "title", "kind", "state", "group", "parent", "calibrationGroup", "acceptance"], "item");
        id(item.issue);
        text(item.title, "item title");
        if (item.kind !== undefined && !["work", "epic"].includes(item.kind as string))
            throw new Error("Item kind must be work or epic");
        if (item.state !== undefined && !["planned", "active", "complete"].includes(item.state as string))
            throw new Error("Item state must be planned, active or complete");
        if (item.group !== undefined) text(item.group, "group");
        if (item.parent !== undefined) id(item.parent);
        if (item.calibrationGroup !== undefined) cohort(item.calibrationGroup);
        if (item.acceptance !== undefined) {
            if (item.kind === "epic")
                throw new Error("Acceptance evidence belongs on delivery work items, not epic trackers");
            const acceptance = object(item.acceptance, "acceptance");
            keys(acceptance, ["source"], "acceptance");
            text(acceptance.source, "acceptance source");
        }
        return { ...item, kind: item.kind ?? "work", state: item.state ?? "planned" } as RoadmapItem;
    });
    if (!items.length) throw new Error("Roadmap must contain at least one item");
    if (new Set(items.map((item) => item.issue)).size !== items.length) throw new Error("Duplicate roadmap issue IDs");
    const dependencies = rows(input.dependencies ?? [], "dependencies", 10000).map((value) => {
        const edge = object(value, "dependency");
        keys(edge, ["before", "after"], "dependency");
        return { before: id(edge.before), after: id(edge.after) };
    });
    const milestones = rows(input.milestones ?? [], "milestones").map((value) => {
        const milestone = object(value, "milestone");
        keys(milestone, ["id", "requires", "unlocks"], "milestone");
        return {
            id: text(milestone.id, "milestone ID"),
            requires: rows(milestone.requires, "requires").map(id),
            unlocks: rows(milestone.unlocks, "unlocks").map(id),
        };
    });
    if (new Set(milestones.map((item) => item.id)).size !== milestones.length)
        throw new Error("Duplicate milestone IDs");
    return { version: 1, items, dependencies, milestones };
}

function normalizedGraph(roadmap: NormalizedRoadmap): DependencyGraph {
    const byId = new Map(roadmap.items.map((item) => [item.issue, item]));
    const children = new Map<number, number[]>();
    for (const item of roadmap.items) {
        if (item.parent === undefined) continue;
        if (byId.get(item.parent)?.kind !== "epic")
            throw new Error(`Parent #${item.parent} must be an epic in roadmap membership`);
        children.set(item.parent, [...(children.get(item.parent) ?? []), item.issue]);
        const seen = new Set([item.issue]);
        let parent: number | undefined = item.parent;
        while (parent !== undefined) {
            if (seen.has(parent)) throw new Error(`Parent cycle at #${parent}`);
            seen.add(parent);
            parent = byId.get(parent)?.parent;
        }
    }
    const diagnostics: string[] = [];
    let traversed = 0;
    const expand = (issue: number): number[] => {
        if (!byId.has(issue)) throw new Error(`Dependency #${issue} is outside roadmap membership`);
        const pending = [issue],
            work: number[] = [];
        while (pending.length) {
            if (++traversed > 100000) throw new Error("Dependency expansion exceeds 100000 item visits");
            const current = pending.pop()!;
            if (byId.get(current)!.kind === "work") work.push(current);
            else if (children.has(current)) pending.push(...children.get(current)!);
            else throw new Error(`Epic #${current} has no delivery children for its dependency`);
        }
        return work;
    };
    const predecessors = new Map(roadmap.items.map((item) => [item.issue, new Set<number>()]));
    const successors = new Map(roadmap.items.map((item) => [item.issue, new Set<number>()]));
    let edges = 0,
        expandedPairs = 0;
    const add = (before: number, after: number) => {
        if (before === after) throw new Error(`Self dependency at #${before}`);
        const fromItems = expand(before),
            toItems = expand(after);
        expandedPairs += fromItems.length * toItems.length;
        if (expandedPairs > 10000) throw new Error("Expanded dependencies are limited to 10000 pairs");
        for (const from of fromItems)
            for (const to of toItems) {
                if (from === to)
                    throw new Error(`Dependency #${before} → #${after} overlaps its own delivery children`);
                if (predecessors.get(to)!.has(from)) continue;
                if (++edges > 10000) throw new Error("Expanded dependencies are limited to 10000 edges");
                predecessors.get(to)!.add(from);
                successors.get(from)!.add(to);
            }
    };
    for (const edge of roadmap.dependencies) add(edge.before, edge.after);
    for (const milestone of roadmap.milestones) {
        // Validate even terminal milestones that do not unlock any work.
        for (const issue of [...milestone.requires, ...milestone.unlocks]) expand(issue);
        if (milestone.requires.length * milestone.unlocks.length > 10000)
            throw new Error("Milestone dependency expansion is limited to 10000 pairs");
        for (const before of milestone.requires) for (const after of milestone.unlocks) add(before, after);
    }
    const remaining = new Map([...predecessors].map(([id, edges]) => [id, edges.size]));
    const ready = [...remaining].filter(([, n]) => n === 0).map(([id]) => id);
    let visited = 0;
    while (ready.length) {
        const current = ready.pop()!;
        visited++;
        for (const next of successors.get(current)!) {
            remaining.set(next, remaining.get(next)! - 1);
            if (remaining.get(next) === 0) ready.push(next);
        }
    }
    if (visited !== roadmap.items.length) throw new Error("Roadmap dependencies contain a cycle");
    if (!edges)
        diagnostics.push(
            "No execution dependencies were provided; work is treated as parallel for critical-path calculations.",
        );
    for (const item of roadmap.items) {
        if (item.state === "complete" && !item.acceptance && item.kind === "work")
            diagnostics.push(
                `Issue #${item.issue} is complete but has no explicit acceptance evidence; its remaining load is still estimated.`,
            );
        if (item.kind === "epic" && !children.has(item.issue))
            diagnostics.push(`Epic #${item.issue} has no delivery children.`);
    }
    const groups = new Map<string, number[]>();
    for (const item of roadmap.items) {
        const group = item.group ?? "ungrouped";
        groups.set(group, [...(groups.get(group) ?? []), item.issue]);
    }
    return {
        nodes: roadmap.items.map((item) => item.issue).sort((a, b) => a - b),
        predecessors,
        diagnostics,
        lanes: [...groups].map(([id, issues]) => ({ id, name: id, state: "active", issues, chains: [] })),
    };
}

function cells(line: string): string[] {
    const result: string[] = [];
    let cell = "",
        escaped = false,
        ticks = false;
    for (const char of line.trim().replace(/^\|/, "").replace(/\|$/, "")) {
        if (escaped) {
            cell += char;
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (char === "`") ticks = !ticks;
        if (char === "|" && !ticks) {
            result.push(cell.trim());
            cell = "";
        } else cell += char;
    }
    result.push(cell.trim());
    return result;
}
function references(value: string): number[] {
    if (!value || ["—", "-"].includes(value)) return [];
    const rest = value.replace(/#([1-9]\d*)/g, "").replace(/[\s,;]/g, "");
    if (rest) throw new Error(`Expected local GitHub references such as #12, #34; got ${value.slice(0, 100)}`);
    return [...new Set([...value.matchAll(/#([1-9]\d*)/g)].map((match) => id(Number(match[1]))))];
}
function parseTable(body: string, titles: ReadonlyMap<number, string>, config: RoadmapConfig): NormalizedRoadmap {
    const lines = body.split(/\r?\n/);
    let section = "",
        sectionLevel = 0,
        fenced = false,
        tables = 0;
    const items: RoadmapItem[] = [],
        dependencies: NormalizedRoadmap["dependencies"] = [];
    const columns = config.columns!;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!.trim();
        if (/^(```|~~~)/.test(line)) {
            fenced = !fenced;
            continue;
        }
        if (fenced) continue;
        const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
        if (heading) {
            if (!sectionLevel || heading[1]!.length <= sectionLevel || heading[2] === config.section) {
                section = heading[2]!;
                sectionLevel = heading[1]!.length;
            }
            continue;
        }
        if (config.section && section !== config.section) continue;
        if (!line.includes("|") || !lines[index + 1]?.includes("|")) continue;
        const headers = cells(line);
        if (!cells(lines[index + 1]!).every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
        if (!headers.includes(columns.issues)) continue;
        if (cells(lines[index + 1]!).length !== headers.length)
            throw new Error("Roadmap table separator has the wrong number of cells");
        if (++tables > 1) throw new Error("Multiple matching roadmap tables; select a unique section");
        if (new Set(headers).size !== headers.length) throw new Error("Duplicate roadmap column headings");
        for (const name of Object.values(columns))
            if (!headers.includes(name)) throw new Error(`Missing roadmap column ${name}`);
        index += 2;
        for (; index < lines.length && lines[index]!.trim().includes("|") && lines[index]!.trim(); index++) {
            const row = cells(lines[index]!);
            if (row.length !== headers.length)
                throw new Error(`Roadmap row ${index + 1} has the wrong number of cells`);
            const get = (key: keyof Columns) => (columns[key] ? row[headers.indexOf(columns[key]!)]! : "");
            const issues = references(get("issues"));
            if (!issues.length) throw new Error(`Roadmap row ${index + 1} has no issues`);
            if (items.length + issues.length > 1000) throw new Error("Roadmap is limited to 1000 items");
            const stateName = get("state"),
                kindName = get("kind");
            const state = stateName
                ? (config.states?.[stateName] ??
                  (["planned", "active", "complete"].includes(stateName) ? (stateName as WorkState) : undefined))
                : "planned";
            const kind = kindName
                ? (config.kinds?.[kindName] ??
                  (["work", "epic"].includes(kindName) ? (kindName as "work" | "epic") : undefined))
                : "work";
            if (!state) throw new Error(`Unmapped roadmap state ${stateName}`);
            if (!kind) throw new Error(`Unmapped roadmap kind ${kindName}`);
            const parents = references(get("parent"));
            if (parents.length > 1) throw new Error("An item can have only one parent epic");
            for (const issue of issues) {
                items.push({
                    issue,
                    title: get("title") || titles.get(issue) || "",
                    state,
                    kind,
                    ...(get("group") ? { group: get("group") } : {}),
                    ...(parents.length ? { parent: parents[0] } : {}),
                    ...(get("calibrationGroup") ? { calibrationGroup: cohort(get("calibrationGroup")) } : {}),
                    ...(get("acceptance") && !["—", "-"].includes(get("acceptance"))
                        ? { acceptance: { source: get("acceptance") } }
                        : {}),
                });
                for (const before of references(get("dependencies"))) dependencies.push({ before, after: issue });
            }
            if (items.length > 1000 || dependencies.length > 10000)
                throw new Error("Roadmap exceeds 1000 items or 10000 dependencies");
        }
        index--;
    }
    if (!tables) throw new Error("No roadmap table matches the configured section and columns");
    return { version: 1, items, dependencies, milestones: [] };
}
