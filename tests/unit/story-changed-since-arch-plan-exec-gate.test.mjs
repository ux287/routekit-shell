/**
 * backlog.fix.exec-start-reset-story-changed-since-arch
 *
 * An arch-approved story whose content (body outside the ARCH Guidance section, targetFiles,
 * testRequirements) changed after rks_arch_verdict recorded arch_subject is refused at plan
 * (runPlanReadyTool) and at exec start (ensureExecStartPhase, rks_exec) with
 * story_changed_since_arch: the same predicate the rks_guardrails_off gate applies.
 * Phase assertions read the note FROM DISK, never a return value.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseFrontmatter } from "../../packages/mcp-rks/src/shared/frontmatter.mjs";
// ARCH_SUBJECT_VERSION, noteV1SubjectDigest and the classifyStoryGate keys archSubjectVersion / v1Subject are the
// names fixed by backlog.fix.arch-subject-digest-whitespace-robust (option C); Build substitutes the merged names
// if they differ. noteLegacySubjectDigest and notePreCarveOutSubjectDigest are used only for the parity case.
import {
  ARCH_SUBJECT_VERSION,
  noteSubjectDigest,
  noteV1SubjectDigest,
  noteLegacySubjectDigest,
  notePreCarveOutSubjectDigest,
  archSubjectMismatch,
  storyChangedSinceArch,
} from "../../packages/mcp-rks/src/workflow/arch-verdict.mjs";
import { classifyStoryGate } from "../../packages/mcp-rks/src/server/guardrails-audit.mjs";
import { runPlanReadyTool } from "../../packages/mcp-rks/src/server/plan-ready.mjs";
import { ensureExecStartPhase } from "../../packages/mcp-rks/src/server/exec-start-durability.mjs";
import { assertStoryUnchangedSinceArch } from "../../packages/mcp-rks/src/server/exec.mjs";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

const STORY = "backlog.fix.digest-probe";
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// Anchor markers are concatenated so this story's own anchor parser never sees them.
const AT = "@@";
const BODY = [
  "## Problem", "Problem.", "",
  "## Solution", "Solution.", "",
  "## Acceptance Criteria", "- [ ] It works", "",
  "## Target Files", "- `src/dummy.mjs` - EDIT", "",
  AT + "SEARCH", "export const x = 1;", AT + "REPLACE", "export const x = 2;", AT + "END", "",
].join("\n");

function frontmatterText({ phase, extra = [] }) {
  return [
    "---",
    `id: "${STORY}"`,
    'title: "Digest probe"',
    `phase: "${phase}"`,
    "multiFileAcknowledged: true",
    "testRequirements:",
    '  - "something"',
    "targetFiles:",
    '  - path: "src/dummy.mjs"',
    '    op: "edit"',
    ...extra,
    "---",
    "",
  ].join("\n");
}

const notePath = (root) => path.join(root, "notes", `${STORY}.md`);
const read = (root) => fs.readFileSync(notePath(root), "utf8");
const write = (root, text) => fs.writeFileSync(notePath(root), text);
const parsedOnDisk = (root) => parseFrontmatter(read(root));
const phaseOnDisk = (root) => read(root).match(/^phase:\s*"?([^"\n]+)"?/m)?.[1]?.trim();

/**
 * A story as rks_arch_verdict leaves it: arch_verdict, arch_subject and arch_subject_version recorded against
 * its current content. versioned: false omits arch_subject_version (an approval recorded before fingerprint
 * versioning). subject: "v1" records noteV1SubjectDigest instead of the current digest. body defaults to BODY;
 * WITH_EXTRA_WHITESPACE carries whitespace-only layout, so its v1 digest differs from its current digest.
 */
