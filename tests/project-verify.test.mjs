import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { makeTempDir, writeFile, ensureDir } from "./helpers/tmp.mjs";
import { fileURLToPath } from "node:url";
import { verifyProjectRoot } from "../packages/cli/src/project/verify.js";
import { ensureMcpJson } from "../packages/cli/src/project/bootstrap.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RKS_REL = "tools/routekit-shell/packages/mcp-rks/src/server.mjs";
const DENDRON_REL = "tools/routekit-shell/packages/mcp-dendron/src/server.mjs";
const FIGMA_REL = "tools/routekit-shell/packages/mcp-figma-bridge/src/server.mjs";
const VALID_RKS = { type: "stdio", command: "node", args: [RKS_REL] };

// Otherwise-complete fixture: every non-mcp check is ok. No MCP config is written.
function makeMinimalProject(prefix) {
  const projectRoot = makeTempDir(prefix);
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
  // Placeholder vendored entrypoints so verify doesn't warn about missing entrypoints.
  for (const rel of [RKS_REL, DENDRON_REL, FIGMA_REL]) {
    ensureDir(path.dirname(path.join(projectRoot, rel)));
    fs.writeFileSync(path.join(projectRoot, rel), "", "utf8");
  }
  return projectRoot;
}

function writeRootMcp(projectRoot, mcpServers) {
  writeFile(path.join(projectRoot, ".mcp.json"), JSON.stringify({ mcpServers }, null, 2));
}

