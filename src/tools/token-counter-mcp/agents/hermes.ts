import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

import { defineAgent, type SessionRef } from "../agent.ts";
import { selectByTask } from "../task-match.ts";

const root = join(homedir(), ".hermes", "state.db");

type HermesSessionUsage = {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
};

/**
 * Hermes keeps every session in one `state.db`. A single row can be counted
 * without an id. Several rows require `session`.
 */
export const hermes = defineAgent({
    id: "hermes",
    decoder: {
        tokens(record: HermesSessionUsage) {
            return record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens;
        },
    },
    select(ref) {
        const session = readSession(root, ref);
        return { session: session.session, records: [session.usage] };
    },
});

export function readSessionUsage(databasePath: string, ref: SessionRef): HermesSessionUsage & { session: string } {
    const session = readSession(databasePath, ref);
    return { session: session.session, ...session.usage };
}

function readSession(databasePath: string, ref: SessionRef): { session: string; usage: HermesSessionUsage } {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const rows = database
        .prepare("SELECT id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM sessions")
        .all() as Array<{
        id: string;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
    }>;
    if (ref.taskId !== undefined && ref.taskId.length > 0 && ref.sessionId === undefined) {
        const texts = taskRows(database);
        database.close();
        const match = selectByTask("hermes", texts, ref.taskId, (row) => row.text);
        const usage = rows.find((row) => row.id === match.id);
        if (usage === undefined) {
            throw new Error(`unknown hermes session "${match.id}"`);
        }
        return usageFrom(usage);
    }
    database.close();
    const matches =
        ref.sessionId !== undefined ? rows.filter((row) => row.id === ref.sessionId) : rows.length === 1 ? rows : [];
    if (matches.length !== 1) {
        if (ref.sessionId !== undefined) {
            throw new Error(`unknown hermes session "${ref.sessionId}"`);
        }
        throw new Error(
            rows.length === 0
                ? "no hermes sessions"
                : `multiple hermes sessions for this process: ${rows
                      .map((row) => row.id)
                      .sort()
                      .join(", ")}; pass session`,
        );
    }
    return usageFrom(matches[0]!);
}

function usageFrom(match: {
    id: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
}): { session: string; usage: HermesSessionUsage } {
    return {
        session: match.id,
        usage: {
            inputTokens: whole(match.input_tokens),
            outputTokens: whole(match.output_tokens),
            cacheReadTokens: whole(match.cache_read_tokens),
            cacheWriteTokens: whole(match.cache_write_tokens),
        },
    };
}

function taskRows(database: DatabaseSync): { id: string; text: string }[] {
    const columns = new Set(
        (database.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    const pieces = ["system_prompt", "title"].filter((name) => columns.has(name));
    if (pieces.length === 0) {
        return [];
    }
    const text = pieces.map((name) => `ifnull(${name}, '')`).join(" || char(10) || ");
    return database.prepare(`SELECT id, ${text} AS text FROM sessions`).all() as Array<{ id: string; text: string }>;
}

function whole(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
