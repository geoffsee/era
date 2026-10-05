import { Octokit } from "octokit";

const githubPat = process.env.GITHUB_PAT ?? process.env.GH_TOKEN;

const githubClient = new Octokit({ auth: githubPat });

export default githubClient;
