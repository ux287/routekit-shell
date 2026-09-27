import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../../..");
const src = readFileSync(join(ROOT, ".env.example"), "utf8");

describe(".env.example — BRAVE_SEARCH_API_KEY", () => {
  it("contains BRAVE_SEARCH_API_KEY as a commented-out variable", () => {
    expect(src).toMatch(/^#\s*BRAVE_SEARCH_API_KEY=/m);
  });

  it("includes a comment explaining what the key is for", () => {
    expect(src).toMatch(/Research Agent|web search|external lookup/i);
  });

  it("includes the URL https://brave.com/search/api/ in a comment", () => {
    expect(src).toContain("https://brave.com/search/api/");
  });
});

describe(".env.example — GITHUB_TOKEN", () => {
  it("contains GITHUB_TOKEN as a commented-out variable", () => {
    expect(src).toMatch(/^#\s*GITHUB_TOKEN=/m);
  });

  it("includes a comment mentioning PR creation and CI status polling", () => {
    expect(src).toMatch(/PR creation/i);
    expect(src).toMatch(/CI status|status polling/i);
  });
});

describe(".env.example — GITHUB_PERSONAL_ACCESS_TOKEN", () => {
  it("contains GITHUB_PERSONAL_ACCESS_TOKEN as a commented-out variable", () => {
    expect(src).toMatch(/^#\s*GITHUB_PERSONAL_ACCESS_TOKEN=/m);
  });

  it("includes guidance on when to use it versus GITHUB_TOKEN", () => {
    expect(src).toMatch(/GITHUB_TOKEN/);
    expect(src).toMatch(/GITHUB_PERSONAL_ACCESS_TOKEN/);
    expect(src).toMatch(/instead of|versus|vs/i);
  });
});
