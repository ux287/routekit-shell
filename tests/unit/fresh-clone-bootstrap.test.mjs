import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

// P1 turnkey coverage: a fresh clone of the public repo must be runnable.
// Config-consistency layer only — the AC "a clean install of the extracted snapshot
// succeeds" is a build-time verification (git archive → npm install in a temp dir),
// NOT a vitest unit test (a real network install violates the subprocess/CI-hygiene rules).

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

describe("fresh-clone bootstrap — portable .mcp.json.example", () => {
  const raw = read(".mcp.json.example");
  const cfg = JSON.parse(raw);

  it("is valid JSON with an mcpServers object", () => {
    expect(typeof cfg.mcpServers).toBe("object");
  });

  it("defines both rks and rks-gov servers with workspace-relative args", () => {
    expect(cfg.mcpServers.rks.args).toEqual(["packages/mcp-rks/bin/mcp-rks.mjs"]);
    expect(cfg.mcpServers["rks-gov"].args).toEqual(["scripts/mcp/governance-server.mjs"]);
    for (const s of Object.values(cfg.mcpServers)) {
      for (const a of s.args || []) {
        expect(a.startsWith("/")).toBe(false); // relative, not absolute
      }
    }
  });

  it("resolves root from cwd (NO ${workspaceFolder}) and keeps the project id", () => {
    // ${workspaceFolder} isn't reliably expanded by the editor and reached rks code as a literal,
    // breaking story creation (dendron resolveProjectRoot had no existence guard). The servers
    // derive root from cwd instead — relative args prove cwd = project root; rks pins ".".
    expect(cfg.mcpServers.rks.env.ROUTEKIT_PROJECT_ROOT).toBe(".");
    expect(cfg.mcpServers.rks.env.ROUTEKIT_REPO_ROOT).toBeUndefined();
    expect(cfg.mcpServers["rks-gov"].env.ROUTEKIT_REPO_ROOT).toBeUndefined();
    expect(cfg.mcpServers["rks-gov"].env.ROUTEKIT_PROJECT_ID).toBe("routekit-shell-core");
  });

  it("carries NO leftover placeholders (__FOO__), absolute /Users paths, or ${workspaceFolder} tokens", () => {
    expect(raw).not.toMatch(/__[A-Z_]+__/);
    expect(raw).not.toMatch(/\/Users\//);
    expect(raw).not.toContain("${workspaceFolder}");
  });
});

describe("fresh-clone bootstrap — rks-public profile ships the example, npm-canonical", () => {
  const profiles = yaml.load(read(".routekit/publish-profiles.yaml"));
  const rksPublic = profiles.profiles["rks-public"];

  it(".mcp.json.example is in the rks-public include allowlist", () => {
    expect(rksPublic.include).toContain(".mcp.json.example");
  });

  it("keeps its Story-2 exclude block intact (this edit is additive)", () => {
    expect(rksPublic.include.length).toBeGreaterThan(0);
    expect(Array.isArray(rksPublic.exclude)).toBe(true);
    expect(rksPublic.exclude).toContain("scripts/publish-to-ux287.mjs");
  });

  it("ships the npm lockfile but NOT pnpm-workspace.yaml (single, npm signal)", () => {
    expect(rksPublic.include).toContain("package-lock.json");
    expect(rksPublic.include).not.toContain("pnpm-workspace.yaml");
  });
});

describe("fresh-clone bootstrap — package manager is unambiguously npm", () => {
  const pkg = JSON.parse(read("package.json"));

  it("has no workspace:* (pnpm-only) dependency specifiers", () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    const wsStar = Object.entries(all).filter(([, v]) => String(v).startsWith("workspace:"));
    expect(wsStar).toEqual([]);
  });

  it("declares npm workspaces and resolves @routekit/cli to the local workspace", () => {
    expect(pkg.workspaces).toContain("packages/*");
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(all["@routekit/cli"]).toBe("*");
  });
});

describe("fresh-clone bootstrap — README documents the bootstrap", () => {
  const readme = read("README.md");
  it("documents `cp .mcp.json.example .mcp.json`", () => {
    expect(readme).toContain("cp .mcp.json.example .mcp.json");
  });
  it("documents the npm install command", () => {
    expect(readme).toMatch(/npm install/);
  });
});
