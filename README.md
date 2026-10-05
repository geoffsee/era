# era

Estimate work, record predictions, and compare actuals; later runs improve the model.

## Setup

Install the CLI with Node.js 22 or newer:

```sh
npm install -g @era.js/era
era --help
era login --api https://your-worker --repository owner/name
```

Use `--no-browser` for headless login. See [authentication setup](docs/AUTH.md) for Worker configuration and token management. The published CLI runs on Node.js and includes its dependencies; Bun is needed only for repository development.

To develop from source, install [Bun](https://bun.sh), then:

```bash
bun install
bun run hooks
```

### Publishing the CLI

Update `version` in `package.json`, then run:

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run verify-package
npm pack
npm publish era.js-era-VERSION.tgz --access public
```

`verify-package` installs the packed artifact with npm into a disposable directory and runs the CLI under Node, including headless login, saved credentials, historical file loading and logout. Only the bundled CLI, documentation and historical JSON Schemas are included. Publishing requires membership in the `era.js` npm organization and npm's configured authentication requirements.

Put two local extracts in `historical-data/` for estimation. They stay untracked; the JSON Schemas next to them are part of the repo. Tests use synthetic fixtures without these files, and automatically enable two additional local-extract checks when both files exist.

- `pr_token_usage_dataset.json` — agent token totals per pull request. Schema: [`historical-data/pr_token_usage_dataset.schema.json`](historical-data/pr_token_usage_dataset.schema.json).
- `pr_cicd_dataset.json` — GitHub check runs, commit statuses, and the CI wall-clock span for those same pull requests. Schema: [`historical-data/pr_cicd_dataset.schema.json`](historical-data/pr_cicd_dataset.schema.json).

The files join on `pr_number`. Build the token file from Antigravity CLI (`agy`) conversation databases. Build the CI file from the GitHub API. Missing CI rows retain an observation flag and are excluded from CI calibration; missing spans do not establish free compute.

`pr_review_dataset.json` is optional. Build it from local Codex sessions. Missing review joins are evidence gaps, not observations of zero review effort. Schema: [`historical-data/pr_review_dataset.schema.json`](historical-data/pr_review_dataset.schema.json).

```bash
bun src/extract-codex-review.ts owner/name
```

The extractor reads `~/.codex/state_*.sqlite` and the session rollouts for that `owner/name`. A session counts when its title or first message asks for a pull-request review, or asks to address review comments. Spawned subagents inherit that role. Tokens are the last thread usage record. Pull request numbers come from the request (`PR #N`, `**#N**`, or a pull URL) and from `gh pr` commands the session actually ran. A session that names several pull requests is split evenly across them. Review CI is the wall-clock span of completed GitHub Actions runs on earlier SHAs of that pull request's head branch that start during one of those sessions. The final head SHA stays in the CI file when that file already has the pull request. `gh` has to be authenticated for the CI pass. If it is not, the token rows are still written and the gap is recorded on the file.

When a reviewed pull request is also in the author-token extract, the forecast uses the median review tokens per author token. When the reviewed pull requests are newer than that extract, each remaining child is charged the median review load of those pull requests instead. Rebuild the author-token extract to replace that median with the ratio.

### `pr_token_usage_dataset.json`

Build both extracts with:

```bash
bun src/extract-agy-usage.ts owner/name
```

The command reads `~/.gemini/antigravity-cli`. A conversation counts when its workspace path contains the repository name, and so does every subagent it spawned. Each model step is attributed to the pull request selected by a `gh pr` command, a `git checkout` of that pull request's head branch, the `On branch` line printed by those commands, or a subagent task that names exactly one pull request. Steps before the first of those boundaries stay in `orchestration_and_overhead`. A pull request whose head SHA is already in `pr_cicd_dataset.json` keeps that CI row. A new head SHA is read from the GitHub API. `gh` has to be authenticated.

`agy` writes one SQLite database per conversation under `~/.gemini/antigravity-cli/conversations/<conversation_id>.db`. The index is `~/.gemini/antigravity-cli/conversation_summaries.db`.

List the repository's pull requests, then the conversations whose workspace is that checkout:

```bash
gh pr list --repo OWNER/REPO --state all --limit 150 \
  --json number,title,headRefName,createdAt,mergedAt,closedAt,state,url
```

```sql
SELECT conversation_id, title, step_count
FROM conversation_summaries
WHERE workspace_uris LIKE '%REPO%';
```

On each conversation database, tool steps mark when the session changed pull request. Model steps carry the token counts:

```sql
SELECT idx, quote(step_payload) FROM steps WHERE step_type = 132;
SELECT idx, hex(metadata) FROM steps WHERE step_type = 15 AND metadata IS NOT NULL;
```

`step_type` 132 is a tool call. Walk those payloads in `idx` order and split the timeline on `git checkout`, `gh pr view`, `gh pr diff`, `gh pr checks`, `gh pr merge`, commit messages, and subagent prompts. `step_type` 15 is a model response. Its `metadata` blob is Protobuf: field 1 is uncached prompt tokens, field 5 is prompt-cache reads, field 3 is completion tokens, and field 6 is extended thinking tokens. The same blob names the model.

Attribute each model step to the pull request active at that `idx`. Steps before the first pull-request boundary go in `orchestration_and_overhead`. The estimator allocates that overhead separately, using its own token mix and ratio to all PR-attributed author usage, once per forecast.

For each rollup, sum those model steps:

- `agent_turns_count` is the number of `step_type` 15 rows.
- `uncached_input_tokens` sums Protobuf field 1.
- `cache_read_input_tokens` sums Protobuf field 5.
- `output_tokens` sums field 3 and field 6. Thinking tokens are already inside this sum.
- `thinking_tokens` is field 6, so it is less than or equal to `output_tokens`.
- `total_input_tokens` = `uncached_input_tokens` + `cache_read_input_tokens`.
- `total_tokens` = `total_input_tokens` + `output_tokens`.
- `models_used` lists the distinct model ids, or `[]` when the pull request has no turns and no tokens.
- `state` is `MERGED` when `merged_at` is set, otherwise `OPEN` or `CLOSED`.

`metadata.repository` is `owner/name`. `total_prs_tracked` is `pull_requests.length`. `prs_with_token_activity` counts pull requests with tokens or turns. `total_agent_turns` and `total_tokens_consumed` add orchestration on top of the pull requests. `generated_at` is when the file was written.

### `pr_cicd_dataset.json`

A JSON array, one object per pull request, using the same `pr_number` values as the token file.

List pull requests with `state=all`:

```bash
gh api --paginate "/repos/OWNER/REPO/pulls?state=all&per_page=100"
```

GitHub reports a merged pull request as `closed`. Store `state` as `MERGED` when `merged_at` is set, and uppercase the GitHub state otherwise. `author` is `user.login`, `head_branch` is `head.ref`, `head_sha` is `head.sha`, and `url` is `html_url`.

`jobs` are the checks on `head_sha`.

Check runs come from `GET /repos/OWNER/REPO/commits/HEAD_SHA/check-runs` (`check_runs` in the response). For each run:

- `type` is `CheckRun`.
- `name`, `started_at`, `completed_at`, and `details_url` are copied from the check run.
- `status` and `conclusion` are uppercased.
- `workflow` is the Actions workflow name when `details_url` matches `/actions/runs/{run_id}/job/{job_id}`. Read `name` from `GET /repos/OWNER/REPO/actions/runs/{run_id}`. A check run whose `details_url` is not an Actions job uses `External / Unspecified`.

Commit statuses come from `GET /repos/OWNER/REPO/commits/HEAD_SHA/status` (`statuses`). For each status:

- `type` is `StatusContext` and `workflow` is `Status Context`.
- `name` is `context`. `conclusion` is `state`, uppercased. `status` is `COMPLETED`.
- `started_at` is null. `completed_at` is `updated_at`. `details_url` is `target_url`.

`duration_seconds` is `(completed_at - started_at)` in whole seconds when both timestamps exist and the difference is zero or positive. Leave it null when a timestamp is missing or the job completed before it started. A skipped job can do that.

`cicd_summary` counts those jobs:

| Field | Rule |
| --- | --- |
| `successful_jobs_count` | conclusion `SUCCESS` |
| `failed_jobs_count` | conclusion `FAILURE` |
| `cancelled_jobs_count` | conclusion `CANCELLED` |
| `skipped_or_neutral_count` | `SKIPPED`, `NEUTRAL`, or `PENDING` |
| `total_jobs_count` | `jobs.length`, including any other conclusion |
| `overall_status` | `FAILURE` when `failed_jobs_count` is greater than 0, otherwise `SUCCESS` |
| `earliest_job_started_at` | earliest `started_at` |
| `latest_job_completed_at` | latest `completed_at` among jobs that have `started_at` |
| `total_cicd_duration_seconds` | that span, in whole seconds |
| `pr_created_to_cicd_completed_seconds` | `latest_job_completed_at` minus `created_at`, in whole seconds |
| `time_to_merge_seconds` | `merged_at` minus `created_at`, in whole seconds, or null when `merged_at` is null |

`total_cicd_duration_seconds` is the wall-clock span from the first start to the last completion. The estimator reads `failed_jobs_count`, `successful_jobs_count`, and `total_cicd_duration_seconds`.

Formatted duration strings are display-only: `37s` under a minute, `6m 23s` under an hour, and `1h 2m 3s` after that. Seconds are always included, including `0s` and `6m 0s`.

Live roadmap lookup uses `GITHUB_PAT` or `GH_TOKEN`.

## Print an estimate

`bun start owner/name` collects a roadmap snapshot and historical usage, sends them to the Worker, and prints its Markdown report. `GITHUB_PAT` or `GH_TOKEN` needs access to the repository's issues; `ERA_API_URL` and `ERA_API_TOKEN` select and authenticate the Worker. The CLI loads inputs; calculation, calibration, report generation, backtesting and prediction generation run on the Worker.

The command looks for one open issue whose title contains "roadmap", or accepts an explicit issue number (`bun start owner/name 359 forecast-plan.json`). It reads the lane table, gate table, and issue titles specified in [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md). Put that repository's extracts in `historical-data/` first; their repository identity must match the target. Both `C` and `G` gate IDs are supported. Milestone references are preserved, with diagnostics for their approximation in the issue-level graph.

The table has three models from `docs/THEORY.md`. The sources are under [Bibliography](#bibliography).

- **Token-threshold** sizes the remaining child issues in tokens. `E_raw` is the sum. `E_eff` is the longest dependency path.
- **SEEAgent** negotiates story points from the historical token scale.
- **Delivery costs** add disjoint author token categories, shared orchestration, review usage, supplied human activities, and explicitly billable runner quantities. The result is a priced subtotal with named unpriced costs, not a full cash budget. The legacy ACEM RF/CF formula remains a diagnostic outside this subtotal because historical consumption already includes retries and context.

```bash
export GITHUB_PAT=github_pat_...
export ERA_API_URL=https://era-tracker.seemueller.workers.dev
export ERA_API_TOKEN=...
bun start owner/name
```

`bun test` checks the formulas, the tracker, and the GitHub Action.

The read-only estimate command can use a saved snapshot without GitHub access. It still calls the authenticated Worker and requires API configuration:

```bash
bun src/cli.ts estimate --repository geoffsee/rubix-kube --issue 359 \
  --body test/fixtures/roadmap-359.md --titles test/fixtures/roadmap-359-titles.json \
  --history historical-data --plan test/fixtures/roadmap-359-central-plan.json
```

The example plan records 25 assumed author blocks and 108 assumed human hours from the issue comment. It is an illustrative scenario, not measured effort or a confidence interval. [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md#forecast-plans) documents plan fields: remaining quantities, named comparable PRs, acceptance evidence, human activity hours/rates, future author rate cards and runner billing. Without a plan each child uses one typical historical PR load and checkpoint-only human labor; the report keeps all remaining gaps visible.

Prices apply the observed fresh/cache-read/output mix under a dated future model assumption. Output already contains reasoning. The historical extract aggregates multiple models, so repricing it does not reconstruct historical invoices. Cache writes, live hosts, soak occupancy and account-specific billing remain gaps until their quantities and terms are available. Public repository visibility alone does not establish that every runner is free.

The report also compares repository-median and epic-median token baselines chronologically: training includes only PRs merged before the target PR's creation, with at least three training samples and at least three epic peers before using an epic median. Missing dates and warmup exclusions are counted. This is retrospective evaluation of final extracts; it does not validate named comparable-PR plans, actual dollars, or immutable prospective predictions. The reconstructed story-point scores are labeled separately. Freeze prospective forecasts before work and collect actual billing and human-effort receipts to validate delivery cost.

## Track accuracy

Forecast operations use `POST /v1/estimates`: `estimate` calculates without saving ledger rows, while `record-estimate` asks the Worker to calculate and record its generated predictions. The backtest command uses `POST /v1/backtests` to calculate and record on the Worker. Both endpoints accept normalized history plus repository identity; the estimate endpoint also accepts the roadmap snapshot and optional plan. No GitHub token or filesystem path is sent to the Worker. See [the API contract](docs/FORECAST-API.md).

Rows are keyed by `owner/name`, a subject such as `issue:4` or `pr:12`, a model, and a metric (`tokens`, `story_points`, `usd_subtotal`, or `cicd_seconds`). New delivery-cost predictions use model `delivery-cost-v2` and metric `usd_subtotal`; legacy `acem`/`usd` rows remain separate. The hosted tracker is `https://era-tracker.seemueller.workers.dev`. Set `ERA_API_URL` or `api-url` when the tracker is a different Worker.

Users sign in through GitHub and receive a repository-scoped ERA token:

```bash
bun src/cli.ts login --api https://era-tracker.seemueller.workers.dev --repository owner/name
bun src/cli.ts accuracy --repository owner/name
```

The CLI saves the credential automatically. Login works from SSH/headless terminals using the printed verification URL and code. GitHub write access and a selected ERA GitHub App installation are required. Keys expire after 30 days; `tokens`, `revoke-token` and `logout` manage them. See [authentication and operator setup](docs/AUTH.md) for the required Worker configuration and migration.

Explicit API credentials override saved login. The operator can set both, or pass `--api` and `--token`:

```bash
export ERA_API_URL=https://era-tracker.seemueller.workers.dev
export ERA_API_TOKEN=...

bun src/cli.ts predictions \
  --repository owner/name \
  --subject issue:1 \
  --model token-threshold \
  --metric tokens \
  --value 100

bun src/cli.ts observations \
  --repository owner/name \
  --subject issue:1 \
  --metric tokens \
  --value 120

bun src/cli.ts accuracy --repository owner/name
```

The operator's `ERA_API_TOKEN` is the matching Worker `API_TOKEN` secret. Normal user keys are issued through login.

`accuracy` prints MAE, MMRE, and PRED(0.5). **Scale** is the median of actual / predicted. Multiply the next forecast for that model and metric by scale.

Other commands:

```bash
bun src/cli.ts repositories
bun src/cli.ts ingest-history --repository owner/name --dir historical-data
bun src/cli.ts backtest --repository owner/name --dir historical-data
bun src/cli.ts record-estimate --repository owner/name
```

`record-estimate` reads the open roadmap issue for `owner/name` and stores one prediction per child issue. Offline, pass `--body roadmap.md --titles titles.json --history historical-data`. `titles.json` maps issue numbers to titles. `bun src/cli.ts help` lists the flags.

## GitHub Action

Add `actions/track-estimate` to the repository you want to score. In GitHub Actions it uses that workflow's OIDC token. Leave `api-token` empty. The job needs `id-token: write`. A workflow can only read and write its own `owner/name`.

`github.token` is used only when `comment` is true, to post the accuracy table on the pull request.

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

`mode` is `predict`, `observe`, `accuracy`, or `sync`. `sync` stores `value` when it is set, then prints accuracy. `subject` defaults to `pr:<number>` on a pull request. `repository` defaults to the repository running the workflow. `api-url` defaults to the hosted tracker. Set `api-url` to another Worker when you run your own.

`records` replaces the single `value` with a JSON array. Each object has `kind` (`prediction` or `observation`), `subject`, `metric`, and `value`. Predictions also have `model`.

Outputs are `stored`, `report` (markdown), and `scales` (JSON). The same markdown is written to the job summary.

`.github/workflows/track-estimate.yml` in this repository is the same action, called with `uses: ./actions/track-estimate` because the workflow sits next to the action. It runs on merged pull requests and on `workflow_dispatch`.

## Run your own tracker

```bash
bun run api
```

For local forecast testing, set `ERA_API_URL=http://localhost:8787` and `ERA_API_TOKEN` to the local `API_TOKEN`, then run the same CLI commands. The Worker uses its configured D1 binding for recorded predictions and observations; calculation-only requests do not store the supplied snapshot or history. Estimation requires the Worker version with `/v1/estimates`, so deploy that version before using the new CLI against an existing hosted tracker.

`bun run deploy` publishes the Worker in `wrangler.jsonc`. Put `API_TOKEN=...` in `.dev.vars` and set the same value with `wrangler secret put API_TOKEN`. That secret is the operator admin token. Workflows use OIDC and do not need it. Point `ERA_API_URL` and the action's `api-url` at the deployed URL. The OIDC audience is that URL's origin. Apply the auth migration and configure the GitHub App and secrets from [the login setup guide](docs/AUTH.md) to enable user onboarding.

## Bibliography

[`docs/THEORY.md`](docs/THEORY.md) formalizes each model from one source. Section 1 follows Smith. Section 2 follows the Bui, Dam, and Hoda preprint of September 17, 2025, arXiv:2509.14483v1. Section 3 follows El-Ramly, arXiv:2608.02582, version 2.

Bui, Thanh-Long, Hoa Khanh Dam, and Rashina Hoda. "An LLM-Based Multi-Agent Framework for Agile Effort Estimation." In *Proceedings of the 2025 40th IEEE/ACM International Conference on Automated Software Engineering (ASE 2025)*, edited by Marcel Böhme and Lingming Zhang, 1032–43. Piscataway, NJ: IEEE, 2025. https://doi.org/10.1109/ASE63991.2025.00090.

El-Ramly, Mohammad. "ACEM: A Cost Estimation Model for Agentic Software Engineering." Preprint, arXiv:2608.02582, version 2, August 4, 2026. https://doi.org/10.48550/arXiv.2608.02582.

Smith, Ryan. "Beyond Story Points: Token-Based Sprint Planning for AI Agents." *Smith Horn Group* (blog), October 27, 2025. https://smithhorngroup.substack.com/p/beyond-story-points-token-based-sprint.
