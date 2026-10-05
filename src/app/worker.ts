import { ensureForecastSchema } from "../persistence/schema.ts";
import { useContainer } from "@di-framework/core/container";
import { AccuracyService } from "../services/accuracy-service.ts";
import { type AuthConfig, AuthService, authFailure } from "../services/auth-service.ts";
import { AuthStore } from "../repositories/auth-store.ts";
import { handleRequest } from "./http.ts";
import { SQL_DATABASE, type SqlDatabase } from "../persistence/database.ts";

export interface Env extends Partial<AuthConfig> {
    DB: SqlDatabase;
    API_TOKEN?: string;
    OIDC_AUDIENCE?: string;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const container = useContainer();
        container.registerFactory(SQL_DATABASE, () => env.DB, { singleton: false });
        const accuracyService = container.construct(AccuracyService);
        await ensureForecastSchema(env.DB);
        let auth: AuthService | undefined;
        if (env.PUBLIC_API_URL) {
            try {
                auth = new AuthService(new AuthStore(env.DB), env as AuthConfig);
            } catch (error) {
                return authFailure(error);
            }
        }
        return handleRequest(request, {
            accuracyService,
            apiToken: env.API_TOKEN ?? "",
            audience: env.OIDC_AUDIENCE || new URL(request.url).origin,
            auth,
        });
    },
    async scheduled(_event: unknown, env: Env): Promise<void> {
        if (env.PUBLIC_API_URL) await new AuthStore(env.DB).purge();
    },
};
