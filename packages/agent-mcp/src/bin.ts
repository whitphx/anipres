#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAnipresMcpServer } from "./server.js";

async function main(): Promise<void> {
  const server = createAnipresMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The transport keeps the process alive; we just wait for it to close.
}

main().catch((err) => {
  // stderr only — stdout is reserved for the JSON-RPC channel.
  process.stderr.write(
    `[anipres-agent-mcp] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
