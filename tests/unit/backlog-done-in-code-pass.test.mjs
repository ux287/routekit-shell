// chore.backlog-agents-architecture-done-in-code
//
// Binds the done-in-code audit paper to the real manifest and to the post-apply notes tree.
// Ids are kept without the leading prefix and joined at run time (see the story's QA note).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { destinationFor } from "../../scripts/backlog-archive-sweep.mjs";
import { parseFrontmatter } from "../../packages/mcp-rks/src/shared/frontmatter.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOTES = path.join(REPO_ROOT, "notes");
const MD = ".md";
const P = "backlog" + ".";
const full = (stripped) => P + stripped;
const STORY = "chore.backlog-agents-architecture-done-in-code";
const PAPER = path.join(NOTES, "research.2026.11.15.backlog-done-in-code-pass" + MD);
const ROW_27 = "architecture.exec-mjs-maintainability-refactor.05-extract-story-validator";
const ROW_41 = "architecture.planner-test-enforcement";
// Rows 8, 16, 18, 20, 40 (user ruled shelve) and the batch-1 STALE rows of the namespaces paper.
const NO_ENTRY = [
  "agents.orchestration-and-parallelization",
  "architecture.abstract-code-context",
  "architecture.abstract-target-resolver",
  "architecture.ci-integration-testing",
  "architecture.planner-slim-orchestrator",
  "agents.dispatcher-minimal-params",
  "agents.exec-to-ship-handoff",
  "architecture.code-rag-strategy",
  "architecture.embedding-optimization",
  "architecture.empty-repo-bootstrap",
  "architecture.exec-extract-backlog-status",
  "architecture.exec-mjs-maintainability-refactor",
  "architecture.multi-agent-orchestration",
  "architecture.plan-phase-checkpoint",
  "architecture.planner-extract-prompt-assembly",
  "architecture.self-improvement-loop",
];

// Batch 2 (build-time candidate set): every old live critic, design and dx note the cutoff dry run
// moved in cohort S or held in_flight_review, plus the 59 in-flight notes the user ruled
// "Check, then shelve". Held without the leading prefix.
const BATCH_2 = [
  "bug.init-targets-lts-not-staging",
  "bug.rag-embed-expects-dev.server",
  "bug.rag-embed-expects-dev.validator",
  "bug.rks-refine-apply-yaml-serialization",
  "canary.simple-create",
  "content.rks-workflow-blog",
  "content.telemetry-lessons-learned",
  "critic-v2.1-semantic-clusters",
  "critic-v2.2-concern-decomposition",
  "critic-v2.3-multi-pass-planner",
  "critic-v2.4-convergent-refinement",
  "critic-v2.5-schema-extensions",
  "critic-v2.6-prompt-updates",
  "design.ac-validation-against-plan",
  "design.agent-code-review",
  "design.dispatcher-cheap-read-path",
  "design.flow-descriptor-registry",
  "design.git-anchored-citations",
  "design.key-aware-dispatcher-mode",
  "design.lightweight-flow-chore-docs-stories",
  "design.mcp-degraded-keyfree-boot",
  "design.public.canon.cal-documentation-architecture",
  "design.rag-query-drop-routing-guardrails-decision",
  "dx.block-git-during-off-rail",
  "dx.context-retention-patterns",
  "dx.documentation-howto-guides",
  "dx.exec-error-capture",
  "dx.exec-partial-rollback",
  "dx.exec-test-failure-analysis",
  "dx.hook-error-ux-phase2",
  "dx.interview-based-project-setup",
  "dx.mcp-discovery-onboarding",
  "dx.plan-auto-commit-phase",
  "dx.preflight-check",
  "dx.rag-embed-staleness",
  "dx.release-process-guardrails",
  "dx.rks-init-main-branch-default.01-git-tools",
  "dx.rks-init-main-branch-default.02-planner",
  "dx.rks-init-main-branch-default.03-exec",
  "dx.rks-init-main-branch-default.04-server",
  "dx.rks-init-main-branch-default.05-cli",
  "dx.test-coverage-backfill",
  "feat.browser-test-agent-core.child-1",
  "feat.exec-auto-commit-notes-pre-check.child-1.child-1",
  "feat.exec-dry-run",
  "feat.exec-step-divergence.child-1",
  "feat.exec-test-verification-report.child-1",
  "feat.fix-incremental-embed-path-mismatch",
  "feat.fix-story-schema.child-1",
  "feat.frontmatter-validation-tests",
  "feat.planner-529-resilience.child-1",
  "feat.planner-live-file-reads.child-1",
  "feat.release-push-staging-fixes.child-1",
  "feat.ship-ci-polling.child-1",
  "feat.test-failure-enforcement-hook",
  "feat.vendor-script-auto-commit.child-1",
  "feat.visual-qa-playwright-execution",
  "feat.vitest-include-mcp-rks-tests",
  "feat.workflow.enforce-cycle-complete-before-next-story",
  "fix.auto-decompose-on-scope.child-1",
  "fix.ci-exit-code-124-force-exit",
  "fix.enforce-plan-ready-before-plan",
  "fix.exec-diverged-state",
  "fix.exec-failure-state-rollback",
  "fix.guardrails-restore-gap.child-1",
  "fix.guardrails-test-dependency-injection",
  "fix.hooks-health-hooksbak-guard.child-1",
  "fix.hooks-manifest-staleness.child-1",
  "fix.off-rail-to-refine.child-1",
  "fix.off-rail-to-refine.child-2",
  "fix.preserve-notes-on-rollback.child-1",
  "fix.restore-dispatcher-discipline.child-1",
  "fix.session-state-provenance-exempt",
  "fix.ship-adhoc-staging-path.child-1",
  "fix.ship-local-merge-for-local-branches",
  "fix.stale-branch-cleanup.impl.child-1",
  "fix.stale-branch-cleanup.tests.child-1",
  "governor.thinking-log",
  "guardrails-on-auto-push-staging",
  "hooks.redirect-read-tools-to-agent",
  "junk.feat.cleanup-claude-json.find-stale-core",
  "planner.create-new-files",
  "planner.story-template-defaults",
  "refactor.consolidate-frontmatter-handlers",
  "test.hook-testing-harness",
  "test.planner-stability",
  "workflow.notes-branch-sync",
  "workflow.staging-sync-check",
  "workflow.story-dependencies",
];

