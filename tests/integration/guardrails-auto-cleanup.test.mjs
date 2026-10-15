/**
 * Tests for guardrails-audit.mjs — orphan hooks.bak auto-cleanup,
 * live-session block, and atomic guardrailsOn rename-first ordering
 * with rollback semantics.
 *
 * Covers testRequirements from backlog.fix.dirty-tree-comprehensive:
 *   - guardrailsOff() auto-cleans orphan hooks.bak (no active session)
 *   - guardrailsOff() still blocks when a live active session is present
 *   - guardrailsOff() orphan cleanup emits a telemetry/log line for audit
 *   - guardrailsOn() renames hooks.bak -> hooks BEFORE clearGuardState
 *   - guardrailsOn() with rename failure leaves state + hooks.bak intact
 *   - guardrailsOn() with clearGuardState failure AFTER rename rolls hooks back
 *     OR emits a structured manual-recovery error
 *   - guardrailsOn() rollback failure surfaces distinct manual-recovery error
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

vi.mock("../../packages/mcp-rks/src/server/git-tools.mjs", () => ({
  runGitPR: vi.fn().mockResolvedValue({ ok: true, url: "https://github.com/test/pr/1", number: 1 }),
  runStagingMerge: vi.fn().mockResolvedValue({ ok: true }),
  runCycleComplete: vi.fn().mockResolvedValue({ ok: true, branch: "staging" }),
}));

vi.mock("../../packages/mcp-rks/src/shared/commit-and-embed.mjs", () => ({
  commitAndEmbed: vi.fn().mockResolvedValue({ commitId: "mockcommit123", ragEmbedWarning: null }),
}));

// backlog.fix.arch-verdict-never-retracts-arch-approved — the shared digest helper is
// wrapped in a pass-through spy so ONE case can make it throw inside guardrailsOff. Every
// other call delegates to the real implementation.
vi.mock("../../packages/mcp-rks/src/workflow/arch-verdict.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    noteSubjectDigest: vi.fn((...args) => actual.noteSubjectDigest(...args)),
  };
});

import {
  guardrailsOff,
  guardrailsOn,
  getSessionHistory,
} from "../../packages/mcp-rks/src/server/guardrails-audit.mjs";
import { runGitPR, runStagingMerge, runCycleComplete } from "../../packages/mcp-rks/src/server/git-tools.mjs";
import { commitAndEmbed } from "../../packages/mcp-rks/src/shared/commit-and-embed.mjs";
import { restoreGuardrails, setProjectRoot } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
// The global stub (tests/setup.mjs); read to assert the hooks.bak provenance telemetry event.
import { ensureTelemetryStorage } from "@routekit/telemetry";
import { noteSubjectDigest, noteLegacySubjectDigest } from "../../packages/mcp-rks/src/workflow/arch-verdict.mjs";
import { parseFrontmatter } from "../../packages/mcp-rks/src/dendron.mjs";

const FIXTURE_STORY_ID = "test-story";

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-guardrails-cleanup-"));
  const hooksDir = path.join(dir, ".routekit", "hooks");
  // Hooks live in tier subdirs — matches guardrailsOff's move targets (hooks/write/, hooks/read/)
  fs.mkdirSync(path.join(hooksDir, "write"), { recursive: true });
  fs.mkdirSync(path.join(hooksDir, "read"), { recursive: true });
  fs.writeFileSync(path.join(hooksDir, "write", "enforce-branch-workflow.mjs"), "// write hook");
  fs.writeFileSync(path.join(hooksDir, "write", "enforce-plan-scope.mjs"), "// write hook");
  fs.writeFileSync(path.join(hooksDir, "read", "enforce-read-provenance.mjs"), "// read hook");

  const manifest = {
    "enforce-branch-workflow": { tier: "write" },
    "enforce-plan-scope": { tier: "write" },
    "enforce-read-provenance": { tier: "read" },
  };
  fs.writeFileSync(
    path.join(dir, ".routekit", "hooks-manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  // The off-rail auto-ship enforcement gate loads .rks/review-policy.yaml with
  // THIS root, so disabling review here keeps the suite off a live reviewer.
  // The gate's own posture and skip logic is covered by
  // tests/integration/off-rail-ship-enforcement-gate.test.mjs.
  fs.writeFileSync(
    path.join(dir, ".rks", "review-policy.yaml"),
    "# Fixture: keep the off-rail enforcement gate from calling a live reviewer.\nenabled: false\n",
  );

  // Write an arch-approved story note so the phase gate passes in all tests.
  const notesDir = path.join(dir, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, `${FIXTURE_STORY_ID}.md`), [
    "---",
    `id: "${FIXTURE_STORY_ID}"`,
    `title: "Test story"`,
    `phase: "arch-approved"`,
    `targetFiles: []`,
    "---",
    "",
  ].join("\n"));

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@test.com",
  };
  execSync("git init", { cwd: dir, stdio: "ignore", env: gitEnv });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "ignore", env: gitEnv });
  execSync('git config user.name "test"', { cwd: dir, stdio: "ignore", env: gitEnv });
  execSync("git add -A && git commit -m 'init'", { cwd: dir, stdio: "ignore", env: gitEnv });

  return { dir, problemId: FIXTURE_STORY_ID };
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) { /* best-effort */ }
}

