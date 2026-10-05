import { createLedger } from "../app/composition.ts";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { useContainer } from "@di-framework/core/container";
import { runCli } from "../cli/cli.ts";
import { AccuracyService, LEDGER } from "../services/accuracy-service.ts";
import { tokenBacktest } from "./backtest.ts";
import { handleRequest } from "../app/http.ts";
import { BunSqlDatabase } from "../persistence/sqlite.ts";
import { MemoryLedger } from "../repositories/ledger.ts";
import type { HistoricalPullRequest } from "../repositories/historical-data-repository.ts";

const TOKEN = "test-token";

describe("accuracy service", () => {
    test("resolves the ledger from the di-framework container and scores paired rows", async () => {
        const ledger = new MemoryLedger();
        useContainer().registerFactory(LEDGER, () => ledger, { singleton: false });
        const service = useContainer().resolve(AccuracyService);
        await service.recordPredictions([
            { repository: "acme/app", subject: "issue:1", model: "token-threshold", metric: "tokens", predicted: 100 },
            { repository: "acme/app", subject: "issue:2", model: "token-threshold", metric: "tokens", predicted: 200 },
        ]);
        await service.recordObservations([
            { repository: "acme/app", subject: "issue:1", metric: "tokens", actual: 80 },
            { repository: "acme/app", subject: "issue:2", metric: "tokens", actual: 100 },
        ]);
        const [report] = await service.accuracy("acme/app");
        expect(report?.count).toBe(2);
        expect(report?.mae).toBeCloseTo(60);
        expect(report?.mmre).toBeCloseTo(0.625);
        expect(report?.pred).toBeCloseTo(0.5);
        expect(report?.scale).toBeCloseTo(0.65);
    });

    test("keeps repositories separate", async () => {
        const ledger = new MemoryLedger();
        await ledger.savePredictions([
            {
                repository: "other/repo",
                subject: "issue:1",
                model: "token-threshold",
                metric: "tokens",
                predicted: 5,
                recordedAt: "2026-10-02T00:00:00.000Z",
            },
        ]);
        await ledger.saveObservations([
            {
                repository: "acme/app",
                subject: "issue:1",
                metric: "tokens",
                actual: 5,
                observedAt: "2026-10-02T00:00:00.000Z",
                source: "manual",
            },
        ]);
        expect(await ledger.pairs("acme/app")).toEqual([]);
        expect(await ledger.repositories()).toEqual(["acme/app", "other/repo"]);
    });
});

describe("sqlite ledger", () => {
    test("upserts predictions and joins them to observations", async () => {
        const ledger = createLedger(new BunSqlDatabase(new Database(":memory:")));
        await ledger.ensureSchema();
        await ledger.savePredictions([
            {
                repository: "acme/app",
                subject: "pr:9",
                model: "token-median",
                metric: "tokens",
                predicted: 10,
                recordedAt: "2026-10-02T00:00:00.000Z",
            },
        ]);
        await ledger.savePredictions([
            {
                repository: "acme/app",
                subject: "pr:9",
                model: "token-median",
                metric: "tokens",
                predicted: 12,
                recordedAt: "2026-10-02T01:00:00.000Z",
            },
        ]);
        await ledger.saveObservations([
            {
                repository: "acme/app",
                subject: "pr:9",
                metric: "tokens",
                actual: 18,
                observedAt: "2026-10-02T02:00:00.000Z",
                source: "historical-pr",
            },
        ]);
        expect(await ledger.predictions("acme/app")).toHaveLength(1);
        expect((await ledger.pairs("acme/app"))[0]?.predicted).toBe(12);
        expect((await ledger.pairs("acme/app"))[0]?.actual).toBe(18);
    });
});

