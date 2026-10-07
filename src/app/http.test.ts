import { expect, test } from "bun:test";
import { useContainer } from "@di-framework/core/container";
import { env } from "../../test/cloudflare.ts";
import { createTestAccuracyService } from "../../test/helpers/accuracy.ts";
import { handleRequest, startWorker } from "../../test/helpers/http.ts";
import type { ForecastResponse } from "../core/forecast/forecast-contract.ts";
import worker from "./main.ts";
import { loadHistoricalData } from "./repositories/historical-data-repository.ts";
import { AccuracyService } from "./services/accuracy-service.ts";

const history = await loadHistoricalData(new URL("../../test/fixtures/forecast-history", import.meta.url).pathname);

test("fetch keeps protected routes behind the bearer guard when the path is disguised", async () => {
    const accuracyService = createTestAccuracyService();
    const body = JSON.stringify({
        predictions: [{ repository: "acme/app", subject: "issue:1", model: "test", metric: "tokens", predicted: 1 }],
    });
    const paths = [
        "/v1/predictions",
        "/v1/predictions/",
        "/auth/../v1/predictions",
        "/health/../v1/predictions",
        "//v1/predictions",
        "/v1//predictions",
        "/AUTH/cli/../v1/predictions",
        "/auth/%2e%2e%2fv1/predictions",
        "/v1/predictions%0a",
        "/health",
    ];
    for (const path of paths) {
        const response = await handleRequest(
            new Request(`https://era.test${path}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
            }),
            { accuracyService, apiToken: "test" },
        );
        expect(response.status).not.toBe(200);
    }
    const health = await handleRequest(new Request("https://era.test/health"), { accuracyService, apiToken: "test" });
    expect(health.status).toBe(200);
    expect(await accuracyService.repositories()).toEqual([]);
});

test("HTTP guard challenges credentials before reading a protected request body", async () => {
    const accuracyService = createTestAccuracyService();
    for (const authorization of [undefined, "Basic invalid", "Bearer invalid"]) {
        const request = new Request("https://era.test/v1/predictions", {
            method: "POST",
            headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
            body: '{"principal":{"claims":{"identity":{"kind":"admin"}}}',
        });
        const response = await handleRequest(request, { accuracyService, apiToken: "test" });
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain("Bearer");
        expect(request.bodyUsed).toBe(false);
    }
    expect(await accuracyService.repositories()).toEqual([]);
});

test("HTTP principals preserve repository scopes across interleaved authentication", async () => {
    const accuracyService = createTestAccuracyService();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
        release = resolve;
    });
    const deps = {
        accuracyService,
        apiToken: "test",
        verifyOidc: async (token: string) => {
            if (token === "slow.jwt.token") await pending;
            return { repository: token === "slow.jwt.token" ? "acme/one" : "acme/two" };
        },
    };
    const request = (token: string) =>
        new Request("https://era.test/v1/predictions", {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({
                predictions: [
                    { repository: "acme/two", subject: "issue:1", model: "test", metric: "tokens", predicted: 1 },
                ],
            }),
        });
    const first = handleRequest(request("slow.jwt.token"), deps);
    const second = await handleRequest(request("fast.jwt.token"), deps);
    release();
    expect(second.status).toBe(200);
    expect((await first).status).toBe(403);
    expect(await accuracyService.repositories()).toEqual(["acme/two"]);
});

test("the Worker builds its graph from bindings at startup and serves the decorated controllers", async () => {
    const accuracyService = createTestAccuracyService();
    env.API_TOKEN = "worker-test";
    try {
        await startWorker();
        const response = await worker.fetch(
            new Request("https://era.test/v1/predictions", {
                method: "POST",
                headers: { authorization: "Bearer worker-test", "content-type": "application/json" },
                body: JSON.stringify({
                    predictions: [
                        { repository: "acme/app", subject: "issue:7", model: "test", metric: "tokens", predicted: 7 },
                    ],
                }),
            }),
        );
        expect(response.status).toBe(200);
        expect((await accuracyService.predictions("acme/app"))[0]?.predicted).toBe(7);

        const container = useContainer();
        expect(container.resolve(AccuracyService)).toBe(container.resolve(AccuracyService));

        const login = await worker.fetch(new Request("https://era.test/auth/cli/verify"));
        expect(login.status).toBe(503);
        await worker.scheduled();
    } finally {
        env.API_TOKEN = undefined;
    }
});

test("a Workers AI binding serves in-context inference when no provider key is bound", async () => {
    const accuracyService = createTestAccuracyService();
    const runs: Array<{ model: string; inputs: Record<string, unknown> }> = [];
    env.API_TOKEN = "worker-test";
    env.AI = {
        run: async (model: string, inputs: Record<string, unknown>) => {
            runs.push({ model, inputs });
            return {
                response: JSON.stringify({ items: [{ issue: 2, calendarDays: 2, rationale: "Like PR #1." }] }),
                usage: { prompt_tokens: 120, completion_tokens: 30 },
            };
        },
    };
    try {
        await startWorker();
        const response = await worker.fetch(
            new Request("https://era.test/v1/estimates", {
                method: "POST",
                headers: { authorization: "Bearer worker-test", "content-type": "application/json" },
                body: JSON.stringify({
                    repository: "octo/example",
                    roadmap: {
                        number: 0,
                        title: "Roadmap",
                        body: "| T01 next | ready | — | #2 | |\n| G01 start | #2 | completion |",
                        titles: { "2": "Next task" },
                    },
                    history,
                    inference: {
                        fields: [
                            {
                                name: "calendarDays",
                                description: "Working days to merge",
                                type: "number",
                                unit: "days",
                            },
                        ],
                    },
                }),
            }),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as ForecastResponse;
        expect(body.inferred?.model).toBe("@cf/meta/llama-3.1-8b-instruct");
        expect(body.inferred?.items).toEqual([{ issue: 2, values: { calendarDays: 2 }, rationale: "Like PR #1." }]);
        expect(body.inferred?.usage).toEqual({ promptTokens: 120, completionTokens: 30, totalTokens: 150, calls: 1 });
        expect(runs).toHaveLength(1);
        expect(runs[0]!.model).toBe("@cf/meta/llama-3.1-8b-instruct");
        expect(JSON.stringify(runs[0]!.inputs.messages)).toContain("#2 Next task | lane T01");
        expect(await accuracyService.repositories()).toEqual([]);
    } finally {
        env.API_TOKEN = undefined;
        env.AI = undefined;
    }
});
