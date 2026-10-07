import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

import { defineAgent } from "../agent.ts";

const root = join(homedir(), ".hermes", "state.db");

type HermesSessionUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * Hermes keeps session counters in `state.db`. Input, cache read, and cache
 * write are separate. Output already includes reasoning tokens.
 */
export const hermes = defineAgent({
  id: "hermes",
  decoder: {
    tokens(record: HermesSessionUsage) {
      return record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens;
    },
  },
  records(): Iterable<HermesSessionUsage> {
    return [readLatestSession(root)];
  },
});

function readLatestSession(databasePath: string): HermesSessionUsage {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const row = database
    .prepare(
      `SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
       FROM sessions
       ORDER BY COALESCE(last_activity_at, started_at) DESC
       LIMIT 1`,
    )
    .get() as
    | {
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
      }
    | undefined;
  database.close();
  if (row === undefined) {
    throw new Error("no hermes sessions");
  }
  return {
    inputTokens: whole(row.input_tokens),
    outputTokens: whole(row.output_tokens),
    cacheReadTokens: whole(row.cache_read_tokens),
    cacheWriteTokens: whole(row.cache_write_tokens),
  };
}

function whole(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
