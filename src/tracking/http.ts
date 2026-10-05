import { json } from "@di-framework/http/portable";
import { handleAuthRequest } from "../auth/http.ts";
import type { AuthService } from "../auth/service.ts";
import { authFailure } from "../auth/service.ts";
import { ForecastInputError } from "../forecast-service.ts";
import { authenticate, HttpError, type Identity } from "./auth.ts";
import { createControllers } from "./composition.ts";
import type { Ledger } from "./ledger.ts";

export type TrackerDeps = {
    ledger: Ledger;
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
        const controllers = createControllers(deps.ledger);
        const forecast = await controllers.forecast.handle(request, identity);
        if (forecast) return forecast;
        const response = await controllers.tracking.fetch(request, { identity });
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
