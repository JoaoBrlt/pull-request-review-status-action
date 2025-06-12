import { CustomPullRequestReviewStatus, Input, OctokitClient, PullRequest, SlackMessage } from "./types";
import { AnyBlock, RichTextSection } from "@slack/types";
import * as github from "@actions/github";
import * as core from "@actions/core";
import { WebClient } from "@slack/web-api";
import { reviewPullRequest } from "./review";

export async function runReportMode() {
    // Get the context
    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;

    // Parse the inputs
    const githubToken = core.getInput(Input.GITHUB_TOKEN, { required: true });
    const requiredApprovals = parseInt(core.getInput(Input.REQUIRED_APPROVALS, { required: true }), 10);
    const slackToken = core.getInput(Input.SLACK_TOKEN, { required: true });
    const slackChannel = core.getInput(Input.SLACK_CHANNEL, { required: true });

    // Initialize the Octokit client
    const octokit = github.getOctokit(githubToken);

    // Get the pull requests
    const pullRequests = await getPullRequests(octokit, owner, repo);

    // Review the pull requests
    const pullRequestsByReviewStatus = await groupPullRequestsByReviewStatus(
        octokit,
        owner,
        repo,
        pullRequests as PullRequest[],
        requiredApprovals,
    );

    // Build the message
    const message = buildSlackMessage(pullRequestsByReviewStatus);

    // Send the message
    await sendSlackMessage(slackToken, slackChannel, message);
}

function getPullRequests(octokit: OctokitClient, owner: string, repo: string) {
    return octokit.paginate(octokit.rest.pulls.list, {
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
    const result = new Map<CustomPullRequestReviewStatus, PullRequest[]>();
    for (const pullRequest of pullRequests) {
        const reviewStatus = await reviewPullRequest(octokit, owner, repo, pullRequest, requiredApprovals);
        const previousPullRequests = result.get(reviewStatus) ?? [];
        result.set(reviewStatus, [...previousPullRequests, pullRequest]);
    }
    return result;
}

function buildSlackMessage(
    pullRequestsByReviewStatus: Map<CustomPullRequestReviewStatus, PullRequest[]>,
): SlackMessage {
    const text = "Code Review Recap";
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
            pullRequestsByReviewStatus.get(CustomPullRequestReviewStatus.PENDING_REVIEW) ?? [],
        ),
    );
    blocks.push(
        ...buildPullRequestReviewSection(
            ":pencil2: *Changes requested*",
            pullRequestsByReviewStatus.get(CustomPullRequestReviewStatus.CHANGES_REQUESTED) ?? [],
        ),
    );
    blocks.push(
        ...buildPullRequestReviewSection(
            ":white_check_mark: *Approved*",
            pullRequestsByReviewStatus.get(CustomPullRequestReviewStatus.APPROVED) ?? [],
        ),
    );
    return { text, blocks };
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
                type: "text",
                text: pullRequest.title,
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
            {
                type: "text",
                text: " in ",
            },
            {
                type: "link",
                url: pullRequest.html_url,
                text: "#" + pullRequest.number,
            },
        ],
    };
}

async function sendSlackMessage(slackToken: string, slackChannel: string, message: SlackMessage) {
    const slackClient = new WebClient(slackToken);
    try {
        await slackClient.chat.postMessage({
            channel: slackChannel,
            text: message.text,
            blocks: message.blocks,
            unfurl_links: false,
            unfurl_media: false,
        });
        core.info("Successfully sent the message!");
    } catch (error) {
        core.setFailed("Failed to send the message: " + (error instanceof Error ? error.message : String(error)));
    }
}
