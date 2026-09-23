import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Redirect the session-state store BEFORE importing session-state.mjs.
// clearSessionState() writes defaultState() into SESSION_DIR, which resolves via
// getProjectRoot() → ROUTEKIT_PROJECT_ROOT || CLAUDE_PROJECT_DIR || process.cwd().
// Without this redirect the beforeEach below would wipe the LIVE repo's
// .rks/session/state.json on every test. Precedent: tests/unit/session-state.test.mjs:6-7.
const TEST_PROJECT_DIR = path.join(process.cwd(), ".tmp-test-git-provenance");
process.env.CLAUDE_PROJECT_DIR = TEST_PROJECT_DIR;

// NOTE (pass-3 Finding 1): resolveHookPath() is deliberately NOT imported here.
// Off-rail it resolves to `.routekit/hooks.bak/read/` (PRE-EDIT bytes) for the
// read tier and to a stale `.routekit/hooks/lib/` for the lib tier — it would
// shadow every hand-edit this file exists to verify. Read canonical directly.
const { hasValidProvenance, clearSessionState } = await import(
  "../../packages/mcp-rks/src/shared/session-state.mjs"
);

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const HOOKS_COPY = path.join(REPO_ROOT, "packages/hooks/lib/session-state.mjs");
const MCP_COPY = path.join(
  REPO_ROOT,
  "packages/mcp-rks/src/shared/session-state.mjs",
);
// Valid to assert by direct path only because the build sequence runs
// `node scripts/sync-hooks.mjs` after the packages/hooks/** edits and before the
// test run — off-rail that run is the ONLY producer of these bytes
// (scripts/sync-hooks.mjs:133-146, templateSynced :137, skippedProject :138).
const TEMPLATE_LIB = path.join(
  REPO_ROOT,
  "templates/generic/.routekit/hooks/lib/session-state.mjs",
);
const REDIRECT_HOOK = path.join(
  REPO_ROOT,
  "packages/hooks/read/redirect-read-to-agent.mjs",
);

const FORBIDDEN = [
  "hasGitProvenance",
  "getGitChangedFiles",
  "gitProvenanceCache",
  "GIT_CACHE_TTL_MS",
  "git diff --name-only main...HEAD",
  "source: 'git'",
  'import { execSync } from "child_process"',
];

/**
 * Files touched on the current branch, i.e. exactly the set the removed
 * git-provenance grant used to admit. Explicit timeout is mandatory.
 */
function branchTouchedFiles() {
  const result = spawnSync("git", ["diff", "--name-only", "main...HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return [];
  return result.stdout.trim().split("\n").filter(Boolean);
}

describe("git provenance removal", () => {
  beforeEach(() => {
    clearSessionState();
  });

  afterEach(() => {
    try {
      fs.rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("denies a branch-touched file that has no other provenance", () => {
    // A file present in `git diff --name-only main...HEAD` with no rag/user/
    // plan/write-ledger grant must now be DENIED. Before this change the git
    // branch in hasValidProvenance() returned { valid: true, source: 'git' }.
    const touched = branchTouchedFiles();
    // Fall back to a file that is unconditionally branch-adjacent if the diff
    // cannot be resolved (e.g. shallow clone with no `main` ref in CI).
    const candidates = touched.length
      ? touched.slice(0, 5)
      : ["packages/hooks/lib/session-state.mjs"];
    for (const file of candidates) {
      const result = hasValidProvenance(file);
      expect(result.valid, `${file} must not be granted a read`).toBe(false);
      expect(result.source).toBeNull();
    }
  });

  it("never reports source 'git' for any input", () => {
    for (const p of [
      "packages/hooks/lib/session-state.mjs",
      "CLAUDE.md",
      "some/unrelated/file.ts",
    ]) {
      expect(hasValidProvenance(p).source).not.toBe("git");
    }
  });

  it.each([HOOKS_COPY, MCP_COPY, TEMPLATE_LIB])(
    "%s carries no git-provenance symbols",
    (file) => {
      const src = fs.readFileSync(file, "utf8");
      for (const sym of FORBIDDEN) expect(src).not.toContain(sym);
      // The write-ledger comment must no longer cite the deleted constant.
      expect(src).not.toContain("mirroring GIT_CACHE_TTL_MS");
    },
  );

  it("both vendored session-state copies are byte-identical", () => {
    // A REAL byte-equality assertion: the pre-existing parity test at
    // tests/unit/session-state.test.mjs:167 only checks a shared durable phrase
    // and would pass on a one-sided removal.
    expect(fs.readFileSync(HOOKS_COPY, "utf8")).toBe(
      fs.readFileSync(MCP_COPY, "utf8"),
    );
  });

  // PASS-3 FINDING 1. Canonical path, read directly: always present and always
  // fresh in either guardrails posture. Both phrases below had ZERO occurrences
  // in the file pre-edit (verified @255803f4), so this test is RED until the
  // header is actually rewritten. The assertions this replaces — toContain(
  // "hasValidProvenance(relativePath)") and not.toContain("git diff") — both
  // passed against the UNEDITED file and therefore pinned nothing.
  it("the redirect hook header enumerates the real allow set", () => {
    const src = fs.readFileSync(REDIRECT_HOOK, "utf8");
    expect(src).toContain("write-ledger");
    expect(src).toContain("Branch membership is NOT a read grant");
    // The four grants the stale header already named remain enumerated…
    expect(src).toContain("runtime_paths from read-policy.yaml");
    expect(src).toContain("RAG-sourced in session state");
    expect(src).toContain("Files explicitly mentioned by the user");
    expect(src).toContain("current plan's targetFiles");
    // …alongside the two it was silent on, plus off-rail allowedFiles.
    expect(src).toContain("allowedFiles");
    expect(src).toMatch(/harness output/);
  });
});
