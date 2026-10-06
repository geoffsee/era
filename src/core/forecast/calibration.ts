import { complexityWeight } from "./theory.ts";
import type { LedgerPair, Prediction } from "../tracking/model.ts";

/** Ledger pairs lose half their weight after one sprint, so a workflow change is not averaged away. */
export const FORGETTING_HALF_LIFE_DAYS = 14;
/** A unit multiplier may leave the extract once about two effective pairs have arrived. */
export const MULTIPLIER_EVIDENCE = 2;
/** Prior precision of the extract's unit multiplier. Two fresh pairs can move the posterior. */
export const MULTIPLIER_PRIOR = 2;
/** Gamma shares the blend only after several recent pairs. Earlier fits chase noise. */
export const GAMMA_EVIDENCE = 6;
/** A pair newer than two half-lives still counts toward identifiability. */
const RECENT_WEIGHT = 0.25;

export const ALIGNED_MODEL_SUFFIX = ":aligned";

export type FactorPosterior = {
    value: number;
    /** Precision of the posterior. Ledger evidence alone, until the factor is identified. */
    evidence: number;
    extract: number;
    extractEvidence: number;
    ledger: number | null;
    ledgerEvidence: number;
    identified: boolean;
};

export type CalibrationFactors = {
    scale: FactorPosterior;
    gamma: FactorPosterior;
    lanes: Record<string, FactorPosterior>;
};

/** Applied inside calculateForecast. Unidentified multipliers stay at the extract. */
export type CalibrationOverride = {
    snapshotId: string;
    factors: CalibrationFactors;
    scale: number;
    /** Null keeps the extract's gamma. */
    gamma: number | null;
    lanes: Record<string, number>;
};

export type ExtractFactors = {
    gammaPerPoint: number;
    sampleCount: number;
    lanes: readonly string[];
};

export type StoredCalibration = {
    repository: string;
    snapshotId: string;
    factors: CalibrationFactors;
    updatedAt: string;
};

export function alignedModel(model: string): string {
    return `${model}${ALIGNED_MODEL_SUFFIX}`;
}

export function fitFactors(
    extract: ExtractFactors,
    pairs: readonly LedgerPair[],
    points: ReadonlyMap<string, number>,
    now: string,
): CalibrationFactors {
    const consumption = pairs.filter(isConsumptionPair);
    const scale = multiplierPosterior(consumption, now);
    const level = ledgerMean(consumption, now, (pair) => pair.actual / pair.predicted);
    const lanes: Record<string, FactorPosterior> = {};
    for (const lane of laneNames(extract.lanes, consumption)) {
        const inLane = consumption.filter((pair) => pair.lane === lane);
        lanes[lane] =
            level === null
                ? multiplierPosterior(inLane, now)
                : multiplierPosterior(inLane, now, (pair) => pair.actual / pair.predicted / level);
    }
    return {
        scale,
        gamma: gammaPosterior(extract, consumption, points, now),
        lanes,
    };
}

/** Observed story points override the raw SEEAgent prediction for the same subject. */
export function storyPointIndex(
    pairs: readonly LedgerPair[],
    predictions: readonly Pick<Prediction, "subject" | "model" | "metric" | "predicted">[],
): Map<string, number> {
    const points = new Map<string, number>();
    for (const row of predictions) {
        if (row.model === "seeagent" && row.metric === "story_points" && row.predicted > 0)
            points.set(row.subject, row.predicted);
    }
    for (const pair of pairs) {
        if (pair.metric === "story_points" && pair.actual > 0) points.set(pair.subject, pair.actual);
    }
    return points;
}

export function calibrationSnapshotId(factors: CalibrationFactors): string {
    const payload = JSON.stringify(factors);
    let high = 0x811c9dc5;
    let low = 0x01000193;
    for (let index = 0; index < payload.length; index++) {
        const code = payload.charCodeAt(index);
        high = Math.imul(high ^ code, 0x01000193);
        low = Math.imul(low ^ code, 0x811c9dc5);
    }
    return `cal_${hex(high)}${hex(low)}`;
}

