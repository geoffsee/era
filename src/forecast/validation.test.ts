import { expect, test } from "bun:test";
import type { HistoricalPullRequest } from "../repositories/historical-data-repository.ts";
import { chronologicalTokenValidation } from "./validation.ts";

function sample(number: number, tokens: number, createdAt: string, mergedAt: string): HistoricalPullRequest {
    return {
        number,
        title: "[E01.01] Task",
        epic: 1,
        state: "MERGED",
        turns: 1,
        createdAt,
        mergedAt,
        totalTokens: tokens,
        uncachedInputTokens: tokens,
        cacheReadTokens: 0,
        totalInputTokens: tokens,
        outputTokens: 0,
        thinkingTokens: 0,
        failedJobs: 0,
        successfulJobs: 1,
        cicdSeconds: 0,
    };
}

const history = [
    sample(1, 100, "2026-01-01", "2026-01-02"),
    sample(2, 200, "2026-01-03", "2026-01-04"),
    sample(3, 300, "2026-01-05", "2026-01-06"),
    sample(4, 400, "2026-01-07", "2026-01-08"),
];

test("chronological scores use actual tokens and only history merged before task creation", () => {
    const result = chronologicalTokenValidation(history);
    expect(result.rows).toEqual([
        {
            prNumber: 4,
            actualTokens: 400,
            repositoryPrediction: 200,
            analoguePrediction: 200,
            trainingPrs: [1, 2, 3],
            analogueSampleCount: 3,
            cutoff: "2026-01-07",
        },
    ]);
    expect(result.repositoryMedian).toMatchObject({ count: 1, maeTokens: 200, mmre: 0.5, pred: 1 });
    expect(result.skippedWarmup).toBe(3);
});

test("later outcomes and overlapping work cannot change an earlier prediction", () => {
    const later = sample(5, 999_999, "2026-01-09", "2026-01-10");
    const overlap = sample(6, 999_999, "2026-01-01", "2026-01-09");
    const before = chronologicalTokenValidation(history).rows[0]!;
    const after = chronologicalTokenValidation([...history, later, overlap]).rows.find((row) => row.prNumber === 4)!;
    expect(after).toEqual(before);
    expect(
        chronologicalTokenValidation(history.map((row) => (row.number === 4 ? { ...row, totalTokens: 800 } : row)))
            .rows[0]?.repositoryPrediction,
    ).toBe(before.repositoryPrediction);
});

test("missing and inconsistent dates are reported rather than admitted to training", () => {
    const bad = [
        { ...history[0]!, createdAt: undefined },
        sample(7, 100, "2026-01-10", "2026-01-09"),
        sample(8, 100, "invalid", "2026-01-09"),
    ];
    const result = chronologicalTokenValidation(bad);
    expect(result.skippedDates).toBe(3);
    expect(result.rows).toHaveLength(0);
    expect(result.repositoryMedian).toBeNull();
});

test("epic analogue baseline needs three historical peers and otherwise falls back", () => {
    const mixed = [
        ...history.map((row) => (row.number === 3 ? { ...row, epic: 2 } : row)),
        { ...sample(5, 500, "2026-01-09", "2026-01-10"), epic: 2 },
    ];
    const result = chronologicalTokenValidation(mixed);
    expect(result.rows[0]?.analogueSampleCount).toBe(0);
    expect(result.rows[0]?.analoguePrediction).toBe(result.rows[0]?.repositoryPrediction);
});
