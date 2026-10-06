import { ScriptedChatModel } from "@di-framework/ai";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAccuracyService } from "../../test/helpers/accuracy.ts";
import { runCli } from "./cli.ts";
import { handleRequest } from "../../test/helpers/http.ts";

const root = join(import.meta.dir, "../..");
const args = [
    "--repository",
    "octo/example",
    "--issue",
    "359",
    "--body",
    join(root, "test/fixtures/roadmap-359.md"),
    "--titles",
    join(root, "test/fixtures/roadmap-359-titles.json"),
    "--history",
    join(root, "test/fixtures/forecast-history"),
    "--plan",
    join(root, "test/fixtures/roadmap-359-central-plan.json"),
];

test("snapshot CLI posts inputs to the Worker and prints its report without recording", async () => {
    const output: string[] = [];
    const accuracyService = createTestAccuracyService();
    const urls: string[] = [];
    const code = await runCli(["estimate", ...args], {
        env: { ERA_API_URL: "https://worker.test", ERA_API_TOKEN: "test" },
        fetch: async (url, init) => {
            urls.push(String(url));
            return handleRequest(url instanceof Request ? url : new Request(String(url), init), {
                accuracyService,
                apiToken: "test",
            });
        },
        stdout: (line) => output.push(line),
        stderr: (line) => {
            throw new Error(line);
        },
    });
    expect(code).toBe(0);
    expect(output.join("\n")).toContain("108.0h");
    expect(output.join("\n")).toContain("octo/example#359");
    expect(urls).toEqual(["https://worker.test/v1/estimates"]);
    expect(await accuracyService.predictions("octo/example")).toEqual([]);
});

test("record-estimate versions the priced subtotal without mixing legacy dollar observations", async () => {
    const rows: Array<{ model: string; metric: string; subject: string }> = [];
    const accuracyService = createTestAccuracyService();
    const code = await runCli(["record-estimate", ...args], {
        env: { ERA_API_URL: "https://tracker.test", ERA_API_TOKEN: "test" },
        fetch: async (url, init) => {
            expect(String(url)).toBe("https://tracker.test/v1/estimates");
            expect(JSON.parse(init?.body as string).record).toBe(true);
            const response = await handleRequest(url instanceof Request ? url : new Request(String(url), init), {
                accuracyService,
                apiToken: "test",
            });
            rows.push(...(await accuracyService.predictions("octo/example")));
            return response;
        },
        stdout: () => {},
        stderr: (line) => {
            throw new Error(line);
        },
    });
    expect(code).toBe(0);
    expect(rows.find((row) => row.metric === "usd_subtotal")).toMatchObject({
        model: "delivery-cost-v2",
        subject: "issue:359",
    });
    expect(rows.some((row) => row.metric === "usd")).toBe(false);
});

test("refuses foreign history and invalid roadmap identities before recording", async () => {
    for (const invalidArgs of [
        args.map((value) => (value === "359" ? "NaN" : value)),
        args.map((value) => (value === "octo/example" ? "other/repo" : value)),
    ]) {
        const errors: string[] = [];
        expect(
            await runCli(["estimate", ...invalidArgs], {
                env: { ERA_API_URL: "https://worker.test", ERA_API_TOKEN: "test" },
                fetch: async () => {
                    throw new Error("Unexpected network access");
                },
                stdout: () => {},
                stderr: (line) => errors.push(line),
            }),
        ).toBe(1);
        expect(errors).toHaveLength(1);
    }
});

test("CLI prints the server report rather than calculating an estimate locally", async () => {
    const output: string[] = [];
    expect(
        await runCli(["estimate", ...args], {
            env: { ERA_API_URL: "https://worker.test", ERA_API_TOKEN: "test" },
            fetch: async () => Response.json({ report: "Worker-owned forecast" }),
            stdout: (line) => output.push(line),
            stderr: (line) => {
                throw new Error(line);
            },
        }),
    ).toBe(0);
    expect(output).toEqual(["Worker-owned forecast"]);
});

