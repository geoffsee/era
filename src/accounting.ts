import type { HistoricalAuthorOverhead } from "./historical-data-repository.ts";

/** Disjoint billable categories. Output already contains reasoning/thinking. */
export type TokenQuantities = {
    uncachedInputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
};

export type TokenRateCard = {
    model: string;
    currency: "USD";
    asOf: string;
    source: string;
    provenance: "assumed" | "verified";
    inputPerToken: number;
    cacheReadPerToken: number;
    outputPerToken: number;
};

export type InfrastructureBilling =
    | { kind: "public-standard" }
    | { kind: "billable"; runnerMinutes: number; usdPerMinute: number; source: string };

export type CostGap = { category: string; detail: string };

export function nonNegative(value: number, label: string): number {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
    return value;
}

export function priceTokens(usage: TokenQuantities, rates: TokenRateCard): number {
    return (
        nonNegative(usage.uncachedInputTokens, "fresh input tokens") * nonNegative(rates.inputPerToken, "input rate") +
        nonNegative(usage.cacheReadTokens, "cache-read tokens") *
            nonNegative(rates.cacheReadPerToken, "cache-read rate") +
        nonNegative(usage.outputTokens, "output tokens") * nonNegative(rates.outputPerToken, "output rate")
    );
}

export function forecastAuthorOverhead(
    remainingAuthorTokens: number,
    history: HistoricalAuthorOverhead | undefined,
    rates: TokenRateCard,
): { tokens: number; cost: number } | undefined {
    if (!history || history.attributedAuthorTokens <= 0) return undefined;
    const quantity = history.uncachedInputTokens + history.cacheReadTokens + history.outputTokens;
    if (quantity !== history.totalTokens) throw new Error("author orchestration token categories do not reconcile");
    const scale =
        nonNegative(remainingAuthorTokens, "remaining author tokens") /
        nonNegative(history.attributedAuthorTokens, "attributed author tokens");
    return { tokens: history.totalTokens * scale, cost: priceTokens(history, rates) * scale };
}

/** Historical CI wall-clock spans are intentionally not accepted as a billable quantity. */
export function priceInfrastructure(billing: InfrastructureBilling | undefined): number {
    if (!billing || billing.kind === "public-standard") return 0;
    return (
        nonNegative(billing.runnerMinutes, "billable runner minutes") * nonNegative(billing.usdPerMinute, "runner rate")
    );
}
