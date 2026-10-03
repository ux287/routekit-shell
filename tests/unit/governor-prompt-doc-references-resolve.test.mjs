/**
 * Witness for backlog.fix.governor-prompt-invariant-reference-dangles-in-children.
 *
 * Reported from child project ux287-bpm: every Governor run there was pointed at
 * `notes/design.evidence-bound-reporting-invariant.md`, which exists in the rks shell repo
 * and in NO child project. Four independent copiers (two JS, two shell) copy the prompts
 * verbatim, so the fix belongs in the prompt text — a change there propagates through all
 * four for free, while shipping the note would have to be implemented in four places.
 *
 * THE OFFENDER LIST IS DERIVED, NOT HARDCODED. What a child project actually receives is
 * `templates/base/notes`, so that directory is the ground truth for "does this path resolve
 * in a child?". A hardcoded list would go stale the moment a prompt gained a new reference —
 * which is precisely how this defect survived.
 *
 * Pure filesystem reads. No subprocess spawns, so the Subprocess Timeout Rule does not apply.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROMPTS_DIR = path.join(REPO_ROOT, ".rks", "prompts");
const CHILD_SEED_DIR = path.join(REPO_ROOT, "templates", "base", "notes");

const PROMPTS = [
  "governor-arch.md",
  "governor-build.md",
  "governor-po.md",
  "governor-qa.md",
  "governor-research.md",
];

/**
 * A repo-relative document reference.
 *
 * The leading character class is load-bearing: it excludes
 * `files: ['notes/<filename from step 2>.md']` in governor-research.md, which is a tool-call
 * ARGUMENT TEMPLATE naming no particular document, not a pointer a reader could follow.
 */
const DOC_REF = /notes\/[A-Za-z0-9][\w.-]*\.md/g;

/** Blank-line-delimited block containing the given index. */
function paragraphAt(text, index) {
  const before = text.lastIndexOf("\n\n", index);
  const after = text.indexOf("\n\n", index);
  return text.slice(before === -1 ? 0 : before + 2, after === -1 ? text.length : after);
}

const childSeedBasenames = new Set(fs.readdirSync(CHILD_SEED_DIR).filter((f) => f.endsWith(".md")));

function referencesIn(file) {
  const text = fs.readFileSync(path.join(PROMPTS_DIR, file), "utf8");
  const out = [];
  for (const m of text.matchAll(DOC_REF)) {
    out.push({ ref: m[0], index: m.index, paragraph: paragraphAt(text, m.index) });
  }
  return { text, refs: out };
}

describe("the child seed set is the ground truth, and the scope is not blind", () => {
  it("templates/base/notes exists and holds notes", () => {
    // POSITIVE CONTROL. Every "absent from the child" verdict below rests on this
    // directory having been read at all; an empty or missing one would make every
    // reference look dangling and every assertion vacuously demanding.
    expect(childSeedBasenames.size).toBeGreaterThan(0);
  });

  it("the shell keeps the canonical long-form note — it is not deleted or duplicated", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "notes", "design.evidence-bound-reporting-invariant.md"))).toBe(true);
    expect(fs.existsSync(path.join(CHILD_SEED_DIR, "design.evidence-bound-reporting-invariant.md"))).toBe(false);
  });

  it("finds document references at all — the regex is not silently matching nothing", () => {
    const total = PROMPTS.reduce((n, f) => n + referencesIn(f).refs.length, 0);
    expect(total).toBeGreaterThan(0);
  });
});

describe("no governor prompt points a child at a path the child does not have", () => {
  it.each(PROMPTS)("%s — every unresolvable reference is marked SHELL-ONLY", (file) => {
    const { refs } = referencesIn(file);
    const unannotated = refs
      .filter((r) => !childSeedBasenames.has(path.basename(r.ref)))
      .filter((r) => !/shell-only/i.test(r.paragraph))
      .map((r) => r.ref);
    expect(unannotated, `${file} points at paths absent from a child project without marking them shell-only`).toEqual([]);
  });

  it("an annotation does not point at a section the reader does not have", () => {
    // The first cut of this fix qualified the pointer with "stated here and in Item 10".
    // Item 10 is an ARCH CHECKLIST item — it exists only in governor-arch.md, so for four
    // of the five prompts that clause named a section the reader had no way to find. That
    // is the same defect the story exists to close, reintroduced by its own remedy.
    for (const file of PROMPTS) {
      const raw = fs.readFileSync(path.join(PROMPTS_DIR, file), "utf8");
      for (const m of raw.matchAll(/Item (\d+)/g)) {
        const paragraph = paragraphAt(raw, m.index);
        const selfContained = new RegExp(`\\*\\*Item ${m[1]}`).test(raw);
        const qualified = /governor-\w+\.md/.test(paragraph);
        expect(
          selfContained || qualified,
          `${file} refers to "${m[0]}" without defining it or naming the prompt that does`,
        ).toBe(true);
      }
    }
  });

  it("the tool-call argument template is NOT treated as a document reference", () => {
    // governor-research.md carries `files: ['notes/<filename from step 2>.md']`. It names no
    // document, so demanding an annotation on it would be a false positive.
    const raw = fs.readFileSync(path.join(PROMPTS_DIR, "governor-research.md"), "utf8");
    expect(raw).toContain("notes/<filename from step 2>.md");
    expect([...raw.matchAll(DOC_REF)].map((m) => m[0])).not.toContain("notes/<filename from step 2>.md");
  });
});

describe("the ARCH evidence-bound instruction is executable from the prompt alone", () => {
  const arch = fs.readFileSync(path.join(PROMPTS_DIR, "governor-arch.md"), "utf8");

  // Word-boundary, not `(R5)`: three of the nine are cited as a group — `(R4, R5, R6)` —
  // because they share one diff-level smell. Pinning the parenthesised singular form would
  // fail on the grouped ones and say nothing about whether the reader can name them.
  it.each(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"])(
    "names %s, so a child ARCH Governor can cite it without the long-form note",
    (rule) => {
      expect(arch).toMatch(new RegExp(`\\b${rule}\\b`));
    },
  );

  it("no longer tells the reader to take the rule number FROM the undistributed note", () => {
    expect(arch).not.toMatch(/naming the rule number from `notes\/design\.evidence-bound-reporting-invariant\.md`/);
  });
});

describe("the fix reaches a child with no change to any copier", () => {
  // Four independent copiers copy .rks/prompts verbatim. If any of them had to learn about
  // this note — to ship it, or to rewrite the path — the fix would have four homes and four
  // places to rot. None of them names it, and that is the property being preserved.
  it.each([
    "packages/cli/src/project/bootstrap.mjs",
    "packages/cli/src/project/sync.mjs",
    "scripts/vendor-rks.sh",
    "scripts/vendor-skills.sh",
  ])("%s does not special-case the invariant note", (rel) => {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    expect(src).not.toContain("evidence-bound-reporting-invariant");
    expect(src).not.toContain("story-sizing-contract");
  });
});
