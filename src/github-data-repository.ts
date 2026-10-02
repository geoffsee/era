import githubClient from "./github-client.ts";

export type RoadmapIssue = {
    number: number;
    title: string;
    body: string;
    titles: Map<number, string>;
};

export async function loadRoadmapIssue(owner: string, repo: string): Promise<RoadmapIssue> {
    const titles = new Map<number, string>();
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
            if (issue.state === "open" && /roadmap/i.test(issue.title)) {
                openRoadmaps.push({ number: issue.number, title: issue.title });
            }
        }
        if (data.length < 100) break;
    }

    if (openRoadmaps.length !== 1) {
        const found = openRoadmaps.map((issue) => `#${issue.number} ${issue.title}`).join("; ");
        throw new Error(
            `Expected one open Roadmap issue in ${owner}/${repo}, found ${openRoadmaps.length}${found ? `: ${found}` : ""}`,
        );
    }

    const roadmap = openRoadmaps[0]!;
    const { data } = await githubClient.rest.issues.get({
        owner,
        repo,
        issue_number: roadmap.number,
    });
    return {
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        titles,
    };
}
