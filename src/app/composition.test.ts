import { expect, test } from "bun:test";
import { useContainer } from "@di-framework/core/container";
import { AccuracyService, LEDGER } from "../services/accuracy-service.ts";
import { createControllers } from "./composition.ts";
import { MemoryLedger } from "../repositories/ledger.ts";

test("injected controllers retain isolated repositories across interleaved requests", async () => {
    const globalLedger = new MemoryLedger();
    useContainer().registerFactory(LEDGER, () => globalLedger, { singleton: false });
    const firstLedger = new MemoryLedger();
    const secondLedger = new MemoryLedger();
    const first = createControllers(firstLedger);
    const second = createControllers(secondLedger);
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
    expect((await firstLedger.predictions("acme/app")).map((row) => row.subject).sort()).toEqual([
        "issue:1",
        "issue:3",
    ]);
    expect((await secondLedger.predictions("acme/app")).map((row) => row.subject)).toEqual(["issue:2"]);
    expect(await useContainer().resolve(AccuracyService).repositories()).toEqual([]);
});
