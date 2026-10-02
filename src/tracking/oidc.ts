export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

export type GitHubOidcClaims = {
    repository: string;
    workflowRef?: string;
};

type Jwk = {
    kty: "RSA";
    n: string;
    e: string;
    alg?: string;
    kid?: string;
    use?: string;
};

type VerifyOptions = {
    jwks?: { keys: Jwk[] };
    now?: number;
    fetch?: typeof fetch;
};

const jwksCache = new Map<string, { keys: Jwk[]; expiresAt: number }>();

/** Verify a GitHub Actions OIDC token the way npm trusted publishing does. */
export async function verifyGitHubOidc(
    token: string,
    audience: string,
    options: VerifyOptions = {},
): Promise<GitHubOidcClaims> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("OIDC token is malformed");
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = decodeJson(encodedHeader) as { alg?: string; kid?: string };
    if (header.alg !== "RS256" || !header.kid) throw new Error("OIDC token must be RS256");
    const payload = decodeJson(encodedPayload) as {
        iss?: string;
        aud?: string | string[];
        exp?: number;
        nbf?: number;
        repository?: string;
        job_workflow_ref?: string;
    };
    const now = options.now ?? Date.now();
    if (payload.iss !== GITHUB_OIDC_ISSUER) throw new Error("OIDC issuer is not GitHub Actions");
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(audience)) throw new Error("OIDC audience does not match this tracker");
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) throw new Error("OIDC token is expired");
    if (typeof payload.nbf === "number" && payload.nbf * 1000 > now + 30_000)
        throw new Error("OIDC token is not valid yet");
    if (!payload.repository || !payload.repository.includes("/")) throw new Error("OIDC token has no repository");

    const jwk = await signingKey(header.kid, options);
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
        "verify",
    ]);
    const valid = await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        key,
        copyBytes(base64UrlToBytes(encodedSignature)),
        copyBytes(new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)),
    );
    if (!valid) throw new Error("OIDC signature is invalid");
    return { repository: payload.repository, workflowRef: payload.job_workflow_ref };
}

async function signingKey(kid: string, options: VerifyOptions): Promise<Jwk> {
    const keys = options.jwks?.keys ?? (await loadJwks(options.fetch ?? globalThis.fetch));
    const key = keys.find((candidate) => candidate.kid === kid);
    if (!key) throw new Error(`OIDC signing key ${kid} was not found`);
    return key;
}

async function loadJwks(fetchImpl: typeof fetch): Promise<Jwk[]> {
    const cached = jwksCache.get(GITHUB_OIDC_ISSUER);
    if (cached && cached.expiresAt > Date.now()) return cached.keys;
    const response = await fetchImpl(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`);
    if (!response.ok) throw new Error("GitHub OIDC keys could not be loaded");
    const body = (await response.json()) as { keys?: Jwk[] };
    const keys = body.keys ?? [];
    jwksCache.set(GITHUB_OIDC_ISSUER, { keys, expiresAt: Date.now() + 10 * 60 * 1000 });
    return keys;
}

function decodeJson(segment: string): unknown {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    return new Uint8Array(bytes);
}

function base64UrlToBytes(segment: string): Uint8Array<ArrayBuffer> {
    const padded = segment
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(segment.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}
