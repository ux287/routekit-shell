/**
 * backlog.fix.commit-trailer-hardcodes-stale-model-name
 * coAuthorTrailer is the single trailer rule, and no rks code site hardcodes a model name.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { coAuthorTrailer } from "../../packages/mcp-rks/src/shared/commit-attribution.mjs";
import { readServerSurfaceSource } from "../_helpers/server-source.mjs";

describe("coAuthorTrailer", () => {
  it("returns a trailer for a well-formed Name <email>", () => {
    expect(coAuthorTrailer("X <x@example.com>")).toBe("\n\nCo-Authored-By: X <x@example.com>");
  });

  it("trims surrounding whitespace", () => {
    expect(coAuthorTrailer("  X <x@example.com>  ")).toBe("\n\nCo-Authored-By: X <x@example.com>");
  });

  it.each([
    [undefined],
    [null],
    [""],
    [42],
    ["X <x@example.com>\nInjected: y"],
    ["X\r <x@example.com>"],
    ["x@example.com"],
    ["X"],
    ["<x@example.com>"],
    ["X <not-an-email>"],
  ])("returns an empty string for %j", (value) => {
    expect(coAuthorTrailer(value)).toBe("");
  });
});

describe("no hardcoded model attribution in rks commit sites", () => {
  const SERVER_ENTRY = "packages/mcp-rks/src/server.mjs";
  const files = [
    "packages/mcp-rks/src/server/git/git-workflow.mjs",
    "packages/mcp-rks/src/server/guardrails-audit.mjs",
    SERVER_ENTRY,
  ];
  it.each(files)("%s has no literal Co-Authored-By: Claude trailer", (rel) => {
    // The server.mjs entry covers the whole tool surface, so code moved into
    // server/handlers/ stays inside these negative assertions.
    const src =
      rel === SERVER_ENTRY ? readServerSurfaceSource() : fs.readFileSync(path.resolve(rel), "utf8");
    expect(src).not.toContain("Co-Authored-By: Claude");
    expect(src).not.toContain("Auto-appends Co-Authored-By.");
  });
});
