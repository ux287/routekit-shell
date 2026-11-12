// backlog.feat.server-lane-policy — AC4, AC7, AC14 (pure module, no server)
//
// AC15: every loadBootLanePolicy case pins ROUTEKIT_PROJECT_ROOT to a temporary fixture root
// (never this repo) and restores ROUTEKIT_PROJECT_ROOT, RKS_PROJECT_ROOT, RKS_VIA and
// RKS_VIA_DEFAULT after each test.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readLanePolicy,
  laneMode,
  decideLane,
  envLane,
  loadBootLanePolicy,
  READ_ONLY_TOOLS,
  LANE_MODES,
  laneReport,
  loadBootProjectId,
} from "../../packages/mcp-rks/src/shared/lane-policy.mjs";

const ENV_KEYS = ["ROUTEKIT_PROJECT_ROOT", "RKS_PROJECT_ROOT", "RKS_VIA", "RKS_VIA_DEFAULT", "RKS_ACTOR"];
const FULL_LANES = { ide: "full", dispatch: "full", call: "read-only", mcp: "read-only" };

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "lane-policy-unit-"));
function makeFixture(name, projectJson) {
  const root = path.join(tmpBase, name);
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  if (projectJson !== undefined) {
    fs.writeFileSync(
      path.join(root, ".rks", "project.json"),
      typeof projectJson === "string" ? projectJson : JSON.stringify(projectJson, null, 2),
    );
  }
  return fs.realpathSync(root);
}
const noLanesRoot = makeFixture("no-lanes", { id: "fixture-no-lanes" });
const fullLanesRoot = makeFixture("full-lanes", { id: "fixture-full-lanes", lanes: FULL_LANES });
const noProjectJsonRoot = makeFixture("no-project-json");
const unparseableRoot = makeFixture("unparseable", "{ this is not json");

