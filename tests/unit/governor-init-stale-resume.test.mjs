import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INIT_PATH = path.join(ROOT, "packages/mcp-rks/src/tools/governor-init.mjs");
const TOKEN_PATH = path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs");
const ARCH_PATH = path.join(ROOT, "packages/mcp-rks/src/workflow/arch-verdict.mjs");
const FM_PATH = path.join(ROOT, "packages/mcp-rks/src/shared/frontmatter.mjs");

const PID = "backlog.fix.stale-x";
// Unclosed double-quoted scalar: gray-matter's YAML engine throws on it (asserted by a fixture control below).
const MALFORMED = "---\nphase: \"unclosed\nid: [oops\n---\n";
let dir, tok, init, arch, fm, errSpy;

async function boot() {
  vi.resetModules();
  tok = await import(TOKEN_PATH);
  init = await import(INIT_PATH);
  arch = await import(ARCH_PATH);
  fm = await import(FM_PATH);
  tok.setProjectRoot(dir);
}

function notePath(id = PID) {
  return path.join(dir, "notes", `${id}.md`);
}

function writeNote({ phase = "executing", body = "## Problem\n\noriginal\n", extra = "" } = {}) {
  const src = `---\nid: "${PID}"\nphase: "${phase}"\n${extra}---\n\n${body}`;
  fs.writeFileSync(notePath(PID), src);
  return src;
}

function digestOf(src) {
  return arch.noteSubjectDigest(fm.parseFrontmatter(src));
}

// The pre-canonicalization digest (backlog.fix.arch-subject-digest-guidance-boundary-whitespace).
function legacyDigestOf(src) {
  return arch.noteLegacySubjectDigest(fm.parseFrontmatter(src));
}

// Enters `planning` through the real rks_plan entry transition, so the admission-time capture runs.
function toPlanned(token) {
  tok.getSession(token).state = "refining";
  const p = tok.advanceState(token, "rks_plan");
  expect(p.newState).toBe("planning");
  const r = tok.advanceStateOnResult(token, "plan.ok");
  expect(r.newState).toBe("planned");
}

function plannedSession(noteOpts) {
  const src = writeNote(noteOpts);
  const a = init.handleGovernorInit({ projectId: "p", problemId: PID });
  toPlanned(a.token);
  return { a, src };
}

// Fixture control for the malformed note. A UNIQUE suffix keeps it out of gray-matter's
// content-keyed cache, which would otherwise serve an earlier failed parse without throwing.
function assertMalformedThrows() {
  expect(() => fm.parseFrontmatter(`${MALFORMED}control-${Math.random()}\n`)).toThrow();
}

function initLogLines() {
  return errSpy.mock.calls
    .map((c) => c.map(String).join(" "))
    .filter((l) => l.includes("[governor-init]"));
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-stale-"));
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  await boot();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  try { tok.resetToken(); } catch { /* ignore */ }
  tok.setProjectRoot(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readStorySubject", () => {
  it("returns phase, digest and legacy digest for a readable note, nulls otherwise, never throws", () => {
    const NONE = { phase: null, digest: null, legacyDigest: null };
    const src = writeNote();
    expect(tok.readStorySubject(PID)).toEqual({ phase: "executing", digest: digestOf(src), legacyDigest: legacyDigestOf(src) });
    // The default body ends in a newline, so the two digests are distinct observations.
    expect(legacyDigestOf(src)).not.toBe(digestOf(src));
    expect(tok.readStorySubject("backlog.fix.absent")).toEqual(NONE);
    expect(tok.readStorySubject("../etc/passwd")).toEqual(NONE);
    assertMalformedThrows();
    fs.writeFileSync(notePath(PID), MALFORMED);
    expect(tok.readStorySubject(PID)).toEqual(NONE);
    // Second read of the same malformed text: gray-matter serves it from cache without throwing.
    expect(tok.readStorySubject(PID)).toEqual(NONE);
  });
});

