import { createAccuracyService } from "../app/composition.ts";
import { createTestAccuracyService } from "../../test/helpers/accuracy.ts";
import { expect, test } from "bun:test";
import { handleRequest } from "../app/http.ts";
import { loadHistoricalData } from "../repositories/historical-data-repository.ts";
import type { ForecastResponse } from "./forecast-contract.ts";

const history = await loadHistoricalData(new URL("../../test/fixtures/forecast-history", import.meta.url).pathname);
const snapshot = {
    repository: "octo/example",
    roadmap: {
        number: 359,
        title: "Roadmap",
        body: "| T01 next | ready | — | #2 | |\n| G01 start | #2 | completion |",
        titles: { "2": "Next task" },
    },
    history,
};

function request(body: unknown, token = "test-token", path = "/v1/estimates") {
    return new Request(`https://worker.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
}

test("Worker calculates a JSON estimate and Markdown report without recording by default", async () => {
    const accuracyService = createTestAccuracyService();
    const response = await handleRequest(request(snapshot), { accuracyService, apiToken: "test-token" });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ForecastResponse;
    expect(result.estimate.rawTokens).toBe(1_000_000);
    expect(result.estimate.authorOverheadTokens).toBe(100_000);
    expect(result.estimate.calibration.labels["1"]).toBeGreaterThan(0);
    expect(result.report).toContain("Priced subtotal");
    expect(result.stored).toBe(0);
    expect(await accuracyService.predictions(snapshot.repository)).toEqual([]);
});

test("Worker records generated versioned predictions only when requested", async () => {
    const accuracyService = createTestAccuracyService();
    const response = await handleRequest(request({ ...snapshot, record: true }), {
        accuracyService,
        apiToken: "test-token",
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as ForecastResponse).stored).toBe(6);
    const rows = await accuracyService.predictions(snapshot.repository);
    expect(rows.find((row) => row.metric === "usd_subtotal")).toMatchObject({
        subject: "issue:359",
        model: "delivery-cost-v2",
    });
    expect(rows.some((row) => row.metric === "usd")).toBe(false);
});

test("Worker refuses foreign history, malformed snapshots and invalid calibration quantities", async () => {
    for (const body of [
        { ...snapshot, history: { ...history, repository: "other/repo" } },
        { ...snapshot, roadmap: { ...snapshot.roadmap, titles: {} } },
        { ...snapshot, roadmap: { ...snapshot.roadmap, body: "no gate table" } },
        { ...snapshot, record: "false" },
        {
            ...snapshot,
            roadmap: {
                ...snapshot.roadmap,
                body: "| T01 huge | ready | — | #1–#999999999 | |\n| G01 start | #1 | completion |",
            },
        },
        { ...snapshot, history: { ...history, pullRequests: [{ ...history.pullRequests[0], totalTokens: -1 }] } },
        { ...snapshot, history: { ...history, pullRequests: [history.pullRequests[0], history.pullRequests[0]] } },
    ]) {
        const accuracyService = createTestAccuracyService();
        const response = await handleRequest(request(body), { accuracyService, apiToken: "test-token" });
        expect(response.status).toBe(400);
        expect(typeof ((await response.json()) as { error: string }).error).toBe("string");
        expect(await accuracyService.repositories()).toEqual([]);
    }
});

test("Worker backtests and optionally records usage rather than requiring client-side calculation", async () => {
    const accuracyService = createTestAccuracyService();
    const observations = [1, 2, 3].map((scale, index) => ({
        ...history.pullRequests[0]!,
        number: index + 1,
        uncachedInputTokens: 100_000 * scale,
        cacheReadTokens: 800_000 * scale,
        totalInputTokens: 900_000 * scale,
        outputTokens: 100_000 * scale,
        totalTokens: 1_000_000 * scale,
        thinkingTokens: 40_000 * scale,
    }));
    const body = { repository: "octo/example", history: { ...history, pullRequests: observations } };
    const preview = await handleRequest(request(body, "test-token", "/v1/backtests"), {
        accuracyService,
        apiToken: "test-token",
    });
    expect(preview.status).toBe(200);
    const result = (await preview.json()) as {
        predictions: Array<{ predicted: number }>;
        reports: Array<{ count: number }>;
    };
    expect(result.predictions.map((row) => row.predicted).sort()).toEqual([1_500_000, 2_000_000, 2_500_000]);
    expect(result.reports[0]?.count).toBe(3);
    expect(await accuracyService.repositories()).toEqual([]);
    const stored = await handleRequest(request({ ...body, record: true }, "test-token", "/v1/backtests"), {
        accuracyService,
        apiToken: "test-token",
    });
    expect(stored.status).toBe(200);
    expect(((await stored.json()) as { stored: unknown }).stored).toEqual({ predictions: 3, observations: 3 });
});

test("calculation preserves valid local-extract quantities across the JSON boundary", async () => {
    const body = {
        ...snapshot,
        roadmap: {
            ...snapshot.roadmap,
            body: await Bun.file(new URL("../../test/fixtures/roadmap-359.md", import.meta.url)).text(),
            titles: await Bun.file(new URL("../../test/fixtures/roadmap-359-titles.json", import.meta.url)).json(),
        },
        plan: await Bun.file(new URL("../../test/fixtures/roadmap-359-central-plan.json", import.meta.url)).json(),
    };
    const response = await handleRequest(request(body), {
        accuracyService: createTestAccuracyService(),
        apiToken: "test-token",
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ForecastResponse;
    expect(result.estimate.childCount).toBe(18);
    expect(result.estimate.humanHours).toBe(108);
    expect(result.estimate.rawTokens).toBe(25_000_000);
});

test("estimate endpoint enforces authentication and repository-scoped OIDC", async () => {
    const accuracyService = createTestAccuracyService();
    expect((await handleRequest(request(snapshot, ""), { accuracyService, apiToken: "test-token" })).status).toBe(401);
    const response = await handleRequest(request(snapshot, "a.b.c"), {
        accuracyService,
        apiToken: "test-token",
        verifyOidc: async () => ({ repository: "other/repo" }),
    });
    expect(response.status).toBe(403);
    expect(await accuracyService.repositories()).toEqual([]);
});

test("invalid JSON and oversized bodies receive client errors", async () => {
    const accuracyService = createTestAccuracyService();
    for (const [body, status] of [
        ["{broken", 400],
        [" ".repeat(2 * 1024 * 1024 + 1), 413],
    ] as const) {
        const response = await handleRequest(
            new Request("https://worker.test/v1/estimates", {
                method: "POST",
                headers: { authorization: "Bearer test-token", "content-type": "application/json" },
                body,
            }),
            { accuracyService, apiToken: "test-token" },
        );
        expect(response.status).toBe(status);
    }
});

test("recording requires a real issue identity, while saved-snapshot calculation accepts zero", async () => {
    const accuracyService = createTestAccuracyService();
    const body = { ...snapshot, roadmap: { ...snapshot.roadmap, number: 0 } };
    expect((await handleRequest(request(body), { accuracyService, apiToken: "test-token" })).status).toBe(200);
    expect(
        (await handleRequest(request({ ...body, record: true }), { accuracyService, apiToken: "test-token" })).status,
    ).toBe(400);
    expect(await accuracyService.predictions(snapshot.repository)).toEqual([]);
});

test("storage failures return a server error without exposing database internals", async () => {
    const accuracyService = createAccuracyService({
        prepare() {
            throw new Error("SQL constraint must be present: private/path");
        },
    });
    const response = await handleRequest(request({ ...snapshot, record: true }), {
        accuracyService,
        apiToken: "test-token",
    });
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("SQL");
});

test("unsupported content type returns 415", async () => {
    const response = await handleRequest(
        new Request("https://worker.test/v1/estimates", {
            method: "POST",
            headers: { authorization: "Bearer test-token", "content-type": "text/plain" },
            body: "{}",
        }),
        { accuracyService: createTestAccuracyService(), apiToken: "test-token" },
    );
    expect(response.status).toBe(415);
});

test("backtest rejects nonfinite computed predictions before storing", async () => {
    const accuracyService = createTestAccuracyService();
    const huge = [1, 2, 3].map((number) => ({
        ...history.pullRequests[0]!,
        number,
        uncachedInputTokens: 1e308,
        cacheReadTokens: 0,
        totalInputTokens: 1e308,
        outputTokens: 0,
        thinkingTokens: 0,
        totalTokens: 1e308,
    }));
    const response = await handleRequest(
        request(
            { repository: "octo/example", history: { ...history, pullRequests: huge }, record: true },
            "test-token",
            "/v1/backtests",
        ),
        { accuracyService, apiToken: "test-token" },
    );
    expect(response.status).toBe(400);
    expect(await accuracyService.repositories()).toEqual([]);
});
