import { expect, test } from "bun:test";
import { join } from "node:path";
import { runCli } from "./cli.ts";

const root = join(import.meta.dir, "..");
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

test("offline estimate needs no tracker credentials and performs no network writes", async () => {
    const output: string[] = [];
    const code = await runCli(["estimate", ...args], {
        env: {},
        fetch: async () => {
            throw new Error("Unexpected tracker access");
        },
        stdout: (line) => output.push(line),
        stderr: (line) => {
            throw new Error(line);
        },
    });
    expect(code).toBe(0);
    expect(output.join("\n")).toContain("108.0h");
    expect(output.join("\n")).toContain("octo/example#359");
});

test("record-estimate versions the priced subtotal without mixing legacy dollar observations", async () => {
    const rows: Array<{ model: string; metric: string; subject: string }> = [];
    const code = await runCli(["record-estimate", ...args], {
        env: { ERA_API_URL: "https://tracker.test", ERA_API_TOKEN: "test" },
        fetch: async (_url, init) => {
            const data = JSON.parse(init?.body as string);
            rows.push(...data.predictions);
            return Response.json({ stored: data.predictions.length });
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
                env: {},
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
