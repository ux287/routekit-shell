import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function run() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [resolve(__dirname, "../packages/mcp-rks/src/server.mjs")],
    env: { ...process.env },
  });

  const client = new Client({ name: "rks-test-plan", version: "0.1.0" });
  await client.connect(transport);

  const result = await client.callTool({
    name: "rks_plan",
    arguments: {
      projectId: "testsite",
      task: "Add an About page with a hero and CTA.",
    },
  });

  console.log("PLAN RESULT:", JSON.stringify(result, null, 2));
  await client.close();
  process.exit(0);
}

run().catch((err) => {
  console.error("Error running rks.plan:", err);
  process.exit(1);
});
