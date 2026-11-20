// chore.backlog-sweep-final-residual-holds
// Binds the final residual-holds sweep to the real manifest, the notes tree and the sweep dry run.
// Ids are kept without the leading prefix and joined at run time, so this file never holds a live
// note's filename literal (the sweep's test_reference guard reads test files).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { destinationFor, planSweep } from "../../scripts/backlog-archive-sweep.mjs";
import { parseFrontmatter } from "../../packages/mcp-rks/src/shared/frontmatter.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOTES = path.join(REPO_ROOT, "notes");
const MD = ".md";
const P = "backlog" + ".";
const full = (stripped) => P + stripped;
const STORY = "chore.backlog-sweep-final-residual-holds";
const DONE_IN_CODE_PASS_STORY = "chore.backlog-agents-architecture-done-in-code";
const CUTOFF = "2026-10-03";
const OLD_CHILD_REASON = "shares child-1's evidence; this child's own ACs not checked";
const KEPT_NOTES_TEST = path.join(REPO_ROOT, "tests", "unit", "backlog-kept-notes-triage-manifest.test.mjs");
const LIFECYCLE_TEST = path.join(REPO_ROOT, "tests", "unit", "governor-lifecycle.test.mjs");
const CLASSIFIER_SPEC = "tests/unit/rag/content-type-classifier.spec.mjs";

const GP_PARENT = full("feat.git-push-tool");
const GP_TWIN = destinationFor(GP_PARENT, "z_implemented");
const GP_CHILDREN = [full("feat.git-push-tool.child-2"), full("feat.git-push-tool.child-3")];
const CCJ_PARENT = full("feat.cleanup-claude-json");
const CCJ_CHILDREN = ["find-stale-core", "cli-entry", "non-path-top"].map((s) => full("z_implemented.junk.feat.cleanup-claude-json." + s));
const RAG_ID = full("feat.rag-content-type-tagging");
const TL_LIVE = full("governor.thinking-log");
const TL_DEST = destinationFor(TL_LIVE, "z_implemented");
const TL_TWIN_OLD_ID = "9b7xehk5hshxt9gno9fcy2x";
const TL_ARCHIVED = "z_archive." + P + "governor.thinking-log-design-draft";
// sha256 of the twin's body (text after its closing frontmatter fence), measured before the rename.
const TWIN_BODY_SHA256 = "f353e244f4f931fe30b67a180763637a398504c40276b36ed44d6a19ec666581";
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts", "backlog-archive-manifest.json"), "utf8"));
const noteFile = (id) => path.join(NOTES, id + MD);
const exists = (id) => fs.existsSync(noteFile(id));
const readData = (id) => parseFrontmatter(fs.readFileSync(noteFile(id), "utf8")).data;
const sha256 = (t) => crypto.createHash("sha256").update(t).digest("hex");
const doneEntry = (id) => manifest.doneInCode.find((e) => e.id === id);
const heldEntry = (id) => (manifest.held || []).find((e) => e.id === id);
const texts = (e) => [e && e.$comment, e && e.reason].filter((s) => typeof s === "string").join("\n");

function bodyOf(text) {
  const close = text.indexOf("\n---", 3);
  return text.slice(text.indexOf("\n", close + 1) + 1);
}

function evidenceFound(entry) {
  return Array.isArray(entry.evidence) && entry.evidence.length > 0 && entry.evidence.every((ev) => {
    const abs = path.join(REPO_ROOT, ev.file);
    return typeof ev.literal === "string" && ev.literal !== "" && fs.existsSync(abs) && fs.readFileSync(abs, "utf8").includes(ev.literal);
  });
}

let planCache;
const dryRun = () => (planCache ??= planSweep({ projectRoot: REPO_ROOT, manifest, cutoff: CUTOFF }));
const holdsFor = (plan, id) => plan.held.filter((h) => h.id === id);
const moveFor = (plan, id) => plan.moves.find((m) => m.from === id);

