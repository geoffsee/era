import { D1Ledger, type SqlDatabase } from "./tracking/ledger.ts";
import { handleRequest } from "./tracking/http.ts";

export interface Env {
    DB: SqlDatabase;
    API_TOKEN?: string;
    OIDC_AUDIENCE?: string;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const ledger = new D1Ledger(env.DB);
        await ledger.ensureSchema();
        return handleRequest(request, {
            ledger,
            apiToken: env.API_TOKEN ?? "",
            audience: env.OIDC_AUDIENCE || new URL(request.url).origin,
        });
    },
};
