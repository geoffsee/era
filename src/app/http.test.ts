import { createTestAccuracyService } from "../../test/helpers/accuracy.ts";
import { expect, test } from "bun:test";
import { handleRequest } from "./http.ts";

test("injected controllers retain isolated repositories across interleaved requests", async () => {
    const untouchedAccuracyService = createTestAccuracyService();
    const firstAccuracyService = createTestAccuracyService();
    const secondAccuracyService = createTestAccuracyService();
    const record = (accuracyService: typeof firstAccuracyService, subject: string) =>
        handleRequest(
            new Request("https://era.test/v1/predictions", {
                method: "POST",
                headers: { "content-type": "application/json", authorization: "Bearer test" },
                body: JSON.stringify({
                    predictions: [{ repository: "acme/app", subject, model: "test", metric: "tokens", predicted: 1 }],
                }),
            }),
            { accuracyService, apiToken: "test" },
        );
    const responses = await Promise.all([
        record(firstAccuracyService, "issue:1"),
        record(secondAccuracyService, "issue:2"),
        record(firstAccuracyService, "issue:3"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect((await firstAccuracyService.predictions("acme/app")).map((row) => row.subject).sort()).toEqual([
        "issue:1",
        "issue:3",
    ]);
    expect((await secondAccuracyService.predictions("acme/app")).map((row) => row.subject)).toEqual(["issue:2"]);
    expect(await untouchedAccuracyService.repositories()).toEqual([]);
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
