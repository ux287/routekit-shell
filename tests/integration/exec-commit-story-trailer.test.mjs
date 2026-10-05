/**
 * Witness for backlog.fix.exec-commit-missing-story-trailer.
 *
 * runGitCommit gains an optional storyId. When given, the commit carries a line-exact
 * `Story: <storyId>` trailer in the same trailer block as Co-Authored-By; when absent the
 * message is byte-identical to the pre-change format. The end-to-end cases prove that an
 * exec-shaped commit merged into the integration branch BY HAND is accepted as evidence by
 * repairPhaseToIntegrated: with the trailer it is admitted as `form: "trailer"`; without it, only
 * a subject that is exactly `feat(exec): <id>` is admitted (`form: "legacy_exec_subject"`), and
 * any other trailerless subject is refused.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Mock only the embedding step, never commitAndEmbed: the real git commit must run.
vi.mock("@routekit/rag/tools", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
}));

import { runGitCommit } from "../../packages/mcp-rks/src/server/git/git-workflow.mjs";
import { repairPhaseToIntegrated } from "../../packages/mcp-rks/src/workflow/auto-phase.mjs";

const { isDiffPartialForStory } = await import("../../packages/mcp-rks/src/server/review.mjs");

const TIMEOUT = 20_000;
const g = (cwd, args, extra = {}) =>
  execFileSync("git", args, { cwd, encoding: "utf8", timeout: TIMEOUT, ...extra });
const CO_AUTHOR = "Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>";

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-exec-trailer-"));
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  g(root, ["init", "-b", "staging"]);
  g(root, ["config", "user.email", "t@t"]);
  g(root, ["config", "user.name", "t"]);
  g(root, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(root, "init.txt"), "init\n");
  g(root, ["add", "-A"]);
  g(root, ["commit", "-m", "init"]);
  g(root, ["checkout", "-b", "rks/exec-branch"]);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const headBody = () => g(root, ["log", "-1", "--format=%B"]);
const headLines = () => headBody().split("\n").map((l) => l.trim());

function writeStory(id, phase) {
  fs.writeFileSync(
    path.join(root, "notes", `${id}.md`),
    `---\nid: "${id}"\ntitle: "T"\ncreated: 1\nupdated: 2\nphase: "${phase}"\n---\n\n## Problem\n\nbody\n`,
  );
}
const phaseOf = (id) =>
  /phase:\s*"([^"]+)"/.exec(fs.readFileSync(path.join(root, "notes", `${id}.md`), "utf8"))?.[1];

/** An exec-shaped commit, produced by the real runGitCommit exactly as exec.mjs calls it. */
async function execCommit({ message, storyId, omitStoryId = false }) {
  const file = `src-${Math.random().toString(36).slice(2)}.mjs`;
  fs.writeFileSync(path.join(root, file), "// work\n");
  const args = { projectRoot: root, message, scope: "exec", type: "feat", files: [file] };
  if (!omitStoryId) args.storyId = storyId;
  const res = await runGitCommit(args);
  expect(res.ok).toBe(true);
  return g(root, ["rev-parse", "HEAD"]).trim();
}

/** The manual merge the peer performed: exec branch merged into the integration branch by hand. */
function manualMergeToStaging() {
  g(root, ["checkout", "staging"]);
  g(root, ["merge", "--no-ff", "rks/exec-branch", "-m", "manual merge"]);
}

const repair = (id) => repairPhaseToIntegrated(root, id, "p", { integrationBranch: "staging" });

describe("runGitCommit Story trailer", { timeout: 30_000 }, () => {
  it("appends a line-exact Story trailer when storyId is given", async () => {
    const id = "backlog.fix.some-story";
    await execCommit({ message: id, storyId: id });
    const lines = headLines();
    expect(lines[0]).toBe(`feat(exec): ${id}`);
    expect(lines).toContain(`Story: ${id}`);
    expect(lines).toContain(CO_AUTHOR);
  });

  it("places Story in the same trailer block as Co-Authored-By", async () => {
    const id = "backlog.fix.some-story";
    await execCommit({ message: id, storyId: id });
    const trailers = g(root, ["interpret-trailers", "--parse"], { input: headBody() });
    expect(trailers).toContain(`Story: ${id}`);
    expect(trailers).toContain(CO_AUTHOR);
  });

  it("produces exactly today's message when storyId is omitted", async () => {
    await execCommit({ message: "some-slug", omitStoryId: true });
    expect(headBody().trimEnd()).toBe(`feat(exec): some-slug\n\n${CO_AUTHOR}`);
  });

  it.each([[undefined], [null], [""]])("carries no Story line when storyId is %s (slug-only exec)", async (storyId) => {
    await execCommit({ message: "some-slug", storyId });
    expect(headLines().some((l) => l.startsWith("Story:"))).toBe(false);
    expect(headBody().trimEnd()).toBe(`feat(exec): some-slug\n\n${CO_AUTHOR}`);
  });
});

