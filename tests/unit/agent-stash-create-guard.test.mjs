/**
 * backlog.fix.agent-stash-create-containment — the git agent must not CREATE a stash.
 *
 * A stash created inside the git agent has no restore path. Agent tools receive no session
 * token (runner.mjs invokes `tool.execute(toolUse.input)` with arguments only), so
 * setPendingStash cannot be registered and endSession's auto-pop never fires. In the field this
 * abandoned a tracked file's +323-line uncommitted diff for eight days on a since-deleted
 * branch, while the agent's model-authored summary said the files "remain in that state".
 *
 * WHY THE OBVIOUS TEST PROVES NOTHING. The tool's `inputSchema` is ADVISORY: runner.mjs does no
 * per-tool zod validation, and runGitStash defaults `action` to 'save'. So asserting the enum no
 * longer lists 'save' passes while a model that simply OMITS `action` still creates a stash.
 * Every load-bearing case below therefore drives execute() and asserts BOTH a refusal shape AND
 * a zero call count on the real runGitStash.
 *
 * MOCK TARGET IS LOAD-BEARING. agents/git.mjs imports runGitStash from
 * '../server/git-tools.mjs', which re-exports it from './git/git-core.mjs'. Mocking git-core
 * directly would not intercept, and every "zero calls" assertion would be vacuously true.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../packages/mcp-rks/src/server/git-tools.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runGitStash: vi.fn(async () => ({ ok: true, action: "save" })) };
});

const { runGitStash } = await import("../../packages/mcp-rks/src/server/git-tools.mjs");
const { createGitAgent } = await import("../../packages/mcp-rks/src/agents/git.mjs");

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function stashTool() {
  const agent = createGitAgent({ projectRoot: "/tmp/does-not-need-to-exist" });
  const tool = agent.tools.find((t) => t.name === "git_stash");
  expect(tool, "git_stash tool is not registered — the rest of this file is meaningless").toBeTruthy();
  return tool;
}

describe("the git agent cannot create a stash", () => {
  beforeEach(() => { runGitStash.mockClear(); });

  // The four inputs a model can actually produce. `{}` is the one the enum cannot stop.
  it.each([
    ["omitted action (falls through to runGitStash's 'save' default)", {}],
    ["explicit save", { action: "save" }],
    ["push, git's own spelling", { action: "push" }],
    ["save with a message, the shape seen in the field", { action: "save", message: "wip" }],
  ])("refuses %s, and calls runGitStash ZERO times", async (_label, input) => {
    const res = await stashTool().execute(input);

    // Refusal must be a SHAPE a caller can distinguish, not prose. A bare string is
    // type-indistinguishable from a success summary — the failure this story exists to fix.
    expect(res.ok, "refusal must carry ok:false as a FIELD").toBe(false);
    expect(typeof res.error).toBe("string");
    expect(typeof res.hint).toBe("string");

    // THE load-bearing assertion. A refusal that still stashed would satisfy everything above.
    expect(runGitStash, "refused but still created a stash").toHaveBeenCalledTimes(0);
  });

  it("SURVIVOR CONTROL — pop and list still reach runGitStash", async () => {
    // Proves the guard is action-scoped rather than a blanket disable, and that the mock
    // genuinely intercepts. Without this, every zero above could be a dead harness.
    const tool = stashTool();
    await tool.execute({ action: "pop" });
    expect(runGitStash).toHaveBeenCalledTimes(1);
    await tool.execute({ action: "list" });
    expect(runGitStash).toHaveBeenCalledTimes(2);
  });

  it("the refusal names both remedies a caller can actually take", async () => {
    const res = await stashTool().execute({ action: "save" });
    expect(res.hint).toMatch(/rks_git_commit/);
    expect(res.hint).toMatch(/rks_stash/);
  });

  it("SECONDARY (not sufficient alone): the enum no longer advertises creation", () => {
    // Documentation-level only. The runtime guard above is the containment; this would pass
    // on an implementation that changed the enum and nothing else.
    const shape = stashTool().inputSchema.shape;
    const values = shape.action?._def?.values ?? [];
    expect(values).not.toContain("save");
    expect(values).toEqual(expect.arrayContaining(["pop", "list", "apply", "drop"]));
  });

  it("the agent PROMPT does not advertise a capability the tool refuses", () => {
    // .rks/prompts/agent-git.md listed git_stash as "stash, pop, list, or apply" — the model
    // read that as permission and acted on it.
    const prompt = fs.readFileSync(path.join(PROJECT_ROOT, ".rks/prompts/agent-git.md"), "utf8");
    const line = prompt.split("\n").find((l) => l.includes("git_stash"));
    expect(line, "no git_stash line in the prompt").toBeTruthy();
    expect(line).not.toMatch(/\bstash,\s*pop\b/);
    expect(line).toMatch(/cannot CREATE|not create/i);
  });
});
