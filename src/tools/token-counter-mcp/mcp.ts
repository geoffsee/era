import { Readable } from "node:stream";

import { registerConfiguredAgents } from "./agents/config.ts";
import { agentById, defaultAgentId, knownAgentIds } from "./agents/registry.ts";
import { callerOpenedPaths, sessionFromProcess } from "./session-ref.ts";
import { TaskMiss } from "./task-match.ts";

const protocolVersions = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const serverInfo = { name: "era-tokens", version: "0.1.0" };

class RpcError extends Error {
    constructor(
        readonly code: number,
        message: string,
    ) {
        super(message);
    }
}

export interface SessionTokenUsage {
    agent: string;
    session: string;
    eraTokens: number;
}

export interface EraTokens extends SessionTokenUsage {
    task: string;
}

/** Session id for an agent. A task identifier outranks process metadata. */
export function getSession(
    agentId = defaultAgentId,
    taskId?: string,
    metadataSession?: string,
): { agent: string; session: string } {
    const agent = agentById(agentId);
    if (taskId !== undefined && taskId.length > 0) {
        try {
            return { agent: agent.id, session: agent.session({ taskId, openedPaths: [] }) };
        } catch (error) {
            if (!(error instanceof TaskMiss)) {
                throw error;
            }
        }
    }
    const sessionId = metadataSession ?? sessionFromProcess(process.ppid);
    return {
        agent: agent.id,
        session: agent.session({ sessionId, openedPaths: callerOpenedPaths(process.ppid) }),
    };
}

/** Era-tokens for one known session. */
export function getTokens(agentId = defaultAgentId, sessionId: string): SessionTokenUsage {
    const agent = agentById(agentId);
    const counted = agent.countTokens({ sessionId, openedPaths: [] });
    return { agent: agent.id, session: counted.session, eraTokens: counted.eraTokens };
}

/** Era-tokens for one roadmap task: resolve the session, then count it. */
export function getEraTokens(taskId: string, agentId = defaultAgentId, metadataSession?: string): EraTokens {
    const selected = getSession(agentId, taskId, metadataSession);
    return { ...getTokens(selected.agent, selected.session), task: taskId };
}

/** Session id carried on the MCP call metadata, when the agent already knows it. */
export function sessionFromMeta(meta: unknown): string | undefined {
    if (!isRecord(meta)) {
        return undefined;
    }
    for (const key of ["session", "sessionId", "session_id"]) {
        const value = meta[key];
        if (typeof value === "string" && value.length > 0) {
            return value;
        }
    }
    return undefined;
}

const usageOutputSchema = {
    type: "object",
    properties: {
        agent: {
            type: "string",
            description: "Agent whose session was counted.",
        },
        session: {
            type: "string",
            description: "Session id that was counted.",
        },
        eraTokens: {
            type: "integer",
            minimum: 0,
            description: "Sum of usage counters for that session.",
        },
    },
    required: ["agent", "session", "eraTokens"],
    additionalProperties: false,
} as const;

const toolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
} as const;

function agentProperty() {
    return {
        type: "string",
        enum: knownAgentIds(),
        description: `Agent id. Defaults to ${defaultAgentId}.`,
    };
}

function eraTokenTools() {
    return [
        {
            name: "get_era_tokens",
            title: "Era-tokens for a task",
            description: "Era-tokens for one roadmap task. Resolves the agent session, then counts that session.",
            inputSchema: {
                type: "object",
                properties: {
                    task: {
                        type: "string",
                        description:
                            "Task identifier. The session whose text contains it nearest the start is counted.",
                    },
                    agent: agentProperty(),
                },
                required: ["task"],
                additionalProperties: false,
            },
            outputSchema: {
                type: "object",
                properties: {
                    ...usageOutputSchema.properties,
                    task: { type: "string", description: "Task identifier that was counted." },
                },
                required: ["agent", "session", "task", "eraTokens"],
                additionalProperties: false,
            },
            annotations: toolAnnotations,
        },
        {
            name: "get_session",
            title: "Session id",
            description:
                "Session id for an agent. Pass task to select by that identifier. A session in the call metadata is used when the agent already knows it.",
            inputSchema: {
                type: "object",
                properties: {
                    agent: agentProperty(),
                    task: {
                        type: "string",
                        description: "Task identifier used to select the session.",
                    },
                },
                additionalProperties: false,
            },
            outputSchema: {
                type: "object",
                properties: {
                    agent: usageOutputSchema.properties.agent,
                    session: usageOutputSchema.properties.session,
                },
                required: ["agent", "session"],
                additionalProperties: false,
            },
            annotations: toolAnnotations,
        },
        {
            name: "get_tokens",
            title: "Session tokens",
            description: "Era-tokens for one agent session.",
            inputSchema: {
                type: "object",
                properties: {
                    agent: agentProperty(),
                    session: {
                        type: "string",
                        description: "Session id returned by get_session.",
                    },
                },
                required: ["session"],
                additionalProperties: false,
            },
            outputSchema: usageOutputSchema,
            annotations: toolAnnotations,
        },
    ];
}

if (import.meta.main) {
    await serve();
}

