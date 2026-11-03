import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(fileURLToPath(import.meta.url), "../../..");
const NOTE_PATH = path.join(ROOT, "notes", "public.canon.build-path-analysis.md");

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

describe("canon.build-path-analysis.md — file exists", () => {
  it("notes/canon.build-path-analysis.md exists on disk", () => {
    expect(fs.existsSync(NOTE_PATH)).toBe(true);
  });
});

describe("canon.build-path-analysis.md — frontmatter", () => {
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
});

describe("canon.build-path-analysis.md — on-rail and off-rail sections", () => {
  it("defines on-rail build path", () => {
    expect(src).toMatch(/on-rail|on rail/i);
  });

  it("defines off-rail build path", () => {
    expect(src).toMatch(/off-rail|off rail/i);
  });

  it("explains what happens on each path", () => {
    expect(src).toMatch(/Build Governor/);
    expect(src).toMatch(/rks_guardrails_off/);
  });
});

describe("canon.build-path-analysis.md — MCP dogfood zone", () => {
  it("lists packages/mcp-rks/src/ as a dogfood zone path", () => {
    expect(src).toContain("packages/mcp-rks/src/");
  });

  it("lists .rks/prompts/ as a dogfood zone path", () => {
    expect(src).toContain(".rks/prompts/");
  });

  it("lists .routekit/hooks/ as a dogfood zone path", () => {
    expect(src).toContain(".routekit/hooks/");
  });

  it("lists .claude/ as a dogfood zone path", () => {
    expect(src).toContain(".claude/");
  });

  it("provides rationale for each dogfood pattern", () => {
    expect(src).toMatch(/circular|self-referential|depends on/i);
  });
});

describe("canon.build-path-analysis.md — guardrails system", () => {
  it("explains what guardrails enforce", () => {
    expect(src).toMatch(/guardrails/i);
    expect(src).toMatch(/enforce|intercept/i);
  });

  it("explains how off/on toggling works", () => {
    expect(src).toMatch(/rks_guardrails_off/);
    expect(src).toMatch(/rks_guardrails_on/);
  });
});

describe("canon.build-path-analysis.md — offRail config", () => {
  it("documents the enabled field", () => {
    expect(src).toMatch(/`?enabled`?/);
  });

  it("documents the roots field", () => {
    expect(src).toMatch(/`?roots`?/);
  });

  it("shows the offRail config structure", () => {
    expect(src).toContain("offRail");
  });
});

describe("canon.build-path-analysis.md — decision table", () => {
  it("includes a markdown table mapping path patterns to build path", () => {
    expect(src).toMatch(/\|.*targetFile.*\||\|.*path.*\|/i);
  });

  it("table includes on-rail and off-rail columns or labels", () => {
    const tableSection = src.match(/\|[\s\S]+?\n\n/)?.[0] || "";
    expect(tableSection).toMatch(/[Oo]n-rail|[Oo]ff-rail/);
  });
});

describe("canon.build-path-analysis.md — cross-references", () => {
  it("contains a cross-reference to canon.getting-started", () => {
    expect(src).toMatch(/canon\.getting-started/);
  });

  it("contains a cross-reference to canon.what-is-rks", () => {
    expect(src).toMatch(/canon\.what-is-rks/);
  });
});
