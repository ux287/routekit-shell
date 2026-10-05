/**
 * backlog.fix.refine-apply-merges-frontmatter-fence-into-first-heading (P0)
 *
 * joinNoteFrontmatter wrote the closing fence with no newline after it, relying on the body to
 * start with one, while refine's body-appending handlers do `body = body.trim() + …`. Any apply
 * that reached one of those sites wrote `---## Problem`. These witnesses drive the real
 * runRefineApplyTool against on-disk notes and assert the fence survives, plus the pre-write
 * integrity refusal at both write sites (apply, and decompose all-or-nothing).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import matter from "gray-matter";
import { makeTempDir, ensureDir, writeFile } from "../helpers/tmp.mjs";
import { runRefineApplyTool } from "../../packages/mcp-rks/src/server/refine.mjs";
import {
  splitNoteFrontmatter,
  joinNoteFrontmatter,
  spliceNoteFrontmatterWithBody,
  checkNoteFenceIntegrity,
} from "../../packages/mcp-rks/src/shared/frontmatter.mjs";

const FRONTMATTER = [
  "id: fence-story",
  'title: "Fence story"',
  "status: not-implemented",
  "phase: ready",
  "targetFiles:",
  '  - path: "packages/app/src/server/thing.mjs"',
  '    op: "edit"',
  '  - path: "tests/unit/thing-new.test.mjs"',
  '    op: "create"',
].join("\n");
const KEYS = ["id", "title", "status", "phase", "targetFiles"];

// Body shapes after the closing fence. Every one of them merged on HEAD once a body.trim() site
// ran — neither the heading level nor the blank line is the trigger.
const SHAPES = {
  blankThenH2: "\n\n## Problem\n\nA file needs changes.\n",
  noBlankH2: "\n## Problem\n\nA file needs changes.\n",
  blankThenH1: "\n\n# Title\n\n## Problem\n\nA file needs changes.\n",
  twoBlanksH2: "\n\n\n## Problem\n\nA file needs changes.\n",
};

const EXEMPLAR = `import { describe, it, expect } from "vitest";

describe("thing", () => {
  it("works", () => {
    const result = { ok: true };
    expect(result.ok).toBe(true);
  });
});
`;

function assertFenceIntact(written, keys = KEYS) {
  const lines = written.split("\n");
  expect(lines.some((l) => /^---[^-\s]/.test(l))).toBe(false);
  expect(lines[0]).toBe("---");
  expect(lines.indexOf("---", 1)).toBeGreaterThan(0);
  const parsed = matter(written);
  for (const k of keys) expect(parsed.data).toHaveProperty(k);
}

function setupProject(name, { withExemplar = true } = {}) {
  const root = makeTempDir(name);
  ensureDir(path.join(root, "notes"));
  ensureDir(path.join(root, "tests", "unit"));
  ensureDir(path.join(root, "packages", "app", "src", "server"));
  writeFile(path.join(root, "packages", "app", "src", "server", "thing.mjs"), "export const thing = 1;\n");
  if (withExemplar) writeFile(path.join(root, "tests", "unit", "thing.test.mjs"), EXEMPLAR);
  return root;
}

function writeNote(root, body, id = "fence-story") {
  const p = path.join(root, "notes", `${id}.md`);
  fs.writeFileSync(p, "---\n" + FRONTMATTER.replace("fence-story", id) + "\n---" + body, "utf8");
  return p;
}

const EXEMPLAR_REFINEMENT = { type: "add_test_exemplar", editTargetDirs: ["packages/app/src/server"] };

describe("joinNoteFrontmatter fence/body boundary", () => {
  it("never writes the closing fence and a heading on one line", () => {
    expect(joinNoteFrontmatter("id: x", "## Problem\n")).toBe("---\nid: x\n---\n## Problem\n");
  });

  it("keeps a newline-leading body byte-identical and adds nothing to an empty body", () => {
    expect(joinNoteFrontmatter("id: x", "\nbody\n")).toBe("---\nid: x\n---\nbody\n");
    expect(joinNoteFrontmatter("id: x", "")).toBe("---\nid: x\n---");
  });

  it("join(split(x)) === x for well-formed notes", () => {
    for (const body of Object.values(SHAPES)) {
      const raw = "---\n" + FRONTMATTER + "\n---" + body;
      const { frontmatter, body: b } = splitNoteFrontmatter(raw);
      expect(joinNoteFrontmatter(frontmatter, b)).toBe(raw);
    }
  });
});

describe("checkNoteFenceIntegrity", () => {
  it("accepts an intact note, an empty frontmatter, and no frontmatter at all", () => {
    expect(checkNoteFenceIntegrity("---\nid: x\n---\n## P\n", "id: x")).toEqual({ ok: true });
    expect(checkNoteFenceIntegrity("---\n\n---\nbody\n", "")).toEqual({ ok: true });
    expect(checkNoteFenceIntegrity("just a body\n", null)).toEqual({ ok: true });
  });

  it("refuses a merged fence and a frontmatter that does not round-trip", () => {
    expect(checkNoteFenceIntegrity("---\nid: x\n---## P\n", "id: x")).toEqual({ ok: false, reason: "fence_not_on_own_line" });
    expect(checkNoteFenceIntegrity("---\nid: y\n---\n## P\n", "id: x")).toEqual({ ok: false, reason: "frontmatter_mismatch" });
    expect(checkNoteFenceIntegrity("## P\n", "id: x")).toEqual({ ok: false, reason: "no_frontmatter_block" });
  });
});

describe("runRefineApplyTool keeps the closing fence on its own line", () => {
  let root;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  for (const [name, body] of Object.entries(SHAPES)) {
    it(`add_test_exemplar, under the cap, shape ${name}`, async () => {
      root = setupProject(`fence-${name}`);
      const notePath = writeNote(root, body);
      const result = await runRefineApplyTool({ projectRoot: root, problemId: "fence-story", refinements: [EXEMPLAR_REFINEMENT] });
      expect(result.ok).toBe(true);
      expect(result.noteSizeOverflow).toBeUndefined();
      const written = fs.readFileSync(notePath, "utf8");
      expect(written).toContain("### Test Exemplar:");
      assertFenceIntact(written);
    });
  }

  it("add_test_exemplar over the cap (prune path) keeps the fence and the @@SEARCH anchors", async () => {
    root = setupProject("fence-overcap");
    const anchor = "\n\n### packages/app/src/server/thing.mjs\n@@SEARCH\nexport const thing = 1;\n@@REPLACE\nexport const thing = 2;\n@@END\n";
    const padding = "\n\n## Notes\n\n" + "Prose that pushes the body past the size cap. ".repeat(220) + "\n";
    const notePath = writeNote(root, SHAPES.blankThenH2 + anchor + padding);
    expect(splitNoteFrontmatter(fs.readFileSync(notePath, "utf8")).body.length).toBeGreaterThan(8192);
    const result = await runRefineApplyTool({ projectRoot: root, problemId: "fence-story", refinements: [EXEMPLAR_REFINEMENT] });
    expect(result.ok).toBe(true);
    expect(result.noteSizeOverflow).toBeDefined(); // the cap branch ran
    const written = fs.readFileSync(notePath, "utf8");
    assertFenceIntact(written);
    expect(written).toContain("@@SEARCH");
  });

  it("add_test_exemplar framework fallback (no test files in the project) keeps the fence", async () => {
    root = setupProject("fence-fallback", { withExemplar: false });
    writeFile(path.join(root, "package.json"), JSON.stringify({ devDependencies: { vitest: "^2.0.0" } }));
    const notePath = writeNote(root, SHAPES.blankThenH2);
    const result = await runRefineApplyTool({ projectRoot: root, problemId: "fence-story", refinements: [EXEMPLAR_REFINEMENT] });
    expect(result.ok).toBe(true);
    assertFenceIntact(fs.readFileSync(notePath, "utf8"));
  });

  it("disk_fetch_context plus add_test_exemplar keeps the fence", async () => {
    root = setupProject("fence-combined");
    const notePath = writeNote(root, SHAPES.blankThenH2);
    const result = await runRefineApplyTool({
      projectRoot: root,
      problemId: "fence-story",
      refinements: [{ type: "disk_fetch_context", data: { file: "packages/app/src/server/thing.mjs" } }, EXEMPLAR_REFINEMENT],
    });
    expect(result.ok).toBe(true);
    assertFenceIntact(fs.readFileSync(notePath, "utf8"));
  });

  it("a frontmatter-only refinement whose only body change is the Refinement History append keeps the fence", async () => {
    root = setupProject("fence-history");
    const notePath = writeNote(root, SHAPES.blankThenH2);
    const result = await runRefineApplyTool({ projectRoot: root, problemId: "fence-story", refinements: [{ type: "acknowledge_multi_file" }] });
    expect(result.ok).toBe(true);
    const written = fs.readFileSync(notePath, "utf8");
    expect(written).toContain("## Refinement History");
    assertFenceIntact(written, [...KEYS, "multiFileAcknowledged"]);
  });

  it("NON-REPRODUCING control: disk_fetch_context alone leaves the body byte-identical", async () => {
    root = setupProject("fence-diskonly");
    const notePath = writeNote(root, SHAPES.blankThenH2);
    const before = splitNoteFrontmatter(fs.readFileSync(notePath, "utf8")).body;
    const result = await runRefineApplyTool({
      projectRoot: root,
      problemId: "fence-story",
      refinements: [{ type: "disk_fetch_context", data: { file: "packages/app/src/server/thing.mjs" } }],
    });
    expect(result.ok).toBe(true);
    const written = fs.readFileSync(notePath, "utf8");
    expect(splitNoteFrontmatter(written).body).toBe(before);
    assertFenceIntact(written);
  });

  it("decompose success path writes a parent and children with intact fences", async () => {
    root = setupProject("fence-decompose");
    const acs = Array.from({ length: 6 }, (_, i) => `- [ ] Criterion ${i + 1}`).join("\n");
    const notePath = writeNote(root, "\n\n## Problem\n\nBig.\n\n## Acceptance Criteria\n" + acs + "\n");
    const result = await runRefineApplyTool({ projectRoot: root, problemId: "fence-story", refinements: [{ type: "decompose" }] });
    expect(result.ok).toBe(true);
    expect(result.decomposed).toBe(true);
    const parent = fs.readFileSync(notePath, "utf8");
    assertFenceIntact(parent, ["id", "childStories"]);
    const childIds = matter(parent).data.childStories;
    expect(childIds.length).toBe(result.children.length);
    for (const id of childIds) {
      assertFenceIntact(fs.readFileSync(path.join(root, "notes", `${id}.md`), "utf8"), ["id", "parent"]);
    }
  });
});

describe("spliceNoteFrontmatterWithBody (characterization)", () => {
  it("repairs a merged fence, so a clean post-ship note is not evidence refine did not merge", () => {
    expect(spliceNoteFrontmatterWithBody("---\nid: x\n---## Problem\n", {}, "## Problem\n")).toBe(
      "---\nid: x\n---\n\n## Problem\n",
    );
  });
});

describe("pre-write integrity refusal", () => {
  let root;
  let refineMod;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../../packages/mcp-rks/src/shared/frontmatter.mjs", async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        joinNoteFrontmatter: (fm, body) => "---\n" + String(fm) + "\n---" + String(body ?? "").replace(/^\s+/, ""),
      };
    });
    // timeout-opt-out: fault-injection only — vi.doMock(frontmatter.mjs) must be observed by a fresh refine.mjs graph; re-import is confined to this describe block's beforeEach
    refineMod = await import("../../packages/mcp-rks/src/server/refine.mjs");
  });

  afterEach(() => {
    vi.doUnmock("../../packages/mcp-rks/src/shared/frontmatter.mjs");
    vi.resetModules();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("apply site: refuses with a named status and leaves the note byte-identical", async () => {
    root = setupProject("fence-refuse-apply");
    const notePath = writeNote(root, SHAPES.blankThenH2);
    const before = fs.readFileSync(notePath, "utf8");
    const result = await refineMod.runRefineApplyTool({ projectRoot: root, problemId: "fence-story", refinements: [EXEMPLAR_REFINEMENT] });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("note_frontmatter_integrity_failed");
    expect(fs.readFileSync(notePath, "utf8")).toBe(before);
  });

  it("decompose site: ALL-OR-NOTHING — no child note, no child-notes commit, parent byte-identical", async () => {
    root = setupProject("fence-refuse-decompose");
    const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-b", "staging");
    git("config", "user.email", "t@t.com");
    git("config", "user.name", "T");
    const acs = Array.from({ length: 6 }, (_, i) => `- [ ] Criterion ${i + 1}`).join("\n");
    const notePath = writeNote(root, "\n\n## Problem\n\nBig.\n\n## Acceptance Criteria\n" + acs + "\n");
    git("add", ".");
    git("commit", "-m", "init");
    const before = fs.readFileSync(notePath, "utf8");
    const listingBefore = fs.readdirSync(path.join(root, "notes")).sort();

    const result = await refineMod.runRefineApplyTool({ projectRoot: root, problemId: "fence-story", refinements: [{ type: "decompose" }] });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("note_frontmatter_integrity_failed");
    expect(result.decomposed).not.toBe(true);
    expect(JSON.stringify(result)).not.toContain("arch-approved");
    expect(fs.readFileSync(notePath, "utf8")).toBe(before);
    expect(fs.readdirSync(path.join(root, "notes")).sort()).toEqual(listingBefore);
    expect(git("log", "--format=%s").stdout).not.toContain("Auto-commit child stories from decompose:");
  });
});
