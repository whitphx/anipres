// Renders the bundle-size sticky-comment markdown from the current
// run's bundle-stats.* artifacts and (optionally) a base run's same
// artifacts. Emits markdown to --output.
//
// Patterned after whitphx/stlite's .github/actions/inform-package-stats
// (Apache-2.0, https://github.com/whitphx/stlite/blob/main/.github/actions/inform-package-stats/action.yml).
// Differences worth flagging when syncing forward:
//   - Reports gzip size + percentage delta (stlite reports raw kiB
//     only). Significance threshold is computed on gzip.
//   - Per-file rendering is a status-icon table (🟢 new / 🔴 removed /
//     🔼 grew / 🔽 shrunk) sorted by Δgzip then by size, instead of a
//     line-diff over `find -printf "%s %p"` text.
//   - Base bundle is matched by `key`, so reordering / renaming an
//     artifact doesn't show as removed+added at the bundle level.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const SIGNIFICANT_GZIP_PCT = 0.05;
const SIGNIFICANT_GZIP_BYTES = 512;

const { values } = parseArgs({
  options: {
    "current-dir": { type: "string" },
    "base-dir": { type: "string" },
    "output": { type: "string" },
    "head-sha": { type: "string" },
    "base-sha": { type: "string" },
    "base-run-id": { type: "string" },
    "base-branch": { type: "string" },
    "repo": { type: "string" },
  },
});

if (!values["current-dir"] || !values.output) {
  console.error(
    "Usage: format-comment.mjs --current-dir <dir> [--base-dir <dir>] --output <file> [--head-sha <sha>] [--base-sha <sha>] [--base-run-id <id>] [--base-branch <name>] [--repo <owner/name>]",
  );
  process.exit(1);
}

function loadStatsFromDir(dir) {
  const stats = [];
  if (!dir || !fs.existsSync(dir)) return stats;
  for (const entry of fs.readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || entry.name !== "bundle-stats.json") continue;
    const full = path.join(entry.parentPath, entry.name);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
      if (parsed.schemaVersion === 1 && typeof parsed.key === "string") {
        stats.push(parsed);
      } else {
        console.warn(`Skipping ${full}: unexpected shape`);
      }
    } catch (e) {
      console.warn(`Skipping ${full}: ${e.message}`);
    }
  }
  return stats;
}

function indexByKey(list) {
  const m = new Map();
  for (const item of list) m.set(item.key, item);
  return m;
}

function formatBytes(n) {
  if (n == null) return "—";
  const KIB = 1024;
  const MIB = KIB * 1024;
  if (n === 0) return "0 B";
  if (n < KIB) return `${n} B`;
  if (n < MIB) return `${(n / KIB).toFixed(1)} KiB`;
  return `${(n / MIB).toFixed(2)} MiB`;
}

function formatDeltaCell(curr, base, { bold = true } = {}) {
  if (base == null && curr == null) return "—";
  if (base == null) return bold ? "**new**" : "new";
  if (curr == null) return bold ? "**removed**" : "removed";
  const diff = curr - base;
  if (diff === 0) return "—";
  const sign = diff > 0 ? "+" : "−";
  const sizeStr = `${sign}${formatBytes(Math.abs(diff))}`;
  const pctStr =
    base > 0
      ? ` (${sign}${((Math.abs(diff) / base) * 100).toFixed(1)}%)`
      : "";
  return bold ? `**${sizeStr}**${pctStr}` : `${sizeStr}${pctStr}`;
}

function isSignificantGzip(curr, base) {
  // Only flag a regression when both sides exist; "new"/"removed"
  // bundles are informational, not threshold violations.
  if (base == null || curr == null) return false;
  const diff = curr - base;
  if (Math.abs(diff) < SIGNIFICANT_GZIP_BYTES) return false;
  if (Math.abs(diff) / Math.max(base, 1) < SIGNIFICANT_GZIP_PCT) return false;
  return true;
}

function statusIcon(curr, base) {
  if (base == null) return "🟢";
  if (curr == null) return "🔴";
  if (curr > base) return "🔼";
  if (curr < base) return "🔽";
  return "";
}

