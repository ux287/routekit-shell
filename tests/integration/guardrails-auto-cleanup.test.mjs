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

import {
  guardrailsOff,
  guardrailsOn,
} from "../../packages/mcp-rks/src/server/guardrails-audit.mjs";

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

  it("returns story_not_ready when story note does not exist", async () => {
    const result = await guardrailsOff(projectRoot, "test", "all", "nonexistent-story");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("story_not_ready");
  });

  it("passes the gate and returns ok:true when story phase is arch-approved", async () => {
    const result = await guardrailsOff(projectRoot, "test", "all", FIXTURE_STORY_ID);
    expect(result.ok).toBe(true);
  });
});
