import { type HistoricalPullRequest, isCalibrationSample } from "../history/history.ts";
import type { Prediction } from "../tracking/model.ts";
import type { ChildEstimate } from "./estimator.ts";

/**
 * In-context inference: a configurable set of additional per-item estimates that a language model
 * infers from the roadmap text, the historical pull requests and the deterministic estimate.
 * This module is pure; the Worker service owns the model call.
 */
export type NumericField = {
    name: string;
    description: string;
    type: "number" | "integer";
    unit?: string;
    minimum?: number;
    maximum?: number;
};
export type EnumField = { name: string; description: string; type: "enum"; values: string[] };
export type InferenceField = NumericField | EnumField;
export type InferenceConfig = { fields: InferenceField[] };

export type InferredItem = { issue: number; values: Record<string, number | string>; rationale: string };
export type InferenceUsage = { promptTokens: number; completionTokens: number; totalTokens: number; calls: number };
export type InferredEstimates = {
    model: string;
    fields: InferenceField[];
    items: InferredItem[];
    usage: InferenceUsage;
};

export type InferenceItem = { issue: number; title: string; description?: string; child: ChildEstimate };

export const INFERENCE_LIMITS = {
    fields: 12,
    nameChars: 40,
    descriptionChars: 400,
    enumValues: 8,
    itemDescriptionChars: 1500,
    itemsPerCall: 40,
    candidates: 400,
    outputTokens: 16000,
} as const;

const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/;
const RESERVED = new Set(["issue", "rationale"]);

/** Tracking rows name the estimator by provider model so accuracy reports separate model generations. */
export function inferenceModelName(model: string): string {
    return `inference:${model.replace(/^@/, "").replace(/[^A-Za-z0-9_.:/-]/g, "-")}`;
}

export function parseInferenceConfig(value: unknown): InferenceConfig {
    const config = record(value, "inference");
    keys(config, ["fields"], "inference");
    if (!Array.isArray(config.fields) || config.fields.length === 0 || config.fields.length > INFERENCE_LIMITS.fields)
        throw new Error(`inference.fields must list 1–${INFERENCE_LIMITS.fields} fields`);
    const names = new Set<string>();
    const fields = config.fields.map((entry): InferenceField => {
        const field = record(entry, "inference field");
        const name = field.name;
        if (typeof name !== "string" || !FIELD_NAME.test(name) || name.length > INFERENCE_LIMITS.nameChars)
            throw new Error(`inference field name must be camelCase letters and digits, got ${JSON.stringify(name)}`);
        if (RESERVED.has(name) || names.has(name)) throw new Error(`inference field ${name} is reserved or duplicated`);
        names.add(name);
        if (
            typeof field.description !== "string" ||
            !field.description.trim() ||
            field.description.length > INFERENCE_LIMITS.descriptionChars
        )
            throw new Error(
                `inference field ${name} needs a description of at most ${INFERENCE_LIMITS.descriptionChars} characters`,
            );
        const description = field.description.trim();
        if (field.type === "enum") {
            keys(field, ["name", "description", "type", "values"], `inference field ${name}`);
            const values = field.values;
            if (
                !Array.isArray(values) ||
                values.length < 2 ||
                values.length > INFERENCE_LIMITS.enumValues ||
                values.some((item) => typeof item !== "string" || !item.trim()) ||
                new Set(values).size !== values.length
            )
                throw new Error(`inference field ${name} needs 2–${INFERENCE_LIMITS.enumValues} distinct enum values`);
            return { name, description, type: "enum", values: values as string[] };
        }
        if (field.type !== "number" && field.type !== "integer")
            throw new Error(`inference field ${name} type must be number, integer or enum`);
        keys(field, ["name", "description", "type", "unit", "minimum", "maximum"], `inference field ${name}`);
        if (
            field.unit !== undefined &&
            (typeof field.unit !== "string" || !field.unit.trim() || field.unit.length > 20)
        )
            throw new Error(`inference field ${name} unit must be short text`);
        for (const bound of ["minimum", "maximum"] as const)
            if (field[bound] !== undefined && (typeof field[bound] !== "number" || !Number.isFinite(field[bound])))
                throw new Error(`inference field ${name} ${bound} must be a finite number`);
        if (typeof field.minimum === "number" && typeof field.maximum === "number" && field.minimum > field.maximum)
            throw new Error(`inference field ${name} minimum exceeds maximum`);
        return {
            name,
            description,
            type: field.type,
            ...(field.unit !== undefined ? { unit: (field.unit as string).trim() } : {}),
            ...(field.minimum !== undefined ? { minimum: field.minimum as number } : {}),
            ...(field.maximum !== undefined ? { maximum: field.maximum as number } : {}),
        };
    });
    return { fields };
}