const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts", "backlog-archive-manifest.json"), "utf8"));
const ours = manifest.doneInCode.filter((e) => typeof e.$comment === "string" && e.$comment.includes(STORY));
const paperText = () => fs.readFileSync(PAPER, "utf8");

function verdictRows(text) {
  const start = text.indexOf("## Verdicts");
  expect(start).toBeGreaterThan(-1);
  const rows = [];
  for (const line of text.slice(start).split("\n").slice(1)) {
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells[0] === "note" || /^-+$/.test(cells[0])) continue;
    rows.push({ note: cells[0].replace(/`/g, ""), batch: cells[1], verdict: cells[2], evidence: cells.slice(3).join("|") });
  }
  return rows;
}

function heldRows(text) {
  const start = text.indexOf("## Held for another reason");
  const end = text.indexOf("## Verdicts");
  expect(start).toBeGreaterThan(-1);
  const rows = [];
  for (const line of text.slice(start, end).split("\n").slice(1)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells[0] === "note" || /^-+$/.test(cells[0])) continue;
    rows.push({ note: cells[0].replace(/`/g, ""), reason: cells.slice(1).join("|") });
  }
  return rows;
}

function evidenceFound(entry) {
  return Array.isArray(entry.evidence) && entry.evidence.length > 0 && entry.evidence.every((ev) => {
    const abs = path.join(REPO_ROOT, ev.file);
    return typeof ev.literal === "string" && ev.literal !== "" && fs.existsSync(abs) && fs.readFileSync(abs, "utf8").includes(ev.literal);
  });
}

