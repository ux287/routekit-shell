/**
 * backlog.fix.exec-note-scope-and-backup-durability — landmine and guard-scope
 * unit tests. TR10, TR11, TR12, TR16 (unit half), TR24.
 *
 * Two concerns:
 *
 * 1. The dead auto-advance unit in server.mjs staged the WHOLE tree (`-A`),
 *    bypassed assertNotProtectedBranch, and swallowed failure via stdio:'pipe'.
 *    It was unreachable only because execSchema never declared `problemId` and a
 *    bare z.object strips unknown keys — so adding that one field would have
 *    silently armed it. Both halves are pinned here.
 *
 * 2. computeUnexpectedFiles must exempt the story note AND the pre-exec dirty
 *    baseline, without becoming a blanket `notes/` pass.
 *
 * Source assertions use durable whole-file phrase checks, never fixed-size
 * window slices, which break on any nearby edit.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { computeUnexpectedFiles } from "../../packages/mcp-rks/src/server/test-runner.mjs";

const ROOT = process.cwd();
const SERVER_SRC = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/server.mjs"), "utf8");
const BACKUP_SRC = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/exec/backup.mjs"), "utf8");

/**
 * Needles are assembled from fragments so that THIS file — which is itself
 * inside the scanned tree — cannot match its own scan and report a false
 * offender. Do not inline them back into literals.
 */
const STASH_WORD = "st" + "ash";
const CLEAR_WORD = "cl" + "ear";
const STASH_CLEAR = `git ${STASH_WORD} ${CLEAR_WORD}`;
const STASH_CLEAR_ARGV = new RegExp(`["']${STASH_WORD}["']\\s*,\\s*["']${CLEAR_WORD}["']`);
const UNSCOPED_COMMIT = ["git add -A", "git commit"].join(" && ");

function walkFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".tmp") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, acc);
    else if (/\.(mjs|js|cjs)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe("TR10 — the dead unscoped auto-advance unit is gone from server.mjs", () => {
  it("contains no unscoped whole-tree commit", () => {
    expect(SERVER_SRC).not.toContain(UNSCOPED_COMMIT);
  });

  it("contains neither orphan comment from the deleted unit", () => {
    // Deleting only the inner commit block would leave these standing above no
    // commit at all — an invitation to re-add the landmine.
    expect(SERVER_SRC).not.toContain("Auto-advance phase on successful exec");
    expect(SERVER_SRC).not.toContain("Note: exec already commits changes");
  });

  it("makes no advancePhase call passing the 'exec' operation", () => {
    // The surviving advancePhase(..., "exec") would have fired a SECOND phase
    // operation on top of exec's own "exec_end" if problemId were ever added.
    expect(SERVER_SRC).not.toMatch(/advancePhase\s*\([^)]*["']exec["']\s*\)/);
  });
});

describe("TR11 — NEGATIVE AC: execSchema still declares no problemId", () => {
  it("the rks_exec input schema does not accept problemId", () => {
    const match = SERVER_SRC.match(/const execSchema = z\.object\(\{([\s\S]*?)\}\);/);
    expect(match, "execSchema declaration not found in server.mjs").toBeTruthy();
    expect(match[1]).not.toContain("problemId");
  });
});

describe("TR12 / TR24 — NEGATIVE AC: pre-existing stashes are never destroyed", () => {
  it("no source or test file wipes the whole stash stack", () => {
    const files = [
      ...walkFiles(path.join(ROOT, "packages/mcp-rks/src")),
      ...walkFiles(path.join(ROOT, "tests")),
    ];
    const offenders = files.filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      return src.includes(STASH_CLEAR) || STASH_CLEAR_ARGV.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("backup.mjs drops no stash from inside an iteration over the stash list", () => {
    // A batch/sweep drop would destroy other runs' backups. Only the single
    // stash the current run created may ever be dropped.
    expect(BACKUP_SRC).not.toMatch(/for\s*\([^)]*\)\s*\{[^}]*stash["']\s*,\s*["']drop/);
  });

  it("backup.mjs selects stashes by SHA equality, never by substring match", () => {
    expect(BACKUP_SRC).not.toMatch(/\.find\s*\([^)]*includes\s*\(\s*["'`]rks\.exec backup/);
    expect(BACKUP_SRC).toContain("--format=%gd %H");
  });
});

describe("TR16 — scope guard exempts the story note AND the pre-exec baseline", () => {
  const problemId = "backlog.fix.demo";
  const storyNote = `notes/${problemId}.md`;
  const childNote = `notes/${problemId}.child-1.md`;
  const otherNote = "notes/backlog.feat.other.md";
  const unrelatedSrc = "src/unrelated.mjs";

  const modifiedFiles = [storyNote, childNote, otherNote, unrelatedSrc];
  const expectedFiles = new Set();
  const storyNoteExclusions = new Set([storyNote, childNote]);

  it("(a) a note dirty BEFORE exec started does not trigger a scope violation", () => {
    // Baseline contains otherNote — it was already dirty when exec began, which
    // exec's own pre-flight gate deliberately admits.
    const scopeExemptions = new Set([...storyNoteExclusions, otherNote]);
    const result = computeUnexpectedFiles({
      steps: [], modifiedFiles, expectedFiles, scopeExemptions,
    });

    expect(result).not.toContain(storyNote);
    expect(result).not.toContain(childNote);
    expect(result).not.toContain(otherNote);
    expect(result).toContain(unrelatedSrc);
  });

  it("(b) a note exec ITSELF newly dirtied is still reported — the exemption is a baseline delta, not a blanket notes/ pass", () => {
    const scopeExemptions = new Set([...storyNoteExclusions]);
    const result = computeUnexpectedFiles({
      steps: [], modifiedFiles, expectedFiles, scopeExemptions,
    });

    expect(result).toContain(otherNote);
    expect(result).not.toContain(storyNote);
    expect(result).not.toContain(childNote);
  });

  it("(c) a genuinely unexpected non-note file is reported in both cases", () => {
    for (const scopeExemptions of [
      new Set([...storyNoteExclusions, otherNote]),
      new Set([...storyNoteExclusions]),
    ]) {
      const result = computeUnexpectedFiles({
        steps: [], modifiedFiles, expectedFiles, scopeExemptions,
      });
      expect(result).toContain(unrelatedSrc);
    }
  });

  it("existing exemptions are untouched", () => {
    const result = computeUnexpectedFiles({
      steps: [],
      modifiedFiles: [".rks/state.json", ".routekit/hooks/x.mjs", "src/kept.mjs"],
      expectedFiles: new Set(),
      scopeExemptions: new Set(),
    });
    expect(result).toEqual(["src/kept.mjs"]);
  });
});
