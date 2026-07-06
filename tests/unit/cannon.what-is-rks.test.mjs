import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(fileURLToPath(import.meta.url), "../../..");
const NOTE_PATH = path.join(ROOT, "notes", "canon.what-is-rks.md");

let src;
try {
  src = fs.readFileSync(NOTE_PATH, "utf-8");
} catch {
  src = "";
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":");
    if (key && rest.length) fm[key.trim()] = rest.join(":").trim().replace(/^["']|["']$/g, "");
  }
  return fm;
}

function countWords(text) {
  const body = text.replace(/^---[\s\S]*?---/, "").trim();
  return body.split(/\s+/).filter(Boolean).length;
}

describe("canon.what-is-rks.md — file exists", () => {
  it("notes/canon.what-is-rks.md exists on disk", () => {
    expect(fs.existsSync(NOTE_PATH)).toBe(true);
  });
});

describe("canon.what-is-rks.md — frontmatter", () => {
  const fm = parseFrontmatter(src);

  it("has id field", () => {
    expect(fm.id).toBeTruthy();
  });

  it("has title field", () => {
    expect(fm.title).toBeTruthy();
  });

  it("has desc field", () => {
    expect(fm.desc).toBeTruthy();
  });

  it("has created field", () => {
    expect(fm.created).toBeTruthy();
  });

  it("has updated field", () => {
    expect(fm.updated).toBeTruthy();
  });
});

describe("canon.what-is-rks.md — content requirements", () => {
  it("first paragraph explains what rks is in plain language", () => {
    const body = src.replace(/^---[\s\S]*?---/, "").trim();
    const firstParagraph = body.split(/\n\n/)[0];
    expect(firstParagraph).toMatch(/RouteKit Shell|rks is/i);
    expect(firstParagraph.split(/\s+/).length).toBeGreaterThan(20);
  });

  it("contains a section explaining the problem rks solves", () => {
    expect(src).toMatch(/problem|solves/i);
    expect(src).toMatch(/unstructured|auditability gap/i);
  });

  it("mentions the auditability gap", () => {
    expect(src).toMatch(/auditability gap/i);
  });

  it("describes the Governor/story/pipeline model", () => {
    expect(src).toMatch(/Governor/);
    expect(src).toMatch(/[Ss]tory|[Ss]tories/);
    expect(src).toMatch(/pipeline/i);
  });

  it("includes a flow diagram or table showing pipeline phases", () => {
    expect(src).toMatch(/\|.*\|.*\|/);
  });

  it("defines the term Governor", () => {
    expect(src).toMatch(/\*\*Governor\*\*|Governor[^\w]/);
    expect(src.indexOf("**Governor**")).toBeGreaterThan(-1);
  });

  it("defines the term story", () => {
    expect(src).toMatch(/\*\*[Ss]tor(y|ies)\*\*/);
  });

  it("defines the term pipeline phase", () => {
    expect(src).toMatch(/\*\*[Pp]ipeline phase\*\*/);
  });

  it("defines the term guardrails", () => {
    expect(src).toMatch(/\*\*[Gg]uardrails\*\*/);
  });

  it("defines the term MCP tools", () => {
    expect(src).toMatch(/\*\*MCP tools\*\*/);
  });

  it("defines the term Dispatcher", () => {
    expect(src).toMatch(/\*\*[Dd]ispatcher\*\*/);
  });

  it("contains a cross-reference to canon.getting-started", () => {
    expect(src).toMatch(/canon\.getting-started/);
  });

  it("word count is between 400 and 800 words", () => {
    const words = countWords(src);
    expect(words).toBeGreaterThanOrEqual(400);
    expect(words).toBeLessThanOrEqual(800);
  });
});
