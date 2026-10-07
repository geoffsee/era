import { applyAuthHeaders, requireAuthExcept, withAuthErrors } from "@di-framework/auth/http";
import { useContainer } from "@di-framework/core/container";
import { json, TypedRouter } from "@di-framework/http/portable";
import { eraStrategy, HttpError } from "../core/auth/access.ts";
import { InputError } from "../core/tracking/model.ts";
import { API_TOKEN, WORKER_SETTINGS, type WorkerSettings } from "./configuration.ts";
import { ForecastSchema } from "./repositories/forecast-schema.ts";
import { AuthService, authFailure } from "./services/auth-service.ts";

const container = useContainer();
export const settings = () => container.resolve<WorkerSettings>(WORKER_SETTINGS);

/**
 * One router for the Worker. Controllers declare `@Endpoint` routes on it.
 * `routes.ts` imports those controllers so the static routes register, then adds the 404.
 */
export const router = TypedRouter({
    before: [
        async (input) => {
            const request = input as Request;
            try {
                await container.resolve(ForecastSchema).ensure();
            } catch {
                throw new HttpError("Forecast storage is unavailable; retry", 503);
            }
            const { oidcAudience, auth } = settings();
            return requireAuthExcept([/^\/health$/, /^\/auth\//], {
                strategy: eraStrategy({
                    apiToken: () => container.resolve<() => string>(API_TOKEN)(),
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

/** The value passed to a route handler is the Fetch request. The router's declared type omits Request methods. */
export function asHttpRequest<T>(request: T): T & Request {
    return request as T & Request;
}

/** Stops a request whose body exceeds `limit` before the router parses it. */
export async function capRequestBody(request: Request, limit: number, message: string): Promise<void> {
    const declared = request.headers.get("content-length");
    if (declared !== null && Number(declared) > limit) throw new HttpError(message, 413);
    const reader = request.clone().body?.getReader();
    if (!reader) return;
    let size = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) {
                await reader.cancel();
                throw new HttpError(message, 413);
            }
        }
    } finally {
        reader.releaseLock();
    }
}

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
