import { keyService, memoryKeyStore } from "@di-framework/auth";
import {
    AuthorizationServer,
    InMemoryAuthCodeStore,
    InMemoryClientStore,
    InMemoryConsentStore,
    InMemoryOAuthTokenStore,
    handleOAuthServerRequest,
    type OAuthClientConfig,
} from "@di-framework/auth/server";

export interface StubAuthServerOptions {
    port?: number;
    host?: string;
    issuer?: string;
    defaultSubject?: string;
    autoConsent?: boolean;
    clients?: OAuthClientConfig[];
    claimsResolver?: (subject: string) => Promise<Record<string, unknown>> | Record<string, unknown>;
    // GitHub emulation settings
    githubUserId?: number;
    githubLogin?: string;
    githubName?: string;
    githubAppId?: number | string;
    githubAppSlug?: string;
}

export const DEFAULT_CLIENTS: OAuthClientConfig[] = [
    {
        clientId: "dev-client",
        clientSecret: "dev-secret",
        clientName: "Local Development Client",
        redirectUris: [
            "http://localhost:3000/callback",
            "http://127.0.0.1:3000/callback",
            "http://localhost:8787/auth/github/callback",
            "http://127.0.0.1:8787/auth/github/callback",
            "http://localhost:8080/callback",
            "http://127.0.0.1:8080/callback",
        ],
        allowedGrantTypes: ["authorization_code", "refresh_token"],
        allowedScopes: ["openid", "profile", "email"],
        isPublic: false,
    },
];

async function verifyS256(verifier: string, challenge: string): Promise<boolean> {
    const digest = new Bun.CryptoHasher("sha256").update(verifier).digest();
    return Buffer.from(digest).toString("base64url") === challenge;
}

