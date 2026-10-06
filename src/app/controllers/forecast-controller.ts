import { Component } from "@di-framework/core/decorators";
import { Controller } from "@di-framework/http/portable";
import { ForecastService } from "../services/forecast-application-service.ts";
import { ForecastInputError } from "../services/forecast-service.ts";
import { RoadmapDetectionService } from "../services/roadmap-detection-service.ts";
import { HttpError, requestIdentity } from "../../core/auth/access.ts";

@Controller()
export class ForecastController {
    constructor(
        @Component(ForecastService) private readonly service: ForecastService,
        @Component(RoadmapDetectionService) private readonly detection: RoadmapDetectionService,
    ) {}

    async handle(request: Request): Promise<Response | undefined> {
        const path = new URL(request.url).pathname;
        if (
            request.method !== "POST" ||
            !["/v1/estimates", "/v1/backtests", "/v1/roadmap-validations", "/v1/roadmap-detections"].includes(path)
        )
            return undefined;
        const identity = requestIdentity(request);
        const content = await readJson(request);
        if (path === "/v1/roadmap-validations") return Response.json(this.service.validate(content, identity));
        if (path === "/v1/roadmap-detections") return Response.json(await this.detection.detect(content, identity));
        if (path === "/v1/estimates") return Response.json(await this.service.estimate(content, identity));
        return Response.json(await this.service.backtest(content, identity));
    }
}

async function readJson(request: Request): Promise<unknown> {
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
        throw new HttpError("content-type must be application/json", 415);
    const limit = 2 * 1024 * 1024;
    if (Number(request.headers.get("content-length")) > limit)
        throw new HttpError("forecast request is limited to 2 MiB", 413);
    const reader = request.body?.getReader();
    if (!reader) throw new ForecastInputError("JSON body is required");
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) {
                await reader.cancel();
                throw new HttpError("forecast request is limited to 2 MiB", 413);
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
    } finally {
        reader.releaseLock();
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new ForecastInputError("body must be valid JSON");
    }
}
