// Walks a directory and emits JSON describing every file's raw +
// gzip size, plus totals. Consumed by the bundle-size-report job.
//
// Patterned after whitphx/stlite's .github/actions/set-package-stats
// (Apache-2.0, https://github.com/whitphx/stlite/blob/main/.github/actions/set-package-stats/action.yml).
// Differences worth flagging when syncing forward:
//   - Stlite uses `du -k` (block-rounded disk usage) plus separate
//     `tree` and `find -printf "%s %p"` shell pipelines. This script
//     reads byte-accurate sizes from a single Node walk and adds gzip
//     so deltas can be reasoned about against what users actually
//     download.
//   - Output is JSON only; the formatter handles tree/list rendering.
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync, constants as zlibConstants } from "node:zlib";
import { join, relative, sep } from "node:path";
import { parseArgs } from "node:util";

function* walk(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }
}

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    key: { type: "string" },
    name: { type: "string" },
  },
});

if (!values.input || !values.output || !values.key) {
  console.error(
    "Usage: measure.mjs --input <dir> --output <file> --key <key> [--name <name>]",
  );
  process.exit(1);
}

const inputDir = values.input;
const outputFile = values.output;
const key = values.key;
const name = values.name ?? key;

if (!statSync(inputDir).isDirectory()) {
  console.error(`Input is not a directory: ${inputDir}`);
  process.exit(1);
}

const files = [];
for (const filePath of walk(inputDir)) {
  const buf = readFileSync(filePath);
  const rawBytes = buf.byteLength;
  // Match what static hosts typically serve (max compression). Mirrors
  // what downstream consumers measure against budgets.
  const gzipBytes = gzipSync(buf, {
    level: zlibConstants.Z_BEST_COMPRESSION,
  }).byteLength;
  files.push({
    path: relative(inputDir, filePath).split(sep).join("/"),
    rawBytes,
    gzipBytes,
  });
}

files.sort((a, b) => a.path.localeCompare(b.path));

const totals = files.reduce(
  (acc, f) => ({
    files: acc.files + 1,
    rawBytes: acc.rawBytes + f.rawBytes,
    gzipBytes: acc.gzipBytes + f.gzipBytes,
  }),
  { files: 0, rawBytes: 0, gzipBytes: 0 },
);

const report = {
  schemaVersion: 1,
  key,
  name,
  createdAt: new Date().toISOString(),
  totals,
  files,
};

writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
console.log(
  `Wrote ${outputFile}: ${totals.files} files, raw=${totals.rawBytes}B, gzip=${totals.gzipBytes}B`,
);
