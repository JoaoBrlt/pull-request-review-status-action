# Pull Request Review Status Action

[![CI][ci-badge-url]][ci-workflow-url]

GitHub Action to label pull requests depending on their review status and send pull request summary reports to Slack.

## Examples

### Label a pull request

```yaml
- name: Label a pull request
  uses: JoaoBrlt/pull-request-review-status-action@v1
  with:
    # Common
    github-token: ${{ secrets.GITHUB_TOKEN }}
    run-mode: label
    required-approvals: 2
    
    # Label mode
    pull-number: ${{ github.event.pull_request.number }}
    pending-review-label: Pending review
    changes-requested-label: Changes requested
    approved-label: Approved
```

[See example GitHub Actions workflow](.github/workflows/pull-request-label.yml).

### Report the pull requests

```yaml
- name: Report the pull requests
  uses: JoaoBrlt/pull-request-review-status-action@v1
  with:
    # Common
    github-token: ${{ secrets.GITHUB_TOKEN }}
    run-mode: report
    required-approvals: 1
    
    # Report mode
    slack-token: ${{ secrets.SLACK_TOKEN }}
    slack-channel: "#pull-requests"
    stale-days: 7
```

[See example GitHub Actions workflow](.github/workflows/pull-request-report.yml).

## Inputs

### Common

| Key                  | Required | Default | Description                                             |
|----------------------|----------|---------|---------------------------------------------------------|
| `github-token`       | Yes      |         | The GitHub token used authenticate against GitHub APIs. |
| `run-mode`           | Yes      |         | The run mode (can be `label` or `report`).              |
| `required-approvals` | No       | `1`     | The required number of approvals to approve a PR.       |

### Label mode

| Key                       | Required             | Default             | Description                                   |
|---------------------------|----------------------|---------------------|-----------------------------------------------|
| `pull-number`             | Yes, in `label` mode |                     | The number of the pull request to label.      |
| `pending-review-label`    | No                   | `Pending review`    | The label to use when a PR is pending review. |
| `changes-requested-label` | No                   | `Changes requested` | The label to use when a PR needs changes.     |
| `approved-label`          | No                   | `Approved`          | The label to use when a PR is approved.       |

### Report mode

| Key             | Required              | Default | Description                                                               |
|-----------------|-----------------------|---------|---------------------------------------------------------------------------|
| `slack-token`   | Yes, in `report` mode |         | The Slack API token used to authenticate against the Slack API.           |
| `slack-channel` | Yes, in `report` mode |         | The Slack channel on which to send the report.                            |
| `stale-days`    | No                    | `7`     | The number of days after which a pull request should be considered stale. |

## Outputs

None.

[ci-badge-url]: https://github.com/JoaoBrlt/pull-request-review-status-action/actions/workflows/ci.yml/badge.svg
[ci-workflow-url]: https://github.com/JoaoBrlt/pull-request-review-status-action/actions/workflows/ci.yml
