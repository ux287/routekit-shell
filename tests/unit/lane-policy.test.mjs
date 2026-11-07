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
} from "../../packages/mcp-rks/src/shared/lane-policy.mjs";

const ENV_KEYS = ["ROUTEKIT_PROJECT_ROOT", "RKS_PROJECT_ROOT", "RKS_VIA", "RKS_VIA_DEFAULT"];
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
