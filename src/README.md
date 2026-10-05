# Source layout

| Directory | Purpose |
| --- | --- |
| `app/` | Worker entry point, HTTP dispatch, and dependency composition |
| `auth/` | GitHub login, credentials, scoped access, OIDC, and authentication storage |
| `cli/` | Installed executable and command orchestration |
| `forecast/` | Estimation, cost accounting, calibration validation, forecast plans, reports, and forecast API |
| `roadmap/` | Roadmap parsing, configurable formats, normalization, and dependency graphs |
| `history/` | Historical usage model and dataset loading |
| `usage/` | Author-session and review usage extraction and attribution |
| `github/` | GitHub client and issue/roadmap retrieval |
| `tracking/` | Predictions, observations, accuracy scoring, backtests, and ledger repositories |
| `persistence/` | Shared database contracts, SQLite repository, and SQL adapters |

Tests live beside the behavior they verify. Integration tests may exercise several domains.
Dependency registration belongs in `app/composition.ts`; controllers receive services and services receive repositories through constructor injection. Domain repositories own their queries; shared persistence code has no dependency on tracking or authentication.

`app/worker.ts` is the Worker entry point. `cli/bin.ts` is the bundled npm executable; `cli/cli.ts` can also run directly during development. The root `index.ts` retains the `bun start` convenience command.
