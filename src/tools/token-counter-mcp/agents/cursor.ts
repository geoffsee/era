import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defineAgent } from "../agent.ts";

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
  records(): Iterable<CursorCallUsage> {
    return readLatestChat(root);
  },
});

function readLatestChat(chatsRoot: string): CursorCallUsage[] {
  const database = new DatabaseSync(newestStore(chatsRoot), { readOnly: true });
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

function newestStore(chatsRoot: string): string {
  let best: { mtime: number; path: string } | null = null;
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
      if (entry.name !== "store.db") {
        continue;
      }
      const mtime = statSync(path).mtimeMs;
      if (best === null || mtime > best.mtime) {
        best = { mtime, path };
      }
    }
  }
  if (best === null) {
    throw new Error("no cursor chat store");
  }
  return best.path;
}

function whole(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
