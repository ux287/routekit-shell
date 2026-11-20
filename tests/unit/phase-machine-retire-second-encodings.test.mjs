import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PHASE_MACHINE,
  VALID_PHASES,
  TRANSITION_GRAPH,
  OPERATION_TRANSITIONS,
  PLANNABLE_PHASES,
  PHASE_GATE_EXEC,
  TOOL_PHASE_OPERATIONS,
  phaseAllows,
} from "../../packages/mcp-rks/src/workflow/phases.mjs";
// Namespace import: validatePhaseMachine is added by this story, and a named import of a
// missing export would fail at link time, so the AC4 snapshot could not run pre-change.
import * as phases from "../../packages/mcp-rks/src/workflow/phases.mjs";
import { canTransition } from "../../packages/mcp-rks/src/workflow/state-machine.mjs";
import { decideExecStartAction } from "../../packages/mcp-rks/src/server/exec-start-durability.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_ROOT = path.join(REPO_ROOT, "packages/mcp-rks/src");
const read = (rel) => fs.readFileSync(path.join(SRC_ROOT, rel), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
// Function body from its declaration to the first line that is exactly "}" (no fixed-size window).
const fnBody = (src, decl) => {
  const start = src.indexOf(decl);
  expect(start, `${decl} not found`).toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end === -1 ? undefined : end + 2);
};
const validatePhaseMachine = (m) => phases.validatePhaseMachine(m);
const recoveryEdge = () => PHASE_MACHINE.recoveryEdges.find((e) => e.to === "arch-approved");

