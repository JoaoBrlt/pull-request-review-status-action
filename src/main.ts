import * as core from "@actions/core";
import * as github from "@actions/github";
import { Repository } from "@octokit/graphql-schema";
import { components } from "@octokit/openapi-types";

type PullRequestReview = components["schemas"]["pull-request-review"];

export async function run(): Promise<void> {
    try {
        // Get the inputs
        const token = core.getInput("github-token");
        const pullRequestNumber = parseInt(core.getInput("pull-request-number"), 10);
        const pendingReviewLabel = core.getInput("pending-review-label");
        const changesRequestedLabel = core.getInput("changes-requested-label");
        const approvedLabel = core.getInput("approved-label");
        const minRequiredApprovals = parseInt(core.getInput("min-required-approvals"), 10);

        // Initialize the Octokit client
        const octokit = github.getOctokit(token);
        const context = github.context;

        // Get the pull request
        const pull_request = await octokit.rest.pulls.get({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: pullRequestNumber,
        });

        // Get pull request reviews
        const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: pull_request.data.number,
        });

        // Get the latest review of each user
        const latest_review_by_user = new Map<number, PullRequestReview>();
        for (const review of reviews) {
            if (review.user == null) {
                continue;
            }

            // Skip reviews from the author
            if (review.user.id === pull_request.data.user.id) {
                continue;
            }

            // Skip "Commented" reviews as they are handled differently
            if (review.state === "COMMENTED") {
                continue;
            }

            // Always keep the latest review
            latest_review_by_user.set(review.user.id, review);
        }

        // Group pull request reviews by state
        const reviews_by_state = new Map<string, PullRequestReview[]>();
        for (const review of latest_review_by_user.values()) {
            const previous_reviews = reviews_by_state.get(review.state) ?? [];
            reviews_by_state.set(review.state, [...previous_reviews, review]);
        }
        const approved_reviews = (reviews_by_state.get("APPROVED") ?? []).length;
        const changes_requested_reviews = (reviews_by_state.get("CHANGES_REQUESTED") ?? []).length;

        // Count unresolved pull request review comments
        let unresolved_review_comments = 0;
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
        let hasNextPage = true;
        let cursor = null;
        while (hasNextPage) {
            const result: { repository?: Repository } = await octokit.graphql<{ repository: Repository }>(query, {
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: pull_request.data.number,
                cursor: cursor,
            });
            if (result?.repository?.pullRequest?.reviewThreads?.nodes != null) {
                for (const reviewThread of result.repository.pullRequest.reviewThreads.nodes) {
                    if (reviewThread?.comments?.nodes?.[0]?.author == null) {
                        continue;
                    }

                    // Skip review comments from the author
                    if (reviewThread.comments.nodes[0].author.login === pull_request.data.user.login) {
                        continue;
                    }

                    // Check the resolve status
                    if (!reviewThread.isResolved) {
                        unresolved_review_comments++;
                    }
                }
                hasNextPage = result.repository.pullRequest?.reviewThreads.pageInfo.hasNextPage;
                cursor = result.repository.pullRequest?.reviewThreads.pageInfo.endCursor;
            } else {
                hasNextPage = false;
            }
        }

        // Get pull request labels
        const labels = await octokit.paginate(octokit.rest.issues.listLabelsOnIssue, {
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: pull_request.data.number,
        });
        const labelNames = labels.map((label) => label.name);

        // Draft
        if (pull_request.data.draft) {
            if (labelNames.includes(pendingReviewLabel)) {
                await octokit.rest.issues.removeLabel({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    issue_number: pull_request.data.number,
                    name: pendingReviewLabel,
                });
            }
            if (labelNames.includes(changesRequestedLabel)) {
                await octokit.rest.issues.removeLabel({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    issue_number: pull_request.data.number,
                    name: changesRequestedLabel,
                });
            }
            if (labelNames.includes(approvedLabel)) {
                await octokit.rest.issues.removeLabel({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    issue_number: pull_request.data.number,
                    name: approvedLabel,
                });
            }
            return;
        }

        // Approved
        if (
            approved_reviews >= minRequiredApprovals &&
            changes_requested_reviews === 0 &&
            unresolved_review_comments === 0
        ) {
            if (labelNames.includes(pendingReviewLabel)) {
                await octokit.rest.issues.removeLabel({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    issue_number: pull_request.data.number,
                    name: pendingReviewLabel,
                });
            }
            if (labelNames.includes(changesRequestedLabel)) {
                await octokit.rest.issues.removeLabel({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    issue_number: pull_request.data.number,
                    name: changesRequestedLabel,
                });
            }
            if (!labelNames.includes(approvedLabel)) {
                await octokit.rest.issues.addLabels({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    issue_number: pull_request.data.number,
                    labels: [approvedLabel],
                });
            }
            return;
        }

        // Changes requested
        if (changes_requested_reviews > 0 || unresolved_review_comments > 0) {
            if (labelNames.includes(pendingReviewLabel)) {
                await octokit.rest.issues.removeLabel({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    issue_number: pull_request.data.number,
                    name: pendingReviewLabel,
                });
            }
            if (!labelNames.includes(changesRequestedLabel)) {
                await octokit.rest.issues.addLabels({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    issue_number: pull_request.data.number,
                    labels: [changesRequestedLabel],
                });
            }
            if (labelNames.includes(approvedLabel)) {
                await octokit.rest.issues.removeLabel({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    issue_number: pull_request.data.number,
                    name: approvedLabel,
                });
            }
            return;
        }

        // Pending
        if (!labelNames.includes(pendingReviewLabel)) {
            await octokit.rest.issues.addLabels({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: pull_request.data.number,
                labels: [pendingReviewLabel],
            });
        }
        if (labelNames.includes(changesRequestedLabel)) {
            await octokit.rest.issues.removeLabel({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: pull_request.data.number,
                name: changesRequestedLabel,
            });
        }
        if (labelNames.includes(approvedLabel)) {
            await octokit.rest.issues.removeLabel({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: pull_request.data.number,
                name: approvedLabel,
            });
        }
    } catch (error) {
        if (error instanceof Error) {
            core.setFailed(error.message);
        }
    }
}
