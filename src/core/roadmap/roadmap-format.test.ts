import { createTestAccuracyService } from "../../../test/helpers/accuracy.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../cli/cli.ts";
import { calculateForecast, parseForecastRequest } from "../../app/services/forecast-service.ts";
import { loadHistoricalData } from "../../app/repositories/historical-data-repository.ts";
import { parseRoadmapConfig, type RoadmapConfig, resolveRoadmap, roadmapHistory } from "./roadmap-format.ts";
import { handleRequest } from "../../../test/helpers/http.ts";

const config: RoadmapConfig = {
    format: "markdown-table",
    section: "Delivery plan",
    issueReferences: "github",
    columns: {
        issues: "Tickets",
        title: "Description",
        group: "Workstream",
        state: "Status",
        dependencies: "Blocked by",
        acceptance: "Evidence",
    },
    states: { Todo: "planned", Doing: "active", Done: "complete" },
};
const body = `# Delivery plan
| Status | Description | Tickets | Blocked by | Workstream | Evidence |
| --- | --- | --- | --- | --- | --- |
| Done | Ordinary task E99.1 | #2 | — | Core | — |
| Doing | Build \\| ship | #3 | #2 | Core | |
`;
const history = await loadHistoricalData(new URL("../../../test/fixtures/forecast-history", import.meta.url).pathname);
const normalized = {
    version: 1,
    items: [
        { issue: 10, title: "Platform", kind: "epic" },
        { issue: 2, title: "First", parent: 10, calibrationGroup: "core" },
        { issue: 3, title: "Second", parent: 10 },
        { issue: 4, title: "Release" },
    ],
    dependencies: [],
    milestones: [{ id: "ready", requires: [10], unlocks: [4] }],
};
const parse = (value: unknown) => resolveRoadmap(JSON.stringify(value), new Map(), { format: "normalized-json" });

function api(body: unknown, path = "/v1/roadmap-validations", token = "test") {
    return new Request(`https://worker.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
}

test("custom headings and reordered columns normalize without title conventions or gate tables", () => {
    const result = resolveRoadmap(body, new Map(), config);
    expect(result.roadmap.items).toMatchObject([
        { issue: 2, kind: "work", state: "complete", group: "Core" },
        { issue: 3, title: "Build | ship", kind: "work" },
    ]);
    expect(result.roadmap.items[0]!.calibrationGroup).toBeUndefined();
    expect(result.graph.predecessors.get(3)).toEqual(new Set([2]));
    expect(result.graph.diagnostics.join("\n")).toContain("no explicit acceptance evidence");
});

test("sections include nested headings but ignore code blocks and other sections", () => {
    const text = `# Example\n\`\`\`md\n${body}\n\`\`\`\n# Delivery plan\n## Tasks\n${body.split("\n").slice(1).join("\n")}\n# Elsewhere\n${body.split("\n").slice(1).join("\n")}`;
    expect(resolveRoadmap(text, new Map(), config).roadmap.items).toHaveLength(2);
    expect(() => resolveRoadmap(body + body, new Map(), config)).toThrow("Multiple matching");
});

test("custom formats fail clearly on unknown fields, states, missing columns and unsupported references", () => {
    expect(() => parseRoadmapConfig({ ...config, parser: "uploaded-code" })).toThrow("Unknown");
    expect(() => resolveRoadmap(body.replace("| Done |", "| Finished |"), new Map(), config)).toThrow("Unmapped");
    expect(() => resolveRoadmap(body.replace("Blocked by", "Dependency"), new Map(), config)).toThrow(
        "Missing roadmap column",
    );
    expect(() => resolveRoadmap(body.replace("#2 | —", "other/repo#2 | —"), new Map(), config)).toThrow(
        "Expected local GitHub",
    );
    expect(() => resolveRoadmap(body.replace("#3 | #2", "#2 | #2"), new Map(), config)).toThrow("Duplicate");
});

test("normalized relationships expand epic dependencies and preserve arbitrary milestone IDs", () => {
    const result = parse(normalized);
    expect(result.graph.predecessors.get(4)).toEqual(new Set([2, 3]));
    expect(result.roadmap.milestones[0]!.id).toBe("ready");
    expect(result.roadmap.items[1]!.calibrationGroup).toBe("core");
});

