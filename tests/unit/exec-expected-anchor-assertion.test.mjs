/**
 * backlog.fix.exec-working-tree-anchor-assertion
 *
 * The PLAN side of verification was already sealed — plan.qualityReview.hash is written at plan
 * time and exec returns integrity_failed on drift. The WORKING TREE side was not.
 * rks_exhaustive_search returns a git anchor precisely so a result can be pinned, but rks_exec
 * had no parameter to assert it, so "I verified this anchor, now execute against that tree" was
 * unexpressible. Divergence surfaced only at apply time, when applySearchReplace failed to find
 * its pattern — which is failure detection, the opposite of pre-execution verification.
 *
 * Behavioural assertions against the exported comparator. Note the schema half of this story is
 * the part that silently fails if done wrong: execSchema is a bare z.object() (strip mode) and
 * runs .parse(cleanArgs), so a field advertised in the JSON Schema but absent from the zod
 * schema is discarded before the tool body ever sees it — the feature would be a no-op AND the
 * mcp-schema-drift-guard would redden. Both declarations are asserted here.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareGitAnchors } from "../../packages/mcp-rks/src/server/exec.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
const OTHER = "0000000000000000000000000000000000000000";

describe("compareGitAnchors — the six cases", () => {
  it("no expectation: proceeds, and reports no match rather than a false one", () => {
    for (const none of [null, undefined, ""]) {
      expect(compareGitAnchors(none, `@${SHA}`)).toEqual({ ok: true, match: null, reason: null });
    }
  });

  it("different sha: refuses", () => {
    const r = compareGitAnchors(`@${SHA}`, `@${OTHER}`);
    expect(r.ok).toBe(false);
    expect(r.match).toBeNull();
    expect(r.reason).toContain(SHA);
    expect(r.reason).toContain(OTHER);
  });

  it("different sha refuses even when both sides are dirty", () => {
    expect(compareGitAnchors(`@${SHA}+dirty`, `@${OTHER}+dirty`).ok).toBe(false);
  });

  it("clean expectation, clean tree: proceeds as exact", () => {
    expect(compareGitAnchors(`@${SHA}`, `@${SHA}`)).toEqual({ ok: true, match: "exact", reason: null });
  });

  it("clean expectation, dirty tree: refuses", () => {
    // The caller asserted a clean tree. It is not clean, so the assertion is false.
    const r = compareGitAnchors(`@${SHA}`, `@${SHA}+dirty`);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("uncommitted");
  });

  it("dirty expectation, clean tree: proceeds as dirty-weak, NEVER exact", () => {
    expect(compareGitAnchors(`@${SHA}+dirty`, `@${SHA}`)).toEqual({ ok: true, match: "dirty-weak", reason: null });
  });

  it("dirty expectation, dirty tree: proceeds as dirty-weak, NEVER exact", () => {
    // Two dirty trees at one HEAD are not the same tree. Reporting this as `exact` would be a
    // guarantee the data cannot support; refusing it would make the parameter unusable on this
    // project's own default build path (guardrails-off, always dirty). Hence three-valued.
    const r = compareGitAnchors(`@${SHA}+dirty`, `@${SHA}+dirty`);
    expect(r.ok).toBe(true);
    expect(r.match).toBe("dirty-weak");
    expect(r.match).not.toBe("exact");
  });

  it("an undeterminable tree anchor refuses when an assertion was made", () => {
    // Failing open here would silently drop the guarantee the caller asked for.
    const r = compareGitAnchors(`@${SHA}`, null);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("could not be determined");
  });

  it("accepts anchors with or without the leading @", () => {
    // Documented in the rks_exec schema description, so the broadened contract is stated
    // rather than merely tolerated.
    expect(compareGitAnchors(SHA, `@${SHA}`).match).toBe("exact");
    expect(compareGitAnchors(`@${SHA}`, SHA).match).toBe("exact");
  });
});

describe("round trip — the format exec compares is the format the search tool emits", () => {
  // The whole point of the parameter is to carry an anchor from rks_exhaustive_search into
  // rks_exec. Asserting the comparator against hand-written strings proves only that it is
  // self-consistent; if computeGitAnchor's real output had a different shape, every test above
  // would still pass while the feature was unusable end to end.
  it("computeGitAnchor output compares equal to itself", async () => {
    const { computeGitAnchor } = await import("@routekit/rag");
    const anchor = computeGitAnchor(ROOT);
    expect(typeof anchor, "computeGitAnchor returned a non-string").toBe("string");
    expect(anchor.length).toBeGreaterThan(0);

    const verdict = compareGitAnchors(anchor, anchor);
    expect(verdict.ok).toBe(true);
    // Self-comparison must never be a refusal, and must classify — a null match here would
    // mean the parser did not recognise the real format at all.
    expect(verdict.match === "exact" || verdict.match === "dirty-weak").toBe(true);
  });

  it("a real anchor is recognised as clean or +dirty, not as an opaque string", async () => {
    const { computeGitAnchor } = await import("@routekit/rag");
    const anchor = computeGitAnchor(ROOT);
    const isDirty = anchor.endsWith("+dirty");
    // Same commit, opposite cleanliness — the verdict must differ from the self-comparison,
    // which is only true if the +dirty suffix is actually being parsed.
    const flipped = isDirty ? anchor.slice(0, -"+dirty".length) : `${anchor}+dirty`;
    const verdict = compareGitAnchors(anchor, flipped);
    if (isDirty) {
      // dirty expectation vs clean tree → proceeds, weakly.
      expect(verdict).toEqual({ ok: true, match: "dirty-weak", reason: null });
    } else {
      // clean expectation vs dirty tree → refuses.
      expect(verdict.ok).toBe(false);
    }
  });
});

describe("expectedAnchor is declared on BOTH sides of the tool contract", () => {
  const src = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/server.mjs"), "utf8");

  /**
   * Capture the execSchema body by BRACE DEPTH rather than a non-greedy regex.
   *
   * A `[\s\S]*?` capture stops at the first `});`, so any nested construct inside the schema
   * would truncate it — and the assertions below would then pass against a fragment while
   * believing they had seen the whole thing. Depth-scanning cannot go vacuous that way.
   */
  function execSchemaBody() {
    const marker = "const execSchema = z.object({";
    const start = src.indexOf(marker);
    if (start === -1) return null;
    let i = start + marker.length;
    let depth = 1;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    return src.slice(start + marker.length, i - 1);
  }

  it("is in the zod execSchema — without this it is silently stripped", () => {
    // execSchema is a bare z.object() (strip mode) feeding .parse(cleanArgs). A field missing
    // here never reaches runExecToolInner, so the whole feature would be an advertised no-op
    // AND tests/integration/mcp-schema-drift-guard.spec.mjs would redden after merge.
    const body = execSchemaBody();
    expect(body, "execSchema block not found").toBeTruthy();
    expect(body).toContain("expectedAnchor");
  });

  it("the depth-scanner captures the WHOLE schema, not a truncated fragment", () => {
    // Guards the guard: if this ever stopped seeing every field, the assertions above would
    // quietly weaken without failing.
    const body = execSchemaBody();
    for (const field of ["projectId", "label", "skipTests", "autoCommit", "dryRun", "expectedAnchor"]) {
      expect(body, `capture missed ${field}`).toContain(field);
    }
  });

  it("is in the advertised JSON Schema for rks_exec", () => {
    const idx = src.indexOf('name: "rks_exec"');
    expect(idx).toBeGreaterThan(-1);
    const end = src.indexOf('name: "rks_exec_abort"', idx);
    expect(src.slice(idx, end)).toContain("expectedAnchor");
  });
});

