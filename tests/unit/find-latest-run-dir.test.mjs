import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findLatestRunDir } from "../../packages/mcp-rks/src/utils/git.mjs";

// backlog.fix.find-latest-run-dir-doc-and-ordering-invariant
// Pins the ordering contract: selection is by descending lexical NAME order, never mtime.
// The null-slug and prefix-collision filter behaviour is pinned below, in the block owned by
// backlog.fix.plan-review-cross-story-bleed-and-silent-transition.

const here = path.dirname(fileURLToPath(import.meta.url));
const GIT_MJS = path.resolve(here, "../../packages/mcp-rks/src/utils/git.mjs");

function stamp(t) {
  return new Date(t).toISOString().replace(/[:.]/g, "-");
}

let root;
let runs;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "find-latest-run-dir-"));
  runs = path.join(root, ".rks", "runs");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function mkRun(name) {
  const p = path.join(runs, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

describe("findLatestRunDir ordering", () => {
  it("returns the lexically later same-slug run even when the earlier-named run has the newer mtime", () => {
    const earlierName = mkRun(`${stamp(Date.UTC(2026, 0, 1, 0, 0, 0, 0))}_alpha`);
    const laterName = mkRun(`${stamp(Date.UTC(2026, 0, 2, 0, 0, 0, 0))}_alpha`);
    const past = new Date(Date.UTC(2020, 0, 1));
    const future = new Date(Date.UTC(2030, 0, 1));
    fs.utimesSync(laterName, past, past);
    fs.utimesSync(earlierName, future, future);
    expect(fs.statSync(earlierName).mtimeMs).toBeGreaterThan(fs.statSync(laterName).mtimeMs);
    expect(findLatestRunDir(root, "alpha")).toBe(laterName);
  });

  it("skips a non-directory entry whose name sorts last", () => {
    const dir = mkRun(`${stamp(Date.UTC(2026, 0, 1, 0, 0, 0, 0))}_alpha`);
    fs.writeFileSync(path.join(runs, `${stamp(Date.UTC(2026, 0, 2, 0, 0, 0, 0))}_alpha`), "not a dir");
    expect(findLatestRunDir(root, "alpha")).toBe(dir);
  });

  it("returns null when .rks/runs is missing", () => {
    expect(fs.existsSync(runs)).toBe(false);
    expect(findLatestRunDir(root, "alpha")).toBeNull();
  });

  it("returns null when no entry matches the slug", () => {
    mkRun(`${stamp(Date.UTC(2026, 0, 1, 0, 0, 0, 0))}_alpha`);
    expect(findLatestRunDir(root, "beta")).toBeNull();
  });

  it("toISOString-derived names sort in creation order across hour, day, month and year changes", () => {
    const times = [
      Date.UTC(2025, 11, 31, 22, 59, 59, 999),
      Date.UTC(2025, 11, 31, 23, 0, 0, 0), // hour change
      Date.UTC(2026, 0, 1, 0, 0, 0, 0), // day, month and year change
      Date.UTC(2026, 0, 31, 23, 59, 59, 999),
      Date.UTC(2026, 1, 1, 0, 0, 0, 0), // day and month change
      Date.UTC(2026, 8, 30, 9, 59, 59, 999),
      Date.UTC(2026, 9, 1, 10, 0, 0, 0), // month 09 -> 10, hour 09 -> 10
    ];
    const names = times.map((t) => `${stamp(t)}_alpha`);
    for (const n of names) expect(n.indexOf("_")).toBe(24);
    expect([...names].sort()).toEqual(names);
    // Create in reverse so creation order on disk disagrees with timestamp order.
    for (const n of [...names].reverse()) mkRun(n);
    expect(findLatestRunDir(root, "alpha")).toBe(path.join(runs, names[names.length - 1]));
  });
});

function jsdocAbove(src, signature) {
  const idx = src.indexOf(signature);
  expect(idx).toBeGreaterThan(-1);
  const before = src.slice(0, idx).trimEnd();
  expect(before.endsWith("*/")).toBe(true);
  const start = before.lastIndexOf("/**");
  return { block: before.slice(start), preceding: before.slice(0, start).trimEnd() };
}

// backlog.fix.plan-review-cross-story-bleed-and-silent-transition: slug matching is exact at the
// end of the name, and a null slug still admits every run (rks_exec "uses latest if omitted").
describe("findLatestRunDir slug boundary and null slug", () => {
  it("returns null when the only run is a different story whose slug shares the prefix boundary", () => {
    mkRun(`${stamp(Date.UTC(2026, 0, 1, 0, 0, 0, 0))}_backlog-fix-foo-bar`);
    expect(findLatestRunDir(root, "backlog-fix-foo")).toBeNull();
  });

  it("returns the exact-slug run, not the lexically later prefix-sharing sibling", () => {
    const own = mkRun(`${stamp(Date.UTC(2026, 0, 1, 0, 0, 0, 0))}_backlog-fix-foo`);
    const sibling = mkRun(`${stamp(Date.UTC(2026, 0, 2, 0, 0, 0, 0))}_backlog-fix-foo-bar`);
    expect([own, sibling].sort().pop()).toBe(sibling);
    expect(findLatestRunDir(root, "backlog-fix-foo")).toBe(own);
    expect(findLatestRunDir(root, "backlog-fix-foo-bar")).toBe(sibling);
  });

  it("still returns the lexically latest run for an explicit unambiguous slug", () => {
    mkRun(`${stamp(Date.UTC(2026, 0, 1, 0, 0, 0, 0))}_alpha`);
    const later = mkRun(`${stamp(Date.UTC(2026, 0, 3, 0, 0, 0, 0))}_alpha`);
    mkRun(`${stamp(Date.UTC(2026, 0, 4, 0, 0, 0, 0))}_beta`);
    expect(findLatestRunDir(root, "alpha")).toBe(later);
  });

  it("null slug returns the lexically latest run of any slug", () => {
    mkRun(`${stamp(Date.UTC(2026, 0, 1, 0, 0, 0, 0))}_alpha`);
    const latest = mkRun(`${stamp(Date.UTC(2026, 0, 2, 0, 0, 0, 0))}_beta`);
    mkRun(`${stamp(Date.UTC(2025, 11, 31, 0, 0, 0, 0))}_gamma`);
    expect(findLatestRunDir(root, null)).toBe(latest);
    expect(findLatestRunDir(root)).toBe(latest);
  });
});

describe("findLatestRunDir documentation", () => {
  const src = fs.readFileSync(GIT_MJS, "utf8");

  it("utils/git.mjs no longer contains the phrase most recently modified", () => {
    expect(src).not.toContain("most recently modified");
  });

  it("the comment directly above getStagingSyncStatus is a single JSDoc that does not describe run directories", () => {
    const { block, preceding } = jsdocAbove(src, "export function getStagingSyncStatus(");
    expect(block).not.toMatch(/run director/i);
    expect(block).not.toMatch(/slug/i);
    // No second JSDoc block stacked immediately above it.
    expect(preceding.endsWith("*/")).toBe(false);
  });

  it("findLatestRunDir has a JSDoc stating lexical name order, never mtime, the toISOString prefix and the null cases", () => {
    const { block } = jsdocAbove(src, "export function findLatestRunDir(");
    expect(block).toMatch(/lexical/i);
    expect(block).toMatch(/mtime/);
    expect(block).toMatch(/toISOString/);
    expect(block).toMatch(/null/);
  });
});
