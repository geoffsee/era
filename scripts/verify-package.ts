import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSecret } from "@di-framework/auth";

const root = await mkdtemp(join(tmpdir(), "era-npm-"));
const repository = "octo/example";
const apiToken = "era_package-test-token";
const keyId = await hashSecret(apiToken);
const requests: string[] = [];
const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
        const path = new URL(request.url).pathname;
        requests.push(path);
        if (path === "/auth/cli/start") {
            assert.deepEqual(await request.json(), { repository });
            return Response.json(
                {
                    deviceCode: "synthetic-device-code",
                    userCode: "ABCDE-12345",
                    verificationUri: `${server.url.origin}/auth/cli/verify`,
                    expiresAt: Math.floor(Date.now() / 1000) + 600,
                    interval: 5,
                },
                { status: 201 },
            );
        }
        if (path === "/auth/cli/token")
            return Response.json({
                apiToken,
                keyId,
                repository,
                subject: "github:42",
                expiresAt: Math.floor(Date.now() / 1000) + 86400,
            });
        assert.equal(request.headers.get("authorization"), `Bearer ${apiToken}`);
        if (path === "/v1/roadmap-validations") {
            const input = (await request.json()) as {
                roadmapConfig: unknown;
                roadmap: { body: string };
                history?: unknown;
            };
            assert.deepEqual(input.roadmapConfig, { format: "normalized-json" });
            assert.equal(input.history, undefined);
            return Response.json({ roadmap: JSON.parse(input.roadmap.body), diagnostics: [] });
        }
        if (path === "/v1/backtests") {
            const body = (await request.json()) as { history: { pullRequests: unknown[] }; record: boolean };
            assert.deepEqual(body.history.pullRequests, []);
            assert.equal(body.record, true);
            return Response.json({ reports: [] });
        }
        if (path === `/auth/tokens/${keyId}`) return new Response(null, { status: 204 });
        return Response.json({ error: "Unexpected request" }, { status: 400 });
    },
});
async function run(command: string[], cwd = root) {
    const env: Record<string, string | undefined> = { ...process.env, XDG_CONFIG_HOME: root };
    delete env.ERA_API_URL;
    delete env.ERA_API_TOKEN;
    const child = Bun.spawn(command, {
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    assert.equal(code, 0, `${command[0]} failed: ${stderr}\n${stdout}`);
    return stdout;
}
try {
    const packed = JSON.parse(
        await run(["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", root], process.cwd()),
    ) as Array<{ filename: string; files: Array<{ path: string }> }>;
    const contents = packed[0]!.files.map((file) => file.path);
    assert(contents.includes("dist/cli.js"));
    assert(
        contents.every(
            (path) =>
                [
                    "README.md",
                    "package.json",
                    "dist/cli.js",
                    "docs/AUTH.md",
                    "docs/FORECAST-API.md",
                    "docs/HISTORICAL-DATA.md",
                    "docs/ROADMAP-FORMATS.md",
                ].includes(path) ||
                /^examples\/roadmaps\/(era\.config\.json|normalized\.config\.json|roadmap\.md|roadmap\.json)$/.test(
                    path,
                ) ||
                /^historical-data\/[^/]+\.schema\.json$/.test(path),
        ),
    );
    await run(["npm", "install", "--prefix", root, "--no-audit", "--no-fund", join(root, packed[0]!.filename)]);
    const bin = join(root, "node_modules/.bin/era");
    assert((await run([bin, "--help"])).includes("era login"));
    const output = await run([bin, "login", "--api", server.url.origin, "--repository", repository, "--no-browser"]);
    assert(output.includes("Signed in"));
    assert(!output.includes(apiToken));
    const cache = join(root, "era/credentials.json");
    assert.equal((await stat(cache)).mode & 0o777, 0o600);
    await writeFile(
        join(root, "pr_token_usage_dataset.json"),
        JSON.stringify({ metadata: { repository }, pull_requests: [] }),
    );
    await writeFile(join(root, "pr_cicd_dataset.json"), "[]");
    await run([bin, "backtest", "--repository", repository, "--dir", root]);
    await writeFile(
        join(root, "era.config.json"),
        JSON.stringify({ version: 1, roadmap: { format: "normalized-json" } }),
    );
    await writeFile(
        join(root, "roadmap.json"),
        JSON.stringify({ version: 1, items: [{ issue: 12, title: "Custom work" }] }),
    );
    const preview = JSON.parse(
        await run([bin, "roadmap", "validate", "--repository", repository, "--body", join(root, "roadmap.json")]),
    );
    assert.equal(preview.roadmap.items[0].title, "Custom work");
    await run([bin, "logout"]);
    assert.deepEqual(JSON.parse(await readFile(cache, "utf8")).credentials, {});
    assert.deepEqual(requests, [
        "/auth/cli/start",
        "/auth/cli/token",
        "/v1/backtests",
        "/v1/roadmap-validations",
        `/auth/tokens/${keyId}`,
    ]);
    console.log(
        "Packed CLI passed Node help, login, cached credentials, history loading, configurable roadmap validation and logout checks.",
    );
} finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
}
