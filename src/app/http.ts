import { applyAuthHeaders, requireAuthExcept, withAuthErrors } from "@di-framework/auth/http";
import { json, TypedRouter } from "@di-framework/http/portable";
import { AuthController } from "./controllers/auth-controller.ts";
import { AuthService } from "./services/auth-service.ts";
import { authFailure } from "./services/auth-service.ts";
import { ForecastInputError } from "./services/forecast-service.ts";
import { eraStrategy, HttpError } from "../core/auth/access.ts";
import { useContainer } from "@di-framework/core/container";
import { ForecastController } from "./controllers/forecast-controller.ts";
import { TrackingController } from "./controllers/tracking-controller.ts";
import { AccuracyService } from "./services/accuracy-service.ts";

export type TrackerDeps = {
    accuracyService: AccuracyService;
    apiToken: string;
    audience?: string;
    auth?: AuthService;
    verifyOidc?: (token: string, audience: string) => Promise<{ repository: string; workflowRef?: string }>;
};

export async function handleRequest(request: Request, deps: TrackerDeps): Promise<Response> {
    const url = new URL(request.url);
    const container = useContainer();
    container.registerFactory(AccuracyService, () => deps.accuracyService, { singleton: false });
    container.registerFactory(AuthService, () => deps.auth, { singleton: false });
    const authController = container.resolve(AuthController);
    const forecastController = container.resolve(ForecastController);
    const trackingController = container.resolve(TrackingController);
    const guard = requireAuthExcept([/^\/health$/, /^\/auth\//], {
        strategy: eraStrategy({
            apiToken: deps.apiToken,
            audience: deps.audience ?? url.origin,
            verifyOidc: deps.verifyOidc,
            authenticateEra: deps.auth ? (req) => deps.auth!.identity(req) : undefined,
        }),
        onUnauthenticated: (_request, error) => authFailure(error),
    });
    const router = TypedRouter({
        before: [(request) => guard(request as Request)],
        catch: withAuthErrors({ fallback: failure, log: () => {} }),
        finally: [applyAuthHeaders],
    });
    router.all("*", async (req: Request) => {
        const auth = await authController.handle(req, deps.apiToken);
        if (auth) return auth;
        const forecast = await forecastController.handle(req);
        if (forecast) return forecast;
        return (await trackingController.fetch(req)) ?? json({ error: "not found" }, { status: 404 });
    });
    return router.fetch(request);
}

function failure(error: unknown): Response {
    if (error instanceof HttpError && [401, 403, 429, 503].includes(error.status)) return authFailure(error);
    if (error instanceof ForecastInputError) return json({ error: error.message }, { status: 400 });
    if (error instanceof HttpError) return json({ error: error.message }, { status: error.status });
    const message = error instanceof Error ? error.message : "request failed";
    const status = message.includes("required") || message.includes("must") ? 400 : 500;
    return json({ error: message }, { status });
}
