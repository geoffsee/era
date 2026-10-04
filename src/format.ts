import type { ChildEstimate, RoadmapEstimate } from "./estimator.ts";
import { tokenSize } from "./theory.ts";

export function renderEstimate(estimate: RoadmapEstimate, repository: string): string {
    const calibration = estimate.calibration;
    const lines = [
        `# Estimates for ${repository}#${estimate.issueNumber}`,
        "",
        estimate.issueTitle,
        "",
        `Remaining work is the ${estimate.childCount} child issues in lanes whose state is not complete. ${estimate.epicCount} epic trackers stay in the dependency graph at zero token weight. Each child is one agent session, so context resets between children.`,
        "",
        "| Model | Quantity | Estimate |",
        "| --- | --- | --- |",
        `| Token-threshold | Raw sprint load E_raw | ${tokens(estimate.rawTokens)} |`,
        `| Token-threshold | Parallel effective load E_eff | ${tokens(estimate.effectiveTokens)} |`,
        `| Token-threshold | Critical path | ${estimate.criticalPath.map((issue) => `#${issue}`).join(" → ")} |`,
        `| Token-threshold | Size of E_raw | ${tokenSize(estimate.rawTokens)} |`,
        `| Token-threshold | Leaves still required so each τ ≤ 4×10^5 | ${integer(estimate.partitions)} |`,
        `| Token-threshold | Illustrative cost C ≈ E_raw · p | ${usd(estimate.illustrativeTokenCost)} |`,
        `| Token-threshold | Review-loop tokens | ${tokens(estimate.reviewTokens + estimate.reviewPoolTokens)} |`,
        `| SEEAgent | Negotiated story points E* | ${integer(estimate.storyPoints)} points |`,
        `| SEEAgent | Leave-one-out MAE | ${estimate.backtest.mae.toFixed(3)} points |`,
        `| SEEAgent | Leave-one-out MMRE | ${estimate.backtest.mmre.toFixed(3)} |`,
        `| SEEAgent | Leave-one-out PRED(0.5) | ${estimate.backtest.pred.toFixed(3)} |`,
        `| ACEM | C_LLM | ${usd(estimate.llmCost)} |`,
        `| ACEM | C_LLM review | ${usd(estimate.reviewLlmCost)} |`,
        `| ACEM | C_LLM review, unattributed | ${usd(estimate.reviewPoolCost)} |`,
        `| ACEM | C_HITL | ${usd(estimate.hitlCost)} |`,
        `| ACEM | C_Infra | ${usd(estimate.infraCost)} |`,
        `| ACEM | C_Infra review | ${usd(estimate.reviewInfraCost)} |`,
        `| ACEM | Total_Cost | ${usd(estimate.totalCost)} |`,
        "",
        "## Decomposition by lane",
        "",
        "| Lane | Children | Calibrated tokens | Review tokens | Story points | C_LLM | C_review | C_HITL | C_Infra |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        ...laneRows(estimate.children),
        `| **Remaining** | **${estimate.childCount}** | **${integer(estimate.rawTokens)}** | **${integer(estimate.reviewTokens)}** | **${integer(estimate.storyPoints)}** | **${usd(estimate.llmCost)}** | **${usd(estimate.reviewLlmCost)}** | **${usd(estimate.hitlCost)}** | **${usd(estimate.infraCost)}** |`,
        "",
        "## Calibration",
        "",
        "| Parameter | Value |",
        "| --- | --- |",
        `| Merged pull requests with agent tokens | ${calibration.sampleCount} |`,
        `| Median calibrated τ | ${tokens(calibration.medianTotalTokens)} |`,
        `| Literal (T_in·P_in + T_out·P_out)·RF·CF | ${usd(estimate.literalLlmCost)} |`,
        `| Rejection rate r | ${calibration.rejectionRate.toFixed(4)} |`,
        `| Extra invocations per rejection n | ${calibration.extraInvocations.toFixed(3)} |`,
        `| RF = 1 + r·n | ${calibration.revisionFactor.toFixed(4)} |`,
        `| Context growth α | ${calibration.alpha.toFixed(3)} |`,
        `| CF at end of a child session | ${calibration.contextFactor.toFixed(3)} |`,
        `| γ_SP | ${integer(Math.round(calibration.gammaPerPoint))} base tokens per point |`,
        `| Blended price p | ${usd(calibration.blendedPricePerToken * 1_000_000)} per million tokens |`,
        `| Review coverage | ${calibration.reviewCoveredPullRequests} of ${calibration.sampleCount} merged pull requests (${calibration.reviewCoverage.toFixed(3)}) |`,
        `| Median review tokens / author tokens | ${calibration.medianReviewTokenRatio.toFixed(3)} |`,
        `| Median review tokens per reviewed pull request | ${tokens(calibration.medianAbsoluteReviewTokens)} |`,
        `| Review price | ${usd(calibration.reviewPricePerToken * 1_000_000)} per million review tokens |`,
        `| Follow-up share of review-loop tokens | ${calibration.followupTokenShare.toFixed(3)} |`,
        `| Inherited-split share of review-loop tokens | ${calibration.inheritedTokenShare.toFixed(3)} |`,
        `| Story-point scale breaks | ${calibration.pointBreaks.map((value) => integer(Math.round(value))).join(", ")} |`,
        "",
        "Assumptions:",
        "",
        `- Token sizes use retrospective calibration τ ← T_actual. The fixed bins remain the decomposition threshold: anything above ${integer(400_000)} tokens is XL and must be split.`,
        "- SEEAgent points are the project's missing story-point field, reconstructed by placing historical token totals on the Fibonacci scale 1, 2, 3, 5, 8, 13. E* is the value the analogist and peers agree on. Accuracy is leave-one-out against those labels.",
        "- ACEM maps story points to a position-independent base, T_base = SP · γ_SP · CW, then applies RF and CF. Fresh input is $3 / million tokens, output is $15 / million, and the (CF − 1) context share is $0.30 / million because those tokens are cache reads in the historical log. Output is not multiplied by CF. The calibration row prices the literal product, which treats that context as fresh input.",
        `- HITL is HIS-3: ${estimate.assumptions.checkpointsPerTask} checkpoint × ${estimate.assumptions.reviewHours} h review, plus r × ${estimate.assumptions.reworkHours} h rework, at $${estimate.assumptions.hourlyRateUsd}/h. W is not in the historical data. HITL is human time. Codex review is a separate model bill.`,
        "- Infrastructure is the median historical CI duration scaled by each child's token ratio, at $0.006 per GitHub-hosted Linux minute. Standard runners on a public repository are not billed; the row is the list price.",
        "- C_LLM review uses the median Codex review tokens per author token when a merged pull request has both, and an epic median when that epic has one. When the reviewed pull requests are missing from the author-token extract, each child is charged the median review-loop tokens of those pull requests instead. The price is the observed review dollars per review token. C_Infra review follows the same choice for the extra Actions span. The unattributed row scales review tokens that named no pull request by remaining author tokens.",
        `- A session that runs gh against several pull requests is split evenly across them. ${(calibration.inheritedTokenShare * 100).toFixed(0)}% of review-loop tokens came from subagents that named none and inherited the parent list. Local test commands and Fast or Ultrafast speed are not in the log.`,
        "- Critical-path edges are issue-level. A gate that releases a later milestone of an issue serializes the whole issue behind that gate.",
        "- No sprint token budget B was supplied, so the commit check E_raw ≤ B is not applied.",
        "- No dates are inferred.",
        "",
    ];
    return lines.join("\n");
}

function laneRows(children: readonly ChildEstimate[]): string[] {
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
            return `| ${laneId} | ${issues} | ${integer(sum(group.map((child) => child.tokens)))} | ${integer(sum(group.map((child) => child.reviewTokens)))} | ${integer(sum(group.map((child) => child.storyPoints)))} | ${usd(sum(group.map((child) => child.llmCost)))} | ${usd(sum(group.map((child) => child.reviewLlmCost)))} | ${usd(sum(group.map((child) => child.hitlCost)))} | ${usd(sum(group.map((child) => child.infraCost)))} |`;
        });
}

function tokens(value: number): string {
    return `${integer(Math.round(value))} tokens`;
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
