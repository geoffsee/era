import { type InfrastructureBilling, type TokenRateCard, nonNegative } from "./accounting.ts";

export const HUMAN_ACTIVITIES = [
    "discovery-design",
    "implementation-operations",
    "coordination",
    "review",
    "integration-acceptance",
] as const;

export type HumanActivity = {
    activity: (typeof HUMAN_ACTIVITIES)[number];
    hours: number;
    usdPerHour: number;
};

export type RemainingWork = {
    authorBlocks: number;
    source: string;
    comparablePrs?: number[];
    /** Explicit acceptance attested by source; issue closure alone is insufficient. */
    accepted?: boolean;
};

export type ForecastPlan = {
    version: 1;
    source: string;
    work?: Record<string, RemainingWork>;
    humanActivities?: HumanActivity[];
    infrastructureBilling?: InfrastructureBilling;
    authorRateCard?: TokenRateCard;
};

/** Validate even typed plans: CLI JSON and callers at runtime are not type-checked inputs. */
export function parseForecastPlan(value: unknown): ForecastPlan {
    const plan = record(value, "forecast plan");
    keys(
        plan,
        ["version", "source", "work", "humanActivities", "infrastructureBilling", "authorRateCard"],
        "forecast plan",
    );
    if (plan.version !== 1) throw new Error("forecast plan version must be 1");
    text(plan.source, "forecast plan source");
    if (plan.work !== undefined) {
        const work = record(plan.work, "work");
        for (const [id, value] of Object.entries(work)) {
            if (!/^[1-9]\d*$/.test(id)) throw new Error(`invalid work issue ${id}`);
            const item = record(value, `work #${id}`);
            keys(item, ["authorBlocks", "source", "comparablePrs", "accepted"], `work #${id}`);
            number(item.authorBlocks, `work #${id} authorBlocks`);
            text(item.source, `work #${id} source`);
            if (item.accepted !== undefined && typeof item.accepted !== "boolean")
                throw new Error(`work #${id} accepted must be boolean`);
            if ((item.accepted === true) !== (item.authorBlocks === 0))
                throw new Error(
                    `work #${id}: zero blocks require explicit acceptance, and accepted work must have zero blocks`,
                );
            if (item.comparablePrs !== undefined) {
                if (!Array.isArray(item.comparablePrs) || item.comparablePrs.length === 0)
                    throw new Error(`work #${id} comparablePrs must be nonempty`);
                for (const pr of item.comparablePrs)
                    if (!Number.isSafeInteger(pr) || pr <= 0)
                        throw new Error(`work #${id} comparable PR must be a positive integer`);
                if (new Set(item.comparablePrs).size !== item.comparablePrs.length)
                    throw new Error(`work #${id} has duplicate comparable PRs`);
            }
        }
    }
    if (plan.humanActivities !== undefined) {
        if (!Array.isArray(plan.humanActivities)) throw new Error("humanActivities must be an array");
        const seen = new Set<string>();
        for (const value of plan.humanActivities) {
            const activity = record(value, "human activity");
            keys(activity, ["activity", "hours", "usdPerHour"], "human activity");
            if (!HUMAN_ACTIVITIES.includes(activity.activity as HumanActivity["activity"]))
                throw new Error(`unknown human activity ${activity.activity}`);
            const name = activity.activity as string;
            if (seen.has(name)) throw new Error(`duplicate human activity ${name}`);
            seen.add(name);
            number(activity.hours, `${name} hours`);
            number(activity.usdPerHour, `${name} usdPerHour`);
        }
    }
    if (plan.infrastructureBilling !== undefined) {
        const billing = record(plan.infrastructureBilling, "infrastructureBilling");
        if (billing.kind === "public-standard") keys(billing, ["kind"], "infrastructureBilling");
        else if (billing.kind === "billable") {
            keys(billing, ["kind", "runnerMinutes", "usdPerMinute", "source"], "infrastructureBilling");
            number(billing.runnerMinutes, "runnerMinutes");
            number(billing.usdPerMinute, "usdPerMinute");
            text(billing.source, "infrastructureBilling source");
        } else throw new Error("infrastructureBilling kind must be public-standard or billable");
    }
    if (plan.authorRateCard !== undefined) {
        const rates = record(plan.authorRateCard, "authorRateCard");
        keys(
            rates,
            [
                "model",
                "currency",
                "asOf",
                "source",
                "provenance",
                "inputPerToken",
                "cacheReadPerToken",
                "outputPerToken",
            ],
            "authorRateCard",
        );
        text(rates.model, "authorRateCard model");
        text(rates.source, "authorRateCard source");
        if (rates.currency !== "USD") throw new Error("authorRateCard currency must be USD");
        if (
            typeof rates.asOf !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(rates.asOf) ||
            !Number.isFinite(Date.parse(rates.asOf)) ||
            new Date(rates.asOf).toISOString().slice(0, 10) !== rates.asOf
        )
            throw new Error("authorRateCard asOf must be a valid YYYY-MM-DD date");
        if (rates.provenance !== "assumed" && rates.provenance !== "verified")
            throw new Error("authorRateCard provenance must be assumed or verified");
        for (const key of ["inputPerToken", "cacheReadPerToken", "outputPerToken"])
            number(rates[key], `authorRateCard ${key}`);
    }
    return value as ForecastPlan;
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}: unknown field ${key}`);
}

function number(value: unknown, label: string): void {
    if (typeof value !== "number") throw new Error(`${label} must be a number`);
    nonNegative(value, label);
}

function text(value: unknown, label: string): void {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be nonempty text`);
}
