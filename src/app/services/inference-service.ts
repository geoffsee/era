import { type ChatModel, ChatClient, RetryAdvisor, schemaOutputConverter } from "@di-framework/ai";
import { Component, Container } from "@di-framework/core/decorators";
import { HttpError } from "../../core/auth/access.ts";
import type { ChildEstimate } from "../../core/forecast/estimator.ts";
import type { ForecastRequest } from "../../core/forecast/forecast-contract.ts";
import {
    INFERENCE_LIMITS,
    INFERENCE_SYSTEM_PROMPT,
    type InferenceConfig,
    type InferenceUsage,
    type InferredEstimates,
    type InferredItem,
    inferenceCandidates,
    inferenceItems,
    inferenceSchema,
    inferenceUserMessage,
    validateInferred,
} from "../../core/forecast/inference.ts";
import { CHAT_MODEL } from "../configuration.ts";

const CALL_TIMEOUT_MS = 120_000;

/** Asks the configured chat model for the additional per-item estimates a request declares. */
@Container()
export class InferenceService {
    constructor(@Component(CHAT_MODEL) private readonly model: ChatModel | undefined) {}

    async infer(
        config: InferenceConfig,
        input: ForecastRequest,
        children: readonly ChildEstimate[],
    ): Promise<InferredEstimates> {
        if (!this.model) throw new HttpError("In-context inference is not configured on this Worker", 503);
        const titles = new Map(Object.entries(input.roadmap.titles ?? {}).map(([id, title]) => [Number(id), title]));
        const items = inferenceItems(children, titles, input.roadmap.descriptions);
        const candidates = inferenceCandidates(input.history.pullRequests);
        const client = ChatClient.builder(this.model)
            .defaultAdvisors(new RetryAdvisor({ maxAttempts: 2 }))
            .build();
        const converter = schemaOutputConverter({ schema: inferenceSchema(config.fields) });
        const usage: InferenceUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
        const inferred: InferredItem[] = [];
        let model = this.model.options?.model;
        for (let index = 0; index < items.length; index += INFERENCE_LIMITS.itemsPerCall) {
            const chunk = items.slice(index, index + INFERENCE_LIMITS.itemsPerCall);
            const result = await this.call(() =>
                client
                    .prompt()
                    .system(INFERENCE_SYSTEM_PROMPT)
                    .user(inferenceUserMessage(config.fields, candidates, chunk))
                    .options({ maxTokens: INFERENCE_LIMITS.outputTokens, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
                    .call()
                    .responseEntity<unknown>(converter),
            );
            const metadata = result.chatResponse?.metadata;
            model = metadata?.model ?? model;
            usage.promptTokens += metadata?.usage?.promptTokens ?? 0;
            usage.completionTokens += metadata?.usage?.completionTokens ?? 0;
            usage.totalTokens += metadata?.usage?.totalTokens ?? 0;
            usage.calls += 1;
            inferred.push(...validateInferred(result.entity, config.fields, chunk));
        }
        return { model: model ?? "unknown", fields: config.fields, items: inferred, usage };
    }

    private async call<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            // Provider payloads and prompts stay out of responses and logs; only the failure class is reported.
            console.warn(
                JSON.stringify({
                    event: "era.inference.failure",
                    error: error instanceof Error ? error.name : "unknown",
                }),
            );
            throw new HttpError("In-context inference is unavailable; retry", 503);
        }
    }
}
