import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

import { defineAgent } from "../agent.ts";
import { protobufDecoder } from "../protobuf.ts";

const root = join(homedir(), ".gemini", "antigravity-cli");

/**
 * Antigravity stores one SQLite database per conversation. Step type 15 holds a
 * protobuf usage message in field 9, with counters in fields 1, 3, 5, and 6.
 */
export const antigravity = defineAgent({
  id: "antigravity",
  decoder: protobufDecoder({
    messageField: 9,
    counterFields: [1, 3, 5, 6],
  }),
  records(): Iterable<Uint8Array> {
    return readUsageMetadata(root);
  },
});

function readUsageMetadata(dataRoot: string): Uint8Array[] {
  const summaries = new DatabaseSync(join(dataRoot, "conversation_summaries.db"), {
    readOnly: true,
  });
  const latest = summaries
    .prepare(
      "SELECT conversation_id FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 1",
    )
    .get() as { conversation_id: string } | undefined;
  summaries.close();

  if (latest === undefined) {
    throw new Error("no conversation summaries");
  }

  const conversation = new DatabaseSync(
    join(dataRoot, "conversations", `${latest.conversation_id}.db`),
    { readOnly: true },
  );
  const rows = conversation
    .prepare("SELECT metadata FROM steps WHERE step_type = 15 AND metadata IS NOT NULL")
    .all() as Array<{ metadata: Uint8Array }>;
  conversation.close();

  return rows.map((row) => copyBlob(row.metadata));
}

function copyBlob(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error("metadata is not a blob");
  }
  return new Uint8Array(value);
}
