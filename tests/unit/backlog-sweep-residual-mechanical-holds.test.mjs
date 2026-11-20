// chore.backlog-sweep-residual-mechanical-holds
//
// Binds this story's reviewed manifest entries to the real manifest and the post-apply notes
// tree. Ids are held without the leading prefix and joined at run time, so this file never
// names a note filename literal. No subprocesses are spawned.
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
const STORY = "chore.backlog-sweep-residual-mechanical-holds";
const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts", "backlog-archive-manifest.json"), "utf8"));
const names = (e) => [e.$comment, e.reason].some((s) => typeof s === "string" && s.includes(STORY));

const PHASE_TWINS = ["workflow.phase-integrated", "workflow.phase-released"].map(full);
const RAG_EMBED = full("feat.rag-embed-after-off-rail-ship");
const RAG_SUCCESSOR = full("z_implemented.feat.rag-wire-commit-and-embed");
const COMPOSITION_ROOT = full("feat.server-mjs-composition-root-refactor");
const HARNESS = full("z_implemented.feat.server-mjs-dispatch-characterization-harness");
const MODULARIZATION_ARCHIVED = destinationFor(full("feat.server-mjs-modularization-and-composition-root"), "z_archive");

const ourDuplicates = manifest.duplicates.filter(names);
const ourDoneInCode = manifest.doneInCode.filter(names);
const ourArchive = manifest.archive.filter(names);
const ourTestReferences = manifest.testReferences.filter(names);

const noteFile = (id) => path.join(NOTES, id + MD);
const noteExists = (id) => fs.existsSync(noteFile(id)) && fs.statSync(noteFile(id)).isFile();
const readData = (id) => parseFrontmatter(fs.readFileSync(noteFile(id), "utf8")).data;

function evidenceFound(entry) {
  return Array.isArray(entry.evidence) && entry.evidence.length > 0 && entry.evidence.every((ev) => {
    const abs = path.resolve(REPO_ROOT, ev.file);
    return abs.startsWith(REPO_ROOT + path.sep) && typeof ev.literal === "string" && ev.literal !== "" && fs.existsSync(abs) && fs.readFileSync(abs, "utf8").includes(ev.literal);
  });
}

describe("backlog sweep residual mechanical holds", () => {
  it("every duplicates entry this story adds has one entry per live id with a z_implemented survivor, sha256 and reason", () => {
    expect(ourDuplicates.length).toBeGreaterThan(0);
    for (const e of ourDuplicates) {
      expect(manifest.duplicates.filter((d) => d.live === e.live).length, e.live).toBe(1);
      expect(e.survivor, e.live).toBe(destinationFor(e.live, "z_implemented"));
      expect(e.sha256, e.live).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof e.reason === "string" && e.reason.trim() !== "", e.live).toBe(true);
    }
  });

  it("both workflow phase twins have a doneInCode entry with found evidence and a duplicates entry", () => {
    for (const id of PHASE_TWINS) {
      const done = ourDoneInCode.filter((e) => e.id === id);
      expect(done.length, id).toBe(1);
      expect(evidenceFound(done[0]), id).toBe(true);
      expect(ourDuplicates.filter((d) => d.live === id).length, id).toBe(1);
    }
  });

  it("rag-embed-after-off-rail-ship has a superseded archive entry whose successor resolves", () => {
    const entries = manifest.archive.filter((e) => e.id === RAG_EMBED);
    expect(entries.length).toBe(1);
    expect(names(entries[0])).toBe(true);
    expect(entries[0].kind).toBe("superseded");
    expect(entries[0].supersededBy).toBe(RAG_SUCCESSOR);
    expect(noteExists(RAG_SUCCESSOR)).toBe(true);
  });

  it("composition-root-refactor supersededBy names the resolving z_implemented harness note", () => {
    const entries = manifest.archive.filter((e) => e.id === COMPOSITION_ROOT);
    expect(entries.length).toBe(1);
    expect(entries[0].kind).toBe("superseded");
    expect(entries[0].supersededBy).toBe(HARNESS);
    expect(noteExists(HARNESS)).toBe(true);
  });

  it("every testReferences entry this story adds is data or comment and its line contains its text", () => {
    for (const e of ourTestReferences) {
      expect(["data", "comment"], e.id).toContain(e.use);
      expect(typeof e.text === "string" && e.text !== "", e.id).toBe(true);
      const abs = path.resolve(REPO_ROOT, e.file);
      expect(abs.startsWith(REPO_ROOT + path.sep), e.file).toBe(true);
      const lines = fs.readFileSync(abs, "utf8").split("\n");
      expect(lines[e.line - 1], `${e.file}:${e.line}`).toContain(e.text);
    }
  });

  it("every resolved duplicate's live file is gone and its survivor parses with id and phase", () => {
    const lives = ourDuplicates.map((e) => e.live);
    for (const id of PHASE_TWINS) expect(lives, id).toContain(id);
    for (const e of ourDuplicates) {
      expect(noteExists(e.live), e.live).toBe(false);
      expect(noteExists(e.survivor), e.survivor).toBe(true);
      const data = readData(e.survivor);
      // Survivors are pre-existing z_implemented notes that keep their own Dendron id.
      expect(typeof data.id === "string" && data.id.trim() !== "", e.survivor).toBe(true);
      expect(typeof data.phase === "string" && data.phase.trim() !== "", e.survivor).toBe(true);
    }
  });

  it("rag-embed-after-off-rail-ship is archived as superseded and its live file is gone", () => {
    const archived = destinationFor(RAG_EMBED, "z_archive");
    expect(noteExists(archived)).toBe(true);
    expect(noteExists(RAG_EMBED)).toBe(false);
    const data = readData(archived);
    expect(data.status).toBe("superseded");
    expect(data.supersededBy).toBe(RAG_SUCCESSOR);
  });

  it("composition-root-refactor is archived and its live file is gone", () => {
    expect(noteExists(destinationFor(COMPOSITION_ROOT, "z_archive"))).toBe(true);
    expect(noteExists(COMPOSITION_ROOT)).toBe(false);
  });

  it("the modularization note supersededBy points at the archived composition-root-refactor", () => {
    expect(noteExists(MODULARIZATION_ARCHIVED)).toBe(true);
    const data = readData(MODULARIZATION_ARCHIVED);
    expect(data.supersededBy).toBe(destinationFor(COMPOSITION_ROOT, "z_archive"));
  });

  it("no held or shelve entry names this story or any id this story adds", () => {
    const held = manifest.held || [];
    const shelve = manifest.shelve || [];
    for (const e of [...held, ...shelve]) expect(names(e), String(e.id)).toBe(false);
    const added = new Set([...ourDuplicates.map((e) => e.live), ...ourDoneInCode.map((e) => e.id), ...ourArchive.map((e) => e.id)]);
    expect(added.size).toBeGreaterThan(0);
    for (const e of [...held, ...shelve]) expect(added.has(e.id), String(e.id)).toBe(false);
  });
});