describe("decideExecStartAction derived from PHASE_MACHINE", () => {
  it("returns the pre-change decision for null, undefined and every VALID_PHASES member", () => {
    const expected = {
      "arch-approved": { reset: false, advance: true },
      planned: { reset: true, advance: true },
      executing: { reset: true, advance: true },
      executed: { reset: true, advance: true },
      released: { reset: false, advance: false, reject: true },
      integrated: { reset: false, advance: false, reject: true },
      draft: { reset: false, advance: false },
      ready: { reset: false, advance: false },
      committed: { reset: false, advance: false },
      decomposed: { reset: false, advance: false },
    };
    expect(new Set(Object.keys(expected))).toEqual(new Set(VALID_PHASES));
    expect(decideExecStartAction(null)).toStrictEqual({ reset: false, advance: true });
    expect(decideExecStartAction(undefined)).toStrictEqual({ reset: false, advance: true });
    for (const p of VALID_PHASES) expect(decideExecStartAction(p), p).toStrictEqual(expected[p]);
  });

  it("decideExecStartAction source holds no phase-name list literal", () => {
    const body = stripComments(fnBody(read("server/exec-start-durability.mjs"), "export function decideExecStartAction"));
    expect(body).not.toMatch(/\[\s*["'][a-z-]+["']\s*,/);
  });
});

describe("phaseAllows reads rks_exec through TOOL_PHASE_OPERATIONS", () => {
  it("TOOL_PHASE_OPERATIONS maps rks_exec to an operation whose from is exactly [PHASE_GATE_EXEC]", () => {
    const op = TOOL_PHASE_OPERATIONS.rks_exec;
    expect(typeof op).toBe("string");
    expect(OPERATION_TRANSITIONS[op].from).toEqual([PHASE_GATE_EXEC]);
  });

  it("phaseAllows returns the pre-change boolean for every phase plus empty, null and undefined", () => {
    const phases = [...VALID_PHASES, "", null, undefined];
    const plannable = ["ready", "arch-approved", "planned", "executed"];
    for (const p of phases) {
      const unset = typeof p !== "string" || p === "";
      expect(phaseAllows(p, "rks_exec"), `rks_exec @ ${p}`).toBe(unset || p === "executing");
      expect(phaseAllows(p, "rks_plan"), `rks_plan @ ${p}`).toBe(unset || plannable.includes(p));
      expect(phaseAllows(p, "rks_agent_research"), `ungated @ ${p}`).toBe(true);
    }
  });

  it("phaseAllows source has no branch naming rks_exec", () => {
    const body = stripComments(fnBody(read("workflow/phases.mjs"), "export function phaseAllows"));
    expect(body).not.toContain("rks_exec");
  });
});

describe("PHASE_MACHINE declares the recovery edge and immutable set", () => {
  it("declares the recovery edge planned, executing, executed to arch-approved", () => {
    const edge = recoveryEdge();
    expect(edge).toBeDefined();
    expect(new Set(edge.from)).toEqual(new Set(["planned", "executing", "executed"]));
    expect(edge.from).toHaveLength(3);
  });

  it("declares the immutable set integrated, released", () => {
    expect(new Set(PHASE_MACHINE.immutable)).toEqual(new Set(["integrated", "released"]));
    expect(PHASE_MACHINE.immutable).toHaveLength(2);
  });

  it("validation rejects a recovery edge naming an undeclared state", () => {
    const bad = { ...PHASE_MACHINE, recoveryEdges: [{ name: "x", from: ["nope"], to: "arch-approved" }] };
    expect(() => validatePhaseMachine(bad)).toThrow();
    const badTo = { ...PHASE_MACHINE, recoveryEdges: [{ name: "x", from: ["planned"], to: "nope" }] };
    expect(() => validatePhaseMachine(badTo)).toThrow();
    expect(() => validatePhaseMachine(PHASE_MACHINE)).not.toThrow();
  });

  it("validation rejects an immutable entry naming an undeclared state", () => {
    const bad = { ...PHASE_MACHINE, immutable: ["integrated", "nope"] };
    expect(() => validatePhaseMachine(bad)).toThrow();
  });
});

describe("derived graph and operations unchanged", () => {
  it("TRANSITION_GRAPH and OPERATION_TRANSITIONS deep-equal the pre-change snapshot", () => {
    expect(TRANSITION_GRAPH).toStrictEqual({
      draft: ["ready"],
      ready: ["arch-approved", "decomposed", "planned", "draft"],
      "arch-approved": ["decomposed", "executing", "planned", "ready"],
      executing: ["executed"],
      planned: ["planned", "executed", "ready"],
      executed: ["committed", "integrated", "planned", "ready"],
      committed: ["integrated"],
      integrated: ["released"],
      released: [],
      decomposed: [],
    });
    expect(OPERATION_TRANSITIONS).toStrictEqual({
      qa: { from: ["draft"], to: "ready" },
      arch: { from: ["ready"], to: "arch-approved" },
      decompose: { from: ["ready", "arch-approved"], to: "decomposed" },
      exec_start: { from: ["arch-approved"], to: "executing" },
      exec_end: { from: ["executing"], to: "executed" },
      commit: { from: ["executed"], to: "committed" },
      promote: { from: ["committed"], to: "integrated" },
      guardrails_off: { from: ["arch-approved"], to: "executing" },
      "guardrails_on.commit": { from: ["executing"], to: "executed" },
      "guardrails_on.merge": { from: ["executed"], to: "integrated" },
      plan: { from: ["ready", "arch-approved", "planned", "executed"], to: "planned" },
      exec: { from: ["planned"], to: "executed" },
      ship: { from: ["executed"], to: "integrated" },
      release: { from: ["integrated"], to: "released" },
    });
  });

  it("canTransition into arch-approved from planned, executing and executed stays false", () => {
    for (const from of ["planned", "executing", "executed"]) {
      expect(canTransition(from, "arch-approved"), from).toBe(false);
    }
  });
});

describe("plan row gate derived from its own from list", () => {
  it("plan gate check admits exactly the plan row from phases", () => {
    const row = PHASE_MACHINE.transitions.find((t) => t.name === "plan" && !t.manual);
    const check = row.gates[0].check;
    for (const p of VALID_PHASES) expect(check({ phase: p }), p).toBe(row.from.includes(p));
  });

  it("phases.mjs code writes the four-phase plannable list exactly once", () => {
    const code = stripComments(read("workflow/phases.mjs"));
    const hits = code.split('["ready", "arch-approved", "planned", "executed"]').length - 1;
    expect(hits).toBe(1);
  });
});

describe("raw arch-approved writers stay inside the declared recovery edge", () => {
  const WRITE = '"phase", "arch-approved"';
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith(".mjs") ? [path.join(dir, d.name)] : []);

  it("the raw arch-approved writers are exactly the four known call sites", () => {
    const counts = {};
    for (const f of walk(SRC_ROOT)) {
      const n = fs.readFileSync(f, "utf8").split(WRITE).length - 1;
      if (n) counts[path.relative(SRC_ROOT, f).split(path.sep).join("/")] = n;
    }
    expect(counts).toStrictEqual({
      "server/exec-start-durability.mjs": 1,
      "server/exec.mjs": 2,
      "server/plan-ready.mjs": 1,
    });
  });

  it("each raw writer's source phase is a member of the recovery edge from", () => {
    const from = recoveryEdge().from;
    // exec-start-durability: reset fires iff decideExecStartAction says reset.
    expect(read("server/exec-start-durability.mjs")).toContain("if (decision.reset) {");
    for (const p of VALID_PHASES) {
      if (decideExecStartAction(p).reset) expect(from, p).toContain(p);
    }
    // exec.mjs resetStalePhaseToArchApproved and plan-ready.mjs self-heal: guarded on PHASE_GATE_EXEC.
    const stale = fnBody(read("server/exec.mjs"), "export function resetStalePhaseToArchApproved");
    expect(stale).toContain("phase === PHASE_GATE_EXEC");
    expect(read("server/plan-ready.mjs")).toContain("if (currentPhase === PHASE_GATE_EXEC) {");
    // exec.mjs runExecAbortTool stranded reset: only notes whose phase line is `executing`.
    expect(read("server/exec.mjs")).toContain("executing[\"']?\\s*$/m.test(content)");
    expect(from).toContain(PHASE_GATE_EXEC);
    expect(from).toContain("executing");
  });
});

describe("exec gate constant and reset_to_ready unchanged", () => {
  it("PHASE_GATE_EXEC is the literal executing and agrees with exec_start.to and the rks_exec operation", () => {
    expect(PHASE_GATE_EXEC).toBe("executing");
    expect(OPERATION_TRANSITIONS.exec_start.to).toBe(PHASE_GATE_EXEC);
    expect(OPERATION_TRANSITIONS[TOOL_PHASE_OPERATIONS.rks_exec].from).toEqual([PHASE_GATE_EXEC]);
  });

  it("reset_to_ready keeps from arch-approved, planned, executed to ready, manual", () => {
    const row = PHASE_MACHINE.transitions.find((t) => t.name === "reset_to_ready");
    expect(row).toStrictEqual({ name: "reset_to_ready", from: ["arch-approved", "planned", "executed"], to: "ready", manual: true });
  });
});