describe("plan.ok records the story subject digest", () => {
  it("captures the digest at rks_plan admission and promotes it on plan.ok", () => {
    const src = writeNote();
    const a = init.handleGovernorInit({ projectId: "p", problemId: PID });
    tok.getSession(a.token).state = "refining";
    expect(tok.advanceState(a.token, "rks_plan").newState).toBe("planning");
    expect(tok.getSession(a.token).pendingPlanSubjectDigest).toBe(digestOf(src));
    expect(tok.getSession(a.token).planSubjectDigest).toBeUndefined();
    expect(tok.advanceStateOnResult(a.token, "plan.ok").newState).toBe("planned");
    expect(tok.getSession(a.token).planSubjectDigest).toBe(digestOf(src));
    expect(tok.getSession(a.token).pendingPlanSubjectDigest).toBeUndefined();
  });

  it("a story amended between rks_plan admission and plan.ok keeps the admission-time digest, so re-init is stale", () => {
    const before = writeNote();
    const a = init.handleGovernorInit({ projectId: "p", problemId: PID });
    tok.getSession(a.token).state = "refining";
    expect(tok.advanceState(a.token, "rks_plan").newState).toBe("planning");
    // The documented escape hatch: rks_refine_apply leaves planning while the plan worker runs.
    expect(tok.advanceState(a.token, "rks_refine_apply").newState).toBe("refining");
    const after = writeNote({ body: "## Problem\n\namended\n" });
    // The in-flight worker's plan.ok lands in refining and still reaches planned.
    expect(tok.advanceStateOnResult(a.token, "plan.ok").newState).toBe("planned");
    expect(tok.getSession(a.token).planSubjectDigest).toBe(digestOf(before));
    const r = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("stale_reset");
    expect(r.reason).toBe("story_changed_since_plan");
    expect(r.recordedDigest).toBe(digestOf(before));
    expect(r.currentDigest).toBe(digestOf(after));
    expect(r.token).not.toBe(a.token);
    expect(tok.getSession(a.token)).toBeFalsy();
  });

  it("a re-plan whose admission-time digest is unobservable clears the earlier planSubjectDigest", () => {
    const { a, src } = plannedSession();
    expect(tok.getSession(a.token).planSubjectDigest).toBe(digestOf(src));
    fs.rmSync(notePath(PID));
    expect(tok.advanceState(a.token, "rks_plan").newState).toBe("planning");
    expect(tok.advanceStateOnResult(a.token, "plan.ok").newState).toBe("planned");
    expect(tok.getSession(a.token).planSubjectDigest).toBeUndefined();
  });

  it("the digest survives persistence and a module reboot", async () => {
    const { a, src } = plannedSession();
    const rec = JSON.parse(fs.readFileSync(path.join(dir, ".rks", "session", "governor", `${a.token}.json`), "utf8"));
    expect(rec.planSubjectDigest).toBe(digestOf(src));
    await boot();
    const r = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(r.mode).toBe("resumed");
    expect(tok.getSession(r.token).planSubjectDigest).toBe(digestOf(src));
    expect(r.stalenessCheck).toEqual({ digest: "passed", phase: "passed" });
  });

  it("missing note: records nothing, never throws, still reaches planned", () => {
    const a = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(() => toPlanned(a.token)).not.toThrow();
    expect(tok.getSession(a.token).planSubjectDigest).toBeUndefined();
  });

  it("malformed note for the SAME problemId being advanced: records nothing, never throws", () => {
    assertMalformedThrows();
    fs.writeFileSync(notePath(PID), MALFORMED);
    const a = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(tok.getSession(a.token).problemId).toBe(PID);
    expect(() => toPlanned(a.token)).not.toThrow();
    expect(tok.getSession(a.token).planSubjectDigest).toBeUndefined();
  });

  it("null project root: records nothing, never throws", () => {
    writeNote();
    tok.setProjectRoot(null);
    const a = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(() => toPlanned(a.token)).not.toThrow();
    expect(tok.getSession(a.token).planSubjectDigest).toBeUndefined();
  });
});

