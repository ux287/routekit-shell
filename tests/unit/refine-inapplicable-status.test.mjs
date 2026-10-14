/**
 * Witness for backlog.fix.refine-inapplicable-status.
 *
 * `refine_noop` means "the story was applied against and came out byte-identical" —
 * the story itself is the problem. It was ALSO being returned when every refinement
 * handed in could never have been applied at all: an absent payload field, an
 * unusable file, a failed read or write, a prune that removed the injection before
 * the write. Those say nothing about the story, and they have a different remedy.
 *
 * A child project reported the consequence: a Governor obeying the Build prompt's
 * refine_noop STOP rule terminated a healthy run on a suggestion that was never
 * actionable.
 *
 * The status is computed from the applied LEDGER — a marker stamped at the site
 * that made the observation — and NEVER from the refinement's `type`. A type says
 * what was asked for; only the ledger says what was observed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { makeTempDir, writeFile, ensureDir } from "../helpers/tmp.mjs";
import { runRefineApplyTool } from "../../packages/mcp-rks/src/server/refine.mjs";

const PROBLEM = "backlog.feat.thing";
let projectRoot;

function writeStory(extraBody = "") {
  writeFile(
    path.join(projectRoot, "notes", `${PROBLEM}.md`),
    `---\nid: "${PROBLEM}"\nphase: "arch-approved"\ntargetFiles:\n  - path: "src/beta.mjs"\n    op: "edit"\n---\n\n## Problem\n\nBuild beta.\n${extraBody}`,
  );
}

beforeEach(() => {
  projectRoot = makeTempDir("refine_inapplicable");
  ensureDir(path.join(projectRoot, "notes"));
  ensureDir(path.join(projectRoot, "src"));
  writeFile(path.join(projectRoot, "src/beta.mjs"), "export const beta = 1;\n");
  writeStory();
});

const apply = (refinements) =>
  runRefineApplyTool({ projectRoot, problemId: PROBLEM, projectId: "p", refinements });

describe("the marker is stamped at the site that observed the problem", () => {
  it.each([
    ["absent payload, generic arm 3", { type: "add_code_snippet" }, "absent_payload"],
    ["unrecognized type, generic arm 1", { type: "not_a_real_type" }, "unrecognized_type"],
    ["add_search_pattern with no file", { type: "add_search_pattern" }, "absent_payload"],
    ["fix_numeric_assertion missing fields", { type: "fix_numeric_assertion" }, "absent_payload"],
    ["fix_test_assertion with no file", { type: "fix_test_assertion" }, "absent_payload"],
    ["disk_fetch_context with no file", { type: "disk_fetch_context" }, "absent_payload"],
  ])("%s stamps cause %s", async (_label, refinement, cause) => {
    const res = await apply([refinement]);
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0].inapplicable).toBe(true);
    expect(res.applied[0].cause).toBe(cause);
  });

  it("a named file that is not on disk stamps unusable_payload, not absent_payload", async () => {
    const res = await apply([
      { type: "fix_numeric_assertion", data: { file: "src/nope.mjs", expected: 1, received: 2 } },
    ]);
    expect(res.applied[0].cause).toBe("unusable_payload");
  });

  it("a failed disk read stamps io_error and the reason carries the underlying message", async () => {
    // A directory is readable as a path but not as a file — a real I/O failure
    // rather than a synthesised one.
    ensureDir(path.join(projectRoot, "src/adir"));
    const res = await apply([{ type: "disk_fetch_context", data: { file: "src/adir" } }]);
    expect(res.applied[0].inapplicable).toBe(true);
    expect(res.applied[0].cause).toBe("io_error");
    expect(String(res.applied[0].result)).toMatch(/failed to read/);
    expect(String(res.applied[0].result).length).toBeGreaterThan("failed to read src/adir: ".length);
  });
});

describe("the sites ruled OUT do not stamp", () => {
  // Generic ternary arm 2. `namesAFile` observes only that a field was PRESENT,
  // never that the file was unusable — so a handler that ran against real state and
  // correctly wrote nothing must not be labelled inapplicable.
  it("arm 2 — a payload naming a file does NOT stamp", async () => {
    const res = await apply([{ type: "add_target_files", data: { files: [] } }]);
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0].inapplicable).toBeUndefined();
    expect(res.status).toBe("refine_noop");
  });

  it("an assertion pattern absent from a file that DOES exist does NOT stamp", async () => {
    writeFile(path.join(projectRoot, "src/t.test.mjs"), "expect(1).toBe(1);\n");
    const res = await apply([
      { type: "fix_numeric_assertion", data: { file: "src/t.test.mjs", expected: 99, received: 5 } },
    ]);
    expect(res.applied[0].result).toMatch(/assertion pattern/);
    expect(res.applied[0].inapplicable).toBeUndefined();
    expect(res.status).toBe("refine_noop");
  });

  it("a fix note already present does NOT stamp — the handler ran and dedup'd", async () => {
    writeStory("\n\n### Test Fix Required: src/t.test.mjs\n\nalready here\n");
    const res = await apply([
      { type: "fix_test_assertion", data: { file: "src/t.test.mjs" } },
    ]);
    expect(res.applied[0].result).toMatch(/already present/);
    expect(res.applied[0].inapplicable).toBeUndefined();
    expect(res.status).toBe("refine_noop");
  });
});

describe("the status is computed from the ledger, never from the type", () => {
  it("returns refine_inapplicable when EVERY entry carries the marker", async () => {
    const res = await apply([
      { type: "add_code_snippet" },
      { type: "add_search_pattern" },
      { type: "not_a_real_type" },
    ]);
    expect(res.applied).toHaveLength(3);
    expect(res.applied.every((a) => a.inapplicable === true)).toBe(true);
    expect(res.status).toBe("refine_inapplicable");
  });

  // The discriminator. A mixed call contains something that ran and declined on its
  // merits, so the run DID learn something about the story.
  it("returns refine_noop for a MIXED call — same types, one unmarked entry", async () => {
    writeFile(path.join(projectRoot, "src/t.test.mjs"), "expect(1).toBe(1);\n");
    const res = await apply([
      { type: "add_code_snippet" },
      { type: "fix_numeric_assertion", data: { file: "src/t.test.mjs", expected: 99, received: 5 } },
    ]);
    expect(res.applied).toHaveLength(2);
    expect(res.applied.some((a) => a.inapplicable === true)).toBe(true);
    expect(res.applied.some((a) => a.inapplicable === undefined)).toBe(true);
    expect(res.status).toBe("refine_noop");
  });

  // Same TYPE, opposite outcome — proving the decision cannot be keyed on type.
  it("one add_code_snippet stamps and another does not, decided by observation", async () => {
    const marked = await apply([{ type: "add_code_snippet" }]);
    expect(marked.status).toBe("refine_inapplicable");

    const unmarked = await apply([{ type: "add_code_snippet", data: { files: [] } }]);
    expect(unmarked.applied[0].inapplicable).toBeUndefined();
    expect(unmarked.status).toBe("refine_noop");
  });

  it("a refinement leaving NO ledger entry does not on its own produce the status", async () => {
    // create_file_directive with no filePath pushes nothing at all. An empty ledger
    // is not "every entry is marked" — it is no evidence either way.
    const res = await apply([{ type: "create_file_directive" }]);
    const ownEntries = res.applied.filter((a) => a.type === "create_file_directive");
    expect(ownEntries).toHaveLength(0);
    expect(res.status).not.toBe("refine_inapplicable");
  });
});

describe("the response envelope is reproduced in full", () => {
  it("carries the same applied[], a populated escalation.skipped, and a truthy result on each", async () => {
    const res = await apply([
      { type: "add_code_snippet" },
      { type: "add_target_files" },
      { type: "add_search_pattern" },
    ]);

    expect(res.status).toBe("refine_inapplicable");
    expect(res.ok).toBe(false);
    expect(res.problemId).toBe(PROBLEM);
    expect(res.applied).toHaveLength(3);
    expect(res.historyAppended).toBe(false);
    expect(res.escalation.kind).toBe("refine_inapplicable");
    expect(res.escalation.skipped.length).toBeGreaterThan(0);
    expect(res.escalation.nextTool).toBe("rks_refine_apply");
    expect(res.escalation.guidance).toBeTruthy();
    for (const entry of res.escalation.skipped) {
      expect(entry.result, `every skip must state a cause: ${JSON.stringify(entry)}`).toBeTruthy();
    }
  });

  it("names the cause AND a concrete remedy in reason", async () => {
    const res = await apply([{ type: "add_code_snippet" }]);
    expect(res.reason).toMatch(/absent_payload/);
    expect(res.reason).toMatch(/apply again|proceed with the run/i);
    // It must NOT claim the story is stuck — that is the other status's message.
    expect(res.reason).not.toMatch(/byte-identical/);
  });

  it("does not return requiredNext — re-planning is not prescribed by this result", async () => {
    const res = await apply([{ type: "add_code_snippet" }]);
    expect(res.requiredNext).toBeUndefined();
  });
});

describe("a genuine no-op is unaffected", () => {
  it("still returns refine_noop with its own reason and guidance", async () => {
    const res = await apply([{ type: "add_target_files", data: { files: [] } }]);
    expect(res.status).toBe("refine_noop");
    expect(res.escalation.kind).toBe("refine_noop");
    expect(res.reason).toMatch(/byte-identical/);
    expect(res.escalation.guidance).toMatch(/second consecutive no-op/);
  });
});