function makeStory({ phase = "arch-approved", verdict = "approved", recordSubject = true, versioned = true, subject, body = BODY } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-since-arch-"));
  dirs.push(root);
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "dummy.mjs"), "export const x = 1;\n");
  const parsed = parseFrontmatter(frontmatterText({ phase }) + body);
  const digest = noteSubjectDigest(parsed);
  const v1 = noteV1SubjectDigest(parsed);
  const recorded = subject === "v1" ? v1 : digest;
  const extra = [`arch_verdict: "${verdict}"`];
  if (recordSubject) extra.push(`arch_subject: "${recorded}"`);
  if (recordSubject && versioned) extra.push(`arch_subject_version: "${ARCH_SUBJECT_VERSION}"`);
  write(root, frontmatterText({ phase, extra }) + body);
  return { root, digest, v1 };
}

// Material amendments.
const amendBody = (root) => write(root, read(root).replace("Solution.", "Solution, amended after ARCH."));
const amendTargetFiles = (root) =>
  write(root, read(root).replace('    op: "edit"', '    op: "edit"\n  - path: "src/other.mjs"\n    op: "edit"'));
const amendTestRequirements = (root) =>
  write(root, read(root).replace('  - "something"', '  - "something"\n  - "something else"'));
// Records arch_subject_version as the given YAML scalar on a makeStory({ versioned: false }) note.
const withVersion = (root, v) =>
  write(root, read(root).replace(/^arch_subject: .*$/m, (line) => `${line}\narch_subject_version: ${v}`));

// A refine-owned row-7 block (backlog.fix.arch-subject-digest-excludes-refine-context-sections): excluded
// from the current digest, so appending it after a version-2 approval is not an amendment.
const WITH_REFINE_HISTORY = BODY + "\n" + "## " + "Refinement History (2026-10-13)\n- Added SEARCH anchors for src/dummy.mjs\n";

// Whitespace-only layout (backlog.fix.arch-subject-digest-whitespace-robust): a blank line after the frontmatter
// and a run of blank lines between sections. The current (version-2) digest normalises both; the version-1 digest
// keeps them, so the two differ.
const WITH_EXTRA_WHITESPACE = "\n" + BODY.replace("Solution.", "Solution.\n\n\n");

