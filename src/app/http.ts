import { json } from "@di-framework/http/portable";
import { handleAuthRequest } from "../controllers/auth-controller.ts";
import type { AuthService } from "../services/auth-service.ts";
import { authFailure } from "../services/auth-service.ts";
import { ForecastInputError } from "../services/forecast-service.ts";
import { authenticate, HttpError, type Identity } from "../auth/access.ts";
import { useContainer } from "@di-framework/core/container";
import { ForecastController } from "../controllers/forecast-controller.ts";
import { TrackingController } from "../controllers/tracking-controller.ts";
import { AccuracyService } from "../services/accuracy-service.ts";

export type TrackerDeps = {
    accuracyService: AccuracyService;
    apiToken: string;
    audience?: string;
    identity?: Identity;
    auth?: AuthService;
    verifyOidc?: (token: string, audience: string) => Promise<{ repository: string; workflowRef?: string }>;
};

export async function handleRequest(request: Request, deps: TrackerDeps): Promise<Response> {
    const url = new URL(request.url);
    const authResponse = await handleAuthRequest(request, deps.auth, deps.apiToken);
    if (authResponse) return authResponse;
    let identity = deps.identity;
    if (url.pathname !== "/health") {
        try {
            identity = await authenticate(request, {
                apiToken: deps.apiToken,
                audience: deps.audience ?? url.origin,
                verifyOidc: deps.verifyOidc,
                authenticateEra: deps.auth ? (req) => deps.auth!.identity(req) : undefined,
            });
        } catch (error) {
            return authFailure(error);
        }
    }
    try {
        const container = useContainer().fork();
        container.registerFactory(AccuracyService, () => deps.accuracyService, { singleton: false });
        const forecast = await container.resolve(ForecastController).handle(request, identity);
        if (forecast) return forecast;
        const response = await container.resolve(TrackingController).fetch(request, { identity });
        return response ?? json({ error: "not found" }, { status: 404 });
    } catch (error) {
        return failure(error);
    }
}

function failure(error: unknown): Response {
    if (error instanceof ForecastInputError) return json({ error: error.message }, { status: 400 });
    if (error instanceof HttpError) return json({ error: error.message }, { status: error.status });
    const message = error instanceof Error ? error.message : "request failed";
    const status = message.includes("required") || message.includes("must") ? 400 : 500;
    return json({ error: message }, { status });
}