test("CLI surfaces Worker validation errors and requires API configuration", async () => {
    const errors: string[] = [];
    expect(
        await runCli(["estimate", ...args], {
            env: { ERA_API_URL: "https://worker.test", ERA_API_TOKEN: "test" },
            fetch: async () => Response.json({ error: "invalid forecast snapshot" }, { status: 400 }),
            stdout: () => {},
            stderr: (line) => errors.push(line),
        }),
    ).toBe(1);
    expect(errors).toEqual(["invalid forecast snapshot"]);
    expect(
        await runCli(["estimate", ...args], {
            env: {},
            fetch: async () => {
                throw new Error("Unexpected fetch");
            },
            stdout: () => {},
            stderr: (line) => errors.push(line),
        }),
    ).toBe(1);
    expect(errors.at(-1)).toContain("ERA_API_URL");
});

test("CLI delegates backtest prediction and scoring to the Worker", async () => {
    const output: string[] = [];
    const code = await runCli(
        ["backtest", "--repository", "octo/example", "--dir", join(root, "test/fixtures/forecast-history")],
        {
            env: { ERA_API_URL: "https://worker.test", ERA_API_TOKEN: "test" },
            fetch: async (url, init) => {
                expect(String(url)).toBe("https://worker.test/v1/backtests");
                const body = JSON.parse(init?.body as string);
                expect(body.record).toBe(true);
                expect(body.history.pullRequests).toHaveLength(1);
                return Response.json({ reports: [] });
            },
            stdout: (line) => output.push(line),
            stderr: (line) => {
                throw new Error(line);
            },
        },
    );
    expect(code).toBe(0);
    expect(output).toEqual(["No paired predictions and observations yet."]);
});

test("an inference section in era.config.json adds model-inferred fields to the printed report", async () => {
    const directory = mkdtempSync(join(tmpdir(), "era-inference-"));
    try {
        writeFileSync(
            join(directory, "era.config.json"),
            JSON.stringify({
                version: 1,
                inference: {
                    fields: [
                        { name: "calendarDays", description: "Working days to merge", type: "number", unit: "days" },
                    ],
                },
            }),
        );
        writeFileSync(join(directory, "bodies.json"), JSON.stringify({ "335": "Amend the ADR and link the ledger." }));
        const chatModel = new ScriptedChatModel(
            [{ respond: JSON.stringify({ items: [{ issue: 335, calendarDays: 4, rationale: "Like PR #1." }] }) }],
            { model: "scripted-model" },
        );
        const accuracyService = createTestAccuracyService();
        const output: string[] = [];
        const code = await runCli(
            [
                "estimate",
                ...args,
                "--config",
                join(directory, "era.config.json"),
                "--descriptions",
                join(directory, "bodies.json"),
            ],
            {
                env: { ERA_API_URL: "https://worker.test", ERA_API_TOKEN: "test" },
                fetch: async (url, init) => {
                    const sent = JSON.parse(init?.body as string);
                    expect(sent.inference.fields).toHaveLength(1);
                    expect(sent.roadmap.descriptions).toEqual({ "335": "Amend the ADR and link the ledger." });
                    return handleRequest(url instanceof Request ? url : new Request(String(url), init), {
                        accuracyService,
                        apiToken: "test",
                        chatModel,
                    });
                },
                stdout: (line) => output.push(line),
                stderr: (line) => {
                    throw new Error(line);
                },
            },
        );
        expect(code).toBe(0);
        const report = output.join("\n");
        expect(report).toContain("## In-context inferred estimates");
        expect(report).toContain("| #335 | 4 | Like PR #1. |");
        expect(chatModel.calls[0]!.messages.map((message) => message.text).join("\n")).toContain(
            "Description: Amend the ADR and link the ledger.",
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
