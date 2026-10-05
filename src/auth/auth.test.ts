import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64UrlEncode, hashSecret, sha256 } from "@di-framework/auth";
import { runCli } from "../cli/cli.ts";
import { handleRequest } from "../app/http.ts";
import { MemoryLedger } from "../tracking/ledger.ts";
import { BunSqlDatabase } from "../persistence/sqlite.ts";
import { credentialId, FileCredentialCache, MemoryCredentialCache } from "./credentials.ts";
import { type AuthConfig, AuthService, type LoginFlow } from "./service.ts";
import { AuthStore, type RepositoryKey } from "./store.ts";

const config: AuthConfig = {
    PUBLIC_API_URL: "https://era.test",
    GITHUB_APP_ID: "123",
    GITHUB_APP_SLUG: "era-test",
    GITHUB_CLIENT_ID: "Iv.test",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    AUTH_SECRET: "s".repeat(32),
};
function fixture() {
    const database = new Database(":memory:");
    database.exec(readFileSync(join(import.meta.dir, "../../migrations/0002_auth.sql"), "utf8"));
    const clock = { now: 1800000000 };
    const provider = {
        permission: "write",
        installed: true,
        repoId: 10,
        outage: false,
        revoked: false,
        challenge: "",
        refreshCalls: 0,
        userId: 42,
        refreshFailure: false,
        refreshOutage: false,
    };
    const fetchImpl = async function (this: unknown, input: string | URL | Request, init?: RequestInit) {
        expect(this).toBeUndefined();
        const url = new URL(String(input));
        if (url.pathname === "/login/oauth/access_token") {
            const fields = new URLSearchParams(String(init?.body));
            expect(new Headers(init?.headers).get("user-agent")).toBe("era");
            if (fields.get("grant_type") === "refresh_token") {
                provider.refreshCalls++;
                if (provider.refreshOutage) return Response.json({}, { status: 503 });
                if (provider.refreshFailure) return Response.json({ error: "bad_refresh_token" }, { status: 400 });
            } else {
                expect(base64UrlEncode(await sha256(fields.get("code_verifier")!))).toBe(provider.challenge);
                expect(fields.get("client_secret")).toBe(config.GITHUB_CLIENT_SECRET);
            }
            return Response.json({
                access_token: "provider-access-secret",
                refresh_token: "provider-refresh-secret",
                expires_in: 28800,
                scope: "",
                token_type: "bearer",
            });
        }
        if (url.pathname === "/user") return Response.json({ id: provider.userId, login: "octocat", name: "Octocat" });
        if (provider.outage) return Response.json({}, { status: 503 });
        if (provider.revoked) return Response.json({}, { status: 401 });
        if (url.pathname.endsWith("/permission")) return Response.json({ permission: provider.permission });
        if (url.pathname === "/repos/octo/example")
            return Response.json({ id: provider.repoId, full_name: "octo/example", owner: { id: 1 } });
        if (url.pathname === "/user/installations")
            return Response.json({ installations: [{ id: 55, app_id: 123, account: { id: 1 } }] });
        if (url.pathname === "/user/installations/55/repositories")
            return Response.json({ repositories: provider.installed ? [{ id: provider.repoId }] : [] });
        throw new Error(`Unexpected provider URL ${url.pathname}`);
    } as typeof fetch;
    const store = new AuthStore(new BunSqlDatabase(database), () => clock.now);
    const service = new AuthService(store, config, fetchImpl);
    const ledger = new MemoryLedger();
    const request = (path: string, init?: RequestInit) =>
        handleRequest(new Request(`https://era.test${path}`, init), { auth: service, ledger, apiToken: "admin" });
    const start = async () => {
        const response = await request("/auth/cli/start", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ repository: "octo/example" }),
        });
        expect(response.status).toBe(201);
        return (await response.json()) as { deviceCode: string; userCode: string; expiresAt: number };
    };
    const browser = async (code: string) => {
        const result = await request("/auth/github/start", {
            method: "POST",
            headers: { origin: config.PUBLIC_API_URL, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ code }),
        });
        expect(result.status).toBe(302);
        const authorize = new URL(result.headers.get("location")!);
        expect(authorize.searchParams.has("scope")).toBe(false);
        provider.challenge = authorize.searchParams.get("code_challenge")!;
        const callbackPath = `/auth/github/callback?code=test-code&state=${authorize.searchParams.get("state")}`;
        const cookie = result.headers.get("set-cookie")!.split(";")[0]!;
        const callback = await request(callbackPath, { headers: { cookie } });
        expect(callback.status).toBe(302);
        const sessionCookie = callback.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");
        const approve = await request("/auth/cli/approve", { headers: { cookie: sessionCookie } });
        expect(approve.headers.get("content-security-policy")).toContain("form-action 'self';");
        const csrf = (await approve.text()).match(/name="csrf" value="([^"]+)"/)![1]!;
        const decide = (decision = "approve", token = csrf) =>
            request("/auth/cli/approve", {
                method: "POST",
                headers: {
                    cookie: sessionCookie,
                    origin: config.PUBLIC_API_URL,
                    "content-type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({ decision, csrf: token }),
            });
        return { decide, callbackPath, cookie };
    };
    const poll = (deviceCode: string) =>
        request("/auth/cli/token", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deviceCode }),
        });
    const login = async () => {
        const flow = await start();
        const web = await browser(flow.userCode);
        expect((await web.decide()).status).toBe(200);
        const response = await poll(flow.deviceCode);
        expect(response.status).toBe(200);
        return (await response.json()) as {
            apiToken: string;
            keyId: string;
            repository: string;
            subject: string;
            expiresAt: number;
        };
    };
    return { database, clock, provider, store, service, request, start, browser, poll, login };
}

