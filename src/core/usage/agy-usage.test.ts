import { describe, expect, test } from "bun:test";
import {
    type AgentStep,
    attributeConversation,
    commandLines,
    formatDuration,
    formatTokenCount,
    pullRequestFromCommand,
    pullRequestFromToolResult,
    usageFromMetadata,
} from "./agy-usage.ts";

const branches = new Map([
    ["e07-02-credentials", 224],
    ["feat/portainer-generate-bootstrap-resources", 262],
]);

describe("agy usage", () => {
    test("reads prompt, cache, completion, and thinking tokens from a model step", () => {
        const usage = usageFromMetadata(metadata({ 1: 10, 3: 4, 5: 20, 6: 1 }));
        expect(usage).toEqual({
            uncachedInputTokens: 10,
            cacheReadTokens: 20,
            outputTokens: 5,
            thinkingTokens: 1,
        });
    });

    test("uses the last pull request a command names", () => {
        expect(pullRequestFromCommand("gh pr checks 262", branches)).toBe(262);
        expect(pullRequestFromCommand("gh pr diff 224; gh pr diff 225", branches)).toBe(225);
        expect(pullRequestFromCommand("git checkout e07-02-credentials", branches)).toBe(224);
        expect(pullRequestFromCommand("git checkout main -- tools/dev/src/lib.rs", branches)).toBeNull();
    });

    test("reads the branch and the pull URL from the tool result", () => {
        const checkout = pullRequestFromToolResult(
            "On branch e07-02-credentials\n",
            ["git status"],
            branches,
            "geoffsee/rubix-kube",
        );
        const created = pullRequestFromToolResult(
            "https://github.com/geoffsee/rubix-kube/pull/262\n",
            ["gh pr create"],
            branches,
            "geoffsee/rubix-kube",
        );
        expect(checkout).toBe(224);
        expect(created).toBe(262);
    });

    test("attributes model steps after the command that selects the pull request", () => {
        const steps: AgentStep[] = [
            { type: 15, metadata: metadata({ 1: 3, 3: 1, 5: 0, 6: 0 }), payload: null, model: "claude-sonnet-4-6" },
            {
                type: 132,
                metadata: null,
                payload: text('{"CommandLine":"gh pr checks 262","Cwd":"/tmp"} result'),
                model: null,
            },
            { type: 15, metadata: metadata({ 1: 7, 3: 1, 5: 4, 6: 1 }), payload: null, model: "claude-sonnet-4-6" },
        ];
        const attributed = attributeConversation(steps, branches, "geoffsee/rubix-kube");
        expect(attributed.orchestration.turns).toBe(1);
        expect(attributed.orchestration.uncachedInputTokens).toBe(3);
        expect(attributed.byPullRequest.get(262)?.uncachedInputTokens).toBe(7);
        expect(attributed.byPullRequest.get(262)?.cacheReadTokens).toBe(4);
        expect(attributed.byPullRequest.get(262)?.outputTokens).toBe(2);
    });

    test("starts a subagent on the single pull request named in its task", () => {
        const steps: AgentStep[] = [
            {
                type: 101,
                metadata: null,
                payload: text("<original_task>Finish PR #262.</original_task>"),
                model: null,
            },
            { type: 15, metadata: metadata({ 1: 5, 3: 1, 5: 0, 6: 0 }), payload: null, model: null },
        ];
        const attributed = attributeConversation(steps, branches, "geoffsee/rubix-kube");
        expect(attributed.byPullRequest.get(262)?.uncachedInputTokens).toBe(5);
        expect(attributed.orchestration.turns).toBe(0);
    });

    test("parses a command line out of a tool payload", () => {
        expect(commandLines('prefix {"CommandLine":"git status","Cwd":"/tmp"} tail')).toEqual(["git status"]);
    });

    test("formats token totals and durations the way the extracts display them", () => {
        expect(formatTokenCount(0)).toBe("0");
        expect(formatTokenCount(19_856)).toBe("19.9k");
        expect(formatTokenCount(8_115_725)).toBe("8.12M");
        expect(formatTokenCount(1_809_501_232)).toBe("1.81B");
        expect(formatDuration(37)).toBe("37s");
        expect(formatDuration(383)).toBe("6m 23s");
        expect(formatDuration(3723)).toBe("1h 2m 3s");
    });
});

function metadata(fields: Record<number, number>): Uint8Array {
    const inner: number[] = [];
    for (const [field, value] of Object.entries(fields)) {
        inner.push(...varint((Number(field) << 3) | 0), ...varint(value));
    }
    return Uint8Array.from([...varint((9 << 3) | 2), ...varint(inner.length), ...inner]);
}

function varint(value: number): number[] {
    const bytes: number[] = [];
    let remaining = value;
    while (remaining > 127) {
        bytes.push((remaining & 127) | 128);
        remaining = Math.floor(remaining / 128);
    }
    bytes.push(remaining);
    return bytes;
}

function text(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}