describe("storyChangedSinceArch: the shared predicate", () => {
  it("passes an approved story whose content is unchanged since ARCH", () => {
    const { root } = makeStory();
    expect(storyChangedSinceArch(parsedOnDisk(root), STORY).changed).toBe(false);
  });

  it("refuses after a body amendment, naming the story, both digests and /arch", () => {
    const { root, digest } = makeStory();
    amendBody(root);
    const res = storyChangedSinceArch(parsedOnDisk(root), STORY);
    expect(res.changed).toBe(true);
    expect(res.recorded).toBe(digest);
    expect(res.current).toBe(noteSubjectDigest(parsedOnDisk(root)));
    expect(res.current).not.toBe(digest);
    expect(res.message).toContain(STORY);
    expect(res.message).toContain(digest);
    expect(res.message).toContain(res.current);
    expect(res.message).toContain("/arch");
  });

  it("refuses after a targetFiles amendment and after a testRequirements amendment", () => {
    const a = makeStory();
    amendTargetFiles(a.root);
    expect(storyChangedSinceArch(parsedOnDisk(a.root), STORY).changed).toBe(true);
    const b = makeStory();
    amendTestRequirements(b.root);
    expect(storyChangedSinceArch(parsedOnDisk(b.root), STORY).changed).toBe(true);
  });

  it("passes when arch_subject is absent, and when arch_verdict is not approved", () => {
    const a = makeStory({ recordSubject: false });
    amendBody(a.root);
    expect(storyChangedSinceArch(parsedOnDisk(a.root), STORY).changed).toBe(false);
    const b = makeStory({ verdict: "needs-revision" });
    amendBody(b.root);
    expect(storyChangedSinceArch(parsedOnDisk(b.root), STORY).changed).toBe(false);
  });

  it("refuses a non-string arch_subject on a version-2 approval", () => {
    const b = makeStory();
    write(b.root, read(b.root).replace(/^arch_subject: .*$/m, "arch_subject: 123"));
    const res = storyChangedSinceArch(parsedOnDisk(b.root), STORY);
    expect(res.changed).toBe(true);
    expect(res.gated).toBe(true);
  });

  it("leaves an unversioned approval ungated, before and after an amendment, without hashing", () => {
    const a = makeStory({ versioned: false, subject: "v1", body: WITH_EXTRA_WHITESPACE });
    const before = storyChangedSinceArch(parsedOnDisk(a.root), STORY);
    expect(before.changed).toBe(false);
    expect(before.gated).toBe(false);
    expect(before.ungatedReason).toBe("arch_subject_unversioned");
    expect(before.current).toBeNull();
    amendBody(a.root);
    expect(storyChangedSinceArch(parsedOnDisk(a.root), STORY).changed).toBe(false);
    for (const v of ["null", '""', '"   "']) {
      const b = makeStory({ versioned: false });
      withVersion(b.root, v);
      amendBody(b.root);
      const res = storyChangedSinceArch(parsedOnDisk(b.root), STORY);
      expect(res.changed).toBe(false);
      expect(res.gated).toBe(false);
      expect(res.ungatedReason).toBe("arch_subject_unversioned");
      expect(res.current).toBeNull();
    }
  });

  it("refuses a present arch_subject_version that is not current, fail closed, before and after an amendment", () => {
    for (const v of ['"1"', "1", '"3"', '["2"]', "{ v: 2 }", "true"]) {
      for (const amend of [false, true]) {
        const b = makeStory({ versioned: false });
        withVersion(b.root, v);
        if (amend) amendBody(b.root);
        const res = storyChangedSinceArch(parsedOnDisk(b.root), STORY);
        expect(res.changed).toBe(true);
        expect(res.gated).toBe(true);
        expect(res.failedClosed).toBe(true);
        expect(res.ungatedReason).toBeUndefined();
        expect(res.recordedVersion).toEqual(parsedOnDisk(b.root).data.arch_subject_version);
        expect(res.message).toContain(STORY);
        expect(res.message).toContain(JSON.stringify(res.recordedVersion));
        expect(res.message).toContain("/arch");
      }
    }
  });

  it("uses no compat digest: a version-2 approval whose arch_subject is the v1 digest is refused", () => {
    const a = makeStory({ subject: "v1", body: WITH_EXTRA_WHITESPACE });
    expect(a.v1).not.toBe(a.digest);
    const res = storyChangedSinceArch(parsedOnDisk(a.root), STORY);
    expect(res.gated).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.failedClosed).toBe(false);
  });

  it("a version-2 approval is not tripped by whitespace-only layout or an appended refine-owned block", () => {
    // Approved on BODY, then re-laid-out AFTER the verdict: the v1 digest moves, the current one does not.
    const a = makeStory();
    write(a.root, read(a.root).replace(BODY, WITH_EXTRA_WHITESPACE));
    expect(noteV1SubjectDigest(parsedOnDisk(a.root))).not.toBe(a.v1);
    expect(noteSubjectDigest(parsedOnDisk(a.root))).toBe(a.digest);
    expect(storyChangedSinceArch(parsedOnDisk(a.root), STORY).changed).toBe(false);
    write(a.root, read(a.root) + WITH_REFINE_HISTORY.slice(BODY.length));
    expect(storyChangedSinceArch(parsedOnDisk(a.root), STORY).changed).toBe(false);
  });

  it("archSubjectMismatch gates only current-version approvals and compares the current digest only", () => {
    const base = { archVerdict: "approved", archSubject: "S", archSubjectVersion: String(ARCH_SUBJECT_VERSION) };
    expect(archSubjectMismatch({ ...base, currentSubject: "S" })).toBe(false);
    expect(archSubjectMismatch({ ...base, currentSubject: "c" })).toBe(true);
    expect(archSubjectMismatch({ ...base, currentSubject: "c", legacySubject: "S", preCarveOutSubject: "S", v1Subject: "S" })).toBe(true);
    expect(archSubjectMismatch({ ...base, archSubject: 123, currentSubject: "c" })).toBe(true);
    expect(archSubjectMismatch({ ...base, archSubjectVersion: ARCH_SUBJECT_VERSION, currentSubject: "c" })).toBe(true);
    // backlog.fix.arch-subject-digest-whitespace-robust AC: "2" with surrounding whitespace is current.
    expect(archSubjectMismatch({ ...base, archSubjectVersion: ` ${ARCH_SUBJECT_VERSION} `, currentSubject: "c" })).toBe(true);
    expect(archSubjectMismatch({ ...base, archSubjectVersion: ` ${ARCH_SUBJECT_VERSION} `, currentSubject: "S" })).toBe(false);
    for (const archSubjectVersion of [undefined, null, "", "   "]) {
      expect(archSubjectMismatch({ ...base, archSubjectVersion, currentSubject: "c" })).toBe(false);
    }
    for (const archSubjectVersion of ["1", 1, "3", [String(ARCH_SUBJECT_VERSION)], { v: 2 }, true]) {
      expect(archSubjectMismatch({ ...base, archSubjectVersion, currentSubject: "S" })).toBe(true);
      expect(archSubjectMismatch({ ...base, archSubjectVersion, currentSubject: "c" })).toBe(true);
    }
    expect(archSubjectMismatch({ ...base, archVerdict: "needs-revision", currentSubject: "c" })).toBe(false);
    expect(archSubjectMismatch({ ...base, archSubject: undefined, currentSubject: "c" })).toBe(false);
  });

  it("fails closed when a digest cannot be computed", () => {
    const { root } = makeStory();
    // Mutate a COPY: gray-matter caches parse results by input text and returns a SHALLOW copy
    // (node_modules/gray-matter/index.js:35-47), so a getter defined on the returned data object
    // would poison every later parse of an identical note in this file.
    const fresh = parsedOnDisk(root);
    const parsed = { content: fresh.content, data: { ...fresh.data } };
    Object.defineProperty(parsed.data, "targetFiles", { get() { throw new Error("boom"); } });
    const res = storyChangedSinceArch(parsed, STORY);
    expect(res.changed).toBe(true);
    expect(res.failedClosed).toBe(true);
    expect(res.message).toContain(STORY);
    expect(res.message).toContain("/arch");
  });
});

