import * as core from "@actions/core";
import * as github from "@actions/github";

export async function run(): Promise<void> {
    try {
        const token = core.getInput("github-token");
        const pullRequestNumber = parseInt(core.getInput("pull-request-number"), 10);

        const octokit = github.getOctokit(token);

        const { data: pullRequest } = await octokit.rest.pulls.get({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            pull_number: pullRequestNumber,
        });

        console.log(pullRequest);
    } catch (error) {
        if (error instanceof Error) {
            core.setFailed(error.message);
        }
    }
}
