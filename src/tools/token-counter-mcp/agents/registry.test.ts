import { describe, expect, test } from "bun:test";

import { agentById, defaultAgentId, knownAgentIds } from "./registry.ts";

describe("agent registry", () => {
    test("lists the built-in agents and defaults to antigravity", () => {
        expect(knownAgentIds()).toEqual(["antigravity", "cursor", "grok", "codex", "claude", "hermes"]);
        expect(defaultAgentId).toBe("antigravity");
        expect(agentById("claude").id).toBe("claude");
    });

    test("names the known agents when the id is missing", () => {
        expect(() => agentById("missing")).toThrow(
            'unknown agent "missing" (known: antigravity, cursor, grok, codex, claude, hermes)',
        );
    });
});
