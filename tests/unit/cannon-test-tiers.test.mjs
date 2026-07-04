import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(fileURLToPath(import.meta.url), "../../..");
const NOTE_PATH = path.join(ROOT, "notes", "canon.test-tiers.md");

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

describe("canon.test-tiers.md — file exists", () => {
  it("notes/canon.test-tiers.md exists on disk", () => {
    expect(fs.existsSync(NOTE_PATH)).toBe(true);
  });
});

describe("canon.test-tiers.md — frontmatter", () => {
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

describe("canon.test-tiers.md — tier overview table", () => {
  it("contains a markdown table with tier overview", () => {
    expect(src).toMatch(/\|.*[Tt]ier.*\|/);
  });

  it("table includes a 'when it runs' column or equivalent", () => {
    expect(src).toMatch(/[Ww]hen it runs|[Ww]hen/);
  });

  it("table includes a 'how to invoke' column or equivalent", () => {
    expect(src).toMatch(/[Hh]ow to invoke|[Ii]nvoke|[Rr]un command/i);
  });

  it("table includes all three tiers", () => {
    expect(src).toMatch(/[Uu]nit/);
    expect(src).toMatch(/[Mm]ock|[Ii]ntegration/);
    expect(src).toMatch(/[Ee]2[Ee]|[Ee]nd.to.[Ee]nd/i);
  });
});

describe("canon.test-tiers.md — unit tier section", () => {
  it("describes pure-logic scope for unit tests", () => {
    expect(src).toMatch(/pure logic|pure business logic|no I\/O|no filesystem/i);
  });

  it("documents tests/unit/ as the file location convention", () => {
    expect(src).toContain("tests/unit/");
  });

  it("includes the npx vitest run command", () => {
    expect(src).toMatch(/npx vitest run|vitest run/);
  });
});

describe("canon.test-tiers.md — mock/integration tier section", () => {
  it("describes MCP tool or server scope", () => {
    expect(src).toMatch(/MCP tool|server logic|mocked/i);
  });

  it("includes an integration invocation command", () => {
    expect(src).toMatch(/vitest\.config\.integration|--project integration/i);
  });
});

describe("canon.test-tiers.md — e2e tier section", () => {
  it("describes e2e scope with real credentials", () => {
    expect(src).toMatch(/real credential|real API|ANTHROPIC_API_KEY/i);
  });

  it("states e2e runs manually, not in automated builds", () => {
    expect(src).toMatch(/manually|not.*automated|never.*automated/i);
  });
});

describe("canon.test-tiers.md — testFiles frontmatter field", () => {
  it("documents the testFiles frontmatter field in story notes", () => {
    expect(src).toMatch(/testFiles|`testFiles`/);
  });

  it("explains what the testFiles field links to", () => {
    expect(src).toMatch(/testFiles[\s\S]{0,300}test file/i);
  });
});

describe("canon.test-tiers.md — concurrent vitest warning", () => {
  it("contains a warning against concurrent vitest instances", () => {
    expect(src).toMatch(/concurrent|simultaneous/i);
    expect(src).toMatch(/vitest/i);
  });

  it("explains the rationale for the warning", () => {
    expect(src).toMatch(/rg|ripgrep|CPU thrash|race condition|overlap/i);
  });
});

describe("canon.test-tiers.md — cross-reference", () => {
  it("contains a cross-reference to canon.getting-started", () => {
    expect(src).toMatch(/canon\.getting-started/);
  });
});