test("normalized roadmaps reject unknown dependencies, parent cycles, execution cycles and excessive expansion", () => {
    expect(() => parse({ ...normalized, dependencies: [{ before: 999, after: 4 }] })).toThrow(
        "outside roadmap membership",
    );
    expect(() => parse({ ...normalized, dependencies: [{ before: 4, after: 10 }] })).toThrow("cycle");
    expect(() =>
        parse({
            ...normalized,
            items: normalized.items.map((item) => (item.issue === 10 ? { ...item, parent: 10 } : item)),
        }),
    ).toThrow("Parent cycle");
    expect(() => parse({ ...normalized, dependencies: [{ before: 2, after: 2 }] })).toThrow("Self dependency");
    expect(() => parse({ ...normalized, milestones: [{ id: "a", requires: [999], unlocks: [] }] })).toThrow(
        "outside roadmap",
    );
    expect(() =>
        parse({ ...normalized, dependencies: Array.from({ length: 6000 }, () => ({ before: 10, after: 4 })) }),
    ).toThrow("limited to 10000");
    expect(() =>
        parse({
            ...normalized,
            items: Array.from({ length: 1001 }, (_, index) => ({ issue: index + 1, title: "task" })),
        }),
    ).toThrow("1000");
});

test("validation endpoint authenticates, enforces repository scope, needs no history and writes nothing", async () => {
    const accuracyService = createTestAccuracyService();
    const input = { repository: "octo/example", roadmap: { body }, roadmapConfig: config };
    expect(
        (await handleRequest(api(input, "/v1/roadmap-validations", "bad"), { accuracyService, apiToken: "test" }))
            .status,
    ).toBe(401);
    const result = await handleRequest(api(input), { accuracyService, apiToken: "test" });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
        format: "markdown-table",
        executionDependencies: [{ before: 2, after: 3 }],
    });
    expect(await accuracyService.predictions("octo/example")).toEqual([]);
    const denied = await handleRequest(api(input, "/v1/roadmap-validations", "workflow.jwt.token"), {
        accuracyService,
        apiToken: "test",
        verifyOidc: async () => ({ kind: "github", repository: "other/repo" }),
    });
    expect(denied.status).toBe(403);
});

test("custom forecasting preserves complete work without acceptance and accepts explicit evidence", () => {
    const request = {
        repository: "octo/example",
        roadmap: { number: 359, title: "Custom roadmap", body, titles: {} },
        roadmapConfig: config,
        history,
    };
    const result = calculateForecast(parseForecastRequest(request), "2026-10-05T00:00:00Z");
    expect(result.estimate.childCount).toBe(2);
    expect(result.estimate.criticalPath).toEqual([2, 3]);
    expect(result.estimate.children[0]!.epic).toBeNull();
    const accepted = calculateForecast(
        parseForecastRequest({
            ...request,
            roadmap: { ...request.roadmap, body: body.replace("| Core | — |", "| Core | Reviewed PR #42 |") },
        }),
        "2026-10-05T00:00:00Z",
    );
    expect(accepted.estimate.childCount).toBe(1);
    expect(accepted.estimate.scopeDiagnostics.join(" ")).toContain("Reviewed PR #42");
});

test("custom calibration uses explicit issue and PR groups without historical title inference", () => {
    const mapped = { format: "normalized-json" as const, historicalGroups: { "1": "core" } };
    const result = calculateForecast(
        parseForecastRequest({
            repository: "octo/example",
            roadmap: { number: 359, title: "Roadmap", body: JSON.stringify(normalized) },
            roadmapConfig: mapped,
            history,
        }),
        "2026-10-05T00:00:00Z",
    );
    expect(result.estimate.children.find((row) => row.issue === 2)?.sizing.basis).toBe("epic-median");
    expect(result.estimate.children.find((row) => row.issue === 3)?.sizing.basis).toBe("repository-median");
    expect(roadmapHistory(history.pullRequests, { format: "normalized-json" }).every((row) => row.epic === null)).toBe(
        true,
    );
    expect(() =>
        roadmapHistory(history.pullRequests, { format: "normalized-json", historicalGroups: { "999": "core" } }),
    ).toThrow("missing PR");
});

test("CLI sends format configuration and roadmap source to Worker validation without loading history", async () => {
    const directory = mkdtempSync(join(tmpdir(), "era-roadmap-"));
    try {
        writeFileSync(join(directory, "era.config.json"), JSON.stringify({ version: 1, roadmap: config }));
        writeFileSync(join(directory, "roadmap.md"), body);
        const output: string[] = [];
        const accuracyService = createTestAccuracyService();
        const code = await runCli(
            [
                "roadmap",
                "validate",
                "--repository",
                "octo/example",
                "--body",
                join(directory, "roadmap.md"),
                "--config",
                join(directory, "era.config.json"),
            ],
            {
                env: { ERA_API_URL: "https://worker.test", ERA_API_TOKEN: "test" },
                fetch: async (input, init) => {
                    expect(String(input)).toBe("https://worker.test/v1/roadmap-validations");
                    expect(JSON.parse(String(init?.body))).not.toHaveProperty("history");
                    return handleRequest(new Request(String(input), init), { accuracyService, apiToken: "test" });
                },
                stdout: (line) => output.push(line),
                stderr: (line) => {
                    throw new Error(line);
                },
            },
        );
        expect(code).toBe(0);
        expect(JSON.parse(output.join("\n")).roadmap.items).toHaveLength(2);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