/** The remaining delivery children exactly as the deterministic estimate sized them. */
export function inferenceItems(
    children: readonly ChildEstimate[],
    titles: ReadonlyMap<number, string>,
    descriptions: Readonly<Record<string, string>> | undefined,
): InferenceItem[] {
    return children.map((child) => {
        const description = descriptions?.[String(child.issue)]?.trim();
        return {
            issue: child.issue,
            title: titles.get(child.issue) ?? `#${child.issue}`,
            ...(description ? { description: description.slice(0, INFERENCE_LIMITS.itemDescriptionChars) } : {}),
            child,
        };
    });
}

/** Merged pull requests with author usage, newest first, bounded for one prompt. */
export function inferenceCandidates(history: readonly HistoricalPullRequest[]): HistoricalPullRequest[] {
    return history
        .filter(isCalibrationSample)
        .sort((left, right) => (right.mergedAt ?? "").localeCompare(left.mergedAt ?? "") || right.number - left.number)
        .slice(0, INFERENCE_LIMITS.candidates);
}

export function inferenceSchema(fields: readonly InferenceField[]): Record<string, unknown> {
    const properties: Record<string, unknown> = {
        issue: { type: "integer", minimum: 1 },
        rationale: { type: "string", minLength: 1 },
    };
    for (const field of fields) {
        properties[field.name] =
            field.type === "enum"
                ? { type: "string", enum: field.values, description: field.description }
                : {
                      type: field.type,
                      description: field.description,
                      ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
                      ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
                  };
    }
    return {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
            items: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["issue", "rationale", ...fields.map((field) => field.name)],
                    properties,
                },
            },
        },
    };
}

export const INFERENCE_SYSTEM_PROMPT = [
    "You extend a deterministic software delivery forecast with additional estimates that can only be inferred from context.",
    "You receive the repository's merged historical pull requests with their dates, agent token usage and CI outcomes,",
    "the remaining roadmap items with their titles, descriptions and the deterministic token and story-point estimate,",
    "and the list of fields to infer for every remaining item.",
    "Ground every value in that evidence: compare each item with the most similar historical pull requests and scale from",
    "the deterministic estimate. Never invent history and never change the fields requested.",
    "Rules:",
    "- Return exactly one entry per remaining item, using the item's issue number.",
    "- Fill every requested field. Numbers must be finite and respect the stated units and bounds; enum fields must use one of the listed values.",
    "- rationale: one sentence naming the historical pull requests or figures the estimate rests on.",
    "Respond with JSON only, matching the provided schema; no prose and no Markdown fences.",
].join("\n");