describe("pipeline writes do not invalidate the approval", () => {
  it("an ARCH Guidance section written after the verdict is not an amendment", () => {
    const { root } = makeStory();
    write(root, read(root) + "\n" + "## " + "ARCH Guidance\n\nApproved. Reviewer notes.\n");
    expect(storyChangedSinceArch(parsedOnDisk(root), STORY).changed).toBe(false);
  });

  it("phase, updated, testFiles and arch_* frontmatter writes are not amendments", () => {
    const { root } = makeStory();
    for (const p of ["planned", "executing", "executed", "arch-approved"]) {
      write(root, read(root).replace(/^phase: .*$/m, `phase: "${p}"`));
      expect(storyChangedSinceArch(parsedOnDisk(root), STORY).changed).toBe(false);
    }
    write(root, read(root).replace(/^arch_verdict: .*$/m, [
      'arch_verdict: "approved"',
      "arch_round: 2",
      "updated: 1790000000000",
      "testFiles:",
      '  - "tests/unit/x.test.mjs"',
    ].join("\n")));
    expect(storyChangedSinceArch(parsedOnDisk(root), STORY).changed).toBe(false);
  });
});

describe("parity with the rks_guardrails_off story gate", () => {
  const gateInputs = (root, parsed) => ({
    problemId: STORY, notePath: notePath(root), noteExists: true, phase: parsed.data.phase,
    archVerdict: parsed.data.arch_verdict ?? null,
    archSubject: parsed.data.arch_subject ?? null,
    archSubjectVersion: parsed.data.arch_subject_version ?? null,
    currentSubject: noteSubjectDigest(parsed),
    v1Subject: noteV1SubjectDigest(parsed),
    legacySubject: noteLegacySubjectDigest(parsed),
    preCarveOutSubject: notePreCarveOutSubjectDigest(parsed),
  });
  const amended = (opts) => { const s = makeStory(opts); amendBody(s.root); return s; };

  it("for version-2 approvals classifyStoryGate refuses with story_changed_since_arch exactly when the gate does", () => {
    const cases = [
      makeStory(), amended(), amended({ recordSubject: false }),
      makeStory({ body: WITH_EXTRA_WHITESPACE }), amended({ body: WITH_EXTRA_WHITESPACE }),
      makeStory({ subject: "v1", body: WITH_EXTRA_WHITESPACE }),
    ];
    for (const { root } of cases) {
      const parsed = parsedOnDisk(root);
      const inputs = gateInputs(root, parsed);
      const changed = storyChangedSinceArch(parsed, STORY).changed;
      expect(classifyStoryGate(inputs).reason === "story_changed_since_arch").toBe(changed);
      expect(archSubjectMismatch(inputs)).toBe(changed);
    }
  });

  it("for unversioned approvals the gate never refuses while classifyStoryGate keeps its own verdict", () => {
    const unchanged = makeStory({ versioned: false, subject: "v1", body: WITH_EXTRA_WHITESPACE });
    const changedOne = amended({ versioned: false, subject: "v1", body: WITH_EXTRA_WHITESPACE });
    for (const { root } of [unchanged, changedOne]) {
      const parsed = parsedOnDisk(root);
      expect(storyChangedSinceArch(parsed, STORY).changed).toBe(false);
      expect(archSubjectMismatch(gateInputs(root, parsed))).toBe(false);
    }
    expect(classifyStoryGate(gateInputs(unchanged.root, parsedOnDisk(unchanged.root))).ok).toBe(true);
    expect(classifyStoryGate(gateInputs(changedOne.root, parsedOnDisk(changedOne.root))).reason).toBe("story_changed_since_arch");
  });
});

