import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { SessionRef } from "../agent.ts";
import { readConversationUsage } from "./antigravity.ts";
import { readTranscriptUsage } from "./claude.ts";
import { readThreadTokens } from "./codex.ts";
import { readChatUsage } from "./cursor.ts";
import { readSessionUsage as readGrokSession } from "./grok.ts";
import { readSessionUsage as readHermesSession } from "./hermes.ts";

describe("codex reader", () => {
    test("reads the thread whose rollout file is open, from the newest state database", () => {
        const home = mkdtempSync(join(tmpdir(), "codex-"));
        const rollout = join(home, "rollout-new.jsonl");
        writeThreads(join(home, "state_2.sqlite"), [{ id: "old", tokens: 10, rollout }]);
        writeThreads(join(home, "state_12.sqlite"), [
            { id: "other", tokens: 3, rollout: join(home, "other.jsonl") },
            { id: "current", tokens: 40, rollout },
        ]);

        expect(readThreadTokens(home, open(rollout))).toEqual({ session: "current", tokens: 40 });
    });

    test("reads the thread named by session id", () => {
        const home = mkdtempSync(join(tmpdir(), "codex-"));
        writeThreads(join(home, "state_1.sqlite"), [
            { id: "a", tokens: 1, rollout: "/a" },
            { id: "b", tokens: -3, rollout: "/b" },
        ]);

        expect(readThreadTokens(home, { sessionId: "b", openedPaths: [] })).toEqual({ session: "b", tokens: 0 });
    });

    test("fails when the session is missing or ambiguous", () => {
        const home = mkdtempSync(join(tmpdir(), "codex-"));
        expect(() => readThreadTokens(home, open())).toThrow("no codex state database");

        writeThreads(join(home, "state_1.sqlite"), [
            { id: "a", tokens: 1, rollout: "/a" },
            { id: "b", tokens: 2, rollout: "/b" },
        ]);
        expect(() => readThreadTokens(home, open())).toThrow("no codex session for this process; pass session");
        expect(() => readThreadTokens(home, open("/a", "/b"))).toThrow(
            "multiple codex sessions for this process: a, b",
        );
        expect(() => readThreadTokens(home, { sessionId: "missing", openedPaths: [] })).toThrow(
            'unknown codex session "missing"',
        );
    });

    test("selects the rollout whose text contains the task nearest the start", () => {
        const home = mkdtempSync(join(tmpdir(), "codex-"));
        const early = join(home, "early.jsonl");
        const later = join(home, "later.jsonl");
        writeFileSync(early, "#12 finish the storage adapter\nsee #40\n");
        writeFileSync(later, "notes about another issue that references #12\n");
        writeThreads(join(home, "state_1.sqlite"), [
            { id: "later", tokens: 2, rollout: later },
            { id: "early", tokens: 5, rollout: early },
        ]);

        expect(readThreadTokens(home, { taskId: "#12", openedPaths: [] })).toEqual({ session: "early", tokens: 5 });
    });
});

