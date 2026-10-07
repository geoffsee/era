import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { defineAgent, type SessionRef } from "../agent.ts";
import { selectNamedPath } from "../session-ref.ts";
import { selectByTask } from "../task-match.ts";

const root = join(homedir(), ".claude", "projects");

type ClaudeCallUsage = {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
};

/**
 * Claude Code appends one JSONL transcript per session. Each assistant turn
 * records that call's usage. Output already includes thinking tokens.
 */
export const claude = defineAgent({
    id: "claude",
    decoder: {
        tokens(record: ClaudeCallUsage) {
            return record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens;
        },
    },
    select(ref) {
        const path = selectTranscript(root, ref);
        return { session: basename(path, ".jsonl"), records: readTranscript(path) };
    },
});

export function readTranscriptUsage(
    projectsRoot: string,
    ref: SessionRef,
): { session: string; records: ClaudeCallUsage[] } {
    const path = selectTranscript(projectsRoot, ref);
    return { session: basename(path, ".jsonl"), records: readTranscript(path) };
}

function selectTranscript(projectsRoot: string, ref: SessionRef): string {
    const found = transcripts(projectsRoot);
    if (ref.taskId !== undefined && ref.taskId.length > 0 && ref.sessionId === undefined) {
        return selectByTask("claude", found, ref.taskId, (item) => readFileSync(item.path, "utf8")).path;
    }
    return selectNamedPath("claude", found, ref, projectsRoot, "file").path;
}

function readTranscript(path: string): ClaudeCallUsage[] {
    const text = readFileSync(path, "utf8");
    const records: ClaudeCallUsage[] = [];
    let rolledUp: ClaudeCallUsage[] = [];
    for (const line of text.split("\n")) {
        if (!line.includes("input_tokens") && !line.includes("inputTokens")) {
            continue;
        }
        const parsed = JSON.parse(line) as {
            type?: string;
            message?: { usage?: Record<string, unknown> };
            modelUsage?: Record<string, Record<string, unknown>>;
        };
        if (parsed.type === "assistant" && parsed.message?.usage !== undefined) {
            records.push(fromUsage(parsed.message.usage));
        }
        if (parsed.modelUsage !== undefined) {
            rolledUp = Object.values(parsed.modelUsage).map((usage) => fromUsage(usage));
        }
    }
    const chosen = records.length > 0 ? records : rolledUp;
    if (chosen.length === 0) {
        throw new Error("no claude usage records");
    }
    return chosen;
}

function fromUsage(usage: Record<string, unknown>): ClaudeCallUsage {
    return {
        inputTokens: whole(usage.input_tokens ?? usage.inputTokens),
        outputTokens: whole(usage.output_tokens ?? usage.outputTokens),
        cacheReadTokens: whole(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens),
        cacheWriteTokens: whole(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens),
    };
}

function transcripts(projectsRoot: string): { id: string; path: string }[] {
    const found: { id: string; path: string }[] = [];
    const stack = [projectsRoot];
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
            if (entry.name.endsWith(".jsonl")) {
                found.push({ id: basename(entry.name, ".jsonl"), path });
            }
        }
    }
    return found;
}

function whole(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
