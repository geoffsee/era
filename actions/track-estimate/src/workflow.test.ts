import { expect, test } from "bun:test";
import { createActionComposition, MockActionRuntime, runComposedAction } from "@terella/action-framework";
import { ERA_CREDENTIAL, ERA_FETCH, type EraFetch } from "./tracker.ts";
import { TrackEstimateWorkflow } from "./workflow.ts";

test("sync records the pull request actual and writes the accuracy scale", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fetchImpl: EraFetch = async (url, init) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.includes("/v1/accuracy")) {
            return Response.json({
                repository: "acme/app",
                reports: [
                    {
                        repository: "acme/app",
                        model: "token-threshold",
                        metric: "tokens",
                        count: 4,
                        mae: 10,
                        mmre: 0.2,
                        pred: 0.75,
                        scale: 1.1,
                    },
                ],
            });
        }
        if (url.includes("/comments")) return Response.json({ id: 9 });
        return Response.json({ stored: 1 });
    };
    const runtime = new MockActionRuntime();
    runtime.inputs = {
        "api-url": "https://tracker.test",
        "api-token": "secret",
        mode: "sync",
        kind: "observation",
        metric: "tokens",
        value: "80",
        comment: "true",
        "github-token": "gh-secret",
    };
    await run(runtime, fetchImpl, { owner: "acme", repo: "app", pullRequestNumber: 12 });

    expect(calls[0]?.url).toBe("https://tracker.test/v1/observations");
    expect(calls[0]?.body).toEqual({
        observations: [
            {
                repository: "acme/app",
                subject: "pr:12",
                metric: "tokens",
                actual: 80,
                source: "github-action",
            },
        ],
    });
    expect(calls[1]?.url).toContain("/v1/accuracy?repository=acme%2Fapp");
    expect(calls[2]?.url).toBe("https://api.github.com/repos/acme/app/issues/12/comments");
    expect(runtime.outputs.stored).toBe("1");
    expect(runtime.outputs.scales).toBe(JSON.stringify([{ model: "token-threshold", metric: "tokens", scale: 1.1 }]));
    expect(String(runtime.outputs.report)).toContain("1.100");
    expect(runtime.secrets).toEqual(["secret", "gh-secret"]);
    expect(runtime.summaryWritten).toBe(true);
});

test("predict uses an explicit subject for any repository", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fetchImpl: EraFetch = async (url, init) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return Response.json({ stored: 1 });
    };
    const runtime = new MockActionRuntime();
    runtime.inputs = {
        "api-url": "https://tracker.test/",
        "api-token": "secret",
        mode: "predict",
        repository: "other/service",
        subject: "issue:4",
        model: "seeagent",
        metric: "story_points",
        value: "5",
    };
    await run(runtime, fetchImpl, { owner: "ignored", repo: "ignored" });
    expect(calls[0]?.url).toBe("https://tracker.test/v1/predictions");
    expect(calls[0]?.body).toEqual({
        predictions: [
            {
                repository: "other/service",
                subject: "issue:4",
                model: "seeagent",
                metric: "story_points",
                predicted: 5,
            },
        ],
    });
    expect(runtime.outputs.report).toBe("");
});

test("records json can mix predictions and observations", async () => {
    const calls: Array<{ body?: { predictions?: unknown[]; observations?: unknown[] } }> = [];
    const fetchImpl: EraFetch = async (_url, init) => {
        calls.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return Response.json({ stored: 1 });
    };
    const runtime = new MockActionRuntime();
    runtime.inputs = {
        "api-url": "https://tracker.test",
        "api-token": "secret",
        mode: "observe",
        repository: "acme/app",
        records: JSON.stringify([
            { kind: "observation", subject: "pr:3", metric: "cicd_seconds", value: 90 },
            { kind: "prediction", subject: "issue:8", metric: "tokens", model: "token-median", value: 1000 },
        ]),
    };
    await run(runtime, fetchImpl, { owner: "acme", repo: "app" });
    expect(runtime.outputs.stored).toBe("2");
    expect(calls[0]?.body?.predictions).toEqual([
        {
            repository: "acme/app",
            subject: "issue:8",
            model: "token-median",
            metric: "tokens",
            predicted: 1000,
        },
    ]);
    expect(calls[1]?.body?.observations?.[0]).toMatchObject({ subject: "pr:3", actual: 90 });
});

test("rejects an unknown mode", async () => {
    const runtime = new MockActionRuntime();
    runtime.inputs = { "api-url": "https://tracker.test", "api-token": "secret", mode: "nope" };
    await expect(run(runtime, async () => Response.json({}), { owner: "acme", repo: "app" })).rejects.toThrow(/mode/);
});

async function run(
    runtime: MockActionRuntime,
    fetchImpl: EraFetch,
    repo: { owner: string; repo: string; pullRequestNumber?: number },
): Promise<void> {
    const composition = createActionComposition(
        { githubContext: { repo: { owner: "default", repo: "default" } }, dependencies: {} },
        {
            runtime,
            githubContext: { repo: { owner: repo.owner, repo: repo.repo }, pullRequestNumber: repo.pullRequestNumber },
        },
    );
    composition.registerFactory(ERA_FETCH, () => fetchImpl, { singleton: true });
    composition.registerFactory(ERA_CREDENTIAL, () => runtime.inputs["api-token"] || "actions-oidc", {
        singleton: true,
    });
    await runComposedAction(composition, TrackEstimateWorkflow);
}