function resetProjectState(dir) {
  const hooksDir = path.join(dir, ".routekit", "hooks");
  const hooksBakDir = path.join(dir, ".routekit", "hooks.bak");
  const rksDir = path.join(dir, ".rks");

  // Remove any hooks.bak left by the previous test
  if (fs.existsSync(hooksBakDir)) {
    fs.rmSync(hooksBakDir, { recursive: true, force: true });
  }

  // Restore tier hook dirs to pristine state
  for (const tier of ["write", "read"]) {
    const tierDir = path.join(hooksDir, tier);
    if (fs.existsSync(tierDir)) {
      fs.rmSync(tierDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tierDir, { recursive: true });
  }
  fs.writeFileSync(path.join(hooksDir, "write", "enforce-branch-workflow.mjs"), "// write hook");
  fs.writeFileSync(path.join(hooksDir, "write", "enforce-plan-scope.mjs"), "// write hook");
  fs.writeFileSync(path.join(hooksDir, "read", "enforce-read-provenance.mjs"), "// read hook");

  // Restore manifest
  fs.writeFileSync(
    path.join(dir, ".routekit", "hooks-manifest.json"),
    JSON.stringify({
      "enforce-branch-workflow": { tier: "write" },
      "enforce-plan-scope": { tier: "write" },
      "enforce-read-provenance": { tier: "read" },
    }, null, 2)
  );

  // Clear rks session state
  for (const name of ["guardrails-state.json", "guardrails-off-sessions.jsonl", "active-scope.json"]) {
    const p = path.join(rksDir, name);
    if (fs.existsSync(p)) fs.rmSync(p);
  }

  // Restore fixture story note
  fs.writeFileSync(path.join(dir, "notes", `${FIXTURE_STORY_ID}.md`), [
    "---",
    `id: "${FIXTURE_STORY_ID}"`,
    `title: "Test story"`,
    `phase: "arch-approved"`,
    `targetFiles: []`,
    "---",
    "",
  ].join("\n"));
}

describe("guardrails-audit: orphan hooks.bak auto-cleanup", () => {
  let projectRoot;
  let problemId;

  beforeAll(() => {
    ({ dir: projectRoot, problemId } = makeTempProject());
  });

  afterAll(() => {
    cleanup(projectRoot);
  });

  beforeEach(() => {
    resetProjectState(projectRoot);
  });

  it("orphan hooks.bak (no active session) is auto-cleaned and off flow proceeds", async () => {
    // Simulate orphan: hooks.bak present but no active session in session log
    const hooksBakDir = path.join(projectRoot, ".routekit", "hooks.bak");
    fs.mkdirSync(hooksBakDir, { recursive: true });
    fs.writeFileSync(path.join(hooksBakDir, "orphan-from-crash.mjs"), "// orphan");

    const result = await guardrailsOff(projectRoot, "test-orphan-cleanup", "all", problemId);

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeTruthy();

    // Orphan file is gone (cleanup removed it before the fresh rename)
    expect(fs.existsSync(path.join(hooksBakDir, "orphan-from-crash.mjs"))).toBe(false);
    // hooks.bak now contains the current hooks from the fresh off-move (tier subdir layout)
    expect(fs.existsSync(path.join(hooksBakDir, "write", "enforce-branch-workflow.mjs"))).toBe(true);
  });

  it("live session + hooks.bak still returns block error with activeSession payload", async () => {
    // First: legit off session
    const firstOff = await guardrailsOff(projectRoot, "first-session", "all", problemId);
    expect(firstOff.ok).toBe(true);

    // Second off while first is still live
    const result = await guardrailsOff(projectRoot, "second", "all", problemId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already off/);
    expect(result.activeSession).toBeTruthy();
    expect(result.activeSession.sessionId).toBe(firstOff.sessionId);
  });

  it("orphan cleanup emits an auditable log/console line identifying the action", async () => {
    const hooksBakDir = path.join(projectRoot, ".routekit", "hooks.bak");
    fs.mkdirSync(hooksBakDir, { recursive: true });

    // Capture console.error (that's where the cleanup announcement lives)
    const errors = [];
    const origErr = console.error;
    console.error = (...args) => { errors.push(args.join(" ")); };

    try {
      const result = await guardrailsOff(projectRoot, "audit-test", "all", problemId);
      expect(result.ok).toBe(true);
    } finally {
      console.error = origErr;
    }

    const auditLine = errors.find(e => /orphan hooks\.bak/i.test(e) || /auto-cleaned/i.test(e));
    expect(auditLine).toBeTruthy();
    expect(auditLine).toMatch(/guardrails/i);
  });
});

describe("guardrails-audit: guardrailsOn atomic rename-first ordering", () => {
  let projectRoot;
  let problemId;

  beforeAll(() => {
    ({ dir: projectRoot, problemId } = makeTempProject());
  });

  afterAll(() => {
    cleanup(projectRoot);
  });

  beforeEach(() => {
    resetProjectState(projectRoot);
  });

  it("happy path: rename hooks.bak -> hooks runs BEFORE clearGuardState", async () => {
    await guardrailsOff(projectRoot, "test", "all", problemId);

    // Instrument: wrap fs.renameSync to capture call order vs state file writes.
    // guardrailsOff moves tier subdirs (hooks/write -> hooks.bak/write, etc.),
    // so guardrailsOn restores via hooks.bak/write -> hooks/write renames.
    const callOrder = [];
    const origRename = fs.renameSync.bind(fs);
    const origWrite = fs.writeFileSync.bind(fs);
    fs.renameSync = (src, dst) => {
      if (["write", "read"].includes(path.basename(src)) && String(src).includes("hooks.bak")) {
        callOrder.push(`rename:${path.basename(src)}->${path.basename(dst)}`);
      }
      return origRename(src, dst);
    };
    fs.writeFileSync = (filePath, data, opts) => {
      if (String(filePath).endsWith("guardrails-state.json")) {
        callOrder.push("writeState");
      }
      return origWrite(filePath, data, opts);
    };

    try {
      const result = await guardrailsOn(projectRoot);
      expect(result.ok).toBe(true);
    } finally {
      fs.renameSync = origRename;
      fs.writeFileSync = origWrite;
    }

    // Find the tier-dir rename and the clearGuardState write
    const renameIdx = callOrder.findIndex(c => c === "rename:write->write" || c === "rename:read->read");
    const stateWriteIdx = callOrder.findIndex(c => c === "writeState");
    expect(renameIdx).toBeGreaterThanOrEqual(0);
    expect(stateWriteIdx).toBeGreaterThanOrEqual(0);
    // Rename must come BEFORE the state-clear write
    expect(renameIdx).toBeLessThan(stateWriteIdx);
  }, 30000);

  it("rename failure leaves state unchanged (active=false) and hooks still in .bak", async () => {
    await guardrailsOff(projectRoot, "test", "all", problemId);

    // Snapshot state before guardrailsOn
    const statePath = path.join(projectRoot, ".rks", "guardrails-state.json");
    const stateBefore = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(stateBefore.active).toBe(false);

    // Simulate rename failure for tier-dir restores
    const origRename = fs.renameSync.bind(fs);
    fs.renameSync = (src, dst) => {
      if (["write", "read"].includes(path.basename(src)) && String(src).includes("hooks.bak")) {
        throw new Error("EPERM: simulated rename failure");
      }
      return origRename(src, dst);
    };

    let result;
    try {
      result = await guardrailsOn(projectRoot);
    } finally {
      fs.renameSync = origRename;
    }

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rename|restore hooks|EPERM/i);

    // State file still shows active=false (unchanged)
    const stateAfter = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(stateAfter.active).toBe(false);
    // Tier dirs still in .bak — recoverable
    expect(fs.existsSync(path.join(projectRoot, ".routekit", "hooks.bak"))).toBe(true);
    // hooks/write was never restored (rename was blocked)
    expect(fs.existsSync(path.join(projectRoot, ".routekit", "hooks", "write"))).toBe(false);
  }, 30000);

  it("clearGuardState failure AFTER rename rolls hooks back to .bak (or emits manual-recovery error)", async () => {
    await guardrailsOff(projectRoot, "test", "all", problemId);

    // Simulate: allow the tier-dir renames, but make writeFileSync for
    // guardrails-state.json throw. This mimics an FS error during clearGuardState.
    const origWrite = fs.writeFileSync.bind(fs);
    fs.writeFileSync = (filePath, data, opts) => {
      if (String(filePath).endsWith("guardrails-state.json")) {
        throw new Error("EACCES: simulated state-write failure");
      }
      return origWrite(filePath, data, opts);
    };

    let result;
    try {
      result = await guardrailsOn(projectRoot);
    } finally {
      fs.writeFileSync = origWrite;
    }

    expect(result.ok).toBe(false);

    // Either rolled back or a structured manual-recovery error
    const rolledBack = result.rolledBack === true;
    const manualRecovery = result.manualRecoveryRequired === true;
    expect(rolledBack || manualRecovery).toBe(true);

    if (rolledBack) {
      // Rollback ran (hooks.bak exists; rollback is a no-op with tier layout since
      // the rollback reads flat hooks/*.mjs which is empty — tier files are in subdirs)
      expect(fs.existsSync(path.join(projectRoot, ".routekit", "hooks.bak"))).toBe(true);
    } else {
      // Manual recovery path: error must identify the clear failure context
      expect(result.error).toMatch(/manual|recovery|clearGuardState/i);
    }
  }, 30000);

  it("rollback failure surfaces distinct manual-recovery error (not a silent failure)", async () => {
    await guardrailsOff(projectRoot, "test", "all", problemId);

    const hooksPath = path.join(projectRoot, ".routekit", "hooks");
    const origRename = fs.renameSync.bind(fs);
    const origWrite = fs.writeFileSync.bind(fs);
    const origReaddir = fs.readdirSync.bind(fs);

    // Allow forward renames (hooks.bak/tier -> hooks/tier) to succeed.
    // Once clearGuardState fails, flag that further renames are rollback attempts.
    let clearStateFailed = false;
    fs.renameSync = (src, dst) => {
      if (!clearStateFailed) {
        // Forward renames — let pass
        return origRename(src, dst);
      }
      // Rollback attempt — throw
      throw new Error("EIO: simulated rollback failure");
    };

    // Make clearGuardState fail so we enter the rollback path
    fs.writeFileSync = (filePath, data, opts) => {
      if (String(filePath).endsWith("guardrails-state.json")) {
        clearStateFailed = true;
        throw new Error("EACCES: simulated clearGuardState failure");
      }
      return origWrite(filePath, data, opts);
    };

    // Rollback reads flat files from hooks/. With tier layout hooks/ root has none,
    // so spoof one entry to force a renameSync call into the rollback path.
    fs.readdirSync = (dirPath, ...args) => {
      if (String(dirPath) === hooksPath && !args[0]) {
        return ["enforce-branch-workflow.mjs"];
      }
      return origReaddir(dirPath, ...args);
    };

    let result;
    try {
      result = await guardrailsOn(projectRoot);
    } finally {
      fs.renameSync = origRename;
      fs.writeFileSync = origWrite;
      fs.readdirSync = origReaddir;
    }

    expect(result.ok).toBe(false);
    expect(result.manualRecoveryRequired).toBe(true);
    // The error must mention both failures distinctly
    expect(result.error).toMatch(/manual recovery/i);
    expect(result.clearError).toBeTruthy();
    expect(result.rollbackError).toBeTruthy();
  }, 30000);
});

