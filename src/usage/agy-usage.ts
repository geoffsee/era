export type TokenCounts = {
    uncachedInputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    thinkingTokens: number;
};

export type UsageRollup = {
    turns: number;
    models: Set<string>;
    uncachedInputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    thinkingTokens: number;
};

export type AgentStep = {
    type: number;
    metadata: Uint8Array | null;
    payload: Uint8Array | null;
    model: string | null;
};

const PR_COMMAND =
    /\bgh\s+pr\s+(?:view|diff|checks|merge|checkout|close|comment|edit|ready|review|update|reopen)\s+(\d+)\b/g;
const CHECKOUT = /\bgit\s+(?:checkout|switch)\s+(?:-[bBcC]\s+)?(?!-)([A-Za-z0-9._/-]+)/g;

export function emptyRollup(): UsageRollup {
    return {
        turns: 0,
        models: new Set(),
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
    };
}

export function addUsage(rollup: UsageRollup, usage: TokenCounts, model: string | null): void {
    rollup.turns += 1;
    rollup.uncachedInputTokens += usage.uncachedInputTokens;
    rollup.cacheReadTokens += usage.cacheReadTokens;
    rollup.outputTokens += usage.outputTokens;
    rollup.thinkingTokens += usage.thinkingTokens;
    if (model) rollup.models.add(model);
}

export function formatTokenCount(value: number): string {
    if (value < 1000) return String(value);
    if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
    if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    return `${(value / 1_000_000_000).toFixed(2)}B`;
}

export function formatDuration(seconds: number): string {
    const rounded = Math.round(seconds);
    const secondsPart = rounded % 60;
    const minutes = Math.floor(rounded / 60);
    if (minutes === 0) return `${secondsPart}s`;
    const hours = Math.floor(minutes / 60);
    const minutesPart = minutes % 60;
    if (hours === 0) return `${minutesPart}m ${secondsPart}s`;
    return `${hours}h ${minutesPart}m ${secondsPart}s`;
}

export function usageFromMetadata(metadata: Uint8Array): TokenCounts | null {
    const message = topLevelLengthField(metadata, 9);
    if (!message) return null;
    const fields = varintFields(message);
    const uncached = fields.get(1);
    if (uncached === undefined) return null;
    const completion = fields.get(3) ?? 0;
    const thinking = fields.get(6) ?? 0;
    return {
        uncachedInputTokens: uncached,
        cacheReadTokens: fields.get(5) ?? 0,
        outputTokens: completion + thinking,
        thinkingTokens: thinking,
    };
}

export function modelForStep(metadata: Uint8Array): { stepIndex: number; model: string } | null {
    const strings = protobufStrings(metadata);
    const model = strings.find((value) => /^(?:claude|gemini|gpt|grok|o\d)-/.test(value));
    const marker = strings.indexOf("last_step_index");
    const stepIndex = marker >= 0 ? Number(strings[marker + 1]) + 1 : Number.NaN;
    if (!model || !Number.isInteger(stepIndex)) return null;
    return { stepIndex, model };
}

export function attributeConversation(
    steps: readonly AgentStep[],
    branches: ReadonlyMap<string, number>,
    repository: string,
): { orchestration: UsageRollup; byPullRequest: Map<number, UsageRollup> } {
    const orchestration = emptyRollup();
    const byPullRequest = new Map<number, UsageRollup>();
    let current: number | null = null;
    let sawTask = false;
    for (const step of steps) {
        if (!sawTask && (step.type === 14 || step.type === 101) && step.payload) {
            sawTask = true;
            const task = originalTask(decode(step.payload));
            if (task) current = solePullRequest(task, branches, repository);
        }
        if (step.type === 132 && step.payload) {
            const text = decode(step.payload);
            const commands = commandLines(text);
            for (const command of commands) {
                const next = pullRequestFromCommand(command, branches);
                if (next !== null) current = next;
            }
            const result = textAfterCommands(text);
            const fromResult = pullRequestFromToolResult(result, commands, branches, repository);
            if (fromResult !== null) current = fromResult;
        }
        if (step.type !== 15 || !step.metadata) continue;
        const usage = usageFromMetadata(step.metadata);
        if (!usage) continue;
        const rollup = current === null ? orchestration : (byPullRequest.get(current) ?? emptyRollup());
        if (current !== null) byPullRequest.set(current, rollup);
        addUsage(rollup, usage, step.model);
    }
    return { orchestration, byPullRequest };
}

export function pullRequestFromCommand(command: string, branches: ReadonlyMap<string, number>): number | null {
    let found: number | null = null;
    let position = -1;
    for (const match of command.matchAll(PR_COMMAND)) {
        const at = match.index ?? 0;
        if (at >= position) {
            position = at;
            found = Number(match[1]);
        }
    }
    for (const match of command.matchAll(CHECKOUT)) {
        const name = match[1] ?? "";
        const number = branches.get(name);
        const at = match.index ?? 0;
        if (number !== undefined && at >= position) {
            position = at;
            found = number;
        }
    }
    return found;
}

export function pullRequestFromToolResult(
    result: string,
    commands: readonly string[],
    branches: ReadonlyMap<string, number>,
    repository: string,
): number | null {
    const joined = commands.join("\n");
    let found: number | null = null;
    let position = -1;
    if (/\bgh\b/.test(joined)) {
        const url = new RegExp(`github\\.com/${escapeRegExp(repository)}/pull/(\\d+)`, "g");
        for (const match of result.matchAll(url)) {
            const at = match.index ?? 0;
            if (at >= position) {
                position = at;
                found = Number(match[1]);
            }
        }
    }
    if (/\bgit\s+(?:status|branch|checkout|switch)\b/.test(joined)) {
        for (const match of result.matchAll(/On branch ([A-Za-z0-9._/-]+)/g)) {
            const number = branches.get(match[1] ?? "");
            const at = match.index ?? 0;
            if (number !== undefined && at >= position) {
                position = at;
                found = number;
            }
        }
    }
    return found;
}

