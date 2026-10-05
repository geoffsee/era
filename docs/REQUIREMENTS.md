# Requirements for a tracked repository

`era` estimates one open roadmap issue in a GitHub repository, then records predictions and actuals against issue and pull-request numbers in that same `owner/name`. This is the shape those issues take.

## Repository

The repository id is `owner/name`, with one slash and no spaces. `bun start owner/name` and `record-estimate --repository owner/name` both read that repository.

Issues are the work items on the roadmap. Pull requests are history and later observations. A pull request is never a roadmap node, even when its title contains "roadmap".

`GITHUB_PAT` or `GH_TOKEN` needs permission to list and read issues.

## The roadmap issue

Without an explicit issue number, the repository has one open issue whose title matches `/roadmap/i`. Zero open matches, or more than one, stops the run. `bun start owner/name N` and `estimate --issue N` select a specific issue, including a historical closed issue; selecting a pull request is refused. The default match is the title only.

The body is GitHub markdown. Lines that do not start with `|` are ignored, including headings, prose, blockquotes, and mermaid diagrams. The body contains both of these pipe tables. A body with no lane row, or no gate row, stops the run.

Header and separator rows are ignored. A row is a lane or a gate when its first cell matches the id pattern below. Cells are split on `|`.

## Lane table

Lanes are the columns of work. The header is documentation for people. The parser reads cells by position:

| Position | Content |
| --- | --- |
| 0 | `T<digits> <name>`, for example `T01 payload / builds` |
| 1 | State word |
| 2 | Free text, usually what opens the lane |
| 3 | Membership and local sequence |
| 4 and after | Free text |

A lane id is `T` plus one or more digits. `T01a` does not match. Lane ids in one roadmap are unique. The name is the rest of the first cell after the id.

The state is compared in lower case. `complete` removes that lane from the estimate and from the dependency graph. Every other word keeps the lane, including `ready`, `active`, and `blocked`.

Cell 2 does not create edges. Dependencies come from arrows in cell 3 and from the gate table.

### Membership

Cell 3 lists the issues in the lane:

- `#48` is issue 48.
- `#7–#18`, `#7—#18`, and `#7-#18` are inclusive ranges. The dash may be an en dash, an em dash, or a hyphen, with spaces allowed around it. Both ends include `#`.
- Words with no issue reference, such as `paired work`, add no issues.

Every issue that should be estimated appears in cell 3 of a lane whose state is not `complete`. An issue number that appears only in a gate is not estimated; it generates an unresolved-membership diagnostic. Missing or empty titles for active members stop estimation. Each referenced number must identify an issue in this repository. Duplicate lane or gate IDs are refused.

An issue listed in two lanes is one node. The estimate shows the first lane that contains it.

### Local sequence

Arrows in cell 3 order the issues in that lane. Semicolons separate chains. A chain is a piece of the cell that contains `→`. Stages are the pieces between arrows. Every issue in a stage depends on every issue in the previous stage. Issues in the same stage are parallel with each other.

`#110 → (#111 and #112 in parallel) → #113` means 110 finishes before 111 and before 112, and both 111 and 112 finish before 113. Parentheses and words such as `and` are ignored. Only `#N` and ranges count.

`#48, #114` lists two issues and adds no order, because the piece has no arrow. `#49 → #50` is an order.

## Gate table

Gates add edges across lanes. Cells are read by position:

| Position | Content |
| --- | --- |
| 0 | `C<digits>` or `G<digits>` plus one optional lower-case letter, then the name. `C01 start`, `G01 decision` and `C12a candidate package outputs` match. |
| 1 | Requires. The listed items are a conjunction. |
| 2 | Unlocks. Each listed item is released when every requirement is met. |
| 3 and after | Free text |

A gate id is `C` or `G`, one or more digits, and one optional trailing lower-case letter. IDs are retained verbatim, not renumbered. Gate ids in one roadmap are unique. The name is the rest of the first cell after the id.

Requires and unlocks are comma-separated. Each comma-separated piece contributes the first token that matches a gate id, a lane id, or an issue reference:

