import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configuredAgents, loadConfiguredAgents } from "./config.ts";
import { useConfiguredAgents } from "./registry.ts";

describe("configured agents", () => {
    test("reads name and path entries", () => {
        expect(configuredAgents({ version: 1, agents: [{ name: "opencode", path: "./opencode.js" }] })).toEqual([
            { name: "opencode", path: "./opencode.js" },
        ]);
        expect(configuredAgents({ version: 1, roadmap: {} })).toEqual([]);
    });

    test("rejects a malformed agents section", () => {
        expect(() => configuredAgents({ agents: { opencode: "./opencode.js" } })).toThrow("agents must be an array");
        expect(() => configuredAgents({ agents: [{ name: "", path: "./a.js" }] })).toThrow(
            "each agent needs a name and a path",
        );
        expect(() =>
            configuredAgents({
                agents: [
                    { name: "opencode", path: "./a.js" },
                    { name: "opencode", path: "./b.js" },
                ],
            }),
        ).toThrow('duplicate agent "opencode"');
    });

    test("loads a javascript file that implements the agent interface", async () => {
        const directory = mkdtempSync(join(tmpdir(), "agent-config-"));
        const source = join(directory, "sample-agent.js");
        writeFileSync(
            source,
            `export default {
                id: "sample",
                select() { return { session: "one", records: [4, 5] }; },
                decoder: { tokens(record) { return record; } },
            };`,
        );
        writeFileSync(
            join(directory, "era.config.json"),
            JSON.stringify({ version: 1, agents: [{ name: "sample", path: "./sample-agent.js" }] }),
        );

        const [agent] = await loadConfiguredAgents(join(directory, "era.config.json"));
        expect(agent?.id).toBe("sample");
        expect(agent?.countTokens({ openedPaths: [] })).toEqual({ session: "one", eraTokens: 9 });
    });

    test("rejects a module that does not match the interface, a mismatched id, a missing file, or a built-in name", async () => {
        const directory = mkdtempSync(join(tmpdir(), "agent-config-"));
        writeFileSync(join(directory, "broken.js"), "export default { id: 'sample' };");
        writeFileSync(
            join(directory, "renamed.js"),
            "export const agent = { id: 'other', select() { return { session: 's', records: [] }; }, decoder: { tokens() { return 0; } } };",
        );
        const config = join(directory, "era.config.json");

        writeFileSync(config, JSON.stringify({ agents: [{ name: "sample", path: "./broken.js" }] }));
        await expect(loadConfiguredAgents(config)).rejects.toThrow('agent "sample" does not match the agent interface');

        writeFileSync(config, JSON.stringify({ agents: [{ name: "sample", path: "./renamed.js" }] }));
        await expect(loadConfiguredAgents(config)).rejects.toThrow('agent "sample" exports id "other"');

        writeFileSync(config, JSON.stringify({ agents: [{ name: "sample", path: "./missing.js" }] }));
        await expect(loadConfiguredAgents(config)).rejects.toThrow("agent file not found: ./missing.js");

        writeFileSync(
            join(directory, "grok.js"),
            "export default { id: 'grok', select() { return { session: 's', records: [] }; }, decoder: { tokens() { return 0; } } };",
        );
        writeFileSync(config, JSON.stringify({ agents: [{ name: "grok", path: "./grok.js" }] }));
        const [builtin] = await loadConfiguredAgents(config);
        expect(() => useConfiguredAgents([builtin!])).toThrow('agent "grok" is already built in');
    });
});
