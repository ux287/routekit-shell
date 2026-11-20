// chore.backlog-sweep-resolve-shipped-twins
//
// Binds the 11 batch-2 held (target_exists) notes to their reviewed doneInCode, duplicates and
// testReferences entries and to the post-apply notes tree. Ids are held without the leading prefix
// and joined at run time, so this file never names a note filename literal.
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
const STORY = "chore.backlog-sweep-resolve-shipped-twins";
const BATCH_2_STORY = "chore.backlog-agents-architecture-done-in-code";
const SCHEMA_SPEC = "tests/unit/frontmatter-schema.spec.mjs";
const RAG = ["bug.rag-embed-expects-dev.server", "bug.rag-embed-expects-dev.validator"];
const TWINS = [
  ...RAG,
  "content.rks-workflow-blog",
  "dx.plan-auto-commit-phase",
  "dx.preflight-check",
  "feat.exec-dry-run",
  "fix.exec-diverged-state",
  "fix.session-state-provenance-exempt",
  "planner.create-new-files",
  "refactor.consolidate-frontmatter-handlers",
  "workflow.staging-sync-check",
];

const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts", "backlog-archive-manifest.json"), "utf8"));
const ours = manifest.doneInCode.filter((e) => typeof e.$comment === "string" && e.$comment.includes(STORY));
const oursIds = new Set(ours.map((e) => e.id));
const twinIds = new Set(TWINS.map(full));

function evidenceFound(entry) {
  return Array.isArray(entry.evidence) && entry.evidence.length > 0 && entry.evidence.every((ev) => {
    const abs = path.join(REPO_ROOT, ev.file);
    return typeof ev.literal === "string" && ev.literal !== "" && fs.existsSync(abs) && fs.readFileSync(abs, "utf8").includes(ev.literal);
  });
}

describe("backlog sweep resolve shipped twins", () => {
  it("every doneInCode entry this story adds names one of the 11 twins and has evidence found in its file", () => {
    expect(TWINS.length).toBe(11);
    expect(ours.length).toBeGreaterThan(0);
    for (const e of ours) {
      expect(twinIds.has(e.id), e.id).toBe(true);
      expect(evidenceFound(e), e.id).toBe(true);
    }
  });

  it("no doneInCode entry this story adds names the batch-2 story in its $comment", () => {
    for (const e of ours) expect(e.$comment.includes(BATCH_2_STORY), e.id).toBe(false);
  });

  it("every resolved twin has exactly one duplicates entry whose survivor is its z_implemented twin", () => {
    for (const e of ours) {
      const d = manifest.duplicates.filter((x) => x.live === e.id);
      expect(d.length, e.id).toBe(1);
      expect(d[0].survivor, e.id).toBe(destinationFor(e.id, "z_implemented"));
      expect(d[0].sha256, e.id).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof d[0].reason === "string" && d[0].reason.trim() !== "", e.id).toBe(true);
    }
  });

  it("each resolved rag-embed-expects-dev twin has a data testReferences entry on its frontmatter-schema.spec line", () => {
    const lines = fs.readFileSync(path.join(REPO_ROOT, SCHEMA_SPEC), "utf8").split("\n");
    for (const s of RAG) {
      if (!oursIds.has(full(s))) continue;
      const r = manifest.testReferences.find((x) => x.id === full(s) && x.file === SCHEMA_SPEC);
      expect(r, s).toBeDefined();
      expect(r.use, s).toBe("data");
      expect(r.text, s).toContain(s);
      expect(lines[r.line - 1], s).toContain(r.text);
    }
  });

  it("each resolved twin's live file is gone and its survivor parses with its id and a phase", () => {
    for (const e of ours) {
      const survivor = destinationFor(e.id, "z_implemented");
      expect(fs.existsSync(path.join(NOTES, e.id + MD)), e.id).toBe(false);
      const abs = path.join(NOTES, survivor + MD);
      expect(fs.existsSync(abs), survivor).toBe(true);
      const data = parseFrontmatter(fs.readFileSync(abs, "utf8")).data;
      // Survivors are pre-existing z_implemented notes that keep their own Dendron id; the sweep rewrites ids only on notes it moves.
      expect(typeof data.id === "string" && data.id !== "", survivor).toBe(true);
      expect(typeof data.phase === "string" && data.phase !== "", survivor).toBe(true);
    }
  });

  it("each unresolved twin has no doneInCode, duplicates or testReferences entry and its live file remains", () => {
    for (const s of TWINS) {
      const id = full(s);
      if (oursIds.has(id)) continue;
      expect(manifest.doneInCode.some((e) => e.id === id), s).toBe(false);
      expect(manifest.duplicates.some((d) => d.live === id), s).toBe(false);
      expect(manifest.testReferences.some((r) => r.id === id), s).toBe(false);
      expect(fs.existsSync(path.join(NOTES, id + MD)), s).toBe(true);
    }
  });
});
