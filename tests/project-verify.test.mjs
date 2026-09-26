import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { makeTempDir, writeFile, ensureDir } from "./helpers/tmp.mjs";
import { verifyProjectRoot } from "../packages/cli/src/project/verify.js";

describe("routekit project verify", () => {
  it("passes for a minimal project with core MCP servers", () => {
    const projectRoot = makeTempDir("verify_project");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "verify-project", private: true }, null, 2));
    writeFile(
      path.join(projectRoot, "routekit", "project.json"),
      JSON.stringify({ id: "verify-project", stack: "test", root: ".", kgFile: "routekit/kg.yaml" }, null, 2)
    );
    writeFile(path.join(projectRoot, "routekit", "kg.yaml"), "framework: eleventy-nunjucks\ncode_roots:\n  - src\n  - notes\n");
    writeFile(
      path.join(projectRoot, "dendron.yml"),
      "version: 5\nworkspace:\n  vaults:\n    - fsPath: notes\n      name: verify-project\n      visibility: public\n"
    );
    ensureDir(path.join(projectRoot, "notes"));
    writeFile(path.join(projectRoot, "notes", "verify-project.welcome.md"), "# hi\n");
    ensureDir(path.join(projectRoot, "src"));
    writeFile(path.join(projectRoot, "src", "index.njk"), "<h1>hi</h1>\n");
    ensureDir(path.join(projectRoot, ".rks", "rag"));
    writeFile(path.join(projectRoot, ".rks", "rag", "config.json"), JSON.stringify({ version: 1, engine: "lancedb", paths: {} }, null, 2));

    ensureDir(path.join(projectRoot, ".vscode"));
    writeFile(
      path.join(projectRoot, ".vscode", "mcp.json"),
      JSON.stringify(
        {
          servers: {
            rks: { type: "stdio", command: "node", args: ["tools/routekit-shell/packages/mcp-rks/src/server.mjs"] },
            dendron: { type: "stdio", command: "node", args: ["tools/routekit-shell/packages/mcp-dendron/src/server.mjs"] },
            figma: {
              type: "stdio",
              command: "node",
              args: ["tools/routekit-shell/packages/mcp-figma-bridge/src/server.mjs"],
              env: { FIGMA_MCP_URL: "http://127.0.0.1:3845/mcp" },
            },
          },
          inputs: [],
        },
        null,
        2
      )
    );

    // Create placeholder vendored paths so verify doesn't warn about missing entrypoints.
    ensureDir(path.join(projectRoot, "tools", "routekit-shell", "packages", "mcp-rks", "src"));
    ensureDir(path.join(projectRoot, "tools", "routekit-shell", "packages", "mcp-dendron", "src"));
    ensureDir(path.join(projectRoot, "tools", "routekit-shell", "packages", "mcp-figma-bridge", "src"));
    fs.writeFileSync(path.join(projectRoot, "tools", "routekit-shell", "packages", "mcp-rks", "src", "server.mjs"), "", "utf8");
    fs.writeFileSync(path.join(projectRoot, "tools", "routekit-shell", "packages", "mcp-dendron", "src", "server.mjs"), "", "utf8");
    fs.writeFileSync(path.join(projectRoot, "tools", "routekit-shell", "packages", "mcp-figma-bridge", "src", "server.mjs"), "", "utf8");

    const result = verifyProjectRoot(projectRoot);
    expect(result.status).toBe("ok");
  });

  it("fails when core MCP servers are missing", () => {
    const projectRoot = makeTempDir("verify_project_missing");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "verify-project-missing", private: true }, null, 2));
    writeFile(path.join(projectRoot, "routekit", "project.json"), JSON.stringify({ id: "p" }, null, 2));
    writeFile(path.join(projectRoot, "routekit", "kg.yaml"), "name: p\nversion: 1\n");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, ".vscode"));
    writeFile(path.join(projectRoot, ".vscode", "mcp.json"), JSON.stringify({ servers: { rks: { type: "stdio" } } }, null, 2));

    const result = verifyProjectRoot(projectRoot);
    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.id === "mcp.server.dendron" && c.status === "fail")).toBe(true);
    expect(result.checks.some((c) => c.id === "mcp.server.figma" && c.status === "fail")).toBe(true);
  });

  it("fails when dendron.yml has no workspace.vaults", () => {
    const projectRoot = makeTempDir("verify_project_bad_dendron");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "verify-project", private: true }, null, 2));
    writeFile(path.join(projectRoot, "routekit", "project.json"), JSON.stringify({ id: "verify-project" }, null, 2));
    writeFile(path.join(projectRoot, "routekit", "kg.yaml"), "framework: eleventy-nunjucks\ncode_roots:\n  - src\n  - notes\n");
    ensureDir(path.join(projectRoot, "notes"));
    writeFile(path.join(projectRoot, "dendron.yml"), "version: 5\nworkspace:\n  name: notes\n");
    ensureDir(path.join(projectRoot, ".vscode"));
    writeFile(
      path.join(projectRoot, ".vscode", "mcp.json"),
      JSON.stringify(
        {
          servers: {
            rks: { type: "stdio", command: "node", args: ["tools/routekit-shell/packages/mcp-rks/src/server.mjs"] },
            dendron: { type: "stdio", command: "node", args: ["tools/routekit-shell/packages/mcp-dendron/src/server.mjs"] },
            figma: {
              type: "stdio",
              command: "node",
              args: ["tools/routekit-shell/packages/mcp-figma-bridge/src/server.mjs"],
              env: { FIGMA_MCP_URL: "http://127.0.0.1:3845/mcp" },
            },
          },
        },
        null,
        2
      )
    );
    // Create placeholder vendored paths so verify doesn't warn about missing entrypoints.
    ensureDir(path.join(projectRoot, "tools", "routekit-shell", "packages", "mcp-rks", "src"));
    ensureDir(path.join(projectRoot, "tools", "routekit-shell", "packages", "mcp-dendron", "src"));
    ensureDir(path.join(projectRoot, "tools", "routekit-shell", "packages", "mcp-figma-bridge", "src"));
    fs.writeFileSync(path.join(projectRoot, "tools", "routekit-shell", "packages", "mcp-rks", "src", "server.mjs"), "", "utf8");
    fs.writeFileSync(path.join(projectRoot, "tools", "routekit-shell", "packages", "mcp-dendron", "src", "server.mjs"), "", "utf8");
    fs.writeFileSync(path.join(projectRoot, "tools", "routekit-shell", "packages", "mcp-figma-bridge", "src", "server.mjs"), "", "utf8");

    const result = verifyProjectRoot(projectRoot);
    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.id === "dendron.config.shape" && c.status === "fail")).toBe(true);
  });
});
