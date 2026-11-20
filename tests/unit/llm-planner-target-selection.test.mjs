/**
 * runLlmPlanner selects its editable targets through selectStoryTargets.
 * Story: backlog.fix.target-extraction-prose-bullets-read-as-paths
 *
 * A non-empty passed-in editableTargets set is authoritative: path-leading body bullets
 * under ## Target Files are not added to it (fix-planner passes appliedFiles here). With no
 * passed-in targets, path-leading body bullets are the fallback. Observed through the paths
 * runLlmPlanner hands to loadEditableTargets, which is wrapped and delegates to the real
 * implementation. No network, no LLM, no subprocess: loadEnv and resolveBackend are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({ loadEditableTargets: vi.fn(), complete: vi.fn() }));

vi.mock("../../packages/mcp-rks/src/llm/clients.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadEnv: () => ({ provider: "anthropic", model: "claude-fixture", anthropicKey: "fixture-key", openaiKey: null }),
  };
});

vi.mock("../../packages/mcp-rks/src/llm/backend.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveBackend: () => ({ id: "anthropic", complete: (args) => h.complete(args) }) };
});

vi.mock("../../packages/mcp-rks/src/llm/targets.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadEditableTargets: (...args) => {
      h.loadEditableTargets(...args);
      return actual.loadEditableTargets(...args);
    },
  };
});

import { runLlmPlanner } from "../../packages/mcp-rks/src/llm/planner.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const NOTE_PLAN = JSON.stringify({ planSummary: "fixture", steps: [{ id: "n1", action: "note", content: "fixture note" }] });
const PROSE = "- Manual prerequisite, not targets: `scripts/tradier-switch.sh`, `scripts/x.sh`";

let root;
const savedSkip = process.env.RKS_SKIP_LLM;

beforeEach(() => {
  delete process.env.RKS_SKIP_LLM;
  h.loadEditableTargets.mockReset();
  h.complete.mockReset();
  h.complete.mockResolvedValue({ content: NOTE_PLAN, usage: null });
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-llm-planner-targets-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.mjs"), "export const a = 1;\n");
  fs.mkdirSync(path.join(root, ".rks", "runs", "fixture"), { recursive: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedSkip === undefined) delete process.env.RKS_SKIP_LLM;
  else process.env.RKS_SKIP_LLM = savedSkip;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

const requirementsWith = (bullets) =>
  ["## Problem", "", "Fixture.", "", "## Target Files", "", ...bullets, "", "## Acceptance Criteria", "", "- [ ] x", ""].join("\n");

/** Run the real runLlmPlanner and return the target paths it handed to loadEditableTargets. */
async function plannedPaths(editableTargets, bullets) {
  const text = requirementsWith(bullets);
  await runLlmPlanner({
    requirements: text,
    fullRequirements: text,
    context: "",
    editableTargets,
    runFolder: path.join(root, ".rks", "runs", "fixture"),
    useReplay: false,
    llmContext: { projectId: "fixture", problemId: "backlog.test-story" },
  });
  const call = h.loadEditableTargets.mock.calls.find(([projectRoot]) => projectRoot === root);
  expect(call).toBeDefined();
  return Array.from(call[1]);
}

describe("runLlmPlanner — target selection goes through selectStoryTargets", () => {
  it("a non-empty passed-in editableTargets set is authoritative: body-only path and prose bullets are not added", async () => {
    const paths = await plannedPaths(
      [{ path: "src/a.mjs", summary: "existing", content: "export const a = 1;\n" }],
      ["- `src/a.mjs` — EDIT — one", "- `src/body-only.mjs` — EDIT — extra", PROSE],
    );
    expect(paths).toEqual(["src/a.mjs"]);
  });

  it("an empty passed-in editableTargets falls back to path-leading body bullets, and the prose bullet is not one", async () => {
    const paths = await plannedPaths([], ["- `src/a.mjs` — EDIT — one", PROSE]);
    expect(paths).toEqual(["src/a.mjs"]);
  });
});

describe("source pins — neither planner site parses body bullets directly", () => {
  it("planner-context.mjs has no parseTargetsFromMarkdown( call and calls selectStoryTargets(", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/planner-context.mjs"), "utf8");
    expect(src.match(/parseTargetsFromMarkdown\(/g) || []).toHaveLength(0);
    expect(src).toMatch(/selectStoryTargets\(/);
  });

  it("llm/planner.mjs has no parseTargetsFromMarkdown( call and calls selectStoryTargets(", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/llm/planner.mjs"), "utf8");
    expect(src.match(/parseTargetsFromMarkdown\(/g) || []).toHaveLength(0);
    expect(src).toMatch(/selectStoryTargets\(/);
  });
});
