/**
 * backlog.fix.planned-state-plan-contents-disclosure — exec dry-run preview.
 *
 * `wouldApply` built its preview from `s.content` only. search_replace steps carry their
 * payload on `s.edits`, so `preview` came back null for exactly the step type a caller runs a
 * dry run to inspect — the plan was unverifiable through the one tool whose stated purpose is
 * to show what would happen.
 *
 * These assertions drive the real exported shaper. An earlier version of this file scanned
 * exec.mjs source for the tokens `s.edits` and `s.content`; that pins spelling rather than
 * conduct, and would stay green if the mapper were rewritten to produce the wrong shape using
 * the right identifiers. It was flagged in review and replaced.
 *
 * Not covered here on purpose: the parameter-level `if (dryRun)` early-returns before the
 * guardrail-critical approval block, whose diff has the same content-only blindness on a
 * reachable path. That is a separate defect with a separate audience and is storied as
 * backlog.fix.guardrail-critical-approval-diff-blind-to-edits.
 */
import { describe, it, expect } from "vitest";
import { describeDryRunStep } from "../../packages/mcp-rks/src/server/plan-quality.mjs";

describe("describeDryRunStep — search_replace payloads are visible", () => {
  it("exposes search and replace text for a search_replace step", () => {
    const out = describeDryRunStep({
      action: "search_replace",
      path: "src/a.mjs",
      edits: [
        { search: "export function a() {", replace: "export function a(x) {" },
        { search: "const B = 1;", replace: "const B = 2;" },
      ],
    }, 0);

    expect(out.step).toBe(1);
    expect(out.action).toBe("search_replace");
    expect(out.file).toBe("src/a.mjs");
    expect(out.edits).toEqual([
      { search: "export function a() {", replace: "export function a(x) {" },
      { search: "const B = 1;", replace: "const B = 2;" },
    ]);
  });

  it("still previews content-bearing steps", () => {
    const out = describeDryRunStep({ action: "create_file", path: "src/b.mjs", content: "export const b = 1;\n" }, 1);
    expect(out.step).toBe(2);
    expect(out.preview).toBe("export const b = 1;\n");
    expect(out.edits).toBeNull();
  });

  it("returns an empty edits array — not null — for an empty edits list", () => {
    const out = describeDryRunStep({ action: "search_replace", path: "x", edits: [] }, 0);
    expect(out.edits).toEqual([]);
  });

  it("reads target when path is absent, and tolerates neither being set", () => {
    expect(describeDryRunStep({ action: "note", target: "t.md" }, 0).file).toBe("t.md");
    expect(describeDryRunStep({ action: "note" }, 0).file).toBeNull();
  });

  it("is non-throwing on a null step", () => {
    expect(describeDryRunStep(null, 0)).toMatchObject({ step: 1, file: null, preview: null, edits: null });
  });
});

describe("describeDryRunStep — truncation", () => {
  it("appends an ellipsis past the limit and not below it", () => {
    const long = "x".repeat(400);
    expect(describeDryRunStep({ content: long }, 0).preview).toBe("x".repeat(300) + "...");

    const short = "y".repeat(300);
    expect(describeDryRunStep({ content: short }, 0).preview).toBe(short);
  });

  it("measures length on the COERCED string, not the raw value", () => {
    // The original guard sliced String(s.content) but read s.content.length. For a non-string
    // those differ, so the ellipsis was decided against a measurement of the wrong thing.
    const buf = Buffer.from("z".repeat(400));
    const out = describeDryRunStep({ content: buf }, 0);
    expect(out.preview.endsWith("...")).toBe(true);
    expect(out.preview).toHaveLength(303);
  });

  it("truncates long edit payloads too", () => {
    const long = "s".repeat(400);
    const out = describeDryRunStep({ action: "search_replace", edits: [{ search: long, replace: "r" }] }, 0);
    expect(out.edits[0].search).toBe("s".repeat(300) + "...");
    expect(out.edits[0].replace).toBe("r");
  });

  it("nulls a missing edit half rather than emitting undefined", () => {
    const out = describeDryRunStep({ action: "search_replace", edits: [{ search: "a" }] }, 0);
    expect(out.edits[0]).toEqual({ search: "a", replace: null });
  });
});