describe("re-init staleness checks (story flow, state planned)", () => {
  it("digest changed since plan -> stale_reset carrying every observed field", () => {
    const { a, src: before } = plannedSession();
    const after = writeNote({ body: "## Problem\n\namended\n" });
    const r = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(r.ok).toBe(true);
    expect(r.token).not.toBe(a.token);
    expect(r.mode).toBe("stale_reset");
    expect(r.state).toBe("init");
    expect(r.reason).toBe("story_changed_since_plan");
    expect(r.recordedDigest).toBe(digestOf(before));
    expect(r.currentDigest).toBe(digestOf(after));
    expect(r.chainState).toBe("planned");
    expect(r.storyPhase).toBe("executing");
    expect(tok.getSession(a.token)).toBeFalsy();
    expect(tok.getSession(r.token).state).toBe("init");
  });

  it("planned chain with phase arch-approved -> stale_reset, chain_phase_mismatch", () => {
    const { a, src } = plannedSession();
    writeNote({ phase: "arch-approved" });
    const r = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(r.token).not.toBe(a.token);
    expect(r.mode).toBe("stale_reset");
    expect(r.reason).toBe("chain_phase_mismatch");
    expect(r.chainState).toBe("planned");
    expect(r.storyPhase).toBe("arch-approved");
    // phase is outside the subject digest, so both digests are observed and equal
    expect(r.recordedDigest).toBe(digestOf(src));
    expect(r.currentDigest).toBe(digestOf(src));
    expect(tok.getSession(a.token)).toBeFalsy();
  });

  it("both checks fail -> story_changed_since_plan wins, storyPhase still reported", () => {
    plannedSession();
    writeNote({ phase: "arch-approved", body: "## Problem\n\namended\n" });
    const r = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(r.mode).toBe("stale_reset");
    expect(r.reason).toBe("story_changed_since_plan");
    expect(r.chainState).toBe("planned");
    expect(r.storyPhase).toBe("arch-approved");
  });

  it("consistent digest and phase resumes with stalenessCheck passed and no log line", () => {
    const { a } = plannedSession();
    writeNote({ extra: "updated: 123\n" });
    const r = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(r.mode).toBe("resumed");
    expect(r.token).toBe(a.token);
    expect(r.state).toBe("planned");
    expect(r.stalenessCheck).toEqual({ digest: "passed", phase: "passed" });
    expect(initLogLines()).toEqual([]);
  });

  // backlog.fix.arch-subject-digest-guidance-boundary-whitespace — a planSubjectDigest persisted
  // before the digest was canonicalized equals the LEGACY digest of the unchanged story.
  it("a planSubjectDigest equal to the legacy digest of the unchanged story RESUMES", () => {
    const { a, src } = plannedSession();
    expect(legacyDigestOf(src)).not.toBe(digestOf(src));
    tok.getSession(a.token).planSubjectDigest = legacyDigestOf(src);
    const r = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(r.mode).toBe("resumed");
    expect(r.token).toBe(a.token);
    expect(r.state).toBe("planned");
    expect(r.stalenessCheck).toEqual({ digest: "passed", phase: "passed" });
    expect(initLogLines()).toEqual([]);
  });

  it("a legacy planSubjectDigest still stale-resets with story_changed_since_plan after a body amendment", () => {
    const { a, src: before } = plannedSession();
    tok.getSession(a.token).planSubjectDigest = legacyDigestOf(before);
    const after = writeNote({ body: "## Problem\n\namended\n" });
    const r = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(r.mode).toBe("stale_reset");
    expect(r.reason).toBe("story_changed_since_plan");
    expect(r.recordedDigest).toBe(legacyDigestOf(before));
    expect(r.currentDigest).toBe(digestOf(after));
    expect(r.token).not.toBe(a.token);
    expect(tok.getSession(a.token)).toBeFalsy();
  });

  it("no recorded digest: resumes with the skip reported and logged, unless the phase check fails", () => {
    const { a } = plannedSession();
    delete tok.getSession(a.token).planSubjectDigest;
    writeNote({ body: "## Problem\n\namended\n" });
    const r1 = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(r1.mode).toBe("resumed");
    expect(r1.token).toBe(a.token);
    expect(r1.stalenessCheck).toEqual({ digest: "skipped_no_recorded_digest", phase: "passed" });
    const lines = initLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(PID);
    expect(lines[0]).toContain("skipped_no_recorded_digest");
    writeNote({ phase: "arch-approved", body: "## Problem\n\namended\n" });
    const r2 = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(r2.mode).toBe("stale_reset");
    expect(r2.reason).toBe("chain_phase_mismatch");
    expect("recordedDigest" in r2).toBe(false);
  });

  it("unobservable phase (note deleted, then malformed) is not stale; skips reported and logged once per init", () => {
    const { a } = plannedSession();
    fs.rmSync(notePath(PID));
    const r1 = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(r1.mode).toBe("resumed");
    expect(r1.token).toBe(a.token);
    expect(r1.stalenessCheck).toEqual({ digest: "skipped_digest_unobservable", phase: "skipped_phase_unobservable" });
    assertMalformedThrows();
    fs.writeFileSync(notePath(PID), MALFORMED);
    const r2 = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(r2.mode).toBe("resumed");
    expect(r2.token).toBe(a.token);
    expect(r2.stalenessCheck).toEqual({ digest: "skipped_digest_unobservable", phase: "skipped_phase_unobservable" });
    const lines = initLogLines();
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).toContain(PID);
      expect(l).toContain("skipped_digest_unobservable");
      expect(l).toContain("skipped_phase_unobservable");
    }
  });

  it("a story session not at planned resumes untouched: checks not_applicable, no log line", () => {
    writeNote();
    const a = init.handleGovernorInit({ projectId: "p", problemId: PID });
    tok.getSession(a.token).state = "refining";
    writeNote({ phase: "arch-approved", body: "## Problem\n\namended\n" });
    const r = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(r.mode).toBe("resumed");
    expect(r.token).toBe(a.token);
    expect(r.state).toBe("refining");
    expect(r.stalenessCheck).toEqual({ digest: "not_applicable", phase: "not_applicable" });
    expect(initLogLines()).toEqual([]);
  });

  it("a non-story flow session is not checked even at planned", () => {
    writeNote();
    const a = init.handleGovernorInit({ projectId: "p", problemId: PID, flowType: "qa" });
    const s = tok.getSession(a.token);
    s.state = "planned";
    s.planSubjectDigest = "0".repeat(32);
    writeNote({ phase: "arch-approved" });
    const r = init.handleGovernorInit({ projectId: "p", problemId: PID, flowType: "qa" });
    expect(r.mode).toBe("resumed");
    expect(r.token).toBe(a.token);
    expect(r.stalenessCheck).toEqual({ digest: "not_applicable", phase: "not_applicable" });
  });

  it("another problemId's live session is untouched by a stale reset", () => {
    writeNote();
    const other = init.handleGovernorInit({ projectId: "p", problemId: "backlog.fix.bystander" });
    tok.getSession(other.token).state = "refining";
    const a = init.handleGovernorInit({ projectId: "p", problemId: PID });
    toPlanned(a.token);
    writeNote({ phase: "arch-approved" });
    init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(tok.getSession(other.token).state).toBe("refining");
  });

  it("reset, terminal auto-reset and problemId-less init are unchanged", () => {
    writeNote();
    const a = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(a.mode).toBe("new");
    // reset: true ends the owned session and mints a new one.
    const b = init.handleGovernorInit({ projectId: "p", problemId: PID, reset: true });
    expect(b.mode).toBe("reset");
    expect(b.token).not.toBe(a.token);
    expect(tok.getSession(a.token)).toBeFalsy();
    // Terminal auto-reset: 'shipped' is terminal for the story flow, so a re-init WITHOUT
    // reset: true must replace the session (mode 'new'), not resume it.
    tok.getSession(b.token).state = "shipped";
    const c = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(c.ok).toBe(true);
    expect(c.mode).toBe("new");
    expect(c.token).not.toBe(b.token);
    expect(c.state).toBe("init");
    expect(tok.getSession(b.token)).toBeFalsy();
    // problemId-less init is the open flow and always mints a fresh session.
    const d = init.handleGovernorInit({ projectId: "p" });
    expect(d.mode).toBe("new");
    expect(d.flowType).toBe("open");
  });
});

