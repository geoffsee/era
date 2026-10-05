import { hashSecret } from "@di-framework/auth";
import { type CredentialCache, credentialId, type SavedCredential } from "./credentials.ts";

export type LoginIo = {
    fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    stdout: (line: string) => void;
    openBrowser?: (url: string) => Promise<void>;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
};
export function apiUrl(value: string): string {
    if (!value) throw new Error("Set ERA_API_URL or pass --api.");
    const url = new URL(value);
    if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== "https:" &&
            !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
        throw new Error("ERA API URL must use HTTPS (HTTP is allowed on loopback for development).");
    return url.href.replace(/\/$/, "");
}
export async function login(
    api: string,
    repository: string,
    cache: CredentialCache,
    io: LoginIo,
    noBrowser: boolean,
): Promise<void> {
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw new Error("repository must be owner/name");
    const now = io.now ?? (() => Math.floor(Date.now() / 1000));
    const request = (path: string, payload: unknown) =>
        io.fetch(`${api}${path}`, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(15000),
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
        });
    const response = await request("/auth/cli/start", { repository });
    const start = (await response.json()) as {
        error?: string;
        deviceCode: string;
        userCode: string;
        verificationUri: string;
        expiresAt: number;
        interval: number;
    };
    if (!response.ok) throw new Error(start.error ?? "Could not start login");
    if (
        new URL(start.verificationUri).origin !== new URL(api).origin ||
        !Number.isFinite(start.expiresAt) ||
        !Number.isFinite(start.interval) ||
        start.interval < 5 ||
        typeof start.deviceCode !== "string" ||
        typeof start.userCode !== "string"
    )
        throw new Error("Worker returned an invalid login response");
    io.stdout(`Open ${start.verificationUri} and enter ${start.userCode}. Approve access to ${repository}.`);
    if (!noBrowser && io.openBrowser) {
        try {
            await io.openBrowser(start.verificationUri);
        } catch {
            io.stdout("Open the URL manually to continue.");
        }
    }
    const sleep = io.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const deadline = Math.min(start.expiresAt, now() + 600);
    while (now() < deadline) {
        await sleep(start.interval * 1000);
        const poll = await request("/auth/cli/token", { deviceCode: start.deviceCode });
        const result = (await poll.json()) as SavedCredential & { error?: string };
        if ([202, 429, 503].includes(poll.status)) continue;
        if (!poll.ok) throw new Error(result.error ?? "Login failed");
        if (
            !result.apiToken?.startsWith("era_") ||
            result.repository.toLowerCase() !== repository.toLowerCase() ||
            !result.subject?.startsWith("github:") ||
            result.expiresAt <= now() ||
            result.keyId !== (await hashSecret(result.apiToken))
        )
            throw new Error("Worker returned an invalid credential");
        const state = cache.read();
        const id = credentialId(api, result.repository);
        const previous = state.credentials[id];
        state.activeApi = api;
        state.activeRepository[api] = result.repository;
        state.credentials[id] = result;
        try {
            cache.write(state);
        } catch (error) {
            // Avoid leaving a usable new remote key when local persistence fails.
            try {
                await io.fetch(`${api}/auth/tokens/${encodeURIComponent(result.keyId)}`, {
                    method: "DELETE",
                    headers: { authorization: `Bearer ${result.apiToken}` },
                    redirect: "error",
                    signal: AbortSignal.timeout(15000),
                });
            } catch {
                /* May require revocation from another login. */
            }
            throw error;
        }
        if (previous && previous.keyId !== result.keyId) {
            try {
                const revoked = await io.fetch(`${api}/auth/tokens/${encodeURIComponent(previous.keyId)}`, {
                    method: "DELETE",
                    headers: { authorization: `Bearer ${result.apiToken}` },
                    redirect: "error",
                    signal: AbortSignal.timeout(15000),
                });
                if (!revoked.ok)
                    io.stdout("Previous token remains active; use era tokens and era revoke-token to revoke it.");
            } catch {
                io.stdout("Previous token could not be revoked; use era tokens and era revoke-token to revoke it.");
            }
        }
        io.stdout(
            `Signed in for ${result.repository}. ERA token expires ${new Date(result.expiresAt * 1000).toISOString()}.`,
        );
        return;
    }
    throw new Error("Login expired; run era login again.");
}
