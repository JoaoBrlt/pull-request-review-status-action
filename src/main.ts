import * as core from "@actions/core";
import * as github from "@actions/github";
import { Repository } from "@octokit/graphql-schema";
import { components } from "@octokit/openapi-types";
import { WebClient } from "@slack/web-api";
import { AnyBlock } from "@slack/types/dist/block-kit/blocks";
import { RichTextSection } from "@slack/types/dist/block-kit/block-elements";

type OctokitClient = ReturnType<typeof github.getOctokit>;

type PullRequest = components["schemas"]["pull-request"];

type PullRequestReview = components["schemas"]["pull-request-review"];

type SlackMessage = { blocks: AnyBlock[] };

enum PullRequestReviewStatus {
    DRAFT,
    PENDING_REVIEW,
    CHANGES_REQUESTED,
    APPROVED,
}

async function getPullRequest(octokit: OctokitClient, owner: string, repo: string, pullNumber: number) {
    const response = await octokit.rest.pulls.get({ owner: owner, repo: repo, pull_number: pullNumber });
    return response.data;
}

function getReviews(octokit: OctokitClient, owner: string, repo: string, pullNumber: number) {
    return octokit.paginate(octokit.rest.pulls.listReviews, {
        owner: owner,
        repo: repo,
        pull_number: pullNumber,
    });
}

function getLatestReviewPerUser(reviews: PullRequestReview[], author_id: number) {
    const result = new Map<number, PullRequestReview>();
    for (const review of reviews) {
        // Skip if the review is invalid
        if (review.user == null) {
            continue;
        }

        // Skip reviews from the author
        if (review.user.id === author_id) {
            continue;
        }

        // Skip "Commented" reviews as they are handled differently
        if (review.state === "COMMENTED") {
            continue;
        }

        // Always keep the latest review
        result.set(review.user.id, review);
    }
    return result;
}

function groupReviewsByState(latestReviewPerUser: Map<number, PullRequestReview>) {
    const result = new Map<string, PullRequestReview[]>();
    for (const review of latestReviewPerUser.values()) {
        const previousReviews = result.get(review.state) ?? [];
        result.set(review.state, [...previousReviews, review]);
    }
    return result;
}

function getReviewComments(
    octokit: OctokitClient,
    owner: string,
    repo: string,
    pullNumber: number,
    cursor: string | null | undefined,
) {
    const query = `query($owner: String!, $repo: String!, $pull_number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pull_number) {
          reviewThreads(first: 100, after: $cursor) {
            nodes {
              id
              isResolved
              comments(first: 1) {
                nodes {
                  author {
                    login
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }`;

    return octokit.graphql<{ repository: Repository }>(query, {
        owner: owner,
        repo: repo,
        pull_number: pullNumber,
        cursor: cursor,
    });
}

async function countUnresolvedReviewComments(
    octokit: OctokitClient,
    owner: string,
    repo: string,
    pullNumber: number,
    authorLogin: string,
) {
    let result = 0;

    let hasNextPage = true;
    let cursor: string | null | undefined = null;

    while (hasNextPage) {
        const response = await getReviewComments(octokit, owner, repo, pullNumber, cursor);

        // Skip if the response is invalid
        if (response.repository.pullRequest?.reviewThreads?.nodes == null) {
            hasNextPage = false;
            continue;
        }

        for (const reviewThread of response.repository.pullRequest.reviewThreads.nodes) {
            // Skip if the review comment is invalid
            if (reviewThread?.comments?.nodes?.[0]?.author == null) {
                continue;
            }

            // Skip review comments from the author
            if (reviewThread.comments.nodes[0].author.login === authorLogin) {
                continue;
            }

            // Check the resolve status
            if (!reviewThread.isResolved) {
                result++;
            }
        }

        hasNextPage = response.repository.pullRequest.reviewThreads.pageInfo.hasNextPage;
        cursor = response.repository.pullRequest.reviewThreads.pageInfo.endCursor;
    }

    return result;
}

