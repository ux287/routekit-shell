import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeTempDir, ensureDir, writeFile } from "./helpers/tmp.mjs";
import {
  getDefaultVendoredMcpConfig,
  getDefaultWorkspaceMcpConfig,
  getDefaultMcpConfig,
  mergeMcpConfig,
} from "../packages/cli/src/mcp/config.mjs";

describe("mcp config defaults", () => {
  it("includes figma as a default server (vendored)", () => {
    const cfg = getDefaultVendoredMcpConfig();
    expect(cfg.servers.figma.type).toBe("stdio");
    expect(cfg.servers.figma.command).toBe("node");
    expect(cfg.servers.figma.args).toEqual(["tools/routekit-shell/packages/mcp-figma-bridge/src/server.mjs"]);
    expect(cfg.servers.figma.cwd).toBe(".");
    expect(cfg.servers.figma.env.FIGMA_MCP_URL).toBe("http://127.0.0.1:3845/mcp");
    expect(cfg.servers.figma.env.ROUTEKIT_PROJECT_ROOT).toBe(".");
  });

  it("applies project-root binding to all default servers", () => {
    const cfg = getDefaultVendoredMcpConfig();
    for (const name of Object.keys(cfg.servers)) {
      expect(cfg.servers[name].cwd).toBe(".");
      expect(cfg.servers[name].env.ROUTEKIT_PROJECT_ROOT).toBe(".");
    }
  });

  it("emits repo-local paths when shellRoot is the project root", () => {
    const projectRoot = makeTempDir("mcp_cfg_repo");
    ensureDir(path.join(projectRoot, "routekit"));
    writeFile(path.join(projectRoot, "routekit", "project.json"), JSON.stringify({ id: "p" }, null, 2));
    const cfg = getDefaultMcpConfig({ cwd: projectRoot, shellRoot: projectRoot, env: {} });
    expect(cfg.servers.rks.args).toEqual(["packages/mcp-rks/src/server.mjs"]);
    expect(cfg.servers.dendron.args).toEqual(["packages/mcp-dendron/src/server.mjs"]);
    expect(cfg.servers.figma.args).toEqual(["packages/mcp-figma-bridge/src/server.mjs"]);
  });

  it("emits tools/routekit-shell paths when running inside a vendored shell", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp_cfg_vendored_"));
    const shellRoot = path.join(projectRoot, "tools", "routekit-shell");
    ensureDir(path.join(projectRoot, "tools", "routekit-shell", "packages"));
    const cwd = path.join(shellRoot, "packages", "cli");
    ensureDir(cwd);
    const cfg = getDefaultMcpConfig({ cwd, shellRoot, env: {} });
    expect(cfg.servers.rks.args).toEqual(["tools/routekit-shell/packages/mcp-rks/src/server.mjs"]);
    expect(cfg.servers.dendron.args).toEqual(["tools/routekit-shell/packages/mcp-dendron/src/server.mjs"]);
    expect(cfg.servers.figma.args).toEqual(["tools/routekit-shell/packages/mcp-figma-bridge/src/server.mjs"]);
  });

  it("includes figma as a default server (workspace)", () => {
    const cfg = getDefaultWorkspaceMcpConfig();
    expect(cfg.servers.figma).toEqual({
      type: "stdio",
      command: "node",
      args: ["packages/mcp-figma-bridge/src/server.mjs"],
      cwd: ".",
      env: { ROUTEKIT_PROJECT_ROOT: ".", RKS_PROJECT_ROOT: ".", FIGMA_MCP_URL: "http://127.0.0.1:3845/mcp" },
    });
  });

  it("merge preserves existing servers and adds missing defaults", () => {
    const defaults = getDefaultVendoredMcpConfig();
    const existing = {
      servers: {
        rks: { type: "stdio", command: "node", args: ["custom-rks.mjs"] },
      },
      inputs: ["keep-me"],
    };
    const merged = mergeMcpConfig(existing, defaults);
    expect(merged.servers.rks.args).toEqual(["custom-rks.mjs"]);
    expect(merged.servers.dendron).toBeTruthy();
    expect(merged.servers.figma).toBeTruthy();
    expect(merged.inputs).toEqual(["keep-me"]);
  });
});