describe("stale reset is refused when ending the session has side effects", () => {
  it("guardrailsDisabled -> ok:false stale_reset_blocked, old session kept live", () => {
    const { a } = plannedSession();
    tok.setGuardrailsDisabled(a.token, true);
    writeNote({ phase: "arch-approved" });
    const r = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("stale_reset_blocked");
    expect(r.staleReason).toBe("chain_phase_mismatch");
    expect(r.blockedBy).toEqual(["guardrailsDisabled"]);
    expect(r.token).toBe(a.token);
    expect(r.chainState).toBe("planned");
    expect(r.storyPhase).toBe("arch-approved");
    expect(r.message).toContain("reset: true");
    expect(tok.getSession(a.token).state).toBe("planned");
    expect(tok.getSession(a.token).guardrailsDisabled).toBe(true);
    tok.setGuardrailsDisabled(a.token, false);
  });

  it("pendingStash -> ok:false stale_reset_blocked, stash cleanup never runs", async () => {
    const { a, src: before } = plannedSession();
    let popped = false;
    tok.setPendingStash(a.token, async () => { popped = true; });
    const after = writeNote({ body: "## Problem\n\namended\n" });
    const r = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("stale_reset_blocked");
    expect(r.staleReason).toBe("story_changed_since_plan");
    expect(r.blockedBy).toEqual(["pendingStash"]);
    expect(r.recordedDigest).toBe(digestOf(before));
    expect(r.currentDigest).toBe(digestOf(after));
    expect(r.token).toBe(a.token);
    await tok.flushPendingStashPops();
    expect(popped).toBe(false);
    expect(tok.getSession(a.token).pendingStash).toBe(true);
    tok.clearPendingStash(a.token);
  });

  it("both flags -> blockedBy lists guardrailsDisabled then pendingStash", () => {
    const { a } = plannedSession();
    tok.setGuardrailsDisabled(a.token, true);
    tok.setPendingStash(a.token, async () => {});
    writeNote({ phase: "arch-approved" });
    const r = init.handleGovernorInit({ projectId: "p", problemId: PID });
    expect(r.ok).toBe(false);
    expect(r.blockedBy).toEqual(["guardrailsDisabled", "pendingStash"]);
    expect(r.token).toBe(a.token);
    tok.clearPendingStash(a.token);
    tok.setGuardrailsDisabled(a.token, false);
  });
});