export function overrideFrom(record: Pick<StoredCalibration, "snapshotId" | "factors">): CalibrationOverride {
    const lanes: Record<string, number> = {};
    for (const [lane, factor] of Object.entries(record.factors.lanes)) {
        if (factor.identified) lanes[lane] = factor.value;
    }
    return {
        snapshotId: record.snapshotId,
        factors: record.factors,
        scale: record.factors.scale.value,
        gamma: record.factors.gamma.identified ? record.factors.gamma.value : null,
        lanes,
    };
}

export function renderCalibration(override: CalibrationOverride): string {
    const lines = [
        "## Ledger calibration",
        "",
        `Snapshot \`${override.snapshotId}\`. Each factor is a precision-weighted blend of the usage extract and the prediction ledger. Ledger pairs lose half their weight every ${FORGETTING_HALF_LIFE_DAYS} days, so a model or workflow change can move the factors. A global scale and a per-lane multiplier are fit from about ${MULTIPLIER_EVIDENCE} effective pairs; gamma waits for ${GAMMA_EVIDENCE}. The figures above stay the unaligned extract. Aligned predictions are recorded under \`${ALIGNED_MODEL_SUFFIX}\` model names so accuracy can show whether the blend helps.`,
        "",
        "| Factor | Posterior | Extract | Ledger | Evidence |",
        "| --- | ---: | ---: | ---: | ---: |",
        factorRow("Global scale", override.factors.scale),
        factorRow("Gamma", override.factors.gamma),
        ...Object.entries(override.factors.lanes).map(([lane, factor]) => factorRow(`Lane ${lane}`, factor)),
        "",
    ];
    return lines.join("\n");
}

export function storedFactors(value: unknown): CalibrationFactors {
    const record = object(value);
    return {
        scale: posterior(record.scale, "scale"),
        gamma: posterior(record.gamma, "gamma"),
        lanes: laneMap(record.lanes),
    };
}

/** Age weight exp(−ln2 · days / half-life). Missing timestamps contribute nothing. */
export function forgettingWeight(observedAt: string, now: string): number {
    const observed = Date.parse(observedAt);
    const current = Date.parse(now);
    if (Number.isNaN(observed) || Number.isNaN(current)) return 0;
    const ageDays = Math.max(0, (current - observed) / 86_400_000);
    return Math.exp((-Math.LN2 * ageDays) / FORGETTING_HALF_LIFE_DAYS);
}

function multiplierPosterior(
    pairs: readonly LedgerPair[],
    now: string,
    value: (pair: LedgerPair) => number = (pair) => pair.actual / pair.predicted,
): FactorPosterior {
    return blendPosterior(1, MULTIPLIER_PRIOR, weighted(pairs, now, value), MULTIPLIER_EVIDENCE);
}

/** Unshrunk ledger mean. Lane factors are residuals against it, so they do not stack on the global scale. */
function ledgerMean(pairs: readonly LedgerPair[], now: string, value: (pair: LedgerPair) => number): number | null {
    const usable = weighted(pairs, now, value).filter((sample) => sample.weight > 0 && sample.value > 0);
    if (usable.filter((sample) => sample.weight >= RECENT_WEIGHT).length < MULTIPLIER_EVIDENCE) return null;
    return weightedMean(usable);
}

function gammaPosterior(
    extract: ExtractFactors,
    pairs: readonly LedgerPair[],
    points: ReadonlyMap<string, number>,
    now: string,
): FactorPosterior {
    const samples = pairs.flatMap((pair) => {
        const storyPoints = points.get(pair.subject);
        if (!storyPoints || storyPoints <= 0) return [];
        const weight = forgettingWeight(pair.observedAt, now);
        return [{ value: pair.actual / (storyPoints * complexityWeight(storyPoints)), weight }];
    });
    return blendPosterior(extract.gammaPerPoint, Math.max(0, extract.sampleCount), samples, GAMMA_EVIDENCE);
}