| Token | Meaning |
| --- | --- |
| `#48` | That issue |
| `T02` | Every issue in that lane's membership cell |
| `C02` or `G02` | The issues reached by walking that gate's requirements |

A suffix on an issue reference is preserved in the parsed gate. `#48:production-cell` remains that reference. Milestones are not yet separate execution nodes: the graph approximates the dependency at whole-issue scope and reports that limitation. When a gate's requirements already include an issue, an unlock of that same issue adds no edge. Every cycle-producing dropped edge, gate cycle, unknown reference and unsupported gate unlock is reported in scope diagnostics. The path is an approximation of token load, not a delivery schedule.

An unlock that is a gate id adds no edges. An unlock that is a lane id adds an edge to each issue in that lane. Edges are kept only when both issues sit in a lane whose state is not `complete`. Naming an issue that lives in a `complete` lane does not bring that issue back into the estimate.

`completion` and other words that contain no gate, lane, or issue token add nothing. A final gate may use such a word as a human label.

## Issue titles

The estimator reads the title of every issue in the repository that is not a pull request. Offline, `--titles titles.json` is a JSON object whose keys are issue numbers and whose values are those titles. The same title rules apply.

### Epic trackers

A title that starts with `[Epic`, in any case after trimming, is an epic tracker. `[Epic E19] Portainer` and `[epic] bootstrap` both qualify. The epic stays in the dependency graph at zero token weight. It is not given a token total, a story-point total, or a cost. Gate references to `[Epic E19]` expand to active children with `E19.<child>` titles, so acceptance requires their delivery. Gate unlocks on an epic release those children at whole-issue scope. An active epic with no mapped children generates an unresolved-acceptance diagnostic; completed lanes remain excluded.

### Child issues

Every other issue in a lane that is not `complete` is one child. Each defaults to one typical historical PR load, an assumption rather than a session count. A plan can replace that quantity and select comparable PRs explicitly.

A title that contains `E<epic>.<child>` selects the calibration epic. The match is a word boundary, then `E`, digits, a dot, and digits. `[E04.03] Classify optional failures` uses epic 4. Leading zeros are allowed, and `E04` is epic 4. The child index after the dot is not read. The first match in the title wins.

Merged pull requests use the same `E<epic>.<child>` pattern in their titles. A child is calibrated from the median token total and story points of merged pull requests in that epic that have token usage. A child with no epic id, or an epic with no such pull requests, uses the median of all merged pull requests with token usage.

Open and closed issues in an active lane are both estimated. Live lookup reads state and warns when a closed issue lacks explicit acceptance evidence. Finished work leaves the estimate by sitting in a lane whose state is `complete`, or by an explicit accepted zero-quantity plan entry with an evidence source. Closure alone does not establish current-candidate acceptance.

The repository does not need a story-point field, labels, assignees, or a GitHub milestone. SEEAgent builds its point scale from the historical token totals.

## Forecast plans

Pass a JSON plan with `--plan path.json`, or as the third positional argument of `bun start owner/name N path.json`. Plans require `version: 1` and a nonempty `source`; unknown fields, duplicate comparables, invalid quantities and missing evidence are rejected. See [`test/fixtures/roadmap-359-central-plan.json`](../test/fixtures/roadmap-359-central-plan.json) for a complete illustrative scenario.

```json
{
  "version": 1,
  "source": "Reviewed scope and remaining work, date and receipt references",
  "work": {
    "10": { "authorBlocks": 2, "comparablePrs": [7, 8], "source": "Two acceptance activities comparable to those PRs" },
    "11": { "authorBlocks": 0, "accepted": true, "source": "Current-candidate acceptance receipt" }
  },
  "humanActivities": [
    { "activity": "discovery-design", "hours": 2, "usdPerHour": 100 },
    { "activity": "implementation-operations", "hours": 3, "usdPerHour": 100 },
    { "activity": "coordination", "hours": 1, "usdPerHour": 100 },
    { "activity": "review", "hours": 1, "usdPerHour": 100 },
    { "activity": "integration-acceptance", "hours": 2, "usdPerHour": 100 }
  ],
  "infrastructureBilling": { "kind": "public-standard" }
}
```

