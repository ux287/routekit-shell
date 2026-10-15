import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeTempDir, ensureDir } from "./helpers/tmp.mjs";

describe("mcp-dendron binding", () => {
  it.skipIf(!!process.env.CI)("writes notes into ROUTEKIT_PROJECT_ROOT/notes", async () => {
    const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
    const serverPath = path.join(repoRoot, "packages", "mcp-dendron", "src", "server.mjs");

    const projectRoot = makeTempDir("mcp_dendron_root");
    const notesDir = path.join(projectRoot, "notes");
    ensureDir(notesDir);

    const transport = new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: { ...process.env, ROUTEKIT_PROJECT_ROOT: projectRoot },
    });
    const client = new Client({ name: "test-mcp-dendron", version: "0.0.0" });
    await client.connect(transport);

    try {
      const filename = "design.test-note.md";
      const res = await client.callTool({
        name: "dendron_create_note",
        arguments: { filename, title: "Test Note", content: "Hello\n" },
      });
      expect(res).toBeTruthy();
      expect(fs.existsSync(path.join(notesDir, filename))).toBe(true);
    } finally {
      await client.close();
    }
  });
});

