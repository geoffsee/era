import { ACTION_COMPONENTS, type ActionRuntime, Inject, InjectableService } from "@terella/action-framework";

export const ERA_FETCH = "era.fetch";
export const ERA_CREDENTIAL = "era.credential";

export type TrackerRecord = {
    kind: "prediction" | "observation";
    subject: string;
    metric: string;
    value: number;
    model?: string;
    source?: string;
};

export type AccuracyReport = {
    repository: string;
    model: string;
    metric: string;
    count: number;
    mae: number;
    mmre: number | null;
    pred: number | null;
    scale: number | null;
};

export type EraFetch = (input: string, init?: RequestInit) => Promise<Response>;

@InjectableService({ singleton: false })
export class EraTrackerClient {
    constructor(
        @Inject(ACTION_COMPONENTS.actionRuntime)
        private readonly runtime: ActionRuntime,
        @Inject(ERA_FETCH)
        private readonly fetchImpl: EraFetch,
    ) {}

    async store(apiUrl: string, token: string, repository: string, records: readonly TrackerRecord[]): Promise<number> {
        const predictions = records.filter((record) => record.kind === "prediction");
        const observations = records.filter((record) => record.kind === "observation");
        let stored = 0;
        if (predictions.length > 0) {
            stored += await this.post(apiUrl, token, "/v1/predictions", {
                predictions: predictions.map((record) => ({
                    repository,
                    subject: record.subject,
                    model: record.model,
                    metric: record.metric,
                    predicted: record.value,
                })),
            });
        }
        if (observations.length > 0) {
            stored += await this.post(apiUrl, token, "/v1/observations", {
                observations: observations.map((record) => ({
                    repository,
                    subject: record.subject,
                    metric: record.metric,
                    actual: record.value,
                    source: record.source ?? "github-action",
                })),
            });
        }
        return stored;
    }

    async accuracy(apiUrl: string, token: string, repository: string): Promise<AccuracyReport[]> {
        const response = await this.fetchImpl(
            `${trimSlash(apiUrl)}/v1/accuracy?repository=${encodeURIComponent(repository)}`,
            { headers: auth(token) },
        );
        const body = await readBody<{ reports: AccuracyReport[] }>(response);
        return body.reports;
    }

    async comment(apiUrl: string, token: string, repository: string, pullRequest: number, body: string): Promise<void> {
        const response = await this.fetchImpl(
            `${trimSlash(apiUrl)}/repos/${repository}/issues/${pullRequest}/comments`,
            {
                method: "POST",
                headers: {
                    authorization: `Bearer ${token}`,
                    accept: "application/vnd.github+json",
                    "content-type": "application/json",
                },
                body: JSON.stringify({ body }),
            },
        );
        await readBody(response);
        this.runtime.info(`Commented on ${repository}#${pullRequest}.`);
    }

    private async post(apiUrl: string, token: string, path: string, payload: unknown): Promise<number> {
        const response = await this.fetchImpl(`${trimSlash(apiUrl)}${path}`, {
            method: "POST",
            headers: {
                ...auth(token),
                "content-type": "application/json",
            },
            body: JSON.stringify(payload),
        });
        const body = await readBody<{ stored: number }>(response);
        return body.stored;
    }
}

function auth(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
}

function trimSlash(url: string): string {
    return url.replace(/\/$/, "");
}

async function readBody<T>(response: Response): Promise<T> {
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `tracker responded ${response.status}`);
    return body;
}