/** Read JSON-RPC from stdin and write responses to stdout. */
export async function serve(configPath?: string): Promise<void> {
    await registerConfiguredAgents(configPath);
    const reader = Readable.toWeb(process.stdin).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            buffer += decoder.decode();
            if (buffer.trim().length > 0) {
                dispatch(buffer);
            }
            return;
        }
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
            const line = buffer.slice(0, newline).replace(/\r$/, "");
            buffer = buffer.slice(newline + 1);
            if (line.trim().length > 0) {
                dispatch(line);
            }
            newline = buffer.indexOf("\n");
        }
    }
}

type JsonRpcId = string | number | null;

export function dispatch(line: string): void {
    let message: unknown;
    try {
        message = JSON.parse(line);
    } catch {
        fail(null, -32700, "parse error");
        return;
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        fail(idOf(message) ?? null, -32600, "invalid request");
        return;
    }
    const id = idOf(message);
    const method = message.method;
    if (id === undefined) {
        return;
    }
    try {
        if (method === "initialize") {
            respond(id, initialize(message.params));
            return;
        }
        if (method === "ping") {
            respond(id, {});
            return;
        }
        if (method === "tools/list") {
            respond(id, { tools: eraTokenTools() });
            return;
        }
        if (method === "tools/call") {
            respond(id, callTool(message.params));
            return;
        }
        fail(id, -32601, `method not found: ${method}`);
    } catch (error) {
        if (error instanceof RpcError) {
            fail(id, error.code, error.message);
            return;
        }
        fail(id, -32603, errorText(error));
    }
}

function initialize(params: unknown): unknown {
    const requested = isRecord(params) ? params.protocolVersion : undefined;
    const protocolVersion =
        typeof requested === "string" && protocolVersions.some((version) => version === requested)
            ? requested
            : protocolVersions[0];
    return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions:
            "Call get_era_tokens with a task identifier. It resolves the session with get_session, then counts it with get_tokens. Pass the session in call metadata when the agent already knows it.",
    };
}

function callTool(params: unknown): unknown {
    if (!isRecord(params) || typeof params.name !== "string") {
        throw new RpcError(-32602, "tools/call requires a tool name");
    }
    const known = eraTokenTools().some((tool) => tool.name === params.name);
    if (!known) {
        throw new RpcError(-32602, `unknown tool: ${params.name}`);
    }
    const metadataSession = sessionFromMeta(params._meta);
    try {
        const usage = runTool(params.name, params.arguments, metadataSession);
        return {
            content: [{ type: "text", text: JSON.stringify(usage) }],
            structuredContent: usage,
        };
    } catch (error) {
        if (error instanceof RpcError) {
            throw error;
        }
        if (error instanceof Error && error.message.startsWith("unknown agent ")) {
            throw new RpcError(-32602, error.message);
        }
        return {
            content: [{ type: "text", text: errorText(error) }],
            isError: true,
        };
    }
}

function runTool(name: string, args: unknown, metadataSession?: string): unknown {
    if (name === "get_era_tokens") {
        const { agentId, taskId } = toolFields(args, ["agent", "task"]);
        if (taskId === undefined || taskId.length === 0) {
            throw new RpcError(-32602, "task must be a string");
        }
        return getEraTokens(taskId, agentId, metadataSession);
    }
    if (name === "get_session") {
        const { agentId, taskId } = toolFields(args, ["agent", "task"]);
        return getSession(agentId, taskId, metadataSession);
    }
    const { agentId, sessionId } = toolFields(args, ["agent", "session"]);
    if (sessionId === undefined || sessionId.length === 0) {
        throw new RpcError(-32602, "session must be a string");
    }
    return getTokens(agentId, sessionId);
}

function toolFields(
    value: unknown,
    allowed: readonly string[],
): { agentId: string; taskId?: string; sessionId?: string } {
    if (value === undefined) {
        return { agentId: defaultAgentId };
    }
    if (!isRecord(value)) {
        throw new RpcError(-32602, "tool arguments must be an object");
    }
    const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unexpected.length > 0) {
        throw new RpcError(-32602, `unexpected argument: ${unexpected.join(", ")}`);
    }
    const agent = value.agent;
    if (agent !== undefined && typeof agent !== "string") {
        throw new RpcError(-32602, "agent must be a string");
    }
    const task = value.task;
    if (task !== undefined && typeof task !== "string") {
        throw new RpcError(-32602, "task must be a string");
    }
    const session = value.session;
    if (session !== undefined && typeof session !== "string") {
        throw new RpcError(-32602, "session must be a string");
    }
    return { agentId: agent ?? defaultAgentId, taskId: task, sessionId: session };
}

function respond(id: JsonRpcId, result: unknown): void {
    write({ jsonrpc: "2.0", id, result });
}

function fail(id: JsonRpcId, code: number, message: string): void {
    write({ jsonrpc: "2.0", id, error: { code, message } });
}

function write(message: unknown): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function idOf(message: unknown): JsonRpcId | undefined {
    if (!isRecord(message) || !Object.hasOwn(message, "id")) {
        return undefined;
    }
    const id = message.id;
    if (id === null || typeof id === "string" || typeof id === "number") {
        return id;
    }
    return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : "session token usage failed";
}
