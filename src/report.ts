import {
    CustomPullRequestReviewStatus,
    FullPullRequest,
    Input,
    OctokitClient,
    PullRequest,
    SlackMessage,
} from "./types";
import { AnyBlock, RichTextSection } from "@slack/types";
import * as github from "@actions/github";
import * as core from "@actions/core";
import { RichTextBlock, RichTextEmoji, RichTextList, WebClient } from "@slack/web-api";
import { getPullRequest, reviewPullRequest } from "./shared";
import { SectionBlock } from "@slack/types/dist/block-kit/blocks";

const PULL_REQUEST_FETCH_MAX_RETRIES = 10;
const PULL_REQUEST_FETCH_DELAY = 500; // ms

export async function runReportMode() {
    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;

    const githubToken = core.getInput(Input.GITHUB_TOKEN, { required: true });
    const requiredApprovals = parseInt(core.getInput(Input.REQUIRED_APPROVALS, { required: true }), 10);
    const slackToken = core.getInput(Input.SLACK_TOKEN, { required: true });
    const slackChannel = core.getInput(Input.SLACK_CHANNEL, { required: true });
    const staleDays = parseInt(core.getInput(Input.STALE_DAYS, { required: true }), 10);

    const octokit = github.getOctokit(githubToken);

    let pullRequests = await getOpenPullRequests(octokit, owner, repo);
    pullRequests = filterDraftPullRequests(pullRequests);

    const fullPullRequests = await getFullPullRequests(octokit, owner, repo, pullRequests, staleDays);

    const pullRequestsByReviewStatus = await groupPullRequestsByReviewStatus(
        octokit,
        owner,
        repo,
        fullPullRequests,
        requiredApprovals,
    );

    const message = buildSlackMessage(fullPullRequests, pullRequestsByReviewStatus, staleDays);

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

async function getFullPullRequests(
    octokit: OctokitClient,
    owner: string,
    repo: string,
    pullRequests: PullRequest[],
    staleDays: number,
): Promise<FullPullRequest[]> {
    const result: FullPullRequest[] = [];
    for (const pullRequest of pullRequests) {
        const fullPullRequest = await getFullPullRequest(octokit, owner, repo, pullRequest.number, staleDays);
        result.push(fullPullRequest);
    }
    return result;
}

async function getFullPullRequest(
    octokit: OctokitClient,
    owner: string,
    repo: string,
    pullNumber: number,
    staleDays: number,
): Promise<FullPullRequest> {
    let lastPullRequest: PullRequest;

    for (let attempt = 1; attempt <= PULL_REQUEST_FETCH_MAX_RETRIES; attempt++) {
        const pullRequest = await getPullRequest(octokit, owner, repo, pullNumber);
        lastPullRequest = pullRequest;

        if (pullRequest.mergeable != null) {
            return {
                ...pullRequest,
                hasBuildFailure: await hasBuildFailure(octokit, owner, repo, pullRequest),
                hasMergeConflicts: hasMergeConflicts(pullRequest),
                isStale: isStale(pullRequest, staleDays),
            };
        }

        if (attempt < PULL_REQUEST_FETCH_MAX_RETRIES) {
            await sleep(PULL_REQUEST_FETCH_DELAY);
        }
    }

    return {
        ...lastPullRequest!,
        hasBuildFailure: false,
        hasMergeConflicts: false,
        isStale: false,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hasBuildFailure(octokit: OctokitClient, owner: string, repo: string, pullRequest: PullRequest) {
    const combinedStatus = await getPullRequestCombinedStatus(octokit, owner, repo, pullRequest);
    return combinedStatus.state === "failure";
}

function hasMergeConflicts(pullRequest: PullRequest) {
    return pullRequest.mergeable === false;
}

function isStale(pullRequest: PullRequest, staleDays: number) {
    const now = new Date();
    const creationDate = new Date(pullRequest.created_at);
    const cutoffDate = new Date();
    cutoffDate.setDate(now.getDate() - staleDays);
    return creationDate < cutoffDate;
}

async function groupPullRequestsByReviewStatus(
    octokit: OctokitClient,
    owner: string,
    repo: string,
    pullRequests: FullPullRequest[],
    requiredApprovals: number,
) {
    const result = new Map<CustomPullRequestReviewStatus, FullPullRequest[]>();
    for (const pullRequest of pullRequests) {
        const reviewStatus = await reviewPullRequest(octokit, owner, repo, pullRequest, requiredApprovals);
        const previousPullRequests = result.get(reviewStatus) ?? [];
        result.set(reviewStatus, [...previousPullRequests, pullRequest]);
    }
    return result;
}

function buildSlackMessage(
    pullRequests: FullPullRequest[],
    pullRequestsByReviewStatus: Map<CustomPullRequestReviewStatus, FullPullRequest[]>,
    staleDays: number,
): SlackMessage {
    const text = "Pull Request Summary";
    const blocks: AnyBlock[] = [];

    blocks.push(buildMarkdownSectionBlock(":loudspeaker: *Pull Request Summary* :loudspeaker:"));
    blocks.push(buildMarkdownSectionBlock(`*Total open PRs*: ${pullRequests.length}`));
    blocks.push(buildMarkdownSectionBlock(" "));
    blocks.push(
        buildPullRequestGroupBlock(
            "eyes",
            "Pending review",
            pullRequestsByReviewStatus.get(CustomPullRequestReviewStatus.PENDING_REVIEW) ?? [],
        ),
    );
    blocks.push(buildMarkdownSectionBlock(" "));
    blocks.push(
        buildPullRequestGroupBlock(
            "pencil2",
            "Changes requested",
            pullRequestsByReviewStatus.get(CustomPullRequestReviewStatus.CHANGES_REQUESTED) ?? [],
        ),
    );
    blocks.push(buildMarkdownSectionBlock(" "));
    blocks.push(
        buildPullRequestGroupBlock(
            "white_check_mark",
            "Approved",
            pullRequestsByReviewStatus.get(CustomPullRequestReviewStatus.APPROVED) ?? [],
        ),
    );
    blocks.push(buildMarkdownSectionBlock(" "));
    blocks.push(buildEmojiLegendBlock(staleDays));
    blocks.push(buildMarkdownSectionBlock(" "));

    return { text, blocks };
}

function buildMarkdownSectionBlock(text: string): SectionBlock {
    return {
        type: "section",
        text: {
            type: "mrkdwn",
            text,
        },
    };
}

function buildPullRequestGroupBlock(emoji: string, title: string, pullRequests: FullPullRequest[]): RichTextBlock {
    return {
        type: "rich_text",
        elements: [buildPullRequestGroupTitle(emoji, title, pullRequests), buildPullRequestGroupList(pullRequests)],
    };
}

function buildPullRequestGroupTitle(emoji: string, title: string, pullRequests: FullPullRequest[]): RichTextSection {
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

function buildPullRequestGroupList(pullRequests: FullPullRequest[]): RichTextList {
    return {
        type: "rich_text_list",
        style: "bullet",
        indent: 0,
        elements: buildPullRequestListItems(pullRequests),
    };
}

function buildPullRequestListItems(pullRequests: FullPullRequest[]): RichTextSection[] {
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

function buildPullRequestListItem(pullRequest: FullPullRequest): RichTextSection {
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
            {
                type: "text",
                text: " ",
            },
            ...(pullRequest.hasBuildFailure ? [buildRichTextEmoji("rotating_light")] : []),
            ...(pullRequest.hasMergeConflicts ? [buildRichTextEmoji("crossed_swords")] : []),
            ...(pullRequest.isStale ? [buildRichTextEmoji("ice_cube")] : []),
        ],
    };
}

async function getPullRequestCombinedStatus(
    octokit: OctokitClient,
    owner: string,
    repo: string,
    pullRequest: PullRequest,
) {
    const response = await octokit.rest.repos.getCombinedStatusForRef({
        owner,
        repo,
        ref: pullRequest.head.sha,
    });
    return response.data;
}

function buildRichTextEmoji(name: string): RichTextEmoji {
    return {
        type: "emoji",
        name,
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

function buildEmojiLegendBlock(staleDays: number) {
    return {
        type: "rich_text",
        elements: [
            {
                type: "rich_text_section",
                elements: [
                    {
                        type: "text",
                        text: "Legend:",
                        style: {
                            bold: true,
                        },
                    },
                ],
            },
            {
                type: "rich_text_section",
                elements: [
                    {
                        type: "emoji",
                        name: "rotating_light",
                    },
                    {
                        type: "text",
                        text: " = Merge conflicts",
                    },
                ],
            },
            {
                type: "rich_text_section",
                elements: [
                    {
                        type: "emoji",
                        name: "crossed_swords",
                    },
                    {
                        type: "text",
                        text: " = Merge conflicts",
                    },
                ],
            },
            {
                type: "rich_text_section",
                elements: [
                    {
                        type: "emoji",
                        name: "ice_cube",
                    },
                    {
                        type: "text",
                        text: ` = Stale PR (> ${staleDays} days)`,
                    },
                ],
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
