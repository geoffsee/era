# era

Estimate work, record predictions, and compare actuals; later runs improve the model.

## Setup

Install [Bun](https://bun.sh), then:

```bash
bun install
```

Put two local extracts in `historical-data/`. `bun test` and `bun start` read them. They stay untracked; the JSON Schemas next to them are part of the repo.

- `pr_token_usage_dataset.json` — agent token totals per pull request. Schema: [`historical-data/pr_token_usage_dataset.schema.json`](historical-data/pr_token_usage_dataset.schema.json).
- `pr_cicd_dataset.json` — GitHub check runs, commit statuses, and the CI wall-clock span for those same pull requests. Schema: [`historical-data/pr_cicd_dataset.schema.json`](historical-data/pr_cicd_dataset.schema.json).

The files join on `pr_number`. Build the token file from Antigravity CLI (`agy`) conversation databases. Build the CI file from the GitHub API. A pull request missing from the CI file counts as zero failed jobs, zero successful jobs, and zero CI seconds.

### `pr_token_usage_dataset.json`

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

Attribute each model step to the pull request active at that `idx`. Steps before the first pull-request boundary go in `orchestration_and_overhead`. The estimator reads only `pull_requests`.

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

`bun start owner/name` reads that repository and prints a markdown table. `GITHUB_PAT` or `GH_TOKEN` needs access to the repository's issues.

The command looks for one open issue whose title contains "roadmap", then reads the lane table, gate table, and issue titles specified in [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md). Put that repository's extracts in `historical-data/` first. The calibration is those pull requests.

The table has three models from `docs/THEORY.md`. The sources are under [Bibliography](#bibliography).

- **Token-threshold** sizes the remaining child issues in tokens. `E_raw` is the sum. `E_eff` is the longest dependency path.
- **SEEAgent** negotiates story points from the historical token scale.
- **ACEM** prices tokens, human review, and CI minutes.

```bash
export GITHUB_PAT=github_pat_...
bun start owner/name
```

`bun test` checks the formulas, the tracker, and the GitHub Action.

## Track accuracy

Rows are keyed by `owner/name`, a subject such as `issue:4` or `pr:12`, a model, and a metric (`tokens`, `story_points`, `usd`, or `cicd_seconds`). The hosted tracker is `https://era-tracker.seemueller.workers.dev`. Set `ERA_API_URL` or `api-url` when the tracker is a different Worker.

The CLI uses a static admin token, because a shell has no GitHub OIDC identity. Set both, or pass `--api` and `--token`:

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

On a machine that deployed the Worker, the token is `API_TOKEN` in `.dev.vars`: `export ERA_API_TOKEN="$(cut -d= -f2 .dev.vars)"`.

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

`bun run deploy` publishes the Worker in `wrangler.jsonc`. Put `API_TOKEN=...` in `.dev.vars` and set the same value with `wrangler secret put API_TOKEN`. That secret is the CLI admin token. Workflows use OIDC and do not need it. Point `ERA_API_URL` and the action's `api-url` at the deployed URL. The OIDC audience is that URL's origin.

## Bibliography

[`docs/THEORY.md`](docs/THEORY.md) formalizes each model from one source. Section 1 follows Smith. Section 2 follows the Bui, Dam, and Hoda preprint of September 17, 2025, arXiv:2509.14483v1. Section 3 follows El-Ramly, arXiv:2608.02582, version 2.

Bui, Thanh-Long, Hoa Khanh Dam, and Rashina Hoda. "An LLM-Based Multi-Agent Framework for Agile Effort Estimation." In *Proceedings of the 2025 40th IEEE/ACM International Conference on Automated Software Engineering (ASE 2025)*, edited by Marcel Böhme and Lingming Zhang, 1032–43. Piscataway, NJ: IEEE, 2025. https://doi.org/10.1109/ASE63991.2025.00090.

El-Ramly, Mohammad. "ACEM: A Cost Estimation Model for Agentic Software Engineering." Preprint, arXiv:2608.02582, version 2, August 4, 2026. https://doi.org/10.48550/arXiv.2608.02582.

Smith, Ryan. "Beyond Story Points: Token-Based Sprint Planning for AI Agents." *Smith Horn Group* (blog), October 27, 2025. https://smithhorngroup.substack.com/p/beyond-story-points-token-based-sprint.