describe("rks_plan_ready (and so rks_plan) refuses an amended approved story", () => {
  const sinceArchIssue = (res) => (res.issues || []).find((i) => i.check === "story_changed_since_arch");
  const planReady = (root) => runPlanReadyTool({ projectId: "test", problemId: STORY, projectRoot: root });

  it("reports a blocking story_changed_since_arch issue and leaves the phase alone", async () => {
    const { root } = makeStory();
    amendBody(root);
    const res = await planReady(root);
    expect(res.ready).toBe(false);
    const issue = sinceArchIssue(res);
    expect(issue).toBeDefined();
    expect(issue.message).toContain(STORY);
    expect(issue.message).toContain("/arch");
    expect(issue.failedClosed).toBe(false);
    expect(phaseOnDisk(root)).toBe("arch-approved");
  });

  it("raises no such issue for an unchanged story or one with no arch_subject, and only warns for an unversioned approval", async () => {
    const ungated = (res) => (res.warnings || []).find((w) => w.check === "arch_subject_ungated");
    const a = makeStory();
    const resA = await planReady(a.root);
    expect(sinceArchIssue(resA)).toBeUndefined();
    expect(ungated(resA)).toBeUndefined();
    const b = makeStory({ recordSubject: false });
    amendBody(b.root);
    expect(sinceArchIssue(await planReady(b.root))).toBeUndefined();
    const c = makeStory({ versioned: false });
    amendBody(c.root);
    const resC = await planReady(c.root);
    expect(sinceArchIssue(resC)).toBeUndefined();
    expect(ungated(resC)).toBeDefined();
    // Non-blocking: the warning is never an issue, and readiness matches the otherwise-identical
    // unchanged version-2 fixture (a), so the Build prompt's issues-array STOP rules never see it.
    expect((resC.issues || []).some((i) => i.check === "arch_subject_ungated")).toBe(false);
    expect(resC.ready).toBe(resA.ready);
    expect((resC.issues || []).map((i) => i.check)).toEqual((resA.issues || []).map((i) => i.check));
    expect(ungated(resC).message).toContain(STORY);
    expect(ungated(resC).message).toContain("/arch");
  });

  it("refuses an approval whose arch_subject_version is the string 3, fail closed, with no ungated warning", async () => {
    const { root } = makeStory({ versioned: false });
    withVersion(root, '"3"');
    const res = await planReady(root);
    expect(res.ready).toBe(false);
    const issue = sinceArchIssue(res);
    expect(issue).toBeDefined();
    expect(issue.failedClosed).toBe(true);
    expect(issue.message).toContain(STORY);
    expect(issue.message).toContain("/arch");
    expect((res.warnings || []).find((w) => w.check === "arch_subject_ungated")).toBeUndefined();
  });

  it("fails closed: a check that throws or returns no verdict is a blocking issue with failedClosed true", async () => {
    const { root } = makeStory();
    for (const sinceArchCheck of [() => { throw new Error("predicate exploded"); }, () => undefined]) {
      const res = await runPlanReadyTool({ projectId: "test", problemId: STORY, projectRoot: root, sinceArchCheck });
      expect(res.ready).toBe(false);
      const issue = sinceArchIssue(res);
      expect(issue).toBeDefined();
      expect(issue.failedClosed).toBe(true);
      expect(issue.message).toContain(STORY);
      expect(issue.message).toContain("/arch");
    }
  });
});