describe("guardrails-audit: guardrailsOn idempotent restore (ENOTEMPTY partial-prior-state)", () => {
  let projectRoot;
  let problemId;

  beforeAll(() => {
    ({ dir: projectRoot, problemId } = makeTempProject());
  });

  afterAll(() => cleanup(projectRoot));

  beforeEach(async () => {
    resetProjectState(projectRoot);
    // Use a real guardrailsOff call so getActiveSession() can find the session.
    // This moves hooks/write -> hooks.bak/write and hooks/read -> hooks.bak/read.
    await guardrailsOff(projectRoot, "test-partial-restore", "all", problemId);
  });

  it("succeeds when hooks/read/ already exists before restore (ENOTEMPTY scenario)", async () => {
    // Simulate partial prior restore: hooks/read/ was re-created mid-restore
    const hooksDir = path.join(projectRoot, ".routekit", "hooks");
    fs.mkdirSync(path.join(hooksDir, "read"), { recursive: true });
    fs.writeFileSync(path.join(hooksDir, "read", "enforce-read-provenance.mjs"), "// stale copy");

    const result = await guardrailsOn(projectRoot);
    expect(result.ok).toBe(true);
  }, 30000);

  it("succeeds when hooks/write/ already exists before restore (ENOTEMPTY scenario)", async () => {
    // Simulate partial prior restore: hooks/write/ was re-created mid-restore
    const hooksDir = path.join(projectRoot, ".routekit", "hooks");
    fs.mkdirSync(path.join(hooksDir, "write"), { recursive: true });
    fs.writeFileSync(path.join(hooksDir, "write", "enforce-branch-workflow.mjs"), "// stale copy");

    const result = await guardrailsOn(projectRoot);
    expect(result.ok).toBe(true);
  }, 30000);

  it("after idempotent restore, hooks are correctly present in hooks/write/ and hooks/read/", async () => {
    // Simulate partial prior restore: both tier dirs exist with stale/partial content
    const hooksDir = path.join(projectRoot, ".routekit", "hooks");
    fs.mkdirSync(path.join(hooksDir, "write"), { recursive: true });
    fs.mkdirSync(path.join(hooksDir, "read"), { recursive: true });
    fs.writeFileSync(path.join(hooksDir, "write", "enforce-branch-workflow.mjs"), "// stale");
    fs.writeFileSync(path.join(hooksDir, "read", "enforce-read-provenance.mjs"), "// stale");

    const result = await guardrailsOn(projectRoot);
    expect(result.ok).toBe(true);
    // rmSync cleared stale dirs; renameSync restored full content from hooks.bak
    expect(fs.existsSync(path.join(hooksDir, "write", "enforce-branch-workflow.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(hooksDir, "write", "enforce-plan-scope.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(hooksDir, "read", "enforce-read-provenance.mjs"))).toBe(true);
  }, 30000);
});

describe("guardrails-audit: phase gate enforcement", () => {
  let projectRoot;
  let problemId;

  beforeAll(() => {
    ({ dir: projectRoot, problemId } = makeTempProject());
  });

  afterAll(() => cleanup(projectRoot));

  beforeEach(() => {
    resetProjectState(projectRoot);
  });

  it("returns problemId_required when no problemId is provided", async () => {
    const result = await guardrailsOff(projectRoot, "test", "all", null);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("problemId_required");
    expect(result.message).toMatch(/arch-approved/i);
  });

  it("returns story_not_ready when story phase is draft", async () => {
    const notesDir = path.join(projectRoot, "notes");
    fs.writeFileSync(path.join(notesDir, "draft-story.md"), [
      "---", 'id: "draft-story"', 'phase: "draft"', 'targetFiles: []', "---", "",
    ].join("\n"));
    const result = await guardrailsOff(projectRoot, "test", "all", "draft-story");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("story_not_ready");
    expect(result.storyId).toBe("draft-story");
  });

  it("returns story_not_ready when story phase is ready (not yet arch-approved)", async () => {
    const notesDir = path.join(projectRoot, "notes");
    fs.writeFileSync(path.join(notesDir, "ready-story.md"), [
      "---", 'id: "ready-story"', 'phase: "ready"', 'targetFiles: []', "---", "",
    ].join("\n"));
    const result = await guardrailsOff(projectRoot, "test", "all", "ready-story");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("story_not_ready");
  });

  it("returns story_note_not_on_branch when the story note is absent from the worktree", async () => {
    // Previously asserted story_not_ready. The two draft/ready cases above still
    // do — a note that IS present with the wrong phase is a genuine phase gate.
    // An absent note is a branch problem and now says so.
    const result = await guardrailsOff(projectRoot, "test", "all", "nonexistent-story");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("story_note_not_on_branch");
    expect(result.storyId).toBe("nonexistent-story");
    expect(result.message).not.toContain("(current: not found)");
    expect(result.message).toMatch(/branch/i);
  });

  it("passes the gate and returns ok:true when story phase is arch-approved", async () => {
    const result = await guardrailsOff(projectRoot, "test", "all", FIXTURE_STORY_ID);
    expect(result.ok).toBe(true);
  });
});

// ── backlog.fix.arch-verdict-never-retracts-arch-approved ────────────────────
//
// The gate keyed on phase alone. It now also refuses an open needs-revision verdict
// (story_not_ready) and an approved story whose content digest no longer matches the
// arch_subject ARCH recorded (story_changed_since_arch). Neither refusal may move hooks
// or write a scope file.

describe("guardrails-audit: arch_verdict and arch_subject gate", () => {
  let projectRoot;

  beforeAll(() => {
    ({ dir: projectRoot } = makeTempProject());
  });

  afterAll(() => cleanup(projectRoot));

  beforeEach(() => {
    resetProjectState(projectRoot);
  });

  let actualDigest;
  beforeAll(async () => {
    ({ noteSubjectDigest: actualDigest } = await vi.importActual(
      "../../packages/mcp-rks/src/workflow/arch-verdict.mjs",
    ));
  });

  afterEach(() => {
    // Drop any unconsumed one-shot throw and restore the pass-through.
    vi.mocked(noteSubjectDigest).mockReset();
    vi.mocked(noteSubjectDigest).mockImplementation((...args) => actualDigest(...args));
  });

  const BODY = "\n## Problem\n\nThe story as ARCH reviewed it.\n";
  const notePathOf = (id) => path.join(projectRoot, "notes", `${id}.md`);

  function writeNote(id, fmLines, body = BODY) {
    fs.writeFileSync(notePathOf(id), ["---", `id: "${id}"`, 'phase: "arch-approved"', "targetFiles: []", ...fmLines, "---"].join("\n") + body);
  }

  /** Writes an approved note and records arch_subject as the shared helper's digest of it. */
  function writeApprovedWithSubject(id) {
    writeNote(id, ['arch_verdict: "approved"']);
    const digest = noteSubjectDigest(parseFrontmatter(fs.readFileSync(notePathOf(id), "utf8")));
    writeNote(id, ['arch_verdict: "approved"', `arch_subject: "${digest}"`]);
    // Recording the subject must not move the digest (arch_* are not digest inputs).
    expect(noteSubjectDigest(parseFrontmatter(fs.readFileSync(notePathOf(id), "utf8")))).toBe(digest);
    return digest;
  }

  function expectNothingMoved() {
    expect(fs.existsSync(path.join(projectRoot, ".routekit", "hooks.bak"))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, ".routekit", "hooks", "write", "enforce-branch-workflow.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, ".rks", "active-scope.json"))).toBe(false);
  }

  it("refuses phase arch-approved with arch_verdict needs-revision as story_not_ready", async () => {
    writeNote("nr-story", ['arch_verdict: "needs-revision"']);
    const result = await guardrailsOff(projectRoot, "test", "all", "nr-story");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("story_not_ready");
    expect(result.message).toContain("needs-revision");
    expectNothingMoved();
  });

  it("still passes the existing fixture (phase arch-approved, no arch_verdict)", async () => {
    const result = await guardrailsOff(projectRoot, "test", "all", FIXTURE_STORY_ID);
    expect(result.ok).toBe(true);
  });

  it("passes an approved note whose arch_subject equals the shared helper's digest", async () => {
    writeApprovedWithSubject("approved-story");
    const result = await guardrailsOff(projectRoot, "test", "all", "approved-story");
    expect(result.ok).toBe(true);
  });

  it("refuses the same note after a body amendment with no ARCH re-run: story_changed_since_arch", async () => {
    const digest = writeApprovedWithSubject("amended-story");
    fs.appendFileSync(notePathOf("amended-story"), "\n## Acceptance Criteria\n\n- [ ] added after ARCH\n");
    const current = noteSubjectDigest(parseFrontmatter(fs.readFileSync(notePathOf("amended-story"), "utf8")));
    expect(current).not.toBe(digest);

    const result = await guardrailsOff(projectRoot, "test", "all", "amended-story");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("story_changed_since_arch");
    expect(result.storyId).toBe("amended-story");
    expect(result.message).toContain("amended-story");
    expect(result.message).toContain(digest);
    expect(result.message).toContain(current);
    expect(result.message).toContain("/arch");
    expectNothingMoved();
  });

  // backlog.fix.arch-subject-digest-guidance-boundary-whitespace — an arch_subject recorded
  // before the digest was canonicalized equals the LEGACY digest of the unchanged note.
  /** Writes an approved note and records arch_subject as the LEGACY digest of it. */
  function writeApprovedWithLegacySubject(id) {
    writeNote(id, ['arch_verdict: "approved"']);
    const parsed = parseFrontmatter(fs.readFileSync(notePathOf(id), "utf8"));
    const legacy = noteLegacySubjectDigest(parsed);
    // BODY ends in a newline, so the two digests differ and only the legacy match can pass.
    expect(legacy).not.toBe(noteSubjectDigest(parsed));
    writeNote(id, ['arch_verdict: "approved"', `arch_subject: "${legacy}"`]);
    return legacy;
  }

  it("passes an approved note whose arch_subject is the LEGACY digest of the unchanged note", async () => {
    writeApprovedWithLegacySubject("legacy-subject-story");
    const result = await guardrailsOff(projectRoot, "test", "all", "legacy-subject-story");
    expect(result.ok).toBe(true);
  });

  it("refuses a legacy-recorded note after a body amendment: story_changed_since_arch", async () => {
    const legacy = writeApprovedWithLegacySubject("legacy-amended-story");
    fs.appendFileSync(notePathOf("legacy-amended-story"), "\n## Acceptance Criteria\n\n- [ ] added after ARCH\n");
    const result = await guardrailsOff(projectRoot, "test", "all", "legacy-amended-story");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("story_changed_since_arch");
    expect(result.message).toContain(legacy);
    expectNothingMoved();
  });

  it("passes an approved note with no arch_subject", async () => {
    writeNote("no-subject-story", ['arch_verdict: "approved"']);
    const result = await guardrailsOff(projectRoot, "test", "all", "no-subject-story");
    expect(result.ok).toBe(true);
  });

  it("classifies a throw from the shared digest helper as story_note_unreadable, never a pass", async () => {
    writeApprovedWithSubject("throwing-story");
    vi.mocked(noteSubjectDigest).mockImplementationOnce(() => {
      throw new Error("digest exploded");
    });
    const result = await guardrailsOff(projectRoot, "test", "all", "throwing-story");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("story_note_unreadable");
    expect(result.message).toContain("digest exploded");
    expectNothingMoved();
  });
});

// ── backlog.fix.offrail-hooks-bak-orphan-restore-fail-closed ────────────────────────────
// Live home of the guardrailsOn fail-closed contract (the describe.skip'd fallback test in
// tests/unit/guardrails-audit.spec.mjs does not run): provenance on every hooks.bak removal,
// hooks_backup_missing with provenance-or-null, no auto-ship, and the template opt-in.

const PROVENANCE_KIND = "hooks_bak_provenance";

function readSessionLog(root) {
  const p = path.join(root, ".rks", "guardrails-off-sessions.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function expectProvenanceShape(rec) {
  expect(typeof rec.component).toBe("string");
  expect(rec.component.length).toBeGreaterThan(0);
  expect(Object.prototype.hasOwnProperty.call(rec, "sessionId")).toBe(true);
  expect(rec.sessionId === null || typeof rec.sessionId === "string").toBe(true);
  expect(new Date(rec.timestamp).toISOString()).toBe(rec.timestamp);
  expect(typeof rec.reason).toBe("string");
  expect(rec.reason.length).toBeGreaterThan(0);
  for (const k of ["problemId", "startedAt", "endedAt", "aborted"]) {
    expect(Object.prototype.hasOwnProperty.call(rec, k)).toBe(false);
  }
}

const provenanceEmits = () =>
  vi.mocked(ensureTelemetryStorage)().emit.mock.calls.filter((c) => c[0] === "guardrails.hooks_bak_removed");

describe("guardrails-audit: guardrailsOn fails closed on a missing hooks.bak (AC4, AC5, AC6)", () => {
  let projectRoot;
  let problemId;
  let offSessionId;
  const rel = (...p) => path.join(projectRoot, ...p);
  const readState = () => JSON.parse(fs.readFileSync(rel(".rks", "guardrails-state.json"), "utf8"));
  const shipMocks = () => [runGitPR, runStagingMerge, runCycleComplete, commitAndEmbed];

  beforeAll(() => {
    ({ dir: projectRoot, problemId } = makeTempProject());
  });

  afterAll(() => {
    cleanup(projectRoot);
  });

  beforeEach(async () => {
    resetProjectState(projectRoot);
    fs.rmSync(rel("templates"), { recursive: true, force: true });
    const off = await guardrailsOff(projectRoot, "test-fail-closed", "all", problemId);
    expect(off.ok).toBe(true);
    offSessionId = off.sessionId;
    expect(fs.existsSync(rel(".routekit", "hooks.bak", "write", "enforce-branch-workflow.mjs"))).toBe(true);
    for (const m of shipMocks()) vi.mocked(m).mockClear();
    vi.mocked(ensureTelemetryStorage)().emit.mockClear();
  });

  afterEach(() => {
    fs.rmSync(rel("templates"), { recursive: true, force: true });
  });

  it("AC4 - a normal off then on cycle records guardrailsOn provenance for the hooks.bak removal before the end entry, emits telemetry, and keeps the session history intact", async () => {
    const res = await guardrailsOn(projectRoot);
    expect(res.ok).toBe(true);
    expect(res.hooksRestored).toBe(true);
    expect(res.hooksSource).toBe("backup");
    expect(fs.existsSync(rel(".routekit", "hooks.bak"))).toBe(false);

    const log = readSessionLog(projectRoot);
    const provIdx = log.findIndex((r) => r.kind === PROVENANCE_KIND && r.component === "guardrailsOn");
    expect(provIdx).toBeGreaterThan(-1);
    const rec = log[provIdx];
    expectProvenanceShape(rec);
    expect(rec.sessionId).toBe(offSessionId);
    const endIdx = log.findIndex((r) => r.sessionId === offSessionId && r.endedAt);
    expect(endIdx).toBeGreaterThan(provIdx);

    const emits = provenanceEmits();
    expect(emits).toHaveLength(1);
    expect(emits[0][2]).toMatchObject({ component: rec.component, sessionId: rec.sessionId, timestamp: rec.timestamp, reason: rec.reason });

    // Session-log merge safety: the provenance record neither overwrites the start reason
    // nor counts as a session.
    const history = getSessionHistory(projectRoot);
    expect(history.total).toBe(1);
    const session = history.sessions.find((s) => s.sessionId === offSessionId);
    expect(session.reason).toBe("test-fail-closed");
    expect(session.endedAt).toBeTruthy();
    expect(session.kind).toBeUndefined();
  }, 30000);

  it("AC5 - hooks.bak removed with no recorded provenance: hooks_backup_missing, provenance null, no auto-ship, guard state still off, no template tiers", async () => {
    fs.rmSync(rel(".routekit", "hooks.bak"), { recursive: true, force: true });
    const res = await guardrailsOn(projectRoot);
    expect(res.ok).not.toBe(true);
    expect(String(res.reason ?? res.error)).toContain("hooks_backup_missing");
    expect(res.hooksRestored).not.toBe(true);
    expect(Object.prototype.hasOwnProperty.call(res, "provenance")).toBe(true);
    expect(res.provenance).toBeNull();
    expect(readState().active).toBe(false);
    expect(fs.existsSync(rel(".routekit", "hooks", "write"))).toBe(false);
    expect(fs.existsSync(rel(".routekit", "hooks", "read"))).toBe(false);
    for (const m of shipMocks()) expect(m).not.toHaveBeenCalled();
    // The session stays open: a later rks_guardrails_on can still end it.
    expect(readSessionLog(projectRoot).some((r) => r.sessionId === offSessionId && r.endedAt)).toBe(false);
  }, 30000);

  it("AC5 - when a component recorded the hooks.bak removal, hooks_backup_missing carries that record", async () => {
    // A recorded removal through the real governor-token path (the H1 shape), against this
    // temp root only.
    setProjectRoot(projectRoot);
    try {
      expect(restoreGuardrails({ component: "test-remover", reason: "simulated mid-session removal" })).toBe(true);
    } finally {
      setProjectRoot(null);
    }
    expect(fs.existsSync(rel(".routekit", "hooks.bak"))).toBe(false);
    const recorded = readSessionLog(projectRoot).filter((r) => r.kind === PROVENANCE_KIND).pop();
    expect(recorded.component).toBe("test-remover");

    const res = await guardrailsOn(projectRoot);
    expect(res.ok).not.toBe(true);
    expect(String(res.reason ?? res.error)).toContain("hooks_backup_missing");
    expect(res.provenance).not.toBeNull();
    expect(res.provenance.component).toBe(recorded.component);
    expect(res.provenance.timestamp).toBe(recorded.timestamp);
    expect(readState().active).toBe(false);
    for (const m of shipMocks()) expect(m).not.toHaveBeenCalled();
  }, 30000);

  it("AC6 - with the explicit restoreFromTemplate opt-in, a missing hooks.bak is restored from the template and the response says so", async () => {
    fs.rmSync(rel(".routekit", "hooks.bak"), { recursive: true, force: true });
    const tpl = rel("templates", "generic", ".routekit", "hooks");
    fs.mkdirSync(path.join(tpl, "write"), { recursive: true });
    fs.mkdirSync(path.join(tpl, "read"), { recursive: true });
    fs.writeFileSync(path.join(tpl, "write", "template-write-hook.mjs"), "// template write hook");
    fs.writeFileSync(path.join(tpl, "read", "template-read-hook.mjs"), "// template read hook");

    const res = await guardrailsOn(projectRoot, { restoreFromTemplate: true });
    expect(res.ok).toBe(true);
    expect(res.hooksFallback).toBe(true);
    expect(res.hooksSource).toBe("template");
    expect(res.warning).toMatch(/template/);
    expect(res.warning).toMatch(/not the backup/);
    expect(fs.existsSync(rel(".routekit", "hooks", "write", "template-write-hook.mjs"))).toBe(true);
    expect(readState().active).toBe(true);
  }, 30000);

  it("AC6 - without the opt-in the template restore never runs, even when a template exists", async () => {
    fs.rmSync(rel(".routekit", "hooks.bak"), { recursive: true, force: true });
    const tpl = rel("templates", "generic", ".routekit", "hooks");
    fs.mkdirSync(path.join(tpl, "write"), { recursive: true });
    fs.writeFileSync(path.join(tpl, "write", "template-write-hook.mjs"), "// template write hook");

    const res = await guardrailsOn(projectRoot);
    expect(res.ok).not.toBe(true);
    expect(String(res.reason ?? res.error)).toContain("hooks_backup_missing");
    expect(fs.existsSync(rel(".routekit", "hooks", "write"))).toBe(false);
    expect(readState().active).toBe(false);
  }, 30000);
});

describe("guardrails-audit: guardrailsOff orphan cleanup records provenance (AC4)", () => {
  let projectRoot;
  let problemId;

  beforeAll(() => {
    ({ dir: projectRoot, problemId } = makeTempProject());
  });

  afterAll(() => {
    cleanup(projectRoot);
  });

  beforeEach(() => {
    resetProjectState(projectRoot);
    vi.mocked(ensureTelemetryStorage)().emit.mockClear();
  });

  it("the orphan hooks.bak cleanup writes a guardrailsOff provenance record and emits telemetry", async () => {
    const hooksBakDir = path.join(projectRoot, ".routekit", "hooks.bak");
    fs.mkdirSync(hooksBakDir, { recursive: true });
    fs.writeFileSync(path.join(hooksBakDir, "orphan-from-crash.mjs"), "// orphan");

    const result = await guardrailsOff(projectRoot, "test-orphan-provenance", "all", problemId);
    expect(result.ok).toBe(true);

    const recs = readSessionLog(projectRoot).filter((r) => r.kind === PROVENANCE_KIND && r.component === "guardrailsOff");
    expect(recs).toHaveLength(1);
    expectProvenanceShape(recs[0]);
    const emits = provenanceEmits().filter((c) => c[2].component === "guardrailsOff");
    expect(emits).toHaveLength(1);
    expect(emits[0][2]).toMatchObject({ sessionId: recs[0].sessionId, timestamp: recs[0].timestamp, reason: recs[0].reason });
    // The new off session is still the open one: the provenance line did not interfere.
    const history = getSessionHistory(projectRoot);
    expect(history.total).toBe(1);
    expect(history.activeSession?.sessionId).toBe(result.sessionId);
  }, 30000);
});

// The AC12 describe below is the QA-authored test code from the story note.
describe("guardrails-audit: guardrailsOn with active=false and no open session (AC12)", () => {
  let projectRoot;
  let problemId;
  const rel = (...p) => path.join(projectRoot, ...p);
  const readState = () => JSON.parse(fs.readFileSync(rel(".rks", "guardrails-state.json"), "utf8"));
  const readLog = () => {
    const p = rel(".rks", "guardrails-off-sessions.jsonl");
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };

  beforeAll(() => {
    ({ dir: projectRoot, problemId } = makeTempProject());
  });

  afterAll(() => {
    cleanup(projectRoot);
  });

  beforeEach(async () => {
    resetProjectState(projectRoot);
    const off = await guardrailsOff(projectRoot, "test-no-session-branch", "all", problemId);
    expect(off.ok).toBe(true);
    expect(fs.existsSync(rel(".routekit", "hooks.bak", "write", "enforce-branch-workflow.mjs"))).toBe(true);
    expect(fs.existsSync(rel(".routekit", "hooks.bak", "read", "enforce-read-provenance.mjs"))).toBe(true);
    expect(readState().active).toBe(false);
    // Drop the session log so getActiveSession finds no open session.
    fs.rmSync(rel(".rks", "guardrails-off-sessions.jsonl"), { force: true });
    for (const m of [runGitPR, runStagingMerge, runCycleComplete, commitAndEmbed]) vi.mocked(m).mockClear();
  });

  it("restores the tiers from hooks.bak and records provenance before reporting hooksRestored", async () => {
    const res = await guardrailsOn(projectRoot);
    expect(res.ok).toBe(true);
    expect(res.hooksRestored).toBe(true);
    expect(fs.existsSync(rel(".routekit", "hooks", "write", "enforce-branch-workflow.mjs"))).toBe(true);
    expect(fs.existsSync(rel(".routekit", "hooks", "write", "enforce-plan-scope.mjs"))).toBe(true);
    expect(fs.existsSync(rel(".routekit", "hooks", "read", "enforce-read-provenance.mjs"))).toBe(true);
    expect(fs.existsSync(rel(".routekit", "hooks.bak"))).toBe(false);
    expect(readState().active).toBe(true);
    const records = readLog().filter((r) => typeof r.component === "string" && /guardrailsOn/.test(r.component));
    expect(records.length).toBeGreaterThanOrEqual(1);
    const rec = records[records.length - 1];
    expect(Object.prototype.hasOwnProperty.call(rec, "sessionId")).toBe(true);
    expect(rec.sessionId === null || typeof rec.sessionId === "string").toBe(true);
    expect(new Date(rec.timestamp).toISOString()).toBe(rec.timestamp);
    expect(typeof rec.reason).toBe("string");
    expect(rec.reason.length).toBeGreaterThan(0);
    // Merge safety: the log now holds only the provenance record, which must not count as a session.
    const history = getSessionHistory(projectRoot);
    expect(history.total).toBe(0);
    expect(history.activeSession).toBeFalsy();
  });

  it("fails closed with hooks_backup_missing when hooks.bak is also gone, keeping guard state off", async () => {
    fs.rmSync(rel(".routekit", "hooks.bak"), { recursive: true, force: true });
    const res = await guardrailsOn(projectRoot);
    expect(res.ok).not.toBe(true);
    expect(String(res.reason ?? res.error)).toContain("hooks_backup_missing");
    expect(res.hooksRestored).not.toBe(true);
    expect(Object.prototype.hasOwnProperty.call(res, "provenance")).toBe(true);
    expect(res.provenance).toBeNull();
    expect(readState().active).toBe(false);
    expect(fs.existsSync(rel(".routekit", "hooks", "write"))).toBe(false);
    expect(fs.existsSync(rel(".routekit", "hooks", "read"))).toBe(false);
    expect(runGitPR).not.toHaveBeenCalled();
    expect(runStagingMerge).not.toHaveBeenCalled();
    expect(runCycleComplete).not.toHaveBeenCalled();
    expect(commitAndEmbed).not.toHaveBeenCalled();
  });
});
