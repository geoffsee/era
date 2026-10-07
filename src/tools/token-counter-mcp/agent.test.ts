import { describe, expect, test } from "bun:test";

import { type Agent, countTokens, defineAgent } from "./agent.ts";

describe("countTokens", () => {
    test("sums the decoder over every record", () => {
        const agent: Agent<number> = {
            id: "sample",
            select: () => ({ session: "s", records: [2, 3, 4] }),
            decoder: { tokens: (record) => record },
        };

        expect(countTokens(agent, { openedPaths: [] })).toEqual({ session: "s", eraTokens: 9 });
    });

    test("returns zero when the agent has no records", () => {
        const agent: Agent<number> = {
            id: "empty",
            select: () => ({ session: "s", records: [] }),
            decoder: { tokens: () => 1 },
        };

        expect(countTokens(agent, { openedPaths: [] })).toEqual({ session: "s", eraTokens: 0 });
    });
});

describe("defineAgent", () => {
    test("exposes the agent id and the summed token count", () => {
        const runner = defineAgent({
            id: "sample",
            select: () => ({ session: "s", records: [10, 5] }),
            decoder: { tokens: (record: number) => record },
        });

        expect(runner.id).toBe("sample");
        expect(runner.session({ openedPaths: [] })).toBe("s");
        expect(runner.countTokens({ openedPaths: [] })).toEqual({ session: "s", eraTokens: 15 });
    });
});
