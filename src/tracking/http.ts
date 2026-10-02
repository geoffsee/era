import { useContainer } from "@di-framework/core/container";
import {
    Controller,
    Endpoint,
    json,
    TypedRouter,
    type Json,
    type QueryParams,
    type RequestSpec,
    type ResponseSpec,
} from "@di-framework/http/portable";
import { assertAccess, authenticate, HttpError, type Identity } from "./auth.ts";
import { AccuracyService, LEDGER } from "./accuracy-service.ts";
import type { Ledger } from "./ledger.ts";
import type { AccuracyReport, Observation, Prediction } from "./model.ts";

export type TrackerDeps = {
    ledger: Ledger;
    apiToken: string;
    audience?: string;
    identity?: Identity;
    verifyOidc?: (token: string, audience: string) => Promise<{ repository: string; workflowRef?: string }>;
};

const router = TypedRouter<[TrackerDeps]>();

@Controller()
export class TrackingController {
    @Endpoint({ summary: "Service health" })
    static health = router.get("/health", () => json({ ok: true }));

    @Endpoint({ summary: "Record estimate predictions for any repository" })
    static recordPredictions = router.post<
        RequestSpec<Json<{ predictions: unknown[] }>>,
        ResponseSpec<{ stored: number }>
    >("/v1/predictions", async (request, deps) => {
        const rows = arrayField(request.content.predictions, "predictions");
        guardRows(deps.identity, rows);
        const stored = await resolveService(deps).recordPredictions(rows);
        return json({ stored });
    });

    @Endpoint({ summary: "Record observed actuals for any repository" })
    static recordObservations = router.post<
        RequestSpec<Json<{ observations: unknown[] }>>,
        ResponseSpec<{ stored: number }>
    >("/v1/observations", async (request, deps) => {
        const rows = arrayField(request.content.observations, "observations");
        guardRows(deps.identity, rows);
        const stored = await resolveService(deps).recordObservations(rows);
        return json({ stored });
    });

    @Endpoint({ summary: "Accuracy of stored predictions against observations" })
    static accuracy = router.get<
        RequestSpec<QueryParams<{ repository: string }>>,
        ResponseSpec<{ repository: string; reports: AccuracyReport[] }>
    >("/v1/accuracy", async (request, deps) => {
        const repository = requiredRepository(request.query.repository, deps.identity);
        const reports = await resolveService(deps).accuracy(repository);
        return json({ repository, reports });
    });

    @Endpoint({ summary: "List repositories that have tracker rows" })
    static repositories = router.get<RequestSpec, ResponseSpec<{ repositories: string[] }>>(
        "/v1/repositories",
        async (_request, deps) => {
            const repositories = await resolveService(deps).repositories();
            const identity = deps.identity;
            if (identity?.kind === "github") {
                return json({ repositories: repositories.filter((repository) => repository === identity.repository) });
            }
            return json({ repositories });
        },
    );

    @Endpoint({ summary: "List predictions for one repository" })
    static listPredictions = router.get<
        RequestSpec<QueryParams<{ repository: string }>>,
        ResponseSpec<{ predictions: Prediction[] }>
    >("/v1/predictions", async (request, deps) => {
        const repository = requiredRepository(request.query.repository, deps.identity);
        return json({ predictions: await resolveService(deps).predictions(repository) });
    });

    @Endpoint({ summary: "List observations for one repository" })
    static listObservations = router.get<
        RequestSpec<QueryParams<{ repository: string }>>,
        ResponseSpec<{ observations: Observation[] }>
    >("/v1/observations", async (request, deps) => {
        const repository = requiredRepository(request.query.repository, deps.identity);
        return json({ observations: await resolveService(deps).observations(repository) });
    });
}

export async function handleRequest(request: Request, deps: TrackerDeps): Promise<Response> {
    const url = new URL(request.url);
    let identity = deps.identity;
    if (url.pathname !== "/health") {
        try {
            identity = await authenticate(request, {
                apiToken: deps.apiToken,
                audience: deps.audience ?? url.origin,
                verifyOidc: deps.verifyOidc,
            });
        } catch (error) {
            return failure(error);
        }
    }
    try {
        const response = await router.fetch(request, { ...deps, identity });
        return response ?? json({ error: "not found" }, { status: 404 });
    } catch (error) {
        return failure(error);
    }
}

function resolveService(deps: TrackerDeps): AccuracyService {
    useContainer().registerFactory(LEDGER, () => deps.ledger, { singleton: false });
    return useContainer().resolve(AccuracyService);
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

function failure(error: unknown): Response {
    if (error instanceof HttpError) return json({ error: error.message }, { status: error.status });
    const message = error instanceof Error ? error.message : "request failed";
    const status = message.includes("required") || message.includes("must") ? 400 : 500;
    return json({ error: message }, { status });
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
