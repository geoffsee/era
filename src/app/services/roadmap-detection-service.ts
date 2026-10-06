import { type ChatModel, ChatClient, RetryAdvisor, schemaOutputConverter } from "@di-framework/ai";
import { Component, Container } from "@di-framework/core/decorators";
import { HttpError, type Identity } from "../../core/auth/access.ts";
import type { RoadmapDetectionResponse } from "../../core/forecast/forecast-contract.ts";
import type { InferenceUsage } from "../../core/forecast/inference.ts";
import {
    applyDetection,
    DETECTION_LIMITS,
    DETECTION_SCHEMA,
    DETECTION_SYSTEM_PROMPT,
    detectionUserMessage,
} from "../../core/roadmap/roadmap-detection.ts";
import { CHAT_MODEL } from "../configuration.ts";
import { authorizedContent } from "./forecast-application-service.ts";
import { parseRoadmapDetectionRequest } from "./forecast-service.ts";

const CALL_TIMEOUT_MS = 120_000;

/** Asks the configured chat model how a roadmap issue is structured, keeping only proposals the parser accepts. */
@Container()
export class RoadmapDetectionService {
    constructor(@Component(CHAT_MODEL) private readonly model: ChatModel | undefined) {}

    async detect(value: unknown, identity: Identity | undefined): Promise<RoadmapDetectionResponse> {
        const content = authorizedContent(value, identity);
        if (!this.model) throw new HttpError("Roadmap detection is not configured on this Worker", 503);
        const input = parseRoadmapDetectionRequest(content);
        const titles = new Map(Object.entries(input.roadmap.titles ?? {}).map(([id, title]) => [Number(id), title]));
        const client = ChatClient.builder(this.model)
            .defaultAdvisors(new RetryAdvisor({ maxAttempts: 2 }))
            .build();
        const converter = schemaOutputConverter({ schema: DETECTION_SCHEMA });
        const usage: InferenceUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
        let model = this.model.options?.model;
        let previous: { answer: unknown; error: string } | undefined;
        for (let attempt = 1; attempt <= DETECTION_LIMITS.attempts; attempt++) {
            const result = await this.call(() =>
                client
                    .prompt()
                    .system(DETECTION_SYSTEM_PROMPT)
                    .user(detectionUserMessage(input.roadmap, titles, previous))
                    .options({ maxTokens: DETECTION_LIMITS.outputTokens, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
                    .call()
                    .responseEntity<unknown>(converter),
            );
            const metadata = result.chatResponse?.metadata;
            model = metadata?.model ?? model;
            usage.promptTokens += metadata?.usage?.promptTokens ?? 0;
            usage.completionTokens += metadata?.usage?.completionTokens ?? 0;
            usage.totalTokens += metadata?.usage?.totalTokens ?? 0;
            usage.calls += 1;
            try {
                const detected = applyDetection(result.entity, input.roadmap.body, titles);
                return { repository: input.repository, ...detected, model: model ?? "unknown", usage };
            } catch (error) {
                previous = {
                    answer: result.entity,
                    error: error instanceof Error ? error.message : "invalid proposal",
                };
            }
        }
        throw new HttpError(`Roadmap detection did not produce a parseable configuration: ${previous?.error}`, 422);
    }

    private async call<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            console.warn(
                JSON.stringify({
                    event: "era.detection.failure",
                    error: error instanceof Error ? error.name : "unknown",
                }),
            );
            throw new HttpError("Roadmap detection is unavailable; retry", 503);
        }
    }
}