describe("exec wiring", () => {
  const src = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");

  it("the anchor gate runs AFTER the plan-hash gate", () => {
    // Precedence is deliberate and pinned: if the plan drifted, the premise of any tree
    // assertion is already void, so integrity_failed is the honest answer and must win.
    const hashGate = src.indexOf('status: "integrity_failed"');
    const anchorGate = src.indexOf('status: "anchor_mismatch"');
    expect(hashGate).toBeGreaterThan(-1);
    expect(anchorGate).toBeGreaterThan(-1);
    expect(anchorGate).toBeGreaterThan(hashGate);
  });

  it("the anchor gate runs BEFORE any branch is created", () => {
    // A refusal must leave the worktree untouched.
    //
    // Asserted unconditionally. An earlier version guarded this with `if (checkoutB > -1)`,
    // which meant the whole assertion silently vanished if the sentinel ever moved — a
    // vacuous pass reporting green while verifying nothing.
    const anchorGate = src.indexOf('status: "anchor_mismatch"');
    const checkoutB = src.indexOf('"checkout"');
    expect(checkoutB, 'the "checkout" sentinel disappeared — re-derive this ordering check').toBeGreaterThan(-1);
    expect(anchorGate).toBeLessThan(checkoutB);
  });

  it("anchor_mismatch is NOT added to the resumable-pause carve-outs", () => {
    // A tree that is not the asserted tree is not a resumable pause, and the carve-out set is
    // an allowlist — an unknown reason is already terminal, so adding it would be a regression.
    const m = src.match(/const EXEC_PHASE_RESET_CARVE_OUTS = new Set\(\[([\s\S]*?)\]\);/);
    expect(m, "carve-out set not found").toBeTruthy();
    expect(m[1]).not.toContain("anchor_mismatch");
  });
});
