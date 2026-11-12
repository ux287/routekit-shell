// backlog.fix.rag-embed-server-stale-module-unreported: commitAndEmbed surfaces a stale-embed-code
// warning as ragEmbedWarning even though the embed result is ok.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process");
vi.mock("@routekit/rag/tools");

import { execSync, execFileSync } from "node:child_process";
import { runRagEmbed } from "@routekit/rag/tools";
import { commitAndEmbed } from "../../packages/mcp-rks/src/shared/commit-and-embed.mjs";

const FAKE_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const GUARD_VARS = ["VITEST", "RKS_SKIP_BACKGROUND_EMBED"];
const saved = {};

function setupGit() {
  execFileSync
    .mockReturnValueOnce(undefined) // git commit
    .mockReturnValueOnce("notes/foo.md\n"); // git diff-tree --root <sha>
  execSync.mockReturnValueOnce(`${FAKE_SHA}\n`); // git rev-parse HEAD
}

describe("commitAndEmbed stale embed code warning", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const k of GUARD_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of GUARD_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("sets ragEmbedWarning from the warning when an ok embed result carries embedCodeStale true", async () => {
    setupGit();
    const warning = "embed code on disk is newer than the loaded code; restart the MCP server";
    runRagEmbed.mockResolvedValueOnce({ ok: true, embedCodeStale: true, warning });
    const result = await commitAndEmbed("/proj", "test message");
    expect(runRagEmbed).toHaveBeenCalledTimes(1);
    expect(result.commitId).toBe(FAKE_SHA);
    expect(result.ragEmbedWarning).toBe(warning);
  });

  it("does not set ragEmbedWarning on a fresh ok result", async () => {
    setupGit();
    runRagEmbed.mockResolvedValueOnce({ ok: true, embedCodeStale: false });
    const result = await commitAndEmbed("/proj", "test message");
    expect(runRagEmbed).toHaveBeenCalledTimes(1);
    expect(result.ragEmbedWarning).toBeUndefined();
  });

  it("sets ragEmbedWarning from the warning when an ok embed result carries embedCodeStale null", async () => {
    setupGit();
    const warning = "could not determine whether the embed ran current embed code: simulated EACCES";
    runRagEmbed.mockResolvedValueOnce({
      ok: true,
      embedCodeStale: null,
      embedCodeStaleReason: "simulated EACCES",
      warning,
    });
    const result = await commitAndEmbed("/proj", "test message");
    expect(runRagEmbed).toHaveBeenCalledTimes(1);
    expect(result.commitId).toBe(FAKE_SHA);
    expect(result.ragEmbedWarning).toBe(warning);
  });
});
