#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { estimateRoadmap, type RoadmapEstimate } from "./estimator.ts";
import { loadRoadmapIssue } from "./github-data-repository.ts";
import { loadHistoricalData, loadHistoricalPullRequests } from "./historical-data-repository.ts";
import { tokenBacktest } from "./tracking/backtest.ts";
import type { AccuracyReport, Observation, Prediction } from "./tracking/model.ts";

type Io = {
    fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    env: Record<string, string | undefined>;
    stdout: (line: string) => void;
    stderr: (line: string) => void;
};

const HELP = `era tracks estimate accuracy for any owner/name repository.

  era predictions --repository owner/name --subject issue:1 --model token-threshold --metric tokens --value 100
  era observations --repository owner/name --subject issue:1 --metric tokens --value 120
  era accuracy --repository owner/name
  era repositories
  era ingest-history --repository owner/name --dir historical-data
  era backtest --repository owner/name --dir historical-data
  era record-estimate --repository owner/name [--body roadmap.md --history historical-data --titles titles.json]

ERA_API_URL and ERA_API_TOKEN select the Cloudflare tracker. --api and --token override them.
`;

export async function runCli(argv: string[], io: Io = defaultIo()): Promise<number> {
    const [command, ...rest] = argv;
    if (!command || command === "help" || command === "--help" || command === "-h") {
        io.stdout(HELP);
        return 0;
    }
    try {
        const flags = parseFlags(rest);
        const api = endpoint(flags, io.env);
        switch (command) {
            case "predictions":
                await post(api, io, "/v1/predictions", {
                    predictions: [predictionFromFlags(flags)],
                });
                io.stdout("Stored 1 prediction.");
                return 0;
            case "observations":
                await post(api, io, "/v1/observations", {
                    observations: [observationFromFlags(flags)],
                });
                io.stdout("Stored 1 observation.");
                return 0;
            case "accuracy": {
                const repository = required(flags, "repository");
                const body = await getJson<{ repository: string; reports: AccuracyReport[] }>(
                    api,
                    io,
                    `/v1/accuracy?repository=${encodeURIComponent(repository)}`,
                );
                io.stdout(renderAccuracy(body.reports));
                return 0;
            }
            case "repositories": {
                const body = await getJson<{ repositories: string[] }>(api, io, "/v1/repositories");
                io.stdout(body.repositories.length === 0 ? "No repositories yet." : body.repositories.join("\n"));
                return 0;
            }
            case "ingest-history": {
                const repository = required(flags, "repository");
                const history = await loadHistoricalPullRequests(required(flags, "dir"));
                const observations = history
                    .filter((pullRequest) => pullRequest.state === "MERGED" && pullRequest.totalTokens > 0)
                    .map(
                        (pullRequest): Observation => ({
                            repository,
                            subject: `pr:${pullRequest.number}`,
                            metric: "tokens",
                            actual: pullRequest.totalTokens,
                            observedAt: new Date().toISOString(),
                            source: "historical-pr",
                        }),
                    );
                const stored = await postBatches(api, io, "/v1/observations", "observations", observations);
                io.stdout(`Stored ${stored} observations for ${repository}.`);
                return 0;
            }
            case "backtest": {
                const repository = required(flags, "repository");
                const history = await loadHistoricalPullRequests(required(flags, "dir"));
                const batch = tokenBacktest(repository, history);
                await postBatches(api, io, "/v1/predictions", "predictions", batch.predictions);
                await postBatches(api, io, "/v1/observations", "observations", batch.observations);
                const body = await getJson<{ reports: AccuracyReport[] }>(
                    api,
                    io,
                    `/v1/accuracy?repository=${encodeURIComponent(repository)}`,
                );
                io.stdout(renderAccuracy(body.reports));
                return 0;
            }
            case "record-estimate": {
                const repository = required(flags, "repository");
                const estimate = await loadEstimate(repository, flags);
                const predictions = predictionsFromEstimate(repository, estimate);
                const stored = await postBatches(api, io, "/v1/predictions", "predictions", predictions);
                io.stdout(`Stored ${stored} predictions for ${repository} issue #${estimate.issueNumber}.`);
                return 0;
            }
            default:
                io.stderr(`Unknown command ${command}.\n${HELP}`);
                return 2;
        }
    } catch (error) {
        io.stderr(error instanceof Error ? error.message : "command failed");
        return 1;
    }
}

function predictionsFromEstimate(repository: string, estimate: RoadmapEstimate): Prediction[] {
    const recordedAt = new Date().toISOString();
    const rows: Prediction[] = [
        row(repository, `issue:${estimate.issueNumber}`, "token-threshold", "tokens", estimate.rawTokens, recordedAt),
        row(
            repository,
            `issue:${estimate.issueNumber}`,
            "token-threshold",
            "tokens_effective",
            estimate.effectiveTokens,
            recordedAt,
        ),
        row(repository, `issue:${estimate.issueNumber}`, "seeagent", "story_points", estimate.storyPoints, recordedAt),
        row(repository, `issue:${estimate.issueNumber}`, "acem", "usd", estimate.totalCost, recordedAt),
    ];
    for (const child of estimate.children) {
        rows.push(row(repository, `issue:${child.issue}`, "token-threshold", "tokens", child.tokens, recordedAt));
        rows.push(row(repository, `issue:${child.issue}`, "seeagent", "story_points", child.storyPoints, recordedAt));
    }
    return rows;
}

