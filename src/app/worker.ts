import { createLedger } from "./composition.ts";
import { type AuthConfig, AuthService, authFailure } from "../services/auth-service.ts";
import { AuthStore } from "../auth/store.ts";
import { handleRequest } from "./http.ts";
import type { SqlDatabase } from "../persistence/database.ts";

export interface Env extends Partial<AuthConfig> {
    DB: SqlDatabase;
    API_TOKEN?: string;
    OIDC_AUDIENCE?: string;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const ledger = createLedger(env.DB);
        await ledger.ensureSchema();
        let auth: AuthService | undefined;
        if (env.PUBLIC_API_URL) {
            try {
                auth = new AuthService(new AuthStore(env.DB), env as AuthConfig);
            } catch (error) {
                return authFailure(error);
            }
        }
        return handleRequest(request, {
            ledger,
            apiToken: env.API_TOKEN ?? "",
            audience: env.OIDC_AUDIENCE || new URL(request.url).origin,
            auth,
        });
    },
    async scheduled(_event: unknown, env: Env): Promise<void> {
        if (env.PUBLIC_API_URL) await new AuthStore(env.DB).purge();
    },
};
