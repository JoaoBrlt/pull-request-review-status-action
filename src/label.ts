import { Input, OctokitClient, PullRequestReviewStatus } from "./types";
import * as github from "@actions/github";
import * as core from "@actions/core";
import { getPullRequest, reviewPullRequest } from "./shared";

export async function runLabelMode(): Promise<void> {
    // Parse the inputs
    const githubToken = core.getInput(Input.GITHUB_TOKEN, { required: true });
    const requiredApprovals = parseInt(core.getInput(Input.REQUIRED_APPROVALS, { required: true }), 10);
    const pullNumber = parseInt(core.getInput(Input.PULL_NUMBER, { required: true }), 10);
    const pendingReviewLabel = core.getInput(Input.PENDING_REVIEW_LABEL, { required: true });
    const changesRequestedLabel = core.getInput(Input.CHANGES_REQUESTED_LABEL, { required: true });
    const approvedLabel = core.getInput(Input.APPROVED_LABEL, { required: true });

    // Get the context variables
    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;

    // Initialize the Octokit client
    const octokit = github.getOctokit(githubToken);

    // Get the pull request
    const pullRequest = await getPullRequest(octokit, owner, repo, pullNumber);

    // Review the pull request
    const { reviewStatus, approvedReviews, changesRequestedReviews, unresolvedReviewComments } =
        await reviewPullRequest(octokit, owner, repo, pullRequest, requiredApprovals);
    core.info(`Approved reviews: ${approvedReviews}`);
    core.info(`Changes requested reviews: ${changesRequestedReviews}`);
    core.info(`Unresolved review comments: ${unresolvedReviewComments}`);
    core.info(`Review status: ${reviewStatus}`);

    // Label the pull request
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

async function getLabels(octokit: OctokitClient, owner: string, repo: string, pullNumber: number): Promise<string[]> {
    const labels = await octokit.paginate(octokit.rest.issues.listLabelsOnIssue, {
        owner: owner,
        repo: repo,
        issue_number: pullNumber,
    });
    return labels.map((label) => label.name);
}

async function addLabel(
    octokit: OctokitClient,
    owner: string,
    repo: string,
    pullNumber: number,
    label: string,
): Promise<void> {
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
): Promise<void> {
    for (const label of labelsToAdd) {
        if (!currentLabels.includes(label)) {
            await addLabel(octokit, owner, repo, pullNumber, label);
        }
    }
}

async function removeLabel(
    octokit: OctokitClient,
    owner: string,
    repo: string,
    pullNumber: number,
    label: string,
): Promise<void> {
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
): Promise<void> {
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
): Promise<void> {
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
): Promise<void> {
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