function getReviewStatus(
    isDraft: boolean,
    approvedReviews: number,
    changesRequestedReviews: number,
    unresolvedReviewComments: number,
    requiredApprovals: number,
) {
    if (isDraft) {
        return PullRequestReviewStatus.DRAFT;
    }
    if (changesRequestedReviews > 0 || unresolvedReviewComments > 0) {
        return PullRequestReviewStatus.CHANGES_REQUESTED;
    }
    if (approvedReviews >= requiredApprovals) {
        return PullRequestReviewStatus.APPROVED;
    }
    return PullRequestReviewStatus.PENDING_REVIEW;
}

async function reviewPullRequest(
    octokit: OctokitClient,
    owner: string,
    repo: string,
    pullRequest: PullRequest,
    requiredApprovals: number,
) {
    // Get pull request reviews
    const reviews = await getReviews(octokit, owner, repo, pullRequest.number);

    // Get the latest review of each user
    const latestReviewPerUser = getLatestReviewPerUser(reviews, pullRequest.user.id);

    // Group pull request reviews by state
    const reviewsByState = groupReviewsByState(latestReviewPerUser);
    const approvedReviews = (reviewsByState.get("APPROVED") ?? []).length;
    const changesRequestedReviews = (reviewsByState.get("CHANGES_REQUESTED") ?? []).length;

    // Count unresolved pull request review comments
    const unresolvedReviewComments = await countUnresolvedReviewComments(
        octokit,
        owner,
        repo,
        pullRequest.number,
        pullRequest.user.login,
    );

    // Determine the review status
    return getReviewStatus(
        pullRequest.draft ?? false,
        approvedReviews,
        changesRequestedReviews,
        unresolvedReviewComments,
        requiredApprovals,
    );
}

async function getLabels(octokit: OctokitClient, owner: string, repo: string, pullNumber: number) {
    const labels = await octokit.paginate(octokit.rest.issues.listLabelsOnIssue, {
        owner: owner,
        repo: repo,
        issue_number: pullNumber,
    });
    return labels.map((label) => label.name);
}

async function addLabel(octokit: OctokitClient, owner: string, repo: string, pullNumber: number, label: string) {
    await octokit.rest.issues.addLabels({
        owner: owner,
        repo: repo,
        issue_number: pullNumber,
        labels: [label],
    });
}

async function addLabels(
    octokit: OctokitClient,
    owner: string,
    repo: string,
    pullNumber: number,
    currentLabels: string[],
    labelsToAdd: string[],
) {
    for (const label of labelsToAdd) {
        if (!currentLabels.includes(label)) {
            await addLabel(octokit, owner, repo, pullNumber, label);
        }
    }
}

async function removeLabel(octokit: OctokitClient, owner: string, repo: string, pullNumber: number, label: string) {
    await octokit.rest.issues.removeLabel({
        owner: owner,
        repo: repo,
        issue_number: pullNumber,
        name: label,
    });
}

async function removeLabels(
    octokit: OctokitClient,
    owner: string,
    repo: string,
    pullNumber: number,
    currentLabels: string[],
    labelsToRemove: string[],
) {
    for (const label of labelsToRemove) {
        if (currentLabels.includes(label)) {
            await removeLabel(octokit, owner, repo, pullNumber, label);
        }
    }
}

async function updateLabels(
    octokit: OctokitClient,
    owner: string,
    repo: string,
    pullNumber: number,
    labelsToAdd: string[],
    labelsToRemove: string[],
) {
    const currentLabels = await getLabels(octokit, owner, repo, pullNumber);
    await addLabels(octokit, owner, repo, pullNumber, currentLabels, labelsToAdd);
    await removeLabels(octokit, owner, repo, pullNumber, currentLabels, labelsToRemove);
}

