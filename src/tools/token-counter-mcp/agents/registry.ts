import type { AgentRunner } from "../agent.ts";
import { antigravity } from "./antigravity.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { grok } from "./grok.ts";
import { hermes } from "./hermes.ts";

/** Add an agent by defining it and appending it here. */
const agents: readonly AgentRunner[] = [antigravity, cursor, grok, codex, claude, hermes];

export const defaultAgentId = antigravity.id;

export function knownAgentIds(): readonly string[] {
  return agents.map((agent) => agent.id);
}

export function agentById(id: string): AgentRunner {
  const found = agents.find((agent) => agent.id === id);
  if (found === undefined) {
    const known = agents.map((agent) => agent.id).join(", ");
    throw new Error(`unknown agent "${id}" (known: ${known})`);
  }
  return found;
}
