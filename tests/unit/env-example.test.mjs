import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../../..");
const src = readFileSync(join(ROOT, ".env.example"), "utf8");
const lines = src.split("\n");
const lastNonEmpty = [...lines].reverse().find(l => l.trim() !== "");

describe(".env.example — structure", () => {
  it("ends with a comment reminding users not to commit .env", () => {
    expect(lastNonEmpty).toMatch(/^#/);
    expect(lastNonEmpty).toMatch(/commit|\.env/i);
  });

  it("contains no non-empty values for API key or token variables", () => {
    const keyVars = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "BRAVE_SEARCH_API_KEY",
      "GITHUB_TOKEN",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
    ];
    for (const varName of keyVars) {
      const valueLine = lines.find(
        l => !l.trimStart().startsWith("#") && l.startsWith(varName + "=") && l.split("=")[1]?.trim() !== ""
      );
      expect(valueLine, `${varName} should have empty value`).toBeUndefined();
    }
  });

  it("contains no placeholder credential strings", () => {
    expect(src).not.toMatch(/your-key-here|sk-\w+|ghp_\w+/);
  });
});

describe(".env.example — runtime variable names", () => {
  it("contains ROUTEKIT_LLM_PROVIDER (read by packages/mcp-rks/src/llm/clients.mjs)", () => {
    expect(src).toContain("ROUTEKIT_LLM_PROVIDER");
  });

  it("contains ROUTEKIT_LLM_MODEL (read by packages/mcp-rks/src/llm/clients.mjs)", () => {
    expect(src).toContain("ROUTEKIT_LLM_MODEL");
  });

  it("contains ANTHROPIC_API_KEY (used for provider inference)", () => {
    expect(src).toContain("ANTHROPIC_API_KEY");
  });

  it("contains OPENAI_API_KEY (used for provider inference)", () => {
    expect(src).toContain("OPENAI_API_KEY");
  });
});
