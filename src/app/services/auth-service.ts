import { Component, Container } from "@di-framework/core/decorators";
import {
    AuthError,
    apiKeyStrategy,
    csrfGuard,
    deriveAesKey,
    hashSecret,
    issueApiKey,
    makeContext,
    openJson,
    randomBytes,
    randomToken,
    readCookie,
    SESSION_COOKIE_NAME,
    sealJson,
    serializeCookie,
    sessionManager,
    toSecretBytes,
} from "@di-framework/auth";
import { githubProvider, type OAuthTokens, oauthClient } from "@di-framework/auth/oauth";
import { HttpError, type Identity } from "../../core/auth/access.ts";
import { AUTH_CONFIG } from "../configuration.ts";
import { AuthRepository, type Grant, type RepositoryKey } from "../repositories/auth-repository.ts";

export interface AuthConfig {
    PUBLIC_API_URL: string;
    GITHUB_APP_ID: string;
    GITHUB_APP_SLUG: string;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    AUTH_SECRET: string;
}
type Connection = {
    login: string;
    sealed: string;
    version: string;
    expiresAt: number;
    lease?: { id: string; until: number };
};
type Permission = { version: string; expiresAt: number; installationId: number };
export type LoginFlow = {
    repository: string;
    userCode: string;
    expiresAt: number;
    nextPollAt: number;
    status: "pending" | "reviewing" | "approved" | "denied";
    subject?: string;
    login?: string;
    sealed?: string;
    grant?: Grant;
};
const FLOW_SECONDS = 600;
const KEY_SECONDS = 30 * 86400;

