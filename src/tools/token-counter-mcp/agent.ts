/** Turns one agent-specific usage record into a token count. */
export interface TokenDecoder<T> {
  tokens(record: T): number;
}

/**
 * Where an agent stores usage, and how those records become tokens.
 * `T` is the record shape for that agent.
 */
export interface Agent<T> {
  readonly id: string;
  records(): Iterable<T>;
  readonly decoder: TokenDecoder<T>;
}

/** Agent entry the CLI can run without knowing `T`. */
export interface AgentRunner {
  readonly id: string;
  countTokens(): number;
}

export function countTokens<T>(agent: Agent<T>): number {
  let total = 0;
  for (const record of agent.records()) {
    total += agent.decoder.tokens(record);
  }
  return total;
}

export function defineAgent<T>(agent: Agent<T>): AgentRunner {
  return {
    id: agent.id,
    countTokens() {
      return countTokens(agent);
    },
  };
}
