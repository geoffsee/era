import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defineAgent } from "../agent.ts";

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
  records(): Iterable<ClaudeCallUsage> {
    return readLatestTranscript(root);
  },
});

function readLatestTranscript(projectsRoot: string): ClaudeCallUsage[] {
  const text = readFileSync(newestTranscript(projectsRoot), "utf8");
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

function newestTranscript(projectsRoot: string): string {
  let best: { mtime: number; path: string } | null = null;
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
      if (!entry.name.endsWith(".jsonl")) {
        continue;
      }
      const mtime = statSync(path).mtimeMs;
      if (best === null || mtime > best.mtime) {
        best = { mtime, path };
      }
    }
  }
  if (best === null) {
    throw new Error("no claude transcript");
  }
  return best.path;
}

function whole(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