describe("ensureExecStartPhase refuses an amended approved story and writes nothing", () => {
  const start = (root) => ensureExecStartPhase({ projectRoot: root, problemId: STORY, projectId: "test" });

  it("from arch-approved: refuses, phase stays arch-approved on disk", async () => {
    const { root } = makeStory({ phase: "arch-approved" });
    amendBody(root);
    const res = await start(root);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("story_changed_since_arch");
    expect(phaseOnDisk(root)).toBe("arch-approved");
  });

  it("from planned: refuses before the reset write, phase stays planned on disk", async () => {
    const { root } = makeStory({ phase: "planned" });
    amendBody(root);
    const res = await start(root);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("story_changed_since_arch");
    expect(phaseOnDisk(root)).toBe("planned");
    expect(res.failedClosed).toBe(false);
  });

  it("fails closed: a check that throws or returns no verdict refuses with failedClosed true and writes nothing", async () => {
    for (const sinceArchCheck of [() => { throw new Error("predicate exploded"); }, () => undefined]) {
      const { root } = makeStory({ phase: "planned" });
      const res = await ensureExecStartPhase({ projectRoot: root, problemId: STORY, projectId: "test", sinceArchCheck });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("story_changed_since_arch");
      expect(res.failedClosed).toBe(true);
      expect(phaseOnDisk(root)).toBe("planned");
    }
  });

  it("an approval whose arch_subject_version is the string 3 refuses fail closed and writes nothing", async () => {
    const { root } = makeStory({ phase: "planned", versioned: false });
    withVersion(root, '"3"');
    const res = await start(root);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("story_changed_since_arch");
    expect(res.failedClosed).toBe(true);
    expect(phaseOnDisk(root)).toBe("planned");
  });

  it("an unversioned approval is ungated: an amended one still lands executing", async () => {
    const { root } = makeStory({ phase: "planned", versioned: false });
    amendBody(root);
    const res = await start(root);
    expect(res.ok).toBe(true);
    expect(phaseOnDisk(root)).toBe("executing");
  });

  it("an unchanged approved story still lands executing, from arch-approved and from planned", async () => {
    for (const opts of [
      { phase: "arch-approved" },
      { phase: "planned" },
      { phase: "planned", body: WITH_EXTRA_WHITESPACE },
      { phase: "planned", versioned: false, subject: "v1", body: WITH_EXTRA_WHITESPACE },
    ]) {
      const { root } = makeStory(opts);
      const res = await start(root);
      expect(res.ok).toBe(true);
      expect(phaseOnDisk(root)).toBe("executing");
    }
  });
});

