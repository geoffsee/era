import { describe, expect, test } from "bun:test";
import { handleRequest } from "../app/http.ts";
import { InMemoryForecastRepository } from "../repositories/forecast-repository.ts";
import { GITHUB_OIDC_ISSUER, verifyGitHubOidc } from "./oidc.ts";

describe("GitHub Actions OIDC", () => {
    test("accepts a token signed by the GitHub issuer for its own repository", async () => {
        const { token, jwks } = await signOidc({ repository: "acme/app", audience: "https://tracker.test" });
        const claims = await verifyGitHubOidc(token, "https://tracker.test", { jwks, now: 1_700_000_000_000 });
        expect(claims.repository).toBe("acme/app");
        expect(claims.workflowRef).toContain("acme/app");
    });

    test("rejects a token for a different audience", async () => {
        const { token, jwks } = await signOidc({ repository: "acme/app", audience: "https://other.example" });
        await expect(verifyGitHubOidc(token, "https://tracker.test", { jwks, now: 1_700_000_000_000 })).rejects.toThrow(
            /audience/,
        );
    });

    test("a workflow can write only its own repository", async () => {
        const forecastRepository = new InMemoryForecastRepository();
        const verifyOidc = async () => ({ repository: "acme/app" });
        const denied = await handleRequest(
            bearer("POST", "/v1/observations", {
                observations: [{ repository: "other/app", subject: "pr:1", metric: "tokens", actual: 4 }],
            }),
            { forecastRepository, apiToken: "static", audience: "https://tracker.test", verifyOidc },
        );
        expect(denied.status).toBe(403);

        const allowed = await handleRequest(
            bearer("POST", "/v1/observations", {
                observations: [{ repository: "acme/app", subject: "pr:1", metric: "tokens", actual: 4 }],
            }),
            { forecastRepository, apiToken: "static", audience: "https://tracker.test", verifyOidc },
        );
        expect(allowed.status).toBe(200);
        expect(await forecastRepository.repositories()).toEqual(["acme/app"]);
    });
});

async function signOidc(input: { repository: string; audience: string }): Promise<{
    token: string;
    jwks: { keys: Array<{ kty: "RSA"; n: string; e: string; alg?: string; kid?: string; use?: string }> };
}> {
    const key = await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
    );
    const exported = await crypto.subtle.exportKey("jwk", key.publicKey);
    const jwk = {
        kty: "RSA" as const,
        n: exported.n ?? "",
        e: exported.e ?? "",
        alg: "RS256",
        kid: "test-key",
        use: "sig",
    };
    const header = base64Url(JSON.stringify({ alg: "RS256", kid: "test-key" }));
    const payload = base64Url(
        JSON.stringify({
            iss: GITHUB_OIDC_ISSUER,
            aud: input.audience,
            exp: 1_700_000_000 + 600,
            repository: input.repository,
            job_workflow_ref: `${input.repository}/.github/workflows/track-estimate.yml@refs/heads/main`,
        }),
    );
    const signature = await crypto.subtle.sign(
        { name: "RSASSA-PKCS1-v1_5" },
        key.privateKey,
        new TextEncoder().encode(`${header}.${payload}`),
    );
    return {
        token: `${header}.${payload}.${base64UrlBytes(new Uint8Array(signature))}`,
        jwks: { keys: [jwk] },
    };
}

function bearer(method: string, path: string, body: unknown): Request {
    return new Request(`https://tracker.test${path}`, {
        method,
        headers: { authorization: "Bearer header.payload.signature", "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

function base64Url(value: string): string {
    return base64UrlBytes(new TextEncoder().encode(value));
}

function base64UrlBytes(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