export function createStubAuthServer(options: StubAuthServerOptions = {}) {
    const port = options.port ?? Number(process.env.AUTH_PORT ?? process.env.PORT ?? 8080);
    const host = options.host ?? process.env.AUTH_HOST ?? process.env.HOST ?? "localhost";
    const issuer = options.issuer ?? process.env.AUTH_ISSUER ?? `http://${host}:${port}`;
    const defaultSubject = options.defaultSubject ?? "dev-user";
    const autoConsent = options.autoConsent ?? true;

    // GitHub emulation defaults
    const githubUserId = options.githubUserId ?? 42;
    const githubLogin = options.githubLogin ?? "dev-user";
    const githubName = options.githubName ?? "Dev User";
    const githubAppId = Number(options.githubAppId ?? 5200437);
    const githubAppSlug = options.githubAppSlug ?? "era-roadmap";

    const initialClients = [...DEFAULT_CLIENTS, ...(options.clients ?? [])];
    const clientStore = new InMemoryClientStore(initialClients);
    const authCodeStore = new InMemoryAuthCodeStore();
    const consentStore = new InMemoryConsentStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const keys = keyService({ store: memoryKeyStore() });

    const authServer = new AuthorizationServer({
        issuer,
        keyService: keys,
        clientStore,
        authCodeStore,
        consentStore,
        tokenStore,
    });

    if (autoConsent) {
        for (const client of initialClients) {
            authServer.grantConsent(client.clientId, defaultSubject, client.allowedScopes);
        }
    }

    const githubAuthCodes = new Map<
        string,
        {
            codeChallenge?: string;
            codeChallengeMethod?: string;
            redirectUri: string;
            state?: string;
        }
    >();

    const knownRepos = new Map<number, string>([[1001, "octo/example"]]);

    const subjectResolver = async (req: Request): Promise<string> => {
        const url = new URL(req.url);
        const subject = req.headers.get("x-dev-user") ?? url.searchParams.get("user") ?? defaultSubject;
        if (autoConsent) {
            const clientId = url.searchParams.get("client_id");
            if (clientId) {
                const client = await clientStore.getClient(clientId);
                if (client) {
                    await authServer.grantConsent(clientId, subject, client.allowedScopes);
                }
            }
        }
        return subject;
    };

    const userinfoClaimsResolver = async (sub: string): Promise<Record<string, unknown>> => {
        if (options.claimsResolver) {
            return options.claimsResolver(sub);
        }
        return {
            sub,
            name: githubName,
            email: `${sub}@example.com`,
            email_verified: true,
            preferred_username: sub,
        };
    };

    const fetchHandler = async (request: Request): Promise<Response> => {
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers":
                        "Authorization, Content-Type, Accept, User-Agent, X-GitHub-Api-Version",
                    "Access-Control-Max-Age": "86400",
                },
            });
        }

        const url = new URL(request.url);

        // Root / Health check
        if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
            return new Response(
                JSON.stringify({
                    status: "ok",
                    name: "di-framework stub auth server (with GitHub emulation)",
                    issuer,
                    discovery: `${issuer}/.well-known/openid-configuration`,
                    jwks: `${issuer}/.well-known/jwks.json`,
                    endpoints: {
                        authorization: `${issuer}/oauth/authorize`,
                        token: `${issuer}/oauth/token`,
                        userinfo: `${issuer}/oauth/userinfo`,
                        revocation: `${issuer}/oauth/revoke`,
                        githubAuthorize: `${issuer}/login/oauth/authorize`,
                        githubToken: `${issuer}/login/oauth/access_token`,
                        githubUser: `${issuer}/user`,
                    },
                    githubEmulation: {
                        userId: githubUserId,
                        login: githubLogin,
                        appId: githubAppId,
                    },
                    defaultSubject,
                    autoConsent,
                }),
                {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                    },
                },
            );
        }

        // ==========================================
        // GitHub Emulation Endpoints
        // ==========================================

        // 1. GET/POST /login/oauth/authorize (GitHub OAuth authorize flow)
        if ((request.method === "GET" || request.method === "POST") && url.pathname === "/login/oauth/authorize") {
            const params = request.method === "GET" ? url.searchParams : new URLSearchParams(await request.text());
            const redirectUri = params.get("redirect_uri");
            const state = params.get("state");
            const codeChallenge = params.get("code_challenge") ?? undefined;
            const codeChallengeMethod = params.get("code_challenge_method") ?? undefined;

            if (!redirectUri) {
                return new Response(JSON.stringify({ error: "missing_redirect_uri" }), {
                    status: 400,
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                });
            }

            const code = `gh_code_${crypto.randomUUID().replaceAll("-", "")}`;
            githubAuthCodes.set(code, {
                codeChallenge,
                codeChallengeMethod,
                redirectUri,
                state: state ?? undefined,
            });

            const targetUrl = new URL(redirectUri);
            targetUrl.searchParams.set("code", code);
            if (state) targetUrl.searchParams.set("state", state);

            return Response.redirect(targetUrl.toString(), 302);
        }

        // 2. POST /login/oauth/access_token (GitHub OAuth token exchange)
        if (request.method === "POST" && url.pathname === "/login/oauth/access_token") {
            const bodyText = await request.text();
            let params: URLSearchParams;
            if (request.headers.get("content-type")?.includes("application/json")) {
                try {
                    const json = JSON.parse(bodyText);
                    params = new URLSearchParams(json);
                } catch {
                    params = new URLSearchParams();
                }
            } else {
                params = new URLSearchParams(bodyText);
            }

            const grantType = params.get("grant_type");
            if (grantType === "refresh_token") {
                return new Response(
                    JSON.stringify({
                        access_token: `ghu_refreshed_${crypto.randomUUID().replaceAll("-", "")}`,
                        refresh_token: `ghr_refreshed_${crypto.randomUUID().replaceAll("-", "")}`,
                        expires_in: 28800,
                        token_type: "bearer",
                        scope: "",
                    }),
                    {
                        status: 200,
                        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                    },
                );
            }

            const code = params.get("code");
            const codeVerifier = params.get("code_verifier");
            const stored = code ? githubAuthCodes.get(code) : undefined;
            const reject = () =>
                new Response(JSON.stringify({ error: "bad_verification_code" }), {
                    status: 400,
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                });
            if (!code || !stored) return reject();
            githubAuthCodes.delete(code);
            const redirectUri = params.get("redirect_uri");
            if (redirectUri !== null && redirectUri !== stored.redirectUri) return reject();
            if (stored.codeChallenge && (!codeVerifier || !(await verifyS256(codeVerifier, stored.codeChallenge))))
                return reject();

            return new Response(
                JSON.stringify({
                    access_token: `ghu_${crypto.randomUUID().replaceAll("-", "")}`,
                    refresh_token: `ghr_${crypto.randomUUID().replaceAll("-", "")}`,
                    expires_in: 28800,
                    token_type: "bearer",
                    scope: "",
                }),
                { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
            );
        }

        // 3. GET /user (GitHub User info)
        if (request.method === "GET" && url.pathname === "/user") {
            const authHeader = request.headers.get("authorization");
            if (!authHeader?.startsWith("Bearer ")) {
                return new Response(JSON.stringify({ message: "Requires authentication" }), {
                    status: 401,
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                });
            }
            return new Response(
                JSON.stringify({
                    id: githubUserId,
                    login: githubLogin,
                    name: githubName,
                    avatar_url: `https://avatars.githubusercontent.com/u/${githubUserId}`,
                    type: "User",
                }),
                { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
            );
        }

        // 4. GET /repos/:owner/:repo/collaborators/:login/permission
        const collPattern = /^\/repos\/([^/]+)\/([^/]+)\/collaborators\/([^/]+)\/permission$/;
        const collMatch = url.pathname.match(collPattern);
        if (request.method === "GET" && collMatch) {
            const permission = request.headers.get("x-github-permission") ?? "admin";
            return new Response(
                JSON.stringify({
                    permission,
                    role_name: permission,
                    user: { id: githubUserId, login: decodeURIComponent(collMatch[3]!) },
                }),
                { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
            );
        }

        // 5. GET /repos/:owner/:repo
        const repoPattern = /^\/repos\/([^/]+)\/([^/]+)$/;
        const repoMatch = url.pathname.match(repoPattern);
        if (request.method === "GET" && repoMatch) {
            const owner = decodeURIComponent(repoMatch[1]!);
            const repo = decodeURIComponent(repoMatch[2]!);
            const fullName = `${owner}/${repo}`;
            let repoId = 1000;
            for (let i = 0; i < fullName.length; i++) {
                repoId = ((repoId * 31 + fullName.charCodeAt(i)) % 1000000) + 1000;
            }
            knownRepos.set(repoId, fullName);
            return new Response(
                JSON.stringify({
                    id: repoId,
                    name: repo,
                    full_name: fullName,
                    private: false,
                    owner: { id: githubUserId, login: owner },
                }),
                { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
            );
        }

        // 6. GET /user/installations
        if (request.method === "GET" && url.pathname === "/user/installations") {
            return new Response(
                JSON.stringify({
                    total_count: 1,
                    installations: [
                        {
                            id: 1,
                            app_id: githubAppId,
                            app_slug: githubAppSlug,
                            account: { id: githubUserId, login: githubLogin },
                            target_type: "User",
                            permissions: { metadata: "read" },
                            repository_selection: "selected",
                        },
                    ],
                }),
                { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
            );
        }

        // 7. GET /user/installations/:id/repositories
        const instReposPattern = /^\/user\/installations\/(\d+)\/repositories$/;
        if (request.method === "GET" && instReposPattern.test(url.pathname)) {
            const repositories = Array.from(knownRepos.entries()).map(([id, full_name]) => ({ id, full_name }));
            return new Response(
                JSON.stringify({
                    total_count: repositories.length,
                    repositories,
                }),
                { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
            );
        }

        // ==========================================
        // Standard OIDC / OAuth 2.0 Endpoints
        // ==========================================

        if (request.method === "POST" && url.pathname === "/dev/clients") {
            try {
                const client = (await request.json()) as OAuthClientConfig;
                if (!client.clientId || !client.redirectUris) {
                    return new Response(
                        JSON.stringify({
                            error: "invalid_client_config",
                            error_description: "Missing clientId or redirectUris",
                        }),
                        {
                            status: 400,
                            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                        },
                    );
                }
                clientStore.registerClient(client);
                if (autoConsent) {
                    await authServer.grantConsent(client.clientId, defaultSubject, client.allowedScopes ?? ["openid"]);
                }
                return new Response(JSON.stringify({ ok: true, client }), {
                    status: 201,
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                });
            } catch {
                return new Response(
                    JSON.stringify({ error: "invalid_request", error_description: "Malformed JSON body" }),
                    {
                        status: 400,
                        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                    },
                );
            }
        }

        if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
            await keys.signingKey();
        }

        const oauthResponse = await handleOAuthServerRequest(request, {
            server: authServer,
            subjectResolver,
            userinfoClaimsResolver,
        });

        if (oauthResponse) {
            oauthResponse.headers.set("Access-Control-Allow-Origin", "*");
            oauthResponse.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
            oauthResponse.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            return oauthResponse;
        }

        return new Response(
            JSON.stringify({
                error: "not_found",
                error_description: `Route not handled by auth server: ${request.method} ${url.pathname}`,
            }),
            {
                status: 404,
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                },
            },
        );
    };

    return {
        issuer,
        port,
        host,
        server: authServer,
        clientStore,
        authCodeStore,
        consentStore,
        tokenStore,
        keyService: keys,
        fetch: fetchHandler,
    };
}

export function startStubAuthServer(options: StubAuthServerOptions = {}) {
    const stub = createStubAuthServer(options);
    const server = Bun.serve({
        port: stub.port,
        hostname: stub.host,
        fetch: stub.fetch,
    });
    return {
        ...stub,
        bunServer: server,
        stop: () => server.stop(),
    };
}
