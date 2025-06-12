import { CustomPullRequestReviewStatus, Input, OctokitClient, PullRequest, SlackMessage } from "./types";
import { AnyBlock, RichTextSection } from "@slack/types";
import * as github from "@actions/github";
import * as core from "@actions/core";
import { RichTextBlock, RichTextList, WebClient } from "@slack/web-api";
import { reviewPullRequest } from "./review";
import { SectionBlock } from "@slack/types/dist/block-kit/blocks";

export async function runReportMode() {
    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;

    const githubToken = core.getInput(Input.GITHUB_TOKEN, { required: true });
    const requiredApprovals = parseInt(core.getInput(Input.REQUIRED_APPROVALS, { required: true }), 10);
    const slackToken = core.getInput(Input.SLACK_TOKEN, { required: true });
    const slackChannel = core.getInput(Input.SLACK_CHANNEL, { required: true });

    const octokit = github.getOctokit(githubToken);

    let pullRequests = await getOpenPullRequests(octokit, owner, repo);
    pullRequests = filterDraftPullRequests(pullRequests);
    console.log("PULL REQUESTS:", pullRequests);

    const pullRequestsByReviewStatus = await groupPullRequestsByReviewStatus(
        octokit,
        owner,
        repo,
        pullRequests,
        requiredApprovals,
    );

    const message = buildSlackMessage(pullRequests, pullRequestsByReviewStatus);

    await sendSlackMessage(slackToken, slackChannel, message);
}

async function getOpenPullRequests(octokit: OctokitClient, owner: string, repo: string) {
    const response = await octokit.paginate(octokit.rest.pulls.list, {
        owner: owner,
        repo: repo,
        state: "open",
        sort: "created",
        direction: "asc",
    });
    return response as PullRequest[];
}

function filterDraftPullRequests(pullRequests: PullRequest[]) {
    return pullRequests.filter((pullRequest) => !pullRequest.draft);
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
    pullRequests: PullRequest[],
    pullRequestsByReviewStatus: Map<CustomPullRequestReviewStatus, PullRequest[]>,
): SlackMessage {
    const text = "Pull Request Summary";
    const blocks: AnyBlock[] = [];

    const spacer = buildSpacerSectionBlock();

    blocks.push({
        type: "section",
        text: {
            type: "mrkdwn",
            text: ":loudspeaker: *Pull Request Summary* :loudspeaker:",
        },
    });
    blocks.push({
        type: "section",
        text: {
            type: "mrkdwn",
            text: `*Total open PRs*: ${pullRequests.length}`,
        },
    });
    blocks.push(spacer);
    blocks.push(
        buildPullRequestGroupBlock(
            "eyes",
            "Pending review",
            pullRequestsByReviewStatus.get(CustomPullRequestReviewStatus.PENDING_REVIEW) ?? [],
        ),
    );
    blocks.push(spacer);
    blocks.push(
        buildPullRequestGroupBlock(
            "pencil2",
            "Changes requested",
            pullRequestsByReviewStatus.get(CustomPullRequestReviewStatus.CHANGES_REQUESTED) ?? [],
        ),
    );
    blocks.push(spacer);
    blocks.push(
        buildPullRequestGroupBlock(
            "white_check_mark",
            "Approved",
            pullRequestsByReviewStatus.get(CustomPullRequestReviewStatus.APPROVED) ?? [],
        ),
    );
    blocks.push(spacer);

    return { text, blocks };
}

function buildSpacerSectionBlock(): SectionBlock {
    return {
        type: "section",
        text: {
            type: "mrkdwn",
            text: " ",
        },
    };
}

function buildPullRequestGroupBlock(emoji: string, title: string, pullRequests: PullRequest[]): RichTextBlock {
    return {
        type: "rich_text",
        elements: [buildPullRequestGroupTitle(emoji, title, pullRequests), buildPullRequestGroupList(pullRequests)],
    };
}

function buildPullRequestGroupTitle(emoji: string, title: string, pullRequests: PullRequest[]): RichTextSection {
    return {
        type: "rich_text_section",
        elements: [
            {
                type: "emoji",
                name: emoji,
            },
            {
                type: "text",
                text: " ",
            },
            {
                type: "text",
                text: `${title} (${pullRequests.length})`,
                style: {
                    bold: true,
                },
            },
        ],
    };
}

function buildPullRequestGroupList(pullRequests: PullRequest[]): RichTextList {
    return {
        type: "rich_text_list",
        style: "bullet",
        indent: 0,
        elements: buildPullRequestListItems(pullRequests),
    };
}

function buildPullRequestListItems(pullRequests: PullRequest[]): RichTextSection[] {
    const listItems: RichTextSection[] = [];
    if (pullRequests.length > 0) {
        for (const pullRequest of pullRequests) {
            listItems.push(buildPullRequestListItem(pullRequest));
        }
    } else {
        listItems.push(buildPullRequestEmptyListItem());
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
                text: `${pullRequest.title} (#${pullRequest.number})`,
            },
            {
                type: "text",
                text: " by ",
            },
            {
                type: "link",
                url: pullRequest.user.html_url,
                text: `@${pullRequest.user.login}`,
            },
        ],
    };
}

function buildPullRequestEmptyListItem(): RichTextSection {
    return {
        type: "rich_text_section",
        elements: [
            {
                type: "text",
                text: "None",
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
