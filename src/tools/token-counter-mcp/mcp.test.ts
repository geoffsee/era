import { describe, expect, test } from "bun:test";

import { dispatch, sessionFromMeta } from "./mcp.ts";

describe("era-tokens JSON-RPC", () => {
    test("rejects a line that is not JSON", () => {
        const [response] = capture(() => {
            dispatch("not-json");
        });

        expect(response).toEqual({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "parse error" },
        });
    });

    test("rejects a request that is not JSON-RPC 2.0", () => {
        const [response] = capture(() => {
            dispatch(request({ id: 4, method: "ping" }));
        });

        expect(response).toMatchObject({ id: 4, error: { code: -32600, message: "invalid request" } });
    });

    test("ignores a notification that has no id", () => {
        const lines = capture(() => {
            dispatch(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
        });

        expect(lines).toEqual([]);
    });

    test("echoes a supported protocol version and falls back otherwise", () => {
        const [supported] = capture(() => {
            dispatch(
                request({ jsonrpc: "2.0", id: "a", method: "initialize", params: { protocolVersion: "2024-11-05" } }),
            );
        });
        const [fallback] = capture(() => {
            dispatch(
                request({ jsonrpc: "2.0", id: "b", method: "initialize", params: { protocolVersion: "1999-01-01" } }),
            );
        });

        expect(supported).toMatchObject({
            id: "a",
            result: { protocolVersion: "2024-11-05", serverInfo: { name: "era-tokens" } },
        });
        expect(fallback).toMatchObject({ id: "b", result: { protocolVersion: "2025-06-18" } });
    });

    test("answers ping and lists the session token tool", () => {
        const [pong] = capture(() => {
            dispatch(request({ jsonrpc: "2.0", id: 1, method: "ping" }));
        });
        const [listed] = capture(() => {
            dispatch(request({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
        });

        expect(pong).toMatchObject({ id: 1, result: {} });
        expect(listed).toMatchObject({
            id: 2,
            result: {
                tools: [{ name: "get_era_tokens" }, { name: "get_session" }, { name: "get_tokens" }],
            },
        });
    });

    test("reports an unknown method", () => {
        const [response] = capture(() => {
            dispatch(request({ jsonrpc: "2.0", id: 8, method: "resources/list" }));
        });

        expect(response).toMatchObject({ id: 8, error: { code: -32601, message: "method not found: resources/list" } });
    });

    test("rejects a tool call that names an unknown tool or agent", () => {
        const [tool] = capture(() => {
            dispatch(call(1, "other_tool", {}));
        });
        const [agent] = capture(() => {
            dispatch(call(2, "get_era_tokens", { agent: "missing", task: "#12" }));
        });

        expect(tool).toMatchObject({ id: 1, error: { code: -32602, message: "unknown tool: other_tool" } });
        expect(agent).toMatchObject({
            id: 2,
            error: { code: -32602, message: expect.stringContaining('unknown agent "missing"') },
        });
    });

    test("rejects tool arguments that are not the agent string", () => {
        const [shape] = capture(() => {
            dispatch(call(1, "get_era_tokens", []));
        });
        const [extra] = capture(() => {
            dispatch(call(2, "get_era_tokens", { agent: "grok", task: "#12", extra: true }));
        });
        const [type] = capture(() => {
            dispatch(call(3, "get_era_tokens", { agent: 1, task: "#12" }));
        });

        expect(shape).toMatchObject({ error: { code: -32602, message: "tool arguments must be an object" } });
        expect(extra).toMatchObject({ error: { code: -32602, message: "unexpected argument: extra" } });
        expect(type).toMatchObject({ error: { code: -32602, message: "agent must be a string" } });
    });

    test("rejects a session argument that is not a string", () => {
        const [response] = capture(() => {
            dispatch(call(1, "get_tokens", { session: 4 }));
        });

        expect(response).toMatchObject({ error: { code: -32602, message: "session must be a string" } });
    });

    test("requires a task string for era-tokens", () => {
        const [missing] = capture(() => {
            dispatch(call(1, "get_era_tokens", {}));
        });
        const [type] = capture(() => {
            dispatch(call(2, "get_era_tokens", { task: 12 }));
        });

        expect(missing).toMatchObject({ error: { code: -32602, message: "task must be a string" } });
        expect(type).toMatchObject({ error: { code: -32602, message: "task must be a string" } });
    });

    test("reads a session id from call metadata", () => {
        expect(sessionFromMeta({ sessionId: "abc" })).toBe("abc");
        expect(sessionFromMeta({ progressToken: 1 })).toBeUndefined();
    });
});

function request(message: unknown): string {
    return JSON.stringify(message);
}

function call(id: number, name: string, args: unknown): string {
    return request({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

function capture(run: () => void): unknown[] {
    const lines: unknown[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
        lines.push(JSON.parse(String(chunk)));
        return true;
    }) as typeof process.stdout.write;
    try {
        run();
    } finally {
        process.stdout.write = write;
    }
    return lines;
}
