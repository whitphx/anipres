// Builds and posts the preview-deployments sticky comment on a pull request.
// Loaded by .github/workflows/post-build.yml through actions/github-script's
// dynamic-import bridge.
//
// Env: HEAD_SHA, CI_CONCLUSION, CI_RUN_URL, RUN_URL, and a URL/RESULT pair
// per deploy job (APP_, SLIDEV_, WORKER_).

import updateStickyComment from "./sticky-comment.mjs";

const MARKER = "<!-- preview-deployments -->";
const HEADING = "## 🚀 Preview deployments";

// Records which commit the comment describes, so a later run can tell whether
// it still describes the pull request's head.
const BUILT_SHA_PATTERN = /<!-- built: ([0-9a-f]{40}) -->/;
const builtShaTag = (sha) => `<!-- built: ${sha} -->`;
const readBuiltSha = (body) => body?.match(BUILT_SHA_PATTERN)?.[1] ?? null;

const commitLink = (sha) =>
  `[\`${sha.slice(0, 7)}\`](${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/commit/${sha})`;

function deploymentLines(headSha) {
  if (process.env.CI_CONCLUSION !== "success") {
    return [
      `Nothing deployed for ${commitLink(headSha)} — [CI](${process.env.CI_RUN_URL}) concluded \`${process.env.CI_CONCLUSION}\`.`,
    ];
  }

  const targets = [
    { name: "App", url: process.env.APP_URL, result: process.env.APP_RESULT },
    {
      name: "Slidev addon demo",
      url: process.env.SLIDEV_URL,
      result: process.env.SLIDEV_RESULT,
    },
    {
      name: "Worker (auth + sync)",
      url: process.env.WORKER_URL,
      result: process.env.WORKER_RESULT,
    },
  ];
  // Bare URLs instead of `[text](url)` — nothing in the cell is then
  // interpretable as markup.
  const cell = ({ url, result }) =>
    url
      ? url
      : result === "skipped"
        ? "— _not deployed_"
        : `⚠️ deploy \`${result}\``;

  // deploy-worker-preview also reports `skipped` when an earlier job in the
  // chain fails, which is not the fork/Dependabot case — a deployed app is
  // what distinguishes the two.
  const workerNote = process.env.WORKER_URL
    ? "The preview worker is shared by every PR — last deploy wins."
    : process.env.WORKER_RESULT === "skipped" && process.env.APP_URL
      ? "The preview worker is not deployed for fork or Dependabot PRs."
      : null;

  return [
    "| Target | URL |",
    "| --- | --- |",
    ...targets.map((target) => `| ${target.name} | ${cell(target)} |`),
    "",
    `Built from ${commitLink(headSha)} · [post-build run](${process.env.RUN_URL}).`,
    ...(workerNote ? ["", `> ${workerNote}`] : []),
  ];
}

const staleLines = (builtSha, prHeadSha) => [
  `⚠️ No preview has been published for this pull request's head, ${commitLink(prHeadSha)}.`,
  "",
  `The most recent one covered ${commitLink(builtSha)}. The next completed CI run replaces this.`,
];

export default async function run({ github, context, core }) {
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const headSha = process.env.HEAD_SHA;

  const associatedPullRequests = await github.paginate(
    github.rest.repos.listPullRequestsAssociatedWithCommit,
    {
      owner: context.repo.owner,
      repo: context.repo.repo,
      commit_sha: headSha,
      per_page: 100,
    },
  );
  // Looser than deploy-worker-preview's filter on purpose: fork and Dependabot
  // PRs get no worker deploy but still get the comment, and a run the PR has
  // moved past still has to find its PR to retire an outdated comment.
  const pullRequests = associatedPullRequests.filter(
    (pullRequest) =>
      pullRequest.state === "open" &&
      pullRequest.base.repo.full_name === repository,
  );
  // A PR closed while post-build was running has nowhere to put the comment;
  // that's not a deployment failure.
  if (pullRequests.length !== 1) {
    core.info(
      `Found ${pullRequests.length} open pull requests for ${headSha}; skipping the preview comment.`,
    );
    return;
  }

  const { number: prNumber, head } = pullRequests[0];
  const describesHead = head.sha === headSha;

  await updateStickyComment({
    github,
    context,
    core,
    marker: MARKER,
    prNumber,
    body: [
      HEADING,
      "",
      ...(describesHead
        ? deploymentLines(headSha)
        : staleLines(headSha, head.sha)),
      "",
      builtShaTag(headSha),
    ].join("\n"),
    // A run the PR has moved past knows nothing about the current head's
    // deployments, so it may only retire a comment it can prove is outdated —
    // never create one, and never touch one whose commit it cannot read, which
    // is every comment written before this tag existed.
    shouldWrite: describesHead
      ? undefined
      : (existingBody) => {
          const builtSha = readBuiltSha(existingBody);
          return builtSha !== null && builtSha !== head.sha;
        },
  });
}
