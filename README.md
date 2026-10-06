# ERA

[![CI](https://github.com/geoffsee/era/actions/workflows/ci.yml/badge.svg)](https://github.com/geoffsee/era/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40era.js%2Fera)](https://www.npmjs.com/package/@era.js/era)

ERA forecasts the cost of the remaining work in a software roadmap from the repository's own history of agent-assisted pull requests, records every forecast, and scores it against what actually happened. Each round of recorded actuals tells you how far each estimator was off and by what factor to correct the next forecast.

## Why ERA

Teams that deliver with coding agents have a measurable history that story points never had: tokens consumed, CI minutes burned, review sessions spent, and dates merged, all per pull request. ERA turns that history into forecasts and keeps the forecasts honest.

- **Grounded in your history.** Every child issue of a roadmap is sized from merged pull requests in the same repository, by hand-picked comparables, by epic cohort, or by the repository median, and the report says which.
- **Three deterministic models and one inferred layer.** Token-threshold sprint sizing, deliberative story-point negotiation, and priced delivery cost come from [the theory notes](docs/THEORY.md). An optional in-context inference layer lets a language model estimate any additional quantity you declare, such as calendar days or review rounds, from the same evidence.
- **Every estimate is a tracked prediction.** Forecasts are recorded per issue, model, and metric. Actuals recorded later produce MAE, MMRE, PRED(0.5), and a correction scale per model, so the deterministic models and the inference model are judged by the same yardstick.
- **Evidence gaps stay visible.** Unpriced costs, parser approximations, and missing observations are listed in every report instead of being silently zeroed.
- **Your roadmap format.** The legacy lane and gate tables, a Markdown table of your own design, or normalized JSON. `era roadmap validate` previews the parsed work and dependencies before anything is estimated.

## How it works

```
 roadmap issue + historical-data/        era CLI (Node)            Cloudflare Worker (Bun + di-framework)
 ─────────────────────────────────  ──►  loads inputs, posts   ──►  parses roadmap, calibrates on history,
 pull-request tokens, CI, reviews        JSON, prints report        estimates, infers, renders, records → D1
```

The CLI only gathers inputs: the roadmap issue from GitHub or a saved snapshot, the local history extracts, and optional configuration. The Worker owns all calculation, calibration, report rendering, and the prediction ledger. No GitHub token or filesystem path reaches the Worker. Authentication supports an operator token, repository-scoped user keys issued through GitHub login, and GitHub Actions OIDC.

## Getting started

### Prerequisites

- Node.js 22 or newer for the published CLI. Bun is needed only to develop ERA itself.
- A GitHub roadmap issue that follows [the requirements](docs/REQUIREMENTS.md), or a saved roadmap snapshot.
- History extracts for the repository in `historical-data/`, built as described in [Historical data](docs/HISTORICAL-DATA.md).
- Access to an ERA tracker. The hosted tracker is `https://era-tracker.seemueller.workers.dev`; [Run your own tracker](#run-your-own-tracker) covers self-hosting.

### Installation

```sh
npm install -g @era.js/era
era --help
```

### Quick start

Sign in once per repository. Login works from headless terminals with `--no-browser`; the CLI saves the repository-scoped key, which expires after 30 days.

```sh
era login --api https://era-tracker.seemueller.workers.dev --repository owner/name
```

Print a forecast for the repository's open roadmap issue. `GITHUB_PAT` or `GH_TOKEN` must be able to read its issues.

```sh
export GITHUB_PAT=github_pat_...
era estimate --repository owner/name
```

Record the forecast, then record actuals as work lands, and score them.

```sh
era record-estimate --repository owner/name --issue 359
era observations --repository owner/name --subject issue:335 --metric tokens --value 120000
era accuracy --repository owner/name
```

`accuracy` prints one row per model and metric with MAE, MMRE, PRED(0.5), and **scale**, the median of actual over predicted. Multiply the next forecast for that model and metric by scale.

Saved snapshots work without GitHub access:

```sh
era estimate --repository owner/name --issue 359 \
  --body roadmap.md --titles titles.json --history historical-data --plan forecast-plan.json
```

### Configuration

`era.config.json` in the working directory, or the file named by `--config`, carries two optional sections.

- **`roadmap`** selects and maps your roadmap format. See [Configurable roadmaps](docs/ROADMAP-FORMATS.md).
- **`inference`** declares additional per-item estimates for the tracker's model to infer in context:

```json
{
  "version": 1,
  "inference": {
    "fields": [
      { "name": "calendarDays", "type": "number", "unit": "days", "minimum": 0,
        "description": "Working days from the first commit to merge" },
      { "name": "risk", "type": "enum", "values": ["low", "medium", "high"],
        "description": "Likelihood that the item slips or is split" }
    ]
  }
}
```

With that section, `era estimate` adds an "In-context inferred estimates" table to the report, one row per remaining item with the model's rationale, and `era record-estimate` records the numeric fields under model `inference:<model id>` so `era accuracy` scores them like any other estimator. Pass issue bodies for saved snapshots with `--descriptions bodies.json`. Field rules and limits are in [the API contract](docs/FORECAST-API.md#in-context-inference).

A **forecast plan** (`--plan`) supplies what history cannot: remaining author blocks per item, named comparable pull requests, acceptance evidence, human activity hours and rates, a future author rate card, and runner billing. Without one, each child is one typical pull-request load with checkpoint-only human labor. See [Forecast plans](docs/REQUIREMENTS.md#forecast-plans).

## GitHub Action

`actions/track-estimate` records predictions and observations from a workflow and posts the accuracy table. In GitHub Actions it authenticates with the workflow's OIDC token, so leave `api-token` empty; the job needs `id-token: write`, and a workflow can only read and write its own repository.

```yaml
permissions:
  id-token: write
  pull-requests: write
steps:
  - uses: geoffsee/era/actions/track-estimate@main
    with:
      mode: sync
      metric: tokens
      value: ${{ steps.usage.outputs.tokens }}
      comment: "true"
      github-token: ${{ github.token }}
```

`mode` is `predict`, `observe`, `accuracy`, or `sync`. `subject` defaults to `pr:<number>` on a pull request, `repository` to the current repository, and `api-url` to the hosted tracker. `records` accepts a JSON array of rows in place of a single `value`. Outputs are `stored`, `report`, and `scales`; the report is also written to the job summary. `.github/workflows/track-estimate.yml` in this repository uses the same action on merged pull requests.

## Run your own tracker

The tracker is a Cloudflare Worker with a D1 database, defined in `wrangler.jsonc`.

```sh
bun install
bun x wrangler d1 migrations apply era-tracker --local
bun run api                      # wrangler dev on http://localhost:8787
```

Set `ERA_API_URL=http://localhost:8787` and `ERA_API_TOKEN` to the `API_TOKEN` in `.dev.vars`, then run the same CLI commands against it. Calculation-only requests store nothing; `record-estimate`, `observations`, and `backtest` write to D1.

To deploy, run `bun run deploy`, set the operator token with `wrangler secret put API_TOKEN`, and point `ERA_API_URL` and the action's `api-url` at the deployed URL. The OIDC audience is that URL's origin. Enable GitHub login for your users by following [the authentication guide](docs/AUTH.md).

In-context inference uses whichever model source the Worker has. `wrangler secret put ANTHROPIC_API_KEY` selects Claude; otherwise the `AI` binding declared in `wrangler.jsonc` serves inference through Workers AI, with no secret required. The model ids are the `ANTHROPIC_MODEL` and `WORKERS_AI_MODEL` vars in `wrangler.jsonc`; the recorded model name carries whichever id answered, so switching models starts a new accuracy series instead of mixing them. Remove the `AI` binding to make the key the only path. Without either source, requests that configure inference receive 503.

## Documentation

| Document | Covers |
| --- | --- |
| [Requirements](docs/REQUIREMENTS.md) | What a tracked repository and its roadmap issue must provide, and forecast plan fields |
| [Configurable roadmaps](docs/ROADMAP-FORMATS.md) | `era.config.json` roadmap formats, normalized JSON, calibration groups, limits |
| [Historical data](docs/HISTORICAL-DATA.md) | The three history extracts, how to build them, and every field |
| [Forecast API](docs/FORECAST-API.md) | Worker endpoints, request and response contracts, in-context inference, errors |
| [Authentication](docs/AUTH.md) | GitHub login, token lifecycle, operator setup |
| [Theory](docs/THEORY.md) | The estimation models and the papers they follow |
| [Source layout](src/README.md) | Code organization and dependency injection wiring |

## Development

```sh
bun install
bun run hooks        # git hooks: typecheck, format, lint on commit; tests on push
bun test
bun run typecheck
bun run lint
bun run format
```

Tests run against disposable in-memory databases and fake Worker bindings; no provider or network is called. `bun run verify-package` builds the CLI, installs the packed tarball under Node, and exercises login, saved credentials, history loading, and roadmap validation. To publish, bump `version` in `package.json`, run `bun install --frozen-lockfile`, `bun test`, `bun run typecheck`, and `bun run verify-package`, then `npm pack` and `npm publish era.js-era-VERSION.tgz --access public`. Publishing requires membership in the `era.js` npm organization.

## Contributing

Issues and pull requests are welcome at [geoffsee/era](https://github.com/geoffsee/era). Before opening a pull request, run the development checks above; CI runs the same suite plus `verify-package`. Keep forecasts reproducible: deterministic calculation lives on the Worker, provider calls stay behind the inference service, and new estimators should record predictions so the accuracy tracker can score them.

## Community

- **Issues and discussions:** [GitHub](https://github.com/geoffsee/era/issues)
- **Hosted tracker:** `https://era-tracker.seemueller.workers.dev`

## Code of Conduct

This project follows the [CNCF Code of Conduct](https://github.com/cncf/foundation/blob/main/code-of-conduct.md).

## Security

Report vulnerabilities privately through [GitHub security advisories](https://github.com/geoffsee/era/security/advisories/new) rather than public issues. The tracker never persists prompts, provider replies, GitHub tokens, or roadmap snapshots; see [the API contract](docs/FORECAST-API.md) for what each endpoint stores.

## License

The repository does not yet carry a license file, and the npm package is published as `UNLICENSED`. Contact the maintainer before reusing the code.

## References

[`docs/THEORY.md`](docs/THEORY.md) formalizes each model from one source. Section 1 follows Smith. Section 2 follows the Bui, Dam, and Hoda preprint of September 17, 2025, arXiv:2509.14483v1. Section 3 follows El-Ramly, arXiv:2608.02582, version 2.

Bui, Thanh-Long, Hoa Khanh Dam, and Rashina Hoda. "An LLM-Based Multi-Agent Framework for Agile Effort Estimation." In *Proceedings of the 2025 40th IEEE/ACM International Conference on Automated Software Engineering (ASE 2025)*, edited by Marcel Böhme and Lingming Zhang, 1032–43. Piscataway, NJ: IEEE, 2025. https://doi.org/10.1109/ASE63991.2025.00090.

El-Ramly, Mohammad. "ACEM: A Cost Estimation Model for Agentic Software Engineering." Preprint, arXiv:2608.02582, version 2, August 4, 2026. https://doi.org/10.48550/arXiv.2608.02582.

Smith, Ryan. "Beyond Story Points: Token-Based Sprint Planning for AI Agents." *Smith Horn Group* (blog), October 27, 2025. https://smithhorngroup.substack.com/p/beyond-story-points-token-based-sprint.
