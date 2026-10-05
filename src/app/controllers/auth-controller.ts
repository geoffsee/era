import { Component } from "@di-framework/core/decorators";
import { Controller } from "@di-framework/http/portable";
import { requireAuth } from "@di-framework/auth/http";
import { checkRequestOrigin } from "@di-framework/auth";
import { eraStrategy, requestIdentity, HttpError } from "../../core/auth/access.ts";
import { WORKER_SETTINGS, type WorkerSettings } from "../configuration.ts";
import { AuthService, authFailure } from "../services/auth-service.ts";

const escapeHtml = (value: string) =>
    value.replace(
        /[&<>"']/g,
        (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
    );
function page(title: string, body: string, status = 200, githubRedirect = false): Response {
    return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`,
        {
            status,
            headers: {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
                "content-security-policy": `default-src 'none'; form-action 'self'${githubRedirect ? " https://github.com" : ""}; frame-ancestors 'none'; base-uri 'none'`,
                "x-content-type-options": "nosniff",
            },
        },
    );
}
async function textBody(request: Request): Promise<string> {
    const reader = request.body?.getReader();
    if (!reader) throw new HttpError("Request body is required", 400);
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 8192) {
                await reader.cancel();
                throw new HttpError("Auth request is limited to 8 KiB", 413);
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
    }
    return new TextDecoder().decode(buffer);
}
async function body(request: Request): Promise<Record<string, unknown>> {
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
        throw new HttpError("content-type must be application/json", 415);
    try {
        const value = JSON.parse(await textBody(request));
        if (value === null || Array.isArray(value) || typeof value !== "object")
            throw new HttpError("JSON object is required", 400);
        return value;
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError("Invalid JSON", 400);
    }
}
async function form(request: Request): Promise<URLSearchParams> {
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/x-www-form-urlencoded")
        throw new HttpError("Form submission is required", 415);
    return new URLSearchParams(await textBody(request));
}
@Controller()
export class AuthController {
    constructor(
        @Component(AuthService) private readonly service: AuthService,
        @Component(WORKER_SETTINGS) private readonly settings: WorkerSettings,
    ) {}

    /** Mounted under /auth/* once login is configured. */
    async handle(request: Request): Promise<Response> {
        const service = this.service;
        const url = new URL(request.url);
        try {
            if (url.origin !== service.origin) throw new HttpError("Use the configured ERA API URL", 400);
            const ip = request.headers.get("cf-connecting-ip") ?? "local";
            const path = url.pathname;
            if (path === "/auth/cli/start" && request.method === "POST") {
                if (!checkRequestOrigin(request, { allowedOrigins: [service.origin] }))
                    throw new HttpError("Cross-origin login is forbidden", 403);
                return Response.json(await service.begin((await body(request)).repository, ip), {
                    status: 201,
                    headers: { "cache-control": "no-store" },
                });
            }
            if (path === "/auth/cli/token" && request.method === "POST")
                return await service.poll((await body(request)).deviceCode);
            if (path === "/auth/cli/verify" && request.method === "GET")
                return page(
                    "Sign in to ERA",
                    '<p>Enter the code displayed by your ERA CLI. Only approve a login you started yourself.</p><form method="post" action="/auth/github/start"><label>CLI code <input name="code" required maxlength="11" autocomplete="off"></label><button>Continue with GitHub</button></form>',
                    200,
                    true,
                );
            if (path === "/auth/github/start" && request.method === "POST") {
                if (!checkRequestOrigin(request, { allowedOrigins: [service.origin], requireOriginHeader: true }))
                    throw new HttpError("Invalid browser origin", 403);
                const result = await service.startBrowser((await form(request)).get("code") ?? "", ip);
                return new Response(null, {
                    status: 302,
                    headers: { location: result.url, "set-cookie": result.cookie, "cache-control": "no-store" },
                });
            }
            if (path === "/auth/github/callback" && request.method === "GET") return await service.callback(request);
            if (path === "/auth/cli/approve" && request.method === "GET") {
                const { flow, session } = await service.browserSession(request);
                if (flow.status !== "reviewing")
                    return page("Login completed", "<p>You can return to your terminal.</p>");
                const csrf = await service.csrf.issue(session.record.id);
                return page(
                    "Approve ERA CLI access",
                    `<p>Signed in as <strong>${escapeHtml(flow.login ?? "")}</strong>.</p><p>Repository: <strong>${escapeHtml(flow.repository)}</strong>. Terminal code: <strong>${escapeHtml(flow.userCode)}</strong>.</p><p>This permits reading and recording ERA forecasts for this repository. Confirm that the code matches your terminal.</p><form method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form><p>If ERA cannot access the repository, <a href="https://github.com/apps/${service.config.GITHUB_APP_SLUG}/installations/new" target="_blank" rel="noopener noreferrer">install the GitHub App</a> and retry approval here.</p>`,
                );
            }
            if (path === "/auth/cli/approve" && request.method === "POST") {
                const input = await form(request);
                try {
                    await service.approve(request, input.get("csrf") ?? "", input.get("decision") ?? "");
                } catch (error) {
                    if (error instanceof HttpError && error.status === 403 && error.message.includes("GitHub"))
                        return page(
                            "Repository access required",
                            `<p>${escapeHtml(error.message)}</p><p><a href="https://github.com/apps/${service.config.GITHUB_APP_SLUG}/installations/new" target="_blank" rel="noopener noreferrer">Install the ERA GitHub App</a>, then <a href="/auth/cli/approve">retry approval</a>.</p>`,
                            403,
                        );
                    throw error;
                }
                return page("Login completed", "<p>You can return to your terminal.</p>");
            }
            if (path === "/auth/tokens" || /^\/auth\/tokens\/[^/]+$/.test(path)) {
                const rejection = await requireAuth({
                    strategy: eraStrategy({
                        apiToken: this.settings.apiToken,
                        audience: service.origin,
                        authenticateEra: (req) => service.identity(req, false),
                    }),
                    onUnauthenticated: (_request, error) => authFailure(error),
                })(request);
                if (rejection) return rejection;
                const identity = requestIdentity(request);
                if (path === "/auth/tokens" && request.method === "GET") {
                    const { tokens, nextCursor } = await service.tokens(identity, url.searchParams.get("cursor") ?? "");
                    const headers = new Headers({ "cache-control": "no-store" });
                    if (nextCursor)
                        headers.set(
                            "link",
                            `<${service.origin}/auth/tokens?cursor=${encodeURIComponent(nextCursor)}>; rel="next"`,
                        );
                    return Response.json({ tokens }, { headers });
                }
                if (request.method === "DELETE" && path !== "/auth/tokens") {
                    const id = decodeURIComponent(path.slice("/auth/tokens/".length));
                    await service.revokeToken(identity, id);
                    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
                }
            }
            return Response.json({ error: "not found" }, { status: 404 });
        } catch (error) {
            // Deliberately record only classifications, never provider payloads or credentials.
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
    }
}
