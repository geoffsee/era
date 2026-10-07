import { describe, expect, test } from "bun:test";

import { selectTaskCandidate, taskIndexes, TaskMiss } from "./task-match.ts";

describe("taskIndexes", () => {
    test("returns each match index and skips a longer identifier", () => {
        const text = "Do #12 now. Later #12 and #120.";

        expect(taskIndexes(text, "#12")).toEqual([3, 18]);
        expect(taskIndexes(text, "E04.03")).toEqual([]);
    });
});

describe("selectTaskCandidate", () => {
    test("picks the session whose first match is nearest the start", () => {
        const chosen = selectTaskCandidate("claude", "#12", [
            { id: "reference", indexes: [400, 420, 440] },
            { id: "delegated", indexes: [2] },
        ]);

        expect(chosen).toBe("delegated");
    });

    test("uses the quantity of indexes when the first index ties", () => {
        const chosen = selectTaskCandidate("claude", "#12", [
            { id: "once", indexes: [0] },
            { id: "prompt", indexes: [0, 40] },
        ]);

        expect(chosen).toBe("prompt");
    });

    test("names the sessions when the indexes tie", () => {
        expect(() =>
            selectTaskCandidate("claude", "#12", [
                { id: "b", indexes: [0, 8] },
                { id: "a", indexes: [0, 9] },
            ]),
        ).toThrow('multiple claude sessions for task "#12": a, b');
    });

    test("reports a miss when the task is absent", () => {
        expect(() => selectTaskCandidate("claude", "#12", [{ id: "a", indexes: [] }])).toThrow(TaskMiss);
    });
});
