/**
 * Story: backlog.fix.project-init-mcp-points-at-unpublished-package
 *
 * Asserts ensureMcpJson() writes the child's rks server args[0] as an absolute
 * path to the invoking shell's packages/mcp-rks/bin/mcp-rks.mjs — matching
 * repin-mcp's shellMcpBinary(shellRoot) — instead of the former relative
 * "node_modules/@routekit/mcp-rks/bin/mcp-rks.mjs", which pointed at the
 * unpublished workspace-only package and made the child's rks server die on
 * first open.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureMcpJson } from "../../packages/cli/src/project/bootstrap.mjs";

const tmps = [];
function mkTmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), name));
  tmps.push(d);
  return d;
}
function readMcp(root) {
  return JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
}
afterEach(() => {
  for (const d of tmps.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const shellRoot = "/Users/example/routekit-shell-core";
const expectedBin = path.join(shellRoot, "packages", "mcp-rks", "bin", "mcp-rks.mjs");

describe("ensureMcpJson serverPath", () => {
  it("non-dev: args[0] is the absolute shell binary, never the unpublished node_modules path", () => {
    const root = mkTmp("mcpjson-nodev-");
    ensureMcpJson({ projectRoot: root, projectId: "p", dev: false, shellRoot });
    const arg0 = readMcp(root).mcpServers.rks.args[0];
    expect(arg0).toBe(expectedBin);
    expect(path.isAbsolute(arg0)).toBe(true);
    expect(arg0).not.toContain("node_modules/@routekit/mcp-rks");
  });

  it("matches repin-mcp's shellMcpBinary, so a fresh init needs no manual repin", () => {
    const root = mkTmp("mcpjson-match-");
    ensureMcpJson({ projectRoot: root, projectId: "p", dev: false, shellRoot });
    expect(readMcp(root).mcpServers.rks.args[0]).toBe(
      path.join(shellRoot, "packages/mcp-rks/bin/mcp-rks.mjs"),
    );
  });

  it("dev and non-dev produce the SAME absolute path after the fix", () => {
    const a = mkTmp("mcpjson-dev-");
    const b = mkTmp("mcpjson-nondev-");
    ensureMcpJson({ projectRoot: a, projectId: "p", dev: true, shellRoot });
    ensureMcpJson({ projectRoot: b, projectId: "p", dev: false, shellRoot });
    expect(readMcp(a).mcpServers.rks.args[0]).toBe(readMcp(b).mcpServers.rks.args[0]);
  });

  it("preserves command + env shape", () => {
    const root = mkTmp("mcpjson-shape-");
    ensureMcpJson({ projectRoot: root, projectId: "calc", dev: false, shellRoot });
    const rks = readMcp(root).mcpServers.rks;
    expect(rks.command).toBe("node");
    expect(rks.env.ROUTEKIT_PROJECT_ID).toBe("calc");
    expect(rks.env.ROUTEKIT_PROJECT_ROOT).toBe(root);
  });
});
