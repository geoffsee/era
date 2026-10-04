import { describe, expect, test } from "bun:test";
import {
    allocateReviewSessions,
    pullRequestNumbersFromRollout,
    pullRequestNumbersFromText,
    type ReviewSessionInput,
    reviewCicdSecondsByPullRequest,
    reviewRole,
    reviewTokenCostUsd,
    splitEvenly,
    usageFromThreadRecord,
} from "./review-usage.ts";

describe("review session classification", () => {
    test("counts a pull-request review and a follow-up that addresses its comments", () => {
        expect(reviewRole("Review https://github.com/geoffsee/rubix-kube/pull/289 and post findings")).toBe("review");
        expect(reviewRole("review the open prs in parallel with subagents and add findings as comments")).toBe(
            "review",
        );
        expect(reviewRole("Review the open pull requests, then address comments on the branch")).toBe("review");
        expect(reviewRole("Address all comments on the open PRs including review findings, commit/push fixes")).toBe(
            "followup",
        );
    });

    test("leaves implementation sessions out", () => {
        expect(reviewRole("Read docs/internal/one-shot-development-prompt.md and execute its prompt.")).toBeNull();
        expect(reviewRole("are you here?")).toBeNull();
        expect(reviewRole("Using the gh CLI, conduct backlog grooming.")).toBeNull();
    });
});

describe("pull request numbers", () => {
    test("reads issue-style numbers from the user message and command names from a rollout", () => {
        expect(
            pullRequestNumbersFromText(
                "Review PR #290 and https://github.com/geoffsee/rubix-kube/pull/289. See #49 and **#276**.",
            ),
        ).toEqual([276, 289, 290]);
        const rollout = [
            "gh pr checks 294 --json name",
            "for n in 289 290 291; do gh pr view 289; done",
            "CARGO_TARGET_DIR=/tmp/rubix-review-target-278",
            "https://github.com/geoffsee/rubix-kube/pull/277",
            "a PR URL (e.g. https://github.com/cli/cli/pull/123)",
        ].join("\n");
        expect(pullRequestNumbersFromRollout(rollout)).toEqual([289, 290, 291, 294]);
    });
});

describe("review allocation", () => {
    const usage = usageFromThreadRecord({
        input_tokens: 1_000,
        cached_input_tokens: 800,
        output_tokens: 100,
    });

    test("prices the credit card at four cents and bills cache reads below fresh input", () => {
        expect(usage).toMatchObject({
            uncachedInputTokens: 200,
            cacheReadTokens: 800,
            outputTokens: 100,
            totalTokens: 1_100,
        });
        const million = {
            uncachedInputTokens: 1_000_000,
            cacheReadTokens: 0,
            outputTokens: 0,
            totalTokens: 1_000_000,
            priced: true,
        };
        expect(reviewTokenCostUsd("gpt-6.1-sol", million)).toBeCloseTo(2);
        expect(
            reviewTokenCostUsd("gpt-6.1-sol", {
                ...million,
                uncachedInputTokens: 0,
                cacheReadTokens: 1_000_000,
            }),
        ).toBeCloseTo(0.1);
        expect(
            reviewTokenCostUsd("gpt-6.1-sol", { ...million, uncachedInputTokens: 0, outputTokens: 1_000_000 }),
        ).toBeCloseTo(10);
        expect(reviewTokenCostUsd("codex-auto-review", million)).toBeNull();
    });

    test("splits a parent across the pull requests it names and keeps a child on its own pull request", () => {
        const parent: ReviewSessionInput = {
            id: "parent",
            parentId: null,
            model: "gpt-6.1-sol",
            roleText: "Review the open PRs #10 and #20",
            pullRequests: [10, 20],
            usage: { ...usage },
        };
        const child: ReviewSessionInput = {
            id: "child",
            parentId: "parent",
            model: "gpt-6.1-sol",
            roleText: "",
            pullRequests: [20],
            usage: { ...usage, uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 50, totalTokens: 50 },
        };
        const idle: ReviewSessionInput = {
            id: "idle",
            parentId: null,
            model: "gpt-6-astra",
            roleText: "execute the one-shot prompt",
            pullRequests: [10],
            usage: { ...usage, totalTokens: 9_000, uncachedInputTokens: 9_000, cacheReadTokens: 0, outputTokens: 0 },
        };
        const allocation = allocateReviewSessions([parent, child, idle]);
        expect(allocation.sessions.map((session) => session.id)).toEqual(["parent", "child"]);
        const ten = allocation.pullRequests.find((pullRequest) => pullRequest.prNumber === 10);
        const twenty = allocation.pullRequests.find((pullRequest) => pullRequest.prNumber === 20);
        expect(ten?.reviewTokens).toBe(550);
        expect(twenty?.reviewTokens).toBe(600);
        expect(allocation.unattributedReviewTokens).toBe(0);
        expect(splitEvenly(10, 3)).toEqual([4, 3, 3]);
    });

    test("inherits the parent list when a subagent names no pull request", () => {
        const allocation = allocateReviewSessions([
            {
                id: "parent",
                parentId: null,
                model: "gpt-6.1-sol",
                roleText: "Review PR #7",
                pullRequests: [7],
                usage: { ...usage },
            },
            {
                id: "child",
                parentId: "parent",
                model: "gpt-6.1-sol",
                roleText: "",
                pullRequests: [],
                usage: { ...usage },
            },
        ]);
        expect(allocation.sessions.find((session) => session.id === "child")?.attribution).toBe("inherited");
        expect(allocation.inheritedReviewTokens).toBe(1_100);
        expect(allocation.pullRequests[0]?.reviewTokens).toBe(2_200);
    });
});

describe("review CI", () => {
    test("adds earlier SHAs that start during the review and leaves the final head to the CI extract", () => {
        const seconds = reviewCicdSecondsByPullRequest(
            [
                {
                    headBranch: "feat/a",
                    headSha: "a".repeat(40),
                    createdAt: "2026-10-03T00:10:00Z",
                    updatedAt: "2026-10-03T00:12:00Z",
                    status: "completed",
                },
                {
                    headBranch: "feat/a",
                    headSha: "a".repeat(40),
                    createdAt: "2026-10-03T00:10:30Z",
                    updatedAt: "2026-10-03T00:40:00Z",
                    status: "completed",
                },
                {
                    headBranch: "feat/a",
                    headSha: "b".repeat(40),
                    createdAt: "2026-10-03T02:00:00Z",
                    updatedAt: "2026-10-03T03:00:00Z",
                    status: "completed",
                },
                {
                    headBranch: "feat/a",
                    headSha: "c".repeat(40),
                    createdAt: "2026-10-03T05:00:00Z",
                    updatedAt: "2026-10-03T06:00:00Z",
                    status: "completed",
                },
            ],
            [
                {
                    pullRequests: [4],
                    startedAt: "2026-10-03T00:00:00Z",
                    endedAt: "2026-10-03T04:00:00Z",
                },
            ],
            [{ number: 4, headBranch: "feat/a", headSha: "b".repeat(40) }],
        );
        expect(seconds.get(4)).toBe(30 * 60);
    });
});
