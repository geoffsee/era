#!/usr/bin/env bun

import { agentById, defaultAgentId } from "./agents/registry.ts";

const agentId = process.argv[2] ?? defaultAgentId;
const total = agentById(agentId).countTokens();
console.log("Computed era-tokens:", total);
