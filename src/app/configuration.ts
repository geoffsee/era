import {
    AnthropicChatModel,
    type ChatModel,
    DEFAULT_WORKERS_AI_MODEL,
    isWorkersAiBinding,
    WorkersAiChatModel,
} from "@di-framework/ai";
import { CloudflareEnvironment } from "@di-framework/cloudflare";
import { Bean, Configuration } from "@di-framework/core/decorators";
import type { SqlDatabase } from "../core/persistence/database.ts";
import type { AuthConfig, AuthSecretSource } from "./services/auth-service.ts";

/** Worker bindings declared in wrangler.jsonc and secrets. */
export type Env = Partial<AuthConfig> & {
    DB: SqlDatabase;
    /** Workers AI binding; enables in-context inference without a provider key. */
    AI?: unknown;
    API_TOKEN?: string;
    GITHUB_CLIENT_SECRET?: string;
    AUTH_SECRET?: string;
    OIDC_AUDIENCE?: string;
    /** Preferred inference provider; the model defaults to DEFAULT_CHAT_MODEL. */
    ANTHROPIC_API_KEY?: string;
    ANTHROPIC_MODEL?: string;
    /** Workers AI model used when no Anthropic key is bound. */
    WORKERS_AI_MODEL?: string;
};

/** String bindings that are secrets rather than vars, so the connector never classifies them as plain config. */
export const SECRET_NAMES = ["API_TOKEN", "ANTHROPIC_API_KEY", "GITHUB_CLIENT_SECRET", "AUTH_SECRET"] as const;
/** Connector options shared by the Worker entry point and the test harness. */
export const CLOUDFLARE_BINDING_OPTIONS = { secretNames: SECRET_NAMES, localFallback: false } as const;

/** The opened D1 handle; the Worker runtime creates it outside the container. */
export const SQL_DATABASE = "era.sql-database";
/** Request authentication settings. Secrets are not copied onto this object. */
export const WORKER_SETTINGS = "era.worker-settings";
/** GitHub login configuration, or undefined when login is disabled on this Worker. */
export const AUTH_CONFIG = "era.auth-config";
/** Reads GITHUB_CLIENT_SECRET and AUTH_SECRET from the Worker bindings at use. */
export const AUTH_SECRETS = "era.auth-secrets";
/** Reads API_TOKEN from the Worker bindings at use. */
export const API_TOKEN = "era.api-token";
/** Chat model for in-context inference, or undefined when neither a provider key nor an AI binding exists. */
export const CHAT_MODEL = "era.chat-model";

export const DEFAULT_CHAT_MODEL = "claude-opus-5-5";

export type WorkerSettings = {
    /** OIDC audience for GitHub Actions tokens; defaults to the request origin. */
    oidcAudience?: string;
    /** Present only when PUBLIC_API_URL is bound. Contains no secrets. */
    auth?: AuthConfig;
};

export function workerSettings(bindings: CloudflareEnvironment): WorkerSettings {
    const publicApiUrl = text(bindings, "PUBLIC_API_URL");
    return {
        oidcAudience: text(bindings, "OIDC_AUDIENCE"),
        auth: publicApiUrl
            ? {
                  PUBLIC_API_URL: publicApiUrl,
                  GITHUB_APP_ID: text(bindings, "GITHUB_APP_ID") ?? "",
                  GITHUB_APP_SLUG: text(bindings, "GITHUB_APP_SLUG") ?? "",
                  GITHUB_CLIENT_ID: text(bindings, "GITHUB_CLIENT_ID") ?? "",
                  GITHUB_URL: text(bindings, "GITHUB_URL"),
              }
            : undefined,
    };
}

/**
 * Turns the published Worker bindings into application beans. `@di-framework/cloudflare` publishes
 * the env and classifies each binding; nothing else in the application reads bindings.
 */
@Configuration()
export class WorkerConfiguration {
    @Bean(SQL_DATABASE, { dependencies: [CloudflareEnvironment] })
    database(bindings: CloudflareEnvironment): SqlDatabase | undefined {
        return bindings.getBinding("DB")?.binding as SqlDatabase | undefined;
    }

    @Bean(WORKER_SETTINGS, { dependencies: [CloudflareEnvironment] })
    settings(bindings: CloudflareEnvironment): WorkerSettings {
        return workerSettings(bindings);
    }

    @Bean(AUTH_CONFIG, { dependencies: [WORKER_SETTINGS] })
    authConfig(settings: WorkerSettings): AuthConfig | undefined {
        return settings.auth;
    }

    @Bean(AUTH_SECRETS, { dependencies: [CloudflareEnvironment] })
    authSecrets(bindings: CloudflareEnvironment): AuthSecretSource {
        return {
            clientSecret: () => requiredText(bindings, "GITHUB_CLIENT_SECRET"),
            authSecret: () => requiredText(bindings, "AUTH_SECRET"),
        };
    }

    @Bean(API_TOKEN, { dependencies: [CloudflareEnvironment] })
    apiToken(bindings: CloudflareEnvironment): () => string {
        return () => text(bindings, "API_TOKEN") ?? "";
    }

    /** An Anthropic key wins; otherwise the Workers AI binding serves inference; otherwise inference is off. */
    @Bean(CHAT_MODEL, { dependencies: [CloudflareEnvironment] })
    chatModel(bindings: CloudflareEnvironment): ChatModel | undefined {
        const apiKey = text(bindings, "ANTHROPIC_API_KEY");
        if (apiKey)
            return new AnthropicChatModel({ apiKey, model: text(bindings, "ANTHROPIC_MODEL") ?? DEFAULT_CHAT_MODEL });
        const ai = bindings.getBinding("AI")?.binding;
        if (isWorkersAiBinding(ai))
            return WorkersAiChatModel.of(ai, { model: text(bindings, "WORKERS_AI_MODEL") ?? DEFAULT_WORKERS_AI_MODEL });
        return undefined;
    }
}

function text(bindings: CloudflareEnvironment, name: string): string | undefined {
    const value = bindings.getBinding(name)?.binding;
    return typeof value === "string" && value ? value : undefined;
}

function requiredText(bindings: CloudflareEnvironment, name: string): string {
    const value = text(bindings, name);
    if (!value) throw new Error(`${name} is not configured`);
    return value;
}
