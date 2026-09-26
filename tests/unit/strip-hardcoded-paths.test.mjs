import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// P1 release-blocker coverage: no file that ships in the rks-public snapshot may contain
// an absolute /Users/<name> home path (identity/path disclosure + clone breakage). The MCP
// servers must derive PROJECT_ROOT from env||cwd instead.
//
// The guard is built from FRAGMENTS (below) so this test file itself carries no plaintext
// identity string when it ships under tests/**. It targets the owner's absolute home path
// specifically — NOT generic /Users/<other> fixtures (e.g. path-utils' "/Users/test/project",
// which is legitimate test data for a path-normalization library).
//
// These are SOURCE assertions, not behavioral spawns: the scripts/mcp/* servers open an MCP
// stdio/SSE transport on startup and block waiting for a peer, so spawning them in vitest
// would hang (violating the project's subprocess-timeout discipline). A source-level grep for
// the owner home path returning zero hits is the governing AC and is enforced here.

const HOME_PATH = new RegExp("/Users/" + "vince" + "mease"); // owner home path, fragmented

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const SERVERS = [
  "scripts/mcp/dendron-server.mjs",
  "scripts/mcp/dendron-server-http.mjs",
  "scripts/mcp/governance-server-http.mjs",
];
const TEMPLATE_SCRIPTS = [
  "templates/app-web/scripts/mcp/contextual-server.mjs",
  "templates/app-web/scripts/mcp/hybrid-router.mjs",
];
// Every file that ships and was touched by this story — the governing grep guard.
const GUARDED = [
  ...SERVERS,
  ...TEMPLATE_SCRIPTS,
  ".routekit/read-policy.yaml",
  "tests/unit/path-utils.spec.mjs",
];

describe("strip hardcoded home paths from the public snapshot (P1 release blocker)", () => {
  it("GOVERNING AC: no guarded file contains an absolute /Users home path", () => {
    const offenders = GUARDED.filter((f) => HOME_PATH.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it("the three scripts/mcp servers derive PROJECT_ROOT from env||cwd", () => {
    for (const f of SERVERS) {
      const src = read(f);
      expect(src).toContain("process.env.ROUTEKIT_PROJECT_ROOT || process.cwd()");
      expect(src).toMatch(/const PROJECT_ROOT = process\.env\.ROUTEKIT_PROJECT_ROOT \|\| process\.cwd\(\);/);
      expect(src).not.toMatch(HOME_PATH);
    }
  });

  it("the dendron servers preserve NOTES_DIR = join(PROJECT_ROOT, 'notes')", () => {
    for (const f of ["scripts/mcp/dendron-server.mjs", "scripts/mcp/dendron-server-http.mjs"]) {
      expect(read(f)).toMatch(/NOTES_DIR = join\(PROJECT_ROOT, "notes"\)/);
    }
  });

  it("the app-web template scripts drop the hardcoded traders.lancedb path + home paths and derive from env/cwd", () => {
    // NB: this is a trading-themed example template, so the domain word "traders"/"trading"
    // legitimately appears in comments and the example RAG server name. The LEAK was the
    // hardcoded absolute path .../.routekit/rag/traders.lancedb — that specific path must go.
    for (const f of TEMPLATE_SCRIPTS) {
      const src = read(f);
      expect(src).not.toMatch(/traders\.lancedb/);
      expect(src).not.toMatch(HOME_PATH);
      expect(src).toContain("process.env.ROUTEKIT_PROJECT_ROOT || process.cwd()");
    }
  });

  it(".routekit/read-policy.yaml no longer allowlists the uat-agents-1 machine path", () => {
    const src = read(".routekit/read-policy.yaml");
    expect(src).not.toMatch(/uat-agents-1/);
    expect(src).not.toMatch(HOME_PATH);
  });

  it("path-utils.spec.mjs fixture is parameterized to a neutral root", () => {
    const src = read("tests/unit/path-utils.spec.mjs");
    expect(src).not.toMatch(HOME_PATH);
    // the fixture still exercises pathsMatch with an absolute projectRoot
    expect(src).toContain("/tmp/rks-fixture/routekit-shell");
  });
});