const find = (result, id) => result.checks.find((c) => c.id === id);
const has = (result, id, status) => result.checks.some((c) => c.id === id && c.status === status);

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

    writeFile(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
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
    expect(fs.existsSync(path.join(projectRoot, ".vscode", "mcp.json"))).toBe(false);
    expect(result.status).toBe("ok");
  });

  it("fails when the required rks MCP server is missing from root .mcp.json", () => {
    const projectRoot = makeTempDir("verify_project_missing");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "verify-project-missing", private: true }, null, 2));
    writeFile(path.join(projectRoot, "routekit", "project.json"), JSON.stringify({ id: "p" }, null, 2));
    writeFile(path.join(projectRoot, "routekit", "kg.yaml"), "name: p\nversion: 1\n");
    ensureDir(path.join(projectRoot, "notes"));
    writeRootMcp(projectRoot, { dendron: { type: "stdio", command: "node", args: [DENDRON_REL] } });

    const result = verifyProjectRoot(projectRoot);
    expect(result.status).toBe("fail");
    expect(has(result, "mcp.server.rks", "fail")).toBe(true);
  });

  it("fails when dendron.yml has no workspace.vaults", () => {
    const projectRoot = makeTempDir("verify_project_bad_dendron");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "verify-project", private: true }, null, 2));
    writeFile(path.join(projectRoot, "routekit", "project.json"), JSON.stringify({ id: "verify-project" }, null, 2));
    writeFile(path.join(projectRoot, "routekit", "kg.yaml"), "framework: eleventy-nunjucks\ncode_roots:\n  - src\n  - notes\n");
    ensureDir(path.join(projectRoot, "notes"));
    writeFile(path.join(projectRoot, "dendron.yml"), "version: 5\nworkspace:\n  name: notes\n");
    writeFile(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
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

  describe("root .mcp.json (mcpServers)", () => {
    it("ok with only mcpServers.rks and no .vscode directory", () => {
      const root = makeMinimalProject("verify_root_mcp_ok");
      writeRootMcp(root, { rks: VALID_RKS });
      expect(fs.existsSync(path.join(root, ".vscode"))).toBe(false);
      const result = verifyProjectRoot(root);
      expect(find(result, "mcp.config")?.status).toBe("ok");
      expect(result.checks.some((c) => c.id.startsWith("mcp.") && c.status === "fail")).toBe(false);
    });

    it("fails mcp.config with exactly 'Missing .mcp.json' when no root .mcp.json and no .vscode", () => {
      const root = makeMinimalProject("verify_root_mcp_missing");
      const check = find(verifyProjectRoot(root), "mcp.config");
      expect(check?.status).toBe("fail");
      expect(check?.message).toBe("Missing .mcp.json");
    });

    it("does not accept a legacy .vscode/mcp.json (servers) as a substitute", () => {
      const root = makeMinimalProject("verify_root_mcp_legacy_only");
      writeFile(path.join(root, ".vscode", "mcp.json"), JSON.stringify({ servers: { rks: VALID_RKS } }, null, 2));
      const check = find(verifyProjectRoot(root), "mcp.config");
      expect(check?.status).toBe("fail");
      expect(check?.message).toBe("Missing .mcp.json");
    });

    it("fails mcp.config with Invalid JSON: when root .mcp.json does not parse", () => {
      const root = makeMinimalProject("verify_root_mcp_badjson");
      writeFile(path.join(root, ".mcp.json"), "{ not json");
      const check = find(verifyProjectRoot(root), "mcp.config");
      expect(check?.status).toBe("fail");
      expect(check?.message.startsWith("Invalid JSON:")).toBe(true);
    });

    it("fails mcp.servers when root .mcp.json has no mcpServers object", () => {
      const root = makeMinimalProject("verify_root_mcp_noservers");
      writeFile(path.join(root, ".mcp.json"), JSON.stringify({ servers: { rks: VALID_RKS } }, null, 2));
      expect(has(verifyProjectRoot(root), "mcp.servers", "fail")).toBe(true);
    });

    it("fails mcp.server.rks and overall status when mcpServers lacks rks", () => {
      const root = makeMinimalProject("verify_root_mcp_norks");
      writeRootMcp(root, { github: { command: "npx", args: ["x"] } });
      const result = verifyProjectRoot(root);
      expect(has(result, "mcp.server.rks", "fail")).toBe(true);
      expect(result.status).toBe("fail");
    });

    it("no longer requires dendron or figma", () => {
      const root = makeMinimalProject("verify_root_mcp_rks_only");
      writeRootMcp(root, { rks: VALID_RKS });
      const result = verifyProjectRoot(root);
      expect(result.checks.some((c) => c.id === "mcp.server.dendron")).toBe(false);
      expect(result.checks.some((c) => c.id === "mcp.server.figma")).toBe(false);
    });

    it("fails figma shape for an empty object and for a bare type sse entry", () => {
      for (const figma of [{}, { type: "sse" }]) {
        const root = makeMinimalProject("verify_root_mcp_figma_bad");
        writeRootMcp(root, { rks: VALID_RKS, figma });
        expect(has(verifyProjectRoot(root), "mcp.server.figma.shape", "fail")).toBe(true);
      }
    });

    it("accepts a typeless figma command+args entry as stdio", () => {
      const root = makeMinimalProject("verify_root_mcp_figma_typeless");
      writeRootMcp(root, { rks: VALID_RKS, figma: { command: "node", args: [FIGMA_REL] } });
      const result = verifyProjectRoot(root);
      expect(has(result, "mcp.server.figma.shape", "fail")).toBe(false);
      expect(result.checks.some((c) => c.id === "mcp.server.figma.type")).toBe(false);
    });

    it("runs validateStdio on a typeless figma command+args entry (absolute arg warns)", () => {
      const root = makeMinimalProject("verify_root_mcp_figma_abs");
      writeRootMcp(root, { rks: VALID_RKS, figma: { command: "node", args: [path.join(root, FIGMA_REL)] } });
      expect(has(verifyProjectRoot(root), "mcp.server.figma.absolute_paths", "warn")).toBe(true);
    });

    it("does not treat a figma entry with type sse as stdio even with command+args", () => {
      const root = makeMinimalProject("verify_root_mcp_figma_sse_cmd");
      writeRootMcp(root, { rks: VALID_RKS, figma: { type: "sse", command: "node", args: [FIGMA_REL] } });
      expect(has(verifyProjectRoot(root), "mcp.server.figma.shape", "fail")).toBe(true);
    });

    it("warns (not fails) when a .vscode/mcp.json exists alongside root .mcp.json", () => {
      const root = makeMinimalProject("verify_root_mcp_both");
      writeRootMcp(root, { rks: VALID_RKS });
      writeFile(path.join(root, ".vscode", "mcp.json"), JSON.stringify({ servers: { rks: VALID_RKS } }, null, 2));
      const result = verifyProjectRoot(root);
      expect(result.checks.some((c) => c.status === "warn" && c.message.includes(".vscode/mcp.json"))).toBe(true);
      expect(result.checks.some((c) => c.status === "fail" && c.message.includes(".vscode/mcp.json"))).toBe(false);
      expect(result.status).toBe("warn");
    });

    it("a root .mcp.json written by ensureMcpJson verifies clean in strict and non-strict mode", () => {
      const root = makeMinimalProject("verify_root_mcp_ensure");
      ensureMcpJson({ projectRoot: root, projectId: "verify-project", shellRoot: REPO_ROOT });
      const written = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
      expect(written.mcpServers.rks.type).toBeUndefined();
      expect(path.isAbsolute(written.mcpServers.rks.args[0])).toBe(true);
      expect(fs.existsSync(written.mcpServers.rks.args[0])).toBe(true);
      expect(fs.existsSync(path.join(root, ".vscode"))).toBe(false);
      for (const opts of [{}, { strict: true }]) {
        const result = verifyProjectRoot(root, opts);
        expect(
          result.checks.filter((c) => c.id.startsWith("mcp.") && (c.status === "warn" || c.status === "fail"))
        ).toEqual([]);
        expect(result.status).toBe("ok");
      }
    });

    it("warns path_exists (only) for a typeless rks entry whose absolute script is missing", () => {
      const root = makeMinimalProject("verify_root_mcp_rks_missing_abs");
      writeRootMcp(root, { rks: { command: "node", args: [path.join(root, "nowhere", "packages", "x.mjs")] } });
      const result = verifyProjectRoot(root);
      expect(has(result, "mcp.server.rks.path_exists", "warn")).toBe(true);
      expect(result.checks.some((c) => c.id === "mcp.server.rks.type")).toBe(false);
      expect(result.checks.some((c) => c.id === "mcp.server.rks.absolute_paths")).toBe(false);
    });

    it("still warns type for a present non-stdio type", () => {
      const root = makeMinimalProject("verify_root_mcp_dendron_sse");
      writeRootMcp(root, { rks: VALID_RKS, dendron: { type: "sse", command: "node" } });
      expect(has(verifyProjectRoot(root), "mcp.server.dendron.type", "warn")).toBe(true);
    });

    it("still warns absolute_paths for non-rks stdio servers", () => {
      const root = makeMinimalProject("verify_root_mcp_dendron_abs");
      writeRootMcp(root, { rks: VALID_RKS, dendron: { type: "stdio", command: "node", args: [path.join(root, DENDRON_REL)] } });
      expect(has(verifyProjectRoot(root), "mcp.server.dendron.absolute_paths", "warn")).toBe(true);
    });
  });
});
