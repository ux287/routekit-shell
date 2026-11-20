import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// backlog.feat.governed-adhoc-commit-verbatim-message AC6: the ad-hoc Ship path (Path 3 of
// .rks/prompts/governor-ship.md) commits caller-named paths with a caller-supplied verbatim
// message, refuses before calling rks_git_commit when an input is missing, and reports only
// from tool output. Every assertion is scoped to the Path 3 section.
const SRC = readFileSync(path.resolve(".rks/prompts/governor-ship.md"), "utf8");

// Path 3 runs from its heading line to the next heading of level 1-3 (#### sub-headings stay inside);
// located by heading, not a fixed slice. The search starts AFTER the heading line, so the heading
// itself can never terminate the section.
function path3() {
  const start = SRC.search(/^###\s+Path 3\b/m);
  expect(start, "Path 3 heading missing").toBeGreaterThanOrEqual(0);
  const rest = SRC.slice(start);
  const nl = rest.indexOf("\n");
  const body = rest.slice(nl + 1);
  const next = body.search(/^#{1,3}\s/m);
  return rest.slice(0, nl + 1) + (next === -1 ? body : body.slice(0, next));
}

describe("governor-ship.md Path 3 ad-hoc verbatim commit (AC6)", () => {
  it("lists files and rawMessage as inputs", () => {
    const s = path3();
    expect(s).toMatch(/\bfiles\b/);
    expect(s).toMatch(/rawMessage/);
  });
  it("forbids rewriting the message", () => {
    expect(path3()).toMatch(/(never|do not|must not)[^\n]*(paraphrase|rewrite|reflow)/i);
  });
  it("returns failed without calling rks_git_commit when files or rawMessage is absent", () => {
    const s = path3();
    expect(s).toMatch(/failed/i);
    expect(s).toMatch(/without calling `?rks_git_commit/i);
    expect(s).toMatch(/no `?files`?|`?files`? (is )?(absent|missing)/i);
    expect(s).toMatch(/no `?rawMessage`?|`?rawMessage`? (is )?(absent|missing)/i);
  });
  it("on a tool refusal returns failed with the tool error verbatim; retry needs reset true", () => {
    const s = path3();
    expect(s).toMatch(/error[^\n]*verbatim|verbatim[^\n]*error/i);
    expect(s).toMatch(/rks_governor_init/);
    expect(s).toMatch(/reset:?\s*`?true/i);
  });
  it("pushes with rks_git_push and reports SHA, committedPaths and push result from tool output only", () => {
    const s = path3();
    expect(s).toContain("rks_git_push");
    expect(s).toMatch(/committedPaths/);
    expect(s).toMatch(/SHA/i);
    expect(s).toMatch(/(from|only from)[^\n]*tool (output|response)/i);
  });
});
