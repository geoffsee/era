import { checkRequestOrigin } from "@di-framework/auth";
import { requireAuth } from "@di-framework/auth/http";
import { useContainer } from "@di-framework/core/container";
import { Component } from "@di-framework/core/decorators";
import {
    Controller,
    Endpoint,
    type Json,
    type Multipart,
    type PathParams,
    type QueryParams,
    type RequestSpec,
    type ResponseSpec,
} from "@di-framework/http/portable";
import { eraStrategy, HttpError, requestIdentity } from "../../core/auth/access.ts";
import { API_TOKEN } from "../configuration.ts";
import { asHttpRequest, capRequestBody, router, settings } from "../http.ts";
import { AuthService, authFailure } from "../services/auth-service.ts";

const escapeHtml = (value: string) =>
    value.replace(
        /[&<>"']/g,
        (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
    );
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Hosts the verification form may navigate to. Chromium applies `form-action` to the
 * OAuth redirect as well as the form post, so a configured stub origin has to be listed.
 * Only an origin is emitted, and non-loopback HTTP hosts are omitted.
 */
export function githubFormAction(githubUrl?: string): string {
    const sources = ["'self'", "https://github.com"];
    const origin = authorizationOrigin(githubUrl);
    if (origin && !sources.includes(origin)) sources.push(origin);
    return sources.join(" ");
}
/** Browser mutations must present this origin. Sec-Fetch-Site alone is not an allowlist. */
function requireBrowserOrigin(request: Request, origin: string): void {
    if (request.headers.get("origin") !== origin) throw new HttpError("Invalid browser origin", 403);
}
function authorizationOrigin(githubUrl?: string): string | undefined {
    if (!githubUrl) return undefined;
    try {
        const url = new URL(githubUrl);
        const loopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
        if ((url.protocol !== "https:" && !loopbackHttp) || url.username || url.password) return undefined;
        return url.origin;
    } catch {
        return undefined;
    }
}
function page(title: string, body: string, status = 200, githubRedirect = false, githubUrl?: string): Response {
    const formAction = githubRedirect ? githubFormAction(githubUrl) : "'self'";
    return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`,
        {
            status,
            headers: {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
                "content-security-policy": `default-src 'none'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
                "x-content-type-options": "nosniff",
            },
        },
    );
}
const AUTH_LIMIT = 8192;
type FormRequest = Request & { content: FormData };
type JsonAuthRequest = Request & { content: unknown };
type TokenListRequest = Request & { query: { cursor?: string | string[] } };
type TokenIdRequest = Request & { params: { id: string } };

@Controller()
export class AuthController {
    constructor(
        @Component(AuthService) private readonly service: AuthService,
        @Component(API_TOKEN) private readonly apiToken: () => string,
    ) {}

    @Endpoint({ summary: "Start a CLI login" })
    static startCli = router.post<RequestSpec<Json<{ repository?: unknown }>>, ResponseSpec<unknown>>(
        "/auth/cli/start",
        (request) => authCall((controller) => controller.startCli(asHttpRequest(request))),
        { use: [guardAuth, cliStartOrigin, requireJson, capAuth] },
    );

    @Endpoint({ summary: "Poll a CLI login" })
    static pollCli = router.post<RequestSpec<Json<{ deviceCode?: unknown }>>, ResponseSpec<unknown>>(
        "/auth/cli/token",
        (request) => authCall((controller) => controller.pollCli(asHttpRequest(request))),
        { use: [guardAuth, requireJson, capAuth] },
    );

    @Endpoint({ summary: "Show the CLI verification form" })
    static verify = router.get("/auth/cli/verify", () => authCall((controller) => controller.verify()), {
        use: [guardAuth],
    });

    @Endpoint({ summary: "Start GitHub login" })
    static startGithub = router.post<RequestSpec<Multipart<{ code?: string }>>, ResponseSpec<unknown>>(
        "/auth/github/start",
        (request) => authCall((controller) => controller.startGithub(asHttpRequest(request))),
        { multipart: true, use: [guardAuth, browserOrigin, requireForm, capAuth] },
    );

    @Endpoint({ summary: "Complete GitHub login" })
    static githubCallback = router.get(
        "/auth/github/callback",
        (request) => authCall((controller) => controller.githubCallback(asHttpRequest(request))),
        { use: [guardAuth] },
    );

