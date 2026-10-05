import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { estimateRoadmap, SONNET_46 } from "./estimator.ts";
import { renderEstimate } from "./format.ts";
import {
    type HistoricalPullRequest,
    isCalibrationSample,
    loadHistoricalPullRequests,
} from "../repositories/historical-data-repository.ts";
import { buildDependencyGraph, parseRoadmap } from "../roadmap/roadmap.ts";
import {
    contextFactor,
    hitlCost,
    infraCost,
    llmCost,
    longestPath,
    meanAbsoluteError,
    meanMagnitudeRelativeError,
    median,
    negotiateEstimates,
    partitionCount,
    predictionWithin,
    revisionFactor,
    tokenSize,
    totalCost,
} from "./theory.ts";

const roadmapBody = await Bun.file(join(import.meta.dir, "../..", "test/fixtures/roadmap-263.md")).text();
const localHistoryTest = test.skipIf(
    !existsSync(join(import.meta.dir, "../../historical-data/pr_token_usage_dataset.json")) ||
        !existsSync(join(import.meta.dir, "../../historical-data/pr_cicd_dataset.json")),
);

describe("token bins", () => {
    test("maps loads onto the Smith Horn thresholds", () => {
        expect(tokenSize(0)).toBe("XS");
        expect(tokenSize(50_000)).toBe("XS");
        expect(tokenSize(50_001)).toBe("S");
        expect(tokenSize(100_000)).toBe("S");
        expect(tokenSize(100_001)).toBe("M");
        expect(tokenSize(200_000)).toBe("M");
        expect(tokenSize(200_001)).toBe("L");
        expect(tokenSize(400_000)).toBe("L");
        expect(tokenSize(400_001)).toBe("XL");
    });

    test("partitions only tasks above 4×10^5", () => {
        expect(partitionCount(400_000)).toBe(1);
        expect(partitionCount(400_001)).toBe(2);
        expect(partitionCount(800_000)).toBe(2);
        expect(partitionCount(800_001)).toBe(3);
    });
});

describe("SEEAgent negotiation", () => {
    test("publishes the conceded anchor rather than the mean or median of the opening round", () => {
        const opening = [13, 5, 5];
        const result = negotiateEstimates(opening);
        const mean = opening.reduce((sum, value) => sum + value, 0) / opening.length;
        expect(result.estimate).toBe(8);
        expect(result.estimate).not.toBe(mean);
        expect(result.estimate).not.toBe(median(opening));
        expect(result.rounds).toBe(1);
        expect(result.trace.at(-1)).toEqual([8, 8, 8]);
    });

    test("keeps the analogist when peers have no majority", () => {
        const result = negotiateEstimates([13, 1, 2]);
        expect(result.estimate).toBe(13);
        expect(result.estimate).not.toBe(median([13, 1, 2]));
    });

    test("stops immediately when the opening round already agrees", () => {
        const result = negotiateEstimates([5, 5, 5]);
        expect(result.estimate).toBe(5);
        expect(result.rounds).toBe(0);
    });
});

describe("ACEM and accuracy", () => {
    test("builds revision, context, and additive cost from the formulas", () => {
        expect(revisionFactor(0.2, 3)).toBeCloseTo(1.6);
        expect(contextFactor(0.5, 2, 4)).toBeCloseTo(1.25);
        const llm = llmCost({
            inputTokens: 1_000,
            outputTokens: 100,
            priceInPerToken: 0.01,
            priceOutPerToken: 0.02,
            revisionFactor: 1.6,
            contextFactor: 1.25,
        });
        const hitl = hitlCost({
            checkpoints: 2,
            reviewHours: 0.5,
            rejectionRate: 0.2,
            reworkHours: 1,
            hourlyRate: 100,
        });
        const infra = infraCost(3, 4);
        expect(llm).toBeCloseTo((1_000 * 0.01 + 100 * 0.02) * 1.6 * 1.25);
        expect(hitl).toBeCloseTo(2 * 0.5 * 100 + 0.2 * 1 * 100);
        expect(totalCost(llm, hitl, infra)).toBeCloseTo(llm + hitl + infra);
    });

    test("scores MAE, MMRE, and PRED(0.5)", () => {
        const actual = [3, 5];
        const predicted = [5, 5];
        expect(meanAbsoluteError(actual, predicted)).toBeCloseTo(1);
        expect(meanMagnitudeRelativeError(actual, predicted)).toBeCloseTo(1 / 3);
        expect(predictionWithin(actual, predicted, 0.5)).toBeCloseTo(0.5);
    });
});

