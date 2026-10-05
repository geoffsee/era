import { authenticated, authFailed, createPrincipal, noCredential, type AuthStrategy } from "@di-framework/auth";
import { requirePrincipal } from "@di-framework/auth/http";
import { verifyGitHubOidc } from "./oidc.ts";

export type Identity =
    | { kind: "admin" }
    | { kind: "github"; repository: string; workflowRef?: string }
    | { kind: "user"; subject: string; repository: string; keyId: string };

export class HttpError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

export function assertAccess(identity: Identity, repository: string): void {
    if (identity.kind === "admin") return;
    if (
        identity.kind === "user"
            ? identity.repository.toLowerCase() !== repository.toLowerCase()
            : identity.repository !== repository
    ) {
        throw new HttpError(`Credential for ${identity.repository} cannot access ${repository}`, 403);
    }
}

export type CredentialOptions = {
    apiToken: string;
    audience: string;
    authenticateEra?: (request: Request) => Promise<Identity>;
    verifyOidc?: (token: string, audience: string) => Promise<{ repository: string; workflowRef?: string }>;
};

/** ERA credential recognition plugs into the framework's HTTP guard. */
export function eraStrategy(options: CredentialOptions): AuthStrategy {
    return {
        name: "bearer",
        challenge: () => 'Bearer realm="era"',
        async authenticate({ request }) {
            const header = request.headers.get("authorization") ?? "";
            if (!header) return noCredential();
            const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
            if (!token) return authFailed("malformed_credential", "Expected a bearer credential");
            let identity: Identity;
            if (options.apiToken && safeEqual(token, options.apiToken)) identity = { kind: "admin" };
            else if (token.startsWith("era_") && options.authenticateEra) {
                try {
                    identity = await options.authenticateEra(request);
                } catch (error) {
                    if (error instanceof HttpError) throw error;
                    throw new HttpError("Authentication service is unavailable; retry", 503);
                }
            } else {
                if (token.split(".").length !== 3) return authFailed("invalid_credentials", "Unrecognized credential");
                try {
                    const claims = await (options.verifyOidc ?? verifyGitHubOidc)(token, options.audience);
                    identity = { kind: "github", repository: claims.repository, workflowRef: claims.workflowRef };
                } catch {
                    return authFailed("invalid_token", "GitHub OIDC verification failed");
                }
            }
            return authenticated(
                createPrincipal({
                    sub:
                        identity.kind === "admin"
                            ? "era:admin"
                            : identity.kind === "user"
                              ? identity.subject
                              : (identity.workflowRef ?? identity.repository),
                    method: identity.kind === "github" ? "bearer" : "api-key",
                    claims: { identity },
                }),
            );
        },
    };
}

/** Read only the guard-attached principal; request bodies cannot supply identity. */
export function requestIdentity(request: unknown): Identity {
    const identity = requirePrincipal(request).claims?.identity as Identity | undefined;
    if (!identity) throw new HttpError("unauthorized", 401);
    return identity;
}

function safeEqual(left: string, right: string): boolean {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    return difference === 0;
}
