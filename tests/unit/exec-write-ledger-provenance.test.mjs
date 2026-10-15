/**
 * backlog.feat.executed-state-post-write-verification — Part B, the write ledger.
 *
 * hasValidProvenance in packages/hooks/lib/session-state.mjs ALREADY had a write-ledger
 * branch, and its own comment there says it is "the gate redirect-read-to-agent.mjs actually
 * fires". Nothing on the exec side ever recorded to that ledger, so a Governor could not read
 * back a file it had itself just written.
 *
 * WHY THIS ASSERTS THROUGH THE HOOKS COPY. Nothing in this suite executed
 * packages/hooks/lib/session-state.mjs at all before this file — the only prior references
 * treat it as text (a byte-parity guard) or as a path string. The cross-copy claim rested on
 * a string comparison, never on execution. A spy on recordWrittenPath, or an assertion against
 * the mcp-rks copy, would prove the call happened and NOT that the gate then permits the read,
 * which is the only thing that matters to a caller.
 *
 * Env must be set before either dynamic import: SESSION_DIR/STATE_PATH bind at import time,
 * and ROUTEKIT_PROJECT_ROOT takes precedence over CLAUDE_PROJECT_DIR (path-utils.mjs), so both
 * are controlled. The fixture lives under repoRoot rather than os.tmpdir() because macOS
 * resolves the latter through /private, which would break the startsWith(root) prefix strip in
 * normalizePath and make every lookup miss.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const registryPath = path.join(repoRoot, "projects", "index.jsonl");
const projectId = `wlp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projectRoot = path.join(repoRoot, `.tmp-wlp-${Date.now()}-${Math.random().toString(16).slice(2)}`);

// BEFORE the imports below. The registry root and these env vars must name the SAME directory,
// or exec writes into one project root while the ledger resolves against another.
const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
const prevClaudeDir = process.env.CLAUDE_PROJECT_DIR;
process.env.ROUTEKIT_PROJECT_ROOT = projectRoot;
process.env.CLAUDE_PROJECT_DIR = projectRoot;

const { runApplyTool } = await import("../../packages/mcp-rks/src/server.mjs");
const { hasValidProvenance, loadSessionState, saveSessionState, WRITE_LEDGER_TTL_MS } =
  await import("../../packages/hooks/lib/session-state.mjs");

const TARGET = "notes/hello.md";
const TARGET_2 = "notes/second.md";
let originalRegistry = null;
let runDir;

describe("rks_exec records what it wrote, and the read gate honours it", () => {
  beforeAll(async () => {
    originalRegistry = fs.existsSync(registryPath) ? fs.readFileSync(registryPath, "utf8") : null;
    fs.mkdirSync(path.join(projectRoot, "routekit"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "routekit", "project.json"),
      JSON.stringify({ id: projectId, baseBranch: "dev", kgFile: "routekit/kg.yaml" }, null, 2),
    );
    fs.writeFileSync(path.join(projectRoot, "routekit", "kg.yaml"), "code_roots: []\n");

    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const existing = originalRegistry ? originalRegistry.trim().split("\n").filter(Boolean) : [];
    fs.writeFileSync(
      registryPath,
      [...existing, JSON.stringify({ id: projectId, root: projectRoot })].filter(Boolean).join("\n") + "\n",
    );

    runDir = path.join(projectRoot, ".rks", "runs", `2026-wlp-${Date.now()}_wlp`);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "plan.json"),
      JSON.stringify({ steps: [{ action: "create_file", path: TARGET, content: "Hello world\n" }] }, null, 2),
    );
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({
        projectId,
        timestamps: { plannedAt: new Date().toISOString(), validatedAt: null, appliedAt: null },
        telemetry: { outcome: "planned" },
      }, null, 2),
    );

    const result = await runApplyTool({ projectId, label: "wlp", force: true });
    expect(result.ok, "the apply itself must succeed or nothing below means anything").toBe(true);
    expect(fs.existsSync(path.join(projectRoot, TARGET))).toBe(true);

    // SECOND apply, a separate run dir and a different target. runApplyTool declares its own
    // `const appliedFiles = []` per invocation; the retry-merge path operates on a DIFFERENT,
    // outer binding that a direct call never reaches. So one call cannot distinguish
    // per-invocation recording from recording hoisted to the outer caller — two can. Both
    // targets must be in the ledger afterwards.
    const runDir2 = path.join(projectRoot, ".rks", "runs", `2026-wlp2-${Date.now()}_wlp2`);
    fs.mkdirSync(runDir2, { recursive: true });
    fs.writeFileSync(
      path.join(runDir2, "plan.json"),
      JSON.stringify({ steps: [{ action: "create_file", path: TARGET_2, content: "Second\n" }] }, null, 2),
    );
    fs.writeFileSync(
      path.join(runDir2, "run.json"),
      JSON.stringify({
        projectId,
        timestamps: { plannedAt: new Date().toISOString(), validatedAt: null, appliedAt: null },
        telemetry: { outcome: "planned" },
      }, null, 2),
    );
    const result2 = await runApplyTool({ projectId, label: "wlp2", force: true });
    expect(result2.ok, "the second apply must succeed").toBe(true);
    expect(fs.existsSync(path.join(projectRoot, TARGET_2))).toBe(true);
  });

  afterAll(() => {
    if (originalRegistry !== null) fs.writeFileSync(registryPath, originalRegistry);
    else if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
    if (fs.existsSync(projectRoot)) fs.rmSync(projectRoot, { recursive: true, force: true });
    if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
    else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
    if (prevClaudeDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevClaudeDir;
  });

  it("THE WITNESS: the hooks-side gate grants a read of the file exec just wrote", () => {
    // Queried in the RELATIVE form, which is what redirect-read-to-agent.mjs supplies after
    // its path.relative() call — and the form appliedFiles already stores.
    const verdict = hasValidProvenance(TARGET);
    expect(verdict.valid, "the read gate still denies a file this session created").toBe(true);
    expect(verdict.source).toBe("session_write");
  });

  it("PER-INVOCATION: both applies are in the ledger, not just the last", () => {
    // Fails if recording were hoisted to the outer caller, or done once at the end of a run
    // rather than per runApplyTool invocation.
    expect(hasValidProvenance(TARGET).valid, "first apply missing from the ledger").toBe(true);
    expect(hasValidProvenance(TARGET_2).valid, "second apply missing from the ledger").toBe(true);
  });

  it("ANTI-VACUITY: a path exec did NOT write is still denied", () => {
    // Without this, the assertion above would pass against a gate that granted everything.
    expect(hasValidProvenance("notes/never-written-by-this-run.md").valid).toBe(false);
  });

  it("TTL — an entry older than the window no longer grants", () => {
    const state = loadSessionState();
    const entry = (state.writtenPaths || []).find((w) => w.path.endsWith("hello.md"));
    expect(entry, "no ledger entry to age — the fix did not record").toBeTruthy();
    const original = entry.timestamp;
    entry.timestamp = Date.now() - WRITE_LEDGER_TTL_MS - 1000;
    saveSessionState(state);
    try {
      expect(hasValidProvenance(TARGET).valid, "an expired ledger entry must not be a standing read grant").toBe(false);
    } finally {
      entry.timestamp = original;
      saveSessionState(state);
    }
  });

  it("TTL — the SAME entry just inside the window still grants", () => {
    // Paired with the case above on purpose: alone, that one can pass for an unrelated reason.
    // This proves the revocation is the TTL doing the work and not something else.
    const state = loadSessionState();
    const entry = (state.writtenPaths || []).find((w) => w.path.endsWith("hello.md"));
    expect(entry, "no ledger entry to age — the fix did not record").toBeTruthy();
    const original = entry.timestamp;
    entry.timestamp = Date.now() - WRITE_LEDGER_TTL_MS + 5000;
    saveSessionState(state);
    try {
      expect(hasValidProvenance(TARGET).valid).toBe(true);
    } finally {
      entry.timestamp = original;
      saveSessionState(state);
    }
  });
});
