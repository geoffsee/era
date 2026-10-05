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
