import type { ChildEstimate, RoadmapEstimate } from "./estimator.ts";

export function renderEstimate(estimate: RoadmapEstimate, repository: string): string {
    const calibration = estimate.calibration;
    const rates = estimate.authorRateCard;
    const missing = (category: string) => estimate.costGaps.some((gap) => gap.category === category);
    const lines = [
        `# Estimates for ${repository}#${estimate.issueNumber}`,
        "",
        estimate.issueTitle,
        "",
        `**Priced subtotal: ${usd(estimate.pricedSubtotalUsd)}, plus unpriced delivery costs.** This is a conditional allocation of priced components, not a complete cash budget.`,
        "",
        `Remaining scope includes ${estimate.childCount} delivery children and ${estimate.epicCount} epic trackers at zero execution weight. Each child's default load is a historical typical PR estimate, not proof that it takes one session.`,
        "",
        "| Model | Quantity | Estimate |",
        "| --- | --- | --- |",
        `| Token-threshold | Raw sprint load E_raw | ${tokens(estimate.rawTokens)} |`,
        `| Token-threshold | Issue-level dependency-path load E_eff (not duration) | ${tokens(estimate.effectiveTokens)} |`,
        `| Token-threshold | Approximate heavy path | ${estimate.criticalPath.map((issue) => `#${issue}`).join(" → ")} |`,
        `| Consumption | Review-loop load | ${tokens(estimate.reviewTokens + estimate.reviewPoolTokens)} |`,
        `| Consumption | Author orchestration load | ${missing("author-orchestration") ? "Unpriced; quantity unavailable" : tokens(estimate.authorOverheadTokens)} |`,
        `| Consumption | Aggregate estimated agent load (coverage gaps below) | ${tokens(estimate.allAgentTokens)} |`,
        `| SEEAgent | Reconstructed negotiated story points E* | ${integer(estimate.storyPoints)} points |`,
        `| SEEAgent diagnostic | Leave-one-out MAE against token-derived labels | ${estimate.backtest.mae.toFixed(3)} points |`,
        `| SEEAgent diagnostic | Leave-one-out MMRE against token-derived labels | ${estimate.backtest.mmre.toFixed(3)} |`,
        `| SEEAgent diagnostic | Leave-one-out PRED(0.5) against token-derived labels | ${estimate.backtest.pred.toFixed(3)} |`,
        `| Priced costs | Author usage | ${usd(estimate.llmCost)} |`,
        `| Priced costs | Author orchestration | ${missing("author-orchestration") ? "Unpriced" : usd(estimate.authorOverheadCost)} |`,
        `| Priced costs | Codex review and follow-ups | ${missing("agent-review") ? "Unpriced" : usd(estimate.reviewLlmCost)} |`,
        `| Priced costs | Shared/unpaired Codex review | ${missing("agent-review") ? "Unpriced" : usd(estimate.reviewPoolCost)} |`,
        `| Priced costs | ${estimate.explicitHumanActivities ? "Explicit human activities" : "Human checkpoint review and assumed rework only"} | ${usd(estimate.hitlCost)} (${estimate.humanHours.toFixed(1)}h) |`,
        `| Priced costs | Runner compute | ${missing("infrastructure") ? "Unpriced" : usd(estimate.infraCost)} |`,
        `| Accounting | Priced subtotal | ${usd(estimate.pricedSubtotalUsd)} |`,
        "",
        "## Chronological retrospective token validation",
        "",
        `Train only on PRs merged before each target PR was created, with at least three prior observations. ${estimate.tokenValidation.rows.length}/${estimate.tokenValidation.sampleCount} targets scored; ${estimate.tokenValidation.skippedDates} excluded for missing/invalid dates, ${estimate.tokenValidation.skippedWarmup} for insufficient prior history.`,
        "",
        "| Baseline | Targets | MAE (tokens) | MMRE | PRED(0.5) |",
        "| --- | ---: | ---: | ---: | ---: |",
        ...(
            [
                ["Repository median", estimate.tokenValidation.repositoryMedian],
                ["Epic median (minimum 3 peers, otherwise repository median)", estimate.tokenValidation.epicMedian],
            ] as const
        ).map(([name, score]) =>
            score
                ? `| ${name} | ${score.count} | ${integer(score.maeTokens)} | ${score.mmre.toFixed(3)} | ${score.pred.toFixed(3)} |`
                : `| ${name} | 0 | Unavailable | Unavailable | Unavailable |`,
        ),
        "",
        "These compare final historical token extracts, not immutable forecasts made at the time. Named comparable-PR plans are not validated by this baseline. Dollar accuracy remains unavailable without actual billing and human-effort observations; freeze prospective forecasts and score those against later receipts.",
        "",
        "## Unpriced costs and evidence gaps",
        "",
        ...estimate.costGaps.map((gap) => `- **${gap.category}:** ${gap.detail}`),
        "",
        "## Scope diagnostics",
        "",
        ...(estimate.scopeDiagnostics.length > 0
            ? estimate.scopeDiagnostics.map((diagnostic) => `- ${diagnostic}`)
            : [
                  "No parser/graph approximations were detected. Acceptance evidence still determines delivery completion.",
              ]),
        "",
        "## Typical load by lane",
        "",
        "| Lane | Children | Author tokens | Review tokens | Reconstructed points | Author USD | Review USD | Checkpoint labor USD |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
        ...laneRows(estimate.children, missing("agent-review")),
        `| **Remaining** | **${estimate.childCount}** | **${integer(estimate.rawTokens)}** | **${integer(estimate.reviewTokens)}** | **${integer(estimate.storyPoints)}** | **${usd(estimate.llmCost)}** | **${missing("agent-review") ? "Unpriced" : usd(estimate.reviewLlmCost)}** | **${usd(sum(estimate.children.map((child) => child.hitlCost)))}** |`,
        "",
        "Shared orchestration, review pools and any explicitly priced runner usage are project-level components, added once outside these lane totals.",
        ...(estimate.explicitHumanActivities
            ? [
                  "Explicit human activity costs are project-level; zero checkpoint allocations in lanes do not mean zero human work.",
              ]
            : []),
        "",
        "## Sizing evidence",
        "",
        "| Issue | Basis | Sample PRs | Remaining author blocks | Source |",
        "| --- | --- | ---: | ---: | --- |",
        ...estimate.children.map(
            (child) =>
                `| #${child.issue} | ${child.sizing.basis}${child.sizing.comparablePrs.length ? ` (${child.sizing.comparablePrs.map((id) => `PR #${id}`).join(", ")})` : ""} | ${child.sizing.sampleCount} | ${child.sizing.authorBlocks} | ${child.sizing.source.replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
        ),
        "",
        "## Calibration and assumptions",
        "",
        "| Parameter | Value |",
        "| --- | --- |",
        `| Author history generated | ${estimate.historyGeneratedAt ?? "Unavailable"} |`,
        `| Explicit plan source | ${cell(estimate.planSource ?? "Unavailable; default quantities apply")} |`,
        `| Merged PRs with positive author usage | ${calibration.sampleCount} |`,
        `| Historical median consumed author tokens | ${tokens(calibration.medianTotalTokens)} |`,
        `| Review coverage | ${calibration.reviewCoveredPullRequests}/${calibration.sampleCount} merged PRs |`,
        `| Median paired review/author ratio | ${calibration.medianReviewTokenRatio.toFixed(3)} |`,
        `| Historical blended review price | ${usd(calibration.reviewPricePerToken * 1_000_000)} per million review tokens; assumed transferable |`,
        `| Legacy RF/CF formula diagnostic (excluded from priced subtotal) | ${usd(estimate.literalLlmCost)} |`,
        "",
        `- **Author rate card (${rates.provenance}):** ${rates.model}, ${rates.currency}, as of ${rates.asOf}; ${usd(rates.inputPerToken * 1_000_000)} fresh / ${usd(rates.cacheReadPerToken * 1_000_000)} cache-read / ${usd(rates.outputPerToken * 1_000_000)} output per million tokens. Source: [rate reference](${rates.source}). A stored reference is not verification of the user's current billing agreement.`,
        "- Author cost prices the disjoint fresh/cache-read/output proportions observed across the calibration sample. Output includes reasoning. Inclusive historical usage already contains retries and context; neither is charged with another multiplier. Mixed-model history is repriced under the stated future routing assumption, not presented as an actual historical invoice.",
        "- Child sizes use the median of explicitly selected comparable PRs, or default to epic-matched historical medians when available, otherwise the repository median. Remaining blocks scale this load. These are typical-load scenarios; a sum of medians is not a project percentile. Stronger forecasts require relevant completed tasks and verified remaining activities.",
        "- Shared author orchestration uses its own observed category mix and its ratio to PR-attributed author usage. Codex review calibration imputes paired review loads or uses unmatched review medians; follow-up sessions are already included. Missing joins remain evidence gaps.",
        estimate.explicitHumanActivities
            ? "- Human labor uses the supplied activity hours and rates instead of default checkpoints. Missing activity categories remain unpriced. Labor allocation is not necessarily incremental cash spend."
            : `- Human checkpoint labor assumes ${estimate.assumptions.checkpointsPerTask} × ${estimate.assumptions.reviewHours}h review per child, plus the CI failure-rate proxy × ${estimate.assumptions.reworkHours}h rework, at ${usd(estimate.assumptions.hourlyRateUsd)}/h. This covers only those activities; CI failure is not observed human rejection. Labor allocation is not necessarily incremental cash spend.`,
        "- Runner compute is priced only from explicit billing applicability and billable quantities. Historical CI spans, review waiting and unattended soak duration are not human work hours or summed job minutes.",
        "- The dependency graph is an issue-level approximation. Milestone collapse, unmapped references and dropped edges are listed above. Dependency-path tokens are not elapsed time; parallelism does not reduce aggregate consumption.",
        "- SEEAgent's accuracy rows score reconstructed story-point labels and do not validate dollar or token forecasts. The chronological token baseline is evaluated separately above; prospective token/dollar forecasts remain necessary.",
        "- Aggregate cached consumption does not imply a number of implementation tasks. The legacy partition arithmetic is not reported as required leaves.",
        "- No delivery date, budget fit, actual spend to date, subscription allowance or estimate-at-completion is inferred.",
        "",
    ];
    return lines.join("\n");
}

function laneRows(children: readonly ChildEstimate[], reviewUnpriced: boolean): string[] {
    const lanes = new Map<string, ChildEstimate[]>();
    for (const child of children) {
        const group = lanes.get(child.laneId) ?? [];
        group.push(child);
        lanes.set(child.laneId, group);
    }
    return [...lanes.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([laneId, group]) => {
            const issues = group.map((child) => `#${child.issue}`).join(", ");
            return `| ${laneId} | ${issues} | ${integer(sum(group.map((child) => child.tokens)))} | ${integer(sum(group.map((child) => child.reviewTokens)))} | ${integer(sum(group.map((child) => child.storyPoints)))} | ${usd(sum(group.map((child) => child.llmCost)))} | ${reviewUnpriced ? "Unpriced" : usd(sum(group.map((child) => child.reviewLlmCost)))} | ${usd(sum(group.map((child) => child.hitlCost)))} |`;
        });
}

function tokens(value: number): string {
    return `${integer(value)} tokens`;
}

function cell(value: string): string {
    return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function integer(value: number): string {
    return Math.round(value).toLocaleString("en-US");
}

function usd(value: number): string {
    return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function sum(values: readonly number[]): number {
    return values.reduce((total, value) => total + value, 0);
}
