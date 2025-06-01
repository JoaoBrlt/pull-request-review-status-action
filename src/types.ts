import { components } from "@octokit/openapi-types";
import { AnyBlock } from "@slack/types";
import { GitHub } from "@actions/github/lib/utils";
import { Repository } from "@octokit/graphql-schema";

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
    STALE_DAYS = "stale-days",
}

export enum RunMode {
    LABEL = "label",
    REPORT = "report",
}

export type OctokitClient = InstanceType<typeof GitHub>;

export interface OctokitGraphQLResponse {
    repository: Repository;
}

export type PullRequest = components["schemas"]["pull-request"];

export type PullRequestReview = components["schemas"]["pull-request-review"];

export enum PullRequestReviewState {
    APPROVED = "APPROVED",
    COMMENTED = "COMMENTED",
    CHANGES_REQUESTED = "CHANGES_REQUESTED",
}

export type CheckRun = components["schemas"]["check-run"];

export interface PullRequestReviewStatusResponse {
    reviewStatus: PullRequestReviewStatus;
    approvedReviews: number;
    changesRequestedReviews: number;
    unresolvedReviewComments: number;
}

export enum PullRequestReviewStatus {
    DRAFT = "draft",
    PENDING_REVIEW = "pending_review",
    CHANGES_REQUESTED = "changes_requested",
    APPROVED = "approved",
}

export interface FullPullRequest extends PullRequest {
    hasBuildFailure: boolean;
    hasMergeConflicts: boolean;
    isStale: boolean;
}

export interface SlackMessage {
    text: string;
    blocks: AnyBlock[];
}
