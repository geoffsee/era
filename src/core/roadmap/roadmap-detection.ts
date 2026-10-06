import {
    type NormalizedRoadmap,
    parseRoadmapConfig,
    resolveRoadmap,
    type RoadmapConfig,
    type RoadmapItem,
} from "./roadmap-format.ts";

/**
 * Roadmap structure detection: a language model proposes either a markdown-table mapping or a
 * normalized roadmap for an issue body, and the proposal counts only if the real parser accepts it.
 * This module is pure; the Worker service owns the model call.
 */
export type DetectionConfidence = "high" | "medium" | "low";
export type DetectedRoadmap = {
    format: "markdown-table" | "normalized-json";
    roadmapConfig: RoadmapConfig;
    /** The normalized body to save when the format is normalized-json. */
    roadmap?: NormalizedRoadmap;
    items: RoadmapItem[];
    dependencies: NormalizedRoadmap["dependencies"];
    milestones: NormalizedRoadmap["milestones"];
    diagnostics: string[];
    rationale: string;
    confidence: DetectionConfidence;
};

export const DETECTION_LIMITS = { bodyChars: 60_000, titles: 300, outputTokens: 16000, attempts: 2 } as const;

const STATES = ["planned", "active", "complete"];
const KINDS = ["work", "epic"];
const column = { type: "string", minLength: 1 };

export const DETECTION_SCHEMA: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    required: ["format", "rationale", "confidence"],
    properties: {
        format: { type: "string", enum: ["markdown-table", "normalized-json"] },
        config: {
            type: "object",
            additionalProperties: false,
            required: ["columns"],
            properties: {
                section: { type: "string" },
                columns: {
                    type: "object",
                    additionalProperties: false,
                    required: ["issues"],
                    properties: {
                        issues: column,
                        title: column,
                        group: column,
                        state: column,
                        dependencies: column,
                        parent: column,
                        kind: column,
                        calibrationGroup: column,
                        acceptance: column,
                    },
                },
                states: { type: "object", additionalProperties: { type: "string", enum: STATES } },
                kinds: { type: "object", additionalProperties: { type: "string", enum: KINDS } },
            },
        },
        roadmap: {
            type: "object",
            additionalProperties: false,
            required: ["version", "items"],
            properties: {
                version: { type: "integer", const: 1 },
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["issue", "title"],
                        properties: {
                            issue: { type: "integer", minimum: 1 },
                            title: { type: "string", minLength: 1 },
                            kind: { type: "string", enum: KINDS },
                            state: { type: "string", enum: STATES },
                            group: { type: "string" },
                            parent: { type: "integer", minimum: 1 },
                        },
                    },
                },
                dependencies: {
                    type: "array",
                    items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["before", "after"],
                        properties: { before: { type: "integer", minimum: 1 }, after: { type: "integer", minimum: 1 } },
                    },
                },
                milestones: {
                    type: "array",
                    items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["id", "requires", "unlocks"],
                        properties: {
                            id: { type: "string", minLength: 1 },
                            requires: { type: "array", items: { type: "integer", minimum: 1 } },
                            unlocks: { type: "array", items: { type: "integer", minimum: 1 } },
                        },
                    },
                },
            },
        },
        rationale: { type: "string", minLength: 1 },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
};

export const DETECTION_SYSTEM_PROMPT = [
    "You detect the structure of a software roadmap written as a GitHub issue so a forecasting tool can parse it.",
    "Answer with exactly one of two shapes.",
    "",
    '1. format "markdown-table" with "config". Choose this when the body contains a Markdown table with a header row,',
    "a separator row, and data rows whose issue cell holds only GitHub references such as #12 or #12, #13.",
    "config.columns maps parser fields to the exact header text of the table: issues (required), and optionally title,",
    "group, state, dependencies, parent, kind, calibrationGroup, acceptance. Use each header text once.",
    "config.section is the exact heading text directly above the table; include it when the body has more than one table.",
    "config.states maps the table's literal state cell values to planned, active or complete; config.kinds maps literal",
    "kind cell values to work or epic. Cells that already say planned/active/complete or work/epic need no mapping.",
    "Dependency and parent cells must contain only #N references, be empty, or be a dash.",
    "",
    '2. format "normalized-json" with "roadmap". Choose this when there is no such table. Build one item per delivery',
    "issue the body references: issue is the number after #, title comes from the known titles or the body's wording,",
    "kind is epic for tracker issues that group children and work otherwise, parent is the epic an item belongs to,",
    "state follows status words in the body (default planned), group is the lane, phase or workstream name.",
    "dependencies are before/after pairs only where the body states an order (blocked by, after, phases in sequence).",
    "milestones are named gates with the issues they require and the issues they unlock.",
    "",
    "Rules: never invent issue numbers; use only numbers that appear in the body or the known titles. Prefer the table",
    "shape whenever a table qualifies. rationale is one or two sentences on what in the body decided the shape.",
    "Respond with JSON only, matching the provided schema; no prose and no Markdown fences.",
].join("\n");

