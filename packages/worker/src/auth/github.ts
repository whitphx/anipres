import { githubAuth } from "@hono/oauth-providers/github";
import type { Hono } from "hono";
import type { AppBindings } from "../types";
import { upsertUserAndIssueSession } from "./session";

export function registerGitHubAuth(app: Hono<AppBindings>) {
  // user:email scope is unused by us, but @hono/oauth-providers
  // unconditionally calls GET /user/emails after auth, which requires it.
  app.use(
    "/auth/github",
    githubAuth({
      scope: ["user:email"],
      oauthApp: true,
    }),
  );

  app.get("/auth/github", async (c) => {
    const ghUser = c.get("user-github");
    if (!ghUser) {
      return c.text("Authentication failed", 401);
    }

    return upsertUserAndIssueSession(c, "github", String(ghUser.id));
  });
}