describe("rks_phase_repair evidence after a manual merge of an exec commit", { timeout: 30_000 }, () => {
  it("accepts the merged exec commit as evidence for a story at executed", async () => {
    const id = "backlog.fix.exec-shipped-by-hand";
    const sha = await execCommit({ message: id, storyId: id });
    manualMergeToStaging();
    writeStory(id, "executed");

    const res = await repair(id);

    expect(res.reason).not.toBe("no_merged_commit_for_story");
    expect(res.ok).toBe(true);
    expect(res.repaired).toBe(true);
    expect(res.evidence.commit).toBe(sha);
    expect(res.evidence.form).toBe("trailer");
    expect(phaseOf(id)).toBe("integrated");
  });

  it("CONTROL: the same merged exec commit without the trailer is admitted by its exact legacy subject", async () => {
    const id = "backlog.fix.exec-shipped-by-hand";
    const sha = await execCommit({ message: id, omitStoryId: true });
    // Fixture shape: no Story line at all, and the subject is exactly the legacy exec subject.
    expect(headLines().some((l) => l.startsWith("Story:"))).toBe(false);
    expect(headLines()[0]).toBe(`feat(exec): ${id}`);
    manualMergeToStaging();
    writeStory(id, "executed");

    const res = await repair(id);

    expect(res.ok).toBe(true);
    expect(res.repaired).toBe(true);
    expect(res.evidence.form).toBe("legacy_exec_subject");
    expect(res.evidence.commit).toBe(sha);
    expect(phaseOf(id)).toBe("integrated");
  });

  it("CONTROL: a merged trailerless exec commit whose subject is not the story's legacy subject is refused", async () => {
    const id = "backlog.fix.exec-shipped-by-hand";
    await execCommit({ message: "some-other-slug", omitStoryId: true });
    expect(headLines()[0]).toBe("feat(exec): some-other-slug");
    manualMergeToStaging();
    writeStory(id, "executed");

    const res = await repair(id);

    expect(res.reason).toBe("no_merged_commit_for_story");
    expect(phaseOf(id)).toBe("executed");
  });

  it("REFUSES a story id that is a strict prefix of the merged exec commit's story id", async () => {
    const prefix = "backlog.fix.foo";
    const longer = "backlog.fix.foo.child";
    await execCommit({ message: longer, storyId: longer });
    manualMergeToStaging();
    writeStory(prefix, "executed");

    const res = await repair(prefix);

    expect(res.reason).toBe("no_merged_commit_for_story");
    expect(phaseOf(prefix)).toBe("executed");
  });
});

describe("isDiffPartialForStory matches the Story trailer line-exactly", { timeout: 30_000 }, () => {
  it("POSITIVE CONTROL: the exact trailer on the target branch reports a partial diff", async () => {
    const id = "backlog.fix.foo.child";
    await execCommit({ message: id, storyId: id });
    manualMergeToStaging();
    expect(isDiffPartialForStory(root, "staging", id)).toBe(true);
  });

  it("REFUSES a story id that is a strict prefix of a merged trailer's id", async () => {
    const longer = "backlog.fix.foo.child";
    await execCommit({ message: longer, storyId: longer });
    manualMergeToStaging();
    expect(isDiffPartialForStory(root, "staging", "backlog.fix.foo")).toBe(false);
  });

  it("does not treat a dot in the story id as a wildcard", async () => {
    const other = "backlog.fix.aXb";
    await execCommit({ message: other, storyId: other });
    manualMergeToStaging();
    expect(isDiffPartialForStory(root, "staging", "backlog.fix.a.b")).toBe(false);
  });

  it("keeps its failure semantics", () => {
    expect(isDiffPartialForStory(root, "staging", null)).toBe(false);
    expect(isDiffPartialForStory(root, null, "backlog.fix.x")).toBe(false);
    expect(isDiffPartialForStory(root, "no-such-ref-xyz", "backlog.fix.x")).toBe(true);
  });
});

describe("exec call site", () => {
  it("passes plan.problemId as storyId to runGitCommit", () => {
    const src = fs.readFileSync(
      path.resolve("packages/mcp-rks/src/server/exec.mjs"),
      "utf8",
    );
    expect(src).toMatch(/runGitCommit\(\{[^}]*storyId:\s*plan\.problemId[^}]*\}\)/);
  });
});
