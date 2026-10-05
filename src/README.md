# Source layout

| Directory | Purpose |
| --- | --- |
| `app/` | Worker entry point, HTTP dispatch, and dependency composition |
| `repositories/` | Ledger repositories, authentication storage, historical and GitHub data access, and the SQLite repository base |
| `services/` | Authentication, forecasting, and accuracy application services |
| `controllers/` | Authentication, forecast, and tracking HTTP handlers |
| `auth/` | GitHub login, credentials, scoped access, and OIDC |
| `cli/` | Installed executable and command orchestration |
| `forecast/` | Estimation, cost accounting, calibration validation, forecast plans, and reports |
| `roadmap/` | Roadmap parsing, configurable formats, normalization, and dependency graphs |
| `history/` | Historical usage model and dataset tests |
| `usage/` | Author-session and review usage extraction and attribution |
| `github/` | GitHub API client |
| `tracking/` | Predictions, observations, accuracy scoring, and backtests |
| `persistence/` | Shared database contracts and SQL adapters |

Tests live beside the behavior they verify. Integration tests may exercise several domains.
Dependency registration belongs in `app/composition.ts`; controllers receive services and services receive repositories through constructor injection. Domain repositories own their queries; shared persistence code has no dependency on tracking or authentication.

`app/worker.ts` is the Worker entry point. `cli/bin.ts` is the bundled npm executable; `cli/cli.ts` can also run directly during development. The root `index.ts` retains the `bun start` convenience command.
