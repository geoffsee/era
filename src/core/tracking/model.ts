export type Prediction = {
    repository: string;
    subject: string;
    model: string;
    metric: string;
    predicted: number;
    recordedAt: string;
};

export type Observation = {
    repository: string;
    subject: string;
    metric: string;
    actual: number;
    observedAt: string;
    source: string;
};

export type AccuracyReport = {
    repository: string;
    model: string;
    metric: string;
    count: number;
    mae: number;
    mmre: number | null;
    pred: number | null;
    /** Median of actual / predicted. Multiply the next forecast by this to correct bias. */
    scale: number | null;
};

export type ScoredPair = {
    repository: string;
    subject: string;
    model: string;
    metric: string;
    predicted: number;
    actual: number;
};

const REPOSITORY = /^[^/\s]+\/[^/\s]+$/;
const TOKEN = /^[A-Za-z0-9_.:/-]+$/;

export function assertRepository(value: string): string {
    if (!REPOSITORY.test(value)) throw new Error(`repository must be owner/name, got ${JSON.stringify(value)}`);
    return value;
}

export function assertToken(value: string, label: string): string {
    if (!TOKEN.test(value)) throw new Error(`${label} must match ${TOKEN.source}, got ${JSON.stringify(value)}`);
    return value;
}

export function assertFinite(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${label} must be a finite number`);
    }
    return value;
}

export function assertTimestamp(value: string | undefined, fallback: string): string {
    const timestamp = value ?? fallback;
    if (Number.isNaN(Date.parse(timestamp))) throw new Error(`timestamp is not ISO-8601: ${timestamp}`);
    return timestamp;
}
