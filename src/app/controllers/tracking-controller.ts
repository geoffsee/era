import { useContainer } from "@di-framework/core/container";
import { Component } from "@di-framework/core/decorators";
import {
    Controller,
    Endpoint,
    type Json,
    json,
    type QueryParams,
    type RequestSpec,
    type ResponseSpec,
} from "@di-framework/http/portable";
import { assertAccess, HttpError, type Identity, requestIdentity } from "../../core/auth/access.ts";
import { type AccuracyReport, InputError, type Observation, type Prediction } from "../../core/tracking/model.ts";
import { asHttpRequest, router } from "../http.ts";
import { AccuracyService } from "../services/accuracy-service.ts";

@Controller()
export class TrackingController {
    constructor(@Component(AccuracyService) private readonly service: AccuracyService) {}

    @Endpoint({ summary: "Service health" })
    static health = router.get("/health", () => json({ ok: true }));

    @Endpoint({ summary: "Record estimate predictions for any repository" })
    static recordPredictions = router.post<
        RequestSpec<Json<{ predictions: unknown[] }>>,
        ResponseSpec<{ stored: number }>
    >("/v1/predictions", (request) =>
        useContainer().resolve(TrackingController).recordPredictions(asHttpRequest(request)),
    );

    @Endpoint({ summary: "Record observed actuals for any repository" })
    static recordObservations = router.post<
        RequestSpec<Json<{ observations: unknown[] }>>,
        ResponseSpec<{ stored: number }>
    >("/v1/observations", (request) =>
        useContainer().resolve(TrackingController).recordObservations(asHttpRequest(request)),
    );

    @Endpoint({ summary: "Accuracy of stored predictions against observations" })
    static accuracy = router.get<
        RequestSpec<QueryParams<{ repository: string }>>,
        ResponseSpec<{ repository: string; reports: AccuracyReport[] }>
    >("/v1/accuracy", (request) => useContainer().resolve(TrackingController).accuracy(asHttpRequest(request)));

    @Endpoint({ summary: "List repositories that have tracker rows" })
    static repositories = router.get<RequestSpec, ResponseSpec<{ repositories: string[] }>>(
        "/v1/repositories",
        (request) => useContainer().resolve(TrackingController).repositories(asHttpRequest(request)),
    );

    @Endpoint({ summary: "List predictions for one repository" })
    static listPredictions = router.get<
        RequestSpec<QueryParams<{ repository: string }>>,
        ResponseSpec<{ predictions: Prediction[] }>
    >("/v1/predictions", (request) =>
        useContainer().resolve(TrackingController).listPredictions(asHttpRequest(request)),
    );

    @Endpoint({ summary: "List observations for one repository" })
    static listObservations = router.get<
        RequestSpec<QueryParams<{ repository: string }>>,
        ResponseSpec<{ observations: Observation[] }>
    >("/v1/observations", (request) =>
        useContainer().resolve(TrackingController).listObservations(asHttpRequest(request)),
    );

    async recordPredictions(request: { content: { predictions: unknown[] } } & Request): Promise<Response> {
        const rows = arrayField(request.content.predictions, "predictions");
        guardRows(requestIdentity(request), rows);
        return json({ stored: await this.service.recordPredictions(rows) });
    }

    async recordObservations(request: { content: { observations: unknown[] } } & Request): Promise<Response> {
        const rows = arrayField(request.content.observations, "observations");
        guardRows(requestIdentity(request), rows);
        return json({ stored: await this.service.recordObservations(rows) });
    }

    async accuracy(request: { query: { repository?: string | string[] } } & Request): Promise<Response> {
        const repository = requiredRepository(request.query.repository, requestIdentity(request));
        return json({ repository, reports: await this.service.accuracy(repository) });
    }

    async repositories(request: Request): Promise<Response> {
        const repositories = await this.service.repositories();
        const identity = requestIdentity(request);
        if (identity && identity.kind !== "admin") {
            return json({
                repositories: repositories.filter((repository) =>
                    identity.kind === "user"
                        ? repository.toLowerCase() === identity.repository.toLowerCase()
                        : repository === identity.repository,
                ),
            });
        }
        return json({ repositories });
    }

    async listPredictions(request: { query: { repository?: string | string[] } } & Request): Promise<Response> {
        const repository = requiredRepository(request.query.repository, requestIdentity(request));
        return json({ predictions: await this.service.predictions(repository) });
    }

    async listObservations(request: { query: { repository?: string | string[] } } & Request): Promise<Response> {
        const repository = requiredRepository(request.query.repository, requestIdentity(request));
        return json({ observations: await this.service.observations(repository) });
    }
}

function guardRows(identity: Identity | undefined, rows: readonly unknown[]): void {
    if (!identity) throw new HttpError("unauthorized", 401);
    for (const row of rows) {
        if (typeof row !== "object" || row === null || !("repository" in row)) continue;
        const repository = (row as { repository?: unknown }).repository;
        if (typeof repository === "string") assertAccess(identity, repository);
    }
}

function requiredRepository(value: string | string[] | undefined, identity: Identity | undefined): string {
    const repository = queryValue(value);
    if (!repository) throw new InputError("repository query is required");
    if (!identity) throw new HttpError("unauthorized", 401);
    assertAccess(identity, repository);
    return repository;
}

function arrayField(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value) || value.length === 0) throw new InputError(`${label} must be a non-empty array`);
    if (value.length > 1000) throw new InputError(`${label} is limited to 1000 rows`);
    return value;
}

function queryValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) return value[0];
    return value;
}
