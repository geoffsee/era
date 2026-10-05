import { mock } from "bun:test";
import type { Env } from "../src/app/configuration.ts";
import type { CredentialOptions } from "../src/core/auth/access.ts";

/** Bun has no Worker runtime. Fixtures assign the bindings that WorkerConfiguration reads. */
export const env: Partial<Env> = {};
mock.module("cloudflare:workers", () => ({ env }));

/** GitHub OIDC double; when unset, requests reach the real verifier. */
export const oidc: { verify?: CredentialOptions["verifyOidc"] } = {};
const { verifyGitHubOidc } = await import("../src/core/auth/oidc.ts");
mock.module("../src/core/auth/oidc.ts", () => ({
    verifyGitHubOidc: (...[token, audience, options]: Parameters<typeof verifyGitHubOidc>) =>
        oidc.verify ? oidc.verify(token, audience) : verifyGitHubOidc(token, audience, options),
}));
