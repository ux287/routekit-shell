import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../../..");
const src = readFileSync(join(ROOT, ".env.example"), "utf8");
const lines = src.split("\n");

describe(".env.example — header", () => {
  it("contains cp .env.example .env setup instruction", () => {
    expect(src).toContain("cp .env.example .env");
  });
});

describe(".env.example — OpenAI section header is a comment", () => {
  it("the 'If using OpenAI' line starts with #", () => {
    const openaiHeader = lines.find(l => l.includes("If using OpenAI"));
    expect(openaiHeader).toBeDefined();
    expect(openaiHeader.trimStart()).toMatch(/^#/);
  });
});

describe(".env.example — model", () => {
  it("sets ROUTEKIT_LLM_MODEL to claude-sonnet-4-6", () => {
    expect(src).toContain("ROUTEKIT_LLM_MODEL=claude-sonnet-4-6");
  });

  it("includes the Anthropic models docs URL", () => {
    expect(src).toContain("https://docs.anthropic.com/en/docs/about-claude/models/overview");
  });

  it("mentions Haiku and Opus for cost/quality range guidance", () => {
    expect(src).toMatch(/Haiku/);
    expect(src).toMatch(/Opus/);
  });
});

describe(".env.example — provider inference", () => {
  it("explains ROUTEKIT_LLM_PROVIDER is optional / inferred from API key", () => {
    expect(src).toMatch(/ROUTEKIT_LLM_PROVIDER is optional|infers the provider/i);
  });
});
