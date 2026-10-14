/**
 * Witness for backlog.fix.refine-noop-escalation-false-positive — MECHANISM C.
 *
 * THE BUG: the detector and the applier disagreed about what "duplicate frontmatter" means.
 *
 *   - Detector: `storyContent.match(/^---\s*$/gm)` with `length > 2`. It counted EVERY line that is
 *     exactly `---`. A markdown horizontal rule in the body, or a `---` inside a fenced code block
 *     (routine in story notes that embed YAML frontmatter examples), was a third delimiter. It
 *     raised `critical`.
 *   - Applier: required PAIRED, YAML-parseable blocks, and otherwise reported "no duplicate blocks
 *     found" — writing nothing.
 *
 * Critical in, nothing to do out. `applied` stayed empty, which mapped to `refine_apply.noop`, and
 * on the old first-no-op-escalates rule that terminated the run. A markdown horizontal rule could
 * kill a build.
 *
 * The fix is a SHARED HELPER, not two literals that happen to agree — two independent
 * implementations agreeing today is precisely how they drifted apart in the first place.
 */
import { describe, it, expect } from "vitest";
import { extractFrontmatterBlocks } from "../../packages/mcp-rks/src/server/refine.mjs";

const REAL_FM = `---
id: "backlog.feat.thing"
phase: "ready"
---

## Problem

Build the thing.
`;

describe("extractFrontmatterBlocks counts paired, parseable blocks only", () => {
  it("a normal single-frontmatter note has exactly one block", () => {
    expect(extractFrontmatterBlocks(REAL_FM).blocks.length).toBe(1);
  });

  it("a body horizontal rule does NOT create a second block", () => {
    // The exact false positive. Three `---` lines, one real frontmatter.
    const withRule = `---
id: "backlog.feat.thing"
---

## Problem

Some prose.

---

More prose after a horizontal rule.
`;
    // POSITIVE CONTROL: the old detector's condition really would have fired here.
    expect(withRule.match(/^---\s*$/gm).length).toBeGreaterThan(2);

    expect(extractFrontmatterBlocks(withRule).blocks.length).toBe(1);
  });

  it("a fenced YAML example does NOT create a second block", () => {
    // Routine in this repo's own story notes, which document frontmatter shapes inline.
    const withFence = `---
id: "backlog.feat.thing"
---

## Problem

Stories look like this:

\`\`\`yaml
---
id: "example"
phase: "draft"
---
\`\`\`

That is documentation, not a second frontmatter block.
`;
    expect(withFence.match(/^---\s*$/gm).length).toBeGreaterThan(2);
    expect(extractFrontmatterBlocks(withFence).blocks.length).toBe(1);
  });

  it("GENUINE duplicate frontmatter is STILL detected — the detector is corrected, not disabled", () => {
    // The over-correction guard. Silencing the check entirely would trade a false positive for a
    // false negative and leave real corruption unrepaired.
    const genuinelyDuplicated = `---
id: "backlog.feat.thing"
phase: "draft"
---
---
id: "backlog.feat.thing"
phase: "ready"
---

## Problem

Two real frontmatter blocks.
`;
    expect(extractFrontmatterBlocks(genuinelyDuplicated).blocks.length).toBeGreaterThan(1);
  });

  it("unparseable pseudo-blocks are skipped, not counted", () => {
    const withGarbage = `---
id: "backlog.feat.thing"
---

## Problem

---
this is not: [valid: yaml: at all
---
`;
    // Whatever this parses to, it must not be reported as duplicated frontmatter.
    expect(extractFrontmatterBlocks(withGarbage).blocks.length).toBe(1);
  });

  it("tolerates empty and nullish input without throwing", () => {
    expect(extractFrontmatterBlocks("").blocks).toEqual([]);
    expect(extractFrontmatterBlocks(undefined).blocks).toEqual([]);
    expect(extractFrontmatterBlocks(null).blocks).toEqual([]);
  });
});

describe("detector and applier cannot disagree", () => {
  it("both sides consume the same helper", async () => {
    // Structural pin: the analyze-side detector must not re-implement the test. If someone
    // reintroduces a bare-delimiter count, this fails.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../packages/mcp-rks/src/server/refine.mjs"),
      "utf8",
    );

    // The old detector literal must be gone from the analyze path.
    expect(src).not.toContain("const fmDelimiters = storyContent.match(/^---\\s*$/gm);");
    // And both call sites go through the helper.
    const helperCalls = src.match(/extractFrontmatterBlocks\(/g) || [];
    // definition + detector + applier
    expect(helperCalls.length).toBeGreaterThanOrEqual(3);
  });
});