async function labelPullRequest(
    octokit: OctokitClient,
    owner: string,
    repo: string,
    pullNumber: number,
    reviewStatus: PullRequestReviewStatus,
    pendingReviewLabel: string,
    changesRequestedLabel: string,
    approvedLabel: string,
) {
    switch (reviewStatus) {
        case PullRequestReviewStatus.DRAFT:
            await updateLabels(
                octokit,
                owner,
                repo,
                pullNumber,
                [],
                [pendingReviewLabel, changesRequestedLabel, approvedLabel],
            );
            break;
        case PullRequestReviewStatus.PENDING_REVIEW:
            await updateLabels(
                octokit,
                owner,
                repo,
                pullNumber,
                [pendingReviewLabel],
                [changesRequestedLabel, approvedLabel],
            );
            break;
        case PullRequestReviewStatus.CHANGES_REQUESTED:
            await updateLabels(
                octokit,
                owner,
                repo,
                pullNumber,
                [changesRequestedLabel],
                [pendingReviewLabel, approvedLabel],
            );
            break;
        case PullRequestReviewStatus.APPROVED:
            await updateLabels(
                octokit,
                owner,
                repo,
                pullNumber,
                [approvedLabel],
                [pendingReviewLabel, changesRequestedLabel],
            );
            break;
    }
}

async function getPullRequests(octokit: OctokitClient, owner: string, repo: string) {
    return await octokit.paginate(octokit.rest.pulls.list, {
        owner: owner,
        repo: repo,
        state: "open",
        sort: "created",
        direction: "asc",
    });
}

async function groupPullRequestsByReviewStatus(
    octokit: OctokitClient,
    owner: string,
    repo: string,
    pullRequests: PullRequest[],
    requiredApprovals: number,
) {
    const result = new Map<PullRequestReviewStatus, PullRequest[]>();
    for (const pullRequest of pullRequests) {
        const reviewStatus = await reviewPullRequest(octokit, owner, repo, pullRequest, requiredApprovals);
        const previousPullRequests = result.get(reviewStatus) ?? [];
        result.set(reviewStatus, [...previousPullRequests, pullRequest]);
    }
    return result;
}

async function runLabelMode() {
    // Parse the inputs
    const githubToken = core.getInput("github-token", { required: true });
    const requiredApprovals = parseInt(core.getInput("required-approvals", { required: true }), 10);
    const pullNumber = parseInt(core.getInput("pull-number", { required: true }), 10);
    const pendingReviewLabel = core.getInput("pending-review-label", { required: true });
    const changesRequestedLabel = core.getInput("changes-requested-label", { required: true });
    const approvedLabel = core.getInput("approved-label", { required: true });

    // Get the context
    const context = github.context;
    const owner = context.repo.owner;
    const repo = context.repo.repo;

    // Initialize the Octokit client
    const octokit = github.getOctokit(githubToken);

    // Get the pull request
    const pullRequest = await getPullRequest(octokit, owner, repo, pullNumber);

    // Determine the review status of the pull request
    const reviewStatus = await reviewPullRequest(octokit, owner, repo, pullRequest as PullRequest, requiredApprovals);

    // Label the pull request according to the review status
    await labelPullRequest(
        octokit,
        owner,
        repo,
        pullNumber,
        reviewStatus,
        pendingReviewLabel,
        changesRequestedLabel,
        approvedLabel,
    );
}

function buildPullRequestReviewSection(title: string, pullRequests: PullRequest[]): AnyBlock[] {
    const blocks: AnyBlock[] = [];
    blocks.push({
        type: "section",
        text: {
            type: "mrkdwn",
            text: title,
        },
    });
    blocks.push({
        type: "rich_text",
        elements: [
            {
                type: "rich_text_list",
                style: "bullet",
                indent: 0,
                elements: buildPullRequestListItems(pullRequests),
            },
        ],
    });
    return blocks;
}

