import { type StubAuthServerOptions, startStubAuthServer } from "./server.ts";

export * from "./server.ts";

function parseCliArgs(args: string[]): StubAuthServerOptions {
    const options: StubAuthServerOptions = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--port" && i + 1 < args.length) {
            options.port = Number(args[++i]);
        } else if (arg === "--host" && i + 1 < args.length) {
            options.host = args[++i];
        } else if (arg === "--issuer" && i + 1 < args.length) {
            options.issuer = args[++i];
        } else if (arg === "--subject" && i + 1 < args.length) {
            options.defaultSubject = args[++i];
        } else if (arg === "--no-auto-consent") {
            options.autoConsent = false;
        } else if (arg === "--help" || arg === "-h") {
            console.log(`di-framework Stub Auth Server for Local Development

Usage:
  bun run start [options]
  bun src/index.ts [options]

Options:
  --port <number>       Port to listen on (default: 8080 or $PORT)
  --host <string>       Host to bind to (default: localhost or $HOST)
  --issuer <url>        Issuer URL (default: http://<host>:<port>)
  --subject <string>    Default dev user subject (default: dev-user)
  --no-auto-consent     Require explicit consent instead of auto-consenting
  -h, --help            Show this help message

Pre-configured client:
  Client ID:     dev-client
  Client Secret: dev-secret
  Scopes:        openid profile email
  Redirect URIs: http://localhost:3000/callback, http://localhost:8787/auth/github/callback, etc.
`);
            process.exit(0);
        }
    }
    return options;
}

if (import.meta.main) {
    const cliOptions = parseCliArgs(process.argv.slice(2));
    const running = startStubAuthServer(cliOptions);
    console.log(`\n🚀 di-framework Stub Auth Server running at ${running.issuer}`);
    console.log(`   - Discovery: ${running.issuer}/.well-known/openid-configuration`);
    console.log(`   - JWKS:      ${running.issuer}/.well-known/jwks.json`);
    console.log(`   - Authorize: ${running.issuer}/oauth/authorize`);
    console.log(`   - Token:     ${running.issuer}/oauth/token`);
    console.log(`   - UserInfo:  ${running.issuer}/oauth/userinfo`);
    console.log(`   - Revoke:    ${running.issuer}/oauth/revoke`);
    console.log(`   - Health:    ${running.issuer}/health`);
    console.log("\n   Default client: client_id=dev-client, client_secret=dev-secret\n");
}