    @Endpoint({ summary: "Show the CLI approval form" })
    static showApproval = router.get(
        "/auth/cli/approve",
        (request) => authCall((controller) => controller.showApproval(asHttpRequest(request))),
        { use: [guardAuth] },
    );

    @Endpoint({ summary: "Approve or deny a CLI login" })
    static submitApproval = router.post<
        RequestSpec<Multipart<{ csrf?: string; decision?: string }>>,
        ResponseSpec<unknown>
    >("/auth/cli/approve", (request) => authCall((controller) => controller.submitApproval(asHttpRequest(request))), {
        multipart: true,
        use: [guardAuth, browserOrigin, requireForm, capAuth],
    });

    @Endpoint({ summary: "List API tokens" })
    static listTokens = router.get<RequestSpec<QueryParams<{ cursor?: string }>>, ResponseSpec<{ tokens: unknown[] }>>(
        "/auth/tokens",
        (request) => authCall((controller) => controller.listTokens(asHttpRequest(request))),
        {
            use: [guardAuth],
        },
    );

    @Endpoint({ summary: "Revoke an API token" })
    static revokeToken = router.delete<RequestSpec<PathParams<{ id: string }>>, ResponseSpec<unknown>>(
        "/auth/tokens/:id",
        (request) => authCall((controller) => controller.revokeToken(asHttpRequest(request))),
        { use: [guardAuth] },
    );

    async startCli(request: JsonAuthRequest): Promise<Response> {
        const ip = request.headers.get("cf-connecting-ip") ?? "local";
        return Response.json(await this.service.begin(authJson(request.content).repository, ip), {
            status: 201,
            headers: { "cache-control": "no-store" },
        });
    }

    pollCli(request: JsonAuthRequest): Promise<Response> {
        return this.service.poll(authJson(request.content).deviceCode);
    }

    verify(): Response {
        return page(
            "Sign in to ERA",
            '<p>Enter the code displayed by your ERA CLI. Only approve a login you started yourself.</p><form method="post" action="/auth/github/start"><label>CLI code <input name="code" required maxlength="11" autocomplete="off"></label><button>Continue with GitHub</button></form>',
            200,
            true,
            this.service.config.GITHUB_URL,
        );
    }

    async startGithub(request: FormRequest): Promise<Response> {
        const ip = request.headers.get("cf-connecting-ip") ?? "local";
        const result = await this.service.startBrowser(formValue(request.content, "code"), ip);
        return new Response(null, {
            status: 302,
            headers: { location: result.url, "set-cookie": result.cookie, "cache-control": "no-store" },
        });
    }

    githubCallback(request: Request): Promise<Response> {
        return this.service.callback(request);
    }

    async showApproval(request: Request): Promise<Response> {
        const { flow, session } = await this.service.browserSession(request);
        if (flow.status !== "reviewing") return page("Login completed", "<p>You can return to your terminal.</p>");
        const csrf = await this.service.csrf.issue(session.record.id);
        return page(
            "Approve ERA CLI access",
            `<p>Signed in as <strong>${escapeHtml(flow.login ?? "")}</strong>.</p><p>Repository: <strong>${escapeHtml(flow.repository)}</strong>. Terminal code: <strong>${escapeHtml(flow.userCode)}</strong>.</p><p>This permits reading and recording ERA forecasts for this repository. Confirm that the code matches your terminal.</p><form method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form><p>If ERA cannot access the repository, <a href="https://github.com/apps/${this.service.config.GITHUB_APP_SLUG}/installations/new" target="_blank" rel="noopener noreferrer">install the GitHub App</a> and retry approval here.</p>`,
        );
    }

    async submitApproval(request: FormRequest): Promise<Response> {
        try {
            await this.service.approve(
                request,
                formValue(request.content, "csrf"),
                formValue(request.content, "decision"),
            );
        } catch (error) {
            if (error instanceof HttpError && error.status === 403 && error.message.includes("GitHub"))
                return page(
                    "Repository access required",
                    `<p>${escapeHtml(error.message)}</p><p><a href="https://github.com/apps/${this.service.config.GITHUB_APP_SLUG}/installations/new" target="_blank" rel="noopener noreferrer">Install the ERA GitHub App</a>, then <a href="/auth/cli/approve">retry approval</a>.</p>`,
                    403,
                );
            throw error;
        }
        return page("Login completed", "<p>You can return to your terminal.</p>");
    }

