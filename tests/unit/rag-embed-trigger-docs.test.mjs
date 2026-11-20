/**
 * Witness for backlog.fix.rag-embed-unchanged-outcome-legibility (docs half).
 * Durable-phrase assertions on whitespace-normalized text, not fixed line windows.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");
const GUIDE = flat(read("notes/public.guide.rag-usage.md"));
const PROMPT = flat(read(".rks/prompts/governor-research.md"));

describe("embed trigger docs", () => {
  it("guide defines alreadyCurrent as manifest hash matches", () => {
    expect(GUIDE).toContain("alreadyCurrent");
    expect(GUIDE).toContain("manifest hash matches");
    expect(GUIDE).toMatch(/not re-?quer(y|ied)|does not re-?query|without re-?querying/i);
    expect(GUIDE).not.toMatch(/healthy/i);
  });

  it("embed source comment defines alreadyCurrent as manifest hash matches", () => {
    const SRC = read("packages/rag/src/embed.mjs");
    // Every occurrence of the phrase that sits on a comment line (// or block-comment *).
    const commentHits = [...SRC.matchAll(/^[ \t]*(?:\/\/|\/?\*)[^\n]*manifest hash matches/gm)].map(
      (m) => m.index + m[0].indexOf("manifest hash matches"),
    );
    expect(commentHits.length).toBeGreaterThan(0);
    const flags = [...SRC.matchAll(/alreadyCurrent/g)].map((m) => m.index);
    expect(flags.length).toBeGreaterThan(0);
    const near = commentHits.some((p) => flags.some((f) => Math.abs(f - p) < 600));
    expect(near).toBe(true);
  });

  it("guide drops the after-any-commit claims", () => {
    expect(GUIDE).not.toContain("fires after a git commit");
    expect(GUIDE).not.toContain("auto-runs after each commit");
  });

  it("guide names the three trigger paths", () => {
    expect(GUIDE).toContain("rks_rag_embed");
    expect(GUIDE).toContain("rag-embed-on-commit");
    expect(GUIDE).toContain("Claude Code");
    expect(GUIDE).toMatch(/MCP[^.]*commit/i);
  });

  it("guide states a terminal commit triggers no embed", () => {
    expect(GUIDE).toMatch(/terminal[^.]*(embeds nothing|no embed|not (trigger|invoke|run)[^.]*embed|nothing is embedded)/i);
  });

  it("research prompt no longer says post-commit hook", () => {
    expect(PROMPT).not.toContain("post-commit hook");
  });

  it("research prompt embed fallback names the Claude Code commit hook", () => {
    expect(PROMPT).toMatch(/Claude Code[^.]*commit`? hook/);
    expect(PROMPT).toMatch(/complete normally/);
  });

  it("guide trigger path 1 ends the ragEmbedSkipped parenthetical with a period", () => {
    expect(GUIDE).toContain("(the result then carries `ragEmbedSkipped: true`). A note write through the rks MCP tools");
    expect(GUIDE).not.toContain("`ragEmbedSkipped: true`), A note write");
  });

  it("guide trigger path 1 keeps its other sentences unchanged", () => {
    expect(GUIDE).toContain("it calls `runRagEmbed(projectRoot, { files: changedFiles })` for the files that commit changed. The embed is scoped to those files.");
    expect(GUIDE).toContain("It is skipped when `VITEST` or `RKS_SKIP_BACKGROUND_EMBED` is set");
    expect(GUIDE).toContain("(same `VITEST` / `RKS_SKIP_BACKGROUND_EMBED` skips); a write made with `skipEmbed` leaves the embed to the commit step.");
  });
});
