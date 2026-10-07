#!/usr/bin/env bun

import { registerConfiguredAgents } from "./agents/config.ts";
import { agentById, defaultAgentId } from "./agents/registry.ts";
import { callerOpenedPaths } from "./session-ref.ts";

await registerConfiguredAgents();

const agentId = process.argv[2] ?? defaultAgentId;
const sessionId = process.argv[3];
const counted = agentById(agentId).countTokens({
    sessionId,
    openedPaths: callerOpenedPaths(process.ppid),
});
console.log(`Computed era-tokens for ${counted.session}:`, counted.eraTokens);
