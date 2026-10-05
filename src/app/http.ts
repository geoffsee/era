import { applyAuthHeaders, requireAuthExcept, withAuthErrors } from "@di-framework/auth/http";
import { useContainer } from "@di-framework/core/container";
import { json, TypedRouter } from "@di-framework/http/portable";
import { eraStrategy, HttpError } from "../core/auth/access.ts";
import { InputError } from "../core/tracking/model.ts";
import { WORKER_SETTINGS, type WorkerSettings } from "./configuration.ts";
import { AuthController } from "./controllers/auth-controller.ts";
import { ForecastController } from "./controllers/forecast-controller.ts";
import { TrackingController } from "./controllers/tracking-controller.ts";
import { ForecastSchema } from "./repositories/forecast-schema.ts";
import { AuthService, authFailure } from "./services/auth-service.ts";

const container = useContainer();
const settings = () => container.resolve<WorkerSettings>(WORKER_SETTINGS);

/** Storage readiness, then the bearer guard, then controllers resolved from the container. */
const router = TypedRouter({
    before: [
        async (input) => {
            const request = input as Request;
            try {
                await container.resolve(ForecastSchema).ensure();
            } catch {
                throw new HttpError("Forecast storage is unavailable; retry", 503);
            }
            const { apiToken, oidcAudience, auth } = settings();
            return requireAuthExcept([/^\/health$/, /^\/auth\//], {
                strategy: eraStrategy({
                    apiToken,
                    audience: oidcAudience ?? new URL(request.url).origin,
                    authenticateEra: auth ? (req) => container.resolve(AuthService).identity(req) : undefined,
                }),
                onUnauthenticated: (_request, error) => authFailure(error),
            })(request);
        },
    ],
    catch: withAuthErrors({ fallback: failure, log: () => {} }),
    finally: [applyAuthHeaders],
});

router.all("/auth/*", async (request: Request) => {
    if (!settings().auth) return authFailure(new HttpError("GitHub login is not configured on this Worker", 503));
    try {
        return await container.resolve(AuthController).handle(request);
    } catch (error) {
        // Resolving AuthService validates the GitHub App bindings; misconfiguration reads as an auth outage.
        return authFailure(error);
    }
});
router.all(
    "*",
    async (request: Request) =>
        (await container.resolve(ForecastController).handle(request)) ??
        (await container.resolve(TrackingController).fetch(request)) ??
        json({ error: "not found" }, { status: 404 }),
);

/** The one place domain errors become HTTP statuses. */
function failure(error: unknown): Response {
    if (error instanceof HttpError) {
        if ([401, 403, 429, 503].includes(error.status)) return authFailure(error);
        return json({ error: error.message }, { status: error.status });
    }
    if (error instanceof InputError) return json({ error: error.message }, { status: 400 });
    return json({ error: "request failed" }, { status: 500 });
}

export default router;
