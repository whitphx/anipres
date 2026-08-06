// Posts or updates a marker-identified sticky comment on a pull request.
// Loaded via actions/github-script's dynamic-import bridge so the
// github/context/core handles flow in cleanly.
//
// Patterned after whitphx/stlite's sticky-comment-add-section retry
// loop (Apache-2.0). The race-handling logic is what makes concurrent
// updates safe when several jobs finish near-simultaneously.
// Upstream: https://github.com/whitphx/stlite/blob/main/.github/actions/sticky-comment-add-section/action.yml

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export default async function updateStickyComment({
  github,
  context,
  core,
  marker,
  prNumber,
  body,
}) {
  const fullBody = `${marker}\n${body}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const comments = await github.paginate(github.rest.issues.listComments, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: prNumber,
      });
      const existing = comments.find(
        (c) =>
          c.body?.startsWith(marker) && c.user?.login === "github-actions[bot]",
      );

      if (existing) {
        await github.rest.issues.updateComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          comment_id: existing.id,
          body: fullBody,
        });
        core.info(
          `Updated ${marker} comment ${existing.id} on PR #${prNumber}`,
        );
      } else {
        await github.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: prNumber,
          body: fullBody,
        });
        core.info(`Created ${marker} comment on PR #${prNumber}`);
      }
      return;
    } catch (error) {
      // 409 = comment was modified between read and update; 422 = stale-data
      // validation; 403 = secondary rate limit. Each is retryable after a
      // pause + a fresh listComments fetch.
      const isRetryable =
        error.status === 409 || error.status === 422 || error.status === 403;
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
