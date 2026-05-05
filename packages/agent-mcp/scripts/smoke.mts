// Spawn the agent-mcp server over stdio, list its tools, and call the
// summarize tool against a real snapshot. Run with:
//   pnpm --filter @anipres/agent-mcp exec tsx scripts/smoke.mts <snapshot-path>
//
// No API key needed for the summarize tool.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const snapshotPath = process.argv[2];
if (!snapshotPath) {
  console.error("Usage: tsx scripts/smoke.mts <snapshot-path>");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: "node",
  args: [new URL("../dist/bin.js", import.meta.url).pathname],
});

const client = new Client(
  { name: "smoketest", version: "0.0.1" },
  { capabilities: {} },
);
await client.connect(transport);

const tools = await client.listTools();
console.log("== Tools ==");
for (const t of tools.tools) {
  console.log(`- ${t.name}: ${t.description?.slice(0, 60)}...`);
}

console.log("\n== summarize_snapshot ==");
const result = await client.callTool({
  name: "anipres_summarize_snapshot",
  arguments: { snapshotPath },
});
const content = result.content as Array<{ type: string; text?: string }>;
for (const c of content) {
  if (c.type === "text" && c.text) console.log(c.text);
}

await client.close();
process.exit(0);
