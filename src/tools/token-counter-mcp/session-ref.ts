import { execFileSync } from "node:child_process";
import { dirname, sep } from "node:path";

import type { SessionRef } from "./agent.ts";

export interface NamedPath {
    id: string;
    path: string;
}

/** `file` matches the session file itself. `directory` matches any open path inside its parent. */
export function selectNamedPath(
    agent: string,
    found: readonly NamedPath[],
    ref: SessionRef,
    root: string,
    kind: "file" | "directory",
): NamedPath {
    const matches =
        ref.sessionId !== undefined
            ? found.filter((item) => item.id === ref.sessionId)
            : found.filter((item) => openedUnder(root, ref.openedPaths).some((path) => pathMatches(item, path, kind)));
    if (matches.length === 1) {
        return matches[0]!;
    }
    const ids = [...new Set(matches.map((item) => item.id))].sort();
    if (ref.sessionId !== undefined) {
        throw new Error(
            matches.length === 0
                ? `unknown ${agent} session "${ref.sessionId}"`
                : `multiple ${agent} sessions: ${ids.join(", ")}`,
        );
    }
    throw new Error(
        matches.length === 0
            ? `no ${agent} session for this process; pass session`
            : `multiple ${agent} sessions for this process: ${ids.join(", ")}`,
    );
}

/** Files open in `pid` and its ancestors, stopping before pid 1. */
export function callerOpenedPaths(pid: number): string[] {
    const paths: string[] = [];
    const seen = new Set<number>();
    let current: number | undefined = pid;
    while (current !== undefined && current > 1 && !seen.has(current)) {
        seen.add(current);
        paths.push(...openPaths(current));
        current = parentPid(current);
    }
    return paths;
}

function openedUnder(root: string, openedPaths: readonly string[]): string[] {
    const prefix = root.endsWith(sep) ? root : root + sep;
    return openedPaths.filter((path) => path === root || path.startsWith(prefix));
}

function pathMatches(item: NamedPath, opened: string, kind: "file" | "directory"): boolean {
    if (kind === "file") {
        return opened === item.path;
    }
    const directory = dirname(item.path);
    return opened === item.path || opened.startsWith(directory + sep);
}

function openPaths(pid: number): string[] {
    let output = "";
    try {
        output = execFileSync("lsof", ["-Fn", "-a", "-p", String(pid)], { encoding: "utf8" });
    } catch (error) {
        output = stdoutOf(error);
        if (output.trim().length === 0 && !isEmptyListing(error)) {
            throw new Error(`cannot inspect process ${pid}`);
        }
    }
    return output.split("\n").flatMap((line) => (line.startsWith("n") ? [line.slice(1)] : []));
}

const sessionKey = /^(?:session|sessionId|session_id|SESSION|SESSION_ID)$/;

/** Session id carried on a process command line, when exactly one is present. */
export function sessionFromCommandText(command: string): string | undefined {
    const found = new Set<string>();
    for (const token of command.split(/\s+/)) {
        const split = token.indexOf("=");
        if (split <= 0) {
            continue;
        }
        const key = token.slice(0, split);
        const value = token.slice(split + 1);
        if (sessionKey.test(key) && value.length > 0) {
            found.add(value);
        }
    }
    if (found.size !== 1) {
        return undefined;
    }
    return [...found][0];
}

/** Session id from the environment of `pid` or an ancestor, when exactly one is present. */
export function sessionFromProcess(pid: number): string | undefined {
    const found = new Set<string>();
    const seen = new Set<number>();
    let current: number | undefined = pid;
    while (current !== undefined && current > 1 && !seen.has(current)) {
        seen.add(current);
        const command = processCommand(current);
        const session = command === undefined ? undefined : sessionFromCommandText(command);
        if (session !== undefined) {
            found.add(session);
        }
        current = parentPid(current);
    }
    if (found.size !== 1) {
        return undefined;
    }
    return [...found][0];
}

function processCommand(pid: number): string | undefined {
    try {
        return execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
    } catch {
        return undefined;
    }
}

function parentPid(pid: number): number | undefined {
    let output = "";
    try {
        output = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
    } catch {
        return undefined;
    }
    const parent = Number(output.trim());
    return Number.isInteger(parent) && parent > 1 ? parent : undefined;
}

function stdoutOf(error: unknown): string {
    if (typeof error === "object" && error !== null && "stdout" in error) {
        const stdout = error.stdout;
        if (typeof stdout === "string") {
            return stdout;
        }
        if (stdout instanceof Uint8Array) {
            return new TextDecoder().decode(stdout);
        }
    }
    return "";
}

function isEmptyListing(error: unknown): boolean {
    return typeof error === "object" && error !== null && "status" in error && error.status === 1;
}
