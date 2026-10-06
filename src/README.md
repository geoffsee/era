# Source layout

Source is grouped into `app/` for the Worker application, `core/` for domain logic and shared integrations, and `cli/` for the npm command-line client.

| Directory | Purpose |
| --- | --- |
| `app/controllers/` | Authentication, forecast, and tracking HTTP handlers |
| `app/services/` | Login and token management, forecast validation and calculation, in-context inference, and accuracy orchestration |
| `app/repositories/` | Prediction and observation repositories, authentication storage, and historical/GitHub data access |
| `core/auth/` | Credential strategy, repository authorization, GitHub OIDC verification, CLI login, and local credential storage |
| `core/forecast/` | Estimation, cost accounting, calibration validation, forecast plans, inference prompts and validation, API contracts, and reports |
| `core/roadmap/` | Roadmap parsing, configurable formats, normalization, and dependency graphs |
| `core/history/` | Historical usage models and dataset validation tests |
| `core/usage/` | Author-session and review usage extraction and attribution |
| `core/github/` | GitHub API client |
| `core/tracking/` | Prediction and observation models, input validation errors, accuracy scoring, and backtests |
| `core/persistence/` | Shared database contracts, SQL adapters, and forecast schema initialization |
| `cli/` | Installed executable and command orchestration |

[`app/main.ts`](app/main.ts) publishes the Worker bindings through `@di-framework/cloudflare`, which registers a lazy `CloudflareEnvironment` factory and classifies each binding, with the names in `SECRET_NAMES` marked as secrets. [`app/configuration.ts`](app/configuration.ts) is the only module that interprets bindings: its `WorkerConfiguration` beans depend on `CloudflareEnvironment` and derive `SQL_DATABASE` from `DB`, `WORKER_SETTINGS` and `AUTH_CONFIG` from the vars and secrets, and `CHAT_MODEL` from `ANTHROPIC_API_KEY` (an `@di-framework/ai` `AnthropicChatModel`), else from the `AI` binding (a `WorkersAiChatModel`), else `undefined`. `main.ts` then starts an `ApplicationContext` with that configuration, resolves the forecast and tracking controllers so a missing registration fails at startup, and exports the Worker `fetch` and `scheduled` handlers. [`app/http.ts`](app/http.ts) applies the forecast schema once per isolate, configures authentication middleware, resolves controllers from the container, and maps `HttpError` and `InputError` to HTTP statuses in one place.

Decorators register controllers, services, and repositories automatically, and every component is a singleton. Controllers receive services through constructor injection, services receive repositories the same way, repositories and `AuthStore` inject `SQL_DATABASE`, `AuthService` injects `AUTH_CONFIG`, and `InferenceService` injects `CHAT_MODEL`. `ForecastService` calls `InferenceService` only when a request configures inference fields; the pure prompt, schema, and validation code lives in `core/forecast/inference.ts`, and `@di-framework/ai` is imported only by the configuration and the inference service. Application code never calls `new` on a component and never reads bindings outside the configuration class.

`PredictionRepository` and `ObservationRepository` extend `@di-framework/repo`'s `EntityRepository` directly and supply their storage adapters in their constructors. They inherit CRUD operations and define repository-scoped queries. `AccuracyService` coordinates these repositories; controllers access persistence through services. Shared persistence code does not depend on tracking or authentication.

HTTP authentication uses `requireAuthExcept`, `withAuthErrors`, and `applyAuthHeaders`. Protected handlers read the guard-attached principal instead of accepting an identity from request content. Health and login routes bypass the bearer guard; browser approval retains session, origin, and CSRF checks, and token management applies its own `requireAuth` guard. See [authentication documentation](../docs/AUTH.md) for the login flow and credential permissions.

[`cli/bin.ts`](cli/bin.ts) is the bundled npm executable. [`cli/cli.ts`](cli/cli.ts) gathers inputs and calls the Worker for forecasts and backtests; it can also run directly during development. The repository's `index.ts` retains the `bun start` convenience command. See the [forecast API](../docs/FORECAST-API.md) and [roadmap formats](../docs/ROADMAP-FORMATS.md) for request contracts and configuration.

Tests live beside the behavior they verify. Shared test helpers and fixtures live in the repository-root `test/` directory; migrations and historical datasets live in root-level `migrations/` and `historical-data/`. File-relative paths from `src/core/<domain>/` and `src/app/repositories/` reach those directories through `../../../`. Repository tests use the production repository classes with disposable in-memory SQLite databases. Bun preloads `test/cloudflare.ts`, which supplies a plain `env` object in place of Worker bindings and a GitHub OIDC double. `test/helpers/accuracy.ts` builds the production `AccuracyService` over a disposable database and binds that database as `env.DB`. `test/helpers/http.ts` re-registers the Worker graph on the global container before each request so the fixture's service, database, and settings are the ones resolved, then calls the exported Worker; `startWorker()` rebuilds the production graph from the fake bindings the same way `main.ts` does, publishing them through the connector first.

Run `bun test`, `bun run typecheck`, `bun run format`, and `bun run lint` from the repository root. `bun run verify-package` builds and exercises the packed CLI under Node.
