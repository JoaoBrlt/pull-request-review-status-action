import { components } from "@octokit/openapi-types";
import { AnyBlock } from "@slack/types";
import { GitHub } from "@actions/github/lib/utils";

export enum Input {
    // Common
    GITHUB_TOKEN = "github-token",
    RUN_MODE = "run-mode",
    REQUIRED_APPROVALS = "required-approvals",

    // Label
    PULL_NUMBER = "pull-number",
    PENDING_REVIEW_LABEL = "pending-review-label",
    CHANGES_REQUESTED_LABEL = "changes-requested-label",
    APPROVED_LABEL = "approved-label",

    // Report
    SLACK_TOKEN = "slack-token",
    SLACK_CHANNEL = "slack-channel",
}

export enum RunMode {
    LABEL = "label",
    REPORT = "report",
}

export type OctokitClient = InstanceType<typeof GitHub>;

export type PullRequest = components["schemas"]["pull-request"];

export type PullRequestReview = components["schemas"]["pull-request-review"];

export enum PullRequestReviewState {
    APPROVED = "APPROVED",
    COMMENTED = "COMMENTED",
    CHANGES_REQUESTED = "CHANGES_REQUESTED",
}

export enum CustomPullRequestReviewStatus {
    DRAFT = "draft",
    PENDING_REVIEW = "pending_review",
    CHANGES_REQUESTED = "changed_requested",
    APPROVED = "approved",
}

export interface SlackMessage {
    text: string;
    blocks: AnyBlock[];
}
