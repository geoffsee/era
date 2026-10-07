import { Readable } from "node:stream";

import { agentById, defaultAgentId, knownAgentIds } from "./agents/registry.ts";

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
  eraTokens: number;
}

/** Era-tokens for an agent's latest session. */
export function sessionTokenUsage(agentId = defaultAgentId): SessionTokenUsage {
  const agent = agentById(agentId);
  return { agent: agent.id, eraTokens: agent.countTokens() };
}

const usageOutputSchema = {
  type: "object",
  properties: {
    agent: {
      type: "string",
      description: "Agent whose latest session was counted.",
    },
    eraTokens: {
      type: "integer",
      minimum: 0,
      description: "Sum of usage counters for that session.",
    },
  },
  required: ["agent", "eraTokens"],
  additionalProperties: false,
} as const;

const sessionTokenUsageTool = {
  name: "session_token_usage",
  title: "Session token usage",
  description: "Report era-tokens used by an agent's latest session.",
  inputSchema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        enum: knownAgentIds(),
        description: `Agent id. Defaults to ${defaultAgentId}.`,
      },
    },
    additionalProperties: false,
  },
  outputSchema: usageOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

if (import.meta.main) {
  await serve();
}

/** Read JSON-RPC from stdin and write responses to stdout. */
export async function serve(): Promise<void> {
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

function dispatch(line: string): void {
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
      respond(id, { tools: [sessionTokenUsageTool] });
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
    typeof requested === "string" &&
    protocolVersions.some((version) => version === requested)
      ? requested
      : protocolVersions[0];
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo,
    instructions:
      "Call session_token_usage to report era-tokens for an agent's latest session. Omit agent to use the default agent.",
  };
}

function callTool(params: unknown): unknown {
  if (!isRecord(params) || typeof params.name !== "string") {
    throw new RpcError(-32602, "tools/call requires a tool name");
  }
  if (params.name !== sessionTokenUsageTool.name) {
    throw new RpcError(-32602, `unknown tool: ${params.name}`);
  }
  const agentId = agentArgument(params.arguments);
  try {
    const usage = sessionTokenUsage(agentId);
    return {
      content: [{ type: "text", text: JSON.stringify(usage) }],
      structuredContent: usage,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("unknown agent ")) {
      throw new RpcError(-32602, error.message);
    }
    return {
      content: [{ type: "text", text: errorText(error) }],
      isError: true,
    };
  }
}

function agentArgument(value: unknown): string {
  if (value === undefined) {
    return defaultAgentId;
  }
  if (!isRecord(value)) {
    throw new RpcError(-32602, "tool arguments must be an object");
  }
  const unexpected = Object.keys(value).filter((key) => key !== "agent");
  if (unexpected.length > 0) {
    throw new RpcError(-32602, `unexpected argument: ${unexpected.join(", ")}`);
  }
  const agent = value.agent;
  if (agent === undefined) {
    return defaultAgentId;
  }
  if (typeof agent !== "string") {
    throw new RpcError(-32602, "agent must be a string");
  }
  return agent;
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
