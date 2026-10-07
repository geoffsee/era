import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuthRepository } from "../src/app/repositories/auth-repository.ts";
import { type AuthConfig, AuthService } from "../src/app/services/auth-service.ts";
import { BunSqlDatabase } from "../src/core/persistence/sqlite.ts";
import { createStubAuthServer } from "../stub-auth-server/src/server.ts";

describe("Worker AuthService integration with Stub Auth Server", () => {
    const stub = createStubAuthServer({
        issuer: "http://localhost:8080",
        githubUserId: 42,
        githubLogin: "octocat",
        githubName: "Mona Lisa Octocat",
        githubAppId: 5200437,
    });

    const config: AuthConfig = {
        PUBLIC_API_URL: "http://localhost:8787",
        GITHUB_APP_ID: "5200437",
        GITHUB_APP_SLUG: "era-roadmap",
        GITHUB_CLIENT_ID: "dev-client",
        GITHUB_URL: "http://localhost:8080",
    };

    const database = new Database(":memory:");
    database.exec(readFileSync(join(import.meta.dir, "../migrations/0002_auth.sql"), "utf8"));

    const nowSeconds = 1_700_000_000;
    const store = new AuthRepository(new BunSqlDatabase(database), () => nowSeconds);

    // Forward outbound fetch from AuthService to stub.fetch when targeted at GITHUB_URL
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input.toString(), init);
        return stub.fetch(req);
    }) as typeof fetch;

    const service = new AuthService(
        store,
        config,
        {
            clientSecret: () => "dev-secret",
            authSecret: () => "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        fetchImpl,
    );

    it("completes full login flow from CLI start to ERA token issuance using stub server", async () => {
        // 1. CLI begins login
        const beginResult = await service.begin("octo/example", "127.0.0.1");
        expect(beginResult.deviceCode).toBeDefined();
        expect(beginResult.userCode).toBeDefined();

        // 2. User enters verification code in browser, Worker initiates OAuth redirect
        const browserStart = await service.startBrowser(beginResult.userCode, "127.0.0.1");
        expect(browserStart.url.startsWith("http://localhost:8080/login/oauth/authorize")).toBe(true);

        // 3. User visits stub auth server authorize endpoint, which acts like GitHub and redirects to callback
        const authRedirect = await stub.fetch(new Request(browserStart.url));
        expect(authRedirect.status).toBe(302);
        const callbackUrl = authRedirect.headers.get("location")!;
        expect(callbackUrl.startsWith("http://localhost:8787/auth/github/callback")).toBe(true);

        // 4. Callback handling in Worker
        const callbackReq = new Request(callbackUrl, {
            headers: { cookie: browserStart.cookie.split(";")[0]! },
        });
        const callbackRes = await service.callback(callbackReq);
        expect(callbackRes.status).toBe(302);
        expect(callbackRes.headers.get("location")).toBe("http://localhost:8787/auth/cli/approve");

        // 5. Browser approve screen
        const sessionCookie = callbackRes.headers.get("set-cookie")!.split(";")[0]!;
        const approveReq = new Request("http://localhost:8787/auth/cli/approve", {
            headers: { cookie: sessionCookie },
        });
        const { session } = await service.browserSession(approveReq);
        const csrfToken = await service.csrf.issue(session.record.id);

        const approveActionReq = new Request("http://localhost:8787/auth/cli/approve", {
            method: "POST",
            headers: {
                origin: "http://localhost:8787",
                cookie: sessionCookie,
            },
        });
        await service.approve(approveActionReq, csrfToken, "approve");

        // 6. CLI polls and gets the issued repository-scoped ERA key
        const pollRes = await service.poll(beginResult.deviceCode);
        expect(pollRes.status).toBe(200);
        const pollData = (await pollRes.json()) as {
            apiToken: string;
            keyId: string;
            repository: string;
            subject: string;
        };
        expect(pollData.apiToken.startsWith("era_")).toBe(true);
        expect(pollData.repository).toBe("octo/example");
        expect(pollData.subject).toBe("github:42");

        // 7. Verify the issued ERA token grants access
        const testReq = new Request("http://localhost:8787/v1/estimates", {
            headers: { authorization: `Bearer ${pollData.apiToken}` },
        });
        const identity = await service.identity(testReq);
        expect(identity.kind).toBe("user");
        if (identity.kind === "user") {
            expect(identity.subject).toBe("github:42");
            expect(identity.repository).toBe("octo/example");
        }
    });
});
