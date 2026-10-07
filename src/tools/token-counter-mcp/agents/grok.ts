import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { defineAgent, type SessionRef } from "../agent.ts";
import { selectNamedPath } from "../session-ref.ts";
import { selectByTask } from "../task-match.ts";

const root = join(homedir(), ".grok", "sessions");

type GrokSessionUsage = {
    totalTokens: number;
};

/**
 * Grok writes `usage.json` per session. `session.totalTokens` is input plus
 * output. Cache reads sit inside input, and reasoning sits inside output.
 */
export const grok = defineAgent({
    id: "grok",
    decoder: {
        tokens(record: GrokSessionUsage) {
            return record.totalTokens;
        },
    },
    select(ref) {
        const path = selectUsageFile(root, ref);
        return { session: sessionIdOf(path), records: [readSession(path)] };
    },
});

export function readSessionUsage(sessionsRoot: string, ref: SessionRef): GrokSessionUsage & { session: string } {
    const path = selectUsageFile(sessionsRoot, ref);
    return { session: sessionIdOf(path), ...readSession(path) };
}

function selectUsageFile(sessionsRoot: string, ref: SessionRef): string {
    const found = usageFiles(sessionsRoot);
    if (ref.taskId !== undefined && ref.taskId.length > 0 && ref.sessionId === undefined) {
        return selectByTask("grok", found, ref.taskId, conversationText).path;
    }
    return selectNamedPath("grok", found, ref, sessionsRoot, "directory").path;
}

function conversationText(item: { path: string }): string {
    const history = join(dirname(item.path), "chat_history.jsonl");
    return readFileSync(existsSync(history) ? history : item.path, "utf8");
}

function readSession(path: string): GrokSessionUsage {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { session?: Record<string, unknown> };
    const total = whole(parsed.session?.totalTokens);
    if (total === 0 && parsed.session === undefined) {
        throw new Error("usage.json has no session");
    }
    return { totalTokens: total };
}

function usageFiles(sessionsRoot: string): { id: string; path: string }[] {
    const found: { id: string; path: string }[] = [];
    const stack = [sessionsRoot];
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
            if (entry.name === "usage.json") {
                found.push({ id: sessionIdOf(path), path });
            }
        }
    }
    return found;
}

function sessionIdOf(path: string): string {
    return path.split("/").at(-2) ?? path;
}

function whole(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
