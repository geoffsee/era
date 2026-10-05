import { Component } from "@di-framework/core/decorators";
import {
    Controller,
    Endpoint,
    type Json,
    json,
    type QueryParams,
    type RequestSpec,
    type ResponseSpec,
    TypedRouter,
} from "@di-framework/http/portable";
import { AccuracyService } from "./accuracy-service.ts";
import { assertAccess, HttpError, type Identity } from "./auth.ts";
import type { AccuracyReport, Observation, Prediction } from "./model.ts";

@Controller({ singleton: false })
export class TrackingController {
    private readonly router = TypedRouter<[{ identity?: Identity }]>();

    constructor(@Component(AccuracyService) private readonly service: AccuracyService) {}

    fetch(request: Request, deps: { identity?: Identity }) {
        return this.router.fetch(request, deps);
    }
    @Endpoint({ summary: "Service health" })
    health = this.router.get("/health", () => json({ ok: true }));

    @Endpoint({ summary: "Record estimate predictions for any repository" })
    recordPredictions = this.router.post<
        RequestSpec<Json<{ predictions: unknown[] }>>,
        ResponseSpec<{ stored: number }>
    >("/v1/predictions", async (request, deps) => {
        const rows = arrayField(request.content.predictions, "predictions");
        guardRows(deps.identity, rows);
        const stored = await this.service.recordPredictions(rows);
        return json({ stored });
    });

    @Endpoint({ summary: "Record observed actuals for any repository" })
    recordObservations = this.router.post<
        RequestSpec<Json<{ observations: unknown[] }>>,
        ResponseSpec<{ stored: number }>
    >("/v1/observations", async (request, deps) => {
        const rows = arrayField(request.content.observations, "observations");
        guardRows(deps.identity, rows);
        const stored = await this.service.recordObservations(rows);
        return json({ stored });
    });

    @Endpoint({ summary: "Accuracy of stored predictions against observations" })
    accuracy = this.router.get<
        RequestSpec<QueryParams<{ repository: string }>>,
        ResponseSpec<{ repository: string; reports: AccuracyReport[] }>
    >("/v1/accuracy", async (request, deps) => {
        const repository = requiredRepository(request.query.repository, deps.identity);
        const reports = await this.service.accuracy(repository);
        return json({ repository, reports });
    });

    @Endpoint({ summary: "List repositories that have tracker rows" })
    repositories = this.router.get<RequestSpec, ResponseSpec<{ repositories: string[] }>>(
        "/v1/repositories",
        async (_request, deps) => {
            const repositories = await this.service.repositories();
            const identity = deps.identity;
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
        },
    );

    @Endpoint({ summary: "List predictions for one repository" })
    listPredictions = this.router.get<
        RequestSpec<QueryParams<{ repository: string }>>,
        ResponseSpec<{ predictions: Prediction[] }>
    >("/v1/predictions", async (request, deps) => {
        const repository = requiredRepository(request.query.repository, deps.identity);
        return json({ predictions: await this.service.predictions(repository) });
    });

    @Endpoint({ summary: "List observations for one repository" })
    listObservations = this.router.get<
        RequestSpec<QueryParams<{ repository: string }>>,
        ResponseSpec<{ observations: Observation[] }>
    >("/v1/observations", async (request, deps) => {
        const repository = requiredRepository(request.query.repository, deps.identity);
        return json({ observations: await this.service.observations(repository) });
    });
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
    if (!repository) throw new Error("repository query is required");
    if (!identity) throw new HttpError("unauthorized", 401);
    assertAccess(identity, repository);
    return repository;
}

function arrayField(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
    if (value.length > 1000) throw new Error(`${label} is limited to 1000 rows`);
    return value;
}

function queryValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) return value[0];
    return value;
}
