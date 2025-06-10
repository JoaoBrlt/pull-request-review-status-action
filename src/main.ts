import * as core from "@actions/core";
import * as github from "@actions/github";
import { Repository } from "@octokit/graphql-schema";
import { components } from "@octokit/openapi-types";

type OctokitClient = ReturnType<typeof github.getOctokit>;

type PullRequestReview = components["schemas"]["pull-request-review"];

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
        const previous_reviews = result.get(review.state) ?? [];
        result.set(review.state, [...previous_reviews, review]);
    }
    return result;
}

async function getReviewComments(
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

    return await octokit.graphql<{ repository: Repository }>(query, {
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
    minRequiredApprovals: number,
) {
    if (isDraft) {
        return PullRequestReviewStatus.DRAFT;
    }
    if (approvedReviews >= minRequiredApprovals && changesRequestedReviews === 0 && unresolvedReviewComments === 0) {
        return PullRequestReviewStatus.APPROVED;
    }
    if (changesRequestedReviews > 0 || unresolvedReviewComments > 0) {
        return PullRequestReviewStatus.CHANGES_REQUESTED;
    }
    return PullRequestReviewStatus.PENDING_REVIEW;
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
            await setPullRequestLabels(
                octokit,
                owner,
                repo,
                pullNumber,
                [],
                [pendingReviewLabel, changesRequestedLabel, approvedLabel],
            );
            break;
        case PullRequestReviewStatus.PENDING_REVIEW:
            await setPullRequestLabels(
                octokit,
                owner,
                repo,
                pullNumber,
                [pendingReviewLabel],
                [changesRequestedLabel, approvedLabel],
            );
            break;
        case PullRequestReviewStatus.CHANGES_REQUESTED:
            await setPullRequestLabels(
                octokit,
                owner,
                repo,
                pullNumber,
                [changesRequestedLabel],
                [pendingReviewLabel, approvedLabel],
            );
            break;
        case PullRequestReviewStatus.APPROVED:
            await setPullRequestLabels(
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

async function getLabels(octokit: OctokitClient, owner: string, repo: string, pullNumber: number) {
    const labels = await octokit.paginate(octokit.rest.issues.listLabelsOnIssue, {
        owner: owner,
        repo: repo,
        issue_number: pullNumber,
    });
    return labels.map((label) => label.name);
}

async function addLabels(octokit: OctokitClient, owner: string, repo: string, pullNumber: number, labels: string[]) {
    await octokit.rest.issues.addLabels({
        owner: owner,
        repo: repo,
        issue_number: pullNumber,
        labels: labels,
    });
}

async function removeLabel(octokit: OctokitClient, owner: string, repo: string, pullNumber: number, label: string) {
    await octokit.rest.issues.removeLabel({
        owner: owner,
        repo: repo,
        issue_number: pullNumber,
        name: label,
    });
}

async function removeLabels(octokit: OctokitClient, owner: string, repo: string, pullNumber: number, labels: string[]) {
    const currentLabels = await getLabels(octokit, owner, repo, pullNumber);
    for (const label of labels) {
        if (currentLabels.includes(label)) {
            await removeLabel(octokit, owner, repo, pullNumber, label);
        }
    }
}

async function setPullRequestLabels(
    octokit: OctokitClient,
    owner: string,
    repo: string,
    pullNumber: number,
    labelsToAdd: string[],
    labelsToRemove: string[],
) {
    await addLabels(octokit, owner, repo, pullNumber, labelsToAdd);
    await removeLabels(octokit, owner, repo, pullNumber, labelsToRemove);
}

export async function run(): Promise<void> {
    try {
        // Get the context
        const context = github.context;
        const owner = context.repo.owner;
        const repo = context.repo.repo;

        // Parse the inputs
        const token = core.getInput("github-token");
        const pullNumber = parseInt(core.getInput("pull-number"), 10);
        const pendingReviewLabel = core.getInput("pending-review-label");
        const changesRequestedLabel = core.getInput("changes-requested-label");
        const approvedLabel = core.getInput("approved-label");
        const minRequiredApprovals = parseInt(core.getInput("min-required-approvals"), 10);

        // Initialize the Octokit client
        const octokit = github.getOctokit(token);

        // Get the pull request
        const pullRequest = await getPullRequest(octokit, owner, repo, pullNumber);

        // Get pull request reviews
        const reviews = await getReviews(octokit, owner, repo, pullNumber);

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
            pullNumber,
            pullRequest.user.login,
        );

        // Determine the review status
        const reviewStatus = getReviewStatus(
            pullRequest.draft ?? false,
            approvedReviews,
            changesRequestedReviews,
            unresolvedReviewComments,
            minRequiredApprovals,
        );

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
    } catch (error) {
        if (error instanceof Error) {
            core.setFailed(error.message);
        }
    }
}