describe("dependency load", () => {
    test("uses the heaviest path and ignores a shorter parallel branch", () => {
        const predecessors = new Map<number, Set<number>>([
            [1, new Set()],
            [2, new Set()],
            [3, new Set([2])],
        ]);
        const result = longestPath([1, 2, 3], predecessors, (node) => (node === 1 ? 10 : 4));
        expect(result.total).toBe(10);
        expect(result.path).toEqual([1]);
    });

    test("parses the roadmap lanes and keeps gate edges acyclic", () => {
        const parsed = parseRoadmap(roadmapBody);
        expect(parsed.lanes).toHaveLength(20);
        expect(parsed.gates.map((gate) => gate.id)).toEqual([
            "C01",
            "C02",
            "C03",
            "C04",
            "C05",
            "C06",
            "C07",
            "C08",
            "C09",
            "C10",
            "C11",
            "C12",
            "C12a",
            "C13",
            "C14",
            "C15",
            "C16",
            "C17",
        ]);
        expect(parsed.lanes[0]?.issues).toContain(1);
        expect(parsed.lanes[0]?.issues).toContain(18);
        expect(parsed.lanes[0]?.issues).not.toContain(19);

        const graph = buildDependencyGraph(parsed.lanes, parsed.gates);
        expect(graph.nodes).not.toContain(1);
        expect(graph.nodes).toContain(48);
        expect(graph.predecessors.get(49)).toEqual(new Set([48, 114]));
        expect(graph.predecessors.get(114)?.has(48)).toBe(false);
        expect(graph.predecessors.get(114)?.has(115)).toBe(false);
        expect(() => longestPath(graph.nodes, graph.predecessors, () => 1)).not.toThrow();
    });
});

