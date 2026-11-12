// backlog.feat.dendron-rename-note-wikilinks — pure unit tests for wikilinks.mjs
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseWikilinks, rewriteWikilinks, isValidNoteName } from "../../packages/mcp-rks/src/shared/wikilinks.mjs";

const MAP = new Map([["docs.a.b", "vendors.b"]]);

describe("rewriteWikilinks", () => {
  it("rewrites every covered form and preserves labels and anchors", () => {
    const src = "[[docs.a.b]] [[Label|docs.a.b]] [[docs.a.b#sec]] [[Label|docs.a.b#sec]] ![[docs.a.b]]";
    const { text, count } = rewriteWikilinks(src, MAP);
    expect(text).toBe("[[vendors.b]] [[Label|vendors.b]] [[vendors.b#sec]] [[Label|vendors.b#sec]] ![[vendors.b]]");
    expect(count).toBe(5);
  });

  it("does not rewrite prefix collisions or other notes", () => {
    const src = "[[docs.a.bc]] [[docs.a]] [[docs.a.b.c]] [[other.note]]";
    const r = rewriteWikilinks(src, MAP);
    expect(r).toEqual({ text: src, count: 0 });
    expect(r.text).toBe(src);
  });

  it("rewrites only the exact target when a prefix-collision link sits on the same line", () => {
    const src = "see [[docs.a.b]] and [[docs.a.bc]] and [[docs.a.b.c]]";
    expect(rewriteWikilinks(src, MAP)).toEqual({ text: "see [[vendors.b]] and [[docs.a.bc]] and [[docs.a.b.c]]", count: 1 });
  });

  it("skips fenced code blocks", () => {
    const src = "[[docs.a.b]]\n```\n[[docs.a.b]]\n```\n~~~\n[[docs.a.b]]\n~~~\n";
    const { text, count } = rewriteWikilinks(src, MAP);
    expect(text).toBe("[[vendors.b]]\n```\n[[docs.a.b]]\n```\n~~~\n[[docs.a.b]]\n~~~\n");
    expect(count).toBe(1);
  });

  it("a ~~~ line does not close a ``` fence, and an info string opens a fence", () => {
    const src = "```js\n[[docs.a.b]]\n~~~\n[[docs.a.b]]\n```\n[[docs.a.b]]";
    expect(rewriteWikilinks(src, MAP)).toEqual({ text: "```js\n[[docs.a.b]]\n~~~\n[[docs.a.b]]\n```\n[[vendors.b]]", count: 1 });
  });

  it("returns the input string itself and count 0 when nothing matches", () => {
    const src = "no links here, and [[other.note]] is not renamed";
    const r = rewriteWikilinks(src, MAP);
    expect(r.text === src).toBe(true);
    expect(r.count).toBe(0);
  });

  it("rewrites several renamed targets in one pass and counts each occurrence", () => {
    const map = new Map([["docs.a.b", "vendors.b"], ["docs.a.b.c", "vendors.b.c"]]);
    const src = "[[docs.a.b]] [[docs.a.b.c]] [[docs.a.b.c#x]]";
    expect(rewriteWikilinks(src, map)).toEqual({ text: "[[vendors.b]] [[vendors.b.c]] [[vendors.b.c#x]]", count: 3 });
  });
});

describe("parseWikilinks", () => {
  it("returns label, target, anchor and embed", () => {
    const [l] = parseWikilinks("![[Label|docs.a.b#sec]]");
    expect(l).toMatchObject({ embed: true, label: "Label", target: "docs.a.b", anchor: "#sec" });
  });

  it("returns the fields for each supported form", () => {
    const links = parseWikilinks("[[t]] [[L|t]] [[t#a]] [[L|t#a]] ![[t]]");
    expect(links.map(({ embed, label, target, anchor }) => ({ embed, label, target, anchor }))).toEqual([
      { embed: false, label: null, target: "t", anchor: null },
      { embed: false, label: "L", target: "t", anchor: null },
      { embed: false, label: null, target: "t", anchor: "#a" },
      { embed: false, label: "L", target: "t", anchor: "#a" },
      { embed: true, label: null, target: "t", anchor: null },
    ]);
  });
});

describe("isValidNoteName", () => {
  it("accepts dot-separated names and refuses separators, traversal, empty segments and .md", () => {
    expect(isValidNoteName("vendors.b")).toBe(true);
    expect(isValidNoteName("docs.a-b_c.d")).toBe(true);
    for (const bad of ["", "a/b", "a\\b", "..", "a..b", ".a", "a.", "a.md.", "a b", 42, null]) {
      expect(isValidNoteName(bad), String(bad)).toBe(false);
    }
  });
});

it("wikilinks.mjs has no filesystem import", () => {
  const src = fs.readFileSync(path.resolve("packages/mcp-rks/src/shared/wikilinks.mjs"), "utf8");
  expect(src).not.toMatch(/from\s+["'](node:)?fs["']/);
  expect(src).not.toMatch(/require\(\s*["'](node:)?fs["']\s*\)/);
  expect(src).not.toMatch(/import\(\s*["'](node:)?fs["']\s*\)/);
});
