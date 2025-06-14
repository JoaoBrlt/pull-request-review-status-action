import {
  CheckRun,
  FullPullRequest,
  Input,
  OctokitClient,
  PullRequest,
  PullRequestReviewStatus,
  SlackMessage,
} from "./types";
import * as github from "@actions/github";
import * as core from "@actions/core";
import { WebClient } from "@slack/web-api";
import { AnyBlock, RichTextBlock, RichTextEmoji, RichTextList, RichTextSection, SectionBlock } from "@slack/types";
import { getPullRequest, reviewPullRequest } from "./shared";

const PULL_REQUEST_FETCH_MAX_RETRIES = 10;
const PULL_REQUEST_FETCH_DELAY = 500; // ms

export async function runReportMode(): Promise<void> {
  // Parse the inputs
  const githubToken = core.getInput(Input.GITHUB_TOKEN, { required: true });
  const requiredApprovals = parseInt(core.getInput(Input.REQUIRED_APPROVALS, { required: true }), 10);
  const slackToken = core.getInput(Input.SLACK_TOKEN, { required: true });
  const slackChannel = core.getInput(Input.SLACK_CHANNEL, { required: true });
  const staleDays = parseInt(core.getInput(Input.STALE_DAYS, { required: true }), 10);

  // Get the context variables
  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;

  // Initialize the Octokit client
  const octokit = github.getOctokit(githubToken);

  // Get the open pull requests
  let pullRequests = await getOpenPullRequests(octokit, owner, repo);
  pullRequests = filterDraftPullRequests(pullRequests);

  // Count the open pull requests
  const totalPullRequests = pullRequests.length;
  core.info(`Total open pull requests: ${totalPullRequests}`);

  // Enrich the pull requests
  const fullPullRequests = await processPullRequests(octokit, owner, repo, pullRequests, staleDays);

  // Review the pull requests and group them by review status
  const pullRequestsByReviewStatus = await groupPullRequestsByReviewStatus(
    octokit,
    owner,
    repo,
    fullPullRequests,
    requiredApprovals,
  );

  // Get the pull requests pending review
  const pendingReviewPullRequests = pullRequestsByReviewStatus.get(PullRequestReviewStatus.PENDING_REVIEW) ?? [];
  core.info(`Pending review pull requests: ${pendingReviewPullRequests.length}`);

  // Get the pull requests with requested changes
  const changesRequestedPullRequests = pullRequestsByReviewStatus.get(PullRequestReviewStatus.CHANGES_REQUESTED) ?? [];
  core.info(`Changes requested pull requests: ${changesRequestedPullRequests.length}`);

  // Get the approved pull requests
  const approvedPullRequests = pullRequestsByReviewStatus.get(PullRequestReviewStatus.APPROVED) ?? [];
  core.info(`Approved pull requests: ${approvedPullRequests.length}`);

  // Build the Slack message
  const message = buildSlackMessage(
    totalPullRequests,
    pendingReviewPullRequests,
    changesRequestedPullRequests,
    approvedPullRequests,
    staleDays,
  );

  // Send the Slack message
  await sendSlackMessage(slackToken, slackChannel, message);
}

async function getOpenPullRequests(octokit: OctokitClient, owner: string, repo: string): Promise<PullRequest[]> {
  const response = await octokit.paginate(octokit.rest.pulls.list, {
    owner: owner,
    repo: repo,
    state: "open",
    sort: "created",
    direction: "asc",
  });
  return response as PullRequest[];
}

function filterDraftPullRequests(pullRequests: PullRequest[]): PullRequest[] {
  return pullRequests.filter((pullRequest) => !pullRequest.draft);
}

async function processPullRequests(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  pullRequests: PullRequest[],
  staleDays: number,
): Promise<FullPullRequest[]> {
  const result: FullPullRequest[] = [];
  for (const pullRequest of pullRequests) {
    const fullPullRequest = await processPullRequest(octokit, owner, repo, pullRequest.number, staleDays);
    result.push(fullPullRequest);
  }
  return result;
}

