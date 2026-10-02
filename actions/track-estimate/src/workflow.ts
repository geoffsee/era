import { ACTION_COMPONENTS, type ActionRuntime, Inject, InjectableWorkflow } from "@terella/action-framework";
import { ERA_CREDENTIAL, EraTrackerClient, type AccuracyReport, type TrackerRecord } from "./tracker.ts";

export type EraGitHubContext = {
    readonly repo: { owner: string; repo: string };
    readonly pullRequestNumber?: number;
};

const MODES = new Set(["predict", "observe", "accuracy", "sync"]);

@InjectableWorkflow({ singleton: false })
export class TrackEstimateWorkflow {
    constructor(
        @Inject(ACTION_COMPONENTS.actionRuntime)
        private readonly runtime: ActionRuntime,
        @Inject(ACTION_COMPONENTS.githubContext)
        private readonly github: EraGitHubContext,
        @Inject(EraTrackerClient)
        private readonly tracker: EraTrackerClient,
        @Inject(ERA_CREDENTIAL)
        private readonly credential: string,
    ) {}

    async run(): Promise<void> {
        const apiUrl = this.runtime.getInput("api-url", { required: true });
        this.runtime.setSecret(this.credential);
        const mode = this.runtime.getInput("mode") || "sync";
        if (!MODES.has(mode)) throw new Error(`mode must be predict, observe, accuracy, or sync, got ${mode}`);

        const repository = this.runtime.getInput("repository") || `${this.github.repo.owner}/${this.github.repo.repo}`;
        const records = this.records();
        let stored = 0;
        if (mode === "predict" || mode === "observe" || (mode === "sync" && records.length > 0)) {
            stored = await this.tracker.store(apiUrl, this.credential, repository, records);
            this.runtime.info(`Stored ${stored} ${stored === 1 ? "row" : "rows"} for ${repository}.`);
        }

        let report = "";
        let scales: Array<{ model: string; metric: string; scale: number | null }> = [];
        if (mode === "accuracy" || mode === "sync") {
            const reports = await this.tracker.accuracy(apiUrl, this.credential, repository);
            report = renderReports(reports);
            scales = reports.map((item) => ({ model: item.model, metric: item.metric, scale: item.scale }));
            this.runtime.info(report);
            await this.runtime.summary.addRaw(report).write();
            await this.comment(repository, report);
        }

        this.runtime.setOutput("stored", String(stored));
        this.runtime.setOutput("report", report);
        this.runtime.setOutput("scales", JSON.stringify(scales));
    }

    private records(): TrackerRecord[] {
        const raw = this.runtime.getInput("records");
        if (raw.trim()) return parseRecords(raw, this.runtime.getInput("source") || "github-action");
        const mode = this.runtime.getInput("mode") || "sync";
        const value = this.runtime.getInput("value");
        if (!value) {
            if (mode === "predict" || mode === "observe") throw new Error("value is required");
            return [];
        }
        const kindInput = this.runtime.getInput("kind") || "observation";
        const kind = mode === "predict" ? "prediction" : mode === "observe" ? "observation" : kindInput;
        if (kind !== "prediction" && kind !== "observation") {
            throw new Error("kind must be prediction or observation");
        }
        const subject = this.subject();
        return [
            {
                kind,
                subject,
                metric: this.runtime.getInput("metric") || "tokens",
                value: finite(value),
                model: this.runtime.getInput("model") || "token-threshold",
                source: this.runtime.getInput("source") || "github-action",
            },
        ];
    }

    private subject(): string {
        const explicit = this.runtime.getInput("subject");
        if (explicit) return explicit;
        const pullRequest = this.runtime.getInput("pull-request") || String(this.github.pullRequestNumber ?? "");
        if (pullRequest) return `pr:${pullRequest}`;
        throw new Error("subject is required when there is no pull request");
    }

    private async comment(repository: string, report: string): Promise<void> {
        if (!this.runtime.getBooleanInput("comment") || !report) return;
        const token = this.runtime.getInput("github-token");
        const pullRequest = Number(this.runtime.getInput("pull-request") || this.github.pullRequestNumber || "");
        if (!token || !Number.isInteger(pullRequest)) {
            this.runtime.warning(
                "Skipped the pull request comment. github-token and a pull request number are required.",
            );
            return;
        }
        this.runtime.setSecret(token);
        const apiUrl = this.runtime.getInput("github-api-url") || "https://api.github.com";
        await this.tracker.comment(apiUrl, token, repository, pullRequest, report);
    }
}

function parseRecords(raw: string, source: string): TrackerRecord[] {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("records must be a non-empty JSON array");
    return parsed.map((item) => {
        if (typeof item !== "object" || item === null) throw new Error("each record must be an object");
        const record = item as Record<string, unknown>;
        const kind = record.kind;
        if (kind !== "prediction" && kind !== "observation")
            throw new Error("record kind must be prediction or observation");
        if (typeof record.subject !== "string" || typeof record.metric !== "string") {
            throw new Error("record subject and metric are required");
        }
        return {
            kind,
            subject: record.subject,
            metric: record.metric,
            value: finite(record.value),
            model: typeof record.model === "string" ? record.model : "token-threshold",
            source: typeof record.source === "string" ? record.source : source,
        };
    });
}

function finite(value: unknown): number {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) throw new Error(`value must be a finite number, got ${JSON.stringify(value)}`);
    return number;
}

export function renderReports(reports: readonly AccuracyReport[]): string {
    if (reports.length === 0) return "No paired predictions and observations yet.";
    const lines = [
        "| Model | Metric | Pairs | MAE | MMRE | PRED(0.5) | Scale |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ];
    for (const report of reports) {
        lines.push(
            `| ${report.model} | ${report.metric} | ${report.count} | ${round(report.mae)} | ${report.mmre === null ? "" : round(report.mmre)} | ${report.pred === null ? "" : round(report.pred)} | ${report.scale === null ? "" : round(report.scale)} |`,
        );
    }
    lines.push("");
    lines.push(
        "Scale is the median of actual / predicted. Multiply the next forecast for that model and metric by scale.",
    );
    return lines.join("\n");
}

function round(value: number): string {
    if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString("en-US");
    return value.toFixed(3);
}