describe("claude reader", () => {
    test("reads the open transcript and prefers assistant turns over a modelUsage rollup", () => {
        const root = mkdtempSync(join(tmpdir(), "claude-"));
        const older = join(root, "old", "session.jsonl");
        const newer = join(root, "new", "current.jsonl");
        writeTranscript(older, [assistantLine({ input_tokens: 99, output_tokens: 99 })]);
        writeTranscript(newer, [
            assistantLine({
                input_tokens: 10,
                output_tokens: 2,
                cache_read_input_tokens: 3,
                cache_creation_input_tokens: 4,
            }),
            assistantLine({ inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1 }),
            JSON.stringify({ modelUsage: { haiku: { input_tokens: 99, output_tokens: 99 } } }),
        ]);

        expect(readTranscriptUsage(root, open(newer))).toEqual({
            session: "current",
            records: [
                { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
                { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 },
            ],
        });
    });

    test("falls back to modelUsage when the named session has no assistant usage", () => {
        const root = mkdtempSync(join(tmpdir(), "claude-"));
        const path = join(root, "session.jsonl");
        writeTranscript(path, [JSON.stringify({ modelUsage: { sonnet: { input_tokens: 5, output_tokens: 6 } } })]);

        expect(readTranscriptUsage(root, { sessionId: "session", openedPaths: [] }).records).toEqual([
            { inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 },
        ]);
    });

    test("fails when no transcript is open or the transcript has no usage", () => {
        const root = mkdtempSync(join(tmpdir(), "claude-"));
        expect(() => readTranscriptUsage(root, open())).toThrow("no claude session for this process; pass session");

        const path = join(root, "session.jsonl");
        writeTranscript(path, ["{"]);
        expect(() => readTranscriptUsage(root, open(path))).toThrow("no claude usage records");
    });
});

describe("grok reader", () => {
    test("reads the session directory that this process has open", () => {
        const root = mkdtempSync(join(tmpdir(), "grok-"));
        const older = join(root, "a", "usage.json");
        const newer = join(root, "b", "usage.json");
        writeJson(older, { session: { totalTokens: 3 } });
        writeJson(newer, { session: { totalTokens: 12.9 } });

        expect(readGrokSession(root, open(join(root, "b", "events.jsonl")))).toEqual({
            session: "b",
            totalTokens: 12,
        });
    });

    test("accepts a named session whose total is zero and rejects a file with no session", () => {
        const root = mkdtempSync(join(tmpdir(), "grok-"));
        const path = join(root, "keep", "usage.json");
        writeJson(path, { session: { totalTokens: 0 } });
        expect(readGrokSession(root, { sessionId: "keep", openedPaths: [] })).toEqual({
            session: "keep",
            totalTokens: 0,
        });

        writeJson(path, {});
        expect(() => readGrokSession(root, { sessionId: "keep", openedPaths: [] })).toThrow(
            "usage.json has no session",
        );
    });

    test("fails when several session directories are open", () => {
        const root = mkdtempSync(join(tmpdir(), "grok-"));
        writeJson(join(root, "a", "usage.json"), { session: { totalTokens: 1 } });
        writeJson(join(root, "b", "usage.json"), { session: { totalTokens: 2 } });

        expect(() =>
            readGrokSession(root, open(join(root, "a", "events.jsonl"), join(root, "b", "events.jsonl"))),
        ).toThrow("multiple grok sessions for this process: a, b");
    });

    test("selects the chat history whose task is nearest the start", () => {
        const root = mkdtempSync(join(tmpdir(), "grok-"));
        writeJson(join(root, "parent", "usage.json"), { session: { totalTokens: 9 } });
        writeJson(join(root, "child", "usage.json"), { session: { totalTokens: 4 } });
        writeFileSync(join(root, "parent", "chat_history.jsonl"), "work continues and issue #12 is mentioned\n");
        writeFileSync(join(root, "child", "chat_history.jsonl"), "#12 implement the counter\n");

        expect(readGrokSession(root, { taskId: "#12", openedPaths: [] })).toEqual({ session: "child", totalTokens: 4 });
    });
});

describe("hermes reader", () => {
    test("reads the named session when several rows exist", () => {
        const path = join(mkdtempSync(join(tmpdir(), "hermes-")), "state.db");
        const database = openHermes(path);
        insertHermes(database, "older", 1, 1, 1, 1);
        insertHermes(database, "current", 9, 8, 7, 6);
        database.close();

        expect(readHermesSession(path, { sessionId: "current", openedPaths: [] })).toEqual({
            session: "current",
            inputTokens: 9,
            outputTokens: 8,
            cacheReadTokens: 7,
            cacheWriteTokens: 6,
        });
    });

    test("reads the only session without an id and rejects an empty or ambiguous table", () => {
        const path = join(mkdtempSync(join(tmpdir(), "hermes-")), "state.db");
        const database = openHermes(path);
        database.close();
        expect(() => readHermesSession(path, open())).toThrow("no hermes sessions");
        const writing = openHermes(path);

        insertHermes(writing, "only", 2, 0, 0, 0);
        writing.close();
        expect(readHermesSession(path, open()).session).toBe("only");

        const many = openHermes(path);
        insertHermes(many, "second", 1, 0, 0, 0);
        many.close();
        expect(() => readHermesSession(path, open())).toThrow(
            "multiple hermes sessions for this process: only, second; pass session",
        );
    });
});

describe("cursor reader", () => {
    test("reads the open store and skips unrelated blobs", () => {
        const root = mkdtempSync(join(tmpdir(), "cursor-"));
        const older = join(root, "old", "store.db");
        const newer = join(root, "new", "store.db");
        writeStore(older, [Buffer.from(JSON.stringify({ inputTokens: 100 }))]);
        writeStore(newer, [
            Buffer.from("binary"),
            Buffer.from(JSON.stringify({ note: "no counters" })),
            Buffer.from(
                JSON.stringify({
                    usage: { input_tokens: 2, output_tokens: 3, cache_read_tokens: 4, cache_write_tokens: 5 },
                }),
            ),
        ]);

        expect(readChatUsage(root, open(newer))).toEqual({
            session: "new",
            records: [{ inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5 }],
        });
    });

    test("fails when no store is open or the store has no usage", () => {
        const root = mkdtempSync(join(tmpdir(), "cursor-"));
        expect(() => readChatUsage(root, open())).toThrow("no cursor session for this process; pass session");

        const path = join(root, "chat", "store.db");
        writeStore(path, [Buffer.from("binary")]);
        expect(() => readChatUsage(root, open(path))).toThrow("no cursor usage records");
    });
});

describe("antigravity reader", () => {
    test("returns step metadata from the open conversation", () => {
        const root = mkdtempSync(join(tmpdir(), "agy-"));
        const metadata = Uint8Array.from([1, 2, 3]);
        const oldPath = writeConversation(root, "old", Uint8Array.from([9]));
        const newPath = writeConversation(root, "new", metadata);

        expect(readConversationUsage(root, open(newPath)).records).toEqual([metadata]);
        expect(readConversationUsage(root, open(oldPath)).session).toBe("old");
    });

    test("fails when no conversation database is open", () => {
        const root = mkdtempSync(join(tmpdir(), "agy-"));
        mkdirSync(join(root, "conversations"));

        expect(() => readConversationUsage(root, open())).toThrow(
            "no antigravity session for this process; pass session",
        );
    });
});

function open(...openedPaths: string[]): SessionRef {
    return { openedPaths };
}

function writeThreads(path: string, rows: Array<{ id: string; tokens: number; rollout: string }> = []): void {
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE threads (id TEXT, tokens_used INTEGER, rollout_path TEXT, updated_at TEXT)");
    const insert = database.prepare(
        "INSERT INTO threads (id, tokens_used, rollout_path, updated_at) VALUES (?, ?, ?, ?)",
    );
    for (const row of rows) {
        insert.run(row.id, row.tokens, row.rollout, "2026-01-01");
    }
    database.close();
}

function writeTranscript(path: string, lines: string[]): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${lines.join("\n")}\n`);
}

function assistantLine(usage: Record<string, number>): string {
    return JSON.stringify({ type: "assistant", message: { usage } });
}

function writeJson(path: string, value: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
}

function openHermes(path: string): DatabaseSync {
    const database = new DatabaseSync(path);
    database.exec(
        `CREATE TABLE IF NOT EXISTS sessions (
            id TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            cache_read_tokens INTEGER,
            cache_write_tokens INTEGER
        )`,
    );
    return database;
}

function insertHermes(
    database: DatabaseSync,
    id: string,
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
): void {
    database
        .prepare(
            "INSERT INTO sessions (id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, input, output, cacheRead, cacheWrite);
}

function writeStore(path: string, blobs: Buffer[]): void {
    mkdirSync(join(path, ".."), { recursive: true });
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE blobs (data BLOB)");
    const insert = database.prepare("INSERT INTO blobs (data) VALUES (?)");
    for (const blob of blobs) {
        insert.run(blob);
    }
    database.close();
}

function writeConversation(root: string, id: string, metadata: Uint8Array): string {
    const directory = join(root, "conversations");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${id}.db`);
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE steps (step_type INTEGER, metadata BLOB)");
    database.prepare("INSERT INTO steps (step_type, metadata) VALUES (15, ?)").run(metadata);
    database.prepare("INSERT INTO steps (step_type, metadata) VALUES (1, ?)").run(Uint8Array.from([8]));
    database.prepare("INSERT INTO steps (step_type, metadata) VALUES (15, NULL)").run();
    database.close();
    return path;
}