export function detectionUserMessage(
    roadmap: { number: number; title: string; body: string },
    titles: ReadonlyMap<number, string>,
    previous?: { answer: unknown; error: string },
): string {
    const body = roadmap.body.slice(0, DETECTION_LIMITS.bodyChars);
    const referenced = new Set([...body.matchAll(/#([1-9]\d*)/g)].map((match) => Number(match[1])));
    const known = [...titles]
        .filter(([issue]) => referenced.size === 0 || referenced.has(issue))
        .slice(0, DETECTION_LIMITS.titles)
        .map(([issue, title]) => `#${issue} ${title}`);
    const lines = [
        `Roadmap issue #${roadmap.number}: ${roadmap.title}`,
        "",
        "Known issue titles (#number title):",
        ...(known.length ? known : ["(none)"]),
        "",
        "Roadmap body:",
        body,
    ];
    if (previous) {
        lines.push(
            "",
            `Your previous answer failed validation: ${previous.error}`,
            `Previous answer: ${JSON.stringify(previous.answer).slice(0, 4000)}`,
            "Return a corrected answer that the parser accepts.",
        );
    }
    return lines.join("\n");
}

/** Accept a proposal only when the real parser produces a roadmap from it. Throws the parser's message otherwise. */
export function applyDetection(raw: unknown, body: string, titles: ReadonlyMap<number, string>): DetectedRoadmap {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("detection must be a JSON object");
    const answer = raw as Record<string, unknown>;
    const rationale = typeof answer.rationale === "string" && answer.rationale.trim() ? answer.rationale.trim() : "";
    const confidence = (["high", "medium", "low"] as const).find((level) => level === answer.confidence) ?? "low";
    if (answer.format === "markdown-table") {
        const config = answer.config;
        if (!config || typeof config !== "object") throw new Error("markdown-table detection needs a config object");
        const { section, columns, states, kinds } = config as Record<string, unknown>;
        const roadmapConfig = parseRoadmapConfig({
            format: "markdown-table",
            ...(section !== undefined ? { section } : {}),
            columns,
            ...(states !== undefined && Object.keys(states as object).length ? { states } : {}),
            ...(kinds !== undefined && Object.keys(kinds as object).length ? { kinds } : {}),
            issueReferences: "github",
        });
        const resolved = resolveRoadmap(body, titles, roadmapConfig);
        return {
            format: "markdown-table",
            roadmapConfig,
            items: resolved.roadmap.items,
            dependencies: resolved.roadmap.dependencies,
            milestones: resolved.roadmap.milestones,
            diagnostics: resolved.graph.diagnostics,
            rationale: rationale || "A matching roadmap table was found.",
            confidence,
        };
    }
    if (answer.format === "normalized-json") {
        if (!answer.roadmap) throw new Error("normalized-json detection needs a roadmap object");
        const roadmapConfig: RoadmapConfig = { format: "normalized-json" };
        const resolved = resolveRoadmap(JSON.stringify(answer.roadmap), titles, roadmapConfig);
        return {
            format: "normalized-json",
            roadmapConfig,
            roadmap: resolved.roadmap,
            items: resolved.roadmap.items,
            dependencies: resolved.roadmap.dependencies,
            milestones: resolved.roadmap.milestones,
            diagnostics: resolved.graph.diagnostics,
            rationale: rationale || "The body has no qualifying table, so its items were normalized.",
            confidence,
        };
    }
    throw new Error("detection format must be markdown-table or normalized-json");
}