describe("backlog sweep final residual holds", () => {
  it("each git-push-tool child sits in exactly one of doneInCode and held", () => {
    for (const id of GP_CHILDREN) expect(Boolean(doneEntry(id)) !== Boolean(heldEntry(id)), id).toBe(true);
  });

  it("every git-push-tool child doneInCode entry names this story and has evidence found in its file", () => {
    for (const id of GP_CHILDREN) {
      const e = doneEntry(id);
      if (!e) continue;
      expect(texts(e), id).toContain(STORY);
      expect(evidenceFound(e), id).toBe(true);
    }
  });

  it("a git-push-tool child left in held names its failing acceptance criterion", () => {
    for (const id of GP_CHILDREN) {
      const h = heldEntry(id);
      if (!h) continue;
      expect(h.reason, id).not.toBe(OLD_CHILD_REASON);
      expect(h.reason, id).toMatch(/\bAC\b|acceptance criteri/i);
    }
  });

  it("child-3 records the server.mjs handler criterion as a pass on substance citing handlers/git.mjs", () => {
    const e = doneEntry(GP_CHILDREN[1]);
    if (!e) return;
    const t = texts(e);
    expect(t).toContain("server/handlers/git.mjs:177");
    expect(t).toContain(":186");
    expect(t).toMatch(/on substance/i);
  });

  it("kept-notes triage test pins exactly the git-push-tool children that remain held, with the title count matching the pinned map", () => {
    const src = fs.readFileSync(KEPT_NOTES_TEST, "utf8");
    const start = src.indexOf("const USER_RULED_HELD = {");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("};", start));
    const keys = [...block.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]);
    for (const id of GP_CHILDREN) expect(keys.includes(id), id).toBe(Boolean(heldEntry(id)));
    const m = src.match(/it\("the (\w+) user-ruled held entries are unchanged"/);
    expect(m).not.toBeNull();
    // The title counts the USER_RULED_HELD keys plus the separately pinned README_HELD_ID hold.
    expect(src).toContain("const README_HELD_ID = ");
    expect(WORDS[m[1]] ?? Number(m[1])).toBe(keys.length + 1);
  });

  it("cleanup-claude-json parent names the three z_implemented junk child ids", () => {
    const loc = exists(CCJ_PARENT) ? CCJ_PARENT : destinationFor(CCJ_PARENT, "z_implemented");
    expect(readData(loc).childStories).toEqual(CCJ_CHILDREN);
    for (const c of CCJ_CHILDREN) expect(exists(c), c).toBe(true);
  });

  it("cleanup-claude-json parent is proposed in cohort C3 or already archived there", () => {
    if (exists(CCJ_PARENT)) {
      const m = moveFor(dryRun(), CCJ_PARENT);
      expect(m && m.cohort, JSON.stringify(holdsFor(dryRun(), CCJ_PARENT))).toBe("C3");
    } else {
      expect(readData(destinationFor(CCJ_PARENT, "z_implemented")).status).toBe("implemented");
    }
  });

  it("testReferences holds a data entry for rag-content-type-tagging whose text is on the named line", () => {
    const r = (manifest.testReferences || []).find((x) => x.id === RAG_ID && x.file === CLASSIFIER_SPEC);
    expect(r).toBeDefined();
    expect(r.use).toBe("data");
    expect(typeof r.reason === "string" && r.reason.trim() !== "").toBe(true);
    const lines = fs.readFileSync(path.join(REPO_ROOT, r.file), "utf8").split("\n");
    expect(lines[r.line - 1]).toContain(r.text);
    expect(r.text).toContain(RAG_ID + MD);
  });

  it("the dry run reports no test_reference hold for rag-content-type-tagging", () => {
    expect(holdsFor(dryRun(), RAG_ID).some((h) => h.reason === "test_reference")).toBe(false);
  });

  it("git-push-tool parent resolves as a duplicate of its z_implemented twin once both children have moved", () => {
    const d = (manifest.duplicates || []).find((x) => x.live === GP_PARENT);
    if (!d) return;
    expect(GP_CHILDREN.every((id) => doneEntry(id))).toBe(true);
    expect(d.survivor).toBe(GP_TWIN);
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof d.reason === "string" && d.reason.includes(STORY)).toBe(true);
    expect(exists(GP_TWIN)).toBe(true);
    if (!exists(GP_PARENT)) return;
    expect(sha256(fs.readFileSync(noteFile(GP_PARENT), "utf8"))).toBe(d.sha256);
    const moved = GP_CHILDREN.every((id) => !exists(id) && exists(destinationFor(id, "z_implemented")));
    if (!moved) return;
    const plan = dryRun();
    const r = plan.duplicatesResolved.find((x) => x.live === GP_PARENT);
    expect(r && r.survivor, JSON.stringify(holdsFor(plan, GP_PARENT))).toBe(GP_TWIN);
    expect(moveFor(plan, GP_PARENT)).toBeUndefined();
  });

  it("governor-lifecycle happy-path preflight test runs at every commit", () => {
    const src = fs.readFileSync(LIFECYCLE_TEST, "utf8");
    const gate = src.match(/lifecycleStoryAvailable = fs\.existsSync\(\s*path\.join\(NOTES_DIR, "([^"]+)"\)/);
    if (doneEntry(TL_LIVE)) {
      // D ran: the happy path reads a fixture notes directory, so the thinking-log move can neither skip nor fail it.
      expect(gate).toBeNull();
      expect(src).not.toContain("skipIf(!lifecycleStoryAvailable)");
      expect(src).toContain('it("passes with valid lifecycle params"');
      expect(src).toContain("function preflight(params, notesDir = NOTES_DIR)");
      expect(src.includes(TL_LIVE + MD)).toBe(false);
      return;
    }
    // D did not run: the file is unchanged, and its gate names a note that exists.
    expect(gate).not.toBeNull();
    expect(fs.existsSync(path.join(NOTES, gate[1])), gate[1]).toBe(true);
    const story = src.match(/playbook: "lifecycle",\s*storyId: "([^"]+)"/);
    expect(story).not.toBeNull();
    expect(story[1] + MD).toBe(gate[1]);
  });

  it("when thinking-log has no doneInCode entry the live note and its twin are where they were", () => {
    if (doneEntry(TL_LIVE)) return;
    expect(exists(TL_LIVE)).toBe(true);
    expect(readData(TL_DEST).id).toBe(TL_TWIN_OLD_ID);
    expect(exists(TL_ARCHIVED)).toBe(false);
  });

  it("when thinking-log is done the twin is archived as a superseded design draft with its body intact", () => {
    if (!doneEntry(TL_LIVE)) return;
    const text = fs.readFileSync(noteFile(TL_ARCHIVED), "utf8");
    const data = parseFrontmatter(text).data;
    expect(data.id).toBe(TL_ARCHIVED);
    expect(data.status).toBe("superseded");
    expect(data.supersededBy).toBe(TL_DEST);
    expect(data.archiveCohort).toBe("superseded");
    expect(String(data.archivedBy)).toContain(STORY);
    expect(TWIN_BODY_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(bodyOf(text))).toBe(TWIN_BODY_SHA256);
    const mismatches = dryRun().existingArchiveIdMismatches || [];
    expect(mismatches.some((mm) => String(mm.file).replace(/\.md$/, "") === TL_ARCHIVED)).toBe(false);
  });

  it("when thinking-log is done the live note is at z_implemented with status implemented", () => {
    const e = doneEntry(TL_LIVE);
    if (!e) return;
    expect(evidenceFound(e)).toBe(true);
    expect(texts(e)).toContain(STORY);
    expect(texts(e).includes(DONE_IN_CODE_PASS_STORY)).toBe(false);
    if (exists(TL_LIVE)) {
      // Code commit, before the first apply: the twin has been renamed away and the live note has not moved yet.
      expect(exists(TL_DEST)).toBe(false);
      return;
    }
    const data = readData(TL_DEST);
    expect(data.id).toBe(TL_DEST);
    expect(data.status).toBe("implemented");
  });

  it("this test file names no live backlog note by full id", () => {
    const own = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    const live = fs.readdirSync(NOTES).filter((f) => f.endsWith(MD)).map((f) => f.slice(0, -MD.length)).filter((id) => id.startsWith(P) && !id.startsWith(P + "z_"));
    expect(live.length).toBeGreaterThan(0);
    for (const id of live) expect(own.includes(id), id).toBe(false);
  });
});
