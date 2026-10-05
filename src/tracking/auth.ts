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

export async function authenticate(
    request: Request,
    options: {
        apiToken: string;
        audience: string;
        authenticateEra?: (request: Request) => Promise<Identity>;
        verifyOidc?: (token: string, audience: string) => Promise<{ repository: string; workflowRef?: string }>;
    },
): Promise<Identity> {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!token) throw new HttpError("unauthorized", 401);
    if (options.apiToken && safeEqual(token, options.apiToken)) return { kind: "admin" };
    if (token.startsWith("era_") && options.authenticateEra) return options.authenticateEra(request);
    if (token.split(".").length !== 3) throw new HttpError("unauthorized", 401);
    try {
        const claims = await (options.verifyOidc ?? verifyGitHubOidc)(token, options.audience);
        return { kind: "github", repository: claims.repository, workflowRef: claims.workflowRef };
    } catch {
        throw new HttpError("unauthorized", 401);
    }
}

function safeEqual(left: string, right: string): boolean {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    return difference === 0;
}
