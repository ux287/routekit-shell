/**
 * Contract tests for tests/_helpers/server-source.mjs - S1 of
 * research.2026.10.05.server-mjs-safe-decomposition
 * (backlog.feat.server-mjs-source-pins-location-independent).
 *
 * Scratch-root fixtures prove the locator contract (surface set, fail-loud head
 * lookup, any-tool terminator, move simulation). The live-tree block proves the
 * S1 migration is byte-preserving, and the migration guard keeps the 35 readers
 * on the helper.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readServerSurfaceSource,
  readToolHandlerSource,
  serverSurfaceFiles,
} from "../_helpers/server-source.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_REL = "packages/mcp-rks/src/server.mjs";
const HANDLERS_REL = "packages/mcp-rks/src/server/handlers";

const ALPHA = '    if (tool === "alpha_tool") {\n      return { a: 1 };\n    }\n';
const BETA =
  '    if (tool === "beta_tool") {\n' +
  "      if (tool === 'beta_tool' && verbose) { log(); }\n" +
  "      return { b: 2 };\n" +
  "    }\n";
const GAMMA = "    if (tool === GAMMA_TOOL) {\n      return { c: 3 };\n    }\n";
const DELTA = "    if (tool === 'delta_tool') {\n      return { d: 4 };\n    }\n";

function dispatch(...branches) {
  return `async function dispatch(tool, verbose) {\n${branches.join("")}}\n`;
}

let root;
function write(rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "server-source-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("serverSurfaceFiles / readServerSurfaceSource", () => {
  it("TR1 is server.mjs alone when server/handlers/ is absent", () => {
    write(SERVER_REL, dispatch(ALPHA));
    expect(serverSurfaceFiles({ root })).toEqual([path.join(root, SERVER_REL)]);
    expect(readServerSurfaceSource({ root })).toBe(dispatch(ALPHA));
  });

  it("TR2 adds every .mjs under server/handlers/ recursively, sorted, after server.mjs", () => {
    write(SERVER_REL, dispatch(ALPHA));
    write(`${HANDLERS_REL}/zeta.mjs`, "// zeta source\n");
    write(`${HANDLERS_REL}/nested/beta.mjs`, "// nested beta source\n");
    write(`${HANDLERS_REL}/notes.txt`, "not a module\n");
    expect(serverSurfaceFiles({ root })).toEqual([
      path.join(root, SERVER_REL),
      path.join(root, HANDLERS_REL, "nested", "beta.mjs"),
      path.join(root, HANDLERS_REL, "zeta.mjs"),
    ]);
    const surface = readServerSurfaceSource({ root });
    expect(surface).toContain(dispatch(ALPHA));
    expect(surface).toContain("// zeta source");
    expect(surface).toContain("// nested beta source");
    expect(surface).not.toContain("not a module");
  });
});

describe("readToolHandlerSource - head lookup and terminator", () => {
  beforeEach(() => write(SERVER_REL, dispatch(ALPHA, BETA, GAMMA, DELTA)));

  it("TR3 slices a double-quoted head to the next dispatch head of ANY tool", () => {
    expect(readToolHandlerSource("alpha_tool", { root })).toBe(ALPHA.trimStart() + "    ");
  });

  it("TR3 slices the last head to EOF", () => {
    expect(readToolHandlerSource("delta_tool", { root })).toBe(DELTA.trimStart() + "}\n");
  });

  it("TR4 accepts a single-quoted head and an identifier head", () => {
    expect(readToolHandlerSource("delta_tool", { root })).toContain("return { d: 4 };");
    expect(readToolHandlerSource("gamma", { root, identifier: "GAMMA_TOOL" })).toBe(
      GAMMA.trimStart() + "    ",
    );
  });

  it("TR5 a compound in-branch condition is not a dispatch head and does not end the slice", () => {
    const beta = readToolHandlerSource("beta_tool", { root });
    expect(beta).toBe(BETA.trimStart() + "    ");
    expect(beta).toContain("return { b: 2 };");
  });

  it("TR6 throws naming the tool when the head is absent, never returning an empty string", () => {
    expect(() => readToolHandlerSource("missing_tool", { root })).toThrow(/missing_tool/);
  });

  it("TR7 throws naming the tool when the head occurs more than once across the surface", () => {
    write(`${HANDLERS_REL}/alpha.mjs`, ALPHA);
    expect(() => readToolHandlerSource("alpha_tool", { root })).toThrow(/alpha_tool/);
  });

  it("TR8 does not match a longer tool name as the same head", () => {
    write(SERVER_REL, dispatch('    if (tool === "alpha_tool_ext") {\n    }\n', ALPHA));
    expect(readToolHandlerSource("alpha_tool", { root })).toBe(ALPHA.trimStart() + "}\n");
  });
});

describe("move simulation - relocated branch stays green, deleted branch fails", () => {
  it("TR9 relocating a branch into server/handlers/ preserves its body and keeps it in the surface", () => {
    write(SERVER_REL, dispatch(ALPHA, BETA, GAMMA));
    const before = readToolHandlerSource("beta_tool", { root });
    expect(readServerSurfaceSource({ root })).toContain(BETA);

    write(SERVER_REL, dispatch(ALPHA, GAMMA));
    write(`${HANDLERS_REL}/beta.mjs`, BETA);
    const after = readToolHandlerSource("beta_tool", { root });

    expect(after.trimEnd()).toBe(before.trimEnd());
    expect(readServerSurfaceSource({ root })).toContain(BETA);
    expect(readToolHandlerSource("alpha_tool", { root })).toBe(ALPHA.trimStart() + "    ");
  });

  it("TR10 deleting the relocated branch makes readToolHandlerSource throw (discrimination, not vacuity)", () => {
    write(SERVER_REL, dispatch(ALPHA, GAMMA));
    write(`${HANDLERS_REL}/beta.mjs`, BETA);
    expect(readToolHandlerSource("beta_tool", { root })).toContain("return { b: 2 };");

    fs.rmSync(path.join(root, HANDLERS_REL, "beta.mjs"));
    expect(() => readToolHandlerSource("beta_tool", { root })).toThrow(/beta_tool/);
    expect(readServerSurfaceSource({ root })).not.toContain("return { b: 2 };");
  });

  it("TR11 a negative assertion over the surface still sees code moved into a handler module", () => {
    write(SERVER_REL, dispatch(ALPHA));
    write(`${HANDLERS_REL}/beta.mjs`, BETA);
    expect(fs.readFileSync(path.join(root, SERVER_REL), "utf8")).not.toContain("return { b: 2 };");
    expect(readServerSurfaceSource({ root })).toContain("return { b: 2 };");
  });
});

describe("live tree - S1 migration is byte-preserving", () => {
  const SERVER_ABS = path.join(REPO_ROOT, SERVER_REL);
  const live = fs.readFileSync(SERVER_ABS, "utf8");
  const handlersPresent = fs.existsSync(path.join(REPO_ROOT, HANDLERS_REL));

  it("TR12 defaults root to the repo root and mirrors server.mjs while handlers/ is absent", () => {
    expect(serverSurfaceFiles()[0]).toBe(SERVER_ABS);
    if (handlersPresent) {
      expect(readServerSurfaceSource().startsWith(live)).toBe(true);
    } else {
      expect(readServerSurfaceSource()).toBe(live);
    }
  });

  // TR13 (legacy-slice NAMED rows) retired: S8 removed the rks_plan_ready and rks_plan rows (TR22), and
  // S9a removed the last row, rks_interview, which now registers in handlers/agent-bootstrap.mjs (TR23).

  const NEXT_HEAD = [
    ["GOVERNOR_INIT_TOOL", "GOVERNOR_INIT_TOOL"],
  ];

  it.each(NEXT_HEAD)("TR14 %s equals the legacy next-head slice", (tool, identifier) => {
    const head = identifier ? `if (tool === ${identifier})` : `if (tool === "${tool}")`;
    const slice = readToolHandlerSource(tool, identifier ? { identifier } : {});
    expect(slice.startsWith(head)).toBe(true);
    if (live.includes(head)) {
      const start = live.indexOf(head);
      // S9a: end at the next dispatch HEAD as tests/_helpers/server-source.mjs defines it, not at the
      // compound `if (tool === 'rks_agent_research' && ...)` inside the per-agent fallthrough.
      const HEAD_RE = /if \(tool === (?:"[^"\n]+"|'[^'\n]+'|[A-Za-z_$][\w$]*)\)/g;
      HEAD_RE.lastIndex = start + 1;
      const nextHead = HEAD_RE.exec(live);
      const end = nextHead === null ? -1 : nextHead.index;
      expect(slice).toBe(end === -1 ? live.slice(start) : live.slice(start, end));
    }
  });
});

// S2 (backlog.feat.server-mjs-handler-registry-telemetry-pilot): the registry registration
// form `registerHandler(<"name" | 'name' | IDENT>, ...)` is a dispatch head too.
const REG_ALPHA =
  'registerHandler("alpha_tool", async (cleanArgs, ctx) => {\n  return { a: 1 };\n});\n';
const REG_BETA = 'registerHandler("beta_tool", async (cleanArgs, ctx) => {\n  return { b: 2 };\n});\n';
const REG_SINGLE = "registerHandler('single_tool', async (cleanArgs, ctx) => {\n  return { s: 1 };\n});\n";
const REG_IDENT = "registerHandler(IDENT_TOOL, async (cleanArgs, ctx) => {\n  return { i: 1 };\n});\n";

describe("registration heads (S2)", () => {
  it("TR13 a registration head slices to the next registration head", () => {
    write(SERVER_REL, dispatch(GAMMA));
    write(`${HANDLERS_REL}/fam.mjs`, REG_ALPHA + REG_BETA);
    expect(readToolHandlerSource("alpha_tool", { root })).toBe(REG_ALPHA);
    expect(readToolHandlerSource("beta_tool", { root })).toBe(REG_BETA);
  });

  it("TR13 single-quoted and identifier registration heads are accepted; the last slices to EOF", () => {
    write(SERVER_REL, dispatch(GAMMA));
    write(`${HANDLERS_REL}/fam.mjs`, REG_SINGLE + REG_IDENT + REG_ALPHA);
    expect(readToolHandlerSource("single_tool", { root })).toBe(REG_SINGLE);
    expect(readToolHandlerSource("ident", { root, identifier: "IDENT_TOOL" })).toBe(REG_IDENT);
    expect(readToolHandlerSource("alpha_tool", { root })).toBe(REG_ALPHA);
  });

  it("TR14 a registration head terminates an if slice, and an if head terminates a registration slice", () => {
    write(SERVER_REL, dispatch(GAMMA));
    write(`${HANDLERS_REL}/mixed.mjs`, ALPHA + REG_BETA + DELTA);
    expect(readToolHandlerSource("alpha_tool", { root })).toBe(ALPHA.trimStart());
    expect(readToolHandlerSource("beta_tool", { root })).toBe(REG_BETA + "    ");
    expect(readToolHandlerSource("delta_tool", { root })).toBe(DELTA.trimStart());
  });

  it("TR15 a tool with both an if head and a registration head throws naming it", () => {
    write(SERVER_REL, dispatch('    if (tool === "x") {\n    }\n', GAMMA));
    write(`${HANDLERS_REL}/x.mjs`, 'registerHandler("x", async (cleanArgs, ctx) => {});\n');
    expect(() => readToolHandlerSource("x", { root })).toThrow(/\bx\b/);
    expect(() => readToolHandlerSource("x", { root })).toThrow(/2 dispatch heads/);
  });

  it("TR15 a missing tool still throws, and a longer registered name does not match", () => {
    write(SERVER_REL, dispatch(GAMMA));
    write(
      `${HANDLERS_REL}/fam.mjs`,
      'registerHandler("alpha_tool_ext", async (cleanArgs, ctx) => {});\n' + REG_ALPHA,
    );
    expect(() => readToolHandlerSource("missing_tool", { root })).toThrow(/missing_tool/);
    expect(readToolHandlerSource("alpha_tool", { root })).toBe(REG_ALPHA);
    expect(readToolHandlerSource("alpha_tool_ext", { root })).toBe(
      'registerHandler("alpha_tool_ext", async (cleanArgs, ctx) => {});\n',
    );
  });

  const TELEMETRY_TOOLS = [
    "rks_telemetry_digest",
    "rks_telemetry_query",
    "rks_telemetry_report",
    "rks_telemetry_analysis",
    "rks_token_cost_report",
    "rks_telemetry_export",
  ];

  it.each(TELEMETRY_TOOLS)("TR16 live tree: %s slices from handlers/telemetry.mjs", (tool) => {
    const telemetrySrc = fs.readFileSync(
      path.join(REPO_ROOT, HANDLERS_REL, "telemetry.mjs"),
      "utf8",
    );
    const slice = readToolHandlerSource(tool);
    expect(slice.startsWith(`registerHandler("${tool}"`)).toBe(true);
    expect(telemetrySrc).toContain(slice);
    if (tool.endsWith("_digest")) {
      expect(slice).toContain('await import("@routekit/telemetry/digest")');
    }
  });
});

// S3 (backlog.feat.server-mjs-project-meta-handler-family): the project/meta family now
// slices from handlers/project-meta.mjs. Its former S1 if-form rows were removed above.
const PROJECT_META_TOOLS = [
  "rks_project_get",
  "rks_kg_query",
  "rks_templates_list",
  "rks_git_state",
  "rks_publish",
  "rks_publish_profiles",
];

describe("project/meta registration slices (S3)", () => {
  it.each(PROJECT_META_TOOLS)("TR17 live tree: %s slices from handlers/project-meta.mjs", (tool) => {
    const projectMetaSrc = fs.readFileSync(
      path.join(REPO_ROOT, HANDLERS_REL, "project-meta.mjs"),
      "utf8",
    );
    const slice = readToolHandlerSource(tool);
    expect(slice.startsWith(`registerHandler("${tool}"`)).toBe(true);
    expect(projectMetaSrc).toContain(slice);
    if (tool === "rks_publish") {
      expect(slice).not.toContain('registerHandler("rks_publish_profiles"');
    }
    if (tool === "rks_git_state") {
      expect(slice).toContain("execSync(");
    }
  });
});

// S4 (backlog.feat.server-mjs-dendron-handler-family): the dendron family now slices from
// handlers/dendron.mjs. Its former S1 if-form NAMED rows were removed above.
const DENDRON_TOOLS = [
  "dendron_create_note",
  "dendron_fix_frontmatter",
  "dendron_validate_schema",
  "dendron_edit_note",
  "dendron_read_note",
  "dendron_update_field",
  "dendron_mark_implemented",
];

describe("dendron registration slices (S4)", () => {
  it.each(DENDRON_TOOLS)("TR18 live tree: %s slices from handlers/dendron.mjs", (tool) => {
    const dendronSrc = fs.readFileSync(path.join(REPO_ROOT, HANDLERS_REL, "dendron.mjs"), "utf8");
    const slice = readToolHandlerSource(tool);
    expect(slice.startsWith(`registerHandler("${tool}"`)).toBe(true);
    expect(dendronSrc).toContain(slice);
    if (tool === "dendron_validate_schema") {
      expect(slice).toContain('await import("glob")');
    }
    if (tool === "dendron_read_note") {
      expect(slice).toContain("sliceNote(raw, cleanArgs || {})");
    }
  });
});

// S5 (backlog.feat.server-mjs-rag-handler-family): the RAG family now slices from
// handlers/rag.mjs. Its former S1 if-form NEXT_HEAD row (rks_fetch_raw) was removed above.
const RAG_TOOLS = [
  "rks_rag_init",
  "rks_rag_embed",
  "rks_rag_query",
  "rks_exhaustive_search",
  "rks_rag_compact",
  "rks_memory_save",
  "rks_fetch_raw",
];

describe("RAG registration slices (S5)", () => {
  it.each(RAG_TOOLS)("TR19 live tree: %s slices from handlers/rag.mjs", (tool) => {
    const ragSrc = fs.readFileSync(path.join(REPO_ROOT, HANDLERS_REL, "rag.mjs"), "utf8");
    const slice = readToolHandlerSource(tool);
    expect(slice.startsWith(`registerHandler("${tool}"`)).toBe(true);
    expect(ragSrc).toContain(slice);
    if (tool === "rks_fetch_raw") {
      expect(slice).toContain('await import("../../agents/fetch-raw.mjs")');
    }
    if (tool === "rks_memory_save") {
      expect(slice).toContain("getDendronContext()");
      expect(slice).toContain("commitAndEmbedNote({");
    }
  });
});

// S6 (backlog.feat.server-mjs-git-handler-family): the git family now slices from
// handlers/git.mjs. rks_git_preflight registers under the GIT_PREFLIGHT_TOOL identifier.
const GIT_LITERAL_TOOLS = [
  "rks_stash",
  "rks_restore",
  "rks_reset",
  "rks_revert",
  "rks_tag",
  "rks_cherry_pick",
  "rks_git_branch",
  "rks_checkout",
  "rks_branch_repair",
  "rks_git_commit",
  "rks_git_push",
  "rks_resolve_conflict",
];

describe("git registration slices (S6)", () => {
  const gitSrc = () => fs.readFileSync(path.join(REPO_ROOT, HANDLERS_REL, "git.mjs"), "utf8");

  it.each(GIT_LITERAL_TOOLS)("TR20 live tree: %s slices from handlers/git.mjs", (tool) => {
    const slice = readToolHandlerSource(tool);
    expect(slice.startsWith(`registerHandler("${tool}", async (cleanArgs, ctx) =>`)).toBe(true);
    expect(gitSrc()).toContain(slice);
    if (tool === "rks_stash") {
      expect(slice).toContain("setPendingStash(_governorToken");
      expect(slice).toContain('await import("../git-tools.mjs")');
    }
    if (tool === "rks_git_commit") {
      expect(slice).toContain("advanceStateOnResult(_governorToken, resultKey)");
      expect(slice).toContain("stageAll: input.files === undefined");
    }
  });

  it("TR20 live tree: rks_git_preflight slices from handlers/git.mjs under the GIT_PREFLIGHT_TOOL identifier", () => {
    const slice = readToolHandlerSource("rks_git_preflight", { identifier: "GIT_PREFLIGHT_TOOL" });
    expect(slice.startsWith("registerHandler(GIT_PREFLIGHT_TOOL, async (cleanArgs, ctx) =>")).toBe(true);
    expect(gitSrc()).toContain(slice);
  });
});

// S7 (backlog.feat.server-mjs-ship-handler-family): the ship/workflow family now slices from
// handlers/ship.mjs, in server.mjs head order.
const SHIP_TOOLS_S7 = [
  "rks_story_ship",
  "rks_cycle_complete",
  "rks_promote",
  "rks_ship",
  "rks_staging_pr",
  "rks_git_merge",
  "rks_sync_staging",
  "rks_staging_merge",
  "rks_release",
];

describe("ship registration slices (S7)", () => {
  const shipSrc = () => fs.readFileSync(path.join(REPO_ROOT, HANDLERS_REL, "ship.mjs"), "utf8");

  it.each(SHIP_TOOLS_S7)("TR21 live tree: %s slices from handlers/ship.mjs", (tool) => {
    const slice = readToolHandlerSource(tool);
    expect(slice.startsWith(`registerHandler("${tool}", async (cleanArgs, ctx) =>`)).toBe(true);
    expect(shipSrc()).toContain(slice);
    if (tool === "rks_story_ship") {
      expect(slice).toContain("await import('../story-ship.mjs')");
      expect(slice).toContain("advanceStateOnResult(_governorToken, resultKey)");
    }
    if (tool === "rks_ship") {
      expect(slice).toContain("advanceToNextChild(_governorToken)");
      expect(slice).toContain("stageAll: input.files === undefined");
    }
    if (tool === "rks_sync_staging") expect(slice).toContain("strategy_not_allowed_under_governor");
    if (tool === "rks_cycle_complete" || tool === "rks_promote") {
      expect(slice).toContain('await import("../git-tools.mjs")');
    }
  });
});

// S8 (backlog.feat.server-mjs-planner-exec-handler-family): the planner/exec family now slices
// from handlers/planner.mjs, in server.mjs head order. rks_plan names its second parameter
// handlerCtx because its body declares a local ctx.
const PLANNER_TOOLS_S8 = [
  "rks_analyze",
  "rks_plan",
  "rks_plan_review",
  "rks_preflight",
  "rks_validate_story",
  "rks_plan_ready",
  "rks_exec",
  "rks_exec_abort",
  "rks_apply",
  "rks_guardrails_simulate",
  "rks_approve",
  "rks_story_create",
  "rks_refine",
  "rks_refine_apply",
  "rks_ready",
  "rks_review",
];

describe("planner registration slices (S8)", () => {
  const plannerSrc = () => fs.readFileSync(path.join(REPO_ROOT, HANDLERS_REL, "planner.mjs"), "utf8");

  it("TR22 the planner list holds sixteen distinct tools", () => {
    expect(new Set(PLANNER_TOOLS_S8).size).toBe(16);
  });

  it.each(PLANNER_TOOLS_S8)("TR22 live tree: %s slices from handlers/planner.mjs", (tool) => {
    const slice = readToolHandlerSource(tool);
    const param = tool === "rks_plan" ? "handlerCtx" : "ctx";
    expect(slice.startsWith(`registerHandler("${tool}", async (cleanArgs, ${param}) =>`)).toBe(true);
    expect(plannerSrc()).toContain(slice);
    if (tool === "rks_plan") {
      expect(slice).toContain("'..', '..', '..', 'bin', 'plan-worker.mjs'");
      expect(slice).toContain("const ctx = await loadContext(input.projectId);");
      expect(slice).toContain("spawn('node'");
    }
    if (tool === "rks_plan_review") {
      expect(slice).toContain("for (const [key, val] of pendingPlans)");
      expect(slice).toContain("classifyMarkerFailure(marker)");
    }
    if (tool === "rks_approve") {
      expect(slice).toContain("ctx.args?.planId");
      expect(slice).toContain('await import("../approve.mjs")');
      expect(slice).not.toContain("req.params");
    }
    if (tool === "rks_refine_apply") expect(slice).toContain('await import("../../shared/governor-token.mjs")');
    if (tool === "rks_ready") expect(slice).toContain('await import("../refine.mjs")');
    if (tool === "rks_review") expect(slice).toContain("await import('../review.mjs')");
  });
});

// S9a (backlog.feat.server-mjs-agent-bootstrap-handler-family): the agent/bootstrap family now slices
// from handlers/agent-bootstrap.mjs, in server.mjs head order.
const AGENT_BOOTSTRAP_TOOLS_S9A = [
  "rks_init",
  "rks_project_init",
  "rks_agent_external_research",
  "rks_onboarder",
  "rks_interview",
  "rks_agent_run",
];

describe("agent/bootstrap registration slices (S9a)", () => {
  const agentBootstrapSrc = () => fs.readFileSync(path.join(REPO_ROOT, HANDLERS_REL, "agent-bootstrap.mjs"), "utf8");

  it("TR23 the agent/bootstrap list holds six distinct tools", () => {
    expect(new Set(AGENT_BOOTSTRAP_TOOLS_S9A).size).toBe(6);
  });

  it.each(AGENT_BOOTSTRAP_TOOLS_S9A)("TR23 live tree: %s slices from handlers/agent-bootstrap.mjs", (tool) => {
    const slice = readToolHandlerSource(tool);
    expect(slice.startsWith(`registerHandler("${tool}", async (cleanArgs, ctx) =>`)).toBe(true);
    expect(agentBootstrapSrc()).toContain(slice);
    if (tool === "rks_init") {
      expect(slice).toContain("await import('../init.mjs')");
      expect(slice).toContain("if (res.success && res.path) {");
    }
    if (tool === "rks_agent_external_research") expect(slice).toContain("await import('../../agents/external-research.mjs')");
    if (tool === "rks_interview") expect(slice).toContain("const DEPRECATION_WARNING =");
    if (tool === "rks_agent_run") expect(slice).toContain("const parsedInput = parseAgentInput(agentName, agentInput);");
  });
});

const MIGRATED = [
  "tests/integration/arch-verdict-tool.test.mjs",
  "tests/integration/dendron-write-auto-commit.test.mjs",
  "tests/integration/memory-save-tool.test.mjs",
  "tests/integration/plan-review-poll-hint.test.mjs",
  "tests/integration/research-agent-note-auto-commit.test.mjs",
  "tests/integration/server-self-project-id.test.mjs",
  "tests/integration/telemetry-dynamic-import-handlers.test.mjs",
  "tests/unit/commit-attribution.test.mjs",
  "tests/unit/cycle-complete-gate-propagation.test.mjs",
  "tests/unit/dendron-create-note-verbatim-content.test.mjs",
  "tests/unit/dendron-create-note-verification.test.mjs",
  "tests/unit/exec-expected-anchor-assertion.test.mjs",
  "tests/unit/exec-unscoped-commit-landmine.test.mjs",
  "tests/unit/git-workflow-hook-test-command.test.mjs",
  "tests/unit/governor-init-preserves-live-offrail-scope.test.mjs",
  "tests/unit/governor-state-tool-admission-gaps.test.mjs",
  "tests/unit/how-to-corpus-publish-accuracy.test.mjs",
  "tests/unit/init-verified-outcome.test.mjs",
  "tests/unit/offrail-phase-repair-evidence-bound.test.mjs",
  "tests/unit/onboard-skill-discovery-rename.test.mjs",
  "tests/unit/onboarder.phase5.test.mjs",
  "tests/unit/pending-plan-marker-worker-log-path.test.mjs",
  "tests/unit/plan-review-failure-payload.test.mjs",
  "tests/unit/plan-worker-project-root.test.mjs",
  "tests/unit/project-get-resolved-branches.test.mjs",
  "tests/unit/promote-ops-flow-admission.test.mjs",
  "tests/unit/publish-suppression-callers.test.mjs",
  "tests/unit/rag-init-reset.test.mjs",
  "tests/unit/refine-apply-schema-contract.test.mjs",
  "tests/unit/refine-projectid-telemetry.test.mjs",
  "tests/unit/research-agent-self-bootstrap.test.mjs",
  "tests/unit/rks-plan-not-ready-short-circuit.test.mjs",
  "tests/unit/server.fetch-raw-projectid-attribution.test.mjs",
  "tests/unit/telemetry-failureclass-reconciliation.test.mjs",
  "tests/unit/workflow/arch-verdict.spec.mjs",
];

describe("TR15 migrated readers route through the helper", () => {
  it("the migrated set has 35 entries", () => {
    expect(MIGRATED).toHaveLength(35);
  });

  it.each(MIGRATED)("%s imports the helper, hand-rolls no head slice, and reads no server.mjs path", (rel) => {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    expect(src).toMatch(/from\s+["'](?:\.\.\/)+_helpers\/server-source\.mjs["']/);
    expect(src).not.toMatch(/indexOf\(\s*[`'"]if \(tool ===/);
    const readLines = src
      .split("\n")
      .filter((line) => line.includes("readFileSync") && line.includes("server.mjs"));
    expect(readLines).toEqual([]);
  });
});
