/**
 * Witness for backlog.fix.refine-apply-note-newline-growth-false-unchanged.
 *
 * THE DEFECT: refine's two write sites rejoined a note as `"---\n" + fm + "\n---\n" + body`, but
 * `body` — sliced from the end of a match whose regex stops AT the closing fence — already begins
 * with that newline. One extra byte per apply, forever, silently. And the disk-fetch result
 * carried a hardcoded `story note unchanged` clause: a claim about the note sourced from nothing
 * that looked at the note, and false on every apply, because a disk-fetch forces isNoop false so
 * the write always runs.
 *
 * Field-confirmed three times in routekit-growth: bodyLength 74643 -> 74644 with ok:true and
 * "story note unchanged".
 *
 * REFERENCE IMPLEMENTATION: server/git/git-utils.mjs:262 already had the convention right.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir, ensureDir } from "../helpers/tmp.mjs";
import { runRefineApplyTool } from "../../packages/mcp-rks/src/server/refine.mjs";
import {
  splitNoteFrontmatter,
  joinNoteFrontmatter,
} from "../../packages/mcp-rks/src/shared/frontmatter.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SRC_ROOT = path.join(REPO_ROOT, "packages", "mcp-rks", "src");

// Real note shapes, not a synthetic minimal one. A naive /^---\n([\s\S]*?)\n---/ mis-handles all
// three of these, which is precisely why they are here.
const SHAPES = {
  nestedLists: [
    "---",
    'id: "backlog.fix.example"',
    "targetFiles:",
    '  - path: "packages/a/b.mjs"',
    '    op: "edit"',
    '    desc: "has: a colon, and --- dashes"',
    "testRequirements:",
    "  - first requirement",
    "  - second requirement",
    "---",
    "",
    "## Problem",
    "",
    "Body text.",
    "",
  ].join("\n"),
  fencedDashes: [
    "---",
    'id: "backlog.fix.fenced"',
    "---",
    "",
    "## Solution",
    "",
    "```yaml",
    "---",
    "key: value",
    "---",
    "```",
    "",
    "Trailing prose.",
    "",
  ].join("\n"),
  searchBlocks: [
    "---",
    'id: "backlog.fix.anchors"',
    "---",
    "",
    "## Anchors",
    "",
    "@@SEARCH",
    "function bearerToken() {",
    "@@REPLACE",
    "export function bearerToken() {",
    "@@END",
    "",
  ].join("\n"),
  leadingBlankLine: "---\nid: \"x\"\n---\n\n\n## Keeps the authored blank line\n",
  noFrontmatter: "just a body, no fence\n",
};

describe("the shared pair round-trips byte-for-byte", () => {
  it("join(split(x)) === x on every real note shape", () => {
    const broken = [];
    for (const [name, raw] of Object.entries(SHAPES)) {
      const { frontmatter, body } = splitNoteFrontmatter(raw);
      if (joinNoteFrontmatter(frontmatter, body) !== raw) broken.push(name);
    }
    expect(broken).toEqual([]);
  });

  it("preserves an authored leading blank line rather than stripping it", () => {
    // formatWithFrontmatter does `replace(/^\s+/, "")`. Routing a note through THAT would trade
    // "adds a newline" for "deletes the author's blank line" — one silent corruption for another.
    const raw = SHAPES.leadingBlankLine;
    const { frontmatter, body } = splitNoteFrontmatter(raw);
    expect(body.startsWith("\n\n\n")).toBe(true);
    expect(joinNoteFrontmatter(frontmatter, body)).toBe(raw);
  });

  it("uses the reference convention — no newline after the closing fence", () => {
    // git-utils.mjs:262 is the site that already had this right, and is allowlisted below rather
    // than converted. This pins the convention itself, so the allowlist's claim is CHECKED.
    expect(joinNoteFrontmatter("id: x", "\nbody\n")).toBe("---\nid: x\n---\nbody\n");
    const gitUtils = fs.readFileSync(
      path.join(SRC_ROOT, "server", "git", "git-utils.mjs"),
      "utf8",
    );
    expect(gitUtils).toContain("`---\\n${frontmatter}\\n---${body}`");
  });
});

describe("one rejoin implementation across the server source", () => {
  it("no file builds a frontmatter fence without using the shared pair", () => {
    // STRUCTURAL, not spelling-based: three fence spellings exist in this tree, and an
    // import-based exemption would give migrations/implemented-to-integrated.mjs a free pass
    // because it already imports the module without calling the pair.
    const ALLOWLIST = new Map([
      // Already correct, and consumed by the ship path via updateBacklogStatus — converting it
      // would pull three ship-path test files into a note-serialisation fix for no behavioural
      // gain. Its convention is pinned by the test above instead.
      ["server/git/git-utils.mjs", "reference implementation; convention pinned above"],
      ["agents/research.mjs", "composes a NEW note from scratch; never splits one"],
      ["migrations/implemented-to-integrated.mjs", "one-shot migration; composes, never round-trips"],
      ["shared/frontmatter.mjs", "defines the pair"],
    ]);
    const FENCE_BUILDERS = [/"---\\n"\s*\+/, /`---\\n\$\{/, /'---\\n'\s*\+/];

    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".mjs")) files.push(p);
      }
    };
    walk(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0); // positive control — the walk found something

    const offenders = [];
    for (const file of files) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      if (ALLOWLIST.has(rel)) continue;
      const src = fs.readFileSync(file, "utf8");
      if (!FENCE_BUILDERS.some((re) => re.test(src))) continue;
      // Exemption is by USE, not by import — matched on the CALL spelling.
      const usesPair =
        src.includes("splitNoteFrontmatter(") && src.includes("joinNoteFrontmatter(");
      if (!usesPair) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

describe("refine apply is byte-stable and reports what it observed", () => {
  let projectRoot;
  const TARGET = "src/target.mjs";

  const buildNote = (storyId) =>
    [
      "---",
      `id: "${storyId}"`,
      'phase: "arch-approved"',
      "targetFiles:",
      `  - path: "${TARGET}"`,
      '    op: "edit"',
      "---",
      "",
      "## Problem",
      "",
      "Body that must not grow.",
      "",
    ].join("\n");

  const bodyOf = (raw) => splitNoteFrontmatter(raw).body;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_roundtrip");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, "src"));
    fs.writeFileSync(path.join(projectRoot, TARGET), "export const a = 1;\n");
  });

  afterEach(() => {
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("body byte length is stable from apply 2 onward", async () => {
    // Measured from apply 2 because apply 1's yaml.dump re-emission legitimately reformats the
    // FRONTMATTER. The body is what must not move. Pre-fix this records [1, 1] — one byte per
    // apply. A green run against unmodified HEAD is a FAILED REPRODUCTION, not a success.
    const storyId = "backlog.fix.roundtrip-stability";
    const notePath = path.join(projectRoot, "notes", `${storyId}.md`);
    fs.writeFileSync(notePath, buildNote(storyId));

    const lengths = [];
    for (let i = 0; i < 3; i++) {
      await runRefineApplyTool({
        projectRoot,
        problemId: storyId,
        refinements: [{ type: "disk_fetch_context", data: { file: TARGET } }],
      });
      lengths.push(bodyOf(fs.readFileSync(notePath, "utf8")).length);
    }
    const deltas = lengths.slice(1).map((n, i) => n - lengths[i]);
    expect(deltas).toEqual([0, 0]);
  });

  it("the disk-fetch report no longer asserts a hardcoded unchanged claim", () => {
    const refineSrc = fs.readFileSync(path.join(SRC_ROOT, "server", "refine.mjs"), "utf8");
    // The literal that made this undiagnosable. It must not come back.
    expect(refineSrc).not.toContain("bytes, story note unchanged)");
  });
});