function solePullRequest(task: string, branches: ReadonlyMap<string, number>, repository: string): number | null {
    const numbers = new Set<number>();
    const url = new RegExp(`github\\.com/${escapeRegExp(repository)}/pull/(\\d+)`, "g");
    for (const match of task.matchAll(url)) numbers.add(Number(match[1]));
    for (const match of task.matchAll(/\bPR\s+#(\d+)\b/gi)) numbers.add(Number(match[1]));
    for (const [branch, number] of branches) {
        const pattern = new RegExp(`(?:^|[^A-Za-z0-9._/-])${escapeRegExp(branch)}(?:[^A-Za-z0-9._/-]|$)`);
        if (pattern.test(task)) numbers.add(number);
    }
    if (numbers.size !== 1) return null;
    return [...numbers][0] ?? null;
}

function originalTask(payload: string): string | null {
    const start = payload.indexOf("<original_task>");
    const end = payload.indexOf("</original_task>");
    if (start < 0 || end < start) return null;
    return payload.slice(start, end);
}

export function commandLines(payload: string): string[] {
    const commands: string[] = [];
    let start = 0;
    while (start < payload.length) {
        const at = payload.indexOf('{"CommandLine"', start);
        if (at < 0) break;
        const end = endOfJsonObject(payload, at);
        if (end < 0) break;
        try {
            const parsed = JSON.parse(payload.slice(at, end)) as { CommandLine?: unknown };
            if (typeof parsed.CommandLine === "string") commands.push(parsed.CommandLine);
        } catch {
            // A tool payload can contain a truncated JSON fragment. Later commands still count.
        }
        start = end;
    }
    return commands;
}

function textAfterCommands(payload: string): string {
    let start = 0;
    let end = 0;
    while (start < payload.length) {
        const at = payload.indexOf('{"CommandLine"', start);
        if (at < 0) break;
        const next = endOfJsonObject(payload, at);
        if (next < 0) break;
        end = next;
        start = next;
    }
    return payload.slice(end);
}

function endOfJsonObject(payload: string, at: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = at; index < payload.length; index += 1) {
        const character = payload[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') inString = true;
        else if (character === "{") depth += 1;
        else if (character === "}") {
            depth -= 1;
            if (depth === 0) return index + 1;
        }
    }
    return -1;
}

function topLevelLengthField(buffer: Uint8Array, wanted: number): Uint8Array | null {
    let index = 0;
    while (index < buffer.length) {
        const key = readVarint(buffer, index);
        if (!key) return null;
        const field = key.value >> 3;
        const wire = key.value & 7;
        index = key.next;
        if (wire === 0) {
            const value = readVarint(buffer, index);
            if (!value) return null;
            index = value.next;
        } else if (wire === 1) {
            index += 8;
        } else if (wire === 5) {
            index += 4;
        } else if (wire === 2) {
            const length = readVarint(buffer, index);
            if (!length) return null;
            const start = length.next;
            const end = start + length.value;
            if (end > buffer.length) return null;
            if (field === wanted) return buffer.subarray(start, end);
            index = end;
        } else {
            return null;
        }
    }
    return null;
}

function varintFields(buffer: Uint8Array): Map<number, number> {
    const fields = new Map<number, number>();
    let index = 0;
    while (index < buffer.length) {
        const key = readVarint(buffer, index);
        if (!key) break;
        const field = key.value >> 3;
        const wire = key.value & 7;
        if (field === 0 || field > 30) break;
        index = key.next;
        if (wire === 0) {
            const value = readVarint(buffer, index);
            if (!value) break;
            if (!fields.has(field)) fields.set(field, value.value);
            index = value.next;
        } else if (wire === 2) {
            const length = readVarint(buffer, index);
            if (!length) break;
            index = length.next + length.value;
        } else if (wire === 1) {
            index += 8;
        } else if (wire === 5) {
            index += 4;
        } else {
            break;
        }
    }
    return fields;
}

function protobufStrings(buffer: Uint8Array): string[] {
    const found: string[] = [];
    walkStrings(buffer, found);
    return found;
}

function walkStrings(buffer: Uint8Array, found: string[]): void {
    let index = 0;
    while (index < buffer.length) {
        const key = readVarint(buffer, index);
        if (!key) return;
        const field = key.value >> 3;
        const wire = key.value & 7;
        if (field === 0 || field > 1_000_000) return;
        index = key.next;
        if (wire === 0) {
            const value = readVarint(buffer, index);
            if (!value) return;
            index = value.next;
        } else if (wire === 1) {
            index += 8;
        } else if (wire === 5) {
            index += 4;
        } else if (wire === 2) {
            const length = readVarint(buffer, index);
            if (!length) return;
            const start = length.next;
            const end = start + length.value;
            if (end > buffer.length) return;
            const chunk = buffer.subarray(start, end);
            const text = decode(chunk);
            if (text.length > 0 && /^[\x20-\x7e]+$/.test(text)) found.push(text);
            else walkStrings(chunk, found);
            index = end;
        } else {
            return;
        }
    }
}

function readVarint(buffer: Uint8Array, start: number): { value: number; next: number } | null {
    let value = 0;
    let shift = 0;
    let index = start;
    while (index < buffer.length && shift <= 28) {
        const byte = buffer[index] ?? 0;
        index += 1;
        value += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) return { value, next: index };
        shift += 7;
    }
    return null;
}

function decode(bytes: Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