export function inferenceUserMessage(
    fields: readonly InferenceField[],
    candidates: readonly HistoricalPullRequest[],
    items: readonly InferenceItem[],
): string {
    const lines = [
        "Historical merged pull requests (#number title | merged, days open, author tokens, CI failures, epic):",
    ];
    for (const pr of candidates) lines.push(candidateLine(pr));
    lines.push(
        "",
        "Remaining roadmap items (#issue title | lane, sizing basis, estimated author tokens, story points):",
    );
    for (const item of items) {
        const { child } = item;
        lines.push(
            `#${item.issue} ${item.title} | lane ${child.laneId || "none"}, ${child.sizing.basis}, ${count(child.tokens)} tokens, ${child.storyPoints} points`,
        );
        if (item.description) lines.push(`  Description: ${item.description.replaceAll(/\s+/g, " ")}`);
    }
    lines.push("", "Fields to infer for every item:");
    for (const field of fields) {
        const shape =
            field.type === "enum"
                ? `one of ${field.values.join(", ")}`
                : `${field.type}${field.unit ? ` in ${field.unit}` : ""}${bounds(field)}`;
        lines.push(`- ${field.name} (${shape}): ${field.description}`);
    }
    return lines.join("\n");
}

/** Keep only entries for remaining items and values that satisfy their field definition. */
export function validateInferred(
    raw: unknown,
    fields: readonly InferenceField[],
    items: readonly InferenceItem[],
): InferredItem[] {
    const entries = raw && typeof raw === "object" ? (raw as { items?: unknown }).items : undefined;
    if (!Array.isArray(entries)) return [];
    const remaining = new Set(items.map((item) => item.issue));
    const seen = new Set<number>();
    const inferred: InferredItem[] = [];
    for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const row = entry as Record<string, unknown>;
        const issue = row.issue;
        if (typeof issue !== "number" || !remaining.has(issue) || seen.has(issue)) continue;
        const values: Record<string, number | string> = {};
        for (const field of fields) {
            const value = fieldValue(field, row[field.name]);
            if (value !== undefined) values[field.name] = value;
        }
        if (Object.keys(values).length === 0) continue;
        seen.add(issue);
        const rationale = typeof row.rationale === "string" ? row.rationale.trim() : "";
        inferred.push({ issue, values, rationale: rationale || "No rationale returned by the model." });
    }
    return inferred.sort((left, right) => left.issue - right.issue);
}

/** Numeric inferred fields become tracked predictions under the inference model name. */
export function inferredPredictions(repository: string, inferred: InferredEstimates, recordedAt: string): Prediction[] {
    const model = inferenceModelName(inferred.model);
    const rows: Prediction[] = [];
    for (const item of inferred.items)
        for (const field of inferred.fields) {
            const value = item.values[field.name];
            if (field.type !== "enum" && typeof value === "number")
                rows.push({
                    repository,
                    subject: `issue:${item.issue}`,
                    model,
                    metric: field.name,
                    predicted: value,
                    recordedAt,
                });
        }
    return rows;
}

function fieldValue(field: InferenceField, value: unknown): number | string | undefined {
    if (field.type === "enum") return typeof value === "string" && field.values.includes(value) ? value : undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    if (field.type === "integer" && !Number.isInteger(value)) return undefined;
    if (field.minimum !== undefined && value < field.minimum) return undefined;
    if (field.maximum !== undefined && value > field.maximum) return undefined;
    return value;
}

function candidateLine(pr: HistoricalPullRequest): string {
    const merged = pr.mergedAt ? pr.mergedAt.slice(0, 10) : "unknown date";
    const open =
        pr.createdAt && pr.mergedAt
            ? `${Math.max(0, (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 86_400_000).toFixed(1)} days open`
            : "unknown duration";
    const epic = pr.epic === null ? "no epic" : `epic ${pr.epic}`;
    return `#${pr.number} ${pr.title} | merged ${merged}, ${open}, ${count(pr.totalTokens)} tokens, ${pr.failedJobs} CI failures, ${epic}`;
}

function bounds(field: NumericField): string {
    if (field.minimum !== undefined && field.maximum !== undefined) return `, ${field.minimum}–${field.maximum}`;
    if (field.minimum !== undefined) return `, at least ${field.minimum}`;
    if (field.maximum !== undefined) return `, at most ${field.maximum}`;
    return "";
}

function count(value: number): string {
    return Math.round(value).toLocaleString("en-US");
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}: unknown field ${key}`);
}
