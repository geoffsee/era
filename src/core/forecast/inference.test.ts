import { describe, expect, test } from "bun:test";
import type { HistoricalPullRequest } from "../history/history.ts";
import type { ChildEstimate } from "./estimator.ts";
import {
    INFERENCE_LIMITS,
    type InferenceField,
    type NumericField,
    inferenceCandidates,
    inferenceItems,
    inferenceModelName,
    inferenceSchema,
    inferenceUserMessage,
    inferredPredictions,
    parseInferenceConfig,
    validateInferred,
} from "./inference.ts";

const calendarDays: NumericField = {
    name: "calendarDays",
    description: "Working days from start to merge",
    type: "number",
    unit: "days",
    minimum: 0,
};
const risk: InferenceField = {
    name: "risk",
    description: "Delivery risk",
    type: "enum",
    values: ["low", "medium", "high"],
};
const fields: InferenceField[] = [
    calendarDays,
    { name: "reviewRounds", description: "Review iterations before merge", type: "integer", minimum: 1, maximum: 10 },
    risk,
];

function pr(number: number, overrides: Partial<HistoricalPullRequest> = {}): HistoricalPullRequest {
    return {
        number,
        title: `[E01.0${number}] Task ${number}`,
        state: "MERGED",
        createdAt: "2026-09-01T00:00:00Z",
        mergedAt: `2026-09-0${number}T00:00:00Z`,
        epic: 1,
        turns: 1,
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        totalInputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        totalTokens: number * 1000,
        failedJobs: 0,
        successfulJobs: 1,
        cicdSeconds: 0,
        ...overrides,
    };
}

function child(issue: number, tokens = 1_000_000): ChildEstimate {
    return {
        issue,
        laneId: "T01",
        epic: null,
        tokens,
        storyPoints: 5,
        sizing: { basis: "repository-median", sampleCount: 1, comparablePrs: [], authorBlocks: 1, source: "test" },
    } as unknown as ChildEstimate;
}

describe("inference configuration", () => {
    test("normalizes valid fields and rejects invalid ones", () => {
        const parsed = parseInferenceConfig({ fields: [{ ...calendarDays, unit: " days " }, risk] });
        expect(parsed.fields[0]).toEqual({ ...calendarDays, unit: "days" });
        expect(parsed.fields[1]).toEqual(risk);
        for (const [config, message] of [
            [{ fields: [] }, "1–12 fields"],
            [{ fields: [{ name: "Issue", description: "x", type: "number" }], extra: 1 }, "unknown field extra"],
            [{ fields: [{ name: "issue", description: "x", type: "number" }] }, "reserved"],
            [{ fields: [calendarDays, calendarDays] }, "duplicated"],
            [{ fields: [{ name: "x", description: "x", type: "text" }] }, "number, integer or enum"],
            [{ fields: [{ name: "x", description: "x", type: "enum", values: ["one"] }] }, "distinct enum values"],
            [{ fields: [{ name: "x", description: "x", type: "number", minimum: 5, maximum: 1 }] }, "exceeds maximum"],
            [{ fields: [{ name: "x", description: "", type: "number" }] }, "description"],
        ] as const) {
            expect(() => parseInferenceConfig(config)).toThrow(message);
        }
    });

    test("builds a JSON schema requiring every field per item", () => {
        const schema = inferenceSchema(fields) as {
            properties: { items: { items: { required: string[]; properties: Record<string, unknown> } } };
        };
        expect(schema.properties.items.items.required).toEqual([
            "issue",
            "rationale",
            "calendarDays",
            "reviewRounds",
            "risk",
        ]);
        expect(schema.properties.items.items.properties.risk).toEqual({
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Delivery risk",
        });
        expect(schema.properties.items.items.properties.reviewRounds).toMatchObject({
            type: "integer",
            minimum: 1,
            maximum: 10,
        });
    });
});

