# Source layout

| Directory | Purpose |
| --- | --- |
| `app/` | Worker entry point, HTTP dispatch, and dependency composition |
| `app/repositories` | Prediction and observation repositories, authentication storage, and historical/GitHub data access |
| `app/services` | Authentication, forecasting, and accuracy application services |
| `app/controllers` | Authentication, forecast, and tracking HTTP handlers |
| `core/auth` | GitHub login, credentials, scoped access, and OIDC |
| `cli/` | Installed executable and command orchestration |
| `core/forecast` | Estimation, cost accounting, calibration validation, forecast plans, and reports |
| `core/roadmap` | Roadmap parsing, configurable formats, normalization, and dependency graphs |
| `core/history` | Historical usage model and dataset tests |
| `core/usage` | Author-session and review usage extraction and attribution |
| `core/github` | GitHub API client |
| `core/tracking` | Predictions, observations, accuracy scoring, and backtests |
| `core/persistence` | Shared database contracts, SQL adapters, and schema initialization |

Tests live beside the behavior they verify. Integration tests may exercise several domains.
Request-specific dependency registration belongs at the Worker and HTTP entry points; controllers receive services and services receive repositories through constructor injection. Domain repositories own their queries; shared persistence code has no dependency on tracking or authentication.

`app/worker.ts` is the Worker entry point. `cli/bin.ts` is the bundled npm executable; `cli/cli.ts` can also run directly during development. The root `index.ts` retains the `bun start` convenience command.

PredictionRepository and ObservationRepository extend @di-framework/repo EntityRepository directly and supply their storage adapters in their constructors. CRUD is inherited; only repository-scoped queries are application-defined. AccuracyService coordinates the two repositories. Tests exercise these same classes against disposable in-memory SQLite databases.
