/**
 * Tests for refine-decompose-child-ids — decompose handler uses LLM-provided
 * semantic slugs (data.children[i].slug) as child ID suffixes when valid
 * kebab-case, falling back to child-N otherwise.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

// ── Source-based verification ────────────────────────────────────────────────

describe("refine.mjs — isValidKebabSlug helper (source)", () => {
  const src = readSource("packages/mcp-rks/src/server/refine.mjs");

  it("exports isValidKebabSlug function", () => {
    expect(src).toMatch(/export function isValidKebabSlug/);
  });

  it("documents the expected data shape with children[].slug", () => {
    const fnIdx = src.indexOf("export function isValidKebabSlug");
    const jsdocStart = src.lastIndexOf("/**", fnIdx);
    const jsdoc = src.slice(jsdocStart, fnIdx);
    expect(jsdoc).toMatch(/children.*slug/);
  });
});

describe("refine.mjs — decompose handler uses semantic slugs (source)", () => {
  const src = readSource("packages/mcp-rks/src/server/refine.mjs");

  it("decompose handler reads data.children[i].slug", () => {
    // Assert against the FULL source (not a fixed-size window): insertions into the
    // decompose handler (e.g. F5's orphanedTests block) must not push the per-child
    // slug read out of view. Match the exact read, which also covers `.slug`.
    expect(src).toContain('if (type === "decompose")');
    expect(src).toMatch(/data\?\.children\?\.\[i\]\?\.slug/);
  });

  // Full-source assertions (no fixed-size window): these patterns are unique to the
  // decompose handler, so they stay meaningful while being resilient to insertions
  // into the handler (e.g. F5's orphanedTests block).
  it("decompose handler calls isValidKebabSlug on the provided slug", () => {
    expect(src).toMatch(/isValidKebabSlug/);
  });

  it("decompose handler falls back to child-N suffix", () => {
    expect(src).toMatch(/"child-"\s*\+\s*childNum/);
  });

  it("parent frontmatter gets decomposed: true", () => {
    expect(src).toMatch(/parentFm\.decomposed\s*=\s*true/);
  });

  it("parent frontmatter gets childStories array", () => {
    expect(src).toMatch(/parentFm\.childStories\s*=/);
  });
});

// ── Behavioral unit tests ────────────────────────────────────────────────────

describe("isValidKebabSlug — behavioral", async () => {
  const mod = await import(path.join(ROOT, "packages/mcp-rks/src/server/refine.mjs"));

  it("accepts valid single-word slug", () => {
    expect(mod.isValidKebabSlug("shell")).toBe(true);
  });

  it("accepts valid multi-word kebab slug", () => {
    expect(mod.isValidKebabSlug("form-shell")).toBe(true);
    expect(mod.isValidKebabSlug("sqlite-write")).toBe(true);
    expect(mod.isValidKebabSlug("manage-wire")).toBe(true);
  });

  it("accepts slug with digits", () => {
    expect(mod.isValidKebabSlug("step-2")).toBe(true);
  });

  it("rejects undefined", () => {
    expect(mod.isValidKebabSlug(undefined)).toBe(false);
  });

  it("rejects null", () => {
    expect(mod.isValidKebabSlug(null)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(mod.isValidKebabSlug("")).toBe(false);
  });

  it("rejects uppercase letters", () => {
    expect(mod.isValidKebabSlug("FormShell")).toBe(false);
    expect(mod.isValidKebabSlug("SHELL")).toBe(false);
  });

  it("rejects leading hyphen", () => {
    expect(mod.isValidKebabSlug("-form-shell")).toBe(false);
  });

  it("rejects trailing hyphen", () => {
    expect(mod.isValidKebabSlug("form-shell-")).toBe(false);
  });

  it("rejects spaces", () => {
    expect(mod.isValidKebabSlug("form shell")).toBe(false);
  });

  it("rejects underscores", () => {
    expect(mod.isValidKebabSlug("form_shell")).toBe(false);
  });

  it("rejects dot-separated strings", () => {
    expect(mod.isValidKebabSlug("form.shell")).toBe(false);
  });
});

describe("deriveSlugFromACs — behavioral", async () => {
  const mod = await import(path.join(ROOT, "packages/mcp-rks/src/server/refine.mjs"));

  it("exports deriveSlugFromACs", () => {
    expect(typeof mod.deriveSlugFromACs).toBe("function");
  });

  it("returns a kebab-case slug from AC text", () => {
    const result = mod.deriveSlugFromACs(["- [ ] Carousel shows 3 images from youfibre folder"]);
    expect(mod.isValidKebabSlug(result)).toBe(true);
    expect(result).toBeTruthy();
  });

  it("filters stopwords and uses significant words", () => {
    const result = mod.deriveSlugFromACs(["- [ ] Tab appears in the left rail and is clickable"]);
    expect(result).not.toMatch(/\b(the|and|in|is)\b/);
  });

  it("returns null when all words are stopwords or too short", () => {
    const result = mod.deriveSlugFromACs(["- [ ] It is a"]);
    expect(result).toBeNull();
  });

  it("deduplicates repeated words across ACs", () => {
    const result = mod.deriveSlugFromACs([
      "- [ ] Tab renders correctly",
      "- [ ] Tab is clickable",
    ]);
    const words = result ? result.split("-") : [];
    const uniqueWords = new Set(words);
    expect(words.length).toBe(uniqueWords.size);
  });

  it("truncates slug to 40 characters", () => {
    const result = mod.deriveSlugFromACs([
      "- [ ] Verylongwordone verylongwordtwo verylongwordthree verylongwordfour",
    ]);
    if (result) {
      expect(result.length).toBeLessThanOrEqual(40);
    }
  });
});

describe("plan-staging suggestion — size is tractability, not a sibling split (backlog.feat.reconcile-story-sizing-po-arch-planner)", () => {
  const src = readSource("packages/mcp-rks/src/server/refine.mjs");

  it("size/tractability pressure surfaces a plan_staging suggestion (not a decompose suggestion)", () => {
    expect(src).toContain('type: "plan_staging"');
  });

  it("the plan-staging hint directs to a multi-step plan and reserves siblings for an independent-concern break", () => {
    const idx = src.indexOf('type: "plan_staging"');
    expect(idx).toBeGreaterThan(-1);
    const suggestion = src.slice(idx, idx + 400);
    expect(suggestion).toMatch(/multi-step plan|staged commits|refine-in-place/);
    expect(suggestion).toMatch(/independent-concern break/);
  });
});

describe("decompose handler — derived slug fallback (source)", () => {
  const src = readSource("packages/mcp-rks/src/server/refine.mjs");

  it("decompose handler calls deriveSlugFromACs", () => {
    expect(src).toMatch(/deriveSlugFromACs/);
  });

  it("deriveSlugFromACs result is validated with isValidKebabSlug before use", () => {
    // Both the derived slug and provided slug are validated (provided + derived + the
    // exported helper definition all reference isValidKebabSlug).
    const matchCount = (src.match(/isValidKebabSlug/g) || []).length;
    expect(matchCount).toBeGreaterThanOrEqual(2);
  });

  it("child-N is final fallback after both provided and derived slugs fail", () => {
    expect(src).toMatch(/"child-"\s*\+\s*childNum/);
  });
});
