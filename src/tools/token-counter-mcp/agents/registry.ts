import type { AgentRunner } from "../agent.ts";
import { antigravity } from "./antigravity.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { grok } from "./grok.ts";
import { hermes } from "./hermes.ts";

/** Built-in agents. Configured agents are appended by `useConfiguredAgents`. */
const builtinAgents: readonly AgentRunner[] = [antigravity, cursor, grok, codex, claude, hermes];
let configuredAgents: readonly AgentRunner[] = [];

export const defaultAgentId = antigravity.id;

/** Replace agents loaded from config. A configured id must not repeat a built-in id. */
export function useConfiguredAgents(agents: readonly AgentRunner[]): void {
    for (const agent of agents) {
        if (builtinAgents.some((builtin) => builtin.id === agent.id)) {
            throw new Error(`agent "${agent.id}" is already built in`);
        }
    }
    configuredAgents = agents;
}

export function knownAgentIds(): readonly string[] {
    return allAgents().map((agent) => agent.id);
}

export function agentById(id: string): AgentRunner {
    const found = allAgents().find((agent) => agent.id === id);
    if (found === undefined) {
        const known = allAgents()
            .map((agent) => agent.id)
            .join(", ");
        throw new Error(`unknown agent "${id}" (known: ${known})`);
    }
    return found;
}

function allAgents(): readonly AgentRunner[] {
    return [...builtinAgents, ...configuredAgents];
}