function row(
    repository: string,
    subject: string,
    model: string,
    metric: string,
    predicted: number,
    recordedAt: string,
): Prediction {
    return { repository, subject, model, metric, predicted, recordedAt };
}

async function loadEstimate(repository: string, flags: Map<string, string>): Promise<RoadmapEstimate> {
    const [owner, repo] = repository.split("/");
    if (!owner || !repo) throw new Error("repository must be owner/name");
    const history = await loadHistoricalData(flags.get("history") ?? "historical-data");
    if (flags.has("body") && flags.has("titles")) {
        const titles = new Map<number, string>(
            Object.entries(JSON.parse(readFileSync(flags.get("titles")!, "utf8")) as Record<string, string>).map(
                ([number, title]) => [Number(number), title],
            ),
        );
        return estimateRoadmap({
            issueNumber: Number(flags.get("issue") ?? "0"),
            issueTitle: flags.get("title") ?? "Roadmap",
            issueBody: readFileSync(flags.get("body")!, "utf8"),
            titles,
            history: history.pullRequests,
            reviewPool: history.reviewPool,
        });
    }
    const issue = await loadRoadmapIssue(owner, repo);
    return estimateRoadmap({
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueBody: flags.has("body") ? readFileSync(flags.get("body")!, "utf8") : issue.body,
        titles: issue.titles,
        history: history.pullRequests,
        reviewPool: history.reviewPool,
    });
}

function predictionFromFlags(flags: Map<string, string>): Prediction {
    return {
        repository: required(flags, "repository"),
        subject: required(flags, "subject"),
        model: required(flags, "model"),
        metric: required(flags, "metric"),
        predicted: numberFlag(flags, "value"),
        recordedAt: new Date().toISOString(),
    };
}

function observationFromFlags(flags: Map<string, string>): Observation {
    return {
        repository: required(flags, "repository"),
        subject: required(flags, "subject"),
        metric: required(flags, "metric"),
        actual: numberFlag(flags, "value"),
        observedAt: new Date().toISOString(),
        source: flags.get("source") ?? "manual",
    };
}

function renderAccuracy(reports: readonly AccuracyReport[]): string {
    if (reports.length === 0) return "No paired predictions and observations yet.";
    const lines = [
        "| Repository | Model | Metric | Pairs | MAE | MMRE | PRED(0.5) | Scale |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ];
    for (const report of reports) {
        lines.push(
            `| ${report.repository} | ${report.model} | ${report.metric} | ${report.count} | ${round(report.mae)} | ${report.mmre === null ? "" : round(report.mmre)} | ${report.pred === null ? "" : round(report.pred)} | ${report.scale === null ? "" : round(report.scale)} |`,
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

async function postBatches<T>(api: Endpoint, io: Io, path: string, field: string, rows: readonly T[]): Promise<number> {
    let stored = 0;
    for (let index = 0; index < rows.length; index += 500) {
        const chunk = rows.slice(index, index + 500);
        const body = await post(api, io, path, { [field]: chunk });
        stored += body.stored;
    }
    return stored;
}

async function post(api: Endpoint, io: Io, path: string, payload: unknown): Promise<{ stored: number }> {
    const response = await io.fetch(`${api.url}${path}`, {
        method: "POST",
        headers: headers(api.token),
        body: JSON.stringify(payload),
    });
    return readJson(response);
}

async function getJson<T>(api: Endpoint, io: Io, path: string): Promise<T> {
    const response = await io.fetch(`${api.url}${path}`, { headers: headers(api.token) });
    return readJson(response);
}

async function readJson<T>(response: Response): Promise<T> {
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `tracker responded ${response.status}`);
    return body;
}

function headers(token: string): Headers {
    return new Headers({
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
    });
}

type Endpoint = { url: string; token: string };

function endpoint(flags: Map<string, string>, env: Record<string, string | undefined>): Endpoint {
    const url = (flags.get("api") ?? env.ERA_API_URL ?? "").replace(/\/$/, "");
    const token = flags.get("token") ?? env.ERA_API_TOKEN ?? "";
    if (!url) throw new Error("Set ERA_API_URL or pass --api.");
    if (!token) throw new Error("Set ERA_API_TOKEN or pass --token.");
    return { url, token };
}

function parseFlags(argv: readonly string[]): Map<string, string> {
    const flags = new Map<string, string>();
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index]!;
        if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}`);
        const name = token.slice(2);
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
        flags.set(name, value);
        index += 1;
    }
    return flags;
}

function required(flags: Map<string, string>, name: string): string {
    const value = flags.get(name);
    if (!value) throw new Error(`--${name} is required`);
    return value;
}

function numberFlag(flags: Map<string, string>, name: string): number {
    const value = Number(required(flags, name));
    if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
    return value;
}

function defaultIo(): Io {
    return {
        fetch: globalThis.fetch,
        env: process.env,
        stdout: (line) => console.log(line),
        stderr: (line) => console.error(line),
    };
}

if (import.meta.main) {
    process.exit(await runCli(process.argv.slice(2)));
}
