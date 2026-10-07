import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { defineAgent, type SessionRef } from "../agent.ts";
import { protobufDecoder } from "../protobuf.ts";
import { selectNamedPath } from "../session-ref.ts";
import { selectByTask } from "../task-match.ts";

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
    select(ref) {
        const conversation = selectConversation(root, ref);
        return { session: conversation.id, records: readUsageMetadata(conversation.path) };
    },
});

export function readConversationUsage(dataRoot: string, ref: SessionRef): { session: string; records: Uint8Array[] } {
    const conversation = selectConversation(dataRoot, ref);
    return { session: conversation.id, records: readUsageMetadata(conversation.path) };
}

function selectConversation(dataRoot: string, ref: SessionRef): { id: string; path: string } {
    const found = conversations(dataRoot);
    if (ref.taskId !== undefined && ref.taskId.length > 0 && ref.sessionId === undefined) {
        return selectByTask("antigravity", found, ref.taskId, (item) => readFileSync(item.path, "latin1"));
    }
    return selectNamedPath("antigravity", found, ref, dataRoot, "file");
}

function conversations(dataRoot: string): { id: string; path: string }[] {
    const directory = join(dataRoot, "conversations");
    return readdirSync(directory)
        .filter((name) => name.endsWith(".db"))
        .map((name) => ({ id: basename(name, ".db"), path: join(directory, name) }));
}

function readUsageMetadata(databasePath: string): Uint8Array[] {
    const conversation = new DatabaseSync(databasePath, { readOnly: true });
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
