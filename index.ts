import { estimateRoadmap } from "./src/estimator.ts";
import { renderEstimate } from "./src/format.ts";
import { loadRoadmapIssue } from "./src/github-data-repository.ts";
import { loadHistoricalData } from "./src/historical-data-repository.ts";
import { parseForecastPlan } from "./src/forecast-plan.ts";

const repository = process.argv[2];
if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    console.error("usage: bun start owner/name [roadmap-issue-number] [forecast-plan.json]");
    process.exit(1);
}
const [owner, repo] = repository.split("/") as [string, string];

const history = await loadHistoricalData();
if (history.repository !== repository)
    throw new Error(`historical repository ${history.repository ?? "unavailable"} does not match ${repository}`);
const roadmap = await loadRoadmapIssue(owner, repo, process.argv[3] ? Number(process.argv[3]) : undefined);
const plan = process.argv[4] ? parseForecastPlan(await Bun.file(process.argv[4]).json()) : undefined;
const estimate = estimateRoadmap({
    issueNumber: roadmap.number,
    issueTitle: roadmap.title,
    issueBody: roadmap.body,
    titles: roadmap.titles,
    history: history.pullRequests,
    reviewPool: history.reviewPool,
    authorOverhead: history.authorOverhead,
    historyGeneratedAt: history.generatedAt,
    issueStates: roadmap.issueStates,
    plan,
});

console.log(renderEstimate(estimate, repository));