describe("tracker api", () => {
    test("rejects missing tokens and stores a batch", async () => {
        const ledger = new MemoryLedger();
        const denied = await handleRequest(request("POST", "/v1/predictions", { predictions: [] }), {
            ledger,
            apiToken: TOKEN,
        });
        expect(denied.status).toBe(401);

        const stored = await handleRequest(
            authed("POST", "/v1/predictions", {
                predictions: [
                    {
                        repository: "acme/app",
                        subject: "issue:7",
                        model: "seeagent",
                        metric: "story_points",
                        predicted: 5,
                    },
                ],
            }),
            { ledger, apiToken: TOKEN },
        );
        expect(stored.status).toBe(200);
        expect(await stored.json()).toEqual({ stored: 1 });

        const health = await handleRequest(request("GET", "/health"), { ledger, apiToken: TOKEN });
        expect(health.status).toBe(200);
    });

    test("does not leak one request ledger into the next", async () => {
        const first = new MemoryLedger();
        const second = new MemoryLedger();
        await handleRequest(
            authed("POST", "/v1/observations", {
                observations: [{ repository: "acme/app", subject: "issue:1", metric: "tokens", actual: 3 }],
            }),
            { ledger: first, apiToken: TOKEN },
        );
        await handleRequest(
            authed("POST", "/v1/observations", {
                observations: [{ repository: "other/app", subject: "issue:1", metric: "tokens", actual: 9 }],
            }),
            { ledger: second, apiToken: TOKEN },
        );
        expect(await first.repositories()).toEqual(["acme/app"]);
        expect(await second.repositories()).toEqual(["other/app"]);
    });
});

describe("cli", () => {
    test("records a prediction, an observation, and prints accuracy", async () => {
        const ledger = new MemoryLedger();
        const lines: string[] = [];
        const io = {
            fetch: (input: string | URL | Request, init?: RequestInit) =>
                handleRequest(
                    input instanceof Request
                        ? input
                        : new Request(input instanceof URL ? input.toString() : input, init),
                    {
                        ledger,
                        apiToken: TOKEN,
                    },
                ),
            env: { ERA_API_URL: "https://tracker.test", ERA_API_TOKEN: TOKEN },
            stdout: (line: string) => lines.push(line),
            stderr: (line: string) => lines.push(line),
        };
        expect(
            await runCli(
                [
                    "predictions",
                    "--repository",
                    "acme/app",
                    "--subject",
                    "issue:4",
                    "--model",
                    "token-threshold",
                    "--metric",
                    "tokens",
                    "--value",
                    "100",
                ],
                io,
            ),
        ).toBe(0);
        expect(
            await runCli(
                [
                    "observations",
                    "--repository",
                    "acme/app",
                    "--subject",
                    "issue:4",
                    "--metric",
                    "tokens",
                    "--value",
                    "80",
                ],
                io,
            ),
        ).toBe(0);
        expect(await runCli(["accuracy", "--repository", "acme/app"], io)).toBe(0);
        expect(lines.at(-1)).toContain("token-threshold");
        expect(lines.at(-1)).toContain("0.800");
    });

    test("backtests token medians for any repository", async () => {
        const history: HistoricalPullRequest[] = [10, 20, 30].map((tokens, index) => ({
            number: index + 1,
            title: `change ${index}`,
            state: "MERGED",
            epic: null,
            turns: 1,
            uncachedInputTokens: tokens,
            cacheReadTokens: 0,
            totalInputTokens: tokens,
            outputTokens: 0,
            thinkingTokens: 0,
            totalTokens: tokens,
            failedJobs: 0,
            successfulJobs: 1,
            cicdSeconds: 1,
        }));
        const batch = tokenBacktest("acme/app", history, "2026-10-02T00:00:00.000Z");
        expect(batch.predictions.map((row) => row.predicted).sort((a, b) => a - b)).toEqual([15, 20, 25]);
        const ledger = new MemoryLedger();
        await ledger.savePredictions(batch.predictions);
        await ledger.saveObservations(batch.observations);
        useContainer().registerFactory(LEDGER, () => ledger, { singleton: false });
        const [report] = await useContainer().resolve(AccuracyService).accuracy("acme/app");
        expect(report?.model).toBe("token-median");
        expect(report?.count).toBe(3);
        expect(report?.scale).not.toBeNull();
    });
});

function request(method: string, path: string, body?: unknown): Request {
    return new Request(`https://tracker.test${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

function authed(method: string, path: string, body?: unknown): Request {
    const headers = new Headers(body === undefined ? undefined : { "content-type": "application/json" });
    headers.set("authorization", `Bearer ${TOKEN}`);
    return new Request(`https://tracker.test${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}
