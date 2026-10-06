# Configurable roadmaps

ERA can read your own Markdown table or a normalized JSON export. The Worker converts the source into work items and execution dependencies before forecasting. The CLI sends the source and declarative configuration; the API uses the same adapters.

Create `era.config.json` in your current working directory, or pass `--config path/to/config.json`. An explicitly selected file overrides discovery. Configuration errors fail visibly. With no configuration, ERA uses the existing `legacy` preset, preserving its lane/gate tables, title conventions, completed-lane handling and forecasts. The same file may carry an `inference` section for [model-inferred estimates](FORECAST-API.md#in-context-inference); either section may appear alone.

```json
{
  "version": 1,
  "roadmap": {
    "format": "markdown-table",
    "section": "Delivery plan",
    "columns": {
      "issues": "Tickets",
      "title": "Description",
      "group": "Workstream",
      "state": "Status",
      "dependencies": "Blocked by"
    },
    "states": { "Todo": "planned", "Doing": "active", "Done": "complete" },
    "issueReferences": "github"
  }
}
```

```markdown
# Delivery plan

| Workstream | Description | Tickets | Status | Blocked by |
| --- | --- | --- | --- | --- |
| Platform | Storage interface | #12 | Done | — |
| Platform | Storage adapter | #13 | Doing | #12 |
| Release | Release qualification | #14 | Todo | #13 |
```

Columns may appear in any order. Names match trimmed table headings exactly. `section` selects a Markdown heading and its subsections; omit it when there is one matching table. Fenced examples are ignored. Multiple matching tables, duplicate headings, missing mapped columns and malformed rows are errors. Escaped pipes and pipes inside inline code are supported. This adapter reads Markdown pipe tables, not arbitrary prose or HTML tables.

## Validate before estimating

```sh
era roadmap validate --repository owner/name --body roadmap.md

era estimate --repository owner/name --body roadmap.md --history historical-data
```

Both commands use the current directory's `era.config.json`. Validation authenticates to ERA, returns JSON containing normalized items, milestones, expanded execution dependencies and diagnostics, and needs no historical usage or forecast plan. It records nothing. Estimation requires historical usage as before. `record-estimate` also requires the real roadmap `--issue` number.

For GitHub issue input, pass `--issue 123` and omit `--body`. GitHub issue collection still requires `GH_TOKEN` or `GITHUB_PAT`; select an issue explicitly when its title does not contain “Roadmap”. For a local custom table, include a mapped title column or supply `--titles titles.json`, a JSON object mapping issue numbers to titles. The normalized JSON format carries its own titles and needs no separate titles file.

## Table mapping fields

Only `columns.issues` is required. Other fields are optional, but every configured heading must exist.

| Field | Meaning |
| --- | --- |
| `issues` | One or more local GitHub references, such as `#12, #13`. |
| `title` | Delivery title; otherwise use the supplied GitHub title map. |
| `group` | Arbitrary workstream name; absent groups use `ungrouped`. |
| `state` | `planned`, `active`, `complete`, or a value explicitly mapped through `states`. |
| `dependencies` | Issues that must precede every issue in this row. |
| `parent` | One parent epic reference. The parent must be included as an epic item. |
| `kind` | `work` or `epic`, or a value explicitly mapped through `kinds`. Defaults to `work`. |
| `calibrationGroup` | Named historical comparison group, such as `storage`. |
| `acceptance` | An explicit acceptance source or attestation for delivery work, such as `Accepted review in PR #40`. |

Reference cells accept `#N` references separated by commas, semicolons or whitespace. Blank, `-` and `—` cells mean none. Ranges, arrows, external repository references and arbitrary expressions are rejected; use the dependencies column to express ordering. For tables, use names rather than numeric calibration group strings.

A “Done” status alone does not remove custom-format work from the estimate. ERA emits a diagnostic and still estimates its load until explicit acceptance evidence is supplied in the roadmap or forecast plan. Blank or dash acceptance cells do not count as evidence. Epic tracker acceptance does not accept its children. Contradictory forecast-plan work and roadmap acceptance are rejected.

## Normalized JSON

Use this configuration for exporters or formats handled by your own tooling:

```json
{ "version": 1, "roadmap": { "format": "normalized-json" } }
```

Then pass `--body roadmap.json`. For example:

```json
{
  "version": 1,
  "items": [
    { "issue": 10, "title": "Storage delivery", "kind": "epic" },
    { "issue": 12, "title": "Storage interface", "parent": 10 },
    { "issue": 13, "title": "Storage adapter", "parent": 10 },
    { "issue": 14, "title": "Release qualification" }
  ],
  "dependencies": [{ "before": 12, "after": 13 }],
  "milestones": [{ "id": "storage-ready", "requires": [10], "unlocks": [14] }]
}
```

Items require positive GitHub issue numbers and titles. Optional fields are `kind`, `state`, `group`, `parent`, `calibrationGroup` and `acceptance: {"source": "..."}`. Kind defaults to `work`; state defaults to `planned`. Dependencies and milestones default to empty arrays. Milestone requirements/unlocks are issue references; epic references expand through their delivery children. These milestones are whole-issue barriers, not partial completion phases. Terminal milestones may have an empty `unlocks` list.

Custom adapters never infer epic membership from titles. Explicit parent relationships control dependency expansion. Group membership controls grouping; it does not establish ordering or historical similarity. Missing dependencies produce a diagnostic and parallel critical-path treatment. Unknown references, parent cycles, execution cycles and ambiguous self-dependencies are errors. The compatibility preset retains its existing diagnostic behavior for imperfect historical roadmaps and returns original gates separately as `sourceGates` during validation.

## Historical calibration

For custom formats, comparison cohorts are explicit. Set an item's `calibrationGroup` and map historical PR numbers to the same group using `historicalGroups` in the roadmap configuration:

```json
{
  "version": 1,
  "roadmap": {
    "format": "normalized-json",
    "historicalGroups": { "41": "storage", "42": "storage", "43": "network" }
  }
}
```

An item with `"calibrationGroup": "storage"` can use the storage PR baseline. Without a matching cohort ERA uses its repository baseline. Custom adapters ignore title-derived historical epic assignments; unmapped PRs remain available to the repository baseline. The mapping also applies to `backtest`. Numeric group IDs remain supported in normalized JSON for compatibility, but strings containing only digits are rejected to prevent ambiguous report keys. Existing API report fields named `epic`/`epicTokens` carry these cohort IDs, including named strings.

## API

`POST /v1/roadmap-validations` accepts `{repository, roadmap: {body, titles?}, roadmapConfig?}`. `POST /v1/estimates` accepts the same `roadmapConfig` alongside its existing snapshot, history and optional plan. `POST /v1/backtests` accepts `roadmapConfig` for historical cohort mapping. API `roadmapConfig` contains the inner `roadmap` object from the CLI file; the file's `version` envelope is local CLI configuration.

The endpoints enforce existing repository authentication and a 2 MiB request limit. Custom models allow up to 1,000 items, 1,000 milestones and 10,000 dependency pairs after expansion, with a bounded traversal budget. Configuration is data: uploaded executable parsers and regex programs are unsupported. Format and validation failures return 400; missing or foreign credentials retain the existing 401/403 behavior.

Runnable examples are in `examples/roadmaps/`. During development, substitute `bun src/cli/cli.ts` for `era`; the installed command needs a CLI release containing these options and a Worker deployment containing the validation endpoint.
