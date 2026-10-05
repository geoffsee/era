import { env } from "cloudflare:workers";
import { Bean, Configuration } from "@di-framework/core/decorators";
import type { SqlDatabase } from "../core/persistence/database.ts";
import type { AuthConfig } from "./services/auth-service.ts";

/** Worker bindings declared in wrangler.jsonc and secrets. */
export interface Env extends Partial<AuthConfig> {
    DB: SqlDatabase;
    API_TOKEN?: string;
    OIDC_AUDIENCE?: string;
}

/** The opened D1 handle; the Worker runtime creates it outside the container. */
export const SQL_DATABASE = "era.sql-database";
/** Request authentication settings. */
export const WORKER_SETTINGS = "era.worker-settings";
/** GitHub login configuration, or undefined when login is disabled on this Worker. */
export const AUTH_CONFIG = "era.auth-config";

export type WorkerSettings = {
    /** Admin bearer token; empty disables admin access. */
    apiToken: string;
    /** OIDC audience for GitHub Actions tokens; defaults to the request origin. */
    oidcAudience?: string;
    /** Present only when PUBLIC_API_URL is bound. */
    auth?: AuthConfig;
};

export function workerSettings(bindings: Env): WorkerSettings {
    return {
        apiToken: bindings.API_TOKEN ?? "",
        oidcAudience: bindings.OIDC_AUDIENCE || undefined,
        auth: bindings.PUBLIC_API_URL
            ? {
                  PUBLIC_API_URL: bindings.PUBLIC_API_URL,
                  GITHUB_APP_ID: bindings.GITHUB_APP_ID ?? "",
                  GITHUB_APP_SLUG: bindings.GITHUB_APP_SLUG ?? "",
                  GITHUB_CLIENT_ID: bindings.GITHUB_CLIENT_ID ?? "",
                  GITHUB_CLIENT_SECRET: bindings.GITHUB_CLIENT_SECRET ?? "",
                  AUTH_SECRET: bindings.AUTH_SECRET ?? "",
              }
            : undefined,
    };
}

/** The only module that reads Worker bindings; everything else injects these beans. */
@Configuration()
export class WorkerConfiguration {
    @Bean(SQL_DATABASE)
    database(): SqlDatabase {
        return env.DB;
    }

    @Bean(WORKER_SETTINGS)
    settings(): WorkerSettings {
        return workerSettings(env);
    }

    @Bean(AUTH_CONFIG, { dependencies: [WORKER_SETTINGS] })
    authConfig(settings: WorkerSettings): AuthConfig | undefined {
        return settings.auth;
    }
}
