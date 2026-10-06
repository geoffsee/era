import { ScriptedChatModel } from "@di-framework/ai";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createTestAccuracyService } from "../../../test/helpers/accuracy.ts";
import { handleRequest } from "../../../test/helpers/http.ts";
import type { RoadmapDetectionResponse } from "../../core/forecast/forecast-contract.ts";

const tableBody = readFileSync(new URL("../../../examples/roadmaps/roadmap.md", import.meta.url), "utf8");
const tableConfig = JSON.parse(
    readFileSync(new URL("../../../examples/roadmaps/era.config.json", import.meta.url), "utf8"),
).roadmap;
const proseBody = [
    "# Storage roadmap",
    "",
    "Phase 1 (Platform): #12 defines the storage interface, then #13 implements the adapter on top of it.",
    "Phase 2 (Release): #14 qualifies the release once the adapter lands. #10 tracks the storage work as an epic.",
].join("\n");
const titles = {
    "10": "Storage delivery",
    "12": "Define the storage interface",
    "13": "Implement the storage adapter",
    "14": "Qualify the release",
};

function request(body: string, token = "test-token") {
    return new Request("https://worker.test/v1/roadmap-detections", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ repository: "octo/example", roadmap: { number: 359, title: "Roadmap", body, titles } }),
    });
}

function scripted(...replies: unknown[]) {
    return new ScriptedChatModel(
        replies.map((reply) => ({ respond: typeof reply === "string" ? reply : JSON.stringify(reply) })),
        { model: "scripted-model" },
    );
}

const tableAnswer = {
    format: "markdown-table",
    config: { section: tableConfig.section, columns: tableConfig.columns, states: tableConfig.states },
    rationale: "The Delivery plan table lists tickets with status and blockers.",
    confidence: "high",
};

test("a qualifying table becomes a parser-verified markdown-table configuration", async () => {
    const accuracyService = createTestAccuracyService();
    const chatModel = scripted(tableAnswer);
    const response = await handleRequest(request(tableBody), { accuracyService, apiToken: "test-token", chatModel });
    expect(response.status).toBe(200);
    const body = (await response.json()) as RoadmapDetectionResponse;
    expect(body.format).toBe("markdown-table");
    expect(body.roadmapConfig).toEqual({ ...tableConfig, format: "markdown-table" });
    expect(body.roadmap).toBeUndefined();
    expect(body.items.map((item) => [item.issue, item.state, item.group])).toEqual([
        [12, "complete", "Platform"],
        [13, "active", "Platform"],
        [14, "planned", "Release"],
    ]);
    expect(body.dependencies).toEqual([
        { before: 12, after: 13 },
        { before: 13, after: 14 },
    ]);
    expect(body.confidence).toBe("high");
    expect(body.model).toBe("scripted-model");
    expect(body.usage.calls).toBe(1);
    const prompt = chatModel.calls[0]!.messages.map((message) => message.text ?? "").join("\n");
    expect(prompt).toContain("Roadmap issue #359: Roadmap");
    expect(prompt).toContain("#12 Define the storage interface");
    expect(prompt).toContain("| Workstream | Description | Tickets |");
    expect(prompt).toContain('"enum":["markdown-table","normalized-json"]');
});

test("prose without a table becomes a normalized roadmap with defaults applied", async () => {
    const accuracyService = createTestAccuracyService();
    const response = await handleRequest(request(proseBody), {
        accuracyService,
        apiToken: "test-token",
        chatModel: scripted({
            format: "normalized-json",
            roadmap: {
                version: 1,
                items: [
                    { issue: 10, title: "Storage delivery", kind: "epic", group: "Platform" },
                    { issue: 12, title: "Define the storage interface", parent: 10, group: "Platform" },
                    { issue: 13, title: "Implement the storage adapter", parent: 10, group: "Platform" },
                    { issue: 14, title: "Qualify the release", group: "Release" },
                ],
                dependencies: [{ before: 12, after: 13 }],
                milestones: [{ id: "storage-ready", requires: [10], unlocks: [14] }],
            },
            rationale: "Two phases describe an order; no table exists.",
            confidence: "medium",
        }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as RoadmapDetectionResponse;
    expect(body.format).toBe("normalized-json");
    expect(body.roadmapConfig).toEqual({ format: "normalized-json" });
    expect(body.roadmap?.items[1]).toEqual({
        issue: 12,
        title: "Define the storage interface",
        parent: 10,
        group: "Platform",
        kind: "work",
        state: "planned",
    });
    expect(body.milestones).toEqual([{ id: "storage-ready", requires: [10], unlocks: [14] }]);
    expect(body.diagnostics).toEqual([]);
});

test("a proposal the parser rejects is sent back once with the error, then accepted", async () => {
    const accuracyService = createTestAccuracyService();
    const chatModel = scripted({ ...tableAnswer, config: { columns: { issues: "Issue numbers" } } }, tableAnswer);
    const response = await handleRequest(request(tableBody), { accuracyService, apiToken: "test-token", chatModel });
    expect(response.status).toBe(200);
    const body = (await response.json()) as RoadmapDetectionResponse;
    expect(body.usage.calls).toBe(2);
    expect(body.items).toHaveLength(3);
    const retry = chatModel.calls[1]!.messages.map((message) => message.text ?? "").join("\n");
    expect(retry).toContain(
        "Your previous answer failed validation: No roadmap table matches the configured section and columns",
    );
    expect(retry).toContain('"Issue numbers"');
});

test("two rejected proposals end as a client-visible 422 naming the parser error", async () => {
    const accuracyService = createTestAccuracyService();
    const empty = { format: "normalized-json", roadmap: { version: 1, items: [] }, rationale: "x", confidence: "low" };
    const response = await handleRequest(request(tableBody), {
        accuracyService,
        apiToken: "test-token",
        chatModel: scripted(empty, empty),
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toContain("Roadmap must contain at least one item");

    const garbled = await handleRequest(request(tableBody), {
        accuracyService,
        apiToken: "test-token",
        chatModel: scripted("not json at all"),
    });
    expect(garbled.status).toBe(503);
});

test("detection needs a configured model and an identity for the repository", async () => {
    const accuracyService = createTestAccuracyService();
    const unconfigured = await handleRequest(request(tableBody), { accuracyService, apiToken: "test-token" });
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ error: "Roadmap detection is not configured on this Worker" });

    const foreign = await handleRequest(request(tableBody, "a.b.c"), {
        accuracyService,
        apiToken: "test-token",
        chatModel: scripted(tableAnswer),
        verifyOidc: async () => ({ repository: "other/repo" }),
    });
    expect(foreign.status).toBe(403);
});