describe("roadmap estimate", () => {
    test("prices one child from a one-pull-request history", () => {
        const history: HistoricalPullRequest[] = [
            {
                number: 1,
                title: "[E01.01] Historical",
                state: "MERGED",
                epic: 1,
                turns: 10,
                uncachedInputTokens: 100,
                cacheReadTokens: 900,
                totalInputTokens: 1_000,
                outputTokens: 10,
                thinkingTokens: 0,
                totalTokens: 1_010,
                failedJobs: 0,
                successfulJobs: 2,
                cicdSeconds: 60,
            },
        ];
        const estimate = estimateRoadmap({
            issueNumber: 9,
            issueTitle: "Tiny roadmap",
            issueBody: [
                "| Lane | State | Opens from | Membership, local sequence | Note |",
                "| --- | --- | --- | --- | --- |",
                "| T00 baseline | complete | — | #1 | done |",
                "| T01 next | ready | T00 | #2 | open |",
                "| Gate | Requires (AND) | Unlocks |",
                "| --- | --- | --- |",
                "| C01 start | #1 | #2 |",
            ].join("\n"),
            titles: new Map([[2, "[E02.01] Next"]]),
            history,
        });

        expect(estimate.childCount).toBe(1);
        expect(estimate.rawTokens).toBe(1_010);
        expect(estimate.effectiveTokens).toBe(1_010);
        expect(estimate.children[0]?.size).toBe("XS");
        expect(estimate.children[0]?.storyPoints).toBe(13);
        expect(estimate.llmCost).toBeCloseTo(0.00072);
        expect(estimate.literalLlmCost).toBeCloseTo(0.0045);
        expect(estimate.hitlCost).toBeCloseTo(75);
        expect(estimate.infraCost).toBe(0);
        expect(estimate.costGaps.some((gap) => gap.category === "infrastructure")).toBe(true);
        expect(estimate.totalCost).toBeCloseTo(
            estimate.llmCost +
                estimate.hitlCost +
                estimate.infraCost +
                estimate.reviewLlmCost +
                estimate.reviewInfraCost +
                estimate.reviewPoolCost,
        );
        expect(estimate.llmCost).toBeCloseTo(estimate.illustrativeTokenCost);
        expect(estimate.illustrativeTokenCost).toBeCloseTo(
            100 * SONNET_46.inputPerToken + 900 * SONNET_46.cacheReadPerToken + 10 * SONNET_46.outputPerToken,
        );
        expect(estimate.reviewLlmCost).toBe(0);
        expect(renderEstimate(estimate, "octo/example")).toContain("SEEAgent");
    });

    test("scales Codex review tokens without pricing earlier CI spans", () => {
        const history: HistoricalPullRequest[] = [
            {
                number: 1,
                title: "[E01.01] Historical",
                state: "MERGED",
                epic: 1,
                turns: 10,
                uncachedInputTokens: 100,
                cacheReadTokens: 900,
                totalInputTokens: 1_000,
                outputTokens: 10,
                thinkingTokens: 0,
                totalTokens: 1_010,
                failedJobs: 0,
                successfulJobs: 2,
                cicdSeconds: 60,
                reviewTokens: 505,
                pricedReviewTokens: 505,
                reviewCostUsd: 1.01,
                reviewCicdSeconds: 120,
            },
        ];
        const estimate = estimateRoadmap({
            issueNumber: 9,
            issueTitle: "Tiny roadmap",
            issueBody: [
                "| Lane | State | Opens from | Membership, local sequence | Note |",
                "| --- | --- | --- | --- | --- |",
                "| T00 baseline | complete | — | #1 | done |",
                "| T01 next | ready | T00 | #2 | open |",
                "| Gate | Requires (AND) | Unlocks |",
                "| --- | --- | --- |",
                "| C01 start | #1 | #2 |",
            ].join("\n"),
            titles: new Map([[2, "[E02.01] Next"]]),
            history,
            reviewPool: {
                unattributedReviewTokens: 101,
                followupTokens: 0,
                reviewLoopTokens: 606,
                inheritedReviewTokens: 0,
                gaps: [],
                unmatchedReviews: [],
            },
        });

        expect(estimate.children[0]?.tokens).toBe(1_010);
        expect(estimate.reviewTokens).toBeCloseTo(505);
        expect(estimate.reviewLlmCost).toBeCloseTo(1.01);
        expect(estimate.reviewPoolTokens).toBeCloseTo(101);
        expect(estimate.reviewPoolCost).toBeCloseTo(101 * (1.01 / 505));
        expect(estimate.reviewInfraCost).toBe(0);
        expect(estimate.totalCost).toBeGreaterThan(estimate.llmCost + estimate.hitlCost + estimate.infraCost);
    });

    test("uses the median review load when reviewed pull requests are missing from the author extract", () => {
        const history: HistoricalPullRequest[] = [
            {
                number: 1,
                title: "[E01.01] Historical",
                state: "MERGED",
                epic: 1,
                turns: 10,
                uncachedInputTokens: 100,
                cacheReadTokens: 900,
                totalInputTokens: 1_000,
                outputTokens: 10,
                thinkingTokens: 0,
                totalTokens: 1_010,
                failedJobs: 0,
                successfulJobs: 2,
                cicdSeconds: 60,
            },
        ];
        const estimate = estimateRoadmap({
            issueNumber: 9,
            issueTitle: "Tiny roadmap",
            issueBody: [
                "| Lane | State | Opens from | Membership, local sequence | Note |",
                "| --- | --- | --- | --- | --- |",
                "| T00 baseline | complete | — | #1 | done |",
                "| T01 next | ready | T00 | #2 | open |",
                "| Gate | Requires (AND) | Unlocks |",
                "| --- | --- | --- |",
                "| C01 start | #1 | #2 |",
            ].join("\n"),
            titles: new Map([[2, "[E02.01] Next"]]),
            history,
            reviewPool: {
                unattributedReviewTokens: 0,
                followupTokens: 0,
                reviewLoopTokens: 300,
                inheritedReviewTokens: 0,
                gaps: [],
                unmatchedReviews: [
                    { reviewTokens: 100, pricedReviewTokens: 100, reviewCostUsd: 2, reviewCicdSeconds: 60 },
                    { reviewTokens: 300, pricedReviewTokens: 300, reviewCostUsd: 6, reviewCicdSeconds: 180 },
                ],
            },
        });

        expect(estimate.calibration.medianReviewTokenRatio).toBe(0);
        expect(estimate.reviewTokens).toBe(200);
        expect(estimate.reviewLlmCost).toBeCloseTo(4);
        expect(estimate.reviewInfraCost).toBe(0);
    });

    localHistoryTest("estimates the October 2026 roadmap from the historical datasets", async () => {
        const history = await loadHistoricalPullRequests();
        const sample = history.filter(isCalibrationSample);
        expect(history).toHaveLength(177);
        expect(sample).toHaveLength(89);
        expect(median(sample.map((pullRequest) => pullRequest.totalTokens))).toBe(27_128_411);

        const estimate = estimateRoadmap({
            issueNumber: 263,
            issueTitle: "(Draft) Roadmap: October 2026",
            issueBody: roadmapBody,
            titles: roadmapTitles(),
            history,
        });

        expect(estimate.children.map((child) => child.issue)).toEqual([
            44, 46, 47, 48, 49, 50, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107,
            108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126,
        ]);
        expect(estimate.epicCount).toBe(17);
        expect(estimate.rawTokens).toBeGreaterThan(estimate.effectiveTokens);
        expect(estimate.criticalPath.at(-1)).toBe(126);
        expect(estimate.criticalPath.length).toBeGreaterThan(1);
        expect(estimate.children.find((child) => child.issue === 48)?.tokens).toBe(12_256_088);
        expect(estimate.children.find((child) => child.issue === 89)?.tokens).toBe(40_678_117.5);
        expect(estimate.children.every((child) => child.size === "XL")).toBe(true);
        expect(estimate.partitions).toBeGreaterThan(estimate.childCount);
        expect(estimate.totalCost).toBeCloseTo(
            estimate.llmCost +
                estimate.hitlCost +
                estimate.infraCost +
                estimate.reviewLlmCost +
                estimate.reviewInfraCost +
                estimate.reviewPoolCost,
        );
        expect(estimate.backtest.count).toBe(89);
        expect(estimate.backtest.pred).toBeGreaterThanOrEqual(0);
        expect(estimate.backtest.pred).toBeLessThanOrEqual(1);

        const markdown = renderEstimate(estimate, "geoffsee/rubix-kube");
        expect(markdown).toContain("geoffsee/rubix-kube#263");
        expect(markdown).toContain("| Token-threshold | Raw sprint load E_raw |");
        expect(markdown).toContain("| SEEAgent | Reconstructed negotiated story points E* |");
        expect(markdown).toContain("| Accounting | Priced subtotal |");
        expect(markdown).toContain("| T19 | #126 |");
    });
});

