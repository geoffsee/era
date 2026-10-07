import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { defineAgent, type SessionRef } from "../agent.ts";
import { selectNamedPath } from "../session-ref.ts";
import { selectByTask } from "../task-match.ts";

const root = join(homedir(), ".cursor", "chats");

type CursorCallUsage = {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
};

/**
 * Cursor stores one SQLite database per chat. JSON blobs may carry a call's
 * token counters. Cache read and cache write are separate from input.
 */
export const cursor = defineAgent({
    id: "cursor",
    decoder: {
        tokens(record: CursorCallUsage) {
            return record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens;
        },
    },
    select(ref) {
        const path = selectStore(root, ref);
        return { session: basename(dirname(path)), records: readStore(path) };
    },
});

export function readChatUsage(chatsRoot: string, ref: SessionRef): { session: string; records: CursorCallUsage[] } {
    const path = selectStore(chatsRoot, ref);
    return { session: basename(dirname(path)), records: readStore(path) };
}

function selectStore(chatsRoot: string, ref: SessionRef): string {
    const found = stores(chatsRoot);
    if (ref.taskId !== undefined && ref.taskId.length > 0 && ref.sessionId === undefined) {
        return selectByTask("cursor", found, ref.taskId, (item) => readFileSync(item.path, "latin1")).path;
    }
    return selectNamedPath("cursor", found, ref, chatsRoot, "file").path;
}

function readStore(path: string): CursorCallUsage[] {
    const database = new DatabaseSync(path, { readOnly: true });
    const rows = database.prepare("SELECT data FROM blobs").all() as Array<{ data: Uint8Array }>;
    database.close();
    const records: CursorCallUsage[] = [];
    for (const row of rows) {
        if (row.data[0] !== 0x7b) {
            continue;
        }
        const text = new TextDecoder().decode(row.data);
        if (!text.includes("inputTokens") && !text.includes("input_tokens")) {
            continue;
        }
        const parsed = JSON.parse(text) as unknown;
        const usage = usageObject(parsed);
        if (usage === null) {
            continue;
        }
        records.push(usage);
    }
    if (records.length === 0) {
        throw new Error("no cursor usage records");
    }
    return records;
}

function usageObject(value: unknown): CursorCallUsage | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const nested = record.usage ?? record.tokenUsage ?? record.token_usage;
    const source = typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : record;
    const inputTokens = whole(source.inputTokens ?? source.input_tokens);
    const outputTokens = whole(source.outputTokens ?? source.output_tokens);
    const cacheReadTokens = whole(source.cacheReadTokens ?? source.cache_read_tokens);
    const cacheWriteTokens = whole(source.cacheWriteTokens ?? source.cache_write_tokens);
    if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) {
        return null;
    }
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function stores(chatsRoot: string): { id: string; path: string }[] {
    const found: { id: string; path: string }[] = [];
    const stack = [chatsRoot];
    while (stack.length > 0) {
        const current = stack.pop();
        if (current === undefined) {
            break;
        }
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const path = join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(path);
                continue;
            }
            if (entry.name === "store.db") {
                found.push({ id: basename(dirname(path)), path });
            }
        }
    }
    return found;
}

function whole(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