@Container()
export class AuthService {
    readonly client;
    readonly sessions;
    readonly csrf;
    readonly origin: string;
    private readonly cryptoKey: Promise<CryptoKey>;
    constructor(
        @Component(AuthRepository) readonly store: AuthRepository,
        @Component(AUTH_CONFIG) readonly config: AuthConfig,
        readonly fetchImpl: typeof fetch = fetch,
    ) {
        const url = new URL(config.PUBLIC_API_URL);
        if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
            throw new Error("PUBLIC_API_URL must be an HTTPS origin");
        if (
            !/^\d+$/.test(config.GITHUB_APP_ID) ||
            !/^[a-zA-Z0-9-]+$/.test(config.GITHUB_APP_SLUG) ||
            !config.GITHUB_CLIENT_ID ||
            !config.GITHUB_CLIENT_SECRET
        )
            throw new Error("GitHub App configuration is incomplete");
        toSecretBytes(config.AUTH_SECRET);
        this.origin = url.origin;
        this.cryptoKey = deriveAesKey(config.AUTH_SECRET, "era:v1:github-credentials");
        this.client = oauthClient(
            githubProvider({
                clientId: config.GITHUB_CLIENT_ID,
                clientSecret: config.GITHUB_CLIENT_SECRET,
                redirectUri: `${this.origin}/auth/github/callback`,
                scopes: [],
            }),
            {
                state: store.state(),
                fetch: (async (input: string | URL | Request, init?: RequestInit) => {
                    const headers = new Headers(init?.headers);
                    headers.set("user-agent", "era");
                    const response = await fetchImpl(input, { ...init, headers, signal: AbortSignal.timeout(10000) });
                    if (response.status >= 500 || response.status === 429 || response.headers.has("retry-after"))
                        throw new HttpError("GitHub authentication is unavailable; retry", 503);
                    return response;
                }) as typeof fetch,
                now: store.now,
            },
        );
        this.sessions = sessionManager({
            store: store.sessions(),
            now: store.now,
            policy: {
                absoluteTimeoutSeconds: FLOW_SECONDS,
                inactivityTimeoutSeconds: FLOW_SECONDS,
            },
        });
        this.csrf = csrfGuard({ secret: config.AUTH_SECRET, allowedOrigins: [this.origin], requireOriginHeader: true });
    }
    async begin(
        repository: unknown,
        ip: string,
    ): Promise<{ deviceCode: string; userCode: string; verificationUri: string; expiresAt: number; interval: number }> {
        if (
            typeof repository !== "string" ||
            !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
            repository.length > 200
        )
            throw new HttpError("repository must be owner/name", 400);
        if (!(await this.store.throttle(`start:${await hashSecret(ip)}`, 10, 60)))
            throw new HttpError("Too many login attempts", 429);
        const deviceCode = randomToken(32);
        const id = await hashSecret(deviceCode);
        const code = Array.from(randomBytes(5), (value) => value.toString(16).padStart(2, "0"))
            .join("")
            .toUpperCase();
        const userCode = `${code.slice(0, 5)}-${code.slice(5)}`;
        const expiresAt = this.store.now() + FLOW_SECONDS;
        await this.store.put(
            "flow",
            id,
            { repository, userCode, expiresAt, nextPollAt: 0, status: "pending" } satisfies LoginFlow,
            expiresAt,
        );
        await this.store.put("code", userCode, { id, expiresAt }, expiresAt);
        return { deviceCode, userCode, verificationUri: `${this.origin}/auth/cli/verify`, expiresAt, interval: 5 };
    }
    async flow(id: string): Promise<LoginFlow> {
        const flow = await this.store.get<LoginFlow>("flow", id);
        if (!flow || flow.expiresAt <= this.store.now()) throw new HttpError("Login expired; run era login again", 410);
        return flow;
    }
    async startBrowser(userCode: string, ip: string): Promise<{ url: string; cookie: string }> {
        if (!(await this.store.throttle(`verify:${await hashSecret(ip)}`, 30, 60)))
            throw new HttpError("Too many verification attempts", 429);
        const code = await this.store.get<{ id: string; expiresAt: number }>("code", userCode.toUpperCase().trim());
        if (!code || code.expiresAt <= this.store.now())
            throw new HttpError("Invalid or expired verification code", 400);
        const flow = await this.flow(code.id);
        if (flow.status !== "pending") throw new HttpError("This login has already been authorized", 409);
        const result = await this.client.authorizationUrl({ returnTo: code.id });
        return { url: result.url, cookie: result.stateCookie };
    }
    async callback(request: Request): Promise<Response> {
        const result = await this.client.callback(request);
        if (!result.returnTo) throw new HttpError("Invalid login", 400);
        const id = result.returnTo;
        const flow = await this.flow(id);
        if (flow.status !== "pending") throw new HttpError("Login already used", 409);
        const subject = `github:${result.profile.subject}`;
        const login = result.profile.raw.login;
        if (typeof login !== "string" || !login) throw new HttpError("GitHub identity unavailable", 400);
        const pending = {
            tokens: result.tokens,
            expiresAt: result.tokens.expiresIn ? this.store.now() + result.tokens.expiresIn : 0,
        };
        const sealed = await sealJson(await this.cryptoKey, `pending:${id}`, pending);
        if (!(await this.store.replace("flow", id, flow, { ...flow, status: "reviewing", subject, login, sealed })))
            throw new HttpError("Login already used", 409);
        const session = await this.sessions.create({ subject, metadata: { flowId: id } });
        const headers = new Headers({ location: `${this.origin}/auth/cli/approve`, "cache-control": "no-store" });
        headers.append("set-cookie", serializeCookie(SESSION_COOKIE_NAME, session.token, { maxAge: FLOW_SECONDS }));
        headers.append("set-cookie", result.clearStateCookie);
        return new Response(null, { status: 302, headers });
    }
    async browserSession(request: Request) {
        const raw = readCookie(request, SESSION_COOKIE_NAME);
        const session = raw ? await this.sessions.resolve(raw) : null;
        if (session?.state !== "active" || typeof session.record.metadata?.flowId !== "string")
            throw new HttpError("Browser login expired", 401);
        const id = session.record.metadata.flowId;
        const flow = await this.flow(id);
        if (flow.subject !== session.principal.sub) throw new HttpError("Invalid login session", 403);
        return { id, flow, session };
    }
    async approve(request: Request, csrfToken: string, decision: string): Promise<void> {
        const { id, flow, session } = await this.browserSession(request);
        if (!(await this.csrf.verify(request, session.record.id, csrfToken)).ok)
            throw new HttpError("Invalid approval request", 403);
        if (flow.status !== "reviewing") throw new HttpError("Login already completed", 409);
        if (decision === "deny") {
            await this.store.replace("flow", id, flow, { ...flow, status: "denied", sealed: undefined });
            console.info(
                JSON.stringify({ event: "era.auth.denied", subject: flow.subject, repository: flow.repository }),
            );
            return;
        }
        if (decision !== "approve" || !flow.sealed || !flow.subject || !flow.login)
            throw new HttpError("Invalid approval", 400);
        const pending = await openJson<{ tokens: OAuthTokens; expiresAt: number }>(
            await this.cryptoKey,
            `pending:${id}`,
            flow.sealed,
        );
        if (!pending) throw new HttpError("Login expired; sign in again", 401);
        const grant = await this.checkRepository(pending.tokens.accessToken, flow.login, flow.repository);
        const connection: Connection = {
            login: flow.login,
            version: randomToken(16),
            expiresAt: pending.expiresAt,
            sealed: await sealJson(await this.cryptoKey, `github:${flow.subject}`, pending.tokens),
        };
        await this.store.put("connection", flow.subject, connection);
        if (!(await this.store.replace("flow", id, flow, { ...flow, status: "approved", grant, sealed: undefined })))
            throw new HttpError("Login already completed", 409);
        console.info(
            JSON.stringify({ event: "era.auth.approved", subject: flow.subject, repository: grant.repository }),
        );
    }
    async poll(deviceCode: unknown): Promise<Response> {
        if (typeof deviceCode !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(deviceCode))
            throw new HttpError("Invalid device credential", 401);
        const id = await hashSecret(deviceCode);
        const flow = await this.flow(id);
        if (flow.nextPollAt > this.store.now()) throw new HttpError("Poll no more than once every five seconds", 429);
        if (flow.status === "denied") throw new HttpError("Login denied", 403);
        if (flow.status !== "approved") {
            if (!(await this.store.replace("flow", id, flow, { ...flow, nextPollAt: this.store.now() + 5 })))
                throw new HttpError("Poll no more than once every five seconds", 429);
            return Response.json(
                { code: "authorization_pending" },
                { status: 202, headers: { "retry-after": "5", "cache-control": "no-store" } },
            );
        }
        const approved = await this.store.consume<LoginFlow>("flow", id, true);
        if (!approved?.subject || !approved.grant) throw new HttpError("Login already consumed", 410);
        const result = await issueApiKey(
            this.store.credentials(approved.grant),
            {
                userId: approved.subject,
                label: "ERA CLI",
                prefix: "era",
                expiresAt: this.store.now() + KEY_SECONDS,
            },
            this.store.now,
        );
        console.info(
            JSON.stringify({
                event: "era.auth.issued",
                subject: approved.subject,
                repository: approved.grant.repository,
            }),
        );
        return Response.json(
            {
                apiToken: result.key,
                keyId: result.credential.id,
                repository: approved.grant.repository,
                subject: approved.subject,
                expiresAt: result.credential.expiresAt,
            },
            { headers: { "cache-control": "no-store" } },
        );
    }
    async identity(request: Request, checkAccess = true): Promise<Identity> {
        const result = await apiKeyStrategy({
            credentials: this.store.credentials(),
            authorizationScheme: "Bearer",
            now: this.store.now,
        }).authenticate(makeContext(request));
        if (result.state !== "authenticated") throw new HttpError("Invalid or expired ERA token; run era login", 401);
        const id = result.principal.claims?.apiKeyId;
        if (typeof id !== "string") throw new HttpError("Invalid ERA token", 401);
        const key = await this.store.get<RepositoryKey>("key", id);
        if (!key) throw new HttpError("Invalid ERA token", 401);
        if (checkAccess) await this.checkAccess(key);
        return { kind: "user", subject: key.userId, keyId: key.id, repository: key.repository };
    }
    async tokens(identity: Identity, cursor: string) {
        if (identity.kind !== "user") throw new HttpError("Use a user token to list your keys", 403);
        const rows = await this.store.listKeys(identity.subject, cursor);
        const now = this.store.now();
        return {
            tokens: rows.slice(0, 100).map((key) => ({
                id: key.id,
                repository: key.repository,
                label: key.label,
                createdAt: key.createdAt,
                expiresAt: key.expiresAt,
                status: key.disabled ? "revoked" : key.expiresAt && key.expiresAt <= now ? "expired" : "active",
            })),
            nextCursor: rows.length > 100 ? rows[99]!.id : undefined,
        };
    }

