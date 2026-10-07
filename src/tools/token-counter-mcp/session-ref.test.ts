import { describe, expect, test } from "bun:test";

import { selectNamedPath, sessionFromCommandText } from "./session-ref.ts";

const found = [
    { id: "a", path: "/data/a/usage.json" },
    { id: "b", path: "/data/b/usage.json" },
];

describe("selectNamedPath", () => {
    test("uses the session id when one is passed", () => {
        expect(
            selectNamedPath(
                "grok",
                found,
                { sessionId: "b", openedPaths: ["/data/a/events.jsonl"] },
                "/data",
                "directory",
            ).id,
        ).toBe("b");
    });

    test("uses the session directory this process has open", () => {
        expect(selectNamedPath("grok", found, { openedPaths: ["/data/a/events.jsonl"] }, "/data", "directory").id).toBe(
            "a",
        );
    });

    test("matches a session file only when that file is open", () => {
        const transcripts = [
            { id: "one", path: "/projects/one.jsonl" },
            { id: "two", path: "/projects/two.jsonl" },
        ];

        expect(
            selectNamedPath("claude", transcripts, { openedPaths: ["/projects/two.jsonl"] }, "/projects", "file").id,
        ).toBe("two");
        expect(() =>
            selectNamedPath("claude", transcripts, { openedPaths: ["/projects/notes.txt"] }, "/projects", "file"),
        ).toThrow("no claude session for this process; pass session");
    });

    test("names every open session when more than one matches", () => {
        expect(() =>
            selectNamedPath(
                "grok",
                found,
                { openedPaths: ["/data/a/events.jsonl", "/data/b/events.jsonl"] },
                "/data",
                "directory",
            ),
        ).toThrow("multiple grok sessions for this process: a, b");
    });
});

describe("sessionFromCommandText", () => {
    test("reads one session id and ignores a terminal session", () => {
        expect(sessionFromCommandText("agent SESSION_ID=sess-1 TERM_SESSION_ID=tty")).toBe("sess-1");
        expect(sessionFromCommandText("agent SESSION=one SESSION_ID=two")).toBeUndefined();
        expect(sessionFromCommandText("agent GROK_AGENT=1")).toBeUndefined();
    });
});