test("GitHub PKCE login issues a scoped key once and stores only encrypted provider credentials and key hashes", async () => {
    const f = fixture();
    expect((await f.request("/auth/cli/verify")).headers.get("content-security-policy")).toContain(
        "form-action 'self' https://github.com;",
    );
    const begin = await f.start();
    expect((await f.poll(begin.deviceCode)).status).toBe(202);
    expect((await f.poll(begin.deviceCode)).status).toBe(429);
    f.clock.now += 5;
    const web = await f.browser(begin.userCode);
    expect((await web.decide()).status).toBe(200);
    expect((await f.request(web.callbackPath, { headers: { cookie: web.cookie } })).status).toBe(400);
    const responses = await Promise.all([f.poll(begin.deviceCode), f.poll(begin.deviceCode)]);
    expect(responses.map((value) => value.status).sort()).toEqual([200, 410]);
    const key = (await responses.find((value) => value.status === 200)!.json()) as { apiToken: string; keyId: string };
    expect(key.keyId).toBe(await hashSecret(key.apiToken));
    const dump = JSON.stringify(f.database.query("SELECT * FROM auth_records").all());
    expect(dump).not.toContain(key.apiToken);
    expect(dump).not.toContain("provider-access-secret");
    expect(dump).not.toContain("provider-refresh-secret");
    expect(
        (
            await f.request("/v1/accuracy?repository=other/repo", {
                headers: { authorization: `Bearer ${key.apiToken}` },
            })
        ).status,
    ).toBe(403);
    expect(
        (
            await f.request("/v1/accuracy?repository=octo/example", {
                headers: { authorization: `Bearer ${key.apiToken}` },
            })
        ).status,
    ).toBe(200);
});

test("write access and selected GitHub App installation are required, including public repositories", async () => {
    for (const setting of ["read", "triage", "uninstalled"]) {
        const f = fixture();
        const begin = await f.start();
        const web = await f.browser(begin.userCode);
        if (setting === "uninstalled") f.provider.installed = false;
        else f.provider.permission = setting;
        expect((await web.decide()).status).toBe(403);
        expect((await f.poll(begin.deviceCode)).status).toBe(202);
        f.provider.installed = true;
        f.provider.permission = "write";
        expect((await web.decide()).status).toBe(200);
    }
});

test("approval requires session CSRF and origin; denial and expiry cannot issue keys", async () => {
    const f = fixture();
    const begin = await f.start();
    const web = await f.browser(begin.userCode);
    expect((await web.decide("approve", "forged")).status).toBe(403);
    expect((await web.decide("deny")).status).toBe(200);
    expect((await f.poll(begin.deviceCode)).status).toBe(403);
    f.clock.now += 601;
    expect((await f.poll(begin.deviceCode)).status).toBe(410);
    expect(
        (
            await f.request("/auth/github/start", {
                method: "POST",
                headers: { origin: "https://evil.test", "content-type": "application/x-www-form-urlencoded" },
                body: "code=anything",
            })
        ).status,
    ).toBe(403);
});

