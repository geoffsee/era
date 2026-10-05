# Source layout

Source is grouped into `app/` for the Worker application, `core/` for domain logic and shared integrations, and `cli/` for the npm command-line client.

| Directory | Purpose |
| --- | --- |
| `app/controllers/` | Authentication, forecast, and tracking HTTP handlers |
| `app/services/` | Login and token management, forecast validation and calculation, and accuracy orchestration |
| `app/repositories/` | Prediction and observation repositories, authentication storage, and historical/GitHub data access |
| `core/auth/` | Credential strategy, repository authorization, GitHub OIDC verification, CLI login, and local credential storage |
| `core/forecast/` | Estimation, cost accounting, calibration validation, forecast plans, API contracts, and reports |
| `core/roadmap/` | Roadmap parsing, configurable formats, normalization, and dependency graphs |
| `core/history/` | Historical usage models and dataset validation tests |
| `core/usage/` | Author-session and review usage extraction and attribution |
| `core/github/` | GitHub API client |
| `core/tracking/` | Prediction and observation models, accuracy scoring, and backtests |
| `core/persistence/` | Shared database contracts, SQL adapters, and forecast schema initialization |
| `cli/` | Installed executable and command orchestration |

[`app/main.ts`](app/main.ts) handles Worker requests and scheduled authentication cleanup. It registers the database binding with the runtime container and initializes services. [`app/http.ts`](app/http.ts) resolves controllers and configures HTTP authentication and dispatch. Controllers receive services through constructor injection. `AccuracyService` receives prediction and observation repositories through constructor injection; the Worker constructs `AuthService` with its store and environment configuration.

`PredictionRepository` and `ObservationRepository` extend `@di-framework/repo`'s `EntityRepository` directly and supply their storage adapters in their constructors. They inherit CRUD operations and define repository-scoped queries. `AccuracyService` coordinates these repositories; controllers access persistence through services. Shared persistence code does not depend on tracking or authentication.

HTTP authentication uses `requireAuthExcept`, `withAuthErrors`, and `applyAuthHeaders`. Protected handlers read the guard-attached principal instead of accepting an identity from request content. Health and login routes bypass the bearer guard; browser approval retains session, origin, and CSRF checks, and token management applies its own `requireAuth` guard. See [authentication documentation](../docs/AUTH.md) for the login flow and credential permissions.

[`cli/bin.ts`](cli/bin.ts) is the bundled npm executable. [`cli/cli.ts`](cli/cli.ts) gathers inputs and calls the Worker for forecasts and backtests; it can also run directly during development. The repository's `index.ts` retains the `bun start` convenience command. See the [forecast API](../docs/FORECAST-API.md) and [roadmap formats](../docs/ROADMAP-FORMATS.md) for request contracts and configuration.

Tests live beside the behavior they verify. Shared test helpers and fixtures live in the repository-root `test/` directory; migrations and historical datasets live in root-level `migrations/` and `historical-data/`. File-relative paths from `src/core/<domain>/` and `src/app/repositories/` reach those directories through `../../../`. Repository tests use the production repository classes with disposable in-memory SQLite databases.

Run `bun test`, `bun run typecheck`, `bun run format`, and `bun run lint` from the repository root. `bun run verify-package` builds and exercises the packed CLI under Node.
