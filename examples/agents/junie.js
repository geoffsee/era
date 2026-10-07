import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { selectByTask } from "../../src/tools/token-counter-mcp/task-match.ts";

const root = join(homedir(), ".junie", "sessions");

/**
 * Junie writes one directory per session. Each LLM call appends a
 * LlmResponseMetadataEvent whose modelUsage counters are input, cache read,
 * cache create, and output.
 */
export default {
    id: "junie",
    select(ref) {
        const sessions = listSessions(root);
        if (typeof ref.taskId === "string" && ref.taskId.length > 0 && ref.sessionId === undefined) {
            const session = selectByTask("junie", sessions, ref.taskId, (item) => readFileSync(item.path, "utf8"));
            return { session: session.id, records: readUsage(session.path) };
        }
        const matches =
            ref.sessionId !== undefined
                ? sessions.filter((session) => session.id === ref.sessionId)
                : sessions.filter((session) => ref.openedPaths.some((path) => pathOwns(path, session)));
        if (matches.length !== 1) {
            const ids = [...new Set(matches.map((session) => session.id))].sort();
            if (ref.sessionId !== undefined) {
                throw new Error(
                    matches.length === 0
                        ? `unknown junie session "${ref.sessionId}"`
                        : `multiple junie sessions: ${ids.join(", ")}`,
                );
            }
            throw new Error(
                matches.length === 0
                    ? "no junie session for this process; pass session"
                    : `multiple junie sessions for this process: ${ids.join(", ")}`,
            );
        }
        const session = matches[0];
        return { session: session.id, records: readUsage(session.path) };
    },
    decoder: {
        tokens(record) {
            return record.inputTokens + record.cacheReadTokens + record.cacheCreateTokens + record.outputTokens;
        },
    },
};

function listSessions(sessionsRoot) {
    return readdirSync(sessionsRoot, { withFileTypes: true }).flatMap((entry) => {
        if (!entry.isDirectory()) {
            return [];
        }
        const path = join(sessionsRoot, entry.name, "events.jsonl");
        return existsSync(path) ? [{ id: entry.name, path }] : [];
    });
}

function pathOwns(path, session) {
    return path === session.path || path.includes(`${sep}${session.id}${sep}`) || path.includes(session.id);
}

function readUsage(path) {
    const records = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.includes("modelUsage")) {
            continue;
        }
        const parsed = JSON.parse(line);
        const usage = parsed.event?.agentEvent?.modelUsage;
        if (!Array.isArray(usage)) {
            continue;
        }
        for (const call of usage) {
            records.push({
                inputTokens: whole(call.inputTokens),
                cacheReadTokens: whole(call.cacheInputTokens),
                cacheCreateTokens: whole(call.cacheCreateTokens),
                outputTokens: whole(call.outputTokens),
            });
        }
    }
    if (records.length === 0) {
        throw new Error("no junie usage records");
    }
    return records;
}

function whole(value) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