let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
});
afterAll(() => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("readLanePolicy (AC4)", () => {
  it("absent when the project json has no lanes key", () => {
    expect(readLanePolicy({})).toMatchObject({ status: "absent", lanes: null });
    expect(readLanePolicy({ id: "x", dispatch: {} })).toMatchObject({ status: "absent", lanes: null });
  });

  it("ok with a copy of the lanes for a valid block", () => {
    const block = { ...FULL_LANES };
    const p = readLanePolicy({ lanes: block });
    expect(p.status).toBe("ok");
    expect(p.lanes).toEqual(FULL_LANES);
    expect(p.lanes).not.toBe(block);
    block.mcp = "full";
    expect(p.lanes.mcp).toBe("read-only");
  });

  it.each([
    ["array", []],
    ["string", "full"],
    ["null", null],
  ])("invalid for a non-object lanes value (%s), with an error message", (_label, value) => {
    const p = readLanePolicy({ lanes: value });
    expect(p.status).toBe("invalid");
    expect(p.lanes).toBeNull();
    expect(typeof p.error).toBe("string");
    expect(p.error.length).toBeGreaterThan(0);
  });

  it("invalid with an error naming the key for an unknown lane key", () => {
    const p = readLanePolicy({ lanes: { ide: "full", robot: "full" } });
    expect(p.status).toBe("invalid");
    expect(p.error).toContain("robot");
  });

  it("invalid with an error naming the lane and value for an unknown mode value", () => {
    const p = readLanePolicy({ lanes: { ide: "full", call: "write-ish" } });
    expect(p.status).toBe("invalid");
    expect(p.error).toContain("call");
    expect(p.error).toContain("write-ish");
  });
});

describe("laneMode (AC4)", () => {
  it("full for an absent policy", () => {
    const p = readLanePolicy({});
    for (const lane of ["ide", "dispatch", "call", "mcp"]) expect(laneMode(p, lane)).toBe("full");
  });

  it("read-only for every lane under an invalid policy", () => {
    const p = readLanePolicy({ lanes: "nope" });
    for (const lane of ["ide", "dispatch", "call", "mcp"]) expect(laneMode(p, lane)).toBe("read-only");
  });

  it("the configured mode for a listed lane", () => {
    const p = readLanePolicy({ lanes: FULL_LANES });
    expect(laneMode(p, "ide")).toBe("full");
    expect(laneMode(p, "dispatch")).toBe("full");
    expect(laneMode(p, "call")).toBe("read-only");
    expect(laneMode(p, "mcp")).toBe("read-only");
  });

  it("read-only for a lane missing from a valid block", () => {
    const p = readLanePolicy({ lanes: { ide: "full" } });
    expect(laneMode(p, "dispatch")).toBe("read-only");
    expect(laneMode(p, "mcp")).toBe("read-only");
  });
});

describe("envLane (enforcement lane is env-resolved)", () => {
  it("RKS_VIA, then RKS_VIA_DEFAULT, else mcp; invalid values ignored", () => {
    expect(envLane({})).toBe("mcp");
    expect(envLane({ RKS_VIA_DEFAULT: "ide" })).toBe("ide");
    expect(envLane({ RKS_VIA: "dispatch", RKS_VIA_DEFAULT: "ide" })).toBe("dispatch");
    expect(envLane({ RKS_VIA: "not-a-lane", RKS_VIA_DEFAULT: "ide" })).toBe("ide");
    expect(envLane({ RKS_VIA_DEFAULT: "not-a-lane" })).toBe("mcp");
  });
});

describe("decideLane (AC7)", () => {
  const readOnly = readLanePolicy({ lanes: FULL_LANES });

  it("refuses a made-up tool name in a read-only lane", () => {
    expect(decideLane({ lane: "mcp", policy: readOnly, tool: "rks_made_up_tool", args: {} }))
      .toMatchObject({ ok: false, reason: "lane_read_only" });
  });

  it("returns null for each READ_ONLY_TOOLS member other than rks_governor_init", () => {
    for (const tool of READ_ONLY_TOOLS) {
      if (tool === "rks_governor_init") continue;
      expect(decideLane({ lane: "mcp", policy: readOnly, tool, args: { projectId: "p" } }), tool).toBeNull();
    }
  });

  it("refuses tools not in READ_ONLY_TOOLS (write tools)", () => {
    for (const tool of ["dendron_create_note", "rks_ship", "rks_story_ship", "rks_exec", "rks_agent_research", "rks_plan_ready"]) {
      expect(READ_ONLY_TOOLS.has(tool)).toBe(false);
      expect(decideLane({ lane: "call", policy: readOnly, tool, args: {} }), tool)
        .toMatchObject({ ok: false, reason: "lane_read_only", tool, lane: "call" });
    }
  });

  it("admits rks_governor_init only with no problemId and flowType absent or open", () => {
    const d = (args) => decideLane({ lane: "mcp", policy: readOnly, tool: "rks_governor_init", args });
    expect(d({ projectId: "p" })).toBeNull();
    expect(d({ projectId: "p", flowType: "open" })).toBeNull();
    expect(d({ projectId: "p", problemId: "backlog.x" })).toMatchObject({ reason: "lane_read_only" });
    expect(d({ projectId: "p", flowType: "open", problemId: "backlog.x" })).toMatchObject({ reason: "lane_read_only" });
    for (const flowType of ["story", "qa", "ship", "ops"]) {
      expect(d({ projectId: "p", flowType }), flowType).toMatchObject({ reason: "lane_read_only" });
    }
  });

  it("READ_ONLY_TOOLS contains none of the write tools", () => {
    for (const tool of [
      "dendron_create_note", "dendron_edit_note", "dendron_update_field", "rks_arch_verdict",
      "rks_ship", "rks_story_ship", "rks_git_commit", "rks_plan", "rks_exec", "rks_rag_embed",
      "rks_guardrails_off", "rks_guardrails_on",
    ]) {
      expect(READ_ONLY_TOOLS.has(tool), tool).toBe(false);
    }
  });

  it("the refusal carries ok false, reason, lane, tool, policySource and a non-empty remedy", () => {
    const r = decideLane({ lane: "mcp", policy: readOnly, tool: "dendron_create_note", args: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("lane_read_only");
    expect(r.lane).toBe("mcp");
    expect(r.tool).toBe("dendron_create_note");
    expect(r.policySource).toBe(".rks/project.json lanes");
    expect(typeof r.remedy).toBe("string");
    expect(r.remedy.length).toBeGreaterThan(0);
  });

  it("a full lane admits everything; an invalid policy refuses with invalid_lane_policy even for ide", () => {
    expect(decideLane({ lane: "ide", policy: readOnly, tool: "dendron_create_note", args: {} })).toBeNull();
    const invalid = readLanePolicy({ lanes: { ide: "sometimes" } });
    const r = decideLane({ lane: "ide", policy: invalid, tool: "dendron_create_note", args: {} });
    expect(r).toMatchObject({ ok: false, reason: "invalid_lane_policy", lane: "ide" });
    expect(r.error).toContain("sometimes");
    expect(r.remedy).toContain(".rks/project.json");
  });
});

describe("loadBootLanePolicy (AC14)", () => {
  it("no root env set: absent with root null, regardless of cwd (cwd = full-lanes fixture)", () => {
    vi.spyOn(process, "cwd").mockReturnValue(fullLanesRoot);
    expect(loadBootLanePolicy()).toEqual({ status: "absent", lanes: null, root: null });
  });

  it("uses RKS_PROJECT_ROOT when ROUTEKIT_PROJECT_ROOT is unset", () => {
    process.env.RKS_PROJECT_ROOT = fullLanesRoot;
    const p = loadBootLanePolicy();
    expect(p.status).toBe("ok");
    expect(p.root).toBe(fullLanesRoot);
    expect(p.lanes).toEqual(FULL_LANES);
  });

  it("prefers ROUTEKIT_PROJECT_ROOT when both are set", () => {
    process.env.ROUTEKIT_PROJECT_ROOT = noLanesRoot;
    process.env.RKS_PROJECT_ROOT = fullLanesRoot;
    const p = loadBootLanePolicy();
    expect(p.status).toBe("absent");
    expect(p.root).toBe(noLanesRoot);
  });

  it("ROUTEKIT_PROJECT_ROOT naming a nonexistent path with RKS_PROJECT_ROOT unset: absent, root null", () => {
    process.env.ROUTEKIT_PROJECT_ROOT = path.join(tmpBase, "does-not-exist");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadBootLanePolicy()).toEqual({ status: "absent", lanes: null, root: null });
  });

  it("boot root without .rks/project.json: absent with root set", () => {
    process.env.ROUTEKIT_PROJECT_ROOT = noProjectJsonRoot;
    expect(loadBootLanePolicy()).toEqual({ status: "absent", lanes: null, root: noProjectJsonRoot });
  });

  it("unparseable .rks/project.json: invalid with an error naming .rks/project.json", () => {
    process.env.ROUTEKIT_PROJECT_ROOT = unparseableRoot;
    const p = loadBootLanePolicy();
    expect(p.status).toBe("invalid");
    expect(p.root).toBe(unparseableRoot);
    expect(p.error).toContain(".rks/project.json");
  });

  it("full-lanes fixture via ROUTEKIT_PROJECT_ROOT: ok", () => {
    process.env.ROUTEKIT_PROJECT_ROOT = fullLanesRoot;
    expect(loadBootLanePolicy()).toMatchObject({ status: "ok", root: fullLanesRoot, lanes: FULL_LANES });
  });
});

// ── backlog.feat.remote-surface-lane ────────────────────────────────────────────────────────────
// Pure-module remote lane tests. Every case pins its env to temporary fixture roots (tmpBase), and
// the shared afterEach restores ROUTEKIT_PROJECT_ROOT, RKS_PROJECT_ROOT, RKS_VIA, RKS_VIA_DEFAULT
// and RKS_ACTOR.
const REMOTE_FIVE = ["rks_governor_init", "rks_governor_end", "rks_rag_query", "dendron_read_note", "dendron_create_note"];
const REMOTE_REASON_SET = new Set([
  "remote_tool_not_allowed", "remote_token_required", "remote_write_outside_prefix",
  "remote_actor_unset", "remote_project_mismatch", "remote_project_unresolved",
]);
const ACTOR_ENV = { RKS_ACTOR: "grokbot" };
const POLICIES = {
  absent: readLanePolicy({}),
  validNoRemote: readLanePolicy({ lanes: FULL_LANES }),
  validWithRemote: readLanePolicy({ lanes: { ...FULL_LANES, remote: "full" } }),
  invalid: { status: "invalid", lanes: null, error: "project json: Unexpected token" },
};
// A broad set of tool names; the sweep over every REGISTERED tool name runs through the real server
// in tests/integration/server-lane-gate.test.mjs.
const OTHER_TOOLS = [
  "rks_exhaustive_search", "rks_agent_research", "rks_story_create", "rks_memory_save", "rks_rag_embed",
  "dendron_edit_note", "dendron_update_field", "dendron_rename_note", "rks_exec", "rks_ship",
  "rks_guardrails_off", "rks_guardrails_on", "rks_project_get", "rks_kg_query", "rks_git_state",
  "rks_telemetry_query", "rks_plan", "rks_release", "rks_story_ship", "rks_arch_verdict", "rks_made_up_tool",
];
const BASE_ARGS = {
  rks_governor_init: { projectId: "p1" },
  rks_governor_end: { projectId: "p1" },
  rks_rag_query: { projectId: "p1", q: "x" },
  dendron_read_note: { filename: "research.x" },
  dendron_create_note: { filename: "inbox.grokbot.x", title: "x" },
};
const remoteArgs = (tool, extra = {}) => ({ ...(BASE_ARGS[tool] ?? { projectId: "p1" }), ...extra });
const remote = (tool, { args, tokenValid, bootProjectId = "p1", policy = POLICIES.absent, env = ACTOR_ENV } = {}) =>
  decideLane({ lane: "remote", policy, tool, args: args ?? remoteArgs(tool), tokenValid, bootProjectId, env });

/** The full remote decision table as plain data, for comparison across policies. */
function remoteTable(policy) {
  const out = {};
  for (const tool of [...REMOTE_FIVE, ...OTHER_TOOLS]) {
    for (const tokenValid of [true, false, undefined]) {
      for (const bootProjectId of ["p1", null]) {
        const r = remote(tool, { tokenValid, bootProjectId, policy });
        out[`${tool}|${tokenValid}|${bootProjectId}`] = r ? r.reason : null;
      }
    }
  }
  return out;
}

describe("remote lane — identity, attribution and modes", () => {
  it("envLane returns remote for RKS_VIA=remote and for RKS_VIA_DEFAULT=remote alone", () => {
    expect(envLane({ RKS_VIA: "remote" })).toBe("remote");
    expect(envLane({ RKS_VIA_DEFAULT: "remote" })).toBe("remote");
  });

  it("resolveAttribution with RKS_VIA=remote returns via remote; the init input via enum has no remote entry", async () => {
    const { resolveAttribution } = await import("../../packages/mcp-rks/src/shared/project-lease.mjs");
    process.env.RKS_VIA = "remote";
    expect(resolveAttribution({}).via).toBe("remote");
    const { INPUT_SCHEMA } = await import("../../packages/mcp-rks/src/tools/governor-init.mjs");
    expect(INPUT_SCHEMA.properties.via.enum).toEqual(["ide", "dispatch", "call", "mcp"]);
  });

  it("laneMode for remote is remote under absent, valid and invalid policies; LANE_MODES unchanged", () => {
    for (const p of Object.values(POLICIES)) expect(laneMode(p, "remote")).toBe("remote");
    expect([...LANE_MODES]).toEqual(["full", "read-only"]);
  });

  it("laneReport for remote reports mode remote, enforced true under every policy; ide under absent stays full/false", () => {
    for (const p of Object.values(POLICIES)) {
      expect(laneReport(p, "remote")).toMatchObject({ via: "remote", mode: "remote", enforced: true });
    }
    expect(laneReport(POLICIES.validWithRemote, "remote").warning).toMatch(/remote/);
    expect(laneReport(POLICIES.validWithRemote, "ide").warning).toMatch(/remote/);
    expect(laneReport(POLICIES.validNoRemote, "remote")).not.toHaveProperty("warning");
    expect(laneReport(POLICIES.absent, "ide")).toMatchObject({ mode: "full", enforced: false });
  });
});

describe("remote lane — readLanePolicy drops lanes.remote with a warning", () => {
  it.each([["full"], ["read-only"], ["sideways"]])("lanes ide full + remote %s: ok, no remote key, warning names remote", (value) => {
    const p = readLanePolicy({ lanes: { ide: "full", remote: value } });
    expect(p.status).toBe("ok");
    expect(p.lanes).toEqual({ ide: "full" });
    expect(p.lanes).not.toHaveProperty("remote");
    expect(p.warning).toMatch(/remote/);
    expect(laneMode(p, "ide")).toBe("full");
    for (const tool of OTHER_TOOLS) expect(remote(tool, { tokenValid: true, policy: p })?.reason, tool).toBe("remote_tool_not_allowed");
    for (const tool of REMOTE_FIVE) expect(remote(tool, { tokenValid: true, policy: p }), tool).toBeNull();
  });

  it("a lanes block whose only key is remote is absent with the warning; every other lane is full", () => {
    const p = readLanePolicy({ lanes: { remote: "full" } });
    expect(p).toMatchObject({ status: "absent", lanes: null });
    expect(p.warning).toMatch(/remote/);
    for (const lane of ["ide", "dispatch", "call", "mcp"]) expect(laneMode(p, lane)).toBe("full");
  });

  it("a lanes block without a remote key carries no warning key", () => {
    expect(readLanePolicy({ lanes: FULL_LANES })).not.toHaveProperty("warning");
    expect(readLanePolicy({})).not.toHaveProperty("warning");
  });

  it("loadBootLanePolicy returns the warning and logs it with console.error exactly once across two calls", async () => {
    vi.resetModules();
    const fresh = await import("../../packages/mcp-rks/src/shared/lane-policy.mjs");
    const root = makeFixture("remote-warning", { id: "fixture-remote-warning", lanes: { ide: "full", remote: "full" } });
    process.env.ROUTEKIT_PROJECT_ROOT = root;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = fresh.loadBootLanePolicy();
    const b = fresh.loadBootLanePolicy();
    expect(a.warning).toMatch(/remote/);
    expect(b.warning).toMatch(/remote/);
    expect(a).toMatchObject({ status: "ok", lanes: { ide: "full" }, root });
    const warned = spy.mock.calls.filter((c) => String(c[0]).includes("lanes.remote"));
    expect(warned).toHaveLength(1);
  });
});

describe("remote lane — loadBootProjectId", () => {
  it("returns the id from the boot root project json", () => {
    process.env.ROUTEKIT_PROJECT_ROOT = fullLanesRoot;
    expect(loadBootProjectId()).toEqual({ id: "fixture-full-lanes", root: fullLanesRoot });
  });

  it("id null with an error: roots unset, project json missing, malformed, id missing, id not a non-empty string", () => {
    vi.spyOn(process, "cwd").mockReturnValue(fullLanesRoot);
    const none = loadBootProjectId();
    expect(none.id).toBeNull();
    expect(typeof none.error).toBe("string");
    const cases = [
      noProjectJsonRoot,
      unparseableRoot,
      makeFixture("no-id", { lanes: FULL_LANES }),
      makeFixture("empty-id", { id: "" }),
      makeFixture("numeric-id", { id: 42 }),
    ];
    for (const root of cases) {
      process.env.ROUTEKIT_PROJECT_ROOT = root;
      const r = loadBootProjectId();
      expect(r.id, root).toBeNull();
      expect(typeof r.error, root).toBe("string");
    }
  });

  it("does not change loadBootLanePolicy's return shape", () => {
    process.env.ROUTEKIT_PROJECT_ROOT = noProjectJsonRoot;
    expect(loadBootLanePolicy()).toEqual({ status: "absent", lanes: null, root: noProjectJsonRoot });
  });
});

describe("remote lane — decideLane fixed policy", () => {
  it("admits open-flow rks_governor_init with projectId p1 and no token", () => {
    for (const tokenValid of [false, undefined]) {
      expect(remote("rks_governor_init", { tokenValid, args: { projectId: "p1" } })).toBeNull();
      expect(remote("rks_governor_init", { tokenValid, args: { projectId: "p1", flowType: "open" } })).toBeNull();
    }
  });

  it("admits the four tokened tools only with tokenValid true; refuses them remote_token_required otherwise", () => {
    for (const tool of REMOTE_FIVE.filter((t) => t !== "rks_governor_init")) {
      expect(remote(tool, { tokenValid: true }), tool).toBeNull();
      for (const tokenValid of [false, undefined, "yes", 1]) {
        expect(remote(tool, { tokenValid })?.reason, `${tool} ${tokenValid}`).toBe("remote_token_required");
      }
    }
  });

  it("refuses every other tool with remote_tool_not_allowed even with tokenValid true", () => {
    for (const tool of OTHER_TOOLS) {
      expect(remote(tool, { tokenValid: true })?.reason, tool).toBe("remote_tool_not_allowed");
    }
  });

  it("refuses rks_governor_init with a problemId or a non-open flowType", () => {
    expect(remote("rks_governor_init", { args: { projectId: "p1", problemId: "backlog.x" } })?.reason).toBe("remote_tool_not_allowed");
    for (const flowType of ["story", "qa", "ship", "ops"]) {
      expect(remote("rks_governor_init", { args: { projectId: "p1", flowType } })?.reason, flowType).toBe("remote_tool_not_allowed");
    }
  });

  it("the decision table is identical for absent, valid-without-remote, valid-with-remote and invalid policies", () => {
    const base = remoteTable(POLICIES.absent);
    expect(remoteTable(POLICIES.validNoRemote)).toEqual(base);
    expect(remoteTable(POLICIES.validWithRemote)).toEqual(base);
    expect(remoteTable(POLICIES.invalid)).toEqual(base);
  });

  it("bootProjectId null, empty or absent refuses every tool with remote_project_unresolved", () => {
    for (const tool of [...REMOTE_FIVE, "rks_exec"]) {
      expect(remote(tool, { tokenValid: true, bootProjectId: null })?.reason, tool).toBe("remote_project_unresolved");
      expect(remote(tool, { tokenValid: true, bootProjectId: "" })?.reason, tool).toBe("remote_project_unresolved");
      expect(decideLane({ lane: "remote", policy: POLICIES.absent, tool, args: remoteArgs(tool), tokenValid: true, env: ACTOR_ENV })?.reason, tool)
        .toBe("remote_project_unresolved");
    }
  });

  it("project pin: missing projectId on init / rag_query, and p2 on any of the five, refuse remote_project_mismatch", () => {
    expect(remote("rks_governor_init", { args: {} })?.reason).toBe("remote_project_mismatch");
    expect(remote("rks_rag_query", { tokenValid: true, args: { q: "x" } })?.reason).toBe("remote_project_mismatch");
    for (const tool of REMOTE_FIVE) {
      expect(remote(tool, { tokenValid: true, args: remoteArgs(tool, { projectId: "p2" }) })?.reason, tool).toBe("remote_project_mismatch");
    }
    expect(remote("dendron_read_note", { tokenValid: true, args: { filename: "research.x" } })).toBeNull();
    expect(remote("dendron_create_note", { tokenValid: true, args: { filename: "inbox.grokbot.x", title: "x" } })).toBeNull();
    expect(remote("dendron_create_note", { tokenValid: true, args: remoteArgs("dendron_create_note", { projectId: "p1" }) })).toBeNull();
  });

  it("RKS_ACTOR=grokbot: inbox.grokbot.test-note admitted; other prefixes and an empty remainder refused", () => {
    const create = (filename) => remote("dendron_create_note", { tokenValid: true, args: { filename, title: "x" } });
    expect(create("inbox.grokbot.test-note")).toBeNull();
    for (const filename of ["inbox.other.x", "inbox.grokbot.", "research.x", "backlog.feat.x"]) {
      expect(create(filename)?.reason, filename).toBe("remote_write_outside_prefix");
    }
  });

  it("RKS_ACTOR unset or not lowercase alphanumeric-and-hyphen refuses every create with remote_actor_unset", () => {
    for (const env of [{}, { RKS_ACTOR: "Grok Bot" }, { RKS_ACTOR: "../x" }, { RKS_ACTOR: "" }, { RKS_ACTOR: "-x" }]) {
      for (const filename of ["inbox.grokbot.test-note", "research.x"]) {
        expect(remote("dendron_create_note", { tokenValid: true, env, args: { filename, title: "x" } })?.reason, `${JSON.stringify(env)} ${filename}`)
          .toBe("remote_actor_unset");
      }
    }
  });

  it("decideLane reads RKS_ACTOR from process.env by default", () => {
    process.env.RKS_ACTOR = "grokbot";
    const args = { filename: "inbox.grokbot.x", title: "x" };
    expect(decideLane({ lane: "remote", policy: POLICIES.absent, tool: "dendron_create_note", args, tokenValid: true, bootProjectId: "p1" })).toBeNull();
    delete process.env.RKS_ACTOR;
    expect(decideLane({ lane: "remote", policy: POLICIES.absent, tool: "dendron_create_note", args, tokenValid: true, bootProjectId: "p1" })?.reason)
      .toBe("remote_actor_unset");
  });

  it("every remote refusal carries ok false, reason (one of six), lane remote and tool", () => {
    const seen = new Set();
    for (const r of [
      remote("rks_exec", { bootProjectId: null }),
      remote("rks_exec", { tokenValid: true }),
      remote("rks_rag_query", {}),
      remote("rks_rag_query", { tokenValid: true, args: { projectId: "p2", q: "x" } }),
      remote("dendron_create_note", { tokenValid: true, env: {} }),
      remote("dendron_create_note", { tokenValid: true, args: { filename: "research.x", title: "x" } }),
    ]) {
      expect(r.ok).toBe(false);
      expect(REMOTE_REASON_SET.has(r.reason), r.reason).toBe(true);
      expect(r.lane).toBe("remote");
      expect(typeof r.tool).toBe("string");
      seen.add(r.reason);
    }
    expect(seen).toEqual(REMOTE_REASON_SET);
    for (const tool of [...REMOTE_FIVE, ...OTHER_TOOLS]) {
      for (const tokenValid of [true, false]) {
        const r = remote(tool, { tokenValid });
        if (r) {
          expect(r).toMatchObject({ ok: false, lane: "remote", tool });
          expect(REMOTE_REASON_SET.has(r.reason), r.reason).toBe(true);
        }
      }
    }
  });
});

describe("remote lane — other lanes ignore tokenValid and bootProjectId", () => {
  it("ide, dispatch, call and mcp decide the same with and without the new arguments", () => {
    const readOnlyAll = readLanePolicy({ lanes: { ide: "read-only", dispatch: "read-only", call: "read-only", mcp: "read-only" } });
    for (const policy of [POLICIES.absent, readOnlyAll, POLICIES.invalid]) {
      for (const lane of ["ide", "dispatch", "call", "mcp"]) {
        for (const tool of [...READ_ONLY_TOOLS, "dendron_create_note"]) {
          const args = { projectId: "p" };
          const plain = decideLane({ lane, policy, tool, args });
          for (const extra of [{ tokenValid: true, bootProjectId: "p1" }, { tokenValid: false, bootProjectId: null }]) {
            expect(decideLane({ lane, policy, tool, args, ...extra }), `${lane} ${tool} ${policy.status}`).toEqual(plain);
          }
        }
      }
    }
  });
});