describe("rks_exec applies the same check inside its phase gate", () => {
  const EXEC_SRC = fs.readFileSync(path.resolve("packages/mcp-rks/src/server/exec.mjs"), "utf8");

  it("calls assertStoryUnchangedSinceArch after the phase check, inside the RKS_SKIP_PHASE_CHECK-guarded try", () => {
    const gate = EXEC_SRC.indexOf("if (problemId && !process.env.RKS_SKIP_PHASE_CHECK) {");
    const phaseCheck = EXEC_SRC.indexOf("currentPhase !== PHASE_GATE_EXEC", gate);
    const call = EXEC_SRC.indexOf("assertStoryUnchangedSinceArch(story, problemId)", gate);
    const gateCatch = EXEC_SRC.indexOf("if (e instanceof McpError) throw e;", gate);
    expect(gate).toBeGreaterThan(-1);
    expect(phaseCheck).toBeGreaterThan(gate);
    expect(call).toBeGreaterThan(phaseCheck);
    expect(gateCatch).toBeGreaterThan(call);
    expect(EXEC_SRC).toMatch(/import\s*\{[^}]*storyChangedSinceArch[^}]*\}\s*from\s*"\.\.\/workflow\/arch-verdict\.mjs"/);
  });

  const loaded = (root) => {
    const parsed = parsedOnDisk(root);
    return { frontmatter: parsed.data, body: parsed.content };
  };
  const thrownBy = (fn) => { try { fn(); } catch (e) { return e; } return undefined; };

  it("assertStoryUnchangedSinceArch throws McpError naming the story and /arch for an amended approved story", () => {
    const { root } = makeStory({ phase: "executing" });
    amendBody(root);
    const err = thrownBy(() => assertStoryUnchangedSinceArch(loaded(root), STORY));
    expect(err).toBeInstanceOf(McpError);
    expect(err.message).toContain(STORY);
    expect(err.message).toContain("/arch");
  });

  it("assertStoryUnchangedSinceArch passes an unchanged version-2 story and an amended unversioned one", () => {
    const a = makeStory({ phase: "executing" });
    expect(thrownBy(() => assertStoryUnchangedSinceArch(loaded(a.root), STORY))).toBeUndefined();
    const b = makeStory({ phase: "executing", versioned: false });
    amendBody(b.root);
    expect(thrownBy(() => assertStoryUnchangedSinceArch(loaded(b.root), STORY))).toBeUndefined();
  });

  it("fails closed: a throw from the check becomes an McpError refusal, never a pass", () => {
    const { root } = makeStory({ phase: "executing" });
    const err = thrownBy(() =>
      assertStoryUnchangedSinceArch(loaded(root), STORY, () => { throw new Error("predicate exploded"); })
    );
    expect(err).toBeInstanceOf(McpError);
    expect(err.message).toContain("story_changed_since_arch");
    expect(err.message).toContain(STORY);
    expect(err.message).toContain("predicate exploded");
  });

  it("assertStoryUnchangedSinceArch refuses an approval whose arch_subject_version is the string 3", () => {
    const { root } = makeStory({ phase: "executing", versioned: false });
    withVersion(root, '"3"');
    const err = thrownBy(() => assertStoryUnchangedSinceArch(loaded(root), STORY));
    expect(err).toBeInstanceOf(McpError);
    expect(err.message).toContain(STORY);
    expect(err.message).toContain("/arch");
  });

  it("fails closed: a check that returns no boolean verdict is a refusal", () => {
    const { root } = makeStory({ phase: "executing" });
    const err = thrownBy(() => assertStoryUnchangedSinceArch(loaded(root), STORY, () => undefined));
    expect(err).toBeInstanceOf(McpError);
    expect(err.message).toContain("story_changed_since_arch");
  });
});
