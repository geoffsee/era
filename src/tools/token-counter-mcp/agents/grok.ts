import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defineAgent } from "../agent.ts";

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
  records(): Iterable<GrokSessionUsage> {
    return [readLatestSession(root)];
  },
});

function readLatestSession(sessionsRoot: string): GrokSessionUsage {
  const path = newestUsageFile(sessionsRoot);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { session?: Record<string, unknown> };
  const total = whole(parsed.session?.totalTokens);
  if (total === 0 && parsed.session === undefined) {
    throw new Error("usage.json has no session");
  }
  return { totalTokens: total };
}

function newestUsageFile(sessionsRoot: string): string {
  let best: { mtime: number; path: string } | null = null;
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
      if (entry.name !== "usage.json") {
        continue;
      }
      const mtime = statSync(path).mtimeMs;
      if (best === null || mtime > best.mtime) {
        best = { mtime, path };
      }
    }
  }
  if (best === null) {
    throw new Error("no grok usage.json");
  }
  return best.path;
}

function whole(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
