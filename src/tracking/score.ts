import type { AccuracyReport, ScoredPair } from "./model.ts";
import { meanAbsoluteError, meanMagnitudeRelativeError, median, predictionWithin } from "../theory.ts";

export function scoreRepository(repository: string, pairs: readonly ScoredPair[]): AccuracyReport[] {
    const groups = new Map<string, ScoredPair[]>();
    for (const pair of pairs) {
        if (pair.repository !== repository) continue;
        const key = `${pair.model}\n${pair.metric}`;
        const group = groups.get(key) ?? [];
        group.push(pair);
        groups.set(key, group);
    }

    return [...groups.entries()]
        .map(([key, group]) => {
            const [model, metric] = key.split("\n");
            const comparable = group.filter((pair) => pair.actual !== 0);
            return {
                repository,
                model: model!,
                metric: metric!,
                count: group.length,
                mae: meanAbsoluteError(
                    group.map((pair) => pair.actual),
                    group.map((pair) => pair.predicted),
                ),
                mmre:
                    comparable.length === 0
                        ? null
                        : meanMagnitudeRelativeError(
                              comparable.map((pair) => pair.actual),
                              comparable.map((pair) => pair.predicted),
                          ),
                pred:
                    comparable.length === 0
                        ? null
                        : predictionWithin(
                              comparable.map((pair) => pair.actual),
                              comparable.map((pair) => pair.predicted),
                              0.5,
                          ),
                scale: comparable.length === 0 ? null : median(comparable.map((pair) => pair.actual / pair.predicted)),
            };
        })
        .sort((left, right) => left.model.localeCompare(right.model) || left.metric.localeCompare(right.metric));
}
