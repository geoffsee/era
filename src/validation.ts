import { type HistoricalPullRequest, isCalibrationSample } from "./historical-data-repository.ts";
import { meanAbsoluteError, meanMagnitudeRelativeError, median, predictionWithin } from "./theory.ts";

export type TokenValidationScore = { count: number; maeTokens: number; mmre: number; pred: number };
export type ChronologicalValidation = {
    sampleCount: number;
    skippedDates: number;
    skippedWarmup: number;
    repositoryMedian: TokenValidationScore | null;
    epicMedian: TokenValidationScore | null;
    rows: Array<{
        prNumber: number;
        actualTokens: number;
        repositoryPrediction: number;
        analoguePrediction: number;
        trainingPrs: number[];
        analogueSampleCount: number;
        cutoff: string;
    }>;
};

/** Retrospective validation of final extracts, not a substitute for frozen prospective forecasts.
 * PR creation is the conservative prediction cutoff; overlapping or future merges cannot train it.
 */
export function chronologicalTokenValidation(history: readonly HistoricalPullRequest[]): ChronologicalValidation {
    const sample = history.filter(isCalibrationSample);
    const dated = sample
        .filter((row) => {
            const created = Date.parse(row.createdAt ?? "");
            const merged = Date.parse(row.mergedAt ?? "");
            return Number.isFinite(created) && Number.isFinite(merged) && merged >= created;
        })
        .sort((a, b) => Date.parse(a.createdAt!) - Date.parse(b.createdAt!) || a.number - b.number);
    const rows: ChronologicalValidation["rows"] = [];
    let skippedWarmup = 0;
    for (const target of dated) {
        const prior = dated.filter(
            (row) => row.number !== target.number && Date.parse(row.mergedAt!) < Date.parse(target.createdAt!),
        );
        if (prior.length < 3) {
            skippedWarmup += 1;
            continue;
        }
        const repositoryPrediction = median(prior.map((row) => row.totalTokens));
        const peers = target.epic === null ? [] : prior.filter((row) => row.epic === target.epic);
        const analogues = peers.length >= 3 ? peers : [];
        rows.push({
            prNumber: target.number,
            actualTokens: target.totalTokens,
            repositoryPrediction,
            analoguePrediction:
                analogues.length > 0 ? median(analogues.map((row) => row.totalTokens)) : repositoryPrediction,
            trainingPrs: prior.map((row) => row.number),
            analogueSampleCount: analogues.length,
            cutoff: target.createdAt!,
        });
    }
    const actual = rows.map((row) => row.actualTokens);
    const score = (predicted: number[]): TokenValidationScore | null =>
        rows.length === 0
            ? null
            : {
                  count: rows.length,
                  maeTokens: meanAbsoluteError(actual, predicted),
                  mmre: meanMagnitudeRelativeError(actual, predicted),
                  pred: predictionWithin(actual, predicted, 0.5),
              };
    return {
        sampleCount: sample.length,
        skippedDates: sample.length - dated.length,
        skippedWarmup,
        rows,
        repositoryMedian: score(rows.map((row) => row.repositoryPrediction)),
        epicMedian: score(rows.map((row) => row.analoguePrediction)),
    };
}
