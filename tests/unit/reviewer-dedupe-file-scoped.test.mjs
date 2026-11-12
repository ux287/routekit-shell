// backlog.fix.reviewer-dedupe-drops-identical-block-for-second-file
// extractExplicitEdits must dedupe on (resolved file, SEARCH text), not SEARCH text alone.
import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractExplicitEdits, runReviewerMode } from "../../packages/mcp-rks/src/llm/reviewer.mjs";
import { makeTempDir } from "../helpers/tmp.mjs";

vi.mock("@routekit/rag/tools", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
  getLastEmbedTime: vi.fn().mockResolvedValue(0),
  ensureRagIndex: vi.fn().mockResolvedValue({ ok: true }),
}));

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const AT = "@@";
const H = "###";
const FENCE = "`".repeat(3);

const A = "src/a.mjs";
const B = "src/b.mjs";
const X = ["const shared = makeClient({ legacy: true });", "const shared = makeClient();"];
const Y = ["const onlyA = 1;", "const onlyA = 2;"];
const Z = ["const onlyB = 1;", "const onlyB = 2;"];

const atBlock = ([s, r]) => `${AT}SEARCH\n${s}\n${AT}REPLACE\n${r}\n${AT}END`;
const atSection = (file, ...blocks) => blocks.map((b) => `${H} ${file}\n${atBlock(b)}\n`).join("\n");
const HH = "##";
const fencedPair = ([s, r]) => `SEARCH:\n${FENCE}js\n${s}\n${FENCE}\nREPLACE:\n${FENCE}js\n${r}\n${FENCE}\n`;
// Pattern 1b shape proven by reviewer-heading-format.test.mjs: an Edit-1 heading line, then a File line.
const fencedSection = (file, pair) => `${H} Edit 1: drop legacy flag\nFile: ${file}\n${fencedPair(pair)}`;
// Pattern 1 shape: an Edit heading naming the path with trailing description text, then a bare fenced pair.
const editSection = (file, desc, pair) => `${HH} Edit ${file} (${desc})\n${fencedPair(pair)}`;
const pairs = (edits) => edits.map((e) => [e.file, e.search]);

let root;
let evaluatePlanGuard;

beforeAll(async () => {
  root = makeTempDir("reviewer-dedupe-file-scoped");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, A), `${X[0]}\n${Y[0]}\n`);
  fs.writeFileSync(path.join(root, B), `${X[0]}\n${Z[0]}\n`);
  ({ evaluatePlanGuard } = await import(path.join(ROOT, "packages/mcp-rks/src/server/planner.mjs")));
});

describe("extractExplicitEdits -- dedupe is file-scoped", () => {
  it("byte-identical @@SEARCH blocks under two file headings yield one edit per file", () => {
    const story = `${atSection(A, X)}\n${atSection(B, X)}`;
    const edits = extractExplicitEdits(story, root, [A, B]).filter((e) => e.source === "at_marker_block");
    expect(pairs(edits)).toEqual([[A, X[0]], [B, X[0]]]);
    expect(edits.every((e) => e.replace === X[1])).toBe(true);
  });

  it("byte-identical fenced SEARCH/REPLACE blocks for two files yield one edit per file", () => {
    const story = `${fencedSection(A, X)}\n${fencedSection(B, X)}`;
    const edits = extractExplicitEdits(story, root, [A, B]).filter((e) => e.source === "search_replace_block");
    expect(pairs(edits)).toEqual([[A, X[0]], [B, X[0]]]);
  });

  it("byte-identical blocks under the SAME file still collapse to one edit", () => {
    const at = extractExplicitEdits(atSection(A, X, X), root, [A]).filter((e) => e.source === "at_marker_block");
    expect(pairs(at)).toEqual([[A, X[0]]]);
    const fenced = extractExplicitEdits(`${fencedSection(A, X)}\n${fencedSection(A, X)}`, root, [A])
      .filter((e) => e.source === "search_replace_block");
    expect(pairs(fenced)).toEqual([[A, X[0]]]);
  });

  it("two Pattern 1 sections with trailing heading text yield exactly two edits, each for its own section", () => {
    const story = `${editSection(A, "first", Y)}\n${editSection(B, "second", Z)}`;
    const edits = extractExplicitEdits(story, root, [A, B]);
    expect(pairs(edits)).toEqual([[A, Y[0]], [B, Z[0]]]);
  });

  it("silent-loss case: X,Y under a and X,Z under b yield four edits", () => {
    const story = `${atSection(A, X, Y)}\n${atSection(B, X, Z)}`;
    const edits = extractExplicitEdits(story, root, [A, B]).filter((e) => e.source === "at_marker_block");
    expect(pairs(edits)).toEqual([[A, X[0]], [A, Y[0]], [B, X[0]], [B, Z[0]]]);
  });
});

describe("runReviewerMode -- both files covered", () => {
  it("emits a search_replace step per file and the plan guard reports no coverage gap", async () => {
    const story = `${atSection(A, X)}\n${atSection(B, X)}`;
    const result = await runReviewerMode({ storyContent: story, projectRoot: root, targetFiles: [A, B], checkCompleteness: false });
    const srPaths = result.actions.filter((s) => s.action === "search_replace").map((s) => s.path);
    expect(srPaths).toEqual(expect.arrayContaining([A, B]));
    const verdict = evaluatePlanGuard({ combinedSteps: result.actions, enhancedEditableTargets: [{ path: A }, { path: B }], droppedSteps: [] });
    expect(verdict.uncoveredTargets).toEqual([]);
    expect(verdict.reason).not.toBe("coverage_gap");
  });
});