describe("inference prompt", () => {
    test("lists merged history with dates and the deterministic estimate per item", () => {
        const items = inferenceItems([child(42)], new Map([[42, "Ship it"]]), { "42": ` ${"x".repeat(2000)} ` });
        expect(items[0]?.description).toHaveLength(INFERENCE_LIMITS.itemDescriptionChars);
        const message = inferenceUserMessage(
            fields,
            inferenceCandidates([pr(1), pr(2, { state: "OPEN" }), pr(3)]),
            items,
        );
        expect(message).toContain(
            "#3 [E01.03] Task 3 | merged 2026-09-03, 2.0 days open, 3,000 tokens, 0 CI failures, epic 1",
        );
        expect(message).toContain("#1 [E01.01] Task 1 | merged 2026-09-01, 0.0 days open, 1,000 tokens");
        expect(message).not.toContain("Task 2");
        expect(message.indexOf("#3 ")).toBeLessThan(message.indexOf("#1 "));
        expect(message).toContain("#42 Ship it | lane T01, repository-median, 1,000,000 tokens, 5 points");
        expect(message).toContain("- calendarDays (number in days, at least 0): Working days from start to merge");
        expect(message).toContain("- reviewRounds (integer, 1–10)");
        expect(message).toContain("- risk (one of low, medium, high)");
    });

    test("caps candidates to the newest merged pull requests", () => {
        const history = Array.from({ length: INFERENCE_LIMITS.candidates + 5 }, (_, index) =>
            pr(index + 1, { mergedAt: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}Z` }),
        );
        expect(inferenceCandidates(history)).toHaveLength(INFERENCE_LIMITS.candidates);
    });
});

describe("inferred output", () => {
    const items = inferenceItems([child(1), child(2)], new Map(), undefined);

    test("keeps only remaining items with values that satisfy their fields", () => {
        const inferred = validateInferred(
            {
                items: [
                    { issue: 2, calendarDays: 3.5, reviewRounds: 2, risk: "medium", rationale: " Like PR #1. " },
                    { issue: 2, calendarDays: 9, reviewRounds: 9, risk: "low", rationale: "duplicate" },
                    { issue: 1, calendarDays: -1, reviewRounds: 2.5, risk: "unknown", rationale: "all invalid" },
                    { issue: 7, calendarDays: 1, reviewRounds: 1, risk: "low", rationale: "not remaining" },
                    "garbage",
                ],
            },
            fields,
            items,
        );
        expect(inferred).toEqual([
            { issue: 2, values: { calendarDays: 3.5, reviewRounds: 2, risk: "medium" }, rationale: "Like PR #1." },
        ]);
        expect(validateInferred({ items: [{ issue: 1, calendarDays: 2 }] }, fields, items)).toEqual([
            { issue: 1, values: { calendarDays: 2 }, rationale: "No rationale returned by the model." },
        ]);
        expect(validateInferred("nope", fields, items)).toEqual([]);
    });

    test("records numeric fields as tracked predictions under the inference model", () => {
        const rows = inferredPredictions(
            "acme/app",
            {
                model: "claude-opus-5-5",
                fields,
                items: [{ issue: 2, values: { calendarDays: 3.5, risk: "medium" }, rationale: "r" }],
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, calls: 1 },
            },
            "2026-10-05T00:00:00.000Z",
        );
        expect(rows).toEqual([
            {
                repository: "acme/app",
                subject: "issue:2",
                model: "inference:claude-opus-5-5",
                metric: "calendarDays",
                predicted: 3.5,
                recordedAt: "2026-10-05T00:00:00.000Z",
            },
        ]);
        expect(inferenceModelName("weird model/name")).toBe("inference:weird-model/name");
        expect(inferenceModelName("@cf/meta/llama-3.3-70b-instruct-sd")).toBe(
            "inference:cf/meta/llama-3.3-70b-instruct-sd",
        );
    });
});
