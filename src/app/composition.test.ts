import { FORECAST_REPOSITORY } from "../repositories/forecast-repository.ts";
import { expect, test } from "bun:test";
import { useContainer } from "@di-framework/core/container";
import { AccuracyService } from "../services/accuracy-service.ts";
import { createControllers } from "./composition.ts";
import { InMemoryForecastRepository } from "../repositories/forecast-repository.ts";

test("injected controllers retain isolated repositories across interleaved requests", async () => {
    const globalForecastRepository = new InMemoryForecastRepository();
    useContainer().registerFactory(FORECAST_REPOSITORY, () => globalForecastRepository, { singleton: false });
    const firstForecastRepository = new InMemoryForecastRepository();
    const secondForecastRepository = new InMemoryForecastRepository();
    const first = createControllers(firstForecastRepository);
    const second = createControllers(secondForecastRepository);
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
    expect((await firstForecastRepository.predictions("acme/app")).map((row) => row.subject).sort()).toEqual([
        "issue:1",
        "issue:3",
    ]);
    expect((await secondForecastRepository.predictions("acme/app")).map((row) => row.subject)).toEqual(["issue:2"]);
    expect(await useContainer().resolve(AccuracyService).repositories()).toEqual([]);
});
