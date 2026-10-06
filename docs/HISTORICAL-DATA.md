# Historical data

ERA calibrates every forecast on the repository's own history: agent token usage per pull request, the CI runs on those pull requests, and optionally the review sessions that touched them. This page specifies the three local extract files, how to build them, and what each field means. The forecast report lists missing evidence as cost gaps rather than treating it as zero.

Put the extracts in `historical-data/` at the repository root. They stay untracked; the JSON Schemas next to them are part of the repo. Tests use synthetic fixtures without these files and automatically enable two additional local-extract checks when both required files exist.

| File | Required | Built from | Schema |
| --- | --- | --- | --- |
| `pr_token_usage_dataset.json` | Yes | Antigravity CLI (`agy`) conversation databases | [`pr_token_usage_dataset.schema.json`](../historical-data/pr_token_usage_dataset.schema.json) |
| `pr_cicd_dataset.json` | Yes | GitHub check runs and commit statuses | [`pr_cicd_dataset.schema.json`](../historical-data/pr_cicd_dataset.schema.json) |
| `pr_review_dataset.json` | Optional | Local Codex review sessions | [`pr_review_dataset.schema.json`](../historical-data/pr_review_dataset.schema.json) |

The files join on `pr_number`. Missing CI rows retain an observation flag and are excluded from CI calibration; missing spans do not establish free compute. Missing review joins are evidence gaps, not observations of zero review effort.

## Building the extracts

### Author tokens and CI

```bash
bun src/core/usage/extract-agy-usage.ts owner/name
```

The command reads `~/.gemini/antigravity-cli` and writes both `pr_token_usage_dataset.json` and `pr_cicd_dataset.json`. A conversation counts when its workspace path contains the repository name, and so does every subagent it spawned. Each model step is attributed to the pull request selected by a `gh pr` command, a `git checkout` of that pull request's head branch, the `On branch` line printed by those commands, or a subagent task that names exactly one pull request. Steps before the first of those boundaries stay in `orchestration_and_overhead`. A pull request whose head SHA is already in `pr_cicd_dataset.json` keeps that CI row. A new head SHA is read from the GitHub API. `gh` has to be authenticated.

### Review sessions

```bash
bun src/core/usage/extract-codex-review.ts owner/name
```

The extractor reads `~/.codex/state_*.sqlite` and the session rollouts for that `owner/name`. A session counts when its title or first message asks for a pull-request review, or asks to address review comments. Spawned subagents inherit that role. Tokens are the last thread usage record. Pull request numbers come from the request (`PR #N`, `**#N**`, or a pull URL) and from `gh pr` commands the session actually ran. A session that names several pull requests is split evenly across them. Review CI is the wall-clock span of completed GitHub Actions runs on earlier SHAs of that pull request's head branch that start during one of those sessions. The final head SHA stays in the CI file when that file already has the pull request. `gh` has to be authenticated for the CI pass. If it is not, the token rows are still written and the gap is recorded on the file.

When a reviewed pull request is also in the author-token extract, the forecast uses the median review tokens per author token. When the reviewed pull requests are newer than that extract, each remaining child is charged the median review load of those pull requests instead. Rebuild the author-token extract to replace that median with the ratio.

## `pr_token_usage_dataset.json`

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

## `pr_cicd_dataset.json`

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

## Loading history into the tracker

`era ingest-history --repository owner/name --dir historical-data` records each merged pull request's token total as an observation with subject `pr:N`, so backtests and later estimates have actuals to score against. `era backtest --repository owner/name --dir historical-data` runs the leave-one-out repository-median baseline on the Worker and records it.