test("permission caching expires within five minutes and outages fail closed without revoking keys", async () => {
    const f = fixture();
    const key = await f.login();
    const call = () =>
        f.request("/v1/accuracy?repository=octo/example", { headers: { authorization: `Bearer ${key.apiToken}` } });
    expect((await call()).status).toBe(200);
    f.provider.outage = true;
    f.clock.now += 299;
    expect((await call()).status).toBe(200);
    f.clock.now += 1;
    expect((await call()).status).toBe(503);
    expect((await f.store.get<RepositoryKey>("key", key.keyId))?.disabled).not.toBe(true);
    f.provider.outage = false;
    f.provider.permission = "read";
    expect((await call()).status).toBe(403);
    expect((await call()).status).toBe(401);
});

test("repository ID changes and revoked GitHub authorization invalidate ERA grants", async () => {
    for (const revoked of [false, true]) {
        const f = fixture();
        const key = await f.login();
        if (revoked) f.provider.revoked = true;
        else f.provider.repoId++;
        const response = await f.request("/v1/repositories", { headers: { authorization: `Bearer ${key.apiToken}` } });
        expect(response.status).toBe(revoked ? 401 : 403);
        expect((await f.store.get<RepositoryKey>("key", key.keyId))?.disabled).toBe(true);
    }
});

test("keys expire, owners can revoke, operators can revoke, and other users cannot", async () => {
    const f = fixture();
    const first = await f.login();
    const rows = await f.request("/auth/tokens", { headers: { authorization: `Bearer ${first.apiToken}` } });
    expect(JSON.stringify(await rows.json())).not.toContain(first.apiToken);
    f.provider.userId = 43;
    const second = await f.login();
    expect(
        (
            await f.request(`/auth/tokens/${first.keyId}`, {
                method: "DELETE",
                headers: { authorization: `Bearer ${second.apiToken}` },
            })
        ).status,
    ).toBe(404);
    expect(
        (
            await f.request(`/auth/tokens/${first.keyId}`, {
                method: "DELETE",
                headers: { authorization: "Bearer admin" },
            })
        ).status,
    ).toBe(204);
    expect(
        (await f.request("/v1/repositories", { headers: { authorization: `Bearer ${first.apiToken}` } })).status,
    ).toBe(401);
    f.clock.now = second.expiresAt;
    expect((await f.request("/auth/tokens", { headers: { authorization: `Bearer ${second.apiToken}` } })).status).toBe(
        401,
    );
});

test("GitHub refresh is serialized across concurrent requests and a failed refresh requires login", async () => {
    const f = fixture();
    const key = await f.login();
    f.clock.now += 28800;
    const calls = await Promise.all(
        [1, 2].map(() => f.request("/v1/repositories", { headers: { authorization: `Bearer ${key.apiToken}` } })),
    );
    expect(f.provider.refreshCalls).toBe(1);
    expect(calls.some((response) => response.status === 200)).toBe(true);
    expect(calls.every((response) => [200, 503].includes(response.status))).toBe(true);
    f.clock.now += 28800;
    f.provider.refreshFailure = true;
    expect((await f.request("/v1/repositories", { headers: { authorization: `Bearer ${key.apiToken}` } })).status).toBe(
        401,
    );
});

test("a provider refresh outage preserves the key and allows recovery", async () => {
    const f = fixture();
    const key = await f.login();
    f.clock.now += 28800;
    f.provider.refreshOutage = true;
    const call = () => f.request("/v1/repositories", { headers: { authorization: `Bearer ${key.apiToken}` } });
    expect((await call()).status).toBe(503);
    expect((await f.store.get<RepositoryKey>("key", key.keyId))?.disabled).not.toBe(true);
    f.provider.refreshOutage = false;
    expect((await call()).status).toBe(200);
    expect(f.provider.refreshCalls).toBe(2);
});

