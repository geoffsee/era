# User authentication

The hosted tracker uses [ERA Roadmap](https://github.com/apps/era-roadmap), owned by `geoffsee`. Repository owners can [install the app](https://github.com/apps/era-roadmap/installations/new) with **Only select repositories**, then complete `era login`. Other users do not need to register their own app. The app requests Metadata read access only.

Users obtain a repository-scoped ERA token with GitHub login:

```sh
bun src/cli.ts login --api https://era-tracker.seemueller.workers.dev --repository owner/name
bun src/cli.ts accuracy --repository owner/name
bun src/cli.ts tokens
bun src/cli.ts revoke-token --id TOKEN_ID
bun src/cli.ts logout
```

The CLI opens a browser and prints a verification URL and code. Enter the code, sign in to GitHub, and confirm the account, repository and matching terminal code before approving. Over SSH or on a headless machine, open the printed URL on another machine; `--no-browser` skips automatic browser launch. The CLI polls every five seconds for up to ten minutes and saves the resulting token automatically. Denial, expiry and failed login preserve previously saved credentials.

The user must have GitHub write or admin permission (maintain maps to write), and the ERA GitHub App must be installed on the selected repository. Both public and private repositories require installation access. Organization installation and SSO policies still apply. If approval fails because installation access is missing, the browser provides an installation link; install the app and retry approval before the login expires.

Each ERA key permits reading and recording forecasts for one repository and expires after 30 days. `tokens` lists the current user's key metadata with pagination; keys are never shown again. A user can revoke their own keys, and the operator admin credential can revoke any known key ID. `logout` revokes the selected key before deleting it locally; a network failure preserves it for retry. Signing in again replaces the saved key and attempts to revoke the previous key. A revoked or expired key cannot be used to list keys; sign in again to manage other keys.

Credentials are stored in `$XDG_CONFIG_HOME/era/credentials.json`, falling back to `~/.config/era/credentials.json`, with atomic replacement, file mode 0600 and directory mode 0700. Credentials are selected by API URL and repository. API URL precedence is `--api`, `ERA_API_URL`, then the saved active API. Token precedence is `--token`, `ERA_API_TOKEN`, then the selected saved key. Commands without a repository use the saved active repository. Explicit credentials do not fall back to saved credentials after an authentication failure.

`GH_TOKEN` or `GITHUB_PAT` still supplies GitHub issue access for CLI roadmap collection. ERA login supplies the Worker credential; it does not export a GitHub token to the CLI. Saved roadmap snapshots can be estimated without GitHub issue credentials.

## Operator setup

Register a [GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) with repository **Metadata: read** permission. Use selected repository installations; no contents or issues write permission is needed for ERA authentication. Enable expiring user access tokens. Set the exact callback URL to `https://YOUR-WORKER/auth/github/callback`. Leave automatic user authorization during installation off: ERA starts authorization with its own browser-bound PKCE state. Native GitHub device flow is not needed for ERA's polling handoff. Webhooks can remain inactive; permission checks enforce access changes within five minutes.

Apply both migrations before enabling login:

```sh
bunx wrangler d1 migrations apply era-tracker --remote
```

Configure these Worker bindings. Nonsecret values can be added to `vars` in `wrangler.jsonc`; keep the secret values in Worker secrets:

| Binding | Value |
| --- | --- |
| `PUBLIC_API_URL` | Trusted HTTPS origin, including a port if needed, with no path/query. |
| `GITHUB_APP_ID` | Numeric GitHub App ID. |
| `GITHUB_APP_SLUG` | GitHub App slug, used for installation links. |
| `GITHUB_CLIENT_ID` | GitHub App OAuth client ID, distinct from the app ID. |
| `GITHUB_CLIENT_SECRET` | GitHub App OAuth client secret. |
| `AUTH_SECRET` | Random master secret with at least 32 bytes of entropy; a 64-character value from `openssl rand -hex 32` is suitable. |

```sh
bunx wrangler secret put GITHUB_CLIENT_SECRET
bunx wrangler secret put AUTH_SECRET
bun run deploy
```

The existing `API_TOKEN` remains the operator admin credential. GitHub Actions continues to use repository-scoped OIDC. With `PUBLIC_API_URL` absent, the Worker serves the existing admin/OIDC API and reports that GitHub login is unconfigured. Configuring it requires all other login bindings. Register separate development/preview apps for their exact HTTPS callback origins. Local auth testing uses Wrangler HTTPS and a disposable D1 database; `.dev.vars` holds development bindings and is never committed.

The Worker refreshes expiring GitHub credentials automatically. Invalid refresh credentials require a new login. Rotating `AUTH_SECRET` requires users to sign in again because old provider credentials cannot be decrypted under the new secret. Configure and qualify the Worker before distributing the new CLI.

## Protocol and storage

The implementation uses `@di-framework/auth` 6.0.3 for GitHub OAuth/PKCE, sessions, CSRF protection, API key issuance and verification, hashing and authenticated encryption. No in-memory production auth stores are used.

| Endpoint | Behavior |
| --- | --- |
| `POST /auth/cli/start` | JSON `{repository}`; returns 201 with `deviceCode`, `userCode`, `verificationUri`, `expiresAt` and `interval`. |
| `GET /auth/cli/verify` | Browser verification form. |
| `POST /auth/github/start` | Browser code submission; starts PKCE with a browser-bound state cookie. |
| `GET /auth/github/callback` | Consumes OAuth state atomically and establishes a ten-minute approval session. |
| `GET/POST /auth/cli/approve` | Displays approval; POST requires session-bound CSRF and a same-origin browser request. |
| `POST /auth/cli/token` | JSON `{deviceCode}`; 202 while pending, 429 for early polling, 200 with a one-time `apiToken`, `keyId`, `repository`, `subject` and `expiresAt` after approval. |
| `GET /auth/tokens` | User bearer credential; returns metadata for up to 100 keys and a `Link: rel="next"` cursor when needed. |
| `DELETE /auth/tokens/:id` | Owner or operator revocation; returns 204. |

Auth bodies are capped at 8 KiB. Login starts are limited to ten per minute per connecting IP, and browser code verification to thirty per minute. Device codes are 256-bit secrets and are stored only as hashes. Approval is atomically claimed by one poll; response loss after issuance requires another login. No key appears in browser URLs, pages or logs. API key hashes and their repository grants share a D1 row. Provider access/refresh tokens are encrypted with AES-GCM and subject-bound associated data. Login state, approval sessions, flows, throttles and permission caches expire and are purged hourly; key metadata is retained for listing and revocation.

GitHub permission checks use the user's stable subject, repository ID, app installation and base repository permission. Successful checks are cached for at most five minutes across Worker instances. Renamed/transferred/replaced repositories or changed installations require login again; keys do not follow a reused repository name. Provider outages or rate limits after cache expiry return 503 without admitting requests. Definite removal of access disables the affected repository keys; revoked GitHub credentials disable that user's keys. Provider refresh uses a D1 lease and conditional writes to avoid concurrent rotation. Authentication logs contain event classifications, subject and repository, never raw credentials or provider payloads.

The implementation tests use synthetic GitHub responses and SQLite/D1 fixtures. On 2026-10-05, the hosted Worker was configured with the registered app and verified using the published `@era.js/era@0.1.0` CLI: GitHub OAuth/PKCE, approval, automatic credential storage, an authenticated read of `geoffsee/era`, rejection of another repository, token metadata, logout and rejection of the revoked key all passed. The app installation selects `geoffsee/era` and `geoffsee/rubix-kube`. Private repository and organization/SSO flows still require fresh operational qualification; unit tests do not establish those cases.
