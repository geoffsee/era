# Requirements for a tracked repository

`era` estimates one open roadmap issue in a GitHub repository, then records predictions and actuals against issue and pull-request numbers in that same `owner/name`. This is the shape those issues take.

## Repository

The repository id is `owner/name`, with one slash and no spaces. `bun start owner/name` and `record-estimate --repository owner/name` both read that repository.

Issues are the work items on the roadmap. Pull requests are history and later observations. A pull request is never a roadmap node, even when its title contains "roadmap".

`GITHUB_PAT` or `GH_TOKEN` needs permission to list and read issues.

## The roadmap issue

The repository has one open issue whose title matches `/roadmap/i`. Zero open matches, or more than one, stops the run. Closed roadmap issues are left unused. The match is the title only.

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

Every issue that should be estimated appears in cell 3 of a lane whose state is not `complete`. An issue number that appears only in a gate is not estimated. A number with no issue in the repository still enters the graph. Its title is empty, so it is estimated as a child at the repository median. Each referenced number should be an issue in this repository.

An issue listed in two lanes is one node. The estimate shows the first lane that contains it.

### Local sequence

Arrows in cell 3 order the issues in that lane. Semicolons separate chains. A chain is a piece of the cell that contains `→`. Stages are the pieces between arrows. Every issue in a stage depends on every issue in the previous stage. Issues in the same stage are parallel with each other.

`#110 → (#111 and #112 in parallel) → #113` means 110 finishes before 111 and before 112, and both 111 and 112 finish before 113. Parentheses and words such as `and` are ignored. Only `#N` and ranges count.

`#48, #114` lists two issues and adds no order, because the piece has no arrow. `#49 → #50` is an order.

## Gate table

Gates add edges across lanes. Cells are read by position:

| Position | Content |
| --- | --- |
| 0 | `C<digits>` plus one optional letter, then the name. `C01 start` and `C12a candidate package outputs` both match. |
| 1 | Requires. The listed items are a conjunction. |
| 2 | Unlocks. Each listed item is released when every requirement is met. |
| 3 and after | Free text |

A gate id is `C`, one or more digits, and one optional trailing letter. `C01`, `C12`, and `C12a` match. Gate ids in one roadmap are unique. The name is the rest of the first cell after the id.

Requires and unlocks are comma-separated. Each comma-separated piece contributes the first token that matches a gate id, a lane id, or an issue reference:

| Token | Meaning |
| --- | --- |
| `#48` | That issue |
| `T02` | Every issue in that lane's membership cell |
| `C02` | The issues reached by walking that gate's requirements |

A suffix on an issue reference is discarded. `#48:production-cell` is issue 48. Milestones are not separate nodes. A gate that names a later milestone of an issue pulls the whole issue onto that edge. When a gate's requirements already include an issue, an unlock of that same issue adds no edge. An edge that would cycle back to an earlier issue is dropped.

An unlock that is a gate id adds no edges. An unlock that is a lane id adds an edge to each issue in that lane. Edges are kept only when both issues sit in a lane whose state is not `complete`. Naming an issue that lives in a `complete` lane does not bring that issue back into the estimate.

`completion` and other words that contain no gate, lane, or issue token add nothing. A final gate may use such a word as a human label.

## Issue titles

The estimator reads the title of every issue in the repository that is not a pull request. Offline, `--titles titles.json` is a JSON object whose keys are issue numbers and whose values are those titles. The same title rules apply.

### Epic trackers

A title that starts with `[Epic`, in any case after trimming, is an epic tracker. `[Epic E19] Portainer` and `[epic] bootstrap` both qualify. The epic stays in the dependency graph at zero token weight. It is not given a token total, a story-point total, or a cost.

### Child issues

Every other issue in a lane that is not `complete` is one child. Each child is one agent session.

A title that contains `E<epic>.<child>` selects the calibration epic. The match is a word boundary, then `E`, digits, a dot, and digits. `[E04.03] Classify optional failures` uses epic 4. Leading zeros are allowed, and `E04` is epic 4. The child index after the dot is not read. The first match in the title wins.

Merged pull requests use the same `E<epic>.<child>` pattern in their titles. A child is calibrated from the median token total and story points of merged pull requests in that epic that have token usage. A child with no epic id, or an epic with no such pull requests, uses the median of all merged pull requests with token usage.

GitHub issue state is not read. Open and closed issues in an active lane are both estimated. Finished work leaves the estimate by sitting in a lane whose state is `complete`.

The repository does not need a story-point field, labels, assignees, or a GitHub milestone. SEEAgent builds its point scale from the historical token totals.

## Tracker subjects

`record-estimate` stores these subjects for `owner/name`. A subject matches `[A-Za-z0-9_.:/-]+`.

| Subject | What it identifies |
| --- | --- |
| `issue:<roadmap number>` | The roadmap issue. Metrics are `tokens` for E_raw, `tokens_effective` for E_eff, `story_points`, and `usd`. |
| `issue:<child number>` | One child issue. Metrics are `tokens` and `story_points`. |
| `pr:<number>` | One pull request. Historical ingest records `tokens` for a merged pull request with token usage. |

An observation uses the same `issue:` or `pr:` subject as the prediction it should score.

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
