#!/usr/bin/env node
// Wipe the shared preview D1 so the next `wrangler d1 migrations apply`
// runs the full set from scratch — applied tags and all.
//
// Why: wrangler tracks applied migration tags by filename in the
// internal `d1_migrations` table. If a migration file is edited
// mid-review (or renamed, squashed), the next apply sees the tag as
// done and silently skips the new contents — preview's schema then
// drifts permanently from the file. CI calls this script before
// `migrate:remote:preview` whenever `packages/worker/migrations/`
// differs from the PR base, so the rebuild is always from-scratch and
// the edited content actually lands.
//
// Hardcoded to `--remote --env preview` so it cannot be aimed at prod
// by passing the wrong flag.

import { execFileSync } from "node:child_process";

function wrangler(args, opts = {}) {
  return execFileSync(
    "wrangler",
    ["d1", "execute", "DB", "--remote", "--env", "preview", ...args],
    { encoding: "utf8", ...opts },
  );
}

const listSQL =
  "SELECT type, name FROM sqlite_master " +
  "WHERE name NOT LIKE 'sqlite_%' " +
  "AND type IN ('table','index','trigger','view')";

const raw = wrangler(["--json", "--command", listSQL]);
const jsonStart = raw.indexOf("[");
const objects =
  (jsonStart >= 0 ? JSON.parse(raw.slice(jsonStart)) : [])[0]?.results ?? [];

if (objects.length === 0) {
  console.log("Preview D1 is already empty — nothing to drop.");
  process.exit(0);
}

// Drop triggers/views first (they reference tables but nothing
// references them), then indexes, then tables. Indexes vanish with
// their parent tables, but explicit DROPs make the order obvious and
// keep the script independent of D1's FK-enforcement default.
const order = { trigger: 0, view: 1, index: 2, table: 3 };
const dropSQL = objects
  .filter((o) => o.name !== "sqlite_sequence") // SQLite-internal
  .sort((a, b) => order[a.type] - order[b.type])
  .map((o) => `DROP ${o.type.toUpperCase()} IF EXISTS "${o.name}";`)
  .join("\n");

console.log("Dropping preview D1 objects:");
console.log(dropSQL);

wrangler(["--command", dropSQL], { stdio: "inherit" });

console.log("Preview D1 reset complete.");
