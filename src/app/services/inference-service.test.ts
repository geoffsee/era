import { ScriptedChatModel } from "@di-framework/ai";
import { expect, test } from "bun:test";
import { createTestAccuracyService } from "../../../test/helpers/accuracy.ts";
import { handleRequest } from "../../../test/helpers/http.ts";
import type { ForecastResponse } from "../../core/forecast/forecast-contract.ts";
import type { InferenceConfig } from "../../core/forecast/inference.ts";
import { loadHistoricalData } from "../repositories/historical-data-repository.ts";

const history = await loadHistoricalData(new URL("../../../test/fixtures/forecast-history", import.meta.url).pathname);
const inference: InferenceConfig = {
    fields: [
        {
            name: "calendarDays",
            description: "Working days from start to merge",
            type: "number",
            unit: "days",
            minimum: 0,
        },
        { name: "risk", description: "Delivery risk", type: "enum", values: ["low", "medium", "high"] },
    ],
};
const snapshot = {
    repository: "octo/example",
    roadmap: {
        number: 359,
        title: "Roadmap",
        body: "| T01 next | ready | — | #2 | |\n| G01 start | #2 | completion |",
        titles: { "2": "Next task" },
        descriptions: { "2": "Wire the new provider behind the existing interface and add a smoke test." },
    },
    history,
    inference,
};
const reply = JSON.stringify({
    items: [{ issue: 2, calendarDays: 3, risk: "medium", rationale: "Scaled from PR #1, which merged in one day." }],
});

function request(body: unknown, token = "test-token") {
    return new Request("https://worker.test/v1/estimates", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
}

function scripted(text: string) {
    return new ScriptedChatModel([{ respond: text }], { model: "scripted-model" });
}

test("configured inference fields are inferred in context, reported and turned into predictions", async () => {
    const accuracyService = createTestAccuracyService();
    const chatModel = scripted(reply);
    const response = await handleRequest(request(snapshot), { accuracyService, apiToken: "test-token", chatModel });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ForecastResponse;
    expect(body.inferred).toEqual({
        model: "scripted-model",
        fields: inference.fields,
        items: [
            {
                issue: 2,
                values: { calendarDays: 3, risk: "medium" },
                rationale: "Scaled from PR #1, which merged in one day.",
            },
        ],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 1 },
    });
    expect(body.report).toContain("## In-context inferred estimates");
    expect(body.report).toContain("| #2 | 3 | medium | Scaled from PR #1, which merged in one day. |");
    expect(body.report).toContain("`inference:scripted-model`");
    expect(body.predictions).toContainEqual(
        expect.objectContaining({
            subject: "issue:2",
            model: "inference:scripted-model",
            metric: "calendarDays",
            predicted: 3,
        }),
    );
    expect(body.predictions.some((row) => row.metric === "risk")).toBe(false);
    expect(body.stored).toBe(0);

    const prompt = chatModel.calls[0]!;
    const text = prompt.messages.map((message) => message.text ?? "").join("\n");
    expect(text).toContain(
        "#1 [E01.01] Synthetic previous task | merged 2026-09-02, 1.0 days open, 1,000,000 tokens, 0 CI failures, epic 1",
    );
    expect(text).toContain("#2 Next task | lane T01, repository-median, 1,000,000 tokens");
    expect(text).toContain("Description: Wire the new provider behind the existing interface and add a smoke test.");
    expect(text).toContain("- risk (one of low, medium, high): Delivery risk");
    expect(text).toContain('"required":["issue","rationale","calendarDays","risk"]');
    expect(prompt.options?.maxTokens).toBe(16000);
    expect(prompt.options?.temperature).toBeUndefined();
});

test("recording stores inferred numeric predictions beside the deterministic ones", async () => {
    const accuracyService = createTestAccuracyService();
    const response = await handleRequest(request({ ...snapshot, record: true }), {
        accuracyService,
        apiToken: "test-token",
        chatModel: scripted(reply),
    });
    expect(response.status).toBe(200);
    const rows = await accuracyService.predictions("octo/example");
    expect(rows).toContainEqual(
        expect.objectContaining({
            subject: "issue:2",
            model: "inference:scripted-model",
            metric: "calendarDays",
            predicted: 3,
        }),
    );
    expect(rows.some((row) => row.model === "token-threshold")).toBe(true);
    expect(((await response.json()) as ForecastResponse).stored).toBe(rows.length);
});

test("unidentified snapshots report inferred values without producing predictions", async () => {
    const accuracyService = createTestAccuracyService();
    const response = await handleRequest(request({ ...snapshot, roadmap: { ...snapshot.roadmap, number: 0 } }), {
        accuracyService,
        apiToken: "test-token",
        chatModel: scripted(reply),
    });
    const body = (await response.json()) as ForecastResponse;
    expect(body.inferred?.items).toHaveLength(1);
    expect(body.predictions).toEqual([]);
});

test("values outside their field definition are dropped and the report says so", async () => {
    const accuracyService = createTestAccuracyService();
    const response = await handleRequest(request(snapshot), {
        accuracyService,
        apiToken: "test-token",
        chatModel: scripted(
            JSON.stringify({ items: [{ issue: 2, calendarDays: -4, risk: "unknown", rationale: "bad" }] }),
        ),
    });
    const body = (await response.json()) as ForecastResponse;
    expect(body.inferred?.items).toEqual([]);
    expect(body.report).toContain("The model returned no usable entries.");
    expect(body.predictions.some((row) => row.model.startsWith("inference:"))).toBe(false);
});

test("a Worker without a provider key refuses inference requests explicitly", async () => {
    const accuracyService = createTestAccuracyService();
    const response = await handleRequest(request(snapshot), { accuracyService, apiToken: "test-token" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "In-context inference is not configured on this Worker" });
    expect(await accuracyService.repositories()).toEqual([]);

    const plain = await handleRequest(request({ ...snapshot, inference: undefined }), {
        accuracyService,
        apiToken: "test-token",
    });
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as ForecastResponse).inferred).toBeUndefined();
});

test("provider failures and unusable replies become a retryable 503 without leaking details", async () => {
    const accuracyService = createTestAccuracyService();
    const response = await handleRequest(request({ ...snapshot, record: true }), {
        accuracyService,
        apiToken: "test-token",
        chatModel: scripted("this is not JSON"),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(JSON.stringify(await response.json())).not.toContain("JSON");
    expect(await accuracyService.predictions("octo/example")).toEqual([]);
});

test("invalid inference configuration is a client error", async () => {
    const accuracyService = createTestAccuracyService();
    const response = await handleRequest(
        request({ ...snapshot, inference: { fields: [{ name: "issue", description: "x", type: "number" }] } }),
        { accuracyService, apiToken: "test-token", chatModel: scripted(reply) },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("reserved");
});