    async listTokens(request: TokenListRequest): Promise<Response> {
        const rejection = await this.authenticateToken(request);
        if (rejection) return rejection;
        const cursor = request.query.cursor;
        const { tokens, nextCursor } = await this.service.tokens(
            requestIdentity(request),
            Array.isArray(cursor) ? (cursor[0] ?? "") : (cursor ?? ""),
        );
        const headers = new Headers({ "cache-control": "no-store" });
        if (nextCursor)
            headers.set(
                "link",
                `<${this.service.origin}/auth/tokens?cursor=${encodeURIComponent(nextCursor)}>; rel="next"`,
            );
        return Response.json({ tokens }, { headers });
    }

    async revokeToken(request: TokenIdRequest): Promise<Response> {
        const rejection = await this.authenticateToken(request);
        if (rejection) return rejection;
        await this.service.revokeToken(requestIdentity(request), request.params.id);
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }

    private authenticateToken(request: Request): Promise<Response | undefined> {
        return requireAuth({
            strategy: eraStrategy({
                apiToken: this.apiToken,
                audience: this.service.origin,
                authenticateEra: (req) => this.service.identity(req, false),
            }),
            onUnauthenticated: (_request, error) => authFailure(error),
        })(request);
    }
}

function authCall(run: (controller: AuthController) => Promise<Response> | Response): Promise<Response> {
    return Promise.resolve()
        .then(() => run(useContainer().resolve(AuthController)))
        .catch(logAuthFailure);
}

function guardAuth(request: Request): Response | undefined {
    if (!settings().auth) return authFailure(new HttpError("GitHub login is not configured on this Worker", 503));
    try {
        const service = useContainer().resolve(AuthService);
        if (new URL(request.url).origin !== service.origin) throw new HttpError("Use the configured ERA API URL", 400);
        return undefined;
    } catch (error) {
        return logAuthFailure(error);
    }
}

function cliStartOrigin(request: Request): Response | undefined {
    const service = useContainer().resolve(AuthService);
    if (!checkRequestOrigin(request, { allowedOrigins: [service.origin] }))
        return logAuthFailure(new HttpError("Cross-origin login is forbidden", 403));
    return undefined;
}

function browserOrigin(request: Request): Response | undefined {
    try {
        requireBrowserOrigin(request, useContainer().resolve(AuthService).origin);
        return undefined;
    } catch (error) {
        return logAuthFailure(error);
    }
}

function requireJson(request: Request): Response | undefined {
    const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") return logAuthFailure(new HttpError("content-type must be application/json", 415));
    return undefined;
}

function requireForm(request: Request): Response | undefined {
    const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/x-www-form-urlencoded")
        return logAuthFailure(new HttpError("Form submission is required", 415));
    return undefined;
}

async function capAuth(request: Request): Promise<Response | undefined> {
    try {
        await capRequestBody(request, AUTH_LIMIT, "Auth request is limited to 8 KiB");
        return undefined;
    } catch (error) {
        return logAuthFailure(error);
    }
}

function authJson(content: unknown): Record<string, unknown> {
    if (content === undefined) throw new HttpError("Request body is required", 400);
    if (typeof content === "string" || content instanceof FormData) throw new HttpError("Invalid JSON", 400);
    if (content === null || Array.isArray(content) || typeof content !== "object")
        throw new HttpError("JSON object is required", 400);
    return content as Record<string, unknown>;
}

function formValue(form: FormData | undefined, name: string): string {
    if (!form) throw new HttpError("Form submission is required", 415);
    const value = form.get(name);
    return typeof value === "string" ? value : "";
}

function logAuthFailure(error: unknown): Response {
    console.info(
        JSON.stringify({
            event: "era.auth.failure",
            status:
                error instanceof HttpError
                    ? error.status
                    : error instanceof Error && "status" in error
                      ? error.status
                      : 503,
        }),
    );
    return authFailure(error);
}
