/** Turns one agent-specific usage record into a token count. */
export interface TokenDecoder<T> {
    tokens(record: T): number;
}

/**
 * Which session to count.
 * `sessionId` wins. `taskId` selects the session whose text contains that
 * identifier nearest the start. Otherwise the session is the one whose files
 * appear in `openedPaths`.
 */
export interface SessionRef {
    sessionId?: string;
    taskId?: string;
    openedPaths: readonly string[];
}

export interface SelectedRecords<T> {
    session: string;
    records: Iterable<T>;
}

/**
 * Where an agent stores usage, and how those records become tokens.
 * `T` is the record shape for that agent.
 */
export interface Agent<T> {
    readonly id: string;
    select(ref: SessionRef): SelectedRecords<T>;
    readonly decoder: TokenDecoder<T>;
}

export interface CountedSession {
    session: string;
    eraTokens: number;
}

/** Agent entry the CLI can run without knowing `T`. */
export interface AgentRunner {
    readonly id: string;
    /** Session id for `ref`, without summing tokens. */
    session(ref: SessionRef): string;
    countTokens(ref: SessionRef): CountedSession;
}

export function countTokens<T>(agent: Agent<T>, ref: SessionRef): CountedSession {
    const selected = agent.select(ref);
    let eraTokens = 0;
    for (const record of selected.records) {
        eraTokens += agent.decoder.tokens(record);
    }
    return { session: selected.session, eraTokens };
}

export function defineAgent<T>(agent: Agent<T>): AgentRunner {
    return {
        id: agent.id,
        session(ref) {
            return agent.select(ref).session;
        },
        countTokens(ref) {
            return countTokens(agent, ref);
        },
    };
}
