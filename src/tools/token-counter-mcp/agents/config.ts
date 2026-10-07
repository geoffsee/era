import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { defineAgent, type Agent, type AgentRunner } from "../agent.ts";
import { useConfiguredAgents } from "./registry.ts";

export interface ConfiguredAgent {
    name: string;
    path: string;
}

/** Read `agents` from an era config file. A missing file contributes no agents. */
export async function registerConfiguredAgents(configPath = join(process.cwd(), "era.config.json")): Promise<void> {
    if (!existsSync(configPath)) {
        return;
    }
    useConfiguredAgents(await loadConfiguredAgents(configPath));
}

/** Load each `{ name, path }` entry as an agent module. `path` is relative to the config file. */
export async function loadConfiguredAgents(configPath: string): Promise<AgentRunner[]> {
    const entries = configuredAgents(JSON.parse(readFileSync(configPath, "utf8")));
    const runners: AgentRunner[] = [];
    for (const entry of entries) {
        runners.push(await loadAgent(entry, configPath));
    }
    return runners;
}

export function configuredAgents(config: unknown): ConfiguredAgent[] {
    if (!isRecord(config) || config.agents === undefined) {
        return [];
    }
    if (!Array.isArray(config.agents)) {
        throw new Error("agents must be an array");
    }
    const names = new Set<string>();
    return config.agents.map((entry) => {
        if (
            !isRecord(entry) ||
            typeof entry.name !== "string" ||
            entry.name.length === 0 ||
            typeof entry.path !== "string" ||
            entry.path.length === 0
        ) {
            throw new Error("each agent needs a name and a path");
        }
        if (names.has(entry.name)) {
            throw new Error(`duplicate agent "${entry.name}"`);
        }
        names.add(entry.name);
        return { name: entry.name, path: entry.path };
    });
}

async function loadAgent(entry: ConfiguredAgent, configPath: string): Promise<AgentRunner> {
    const file = isAbsolute(entry.path) ? entry.path : resolve(dirname(configPath), entry.path);
    if (!existsSync(file) || !statSync(file).isFile()) {
        throw new Error(`agent file not found: ${entry.path}`);
    }
    const imported = (await import(pathToFileURL(file).href)) as { default?: unknown; agent?: unknown };
    const exported = imported.default ?? imported.agent;
    if (!isAgent(exported)) {
        throw new Error(`agent "${entry.name}" does not match the agent interface`);
    }
    if (exported.id !== entry.name) {
        throw new Error(`agent "${entry.name}" exports id "${exported.id}"`);
    }
    return defineAgent(exported);
}

function isAgent(value: unknown): value is Agent<unknown> {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.select !== "function") {
        return false;
    }
    const decoder = value.decoder;
    return isRecord(decoder) && typeof decoder.tokens === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
