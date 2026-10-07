import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defineAgent } from "../agent.ts";

const root = join(homedir(), ".codex");

/**
 * Codex stores the latest thread total on `threads.tokens_used`. That column
 * matches rollout `total_tokens`, which is input plus output.
 */
export const codex = defineAgent({
  id: "codex",
  decoder: {
    tokens(record: number) {
      return record;
    },
  },
  records(): Iterable<number> {
    return [readLatestThreadTokens(root)];
  },
});

function readLatestThreadTokens(codexHome: string): number {
  const database = new DatabaseSync(statePath(codexHome), { readOnly: true });
  const row = database
    .prepare("SELECT tokens_used FROM threads ORDER BY updated_at DESC LIMIT 1")
    .get() as { tokens_used: number } | undefined;
  database.close();
  if (row === undefined) {
    throw new Error("no codex threads");
  }
  return whole(row.tokens_used);
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

function whole(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
