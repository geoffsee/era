import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { estimateRoadmap } from "./estimator.ts";
import { renderEstimate } from "./format.ts";
import { type HistoricalPullRequest, loadHistoricalData } from "./historical-data-repository.ts";
import { buildDependencyGraph, parseRoadmap } from "./roadmap.ts";

function history(thinkingTokens = 40_000): HistoricalPullRequest[] {
    return [
        {
            number: 1,
            title: "[E01.01] Previous",
            state: "MERGED",
            epic: 1,
            turns: 10,
            uncachedInputTokens: 100_000,
            cacheReadTokens: 800_000,
            totalInputTokens: 900_000,
            outputTokens: 100_000,
            thinkingTokens,
            totalTokens: 1_000_000,
            failedJobs: 0,
            successfulJobs: 1,
            cicdSeconds: 120,
        },
    ];
}

function tinyEstimate(extra: Partial<Parameters<typeof estimateRoadmap>[0]> = {}) {
    return estimateRoadmap({
        issueNumber: 9,
        issueTitle: "Roadmap",
        issueBody: "| T01 next | ready | — | #2 | |\n| C01 start | #2 | completion |",
        titles: new Map([[2, "[E02.01] Next"]]),
        history: history(),
        ...extra,
    });
}

describe("forecast scope integrity", () => {
    test("accepts #359 without changing gate IDs and retains milestones", async () => {
        const body = await Bun.file(join(import.meta.dir, "../test/fixtures/roadmap-359.md")).text();
        const titles = await Bun.file(join(import.meta.dir, "../test/fixtures/roadmap-359-titles.json")).json();
        const parsed = parseRoadmap(body);
        expect(parsed.gates.map((gate) => gate.id)).toEqual(["G01", "G02", "G03", "G04", "G05", "G06", "G07"]);
        expect(parsed.gates[1]?.requires).toContain("#339:arm64-cell");
        const data = await loadHistoricalData(join(import.meta.dir, "../test/fixtures/forecast-history"));
        const estimate = estimateRoadmap({
            issueNumber: 359,
            issueTitle: "Linux qualification",
            issueBody: body,
            titles: new Map(Object.entries(titles).map(([id, title]) => [Number(id), title as string])),
            history: data.pullRequests,
            reviewPool: data.reviewPool,
            authorOverhead: data.authorOverhead,
            infrastructureBilling: { kind: "public-standard" },
        });
        expect(estimate.childCount).toBe(18);
        expect(estimate.epicCount).toBe(7);
        expect(estimate.scopeDiagnostics.some((item) => item.includes("#339:arm64-cell"))).toBe(true);
        const report = renderEstimate(estimate, "geoffsee/rubix-kube");
        expect(report).toContain("Priced subtotal");
        expect(report).toContain("Unpriced");
        expect(report).not.toContain("Leaves still required");
        expect(report).not.toContain("| ACEM | Total_Cost |");
        expect(report).not.toContain("must be split");
        expect(estimate.allAgentTokens).toBeGreaterThan(estimate.rawTokens + estimate.reviewTokens);
    });

    test("expands an epic acceptance dependency through its children", () => {
        const parsed = parseRoadmap("| T01 build | ready | — | #10, #11, #12, #20 | |\n| G01 accepted | #10 | #20 |");
        const titles = new Map([
            [10, "[Epic E01] Runtime"],
            [11, "[E01.01] Provider"],
            [12, "[E01.02] Gaps"],
            [20, "Publish"],
        ]);
        const graph = buildDependencyGraph(parsed.lanes, parsed.gates, titles);
        expect(graph.predecessors.get(20)).toEqual(new Set([11, 12]));
        const released = parseRoadmap(
            "| T01 build | ready | — | #10, #11, #12, #20 | |\n| G01 start | #20 | #10:live-runs |",
        );
        const releasedGraph = buildDependencyGraph(released.lanes, released.gates, titles);
        expect(releasedGraph.predecessors.get(11)).toEqual(new Set([20]));
        expect(releasedGraph.predecessors.get(12)).toEqual(new Set([20]));
    });

    test("reports cycle-producing and unresolved dependencies", () => {
        const parsed = parseRoadmap(
            "| T01 build | ready | — | #1 → #2 | |\n| C01 backwards | #2 | #1 |\n| C02 missing | C99 | #2 |",
        );
        const graph = buildDependencyGraph(parsed.lanes, parsed.gates);
        expect(
            graph.diagnostics.some((item) => item.includes("cycle") && item.includes("#2") && item.includes("#1")),
        ).toBe(true);
        expect(graph.diagnostics.some((item) => item.includes("C99"))).toBe(true);
    });

    test("refuses missing issue titles instead of sizing nonexistent work", () => {
        expect(() => tinyEstimate({ titles: new Map() })).toThrow("Missing issue title for #2");
    });

    test("refuses ambiguous gate IDs and reports unknown unlocks", () => {
        expect(() =>
            parseRoadmap("| T01 next | ready | — | #1 | |\n| G01 a | #1 | completion |\n| G01 b | #1 | completion |"),
        ).toThrow("duplicate gate");
        const parsed = parseRoadmap("| T01 next | ready | — | #1 | |\n| G01 a | #1 | #99 |");
        expect(
            buildDependencyGraph(parsed.lanes, parsed.gates).diagnostics.some((row) => row.includes("Unlock #99")),
        ).toBe(true);
    });
});

