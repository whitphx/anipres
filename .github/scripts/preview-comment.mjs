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

// Says only which commit the comment covers, and which one the PR is on now.
// Whether the head itself deployed is not knowable from a run the PR has moved
// past, so the notice claims nothing about it.
const staleLines = (builtSha, prHeadSha) => [
  `⚠️ This comment is outdated: it describes ${commitLink(builtSha)}, and this pull request's head is now ${commitLink(prHeadSha)}.`,
  "",
  "The next completed CI run replaces it.",
];

const comment = (lines, builtSha) =>
  [HEADING, "", ...lines, "", builtShaTag(builtSha)].join("\n");

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
  const openPullRequests = associatedPullRequests.filter(
    (pullRequest) =>
      pullRequest.state === "open" &&
      pullRequest.base.repo.full_name === repository,
  );
  // More than one open PR can contain this commit — one stacked on this one,
  // say — and the comment belongs to the PR whose head it is. Falling back to
  // the looser set is what lets a run the PR has moved past find its PR.
  const headPullRequests = openPullRequests.filter(
    (pullRequest) => pullRequest.head.sha === headSha,
  );
  const pullRequests =
    headPullRequests.length === 1 ? headPullRequests : openPullRequests;
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
    body: describesHead
      ? comment(deploymentLines(headSha), headSha)
      : // A run the PR has moved past knows nothing about the current head's
        // deployments, so it may only retire a comment it can prove is
        // outdated — never create one, and never touch one whose commit it
        // cannot read, which is every comment written before this tag existed.
        // The notice names the commit that comment covers, which this run's
        // own may well be older than.
        (existingBody) => {
          const builtSha = readBuiltSha(existingBody);
          if (builtSha === null || builtSha === head.sha) return null;
          return comment(staleLines(builtSha, head.sha), builtSha);
        },
  });
}