describe("source-window hazard", () => {
  it("readStorySubject is a plain function between resolveStoryPhase and checkAllowedTool, exported only via the trailing list", () => {
    const src = fs.readFileSync(TOKEN_PATH, "utf8");
    expect(src).not.toMatch(/export\s+(async\s+)?function\s+readStorySubject\b/);
    expect(src).not.toMatch(/export\s+(async\s+)?function\s+resolveStoryPhase\b/);
    const decl = src.indexOf("\nfunction readStorySubject(");
    expect(decl).toBeGreaterThan(src.indexOf("\nfunction resolveStoryPhase("));
    expect(decl).toBeLessThan(src.indexOf("\nexport function checkAllowedTool("));
    const list = src.match(/^export \{([^}]*)\};?$/m);
    expect(list).not.toBeNull();
    expect(list[1]).toContain("readStorySubject");
    expect(list[1]).not.toContain("resolveStoryPhase");
    expect(typeof tok.readStorySubject).toBe("function");
    expect(src).toContain("export function advanceStateOnResult");
    // The capture edit lives in advanceState's BODY; its declaration line delimits other suites' windows.
    expect(src).toContain("\nexport function advanceState(token, toolName) {");
    // readStorySubject reimplements the guards; it must not add a classifyChainRefusal reference.
    const body = src.slice(decl, src.indexOf("\nexport function checkAllowedTool(", decl));
    expect(body).not.toContain("classifyChainRefusal");
  });

  it("governor-init.mjs compares against PHASE_GATE_EXEC, not a phase literal", () => {
    const src = fs.readFileSync(INIT_PATH, "utf8");
    expect(src).toContain("PHASE_GATE_EXEC");
    expect(src).not.toMatch(/["'`]executing["'`]/);
  });

  it("governor-init.mjs keeps exactly one Date.now() call and declares no isStale, STALE_MS or elapsed", () => {
    // Mirrors tests/unit/governor-init-session-isolation.test.mjs so a violation is reported here too.
    const src = fs.readFileSync(INIT_PATH, "utf8");
    expect((src.match(/Date\.now\(\)/g) || []).length).toBe(1);
    expect(src).not.toMatch(/const\s+(isStale|STALE_MS|elapsed)\b/);
  });
});

describe("rks_governor_init advertises the new outcomes", () => {
  it("the reset description and both contract comments name stale_reset and stale_reset_blocked", () => {
    const d = init.INPUT_SCHEMA.properties.reset.description;
    // stale_reset as its own token, not only as the prefix of stale_reset_blocked.
    expect(d).toMatch(/stale_reset(?!_blocked)/);
    expect(d).toContain("stale_reset_blocked");
    const src = fs.readFileSync(INIT_PATH, "utf8");
    const header = src.slice(0, src.indexOf("export const TOOL_NAME"));
    expect(header).toMatch(/stale_reset(?!_blocked)/);
    expect(header).toContain("stale_reset_blocked");
    const contract = src.slice(src.indexOf("RE-ENTRY CONTRACT"), src.indexOf("const owned = findOwnedSession("));
    expect(contract).toMatch(/stale_reset(?!_blocked)/);
    expect(contract).toContain("stale_reset_blocked");
  });
});

describe("Build Governor prompts handle the new init outcomes", () => {
  const PROMPTS = [
    path.join(ROOT, ".rks/prompts/governor-build.md"),
    path.join(ROOT, "templates/base/.rks/prompts/governor-build.md"),
  ];
  it.each(PROMPTS)("%s proceeds on stale_reset and stops on stale_reset_blocked without auto-reset", (p) => {
    const src = fs.readFileSync(p, "utf8");
    // stale_reset: proceed with the NEW token (same line, so the assertion is not satisfied elsewhere).
    expect(src).toMatch(/`mode` is 'stale_reset'[^\n]*NEW token/);
    // stale_reset_blocked: STOP on the same line that names it.
    expect(src).toMatch(/'stale_reset_blocked'[^\n]*STOP/);
    // Never auto-pass reset to get past the refusal.
    expect(src).toMatch(/NEVER pass `reset: true`/);
    // No added line opens a numbered step (other prompt suites delimit steps on that shape).
    const i = src.indexOf("'stale_reset'");
    const region = src.slice(i, src.indexOf("user's decision", i));
    for (const line of region.split("\n")) expect(line).not.toMatch(/^\d+(\.\d+)?\.\s/);
  });
});
