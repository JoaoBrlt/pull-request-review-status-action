import { CustomPullRequestReviewStatus, Input, OctokitClient, PullRequest } from "./types";
import * as github from "@actions/github";
import * as core from "@actions/core";
import { reviewPullRequest } from "./review";

export async function runLabelMode() {
    // Get the context
    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;

    // Parse the inputs
    const githubToken = core.getInput(Input.GITHUB_TOKEN, { required: true });
    const requiredApprovals = parseInt(core.getInput(Input.REQUIRED_APPROVALS, { required: true }), 10);
    const pullNumber = parseInt(core.getInput(Input.PULL_NUMBER, { required: true }), 10);
    const pendingReviewLabel = core.getInput(Input.PENDING_REVIEW_LABEL, { required: true });
    const changesRequestedLabel = core.getInput(Input.CHANGES_REQUESTED_LABEL, { required: true });
    const approvedLabel = core.getInput(Input.APPROVED_LABEL, { required: true });

    // Initialize the Octokit client
    const octokit = github.getOctokit(githubToken);

    // Get the pull request
    const pullRequest = await getPullRequest(octokit, owner, repo, pullNumber);

    // Get the review status of the pull request
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

async function getPullRequest(octokit: OctokitClient, owner: string, repo: string, pullNumber: number) {
    const response = await octokit.rest.pulls.get({ owner: owner, repo: repo, pull_number: pullNumber });
    return response.data;
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
    reviewStatus: CustomPullRequestReviewStatus,
    pendingReviewLabel: string,
    changesRequestedLabel: string,
    approvedLabel: string,
) {
    switch (reviewStatus) {
        case CustomPullRequestReviewStatus.DRAFT:
            await updateLabels(
                octokit,
                owner,
                repo,
                pullNumber,
                [],
                [pendingReviewLabel, changesRequestedLabel, approvedLabel],
            );
            break;
        case CustomPullRequestReviewStatus.PENDING_REVIEW:
            await updateLabels(
                octokit,
                owner,
                repo,
                pullNumber,
                [pendingReviewLabel],
                [changesRequestedLabel, approvedLabel],
            );
            break;
        case CustomPullRequestReviewStatus.CHANGES_REQUESTED:
            await updateLabels(
                octokit,
                owner,
                repo,
                pullNumber,
                [changesRequestedLabel],
                [pendingReviewLabel, approvedLabel],
            );
            break;
        case CustomPullRequestReviewStatus.APPROVED:
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
