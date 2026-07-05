// scripts/test-analyze.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function run() {
    const projectId = process.argv[2] || "testsite";
    // Launch the MCP server via stdio transport
    const transport = new StdioClientTransport({
        command: "node",
        args: [
            // ensure this path is correct relative to repo root
            resolve(__dirname, "../packages/mcp-rks/src/server.mjs"),
        ],
        env: {
            ...process.env,
        },
    });

    const client = new Client({
        name: "rks-test-client",
        version: "0.1.0",
    });

    await client.connect(transport);

    // Call your tool
    const result = await client.callTool({
        name: "rks_analyze",
        arguments: {
            projectId,
        },
    });

    console.log(`RESULT for ${projectId}:`, JSON.stringify(result, null, 2));

    await client.close();
    process.exit(0);
}

run().catch((err) => {
    console.error("Error running rks.analyze:", err);
    process.exit(1);
});
