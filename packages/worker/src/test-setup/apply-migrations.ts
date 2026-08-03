import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// TEST_MIGRATIONS is injected by vitest.config.ts (miniflare bindings)
// for the test runtime only, so it is not part of the app `Env` shape
// that types `env` here.
const { TEST_MIGRATIONS } = env as unknown as {
  TEST_MIGRATIONS: D1Migration[];
};

await applyD1Migrations(env.DB, TEST_MIGRATIONS);