test("an interrupted refresh does not reuse a potentially rotated provider token", async () => {
    const f = fixture();
    const key = await f.login();
    const connection = await f.store.get<Record<string, unknown>>("connection", key.subject);
    await f.store.put("connection", key.subject, {
        ...connection,
        lease: { id: "interrupted", until: f.clock.now + 30 },
    });
    f.clock.now += 28800;
    expect((await f.request("/v1/repositories", { headers: { authorization: `Bearer ${key.apiToken}` } })).status).toBe(
        401,
    );
    expect(f.provider.refreshCalls).toBe(0);
    expect((await f.store.get<RepositoryKey>("key", key.keyId))?.disabled).toBe(true);
});

test("atomic D1 state consumption has one winner and expired transient state is purged", async () => {
    const f = fixture();
    await f.store.state().put({ purpose: "oauth", key: "state", data: {}, expiresAt: f.clock.now + 1 });
    const result = await Promise.all([
        f.store.state().consume("oauth", "state"),
        f.store.state().consume("oauth", "state"),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    const flow = await f.start();
    f.clock.now += 601;
    await f.store.purge();
    expect(await f.store.get<LoginFlow>("flow", await hashSecret(flow.deviceCode))).toBeNull();
});

test("CLI login supports headless approval, cached API selection and logout without exposing tokens", async () => {
    const f = fixture();
    const cache = new MemoryCredentialCache();
    const output: string[] = [];
    let code = "";
    let approved = false;
    const io = {
        env: {},
        credentials: cache,
        now: () => f.clock.now,
        fetch: async (input: string | URL | Request, init?: RequestInit) =>
            f.request(new URL(String(input)).pathname + new URL(String(input)).search, init),
        stdout: (line: string) => {
            output.push(line);
            code = line.match(/enter ([A-F0-9-]+)/)?.[1] ?? code;
        },
        stderr: (line: string) => {
            throw new Error(line);
        },
        sleep: async () => {
            f.clock.now += 5;
            if (!approved) {
                const web = await f.browser(code);
                await web.decide();
                approved = true;
            }
        },
        openBrowser: async () => {
            throw new Error("Headless");
        },
    };
    expect(await runCli(["login", "--api", config.PUBLIC_API_URL, "--repository", "octo/example"], io)).toBe(0);
    const saved = cache.read().credentials[credentialId(config.PUBLIC_API_URL, "octo/example")]!;
    expect(output.join("\n")).not.toContain(saved.apiToken);
    expect(await runCli(["accuracy", "--repository", "octo/example"], io)).toBe(0);
    expect(await runCli(["logout"], io)).toBe(0);
    expect(Object.keys(cache.read().credentials)).toHaveLength(0);
    expect((await f.store.get<RepositoryKey>("key", saved.keyId))?.disabled).toBe(true);
});

test("credential files are atomic and private; explicit credentials override saved login", async () => {
    const directory = mkdtempSync(join(tmpdir(), "era-auth-test-"));
    try {
        const cache = new FileCredentialCache(join(directory, "era", "credentials.json"));
        const state = cache.read();
        state.activeApi = config.PUBLIC_API_URL;
        state.activeRepository[config.PUBLIC_API_URL] = "octo/example";
        state.credentials[credentialId(config.PUBLIC_API_URL, "octo/example")] = {
            apiToken: "era_saved",
            keyId: "id",
            repository: "octo/example",
            subject: "github:42",
            expiresAt: 1900000000,
        };
        cache.write(state);
        expect(statSync(cache.path).mode & 0o777).toBe(0o600);
        expect(statSync(join(directory, "era")).mode & 0o777).toBe(0o700);
        let token = "";
        const io = {
            env: { ERA_API_TOKEN: "environment" },
            credentials: cache,
            stdout: () => {},
            stderr: () => {},
            fetch: async (_url: string | URL | Request, init?: RequestInit) => {
                token = new Headers(init?.headers).get("authorization")!;
                return Response.json({ reports: [] });
            },
        };
        expect(await runCli(["accuracy", "--repository", "octo/example", "--token", "explicit"], io)).toBe(0);
        expect(token).toBe("Bearer explicit");
        expect(await runCli(["accuracy", "--repository", "octo/example"], io)).toBe(0);
        expect(token).toBe("Bearer environment");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
