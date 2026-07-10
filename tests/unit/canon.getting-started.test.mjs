import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(fileURLToPath(import.meta.url), "../../..");
const NOTE_PATH = path.join(ROOT, "notes", "canon.getting-started.md");

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

describe("canon.getting-started.md — file exists", () => {
  it("notes/canon.getting-started.md exists on disk", () => {
    expect(fs.existsSync(NOTE_PATH)).toBe(true);
  });
});

describe("canon.getting-started.md — frontmatter", () => {
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

describe("canon.getting-started.md — required sections", () => {
  it("contains a prerequisites section", () => {
    expect(src).toMatch(/prerequisites/i);
  });

  it("contains an installation section", () => {
    expect(src).toMatch(/installation|install/i);
  });

  it("contains a project init section", () => {
    expect(src).toMatch(/init|initialize|project init/i);
  });

  it("contains a configure project section", () => {
    expect(src).toMatch(/configure|configuration/i);
  });

  it("contains a first story section", () => {
    expect(src).toMatch(/first story|first build|create.*story/i);
  });

  it("contains a verify section", () => {
    expect(src).toMatch(/verify|verif/i);
  });
});

describe("canon.getting-started.md — command examples", () => {
  it("contains literal command strings in code blocks", () => {
    expect(src).toMatch(/```/);
    expect(src).toMatch(/```bash|```json/);
  });

  it("contains the cp .env.example .env command", () => {
    expect(src).toContain("cp .env.example .env");
  });
});

describe("canon.getting-started.md — .env setup", () => {
  it("references .env.example as the starting point", () => {
    expect(src).toContain(".env.example");
  });

  it("mentions ANTHROPIC_API_KEY", () => {
    expect(src).toContain("ANTHROPIC_API_KEY");
  });
});

describe("canon.getting-started.md — skill commands", () => {
  it("references the /po skill command", () => {
    expect(src).toMatch(/\/po\b/);
  });

  it("references the /qa skill command", () => {
    expect(src).toMatch(/\/qa\b/);
  });

  it("references the /arch skill command", () => {
    expect(src).toMatch(/\/arch\b/);
  });

  it("references the /build skill command", () => {
    expect(src).toMatch(/\/build\b/);
  });
});

describe("canon.getting-started.md — cross-references", () => {
  it("contains a cross-reference to canon.what-is-rks", () => {
    expect(src).toMatch(/canon\.what-is-rks/);
  });

  it("contains a cross-reference to canon.build-path-analysis", () => {
    expect(src).toMatch(/canon\.build-path-analysis/);
  });
});

describe("canon.getting-started.md — word count", () => {
  it("word count is between 600 and 1500 words", () => {
    const words = countWords(src);
    expect(words).toBeGreaterThanOrEqual(600);
    expect(words).toBeLessThanOrEqual(1500);
  });
});