    async revokeToken(identity: Identity, id: string): Promise<void> {
        if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw new HttpError("Invalid token ID", 400);
        const key = await this.store.get<RepositoryKey>("key", id);
        if (identity.kind !== "admin" && (identity.kind !== "user" || key?.userId !== identity.subject))
            throw new HttpError("Token not found", 404);
        if (key) await this.store.credentials().saveApiKey({ ...key, disabled: true });
    }

    private async connection(subject: string): Promise<{ record: Connection; tokens: OAuthTokens }> {
        const record = await this.store.get<Connection>("connection", subject);
        if (!record) throw new HttpError("GitHub login required", 401);
        const tokens = await openJson<OAuthTokens>(await this.cryptoKey, `github:${subject}`, record.sealed);
        if (!tokens) throw new HttpError("GitHub login required", 401);
        if (!record.expiresAt || record.expiresAt > this.store.now() + 60) return { record, tokens };
        if (!tokens.refreshToken) throw new HttpError("GitHub login expired; run era login", 401);
        if (record.lease && record.lease.until > this.store.now())
            throw new HttpError("GitHub credentials are refreshing; retry", 503);
        if (record.lease) {
            // A crashed refresh may have rotated GitHub's single-use refresh token.
            if (await this.store.replace("connection", subject, record, { ...record, sealed: "", lease: undefined }))
                await this.store.revokeKeys(subject);
            throw new HttpError("GitHub refresh was interrupted; run era login", 401);
        }
        const leased: Connection = { ...record, lease: { id: randomToken(16), until: this.store.now() + 30 } };
        if (!(await this.store.replace("connection", subject, record, leased)))
            throw new HttpError("GitHub credentials are refreshing; retry", 503);
        try {
            const refreshed = await this.client.refresh(tokens.refreshToken);
            const next: Connection = {
                login: record.login,
                version: randomToken(16),
                expiresAt: refreshed.expiresIn ? this.store.now() + refreshed.expiresIn : 0,
                sealed: await sealJson(await this.cryptoKey, `github:${subject}`, refreshed),
            };
            if (!(await this.store.replace("connection", subject, leased, next)))
                throw new HttpError("GitHub credentials changed; retry", 503);
            return { record: next, tokens: refreshed };
        } catch (error) {
            if (error instanceof HttpError && error.status === 503) {
                await this.store.replace("connection", subject, leased, record);
                throw error;
            }
            // A failed or ambiguous refresh cannot safely reuse a potentially rotated provider token.
            if (
                await this.store.replace("connection", subject, leased, {
                    ...leased,
                    sealed: "",
                    expiresAt: 1,
                    lease: undefined,
                })
            )
                await this.store.revokeKeys(subject);
            if (error instanceof HttpError) throw error;
            throw new HttpError("GitHub login needs renewal; run era login", 401);
        }
    }
    private async checkAccess(key: RepositoryKey): Promise<void> {
        const current = await this.store.get<Connection>("connection", key.userId);
        const cacheId = `${key.userId}:${key.repositoryId}`;
        const cached = await this.store.get<Permission>("permission", cacheId);
        if (
            current &&
            cached?.version === current.version &&
            cached.installationId === key.installationId &&
            cached.expiresAt > this.store.now()
        )
            return;
        const { record, tokens } = await this.connection(key.userId);
        try {
            const grant = await this.checkRepository(tokens.accessToken, record.login, key.repository);
            if (grant.repositoryId !== key.repositoryId || grant.installationId !== key.installationId)
                throw new HttpError("Repository identity or installation changed; run era login", 403);
        } catch (error) {
            if (error instanceof HttpError && [401, 403, 404].includes(error.status)) {
                if (error.status === 401) {
                    await this.store.remove("connection", key.userId);
                    await this.store.revokeKeys(key.userId);
                } else await this.store.revokeKeys(key.userId, key.repositoryId);
            }
            throw error;
        }
        await this.store.put(
            "permission",
            cacheId,
            { version: record.version, installationId: key.installationId, expiresAt: this.store.now() + 300 },
            this.store.now() + 300,
        );
    }
    private async github<T>(token: string, path: string): Promise<T> {
        let response: Response;
        try {
            const fetchImpl = this.fetchImpl;
            response = await fetchImpl(`https://api.github.com${path}`, {
                headers: {
                    authorization: `Bearer ${token}`,
                    accept: "application/vnd.github+json",
                    "user-agent": "era",
                    "x-github-api-version": "2026-03-10",
                },
                signal: AbortSignal.timeout(10000),
            });
        } catch (error) {
            console.warn(
                JSON.stringify({
                    event: "era.auth.github-unavailable",
                    path,
                    reason: "transport",
                    error: error instanceof Error ? error.name : "unknown",
                }),
            );
            throw new HttpError("GitHub access checks are unavailable; retry", 503);
        }
        if (
            response.status === 429 ||
            response.status >= 500 ||
            response.headers.get("x-ratelimit-remaining") === "0" ||
            response.headers.has("retry-after")
        ) {
            console.warn(
                JSON.stringify({
                    event: "era.auth.github-unavailable",
                    path,
                    reason: "provider",
                    status: response.status,
                    remaining: response.headers.get("x-ratelimit-remaining"),
                }),
            );
            throw new HttpError("GitHub access checks are unavailable; retry", 503);
        }
        if (response.status === 401) throw new HttpError("GitHub authorization revoked; run era login", 401);
        if (!response.ok) throw new HttpError("GitHub repository write access and app installation are required", 403);
        try {
            return (await response.json()) as T;
        } catch {
            console.warn(
                JSON.stringify({
                    event: "era.auth.github-unavailable",
                    path,
                    reason: "invalid-json",
                    status: response.status,
                }),
            );
            throw new HttpError("GitHub access checks are unavailable; retry", 503);
        }
    }
    async checkRepository(token: string, login: string, repository: string): Promise<Grant> {
        const path = repository.split("/").map(encodeURIComponent).join("/");
        const repo = await this.github<{ id: number; full_name: string; owner: { id: number } }>(
            token,
            `/repos/${path}`,
        );
        if (
            !Number.isSafeInteger(repo.id) ||
            !repo.full_name ||
            repo.full_name.toLowerCase() !== repository.toLowerCase()
        )
            throw new HttpError("Repository identity changed; run era login again", 403);
        const permission = await this.github<{ permission: string }>(
            token,
            `/repos/${path}/collaborators/${encodeURIComponent(login)}/permission`,
        );
        if (!["write", "admin"].includes(permission.permission))
            throw new HttpError("GitHub repository write access is required", 403);
        // Check selected installation repositories explicitly, including public repositories.
        for (let page = 1; page <= 100; page++) {
            const installations = await this.github<{
                installations: { id: number; app_id: number; account: { id: number } }[];
            }>(token, `/user/installations?per_page=100&page=${page}`);
            if (!Array.isArray(installations.installations))
                throw new HttpError("GitHub access checks are unavailable; retry", 503);
            for (const installation of installations.installations) {
                if (
                    String(installation.app_id) !== this.config.GITHUB_APP_ID ||
                    installation.account.id !== repo.owner.id
                )
                    continue;
                for (let repoPage = 1; repoPage <= 100; repoPage++) {
                    const batch = await this.github<{ repositories: { id: number }[] }>(
                        token,
                        `/user/installations/${installation.id}/repositories?per_page=100&page=${repoPage}`,
                    );
                    if (!Array.isArray(batch.repositories))
                        throw new HttpError("GitHub access checks are unavailable; retry", 503);
                    if (batch.repositories.some((item) => item.id === repo.id))
                        return { repository: repo.full_name, repositoryId: repo.id, installationId: installation.id };
                    if (batch.repositories.length < 100) break;
                }
            }
            if (installations.installations.length < 100) break;
        }
        throw new HttpError("Install the ERA GitHub App on this repository before approving", 403);
    }
}

export function authFailure(error: unknown): Response {
    const privateResponse = (response: Response) => {
        const headers = new Headers(response.headers);
        headers.set("cache-control", "no-store");
        return new Response(response.body, { status: response.status, headers });
    };
    if (error instanceof AuthError) return privateResponse(error.toResponse());
    // Published subpath bundles have separate AuthError constructors. Preserve their public response contract.
    if (error instanceof Error && "toResponse" in error && typeof error.toResponse === "function")
        return privateResponse(error.toResponse());
    const status = error instanceof HttpError ? error.status : 503;
    const message = error instanceof HttpError ? error.message : "Authentication service is unavailable; retry";
    return Response.json(
        { error: message },
        {
            status,
            headers: {
                "cache-control": "no-store",
                ...([429, 503].includes(status) ? { "retry-after": "5" } : {}),
            },
        },
    );
}
