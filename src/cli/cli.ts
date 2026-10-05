#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hashSecret } from "@di-framework/auth";
import { apiUrl, login } from "../auth/cli.ts";
import { type CredentialCache, credentialId, FileCredentialCache, MemoryCredentialCache } from "../auth/credentials.ts";
import type { BacktestResponse, ForecastRequest, ForecastResponse } from "../forecast/forecast-contract.ts";
import { loadRoadmapIssue } from "../repositories/github-data-repository.ts";
import { loadHistoricalData, loadHistoricalPullRequests } from "../repositories/historical-data-repository.ts";
import type { RoadmapConfig } from "../roadmap/roadmap-format.ts";
import type { AccuracyReport, Observation, Prediction } from "../tracking/model.ts";

type Io = {
    fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    env: Record<string, string | undefined>;
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    credentials?: CredentialCache;
    openBrowser?: (url: string) => Promise<void>;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
};

const HELP = `era tracks estimate accuracy for any owner/name repository.

  era login --repository owner/name --api https://your-worker [--no-browser]
  era logout [--repository owner/name]
  era tokens [--repository owner/name]
  era revoke-token --id TOKEN_ID [--repository owner/name]

  era roadmap validate --repository owner/name [--body roadmap.md --config era.config.json]

  era predictions --repository owner/name --subject issue:1 --model token-threshold --metric tokens --value 100
  era observations --repository owner/name --subject issue:1 --metric tokens --value 120
  era accuracy --repository owner/name
  era repositories
  era ingest-history --repository owner/name --dir historical-data
  era backtest --repository owner/name --dir historical-data
  era record-estimate --repository owner/name [--body roadmap.md --history historical-data --titles titles.json]
  era estimate --repository owner/name [--issue N] [--body roadmap.md --titles titles.json --history historical-data --plan forecast-plan.json]

ERA_API_URL and ERA_API_TOKEN select the Cloudflare tracker. --api and --token override them.
Saved login credentials are used when flags and environment variables are absent.
Roadmap commands load era.config.json from the current directory; --config selects another file.
estimate sends a snapshot to the authenticated Worker without recording predictions.
record-estimate calculates and records on the Worker. Dollar predictions use the versioned usd_subtotal metric.
`;

