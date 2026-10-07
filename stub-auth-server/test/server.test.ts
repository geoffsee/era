import { describe, expect, it } from "bun:test";
import { createStubAuthServer } from "../src/server.ts";

function generatePkce() {
    const rawBytes = crypto.getRandomValues(new Uint8Array(32));
    const codeVerifier = Buffer.from(rawBytes).toString("base64url");
    const digest = new Bun.CryptoHasher("sha256").update(codeVerifier).digest();
    const codeChallenge = Buffer.from(digest).toString("base64url");
    return { codeVerifier, codeChallenge };
}

describe("Stub Auth Server (di-framework + bun)", () => {
    const stub = createStubAuthServer({
        issuer: "http://localhost:8080",
        defaultSubject: "alice",
        githubUserId: 42,
        githubLogin: "octocat",
        githubName: "Mona Lisa Octocat",
    });

    it("serves health check and metadata at root", async () => {
        const res = await stub.fetch(new Request("http://localhost:8080/health"));
        expect(res.status).toBe(200);
        const data = (await res.json()) as {
            status: string;
            issuer: string;
            endpoints: { authorization: string; token: string; githubAuthorize: string };
        };
        expect(data.status).toBe("ok");
        expect(data.issuer).toBe("http://localhost:8080");
        expect(data.endpoints.authorization).toBe("http://localhost:8080/oauth/authorize");
        expect(data.endpoints.token).toBe("http://localhost:8080/oauth/token");
        expect(data.endpoints.githubAuthorize).toBe("http://localhost:8080/login/oauth/authorize");
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("responds to CORS preflight OPTIONS requests", async () => {
        const res = await stub.fetch(
            new Request("http://localhost:8080/oauth/token", {
                method: "OPTIONS",
                headers: {
                    Origin: "http://localhost:3000",
                    "Access-Control-Request-Method": "POST",
                },
            }),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    });

    it("serves OpenID Connect discovery metadata", async () => {
        const res = await stub.fetch(new Request("http://localhost:8080/.well-known/openid-configuration"));
        expect(res.status).toBe(200);
        const disco = (await res.json()) as {
            issuer: string;
            authorization_endpoint: string;
            token_endpoint: string;
            jwks_uri: string;
            userinfo_endpoint: string;
            response_types_supported: string[];
            code_challenge_methods_supported: string[];
        };
        expect(disco.issuer).toBe("http://localhost:8080");
        expect(disco.authorization_endpoint).toBe("http://localhost:8080/oauth/authorize");
        expect(disco.token_endpoint).toBe("http://localhost:8080/oauth/token");
        expect(disco.jwks_uri).toBe("http://localhost:8080/.well-known/jwks.json");
        expect(disco.userinfo_endpoint).toBe("http://localhost:8080/oauth/userinfo");
        expect(disco.response_types_supported).toEqual(["code"]);
        expect(disco.code_challenge_methods_supported).toEqual(["S256"]);
    });

    it("serves JWKS public keys", async () => {
        const res = await stub.fetch(new Request("http://localhost:8080/.well-known/jwks.json"));
        expect(res.status).toBe(200);
        const jwks = (await res.json()) as { keys: unknown[] };
        expect(Array.isArray(jwks.keys)).toBe(true);
        expect(jwks.keys.length).toBeGreaterThan(0);
    });

    it("completes full OAuth 2.0 PKCE flow with userinfo", async () => {
        const { codeVerifier, codeChallenge } = generatePkce();

        // 1. Authorization request
        const authUrl = new URL("http://localhost:8080/oauth/authorize");
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("client_id", "dev-client");
        authUrl.searchParams.set("redirect_uri", "http://localhost:3000/callback");
        authUrl.searchParams.set("scope", "openid profile email");
        authUrl.searchParams.set("code_challenge", codeChallenge);
        authUrl.searchParams.set("code_challenge_method", "S256");
        authUrl.searchParams.set("state", "state-1234");

        const authRes = await stub.fetch(new Request(authUrl.toString()));
        expect(authRes.status).toBe(302);
        const redirectLocation = authRes.headers.get("location");
        expect(redirectLocation).toBeDefined();

        const redirectUrl = new URL(redirectLocation!);
        expect(redirectUrl.origin + redirectUrl.pathname).toBe("http://localhost:3000/callback");
        expect(redirectUrl.searchParams.get("state")).toBe("state-1234");
        const code = redirectUrl.searchParams.get("code");
        expect(code).toBeDefined();

        // 2. Token exchange with PKCE verifier
        const tokenRes = await stub.fetch(
            new Request("http://localhost:8080/oauth/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "authorization_code",
                    code: code!,
                    code_verifier: codeVerifier,
                    client_id: "dev-client",
                    client_secret: "dev-secret",
                    redirect_uri: "http://localhost:3000/callback",
                }).toString(),
            }),
        );
        expect(tokenRes.status).toBe(200);
        const tokenData = (await tokenRes.json()) as {
            token_type: string;
            access_token: string;
            id_token: string;
            refresh_token: string;
        };
        expect(tokenData.token_type).toBe("Bearer");
        expect(typeof tokenData.access_token).toBe("string");
        expect(typeof tokenData.id_token).toBe("string");
        expect(typeof tokenData.refresh_token).toBe("string");

        // 3. UserInfo request using access token
        const userinfoRes = await stub.fetch(
            new Request("http://localhost:8080/oauth/userinfo", {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
            }),
        );
        expect(userinfoRes.status).toBe(200);
        const claims = (await userinfoRes.json()) as { sub: string; email: string };
        expect(claims.sub).toBe("alice");
        expect(claims.email).toBe("alice@example.com");

        // 4. Refresh token grant
        const refreshRes = await stub.fetch(
            new Request("http://localhost:8080/oauth/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "refresh_token",
                    refresh_token: tokenData.refresh_token,
                    client_id: "dev-client",
                    client_secret: "dev-secret",
                }).toString(),
            }),
        );
        expect(refreshRes.status).toBe(200);
        const refreshedData = (await refreshRes.json()) as {
            access_token: string;
            refresh_token: string;
        };
        expect(typeof refreshedData.access_token).toBe("string");
        expect(typeof refreshedData.refresh_token).toBe("string");

        // 5. Revocation
        const revokeRes = await stub.fetch(
            new Request("http://localhost:8080/oauth/revoke", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    token: refreshedData.refresh_token,
                }).toString(),
            }),
        );
        expect(revokeRes.status).toBe(200);
    });

    it("supports dynamic client registration for dev", async () => {
        const clientRes = await stub.fetch(
            new Request("http://localhost:8080/dev/clients", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    clientId: "custom-app",
                    clientSecret: "custom-secret",
                    clientName: "Custom App",
                    redirectUris: ["http://localhost:4000/callback"],
                    allowedGrantTypes: ["authorization_code"],
                    allowedScopes: ["openid"],
                }),
            }),
        );
        expect(clientRes.status).toBe(201);
        const registered = (await clientRes.json()) as { ok: boolean; client: { clientId: string } };
        expect(registered.ok).toBe(true);
        expect(registered.client.clientId).toBe("custom-app");

        const client = await stub.clientStore.getClient("custom-app");
        expect(client).toBeDefined();
        expect(client?.clientId).toBe("custom-app");
    });

    describe("GitHub Emulation Surface", () => {
        it("emulates GitHub OAuth authorization redirect", async () => {
            const { codeChallenge } = generatePkce();
            const authUrl = new URL("http://localhost:8080/login/oauth/authorize");
            authUrl.searchParams.set("client_id", "dev-client");
            authUrl.searchParams.set("redirect_uri", "http://localhost:8787/auth/github/callback");
            authUrl.searchParams.set("state", "gh-state-123");
            authUrl.searchParams.set("code_challenge", codeChallenge);
            authUrl.searchParams.set("code_challenge_method", "S256");

            const res = await stub.fetch(new Request(authUrl.toString()));
            expect(res.status).toBe(302);
            const location = res.headers.get("location");
            expect(location).toBeDefined();

            const redirectUrl = new URL(location!);
            expect(redirectUrl.origin + redirectUrl.pathname).toBe("http://localhost:8787/auth/github/callback");
            expect(redirectUrl.searchParams.get("state")).toBe("gh-state-123");
            expect(redirectUrl.searchParams.get("code")?.startsWith("gh_code_")).toBe(true);
        });

        it("emulates GitHub OAuth token exchange with PKCE verification", async () => {
            const { codeVerifier, codeChallenge } = generatePkce();

            // 1. Authorize
            const authUrl = new URL("http://localhost:8080/login/oauth/authorize");
            authUrl.searchParams.set("client_id", "dev-client");
            authUrl.searchParams.set("redirect_uri", "http://localhost:8787/auth/github/callback");
            authUrl.searchParams.set("code_challenge", codeChallenge);
            authUrl.searchParams.set("code_challenge_method", "S256");

            const authRes = await stub.fetch(new Request(authUrl.toString()));
            const code = new URL(authRes.headers.get("location")!).searchParams.get("code");

            // 2. Token exchange
            const tokenRes = await stub.fetch(
                new Request("http://localhost:8080/login/oauth/access_token", {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({
                        client_id: "dev-client",
                        client_secret: "dev-secret",
                        code: code!,
                        code_verifier: codeVerifier,
                    }).toString(),
                }),
            );
            expect(tokenRes.status).toBe(200);
            const tokenData = (await tokenRes.json()) as {
                access_token: string;
                refresh_token: string;
                token_type: string;
                expires_in: number;
            };
            expect(tokenData.access_token.startsWith("ghu_")).toBe(true);
            expect(tokenData.refresh_token.startsWith("ghr_")).toBe(true);
            expect(tokenData.token_type).toBe("bearer");

            // 3. Refresh token flow
            const refreshRes = await stub.fetch(
                new Request("http://localhost:8080/login/oauth/access_token", {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({
                        grant_type: "refresh_token",
                        refresh_token: tokenData.refresh_token,
                    }).toString(),
                }),
            );
            expect(refreshRes.status).toBe(200);
            const refreshData = (await refreshRes.json()) as { access_token: string };
            expect(refreshData.access_token.startsWith("ghu_refreshed_")).toBe(true);
        });

        it("rejects missing, unknown, reused, mismatched, and unverified GitHub codes", async () => {
            const exchange = (body: Record<string, string>) =>
                stub.fetch(
                    new Request("http://localhost:8080/login/oauth/access_token", {
                        method: "POST",
                        headers: { "Content-Type": "application/x-www-form-urlencoded" },
                        body: new URLSearchParams(body).toString(),
                    }),
                );
            const missing = await exchange({});
            expect(missing.status).toBe(400);
            expect(await missing.json()).toEqual({ error: "bad_verification_code" });

            const unknown = await exchange({ code: "gh_code_missing" });
            expect(unknown.status).toBe(400);

            const { codeVerifier, codeChallenge } = generatePkce();
            const redirectUri = "http://localhost:8787/auth/github/callback";
            const authorize = async () => {
                const authUrl = new URL("http://localhost:8080/login/oauth/authorize");
                authUrl.searchParams.set("redirect_uri", redirectUri);
                authUrl.searchParams.set("code_challenge", codeChallenge);
                authUrl.searchParams.set("code_challenge_method", "S256");
                const authRes = await stub.fetch(new Request(authUrl.toString()));
                return new URL(authRes.headers.get("location")!).searchParams.get("code")!;
            };

            const mismatched = await exchange({
                code: await authorize(),
                code_verifier: codeVerifier,
                redirect_uri: "http://evil.example/callback",
            });
            expect(mismatched.status).toBe(400);

            const code = await authorize();
            const unverified = await exchange({ code, redirect_uri: redirectUri });
            expect(unverified.status).toBe(400);

            const wrongVerifier = await exchange({
                code: await authorize(),
                code_verifier: "not-the-verifier",
                redirect_uri: redirectUri,
            });
            expect(wrongVerifier.status).toBe(400);

            const acceptedCode = await authorize();
            const accepted = await exchange({
                code: acceptedCode,
                code_verifier: codeVerifier,
                redirect_uri: redirectUri,
            });
            expect(accepted.status).toBe(200);
            const reused = await exchange({
                code: acceptedCode,
                code_verifier: codeVerifier,
                redirect_uri: redirectUri,
            });
            expect(reused.status).toBe(400);
        });

        it("emulates GitHub REST API endpoints (/user, /repos, collaborators, installations)", async () => {
            const token = "ghu_dummy_token";

            // 1. GET /user
            const userRes = await stub.fetch(
                new Request("http://localhost:8080/user", {
                    headers: { Authorization: `Bearer ${token}` },
                }),
            );
            expect(userRes.status).toBe(200);
            const user = (await userRes.json()) as { id: number; login: string };
            expect(user.id).toBe(42);
            expect(user.login).toBe("octocat");

            // 2. GET /repos/:owner/:repo
            const repoRes = await stub.fetch(
                new Request("http://localhost:8080/repos/acme/widgets", {
                    headers: { Authorization: `Bearer ${token}` },
                }),
            );
            expect(repoRes.status).toBe(200);
            const repo = (await repoRes.json()) as { id: number; full_name: string; owner: { id: number } };
            expect(repo.full_name).toBe("acme/widgets");
            expect(repo.owner.id).toBe(42);

            // 3. GET /repos/:owner/:repo/collaborators/:login/permission
            const permRes = await stub.fetch(
                new Request("http://localhost:8080/repos/acme/widgets/collaborators/octocat/permission", {
                    headers: { Authorization: `Bearer ${token}` },
                }),
            );
            expect(permRes.status).toBe(200);
            const perm = (await permRes.json()) as { permission: string };
            expect(perm.permission).toBe("admin");

            // 4. GET /user/installations
            const instRes = await stub.fetch(
                new Request("http://localhost:8080/user/installations", {
                    headers: { Authorization: `Bearer ${token}` },
                }),
            );
            expect(instRes.status).toBe(200);
            const inst = (await instRes.json()) as {
                installations: { id: number; app_id: number; account: { id: number } }[];
            };
            expect(inst.installations.length).toBeGreaterThan(0);
            expect(inst.installations[0]?.app_id).toBe(5200437);
            expect(inst.installations[0]?.account.id).toBe(42);

            // 5. GET /user/installations/:id/repositories
            const instReposRes = await stub.fetch(
                new Request("http://localhost:8080/user/installations/1/repositories", {
                    headers: { Authorization: `Bearer ${token}` },
                }),
            );
            expect(instReposRes.status).toBe(200);
            const instRepos = (await instReposRes.json()) as { repositories: { full_name: string }[] };
            expect(instRepos.repositories.some((r) => r.full_name === "acme/widgets")).toBe(true);
        });
    });
});
