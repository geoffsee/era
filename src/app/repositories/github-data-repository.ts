import githubClient from "../../core/github/github-client.ts";

export type RoadmapIssue = {
    number: number;
    title: string;
    body: string;
    titles: Map<number, string>;
    issueStates: Map<number, string>;
    /** Issue bodies, kept for in-context inference descriptions. */
    bodies: Map<number, string>;
};

export async function loadRoadmapIssue(owner: string, repo: string, issueNumber?: number): Promise<RoadmapIssue> {
    if (issueNumber !== undefined && (!Number.isSafeInteger(issueNumber) || issueNumber <= 0))
        throw new Error("roadmap issue must be a positive integer");
    const titles = new Map<number, string>();
    const issueStates = new Map<number, string>();
    const bodies = new Map<number, string>();
    const openRoadmaps: Array<{ number: number; title: string }> = [];

    for (let page = 1; ; page++) {
        const { data } = await githubClient.rest.issues.listForRepo({
            owner,
            repo,
            state: "all",
            per_page: 100,
            page,
        });
        for (const issue of data) {
            if (issue.pull_request) continue;
            titles.set(issue.number, issue.title);
            issueStates.set(issue.number, issue.state);
            if (issue.body) bodies.set(issue.number, issue.body);
            if (issue.state === "open" && /roadmap/i.test(issue.title)) {
                openRoadmaps.push({ number: issue.number, title: issue.title });
            }
        }
        if (data.length < 100) break;
    }

    if (issueNumber === undefined && openRoadmaps.length !== 1) {
        const found = openRoadmaps.map((issue) => `#${issue.number} ${issue.title}`).join("; ");
        throw new Error(
            `Expected one open Roadmap issue in ${owner}/${repo}, found ${openRoadmaps.length}${found ? `: ${found}` : ""}`,
        );
    }

    const selected = issueNumber ?? openRoadmaps[0]!.number;
    const { data } = await githubClient.rest.issues.get({
        owner,
        repo,
        issue_number: selected,
    });
    if (data.pull_request) throw new Error(`#${selected} is a pull request, not a roadmap issue`);
    return {
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        titles,
        issueStates,
        bodies,
    };
}