export async function runCli(argv: string[], io: Io = defaultIo()): Promise<number> {
    const [command, ...rest] = argv;
    if (!command || command === "help" || command === "--help" || command === "-h") {
        io.stdout(HELP);
        return 0;
    }
    try {
        if (command === "roadmap" && rest[0] !== "validate") throw new Error("Use era roadmap validate");
        const flags = parseFlags(command === "roadmap" ? rest.slice(1) : rest);
        const cache = io.credentials ?? new MemoryCredentialCache();
        const state = cache.read();
        const url = apiUrl(flags.get("api") ?? io.env.ERA_API_URL ?? state.activeApi ?? "");
        if (command === "login") {
            await login(url, required(flags, "repository"), cache, io, flags.has("no-browser"));
            return 0;
        }
        const repository = flags.get("repository") ?? state.activeRepository[url];
        const saved = repository ? state.credentials[credentialId(url, repository)] : undefined;
        const api = endpoint(flags, io.env, url, saved?.apiToken);
        switch (command) {
            case "roadmap": {
                const repository = required(flags, "repository");
                const roadmapConfig = loadRoadmapConfig(flags);
                const roadmap = await loadRoadmapSource(repository, flags, roadmapConfig);
                const result = await post(api, io, "/v1/roadmap-validations", { repository, roadmap, roadmapConfig });
                io.stdout(JSON.stringify(result, null, 2));
                return 0;
            }
            case "logout": {
                if (!api.token.startsWith("era_"))
                    throw new Error(
                        "Logout requires an ERA user token. Clear ERA_API_TOKEN for an admin or workflow credential.",
                    );
                const id = await hashSecret(api.token);
                const response = await io.fetch(`${api.url}/auth/tokens/${encodeURIComponent(id)}`, {
                    method: "DELETE",
                    headers: headers(api.token),
                    redirect: "error",
                    signal: AbortSignal.timeout(15000),
                });
                if (!response.ok && response.status !== 401) await readJson(response);
                // Remove only a matching saved credential; explicit overrides can target another account.
                for (const [key, value] of Object.entries(state.credentials))
                    if (key === credentialId(url, value.repository) && value.apiToken === api.token)
                        delete state.credentials[key];
                cache.write(state);
                io.stdout("Signed out.");
                return 0;
            }
            case "tokens": {
                let path = "/auth/tokens";
                for (;;) {
                    const response = await io.fetch(`${api.url}${path}`, {
                        headers: headers(api.token),
                        redirect: "error",
                        signal: AbortSignal.timeout(15000),
                    });
                    const result = await readJson<{
                        tokens: Array<{ id: string; repository: string; status: string; expiresAt: number }>;
                    }>(response);
                    for (const token of result.tokens)
                        io.stdout(
                            `${token.id}\t${token.repository}\t${token.status}\t${new Date(token.expiresAt * 1000).toISOString()}`,
                        );
                    const next = response.headers.get("link")?.match(/<([^>]+)>; rel="next"/)?.[1];
                    if (!next) break;
                    const nextUrl = new URL(next);
                    if (nextUrl.origin !== new URL(api.url).origin || nextUrl.pathname !== "/auth/tokens")
                        throw new Error("Invalid token pagination URL");
                    path = nextUrl.pathname + nextUrl.search;
                }
                return 0;
            }
            case "revoke-token": {
                const response = await io.fetch(`${api.url}/auth/tokens/${encodeURIComponent(required(flags, "id"))}`, {
                    method: "DELETE",
                    headers: headers(api.token),
                    redirect: "error",
                    signal: AbortSignal.timeout(15000),
                });
                if (!response.ok) await readJson(response);
                io.stdout("Token revoked.");
                return 0;
            }
            case "estimate": {
                const input = await loadForecastInput(required(flags, "repository"), flags);
                const result = await post<ForecastResponse>(api, io, "/v1/estimates", input);
                io.stdout(result.report);
                return 0;
            }
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
                const history = await loadHistoricalData(required(flags, "dir"));
                const body = await post<BacktestResponse>(api, io, "/v1/backtests", {
                    repository,
                    history,
                    record: true,
                    roadmapConfig: loadRoadmapConfig(flags),
                });
                io.stdout(renderAccuracy(body.reports));
                return 0;
            }
            case "record-estimate": {
                const repository = required(flags, "repository");
                const input = await loadForecastInput(repository, flags);
                if (input.roadmap.number <= 0)
                    throw new Error(
                        "record-estimate requires a real roadmap issue number; pass --issue for offline snapshots",
                    );
                const result = await post<ForecastResponse>(api, io, "/v1/estimates", { ...input, record: true });
                io.stdout(`Stored ${result.stored} predictions for ${repository} issue #${input.roadmap.number}.`);
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

function loadRoadmapConfig(flags: Map<string, string>): RoadmapConfig | undefined {
    const path = flags.get("config") ?? "era.config.json";
    if (!flags.has("config") && !existsSync(path)) return undefined;
    const config = JSON.parse(readFileSync(path, "utf8"));
    if (
        !config ||
        typeof config !== "object" ||
        Array.isArray(config) ||
        config.version !== 1 ||
        !config.roadmap ||
        Object.keys(config).some((key) => !["version", "roadmap"].includes(key))
    )
        throw new Error("ERA config must contain version: 1 and roadmap configuration");
    return config.roadmap as RoadmapConfig;
}

async function loadForecastInput(repository: string, flags: Map<string, string>): Promise<ForecastRequest> {
    const roadmapConfig = loadRoadmapConfig(flags);
    const roadmap = await loadRoadmapSource(repository, flags, roadmapConfig);
    const history = await loadHistoricalData(flags.get("history") ?? "historical-data");
    if (history.repository !== repository)
        throw new Error(`historical repository ${history.repository ?? "unavailable"} does not match ${repository}`);
    const plan = flags.has("plan") ? JSON.parse(readFileSync(flags.get("plan")!, "utf8")) : undefined;
    return { repository, history, plan, roadmap, roadmapConfig };
}

async function loadRoadmapSource(
    repository: string,
    flags: Map<string, string>,
    config?: RoadmapConfig,
): Promise<ForecastRequest["roadmap"]> {
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error("repository must be owner/name");
    const [owner, repo] = repository.split("/") as [string, string];
    if (flags.has("issue") && (!Number.isSafeInteger(Number(flags.get("issue"))) || Number(flags.get("issue")) <= 0))
        throw new Error("--issue must be a positive integer");
    if (flags.has("body") && (flags.has("titles") || (config && config.format !== "legacy"))) {
        return {
            number: Number(flags.get("issue") ?? "0"),
            title: flags.get("title") ?? "Roadmap",
            body: readFileSync(flags.get("body")!, "utf8"),
            titles: flags.has("titles") ? JSON.parse(readFileSync(flags.get("titles")!, "utf8")) : {},
        };
    }
    const issue = await loadRoadmapIssue(owner, repo, flags.has("issue") ? Number(flags.get("issue")) : undefined);
    return {
        number: issue.number,
        title: issue.title,
        body: flags.has("body") ? readFileSync(flags.get("body")!, "utf8") : issue.body,
        titles: Object.fromEntries(issue.titles),
        states: Object.fromEntries(issue.issueStates),
    };
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

async function post<T = { stored: number }>(api: Endpoint, io: Io, path: string, payload: unknown): Promise<T> {
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

function endpoint(
    flags: Map<string, string>,
    env: Record<string, string | undefined>,
    url: string,
    saved?: string,
): Endpoint {
    const token = flags.get("token") ?? env.ERA_API_TOKEN ?? saved ?? "";
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
        if (name === "no-browser") {
            flags.set(name, "true");
            continue;
        }
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
        credentials: new FileCredentialCache(),
        openBrowser: async (url) => {
            const command =
                process.platform === "darwin"
                    ? ["open", url]
                    : process.platform === "win32"
                      ? ["rundll32", "url.dll,FileProtocolHandler", url]
                      : ["xdg-open", url];
            await new Promise<void>((resolve, reject) => {
                const child = spawn(command[0]!, command.slice(1), { stdio: "ignore" });
                child.once("error", reject);
                child.once("close", (code) => (code === 0 ? resolve() : reject(new Error("Browser unavailable"))));
            });
        },
    };
}

if (import.meta.main) {
    process.exit(await runCli(process.argv.slice(2)));
}