function buildPullRequestListItems(pullRequests: PullRequest[]): RichTextSection[] {
    const listItems: RichTextSection[] = [];
    if (pullRequests.length > 0) {
        for (const pullRequest of pullRequests) {
            listItems.push(buildPullRequestListItem(pullRequest));
        }
    } else {
        listItems.push({
            type: "rich_text_section",
            elements: [
                {
                    type: "text",
                    text: "None",
                },
            ],
        });
    }
    return listItems;
}

function buildPullRequestListItem(pullRequest: PullRequest): RichTextSection {
    return {
        type: "rich_text_section",
        elements: [
            {
                type: "link",
                url: pullRequest.html_url,
                text: pullRequest.title + " (#" + pullRequest.number + ")",
            },
            {
                type: "text",
                text: " by ",
            },
            {
                type: "link",
                url: pullRequest.user.html_url,
                text: "@" + pullRequest.user.login,
            },
        ],
    };
}

function buildSlackMessage(pullRequestsByReviewStatus: Map<PullRequestReviewStatus, PullRequest[]>): SlackMessage {
    const blocks: AnyBlock[] = [];
    blocks.push({
        type: "section",
        text: {
            type: "mrkdwn",
            text: ":loudspeaker: *Code Review Recap* :loudspeaker:",
        },
    });
    blocks.push(
        ...buildPullRequestReviewSection(
            ":eyes: *Pending*",
            pullRequestsByReviewStatus.get(PullRequestReviewStatus.PENDING_REVIEW) ?? [],
        ),
    );
    blocks.push(
        ...buildPullRequestReviewSection(
            ":pencil2: *Changes requested*",
            pullRequestsByReviewStatus.get(PullRequestReviewStatus.CHANGES_REQUESTED) ?? [],
        ),
    );
    blocks.push(
        ...buildPullRequestReviewSection(
            ":white_check_mark: *Approved*",
            pullRequestsByReviewStatus.get(PullRequestReviewStatus.CHANGES_REQUESTED) ?? [],
        ),
    );
    return { blocks };
}

async function sendSlackMessage(slackToken: string, slackChannel: string, message: SlackMessage) {
    const slackClient = new WebClient(slackToken);
    try {
        await slackClient.chat.postMessage({
            channel: slackChannel,
            blocks: message.blocks,
        });
        core.info("Successfully sent the message!");
    } catch (error) {
        core.setFailed("Failed to send the message: " + (error instanceof Error ? error.message : ""));
    }
}

async function runReportMode() {
    // Parse the inputs
    const githubToken = core.getInput("github-token", { required: true });
    const requiredApprovals = parseInt(core.getInput("required-approvals", { required: true }), 10);
    const slackToken = core.getInput("slack-token", { required: true });
    const slackChannel = core.getInput("slack-channel", { required: true });

    // Get the context
    const context = github.context;
    const owner = context.repo.owner;
    const repo = context.repo.repo;

    // Initialize the Octokit client
    const octokit = github.getOctokit(githubToken);

    // Get the pull requests
    const pullRequests = getPullRequests(octokit, owner, repo);

    // Review the pull requests
    const pullRequestsByReviewStatus = await groupPullRequestsByReviewStatus(
        octokit,
        owner,
        repo,
        pullRequests as unknown as PullRequest[],
        requiredApprovals,
    );

    // Build the message
    const message = buildSlackMessage(pullRequestsByReviewStatus);

    // Send the message
    await sendSlackMessage(slackToken, slackChannel, message);
}

export async function run(): Promise<void> {
    try {
        const runMode = core.getInput("run-mode");
        switch (runMode) {
            case "label":
                await runLabelMode();
                break;
            case "report":
                await runReportMode();
                break;
            default:
                core.setFailed(`Unsupported run mode: ${runMode}`);
                break;
        }
    } catch (error) {
        core.setFailed("Failed to run the action: " + (error instanceof Error ? error.message : ""));
    }
}
