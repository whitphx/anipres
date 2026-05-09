// Posts or updates the bundle-size sticky comment on the current PR.
// Loaded by .github/actions/measure-bundle-size/action.yml via
// actions/github-script's dynamic-import bridge so the github/context/
// core handles flow in cleanly.
//
// Patterned after whitphx/stlite's sticky-comment-add-section retry
// loop (Apache-2.0). The race-handling logic is what makes per-job
// updates safe when several measure jobs finish near-simultaneously.
// Upstream: https://github.com/whitphx/stlite/blob/main/.github/actions/sticky-comment-add-section/action.yml

import fs from "node:fs";

const MARKER = "<!-- bundle-size-report -->";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Env: PR_NUMBER, COMMENT_PATH
export default async function run({ github, context, core }) {
  const prNumber = parseInt(process.env.PR_NUMBER, 10);
  const body = `${MARKER}\n${fs.readFileSync(process.env.COMMENT_PATH, "utf8")}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const comments = await github.paginate(github.rest.issues.listComments, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: prNumber,
      });
      const existing = comments.find(
        (c) =>
          c.body?.startsWith(MARKER) &&
          c.user?.login === "github-actions[bot]",
      );

      if (existing) {
        await github.rest.issues.updateComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          comment_id: existing.id,
          body,
        });
        core.info(
          `Updated bundle-size comment ${existing.id} on PR #${prNumber}`,
        );
      } else {
        await github.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: prNumber,
          body,
        });
        core.info(`Created bundle-size comment on PR #${prNumber}`);
      }
      return;
    } catch (error) {
      // 409 = comment was modified between read and update; 422 = stale-data
      // validation; 403 = secondary rate limit. Each is retryable after a
      // pause + a fresh listComments fetch.
      const isRetryable =
        error.status === 409 ||
        error.status === 422 ||
        error.status === 403;
      if (isRetryable && attempt < MAX_RETRIES) {
        core.warning(
          `Attempt ${attempt} failed with status ${error.status}, retrying in ${RETRY_DELAY_MS}ms…`,
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw error;
    }
  }
}
