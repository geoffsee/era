import { expect, test } from "bun:test";
import { parseForecastPlan } from "./forecast-plan.ts";

const base = { version: 1, source: "Planning audit" };

test("rejects malformed quantities, missing evidence and accidental plan fields", () => {
    for (const authorBlocks of [-1, Infinity, NaN, "1"]) {
        expect(() => parseForecastPlan({ ...base, work: { "2": { authorBlocks, source: "Plan" } } })).toThrow();
    }
    expect(() => parseForecastPlan({ ...base, work: { "2": { authorBlocks: 0, source: "Issue closed" } } })).toThrow(
        "explicit acceptance",
    );
    expect(() =>
        parseForecastPlan({ ...base, work: { "2": { authorBlocks: 1, source: "", accepted: false } } }),
    ).toThrow("source");
    expect(() => parseForecastPlan({ ...base, humanHours: 20 })).toThrow("unknown field");
    expect(() =>
        parseForecastPlan({ ...base, work: { "2": { authorBlocks: 1, source: "Plan", comparablePrs: [3, 3] } } }),
    ).toThrow("duplicate");
});

test("requires explicit labor categories and billable runner quantities", () => {
    const activity = { activity: "review", hours: 1, usdPerHour: 100 };
    expect(() => parseForecastPlan({ ...base, humanActivities: [activity, activity] })).toThrow(
        "duplicate human activity",
    );
    expect(() =>
        parseForecastPlan({ ...base, infrastructureBilling: { kind: "billable", runnerMinutes: 100 } }),
    ).toThrow();
    const plan = {
        ...base,
        humanActivities: [],
        infrastructureBilling: {
            kind: "billable" as const,
            runnerMinutes: 60,
            usdPerMinute: 0.01,
            source: "Runner plan",
        },
    };
    expect(parseForecastPlan(plan).infrastructureBilling).toEqual(plan.infrastructureBilling);
});

test("#359 central scenario records all quantities as assumptions", async () => {
    const plan = parseForecastPlan(
        await Bun.file(new URL("../../test/fixtures/roadmap-359-central-plan.json", import.meta.url)).json(),
    );
    expect(Object.values(plan.work!).reduce((sum, work) => sum + work.authorBlocks, 0)).toBe(25);
    expect(plan.humanActivities!.reduce((sum, work) => sum + work.hours, 0)).toBe(108);
    expect(plan.source).toContain("assumptions");
});