function renderHeader({ hasBase }) {
  const lines = ["## 📦 Bundle size report", ""];
  const repo = values.repo;
  const baseSha = values["base-sha"];
  const baseBranch = values["base-branch"] ?? "main";
  const baseRunId = values["base-run-id"];

  if (hasBase && baseSha && repo) {
    const shaLink = `[\`${baseSha.slice(0, 7)}\`](https://github.com/${repo}/commit/${baseSha})`;
    const runLink = baseRunId
      ? ` · [run #${baseRunId}](https://github.com/${repo}/actions/runs/${baseRunId})`
      : "";
    lines.push(
      `> Compared against \`${baseBranch}\` (${shaLink}${runLink}).`,
    );
  } else {
    lines.push(
      `> No baseline run found on \`${baseBranch}\`; showing absolute sizes only.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderSummary(currentByKey, baseByKey) {
  const rows = [];
  let significantCount = 0;
  const allKeys = [
    ...new Set([...currentByKey.keys(), ...baseByKey.keys()]),
  ].sort();

  for (const key of allKeys) {
    const curr = currentByKey.get(key);
    const base = baseByKey.get(key);
    const name = curr?.name ?? base?.name ?? key;
    const currTotals = curr?.totals;
    const baseTotals = base?.totals;
    const significant = isSignificantGzip(
      currTotals?.gzipBytes,
      baseTotals?.gzipBytes,
    );
    if (significant) significantCount++;

    const rawCell = `${formatBytes(currTotals?.rawBytes ?? null)} ${formatDeltaCell(currTotals?.rawBytes, baseTotals?.rawBytes, { bold: false })}`.trim();
    const gzipCell = `${formatBytes(currTotals?.gzipBytes ?? null)} ${formatDeltaCell(currTotals?.gzipBytes, baseTotals?.gzipBytes)}`.trim();
    const indicator = significant ? "⚠️ " : "";
    rows.push(
      `| ${indicator}${name} | ${currTotals?.files ?? "—"} | ${rawCell} | ${gzipCell} |`,
    );
  }

  const lines = [];
  if (significantCount > 0) {
    lines.push(
      `⚠️ ${significantCount} bundle${significantCount === 1 ? "" : "s"} changed by ≥${SIGNIFICANT_GZIP_PCT * 100}% gzip (and ≥${formatBytes(SIGNIFICANT_GZIP_BYTES)}).`,
    );
    lines.push("");
  }
  lines.push("### Summary");
  lines.push("");
  lines.push("| Bundle | Files | Raw | Gzip |");
  lines.push("| --- | ---: | ---: | ---: |");
  lines.push(...rows);
  lines.push("");
  return lines.join("\n");
}

function renderFileTable(curr, base) {
  const baseFiles = new Map();
  if (base) for (const f of base.files) baseFiles.set(f.path, f);
  const currFiles = new Map();
  if (curr) for (const f of curr.files) currFiles.set(f.path, f);

  const allPaths = new Set([...baseFiles.keys(), ...currFiles.keys()]);
  const rows = [];
  for (const p of allPaths) {
    const c = currFiles.get(p);
    const b = baseFiles.get(p);
    const currGzip = c?.gzipBytes ?? null;
    const baseGzip = b?.gzipBytes ?? null;
    const diff =
      currGzip != null && baseGzip != null ? currGzip - baseGzip : null;
    rows.push({
      path: p,
      curr: c,
      base: b,
      diff,
      sortKey:
        diff != null
          ? Math.abs(diff)
          : currGzip != null
            ? currGzip
            : (baseGzip ?? 0),
      hasChange: diff !== 0 || c == null || b == null,
    });
  }

  rows.sort((a, b) => {
    if (a.hasChange !== b.hasChange) return a.hasChange ? -1 : 1;
    return b.sortKey - a.sortKey;
  });

  const lines = [];
  lines.push("|   | File | Raw | Gzip | Δ Gzip |");
  lines.push("| --- | --- | ---: | ---: | ---: |");
  for (const r of rows) {
    const icon = statusIcon(r.curr?.gzipBytes, r.base?.gzipBytes);
    const path =
      r.curr == null ? `~~\`${r.path}\`~~` : `\`${r.path}\``;
    const raw = formatBytes(r.curr?.rawBytes ?? null);
    const gzip = formatBytes(r.curr?.gzipBytes ?? null);
    const delta = formatDeltaCell(r.curr?.gzipBytes, r.base?.gzipBytes);
    lines.push(`| ${icon} | ${path} | ${raw} | ${gzip} | ${delta} |`);
  }
  return lines.join("\n");
}

function renderPerBundle(currentByKey, baseByKey) {
  const lines = ["### File breakdown", ""];
  const keys = [...currentByKey.keys()].sort();

  for (const key of keys) {
    const curr = currentByKey.get(key);
    const base = baseByKey.get(key);
    const name = curr?.name ?? key;
    const t = curr.totals;
    const summary =
      `${t.files} files · ${formatBytes(t.rawBytes)} raw · ${formatBytes(t.gzipBytes)} gzip` +
      (base
        ? ` · ${formatDeltaCell(t.rawBytes, base.totals.rawBytes, { bold: false })} raw / ${formatDeltaCell(t.gzipBytes, base.totals.gzipBytes, { bold: false })} gzip`
        : "");
    lines.push(`<details>`);
    lines.push(`<summary><b>${name}</b> — ${summary}</summary>`);
    lines.push("");
    lines.push(renderFileTable(curr, base));
    lines.push("");
    lines.push(`</details>`);
    lines.push("");
  }
  return lines.join("\n");
}

const current = loadStatsFromDir(values["current-dir"]);
if (current.length === 0) {
  console.error(
    `No bundle-stats found in ${values["current-dir"]}; aborting.`,
  );
  process.exit(1);
}
const base = loadStatsFromDir(values["base-dir"]);

const currentByKey = indexByKey(current);
const baseByKey = indexByKey(base);

const out =
  renderHeader({ hasBase: base.length > 0 }) +
  "\n" +
  renderSummary(currentByKey, baseByKey) +
  "\n" +
  renderPerBundle(currentByKey, baseByKey);

fs.writeFileSync(values.output, out);
console.log(`Wrote comment markdown to ${values.output} (${out.length} bytes)`);
