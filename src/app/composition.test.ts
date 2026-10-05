import { createTestAccuracyService } from "../../test/helpers/accuracy.ts";
import { expect, test } from "bun:test";
import { createControllers } from "./composition.ts";

test("injected controllers retain isolated repositories across interleaved requests", async () => {
    const untouchedAccuracyService = createTestAccuracyService();
    const firstAccuracyService = createTestAccuracyService();
    const secondAccuracyService = createTestAccuracyService();
    const first = createControllers(firstAccuracyService);
    const second = createControllers(secondAccuracyService);
    const record = (controller: typeof first.tracking, subject: string) =>
        controller.fetch(
            new Request("https://era.test/v1/predictions", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    predictions: [{ repository: "acme/app", subject, model: "test", metric: "tokens", predicted: 1 }],
                }),
            }),
            { identity: { kind: "admin" } },
        );
    const responses = await Promise.all([
        record(first.tracking, "issue:1"),
        record(second.tracking, "issue:2"),
        record(first.tracking, "issue:3"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect((await firstAccuracyService.predictions("acme/app")).map((row) => row.subject).sort()).toEqual([
        "issue:1",
        "issue:3",
    ]);
    expect((await secondAccuracyService.predictions("acme/app")).map((row) => row.subject)).toEqual(["issue:2"]);
    expect(await untouchedAccuracyService.repositories()).toEqual([]);
});
