import {
    CustomPullRequestReviewStatus,
    OctokitClient,
    PullRequest,
    PullRequestReview,
    PullRequestReviewState,
} from "./types";
import { Repository } from "@octokit/graphql-schema";

export async function reviewPullRequest(
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
    const approvedReviews = (reviewsByState.get(PullRequestReviewState.APPROVED) ?? []).length;
    const changesRequestedReviews = (reviewsByState.get(PullRequestReviewState.CHANGES_REQUESTED) ?? []).length;

    // Count unresolved pull request review comments
    const unresolvedReviewComments = await countUnresolvedReviewComments(
        octokit,
        owner,
        repo,
        pullRequest.number,
        pullRequest.user.login,
    );

    // Determine the review status of the pull request
    return getReviewStatus(
        pullRequest,
        approvedReviews,
        changesRequestedReviews,
        unresolvedReviewComments,
        requiredApprovals,
    );
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
        const reviewState = review.state as PullRequestReviewState;
        if (reviewState === PullRequestReviewState.COMMENTED) {
            continue;
        }

        // Always keep the latest review
        result.set(review.user.id, review);
    }
    return result;
}

function groupReviewsByState(latestReviewPerUser: Map<number, PullRequestReview>) {
    const result = new Map<PullRequestReviewState, PullRequestReview[]>();
    for (const review of latestReviewPerUser.values()) {
        const reviewState = review.state as PullRequestReviewState;
        const previousReviews = result.get(reviewState) ?? [];
        result.set(reviewState, [...previousReviews, review]);
    }
    return result;
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

function getReviewStatus(
    pullRequest: PullRequest,
    approvedReviews: number,
    changesRequestedReviews: number,
    unresolvedReviewComments: number,
    requiredApprovals: number,
) {
    if (pullRequest.draft) {
        return CustomPullRequestReviewStatus.DRAFT;
    }
    if (changesRequestedReviews > 0 || unresolvedReviewComments > 0) {
        return CustomPullRequestReviewStatus.CHANGES_REQUESTED;
    }
    if (approvedReviews >= requiredApprovals) {
        return CustomPullRequestReviewStatus.APPROVED;
    }
    return CustomPullRequestReviewStatus.PENDING_REVIEW;
}
