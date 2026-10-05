import { runCli } from "./src/cli.ts";

const [repository, issue, plan, ...extra] = process.argv.slice(2);
if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository) || extra.length > 0) {
    console.error("usage: bun start owner/name [roadmap-issue-number] [forecast-plan.json]");
    process.exit(1);
}
const args = ["estimate", "--repository", repository];
if (issue) args.push("--issue", issue);
if (plan) args.push("--plan", plan);
process.exit(await runCli(args));
