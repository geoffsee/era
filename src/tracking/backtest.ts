import { isCalibrationSample, type HistoricalPullRequest } from "../historical-data-repository.ts";
import type { Observation, Prediction } from "./model.ts";
import { median } from "../theory.ts";

/** Leave-one-out token median, the calibration forecast a new child receives. */
export function tokenBacktest(
    repository: string,
    history: readonly HistoricalPullRequest[],
    now = new Date().toISOString(),
): {
    predictions: Prediction[];
    observations: Observation[];
} {
    const sample = history.filter(isCalibrationSample);
    if (sample.length < 2) throw new Error("backtest needs at least two merged pull requests with tokens");
    const predictions: Prediction[] = [];
    const observations: Observation[] = [];
    for (const pullRequest of sample) {
        const others = sample
            .filter((candidate) => candidate.number !== pullRequest.number)
            .map((candidate) => candidate.totalTokens);
        const subject = `pr:${pullRequest.number}`;
        predictions.push({
            repository,
            subject,
            model: "token-median",
            metric: "tokens",
            predicted: median(others),
            recordedAt: now,
        });
        observations.push({
            repository,
            subject,
            metric: "tokens",
            actual: pullRequest.totalTokens,
            observedAt: now,
            source: "historical-pr",
        });
    }
    return { predictions, observations };
}