function blendPosterior(
    extract: number,
    extractEvidence: number,
    samples: readonly { value: number; weight: number }[],
    minimumLedger: number,
): FactorPosterior {
    const usable = samples.filter((sample) => sample.weight > 0 && Number.isFinite(sample.value) && sample.value > 0);
    const ledgerEvidence = roundEvidence(usable.reduce((total, sample) => total + sample.weight, 0));
    const recent = usable.filter((sample) => sample.weight >= RECENT_WEIGHT).length;
    const identified = recent >= minimumLedger && Number.isFinite(extract) && extract > 0;
    const ledger = identified ? roundValue(weightedMean(usable)) : null;
    const value =
        identified && ledger !== null
            ? roundValue((extractEvidence * extract + ledgerEvidence * ledger) / (extractEvidence + ledgerEvidence))
            : roundValue(extract);
    return {
        value,
        evidence: identified ? roundEvidence(extractEvidence + ledgerEvidence) : ledgerEvidence,
        extract: roundValue(extract),
        extractEvidence: roundEvidence(extractEvidence),
        ledger,
        ledgerEvidence,
        identified,
    };
}

function weighted(pairs: readonly LedgerPair[], now: string, value: (pair: LedgerPair) => number) {
    return pairs.map((pair) => ({ value: value(pair), weight: forgettingWeight(pair.observedAt, now) }));
}

function weightedMean(samples: readonly { value: number; weight: number }[]): number {
    const weight = samples.reduce((total, sample) => total + sample.weight, 0);
    return samples.reduce((total, sample) => total + sample.weight * sample.value, 0) / weight;
}

function isConsumptionPair(pair: LedgerPair): boolean {
    return (
        pair.metric === "tokens" &&
        !pair.model.endsWith(ALIGNED_MODEL_SUFFIX) &&
        pair.predicted > 0 &&
        pair.actual > 0 &&
        Number.isFinite(pair.predicted) &&
        Number.isFinite(pair.actual)
    );
}

function laneNames(extract: readonly string[], pairs: readonly LedgerPair[]): string[] {
    return [
        ...new Set([...extract, ...pairs.map((pair) => pair.lane)].filter((lane): lane is string => !!lane)),
    ].sort();
}

function factorRow(name: string, factor: FactorPosterior): string {
    const ledger = factor.ledger === null ? "—" : formatFactor(factor.ledger);
    const evidence = factor.identified
        ? `${factor.evidence.toFixed(1)} blended`
        : `${factor.ledgerEvidence.toFixed(1)} waiting`;
    return `| ${name} | ${formatFactor(factor.value)} | ${formatFactor(factor.extract)} | ${ledger} | ${evidence} |`;
}

function formatFactor(value: number): string {
    if (Math.abs(value) >= 100) return Math.round(value).toLocaleString("en-US");
    return value.toFixed(3);
}

function roundValue(value: number): number {
    if (!Number.isFinite(value)) return value;
    if (value === 0) return 0;
    return Number(value.toPrecision(6));
}

function roundEvidence(value: number): number {
    return Math.round(value * 1000) / 1000;
}

function hex(value: number): string {
    return (value >>> 0).toString(16).padStart(8, "0");
}

function posterior(value: unknown, label: string): FactorPosterior {
    const record = object(value);
    return {
        value: finite(record.value, `${label} value`),
        evidence: finite(record.evidence, `${label} evidence`),
        extract: finite(record.extract, `${label} extract`),
        extractEvidence: finite(record.extractEvidence, `${label} extract evidence`),
        ledger: record.ledger === null ? null : finite(record.ledger, `${label} ledger`),
        ledgerEvidence: finite(record.ledgerEvidence, `${label} ledger evidence`),
        identified: record.identified === true,
    };
}

function laneMap(value: unknown): Record<string, FactorPosterior> {
    const record = object(value ?? {});
    return Object.fromEntries(Object.entries(record).map(([lane, factor]) => [lane, posterior(factor, lane)]));
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("calibration factors are unreadable");
    return value as Record<string, unknown>;
}

function finite(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is not a finite number`);
    return value;
}
