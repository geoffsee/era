import { useContainer } from "@di-framework/core/container";
import { Component } from "@di-framework/core/decorators";
import { Controller, Endpoint, type Json, type RequestSpec, type ResponseSpec } from "@di-framework/http/portable";
import { HttpError, requestIdentity } from "../../core/auth/access.ts";
import { asHttpRequest, capRequestBody, router } from "../http.ts";
import { ForecastService } from "../services/forecast-application-service.ts";
import { ForecastInputError } from "../services/forecast-service.ts";
import { RoadmapDetectionService } from "../services/roadmap-detection-service.ts";

const FORECAST_LIMIT = 2 * 1024 * 1024;

@Controller()
export class ForecastController {
    constructor(
        @Component(ForecastService) private readonly service: ForecastService,
        @Component(RoadmapDetectionService) private readonly detection: RoadmapDetectionService,
    ) {}

    @Endpoint({ summary: "Validate a roadmap without recording" })
    static validate = router.post<RequestSpec<Json<unknown>>, ResponseSpec<unknown>>(
        "/v1/roadmap-validations",
        (request) => useContainer().resolve(ForecastController).validate(asHttpRequest(request)),
        { use: [forecastBody] },
    );

    @Endpoint({ summary: "Detect roadmap structure" })
    static detect = router.post<RequestSpec<Json<unknown>>, ResponseSpec<unknown>>(
        "/v1/roadmap-detections",
        (request) => useContainer().resolve(ForecastController).detect(asHttpRequest(request)),
        { use: [forecastBody] },
    );

    @Endpoint({ summary: "Calculate a roadmap estimate" })
    static estimate = router.post<RequestSpec<Json<unknown>>, ResponseSpec<unknown>>(
        "/v1/estimates",
        (request) => useContainer().resolve(ForecastController).estimate(asHttpRequest(request)),
        { use: [forecastBody] },
    );

    @Endpoint({ summary: "Backtest a roadmap estimate against history" })
    static backtest = router.post<RequestSpec<Json<unknown>>, ResponseSpec<unknown>>(
        "/v1/backtests",
        (request) => useContainer().resolve(ForecastController).backtest(asHttpRequest(request)),
        { use: [forecastBody] },
    );

    validate(request: JsonRequest): Response {
        return Response.json(this.service.validate(jsonContent(request.content), requestIdentity(request)));
    }

    async detect(request: JsonRequest): Promise<Response> {
        return Response.json(await this.detection.detect(jsonContent(request.content), requestIdentity(request)));
    }

    async estimate(request: JsonRequest): Promise<Response> {
        return Response.json(await this.service.estimate(jsonContent(request.content), requestIdentity(request)));
    }

    async backtest(request: JsonRequest): Promise<Response> {
        return Response.json(await this.service.backtest(jsonContent(request.content), requestIdentity(request)));
    }
}

type JsonRequest = Request & { content: unknown };

async function forecastBody(request: Request): Promise<void> {
    const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") throw new HttpError("content-type must be application/json", 415);
    await capRequestBody(request, FORECAST_LIMIT, "forecast request is limited to 2 MiB");
}

function jsonContent(content: unknown): unknown {
    if (content === undefined) throw new ForecastInputError("JSON body is required");
    if (typeof content === "string" || content instanceof FormData)
        throw new ForecastInputError("body must be valid JSON");
    return content;
}