describe("forecast accounting", () => {
    test("uses explicit remaining activity quantities and labor instead of default checkpoints", () => {
        const estimate = tinyEstimate({
            plan: {
                version: 1,
                source: "Owner planning review",
                work: { "2": { authorBlocks: 2, source: "Two remaining acceptance activities" } },
                humanActivities: [
                    { activity: "discovery-design", hours: 2, usdPerHour: 100 },
                    { activity: "implementation-operations", hours: 3, usdPerHour: 100 },
                    { activity: "coordination", hours: 1, usdPerHour: 100 },
                    { activity: "review", hours: 1, usdPerHour: 100 },
                    { activity: "integration-acceptance", hours: 2, usdPerHour: 100 },
                ],
            },
        });
        expect(estimate.rawTokens).toBe(2_000_000);
        expect(estimate.hitlCost).toBe(900);
        expect(estimate.humanHours).toBe(9);
        expect(estimate.costGaps.some((gap) => gap.category === "human-delivery")).toBe(false);
        expect(estimate.children[0]?.sizing.source).toContain("Two remaining acceptance");
    });

    test("sizes comparable work from named PRs with visible sample coverage", () => {
        const peers = [
            history()[0]!,
            {
                ...history()[0]!,
                number: 3,
                totalTokens: 3_000_000,
                uncachedInputTokens: 300_000,
                cacheReadTokens: 2_400_000,
                totalInputTokens: 2_700_000,
                outputTokens: 300_000,
            },
        ];
        const estimate = tinyEstimate({
            history: peers,
            plan: {
                version: 1,
                source: "Scope review",
                work: { "2": { authorBlocks: 1, comparablePrs: [3], source: "Same runtime adapter work" } },
            },
        });
        expect(estimate.rawTokens).toBe(3_000_000);
        expect(estimate.children[0]?.sizing).toMatchObject({
            basis: "comparables",
            sampleCount: 1,
            comparablePrs: [3],
        });
        const crossEpic = tinyEstimate({
            titles: new Map([[2, "[E01.02] Next"]]),
            history: [peers[0]!, { ...peers[1]!, epic: 2 }],
            plan: {
                version: 1,
                source: "Scope review",
                work: { "2": { authorBlocks: 1, comparablePrs: [1, 3], source: "Mixed relevant peers" } },
            },
        });
        expect(crossEpic.rawTokens).toBe(2_000_000);
    });

    test("closed issues remain estimated until acceptance evidence excludes them", () => {
        const closed = tinyEstimate({ issueStates: new Map([[2, "closed"]]) });
        expect(closed.childCount).toBe(1);
        expect(closed.scopeDiagnostics.some((item) => item.includes("closed") && item.includes("#2"))).toBe(true);
        const accepted = tinyEstimate({
            plan: {
                version: 1,
                source: "Acceptance audit",
                work: {
                    "2": { authorBlocks: 0, source: "Current-candidate receipt abc", accepted: true },
                },
            },
        });
        expect(accepted.childCount).toBe(0);
        expect(accepted.rawTokens).toBe(0);
        expect(accepted.reviewPoolTokens).toBe(0);
    });

    test("prices disjoint historical categories without charging reasoning twice", () => {
        const split = tinyEstimate();
        const unsplit = tinyEstimate({ history: history(0) });
        expect(split.llmCost).toBeCloseTo(2.04);
        expect(split.llmCost).toBeCloseTo(unsplit.llmCost);
        expect(split.illustrativeTokenCost).toBeCloseTo(unsplit.illustrativeTokenCost);
        const repriced = tinyEstimate({
            plan: {
                version: 1,
                source: "Future routing review",
                authorRateCard: {
                    model: "chosen-model",
                    currency: "USD",
                    asOf: "2026-10-05",
                    source: "Reviewed pricing reference",
                    provenance: "assumed",
                    inputPerToken: 1 / 1_000_000,
                    cacheReadPerToken: 0.1 / 1_000_000,
                    outputPerToken: 5 / 1_000_000,
                },
            },
        });
        expect(repriced.llmCost).toBeCloseTo(0.68);
    });

    test("prices a cache-only observation without requiring fresh input for legacy diagnostics", () => {
        const estimate = tinyEstimate({
            history: [
                {
                    ...history()[0]!,
                    uncachedInputTokens: 0,
                    cacheReadTokens: 1_000_000,
                    totalInputTokens: 1_000_000,
                    outputTokens: 0,
                    thinkingTokens: 0,
                },
            ],
        });
        expect(estimate.llmCost).toBeCloseTo(0.3);
        expect(Number.isFinite(estimate.literalLlmCost)).toBe(true);
    });

    test("includes measured author orchestration exactly once", () => {
        const estimate = tinyEstimate({
            authorOverhead: {
                uncachedInputTokens: 10_000,
                cacheReadTokens: 80_000,
                outputTokens: 10_000,
                totalTokens: 100_000,
                attributedAuthorTokens: 1_000_000,
            },
        });
        expect(estimate.authorOverheadTokens).toBeCloseTo(100_000);
        expect(estimate.authorOverheadCost).toBeCloseTo(0.204);
        expect(estimate.allAgentTokens).toBeCloseTo(1_100_000);
        expect(estimate.pricedSubtotalUsd).toBeCloseTo(estimate.llmCost + estimate.hitlCost + 0.204);
    });

    test("does not turn CI wall-clock spans into a billable quantity", () => {
        const unknown = tinyEstimate();
        expect(unknown.infraCost + unknown.reviewInfraCost).toBe(0);
        expect(unknown.costGaps.some((gap) => gap.category === "infrastructure")).toBe(true);
        const free = tinyEstimate({ infrastructureBilling: { kind: "public-standard" } });
        expect(free.infraCost).toBe(0);
        expect(free.costGaps.some((gap) => gap.category === "live-infrastructure")).toBe(true);
        const billable = tinyEstimate({
            infrastructureBilling: {
                kind: "billable",
                runnerMinutes: 60,
                usdPerMinute: 0.01,
                source: "Runner job plan",
            },
        });
        expect(billable.infraCost).toBeCloseTo(0.6);
    });

    test("allocates a shared review pool once and removes it when no work remains", () => {
        const reviewPool = {
            unattributedReviewTokens: 10_000,
            followupTokens: 0,
            reviewLoopTokens: 20_000,
            inheritedReviewTokens: 0,
            gaps: ["Review billing is assumed"],
            unmatchedReviews: [
                { reviewTokens: 20_000, pricedReviewTokens: 20_000, reviewCostUsd: 0.2, reviewCicdSeconds: 0 },
            ],
        };
        const estimate = tinyEstimate({ reviewPool });
        expect(estimate.reviewPoolTokens).toBe(10_000);
        expect(estimate.reviewPoolCost).toBeCloseTo(0.1);
        expect(estimate.costGaps.some((gap) => gap.category === "review-source")).toBe(true);
        const accepted = tinyEstimate({
            reviewPool,
            plan: {
                version: 1,
                source: "Acceptance receipt",
                work: {
                    "2": { authorBlocks: 0, accepted: true, source: "Current-candidate receipt" },
                },
            },
        });
        expect(accepted.reviewPoolTokens).toBe(0);
        expect(accepted.reviewPoolCost).toBe(0);
    });

    test("missing review observations and non-review labor stay visibly unpriced", () => {
        const estimate = tinyEstimate();
        expect(estimate.costGaps.some((gap) => gap.category === "agent-review")).toBe(true);
        expect(estimate.costGaps.some((gap) => gap.category === "human-delivery")).toBe(true);
        expect(estimate.costGaps.some((gap) => gap.category === "author-orchestration")).toBe(true);
        expect(estimate.costGaps.some((gap) => gap.category === "cache-writes")).toBe(true);
        expect(estimate.pricedSubtotalUsd).toBe(estimate.totalCost);
    });
});