`work` keys must identify delivery children in active lanes. Blocks may be fractional; zero requires `accepted: true`, and accepted work must have zero blocks. Comparable PRs must have merged positive author usage. Their median and aggregate usage mix replace the epic/repository defaults; all named comparables are used, including those from different epics. The report lists sample count, selected PRs, blocks and evidence source. These quantities remain assumptions until verified.

`humanActivities` replaces checkpoint-only labor at project level. Missing categories stay unpriced; provided categories are not charged again in lane checkpoint rows. Absence uses the existing checkpoint and CI-failure rework proxy, with its remaining labor gaps visible. Explicit zero hours are a supplied assumption, not a measured absence of effort.

`infrastructureBilling` may instead be `{"kind":"billable","runnerMinutes":60,"usdPerMinute":0.006,"source":"Reviewed runner plan"}`. Quantities must be billable job minutes. Historical CI wall-clock spans cannot provide them. `public-standard` explicitly attests applicability to standard public runners; public visibility alone is insufficient. Live hosts, soak/reboot occupancy, storage and transfer remain unpriced by this runner-only input.

Optional `authorRateCard` supplies `model`, `currency: "USD"`, `asOf: "YYYY-MM-DD"`, `source`, `provenance` (`assumed` or `verified`), and nonnegative `inputPerToken`, `cacheReadPerToken`, `outputPerToken`. The default is a dated assumed Sonnet 4.6 rate card. Rates price future routing under the observed disjoint usage mix; they do not reconstruct invoices for mixed-model historical usage. Separate cache-write quantities and account terms remain gaps. Historical review prices are a separate assumed transferable blend.

The report adds shared author orchestration once, retains missing CI/review observation flags, names all unpriced costs and emits a priced subtotal. Inclusive author usage is not multiplied again by RF/CF, and output already includes thinking. The old partition arithmetic is retained for API compatibility but is not reported as required implementation tasks.

Chronological retrospective token validation compares repository and epic medians against actual final token totals, admitting only observations merged before target PR creation. It requires three prior samples; epic estimates require three prior peers or fall back. Missing dates and warmup exclusions are counted. This does not score named comparable-PR plans or actual dollars, and final extracts/titles are not frozen records from prediction time. Prospective forecasts and actual billing/human-effort receipts remain necessary.

## Tracker subjects

`record-estimate` stores these subjects for `owner/name`. A subject matches `[A-Za-z0-9_.:/-]+`.

| Subject | What it identifies |
| --- | --- |
| `issue:<roadmap number>` | The roadmap issue. Metrics are `tokens` for E_raw, `tokens_effective` for E_eff, `story_points`, and `usd_subtotal`. Dollars use model `delivery-cost-v2` and include only priced components. Historical `acem` / `usd` rows are preserved separately. |
| `issue:<child number>` | One child issue. Metrics are `tokens` and `story_points`. |
| `pr:<number>` | One pull request. Historical ingest records `tokens` for a merged pull request with token usage. |

An observation uses the same `issue:` or `pr:` subject as the prediction it should score.

`estimate` is read-only and requires no tracker credentials; offline snapshots can omit `--issue`. `record-estimate` requires a positive real roadmap issue number before writing to the tracker, including for offline snapshots. Recording new dollar rows does not migrate or overwrite legacy dollar predictions.

## Minimal body

```markdown
| Lane | State | Opens from | Membership, local sequence | Note |
| --- | --- | --- | --- | --- |
| T00 baseline | complete | — | #1–#3 | Accepted. |
| T01 next | ready | T00 | #10 → (#11 and #12) → #13 | |
| T02 side | ready | T00 | #20 | |

| Gate | Requires (AND) | Unlocks |
| --- | --- | --- |
| C01 start | #10 | #20, #11:design |
```

`T00` is out of the estimate. `#10` precedes both `#11` and `#12`, and both precede `#13`. `C01` makes `#20` and the whole of `#11` wait on `#10`. The `:design` suffix does not create a second node. `#11` is also in the lane sequence, so the gate edge and the arrow edge are the same dependency.