async function processPullRequest(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  pullNumber: number,
  staleDays: number,
): Promise<FullPullRequest> {
  let lastPullRequest: PullRequest | undefined;

  for (let attempt = 1; attempt <= PULL_REQUEST_FETCH_MAX_RETRIES; attempt++) {
    const pullRequest = await getPullRequest(octokit, owner, repo, pullNumber);
    lastPullRequest = pullRequest;

    // The mergeable state takes some time to be computed by GitHub
    if (pullRequest.mergeable != null) {
      core.info(`Found the mergeable state of the pull request #${pullNumber} on attempt ${attempt}`);
      return {
        ...pullRequest,
        hasBuildFailure: await hasPullRequestBuildFailure(octokit, owner, repo, pullRequest),
        hasMergeConflicts: hasPullRequestMergeConflicts(pullRequest),
        isStale: isPullRequestStale(pullRequest, staleDays),
      };
    }

    if (attempt < PULL_REQUEST_FETCH_MAX_RETRIES) {
      await sleep(PULL_REQUEST_FETCH_DELAY);
    }
  }

  // In this case, we don't know the mergeable state of the pull request
  core.warning(`Unable to get the mergeable state of the pull request #${pullNumber}`);
  return {
    ...lastPullRequest!,
    hasBuildFailure: await hasPullRequestBuildFailure(octokit, owner, repo, lastPullRequest!),
    hasMergeConflicts: false,
    isStale: isPullRequestStale(lastPullRequest!, staleDays),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hasPullRequestBuildFailure(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  pullRequest: PullRequest,
): Promise<boolean> {
  const checkRuns = await getPullRequestCheckRuns(octokit, owner, repo, pullRequest);
  return checkRuns.some((checkRun) => isCheckRunCompleted(checkRun) && isCheckRunFailed(checkRun));
}

async function getPullRequestCheckRuns(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  pullRequest: PullRequest,
): Promise<CheckRun[]> {
  const response = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref: pullRequest.head.sha,
  });
  return response.data.check_runs as CheckRun[];
}

function isCheckRunCompleted(checkRun: CheckRun): boolean {
  return checkRun.status === "completed";
}

function isCheckRunFailed(checkRun: CheckRun): boolean {
  return checkRun.conclusion != null && ["failure", "cancelled", "timed_out"].includes(checkRun.conclusion);
}

function hasPullRequestMergeConflicts(pullRequest: PullRequest): boolean {
  return pullRequest.mergeable === false;
}

function isPullRequestStale(pullRequest: PullRequest, staleDays: number): boolean {
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
): Promise<Map<PullRequestReviewStatus, FullPullRequest[]>> {
  const result = new Map<PullRequestReviewStatus, FullPullRequest[]>();
  for (const pullRequest of pullRequests) {
    const { reviewStatus } = await reviewPullRequest(octokit, owner, repo, pullRequest, requiredApprovals);
    const previousPullRequests = result.get(reviewStatus) ?? [];
    result.set(reviewStatus, [...previousPullRequests, pullRequest]);
  }
  return result;
}

function buildSlackMessage(
  totalPullRequests: number,
  pendingReviewPullRequests: FullPullRequest[],
  changesRequestedPullRequests: FullPullRequest[],
  approvedPullRequests: FullPullRequest[],
  staleDays: number,
): SlackMessage {
  const text = "Pull Request Summary";
  const blocks: AnyBlock[] = [];

  blocks.push(buildMarkdownSectionBlock(":loudspeaker: *Pull Request Summary* :loudspeaker:"));
  blocks.push(buildMarkdownSectionBlock(`*Total open PRs*: ${totalPullRequests}`));
  blocks.push(buildMarkdownSectionBlock(" "));
  blocks.push(buildPullRequestSectionBlock("eyes", "Pending review", pendingReviewPullRequests));
  blocks.push(buildMarkdownSectionBlock(" "));
  blocks.push(buildPullRequestSectionBlock("pencil2", "Changes requested", changesRequestedPullRequests));
  blocks.push(buildMarkdownSectionBlock(" "));
  blocks.push(buildPullRequestSectionBlock("white_check_mark", "Approved", approvedPullRequests));
  blocks.push(buildMarkdownSectionBlock(" "));
  blocks.push(buildLegendBlock(staleDays));
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

function buildPullRequestSectionBlock(emoji: string, title: string, pullRequests: FullPullRequest[]): RichTextBlock {
  return {
    type: "rich_text",
    elements: [buildPullRequestSectionTitle(emoji, title, pullRequests), buildPullRequestSectionList(pullRequests)],
  };
}

function buildPullRequestSectionTitle(emoji: string, title: string, pullRequests: FullPullRequest[]): RichTextSection {
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

function buildPullRequestSectionList(pullRequests: FullPullRequest[]): RichTextList {
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

function buildLegendBlock(staleDays: number): RichTextBlock {
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
            text: " = Build failure",
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

async function sendSlackMessage(slackToken: string, slackChannel: string, message: SlackMessage): Promise<void> {
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
