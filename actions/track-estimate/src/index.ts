import * as core from "@actions/core";
import * as github from "@actions/github";
import { createActionComposition, runComposedAction } from "@terella/action-framework";
import { ERA_CREDENTIAL, ERA_FETCH } from "./tracker.ts";
import { TrackEstimateWorkflow } from "./workflow.ts";

const pullRequest = github.context.payload.pull_request;
const apiUrl = (core.getInput("api-url") || "https://era-tracker.seemueller.workers.dev").replace(/\/$/, "");
const audience = new URL(apiUrl).origin;
const suppliedToken = core.getInput("api-token");
const credential = suppliedToken || (await core.getIDToken(audience));
core.setSecret(credential);

const composition = createActionComposition({
    githubContext: {
        repo: github.context.repo,
        pullRequestNumber: typeof pullRequest?.number === "number" ? pullRequest.number : undefined,
    },
    dependencies: {},
});
composition.registerFactory(ERA_FETCH, () => globalThis.fetch.bind(globalThis), { singleton: true });
composition.registerFactory(ERA_CREDENTIAL, () => credential, { singleton: true });

try {
    await runComposedAction(composition, TrackEstimateWorkflow);
} catch (error) {
    core.setFailed(error instanceof Error ? error.message : "track-estimate failed");
}
