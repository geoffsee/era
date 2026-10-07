# di-framework Stub Auth Server

A local development OAuth 2.0 and OpenID Connect (OIDC) stub authorization server built with [`@di-framework/auth/server`](https://docs.di-framework.dev/auth.html#oauth-2-0-oidc-authorization-server) and [Bun](https://bun.sh).

## Features

- **OAuth 2.0 & OpenID Connect Core 1.0**:
  - RFC 6749 Authorization Code Grant
  - RFC 7636 Mandatory PKCE (`code_challenge_method=S256`)
  - RFC 7009 Token Revocation (`/oauth/revoke`)
  - OpenID Connect 1.0 Discovery (`/.well-known/openid-configuration`)
  - JWKS endpoint (`/.well-known/jwks.json`) with rotating cryptographic keys
  - UserInfo endpoint (`/oauth/userinfo`) with Bearer token authentication
- **Zero-configuration local development**:
  - Pre-registered `dev-client` client credentials
  - Automatic user consent for registered clients (no interactive prompt required in dev)
  - Full CORS support for browser / SPA frontend development (`http://localhost:*`)
  - In-memory keystore and token stores with zero external database dependencies
  - Dynamic client registration endpoint (`POST /dev/clients`)

## Quick Start

### Start the server

From this directory:
```bash
bun start
# or with custom options
bun src/index.ts --port 8080 --host localhost
```

From the root project repository:
```bash
bun run auth:server
```

### Pre-configured Dev Client

| Property | Value |
|---|---|
| **Client ID** | `dev-client` |
| **Client Secret** | `dev-secret` |
| **Scopes** | `openid`, `profile`, `email` |
| **Redirect URIs** | `http://localhost:3000/callback`, `http://localhost:8787/auth/github/callback`, `http://localhost:8080/callback` |

## Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/.well-known/openid-configuration` | `GET` | Discovery document |
| `/.well-known/jwks.json` | `GET` | Public signing keys |
| `/oauth/authorize` | `GET` / `POST` | Authorization endpoint (PKCE S256 required) |
| `/oauth/token` | `POST` | Issue access token, ID token, refresh token |
| `/oauth/userinfo` | `GET` / `POST` | User claims (`Authorization: Bearer <token>`) |
| `/oauth/revoke` | `POST` | Revoke a refresh token |
| `/health` | `GET` | Server status and metadata |
| `/dev/clients` | `POST` | Register additional OAuth client configurations |

## GitHub Emulation Layer

In addition to standard OIDC endpoints, this server provides a GitHub emulation layer so local development services (like the ERA Cloudflare Worker running under `wrangler dev`) can perform GitHub OAuth and permission verification completely offline.

| Endpoint | Method | Description |
|---|---|---|
| `/login/oauth/authorize` | `GET` / `POST` | GitHub authorization endpoint (supports PKCE and redirects to `redirect_uri`) |
| `/login/oauth/access_token` | `POST` | GitHub token exchange returning `ghu_...` access token and `ghr_...` refresh token |
| `/user` | `GET` | GitHub user profile (`id: 42`, `login: "dev-user"`, etc.) |
| `/repos/:owner/:repo` | `GET` | GitHub repository details with consistent numeric ID and owner |
| `/repos/:owner/:repo/collaborators/:login/permission` | `GET` | Collaborator permissions (`permission: "admin"`) |
| `/user/installations` | `GET` | GitHub App installations (`app_id: 5200437`) |
| `/user/installations/:id/repositories` | `GET` | Repositories accessible to the GitHub App installation |

## Local Development with ERA Worker

1. **Start the stub auth server**:
   ```bash
   bun run auth:server
   ```
   Listens on `http://localhost:8080`.

2. **Configure `.dev.vars` in project root**:
   ```ini
   PUBLIC_API_URL=http://localhost:8787
   GITHUB_URL=http://localhost:8080
   GITHUB_APP_ID=5200437
   GITHUB_APP_SLUG=era-roadmap
   GITHUB_CLIENT_ID=dev-client
   GITHUB_CLIENT_SECRET=dev-secret
   AUTH_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
   API_TOKEN=edc25a992630d39b9a6d6350e65888485be489ee63befe1e3b26e65a04c96c40
   ```

3. **Start the local Cloudflare Worker**:
   ```bash
   bun run api
   ```

4. **Log in using the ERA CLI**:
   ```bash
   bun src/cli/cli.ts login --repository octo/example --api http://localhost:8787
   ```

## Testing

Run tests with Bun:
```bash
bun test
```
Or from the project root:
```bash
bun run test:auth-server
```
