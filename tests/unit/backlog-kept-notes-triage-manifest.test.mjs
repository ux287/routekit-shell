// Binds the kept-notes triage paper to the real sweep manifest
// (backlog.chore.backlog-kept-notes-evidence-triage). No subprocesses are spawned.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = path.join(REPO_ROOT, "scripts", "backlog-archive-manifest.json");
const PAPER = path.join(REPO_ROOT, "notes", "research.2026.11.14.backlog-kept-notes-triage.md");
const ROW = /^\|\s*(backlog\.[^\s|]+)\s*\|\s*(done|superseded|wont-do|unclear)\s*\|\s*(.*?)\s*\|\s*$/;

const USER_RULED_HELD = {
  "backlog.feat.research-agent-exhaustive-search-tool": "triage evidence is the MCP tool registration, not the research-agent integration this story names",
  "backlog.feat.governor-state-machine-p1": "triage: DONE (other design); candidate for superseded, not done",
  "backlog.feat.governor-state-machine-p3": "a current roadmap paper still calls it draft (triage Section 8)",
};
const README_HELD_ID = "backlog.feat.readme-public-launch-update";

// backlog.chore.backlog-sweep-residual-mechanical-holds reviews three unclear rows (the two
// workflow phase twins and rag-embed-after-off-rail-ship). An unclear row may carry a doneInCode
// or archive entry only when that entry's $comment or reason names that story by its stripped id.
const RESIDUAL_HOLDS_STORY = "chore.backlog-sweep-residual-mechanical-holds";
function namesResidualHoldsStory(entry) {
  return [entry && entry.$comment, entry && entry.reason].some((s) => typeof s === "string" && s.includes(RESIDUAL_HOLDS_STORY));
}

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
}

function readRows() {
  const rows = [];
  for (const line of fs.readFileSync(PAPER, "utf8").split("\n")) {
    const m = ROW.exec(line);
    if (m) rows.push({ id: m[1], verdict: m[2], note: m[3] });
  }
  return rows;
}

// A successor resolves only as the sweep resolves it (scripts/backlog-archive-sweep.mjs
// computePlan: nameSet of top-level notes/*.md names, then nameSet.has(b)): the exact
// supersededBy string must name a note file. No prefix or alias fallback; an archived
// successor is recorded under its archived id.
function successorResolves(id) {
  const p = path.join(REPO_ROOT, "notes", `${id}.md`);
  return fs.existsSync(p) && fs.statSync(p).isFile();
}

describe("kept-notes evidence triage manifest", () => {
  it("triage paper lists every examined note with a verdict and evidence or reason", () => {
    const rows = readRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.note.length > 0, r.id).toBe(true);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it("every done row has a doneInCode entry whose evidence literals are found", () => {
    const manifest = readManifest();
    for (const r of readRows().filter((x) => x.verdict === "done")) {
      const entry = manifest.doneInCode.find((e) => e.id === r.id);
      expect(Boolean(entry), r.id).toBe(true);
      expect(Array.isArray(entry.evidence) && entry.evidence.length > 0, r.id).toBe(true);
      for (const ev of entry.evidence) {
        const abs = path.resolve(REPO_ROOT, ev.file);
        expect(abs.startsWith(REPO_ROOT + path.sep), `${r.id} ${ev.file}`).toBe(true);
        expect(fs.existsSync(abs), `${r.id} ${ev.file}`).toBe(true);
        expect(fs.readFileSync(abs, "utf8").includes(ev.literal), `${r.id} ${ev.file} :: ${ev.literal}`).toBe(true);
      }
    }
  });

  it("every superseded row has a superseded archive entry whose successor resolves under notes", () => {
    const manifest = readManifest();
    for (const r of readRows().filter((x) => x.verdict === "superseded")) {
      const entry = manifest.archive.find((e) => e.id === r.id);
      expect(entry && entry.kind, r.id).toBe("superseded");
      const by = Array.isArray(entry.supersededBy) ? entry.supersededBy : [entry.supersededBy];
      expect(by.length > 0, r.id).toBe(true);
      for (const s of by) expect(typeof s === "string" && successorResolves(s), `${r.id} -> ${s}`).toBe(true);
    }
  });

  it("every wont-do row has a wont-do archive entry with a non-blank reason", () => {
    const manifest = readManifest();
    for (const r of readRows().filter((x) => x.verdict === "wont-do")) {
      const entry = manifest.archive.find((e) => e.id === r.id);
      expect(entry && entry.kind, r.id).toBe("wont-do");
      expect(typeof entry.reason === "string" && entry.reason.trim() !== "", r.id).toBe(true);
    }
  });

  it("unclear-row predicate accepts only an entry that names the residual-holds story", () => {
    const base = { id: "backlog.zzfx.unclear-row", kind: "superseded", supersededBy: "backlog.zzfx.successor" };
    expect(namesResidualHoldsStory({ ...base, reason: `${RESIDUAL_HOLDS_STORY}: reviewed` })).toBe(true);
    expect(namesResidualHoldsStory({ ...base, $comment: `reviewed by ${RESIDUAL_HOLDS_STORY}` })).toBe(true);
    expect(namesResidualHoldsStory({ ...base, reason: "reviewed by another story" })).toBe(false);
    expect(namesResidualHoldsStory({ ...base, $comment: "reviewed by another story" })).toBe(false);
    expect(namesResidualHoldsStory(base)).toBe(false);
    expect(namesResidualHoldsStory({ ...base, reason: 42, $comment: null })).toBe(false);
  });

  it("unclear rows have no doneInCode or archive entry unless it names the residual-holds story", () => {
    const manifest = readManifest();
    for (const r of readRows().filter((x) => x.verdict === "unclear")) {
      for (const e of manifest.doneInCode.filter((x) => x.id === r.id)) expect(namesResidualHoldsStory(e), `doneInCode ${r.id}`).toBe(true);
      for (const e of manifest.archive.filter((x) => x.id === r.id)) expect(namesResidualHoldsStory(e), `archive ${r.id}`).toBe(true);
    }
  });

  it("the four user-ruled held entries are unchanged", () => {
    const manifest = readManifest();
    for (const [id, reason] of Object.entries(USER_RULED_HELD)) {
      const entry = manifest.held.find((e) => e.id === id);
      expect(entry && entry.reason, id).toBe(reason);
    }
    const readme = manifest.held.find((e) => e.id === README_HELD_ID);
    expect(Boolean(readme), README_HELD_ID).toBe(true);
    expect(readme.reason).toContain("done-vs-superseded is a user decision");
    expect(manifest.doneInCode.some((e) => e.id === README_HELD_ID)).toBe(false);
    expect(manifest.archive.some((e) => e.id === README_HELD_ID)).toBe(false);
  });
});
