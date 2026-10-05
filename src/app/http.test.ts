import { useContainer } from "@di-framework/core/container";
import { expect, test } from "bun:test";
import { env } from "../../test/cloudflare.ts";
import { createTestAccuracyService } from "../../test/helpers/accuracy.ts";
import { handleRequest, startWorker } from "../../test/helpers/http.ts";
import worker from "./main.ts";
import { AccuracyService } from "./services/accuracy-service.ts";

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
