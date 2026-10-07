import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defineAgent, type SessionRef } from "../agent.ts";
import { selectByTask } from "../task-match.ts";

const root = join(homedir(), ".codex");

/**
 * Codex stores one row per thread. `tokens_used` matches rollout `total_tokens`,
 * which is input plus output. The open rollout file identifies the thread.
 */
export const codex = defineAgent({
    id: "codex",
    decoder: {
        tokens(record: number) {
            return record;
        },
    },
    select(ref) {
        const thread = readThread(root, ref);
        return { session: thread.session, records: [thread.tokens] };
    },
});

export function readThreadTokens(codexHome: string, ref: SessionRef): { session: string; tokens: number } {
    return readThread(codexHome, ref);
}

function readThread(codexHome: string, ref: SessionRef): { session: string; tokens: number } {
    const database = new DatabaseSync(statePath(codexHome), { readOnly: true });
    const rows = database.prepare("SELECT id, tokens_used, rollout_path FROM threads").all() as Array<{
        id: string;
        tokens_used: number;
        rollout_path: string;
    }>;
    database.close();
    if (ref.taskId !== undefined && ref.taskId.length > 0 && ref.sessionId === undefined) {
        const match = selectByTask("codex", rows, ref.taskId, (row) => readOptional(row.rollout_path));
        return { session: match.id, tokens: whole(match.tokens_used) };
    }
    const matches =
        ref.sessionId !== undefined
            ? rows.filter((row) => row.id === ref.sessionId)
            : rows.filter((row) => ref.openedPaths.includes(row.rollout_path));
    if (matches.length !== 1) {
        const ids = matches.map((row) => row.id);
        if (ref.sessionId !== undefined) {
            throw new Error(
                matches.length === 0
                    ? `unknown codex session "${ref.sessionId}"`
                    : `multiple codex sessions: ${ids.join(", ")}`,
            );
        }
        throw new Error(
            matches.length === 0
                ? "no codex session for this process; pass session"
                : `multiple codex sessions for this process: ${ids.join(", ")}`,
        );
    }
    const match = matches[0]!;
    return { session: match.id, tokens: whole(match.tokens_used) };
}

function statePath(codexHome: string): string {
    const names = readdirSync(codexHome).flatMap((name) => {
        const match = /^state_(\d+)\.sqlite$/.exec(name);
        return match ? [{ name, version: Number(match[1]) }] : [];
    });
    const match = names.sort((left, right) => left.version - right.version).at(-1);
    if (match === undefined) {
        throw new Error("no codex state database");
    }
    return join(codexHome, match.name);
}

function readOptional(path: string): string {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
}

function whole(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
