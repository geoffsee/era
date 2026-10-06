import { AnthropicChatModel, WorkersAiChatModel } from "@di-framework/ai";
import { CloudflareEnvironment } from "@di-framework/cloudflare";
import { expect, test } from "bun:test";
import { createTestDatabase } from "../../test/helpers/accuracy.ts";
import {
    CLOUDFLARE_BINDING_OPTIONS,
    DEFAULT_CHAT_MODEL,
    WorkerConfiguration,
    workerSettings,
} from "./configuration.ts";

const db = createTestDatabase();
const ai = { run: async () => ({ response: "{}" }) };

function bindings(values: Record<string, unknown>): CloudflareEnvironment {
    return new CloudflareEnvironment({ ...CLOUDFLARE_BINDING_OPTIONS, bindings: values });
}

test("the connector classifies declared secrets apart from vars and hands beans the live bindings", () => {
    const env = bindings({ DB: db, API_TOKEN: "admin", PUBLIC_API_URL: "https://era.test", OIDC_AUDIENCE: "" });
    expect(env.getBinding("API_TOKEN")?.kind).toBe("secret");
    expect(env.getBinding("PUBLIC_API_URL")?.kind).toBe("var");
    const configuration = new WorkerConfiguration();
    expect(configuration.database(env)).toBe(db);
    expect(workerSettings(env)).toEqual({
        apiToken: "admin",
        oidcAudience: undefined,
        auth: {
            PUBLIC_API_URL: "https://era.test",
            GITHUB_APP_ID: "",
            GITHUB_APP_SLUG: "",
            GITHUB_CLIENT_ID: "",
            GITHUB_CLIENT_SECRET: "",
            AUTH_SECRET: "",
        },
    });
    expect(workerSettings(bindings({})).auth).toBeUndefined();
    expect(configuration.database(bindings({}))).toBeUndefined();
});

test("the chat model bean prefers an Anthropic key, then the Workers AI binding, then nothing", () => {
    const configuration = new WorkerConfiguration();
    const anthropic = configuration.chatModel(bindings({ ANTHROPIC_API_KEY: "sk-test", AI: ai }));
    expect(anthropic).toBeInstanceOf(AnthropicChatModel);
    expect(anthropic?.options?.model).toBe(DEFAULT_CHAT_MODEL);
    expect(
        configuration.chatModel(bindings({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_MODEL: "claude-sonnet-5-5" }))
            ?.options?.model,
    ).toBe("claude-sonnet-5-5");

    const workers = configuration.chatModel(
        bindings({ AI: ai, WORKERS_AI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }),
    );
    expect(workers).toBeInstanceOf(WorkersAiChatModel);
    expect(workers?.options?.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");

    expect(configuration.chatModel(bindings({ AI: { notABinding: true } }))).toBeUndefined();
    expect(configuration.chatModel(bindings({}))).toBeUndefined();
});