describe("backlog done-in-code pass", () => {
  it("every doneInCode entry this story adds has evidence found in its file", () => {
    expect(ours.length).toBeGreaterThan(0);
    for (const e of ours) expect(evidenceFound(e), e.id).toBe(true);
  });

  it("every entry this story adds names its batch and batch-1 entries name their paper row", () => {
    for (const e of ours) {
      const m = e.$comment.match(/batch (\d+)/i);
      expect(m, e.id).not.toBeNull();
      if (m[1] === "1") expect(e.$comment, e.id).toMatch(/row \d+/i);
    }
  });

  it("planner-test-enforcement entry records the user ruling and the plan-ready evidence", () => {
    const e = ours.find((x) => x.id === full(ROW_41));
    expect(e).toBeDefined();
    expect(e.$comment).toContain("Treat as done");
    expect(e.evidence.some((ev) => ev.file === "packages/mcp-rks/src/server/plan-ready.mjs")).toBe(true);
  });

  it("user-ruled shelve rows and batch-1 STALE rows get no doneInCode entry", () => {
    const ids = new Set(manifest.doneInCode.map((e) => e.id));
    for (const s of NO_ENTRY) expect(ids.has(full(s)), s).toBe(false);
  });

  it("testReferences covers the row-27 line in frontmatter-schema.spec", () => {
    const r = manifest.testReferences.find((x) => x.id === full(ROW_27) && x.file === "tests/unit/frontmatter-schema.spec.mjs");
    expect(r).toBeDefined();
    expect(["data", "comment"]).toContain(r.use);
    const lines = fs.readFileSync(path.join(REPO_ROOT, r.file), "utf8").split("\n");
    expect(lines[r.line - 1]).toContain(r.text);
  });

  it("audit paper parses and records the dry-run digest and git anchor", () => {
    const text = paperText();
    expect(parseFrontmatter(text).data.id).toBe("research.2026.11.15.backlog-done-in-code-pass");
    expect(text).toMatch(/^- Dry-run digest: *\S+/m);
    expect(text).toMatch(/^- Git anchor: *\S+/m);
  });

  it("audit paper names no live backlog note by full id", () => {
    const text = paperText();
    // notes/backlog*.md filenames whose id has the form <prefix><rest> (the requirement's
    // backlog.*.md glob, and the sweep's candidate predicate). The root index note, whose
    // id is the bare prefix word, is not a backlog story and is excluded.
    const live = fs.readdirSync(NOTES).filter((f) => f.endsWith(MD)).map((f) => f.slice(0, -MD.length)).filter((id) => id.startsWith(P) && !id.startsWith(P + "z_"));
    expect(live.length).toBeGreaterThan(0);
    for (const id of live) expect(text.includes(id), id).toBe(false);
  });

  it("every done row has a found doneInCode entry and no unclear row has one", () => {
    const byId = new Map(manifest.doneInCode.map((e) => [e.id, e]));
    const rows = verdictRows(paperText());
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(["done", "unclear"], r.note).toContain(r.verdict);
      const e = byId.get(full(r.note));
      if (r.verdict === "done") expect(e && evidenceFound(e), r.note).toBe(true);
      // An unclear row gets no doneInCode entry from this story. A later story may record it after its own
      // AC check (chore.backlog-sweep-final-residual-holds does for one), so only this story's entries count.
      else expect(ours.includes(e), r.note).toBe(false);
    }
  });

  it("each examined note appears in exactly one verdict row and every entry this story adds has a done row", () => {
    const rows = verdictRows(paperText());
    const notes = rows.map((r) => r.note);
    expect(new Set(notes).size).toBe(notes.length);
    const done = new Set(rows.filter((r) => r.verdict === "done").map((r) => full(r.note)));
    for (const e of ours) expect(done.has(e.id), e.id).toBe(true);
  });

  it("each done note is at its z_implemented destination with cohort metadata and the live file is gone", () => {
    for (const r of verdictRows(paperText()).filter((x) => x.verdict === "done")) {
      const id = full(r.note);
      const dest = destinationFor(id, "z_implemented");
      const abs = path.join(NOTES, dest + MD);
      expect(fs.existsSync(abs), dest).toBe(true);
      expect(fs.existsSync(path.join(NOTES, id + MD)), r.note).toBe(false);
      const data = parseFrontmatter(fs.readFileSync(abs, "utf8")).data;
      expect(data.id).toBe(dest);
      expect(data.status).toBe("implemented");
      expect(data.archiveCohort).toBe("done-in-code");
      expect(Array.isArray(data.archiveEvidence) && data.archiveEvidence.length > 0, dest).toBe(true);
    }
  });

  it("batch 2 gives every critic, design, dx and in-flight candidate exactly one batch-2 row", () => {
    // A candidate the batch-2 dry run holds for another reason (for example target_exists) is
    // listed in the held table instead of the Verdicts table, and has no doneInCode entry.
    const text = paperText();
    const rows = verdictRows(text);
    const held = heldRows(text);
    const ids = new Set(manifest.doneInCode.map((e) => e.id));
    expect(BATCH_2.length).toBe(89);
    for (const id of BATCH_2) {
      const mine = rows.filter((r) => r.note === id);
      const mineHeld = held.filter((r) => r.note === id);
      expect(mine.length + mineHeld.length, id).toBe(1);
      if (mine.length) expect(mine[0].batch, id).toMatch(/^2\b/);
      else {
        expect(mineHeld[0].reason, id).toMatch(/^batch 2\b/);
        // A held note may carry a doneInCode entry only when a reviewed duplicates[] entry names it as
        // live (chore.backlog-sweep-resolve-shipped-twins resolves target_exists that way).
        const dupLive = (manifest.duplicates || []).some((d) => d.live === full(id));
        if (!dupLive) expect(ids.has(full(id)), id).toBe(false);
      }
    }
    for (const e of ours.filter((x) => /batch 2\b/i.test(x.$comment))) {
      expect(BATCH_2.includes(e.id.slice(P.length)), e.id).toBe(true);
    }
  });
});
