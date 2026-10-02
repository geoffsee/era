import { estimateRoadmap } from "./src/estimator.ts";
import { renderEstimate } from "./src/format.ts";
import { loadRoadmapIssue } from "./src/github-data-repository.ts";
import { loadHistoricalPullRequests } from "./src/historical-data-repository.ts";

const repository = process.argv[2];
if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    console.error("usage: bun start owner/name");
    process.exit(1);
}
const [owner, repo] = repository.split("/") as [string, string];

const history = await loadHistoricalPullRequests();
const roadmap = await loadRoadmapIssue(owner, repo);
const estimate = estimateRoadmap({
    issueNumber: roadmap.number,
    issueTitle: roadmap.title,
    issueBody: roadmap.body,
    titles: roadmap.titles,
    history,
});

console.log(renderEstimate(estimate, repository));
