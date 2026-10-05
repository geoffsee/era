import { createTestAccuracyService } from "../../../test/helpers/accuracy.ts";
import { describe, expect, test } from "bun:test";
import { runCli } from "../../cli/cli.ts";
import { tokenBacktest } from "./backtest.ts";
import { handleRequest } from "../../../test/helpers/http.ts";
import type { HistoricalPullRequest } from "../../app/repositories/historical-data-repository.ts";

const TOKEN = "test-token";

describe("accuracy service", () => {
    test("resolves the forecast repository from the di-framework container and scores paired rows", async () => {
        const accuracyService = createTestAccuracyService();
        const service = accuracyService;
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
        const accuracyService = createTestAccuracyService();
        await accuracyService.recordPredictions([
            {
                repository: "other/repo",
                subject: "issue:1",
                model: "token-threshold",
                metric: "tokens",
                predicted: 5,
                recordedAt: "2026-10-02T00:00:00.000Z",
            },
        ]);
        await accuracyService.recordObservations([
            {
                repository: "acme/app",
                subject: "issue:1",
                metric: "tokens",
                actual: 5,
                observedAt: "2026-10-02T00:00:00.000Z",
                source: "manual",
            },
        ]);
        expect(await accuracyService.accuracy("acme/app")).toEqual([]);
        expect(await accuracyService.repositories()).toEqual(["acme/app", "other/repo"]);
    });
});

describe("sqlite forecast repository", () => {
    test("upserts predictions and joins them to observations", async () => {
        const accuracyService = createTestAccuracyService();
        await accuracyService.recordPredictions([
            {
                repository: "acme/app",
                subject: "pr:9",
                model: "token-median",
                metric: "tokens",
                predicted: 10,
                recordedAt: "2026-10-02T00:00:00.000Z",
            },
        ]);
        await accuracyService.recordPredictions([
            {
                repository: "acme/app",
                subject: "pr:9",
                model: "token-median",
                metric: "tokens",
                predicted: 12,
                recordedAt: "2026-10-02T01:00:00.000Z",
            },
        ]);
        await accuracyService.recordObservations([
            {
                repository: "acme/app",
                subject: "pr:9",
                metric: "tokens",
                actual: 18,
                observedAt: "2026-10-02T02:00:00.000Z",
                source: "historical-pr",
            },
        ]);
        expect(await accuracyService.predictions("acme/app")).toHaveLength(1);
        expect((await accuracyService.predictions("acme/app"))[0]?.predicted).toBe(12);
        expect((await accuracyService.observations("acme/app"))[0]?.actual).toBe(18);
        expect((await accuracyService.accuracy("acme/app"))[0]?.mae).toBe(6);
    });
});

describe("tracker api", () => {
    test("rejects missing tokens and stores a batch", async () => {
        const accuracyService = createTestAccuracyService();
        const denied = await handleRequest(request("POST", "/v1/predictions", { predictions: [] }), {
            accuracyService,
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
            { accuracyService, apiToken: TOKEN },
        );
        expect(stored.status).toBe(200);
        expect(await stored.json()).toEqual({ stored: 1 });

        const health = await handleRequest(request("GET", "/health"), { accuracyService, apiToken: TOKEN });
        expect(health.status).toBe(200);
    });

    test("does not leak one request forecast repository into the next", async () => {
        const first = createTestAccuracyService();
        const second = createTestAccuracyService();
        await handleRequest(
            authed("POST", "/v1/observations", {
                observations: [{ repository: "acme/app", subject: "issue:1", metric: "tokens", actual: 3 }],
            }),
            { accuracyService: first, apiToken: TOKEN },
        );
        await handleRequest(
            authed("POST", "/v1/observations", {
                observations: [{ repository: "other/app", subject: "issue:1", metric: "tokens", actual: 9 }],
            }),
            { accuracyService: second, apiToken: TOKEN },
        );
        expect(await first.repositories()).toEqual(["acme/app"]);
        expect(await second.repositories()).toEqual(["other/app"]);
    });
});

describe("cli", () => {
    test("records a prediction, an observation, and prints accuracy", async () => {
        const accuracyService = createTestAccuracyService();
        const lines: string[] = [];
        const io = {
            fetch: (input: string | URL | Request, init?: RequestInit) =>
                handleRequest(
                    input instanceof Request
                        ? input
                        : new Request(input instanceof URL ? input.toString() : input, init),
                    {
                        accuracyService,
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
        const accuracyService = createTestAccuracyService();
        await accuracyService.recordPredictions(batch.predictions);
        await accuracyService.recordObservations(batch.observations);
        const [report] = await accuracyService.accuracy("acme/app");
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

test("batch validation completes before any predictions are saved", async () => {
    const service = createTestAccuracyService();
    await expect(
        service.recordPredictions([
            { repository: "acme/app", subject: "issue:1", model: "test", metric: "tokens", predicted: 5 },
            { repository: "acme/app", subject: "issue:2", model: "test", metric: "tokens", predicted: "invalid" },
        ]),
    ).rejects.toThrow("predicted must");
    expect(await service.predictions("acme/app")).toEqual([]);
});
