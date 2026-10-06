import { expect, test } from "bun:test";
import { calculateForecast, parseForecastRequest } from "../../app/services/forecast-service.ts";
import type { LedgerPair } from "../tracking/model.ts";
import {
    ALIGNED_MODEL_SUFFIX,
    type CalibrationOverride,
    fitFactors,
    FORGETTING_HALF_LIFE_DAYS,
    GAMMA_EVIDENCE,
    overrideFrom,
    renderCalibration,
    calibrationSnapshotId,
} from "./calibration.ts";

const NOW = "2026-10-05T00:00:00.000Z";
const extract = { gammaPerPoint: 100, sampleCount: 10, lanes: ["T01", "T02"] };

function pair(overrides: Partial<LedgerPair> = {}): LedgerPair {
    return {
        repository: "octo/example",
        subject: "issue:1",
        model: "token-threshold",
        metric: "tokens",
        predicted: 100,
        actual: 200,
        observedAt: NOW,
        ...overrides,
    };
}

test("a handful of pairs does not move scale, and two fresh pairs blend with the unit extract", () => {
    const waiting = fitFactors(extract, [pair()], new Map(), NOW);
    expect(waiting.scale.identified).toBe(false);
    expect(waiting.scale.value).toBe(1);
    expect(waiting.scale.ledgerEvidence).toBe(1);

    const fitted = fitFactors(extract, [pair({ subject: "issue:1" }), pair({ subject: "issue:2" })], new Map(), NOW);
    expect(fitted.scale.identified).toBe(true);
    expect(fitted.scale.ledger).toBe(2);
    expect(fitted.scale.value).toBe(1.5);
    expect(fitted.lanes.T01?.identified).toBe(false);
    expect(fitted.lanes.T02?.value).toBe(1);
});

test("lane multipliers are residuals, so one lane does not stack on the global scale", () => {
    const pairs = [
        pair({ subject: "issue:1", actual: 400, lane: "T01" }),
        pair({ subject: "issue:2", actual: 400, lane: "T01" }),
        pair({ subject: "issue:3", actual: 100, lane: "T02" }),
        pair({ subject: "issue:4", actual: 100, lane: "T02" }),
    ];
    const fitted = fitFactors(extract, pairs, new Map(), NOW);
    expect(fitted.scale.ledger).toBe(2.5);
    expect(fitted.scale.value).toBe(2);
    expect(fitted.lanes.T01?.ledger).toBeCloseTo(1.6);
    expect(fitted.lanes.T01?.value).toBeCloseTo(1.3);
    expect(fitted.lanes.T02?.ledger).toBeCloseTo(0.4);
    expect(fitted.lanes.T02?.value).toBeCloseTo(0.7);
    expect(fitted.scale.value * fitted.lanes.T01!.value).toBeLessThan(4);
});

test("exponential forgetting keeps a stale ratio from identifying the scale", () => {
    const stale = new Date(Date.parse(NOW) - 4 * FORGETTING_HALF_LIFE_DAYS * 86_400_000).toISOString();
    const pairs = [
        pair({ subject: "issue:1", actual: 200 }),
        pair({ subject: "issue:2", actual: 1000, observedAt: stale }),
        pair({ subject: "issue:3", actual: 1000, observedAt: stale }),
        pair({ subject: "issue:4", actual: 1000, observedAt: stale }),
    ];
    const fitted = fitFactors(extract, pairs, new Map(), NOW);
    expect(fitted.scale.identified).toBe(false);
    expect(fitted.scale.value).toBe(1);
    expect(fitted.scale.ledgerEvidence).toBeLessThan(2);
});

test("gamma stays on the extract until several pairs, then blends, and aligned rows are not evidence", () => {
    const points = new Map(Array.from({ length: GAMMA_EVIDENCE }, (_, index) => [`issue:${index + 1}`, 5]));
    const rows = [...points.keys()].map((subject) => pair({ subject, predicted: 100, actual: 1_000 }));
    const waiting = fitFactors(extract, rows.slice(0, GAMMA_EVIDENCE - 1), points, NOW);
    expect(waiting.gamma.identified).toBe(false);
    expect(waiting.gamma.value).toBe(100);

    const fitted = fitFactors(
        extract,
        [...rows, pair({ subject: "issue:99", model: `token-threshold${ALIGNED_MODEL_SUFFIX}`, actual: 10_000 })],
        points,
        NOW,
    );
    expect(fitted.gamma.identified).toBe(true);
    expect(fitted.gamma.ledger).toBe(200);
    expect(fitted.gamma.value).toBe(137.5);
    expect(fitted.scale.ledger).toBe(10);
});

test("the same posterior keeps its snapshot id", () => {
    const fitted = fitFactors(extract, [pair(), pair({ subject: "issue:2" })], new Map(), NOW);
    expect(calibrationSnapshotId(fitted)).toBe(calibrationSnapshotId(fitted));
    expect(calibrationSnapshotId(fitted)).not.toBe(
        calibrationSnapshotId({ ...fitted, scale: { ...fitted.scale, value: 9 } }),
    );
});

test("the override hook scales aligned predictions and leaves the extract forecast in place", () => {
    const input = parseForecastRequest({
        repository: "octo/example",
        roadmap: {
            number: 9,
            title: "Roadmap",
            body: "| T01 next | ready | — | #2 | |\n| G01 start | #2 | completion |",
            titles: { "2": "Next task" },
        },
        history: {
            repository: "octo/example",
            pullRequests: [1, 2].map((number) => ({
                number,
                title: `PR ${number}`,
                state: "MERGED",
                epic: null,
                turns: 1,
                uncachedInputTokens: 100_000,
                cacheReadTokens: 800_000,
                totalInputTokens: 900_000,
                outputTokens: 100_000,
                thinkingTokens: 0,
                totalTokens: 1_000_000,
                failedJobs: 0,
                successfulJobs: 1,
                cicdSeconds: 0,
            })),
        },
    });
    const override: CalibrationOverride = overrideFrom({
        snapshotId: "cal_test",
        factors: fitFactors(extract, [pair(), pair({ subject: "issue:2", lane: "T09" })], new Map(), NOW),
    });
    const result = calculateForecast(input, NOW, override);
    const raw = result.predictions.find((row) => row.model === "token-threshold" && row.subject === "issue:2");
    const aligned = result.predictions.find(
        (row) => row.model === `token-threshold${ALIGNED_MODEL_SUFFIX}` && row.subject === "issue:2",
    );
    expect(raw?.predicted).toBe(result.estimate.rawTokens);
    expect(aligned?.predicted ?? 0).toBeCloseTo((raw?.predicted ?? 0) * override.scale);
    expect(raw?.snapshotId).toBe("cal_test");
    expect(aligned?.snapshotId).toBe("cal_test");
    expect(raw?.lane).toBe("T01");
    expect(result.report).toContain(renderCalibration(override).split("\n")[0]!);
    expect(result.calibrationSnapshot?.snapshotId).toBe("cal_test");
});
