/**
 * backlog.fix.plan-exec-start-phase-write-durability
 *
 * `rks_plan` returned ok:true with a valid plan and never wrote `phase: executing`.
 * `rks_exec` requires `executing`. `rks_plan_ready`'s stale-executing self-heal undid any
 * hand-set value. Closed deadlock — a child project could not execute ANY story.
 *
 * Every phase assertion here READS THE NOTE FROM DISK. The defect is a code path that
 * reports success while nothing reaches disk, so asserting on a return value would be
 * vacuous against this exact bug.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensureExecStartPhase,
  decideExecStartAction,
} from "../../packages/mcp-rks/src/server/exec-start-durability.mjs";

const dirs = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const STORY = "backlog.test-story";

function makeProject(phase) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-exec-start-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "notes", `${STORY}.md`),
    `---\nid: ${STORY}\ntitle: Test\nphase: "${phase}"\n---\n\n## Problem\nx\n`,
  );
  return dir;
}

/** Read the phase FROM DISK — never from a return value. */
const phaseOnDisk = (dir) => {
  const raw = fs.readFileSync(path.join(dir, "notes", `${STORY}.md`), "utf8");
  return raw.match(/^phase:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
};

describe("decideExecStartAction — decision table (moved, behaviour unchanged)", () => {
  it("advances from arch-approved without resetting", () => {
    expect(decideExecStartAction("arch-approved")).toEqual({ reset: false, advance: true });
  });
  it("resets then advances from the post-arch re-plan phases", () => {
    for (const p of ["planned", "executing", "executed"]) {
      expect(decideExecStartAction(p)).toEqual({ reset: true, advance: true });
    }
  });
  it("rejects terminal phases", () => {
    for (const p of ["released", "integrated"]) {
      expect(decideExecStartAction(p)).toEqual({ reset: false, advance: false, reject: true });
    }
  });
  it("does not advance a pre-ARCH phase — the arch gate is not bypassable", () => {
    expect(decideExecStartAction("ready")).toEqual({ reset: false, advance: false });
    expect(decideExecStartAction("draft")).toEqual({ reset: false, advance: false });
  });
  it("advances on an unreadable phase and lets advancePhase validate", () => {
    expect(decideExecStartAction(null)).toEqual({ reset: false, advance: true });
    expect(decideExecStartAction(undefined)).toEqual({ reset: false, advance: true });
  });
});

describe("ensureExecStartPhase — the transition is DURABLE", () => {
  it("TR6: lands arch-approved → executing and the note ON DISK says so", async () => {
    const dir = makeProject("arch-approved");

    const res = await ensureExecStartPhase({
      projectRoot: dir, problemId: STORY, projectId: "test-proj",
    });

    expect(res.ok).toBe(true);
    expect(res.verified).toBe(true);
    // The assertion that matters. A no-op implementation returning { ok: true }
    // passes every return-value check and fails this one.
    expect(phaseOnDisk(dir)).toBe("executing");
  });

  it("TR6: is the PARENT-SIDE net — it lands the phase when the worker never did", async () => {
    // Reproduces the child failure exactly: executable plan on disk, story still at
    // arch-approved because the detached worker's write never happened.
    const dir = makeProject("arch-approved");
    expect(phaseOnDisk(dir)).toBe("arch-approved");

    const res = await ensureExecStartPhase({
      projectRoot: dir, problemId: STORY, projectId: "test-proj", allowNoopWhenExecuting: true,
    });

    expect(res.ok).toBe(true);
    expect(phaseOnDisk(dir)).toBe("executing");
  });

  it("is idempotent for the parent net when the worker already landed it", async () => {
    const dir = makeProject("executing");

    const res = await ensureExecStartPhase({
      projectRoot: dir, problemId: STORY, projectId: "test-proj", allowNoopWhenExecuting: true,
    });

    expect(res.ok).toBe(true);
    expect(res.alreadyThere).toBe(true);
    expect(phaseOnDisk(dir)).toBe("executing");
  });

  it("re-lands executing on a BARE re-plan (reset then advance), preserving P0-3", async () => {
    const dir = makeProject("executing");

    const res = await ensureExecStartPhase({
      projectRoot: dir, problemId: STORY, projectId: "test-proj", // allowNoop NOT set
    });

    expect(res.ok).toBe(true);
    expect(phaseOnDisk(dir)).toBe("executing");
  });

  it("does NOT advance a pre-ARCH story, and says why", async () => {
    const dir = makeProject("ready");

    const res = await ensureExecStartPhase({
      projectRoot: dir, problemId: STORY, projectId: "test-proj",
    });

    expect(res.ok).toBe(true);
    expect(res.skipped).toBe("pre_arch_not_advanced");
    expect(phaseOnDisk(dir)).toBe("ready"); // arch gate intact
  });

  it("refuses a terminal phase rather than silently persisting", async () => {
    const dir = makeProject("released");

    const res = await ensureExecStartPhase({
      projectRoot: dir, problemId: STORY, projectId: "test-proj",
    });

    expect(res.ok).toBe(false);
    expect(res.rejected).toBe(true);
    expect(phaseOnDisk(dir)).toBe("released");
  });

  it("reports ok:false — never a silent success — when the note cannot be read", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-exec-start-empty-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, "notes"), { recursive: true });

    const res = await ensureExecStartPhase({
      projectRoot: dir, problemId: "backlog.does-not-exist", projectId: "test-proj",
    });

    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
  });
});

describe("ensureExecStartPhase — the read-back is load-bearing", () => {
  it("TR6 mutation (b): reports failure when advancePhase claims success but writes nothing", async () => {
    // This is the sharpest test in the story. It isolates "trusting a return value" as
    // the bug: advancePhase reports ok while the note never changes. An implementation
    // that returns advanceResult.ok passes; one that re-reads the note catches it.
    vi.doMock("../../packages/mcp-rks/src/workflow/auto-phase.mjs", () => ({
      advancePhase: vi.fn(async () => ({ ok: true, to: "executing" })),
    }));
    const { ensureExecStartPhase: patched } = await import(
      "../../packages/mcp-rks/src/server/exec-start-durability.mjs"
    );

    const dir = makeProject("arch-approved");
    const res = await patched({ projectRoot: dir, problemId: STORY, projectId: "test-proj" });

    expect(res.ok).toBe(false);
    expect(res.error).toBe("phase_write_not_observed");
    expect(res.observed).toBe("arch-approved");
    expect(phaseOnDisk(dir)).toBe("arch-approved");

    vi.doUnmock("../../packages/mcp-rks/src/workflow/auto-phase.mjs");
  });
});