function roadmapTitles(): Map<number, string> {
    const titles = new Map<number, string>([
        [44, "[E04.03] Classify optional failures and expose lifecycle diagnostics"],
        [46, "[E05.02] Implement preflight reporting and owned host preparation"],
        [47, "[E05.03] Cover constrained hosts and external-runtime preflight"],
        [48, "[E06.01] Define the target and variant asset inventory"],
        [49, "[E06.02] Materialize owned dependency assets safely"],
        [50, "[E06.03] Implement optional and external-dependency asset selection"],
        [89, "[E19.02] Preserve all existing Portainer-owned objects"],
        [90, "[E19.03] Verify Portainer image acquisition and optional bootstrap"],
        [91, "[E20.01] Characterize and decide the D2K TLS client contract"],
        [92, "[E20.02] Implement D2K resources, credentials and enablement gates"],
        [93, "[E20.03] Verify authenticated D2K workloads and endpoint readiness"],
        [94, "[E21.01] Implement optional metrics HTTP serving and health route"],
        [95, "[E21.02] Implement certificate and component health collectors"],
        [96, "[E21.03] Provide Rust diagnostics and metric compatibility documentation"],
        [97, "[E22.01] Implement the local configuration API and socket access"],
        [98, "[E22.02] Protect concurrent edits and redacted secrets"],
        [99, "[E22.03] Implement config get/set/edit/validate/schema commands"],
        [100, "[E23.01] Build management CLI commands and artifact selection"],
        [101, "[E23.02] Implement host service definitions and lifecycle adapters"],
        [102, "[E23.03] Implement universal and minimal host install flows"],
        [103, "[E23.04] Build and consume target-specific offline install bundles"],
        [104, "[E24.01] Implement named container creation and runtime settings"],
        [105, "[E24.02] Implement API and workload port publication"],
        [106, "[E24.03] Implement named-instance status and persistence lifecycle"],
        [107, "[E25.01] Implement safe kubeconfig merge, backup and identity resolution"],
        [108, "[E25.02] Resolve published container endpoints and selective access cleanup"],
        [109, "[E25.03] Export D2K credentials and Docker client contexts"],
        [110, "[E26.01] Migrate legacy flags to versioned YAML safely"],
        [111, "[E26.02] Implement version-aware host and container upgrades"],
        [112, "[E26.03] Implement reset confirmation and scoped state cleanup"],
        [113, "[E26.04] Implement uninstall, purge and keep-config semantics"],
        [114, "[E27.01] Build the supported node artifact and variant matrix"],
        [115, "[E27.02] Package management binaries, archives and OCI manifests"],
        [116, "[E27.03] Attach checksums, provenance and license inventories"],
        [117, "[E27.04] Gate trusted publication and rehearse an upstream release update"],
        [118, "[E28.01] Qualify smoke, manifest tiers and selected conformance"],
        [119, "[E28.02] Qualify restart, ownership and failure recovery"],
        [120, "[E28.03] Publish platform coverage and sustained-soak evidence"],
        [121, "[E29.01] Establish matched Go and Rust performance baselines"],
        [122, "[E29.02] Profile and address measured budget regressions"],
        [123, "[E29.03] Gate performance and sustained memory growth"],
        [124, "[E30.01] Validate supported Go-to-Rust state transition paths"],
        [125, "[E30.02] Rehearse migration failure and operator recovery"],
        [126, "[E30.03] Finalize operator documentation and qualified release evidence"],
    ]);
    for (const epic of [2, 3, 4, 5, 6, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]) {
        titles.set(epic, `[Epic E${String(epic).padStart(2, "0")}] tracker`);
    }
    return titles;
}
