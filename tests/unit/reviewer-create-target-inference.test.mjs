/**
 * Witness for backlog.fix.reviewer-create-target-search-block-uninferrable.
 *
 * Four defects, one function family. Field-reported by routekit-traders, where a story spent
 * eight build attempts on `1 of 16 explicit edits failed validation — 1 missing_file`.
 *
 * D4 — plan-ready.mjs DOCUMENTED `### Target: <path>` while reviewer.mjs REJECTED it. The
 *      label is stripped inside atAtRegex's adjacent-LINE arm, but its heading arm captures
 *      raw, so identical text bound or failed depending only on the `###` marker.
 * D1 — attribution requires EXACTLY one content match; two or more failed identically to
 *      zero, and a create target can never match at all (it does not exist yet).
 * D2 — the emitted issue named neither the block nor its text, so the only way to find the
 *      offending block was to delete one and see if the count dropped.
 *
 * CLASSIFICATION IS SOURCED FROM OBSERVATION, NOT INTENT: every case tagged RED below was
 * evaluated against HEAD and found false there. Cases tagged CONTROL pass both before and
 * after, and say so.
 *
 * Pure filesystem + module import. No subprocess spawns.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  resolveTargetPath,
  extractExplicitEdits,
  validateExplicitEdits,
  describeEditFailures,
} from "../../packages/mcp-rks/src/llm/reviewer.mjs";

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-create-target-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (rel, content) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return rel;
};

describe("D4 — the Target:/File: label no longer decides whether a heading binds", () => {
  it("RED: resolveTargetPath accepts a Target:-labelled declared path", () => {
    // Defect-present value: null. looksLikePath rejected on the space inside the label.
    expect(resolveTargetPath("Target: lib/real.mjs", null, ["lib/real.mjs"]))
      .toBe("lib/real.mjs");
  });

  it("RED: the File: label resolves to the same VALUE, not merely to agreement", () => {
    // Asserts the value the fixed code produces. An equality between two calls of the same
    // broken function is not a discriminator — both returned null before the fix.
    expect(resolveTargetPath("File: lib/real.mjs", null, ["lib/real.mjs"]))
      .toBe("lib/real.mjs");
  });

  it("CONTROL, green before and after: a bare declared path still resolves", () => {
    expect(resolveTargetPath("lib/real.mjs", null, ["lib/real.mjs"])).toBe("lib/real.mjs");
  });

  it("CONTROL / HOLE-GUARD, green before and after: tolerance must NOT widen acceptance", () => {
    // DO NOT MISREAD THIS ONE. Finding it green CONFIRMS the guard holds. Do not attempt to
    // make it red: that means making resolveTargetPath accept prose, which is the exact hole
    // this guards, and it would flip the PROSE_HEADING guard in
    // reviewer-search-target-attribution.test.mjs from null to a value.
    //
    // Stripping only the LEADING label is what keeps this null — the remainder still carries
    // spaces and still fails looksLikePath.
    expect(resolveTargetPath("Target: 2. Wire the ledger row", null, ["2. Wire the ledger row"]))
      .toBeNull();
    expect(resolveTargetPath("2. Wire the ledger row", null, ["2. Wire the ledger row"]))
      .toBeNull();
  });

  it("CONTROL, green before and after: a labelled path that is neither declared nor on disk stays null", () => {
    expect(resolveTargetPath("Target: nowhere/absent.mjs", root, [])).toBeNull();
  });

  it("RED: a ### Target: heading binds a block end-to-end through extraction", () => {
    // The downstream repro, minimised. Defect-present: edit.file is null, because the heading
    // arm handed the labelled text to resolveTargetPath and got null back.
    const target = write("lib/a.mjs", "const x = 1;\n");
    const body = [
      "## Target Files",
      "",
      `### Target: ${target}`,
      "",
      "@@SEARCH",
      "const x = 1;",
      "@@REPLACE",
      "const x = 2;",
      "@@END",
      "",
    ].join("\n");
    const edits = extractExplicitEdits(body, root, [target]);
    expect(edits).toHaveLength(1);
    expect(edits[0].file).toBe(target);
  });
});

describe("D1 — attribution requires exactly one target, and says which case failed", () => {
  const twoFilesSharingText = () => {
    const a = write("src/one.mjs", "client = Thing(sandbox=False)\n// unique-to-one\n");
    const b = write("src/two.mjs", "client = Thing(sandbox=False)\n// unique-to-two\n");
    return [a, b];
  };

  const blockFor = (search) =>
    ["@@SEARCH", search, "@@REPLACE", "replaced", "@@END", ""].join("\n");

  it("RED: two or more content matches is reported as ambiguity, not as no-candidate", () => {
    // Defect-present: type "missing_file" with the same message as the zero-match case, and
    // no indication that the pattern in fact matched several files. That conflation is why
    // eight attempts hunted a non-existent missing file.
    const files = twoFilesSharingText();
    const v = validateExplicitEdits(
      [{ description: "d", search: "client = Thing(sandbox=False)", replace: "x" }],
      root,
      files,
    );
    expect(v.valid).toBe(false);
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0].type).toBe("target_ambiguous");
    expect(v.issues[0].candidates).toEqual(files);
  });

  it("RED: zero matches and two-plus matches are DISTINGUISHABLE", () => {
    // Defect-present: both emitted type "missing_file" with a byte-identical message, so the
    // author could not tell "supply a heading" from "disambiguate a shared pattern".
    const files = twoFilesSharingText();
    const ambiguous = validateExplicitEdits(
      [{ description: "d", search: "client = Thing(sandbox=False)", replace: "x" }], root, files);
    const absent = validateExplicitEdits(
      [{ description: "d", search: "text that appears nowhere at all", replace: "x" }], root, files);

    expect(ambiguous.issues[0].type).not.toBe(absent.issues[0].type);
    expect(ambiguous.issues[0].message).not.toBe(absent.issues[0].message);
  });

  it("CONTROL, green before and after: a single content match still binds", () => {
    const files = twoFilesSharingText();
    const v = validateExplicitEdits(
      [{ description: "d", search: "// unique-to-two", replace: "x" }], root, files);
    expect(v.valid).toBe(true);
  });

  it("RED: a create target is named as a candidate a heading can bind", () => {
    // A declared-but-absent path cannot be reached by content inference — it has no content.
    // The heading route must reach it, which is what makes the documented remedy work at all.
    const v = resolveTargetPath("Target: src/brand-new.mjs", root, ["src/brand-new.mjs"]);
    expect(v).toBe("src/brand-new.mjs");
    expect(fs.existsSync(path.join(root, "src/brand-new.mjs"))).toBe(false);
  });
});

describe("D2 — an unbindable block is locatable from the output alone", () => {
  const nBlocks = (n, distinct = true) =>
    Array.from({ length: n }, (_, i) => ({
      description: "Edit (@@SEARCH block)",
      search: distinct ? `unfindable marker number ${i}` : "identical unfindable marker",
      replace: "x",
    }));

  it("RED: the locator identifies EXACTLY ONE of N blocks, and it is the seeded failure", () => {
    // Defect-present: the issue carried only { type, edit, message } with edit ===
    // "Edit (@@SEARCH block)" for every block, so nothing distinguished one of N.
    // TWO files, deliberately. With a single declared target, attribution short-circuits on
    // `targetFiles.length === 1` and every block binds to it regardless of its SEARCH text —
    // so a one-file fixture can never reach the unbindable branch this suite exists to test.
    const files = [write("src/one.mjs", "unrelated\n"), write("src/two.mjs", "also unrelated\n")];
    const edits = nBlocks(4);
    edits[2].search = "unfindable marker number 2";
    const v = validateExplicitEdits(edits, root, files);

    const issue = v.issues.find((i) => i.blockIndex === 2);
    expect(issue, "no issue carried blockIndex 2").toBeTruthy();
    const matching = edits.filter((e) => e.search.includes(issue.searchFragment));
    expect(matching).toHaveLength(1);
    expect(matching[0]).toBe(edits[2]);
  });

  it("RED: the locator survives blocks whose descriptions are identical", () => {
    // Forces the locator off edit.description, which extraction sets to the same constant
    // for every @@SEARCH block.
    // TWO files, deliberately. With a single declared target, attribution short-circuits on
    // `targetFiles.length === 1` and every block binds to it regardless of its SEARCH text —
    // so a one-file fixture can never reach the unbindable branch this suite exists to test.
    const files = [write("src/one.mjs", "unrelated\n"), write("src/two.mjs", "also unrelated\n")];
    const v = validateExplicitEdits(nBlocks(3), root, files);
    const descs = new Set(v.issues.map((i) => i.edit));
    expect(descs.size).toBe(1);
    expect(new Set(v.issues.map((i) => i.searchFragment)).size).toBe(3);
  });

  it("RED: identical SEARCH text is still distinguishable, via the block index", () => {
    // The converse: a fragment alone cannot separate two blocks searching for the same text.
    // Neither field alone covers both this case and the identical-description case.
    // TWO files, deliberately. With a single declared target, attribution short-circuits on
    // `targetFiles.length === 1` and every block binds to it regardless of its SEARCH text —
    // so a one-file fixture can never reach the unbindable branch this suite exists to test.
    const files = [write("src/one.mjs", "unrelated\n"), write("src/two.mjs", "also unrelated\n")];
    const v = validateExplicitEdits(nBlocks(3, false), root, files);
    expect(new Set(v.issues.map((i) => i.searchFragment)).size).toBe(1);
    expect(new Set(v.issues.map((i) => i.blockIndex)).size).toBe(3);
  });

  it("CONTROL, green before and after: no path is invented for a block that resolved to none", () => {
    // RELABELLED. I first tagged this RED; the RED proof measured it passing against HEAD,
    // because the pre-fix issue object carried no `file` key either. It is a REGRESSION PIN,
    // not a witness: it stops a future locator from filling `file` with a guess, which would
    // be a fabricated status — the absence of a path IS the failure being reported.
    //
    // Recorded rather than quietly corrected, because it is the same defect this story's
    // review cycle caught twice: a label sourced from the requirement's INTENT rather than
    // from an observation of HEAD.
    // TWO files, deliberately. With a single declared target, attribution short-circuits on
    // `targetFiles.length === 1` and every block binds to it regardless of its SEARCH text —
    // so a one-file fixture can never reach the unbindable branch this suite exists to test.
    const files = [write("src/one.mjs", "unrelated\n"), write("src/two.mjs", "also unrelated\n")];
    const v = validateExplicitEdits(nBlocks(1), root, files);
    expect(v.issues[0].file).toBeUndefined();
  });

  it("RED: the summary names the cause instead of echoing the raw type", () => {
    // Defect-present: FAILURE_CAUSE_LABELS had no missing_file key, so the fallback printed
    // the type name back at the operator — "1 missing_file".
    const line = describeEditFailures([{ type: "missing_file" }], 1, 16);
    expect(line).toContain("1 of 16");
    expect(line).not.toContain("1 missing_file");
    expect(line).toMatch(/attributed/i);
  });
});
