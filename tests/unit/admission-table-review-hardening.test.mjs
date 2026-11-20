// backlog.feat.admission-table-review-hardening: unit-tier guards for the post-ship review findings
// on the admission decision table (complementOf cycles, row order, self-bootstrap tokenPresent,
// lane refusal parity, read-only derived views, governor-token comments, manifest evidence).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ADMISSION_TABLE,
  NAMESPACE_ALLOWLIST,
  validateAdmissionTable,
  evaluateRows,
  decide,
  namespaceAllowlistRefusal,
} from "../../packages/mcp-rks/src/shared/admission-table.mjs";
import { CHAIN_MACHINE, getStates, checkStateAllowed } from "../../packages/mcp-rks/src/shared/governor-state.mjs";
import { laneRefusal, decideLane } from "../../packages/mcp-rks/src/shared/lane-policy.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

// A minimal valid row of one stage; `extra` adds columns (complementOf, effect, ...).
const row = (id, extra = {}) => ({ id, stage: "lane", layer: "lane", effect: "allow", ...extra });
const CYCLE = /complementOf cycle/;

// Deterministic permutations of a rows array: reversed, a seeded shuffle and a half rotation.
function permutations(rows) {
  let seed = 0x2545f491;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const shuffled = [...rows];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const half = Math.floor(rows.length / 2);
  return { reversed: [...rows].reverse(), shuffled, rotated: [...rows.slice(half), ...rows.slice(0, half)] };
}

const FLOWS = Object.keys(CHAIN_MACHINE);
const TABLE_TOOLS = [...new Set(ADMISSION_TABLE.flatMap((r) => r.tools ?? []))];
const EXTRA_TOOLS = ["rks_kg_query", "rks_exec", "rks_release", "rks_git_state", "__not_a_tool__"];
const POLICIES = [
  { status: "absent", lanes: null },
  { status: "ok", lanes: { mcp: "read-only" } },
  { status: "invalid", lanes: null, error: "malformed" },
];

// Inputs covering the lane, bootstrap and session stages.
function generatedInputs() {
  const inputs = [];
  const tools = [...TABLE_TOOLS, ...EXTRA_TOOLS];
  for (const tool of tools) {
    const args = { projectId: "p" };
    for (const lane of ["ide", "mcp", "remote"]) {
      for (const policy of POLICIES) {
        for (const [tokenPresent, tokenValid] of [[false, false], [true, false], [true, true]]) {
          inputs.push({ tool, args, context: { stage: "lane", lane, policy, tokenPresent, tokenValid, bootProjectId: "p", env: { RKS_ACTOR: "a" } } });
        }
      }
    }
    for (const tokenPresent of [false, true]) {
      for (const tokenGateArmed of [false, true]) {
        inputs.push({ tool, args, context: { stage: "bootstrap", tokenPresent, tokenGateArmed } });
        inputs.push({ tool, args: {}, context: { stage: "bootstrap", tokenPresent, tokenGateArmed } });
      }
    }
    for (const [tokenPresent, tokenGateArmed] of [[false, false], [false, true], [true, false], [true, true]]) {
      inputs.push({ tool, args, session: null, context: { stage: "session", tokenPresent, tokenValid: false, tokenGateArmed } });
    }
    inputs.push({ tool, args, session: null, context: { stage: "session", tokenPresent: true, tokenValid: true, tokenGateArmed: true } });
  }
  const sessionTools = [...TABLE_TOOLS.filter((_, i) => i % 3 === 0), ...EXTRA_TOOLS, "dendron_create_note", "dendron_update_field"];
  for (const flowType of FLOWS) {
    for (const state of Object.keys(getStates(flowType))) {
      const session = { flowType, state, problemId: null };
      const stateTools = [...new Set([...getStates(flowType)[state].allowed, ...sessionTools])];
      for (const tool of stateTools) {
        for (const leaseRefused of [false, true]) {
          inputs.push({ tool, args: { projectId: "p" }, session, context: { stage: "session", tokenPresent: true, tokenValid: true, tokenGateArmed: true, leaseRefused } });
        }
      }
      for (const filename of ["backlog.x", "scratch.x", "qa.x"]) {
        inputs.push({ tool: "dendron_create_note", args: { filename }, session, context: { stage: "session", tokenPresent: true, tokenValid: true, tokenGateArmed: true } });
      }
      inputs.push({ tool: "dendron_update_field", args: { filename: "backlog.x", field: "phase", value: "ready" }, session, context: { stage: "session", tokenPresent: true, tokenValid: true, tokenGateArmed: true } });
    }
  }
  return inputs;
}

describe("complementOf cycle validation", () => {
  it("rejects a two-row cycle naming a row", () => {
    expect(() => validateAdmissionTable([row("a", { complementOf: ["b"] }), row("b", { complementOf: ["a"] })]))
      .toThrow(/complementOf cycle .*'?\b(a|b)\b/);
    expect(() => validateAdmissionTable([row("a", { complementOf: ["b"] }), row("b", { complementOf: ["a"] })]))
      .toThrow(/row '(a|b)'/);
  });

  it("rejects a self-reference naming the row", () => {
    expect(() => validateAdmissionTable([row("a", { complementOf: ["a"] })])).toThrow(CYCLE);
    expect(() => validateAdmissionTable([row("a", { complementOf: ["a"] })])).toThrow(/row 'a'/);
  });

  it("rejects a three-row cycle naming a row", () => {
    const rows = [row("a", { complementOf: ["b"] }), row("b", { complementOf: ["c"] }), row("c", { complementOf: ["a"] })];
    expect(() => validateAdmissionTable(rows)).toThrow(CYCLE);
    expect(() => validateAdmissionTable(rows)).toThrow(/row '(a|b|c)'/);
  });

  it("rejects a cycle in the machine-aware call", () => {
    const rows = [...ADMISSION_TABLE, row("probe.a", { complementOf: ["probe.b"] }), row("probe.b", { complementOf: ["probe.a"] })];
    expect(() => validateAdmissionTable(rows, CHAIN_MACHINE)).toThrow(CYCLE);
    expect(() => validateAdmissionTable(rows, CHAIN_MACHINE)).toThrow(/row 'probe\.(a|b)'/);
  });

  it("rejects the reviewer probe rows before evaluation", () => {
    const A = row("a", { effect: "allow", complementOf: ["b"] });
    const B = row("b", { effect: "deny", complementOf: ["a"] });
    const input = { tool: "t", context: { stage: "lane" } };
    // Why the gate matters: unvalidated, the cycle makes the decision depend on row order.
    expect(evaluateRows([A, B], input).matchedRule).not.toBe(evaluateRows([B, A], input).matchedRule);
    let evaluated = false;
    const guarded = (rows) => {
      validateAdmissionTable(rows);
      evaluated = true;
      return evaluateRows(rows, input);
    };
    expect(() => guarded([A, B])).toThrow(CYCLE);
    expect(() => guarded([B, A])).toThrow(CYCLE);
    expect(evaluated).toBe(false);
  });

  it("accepts the shipped table and an acyclic chain", () => {
    expect(() => validateAdmissionTable(ADMISSION_TABLE)).not.toThrow();
    expect(() => validateAdmissionTable(ADMISSION_TABLE, CHAIN_MACHINE)).not.toThrow();
    expect(() => validateAdmissionTable([row("a", { complementOf: ["b"] }), row("b")])).not.toThrow();
    // A diamond (two paths to one row) is acyclic too.
    expect(() => validateAdmissionTable([
      row("a", { complementOf: ["b", "c"] }), row("b", { complementOf: ["d"] }), row("c", { complementOf: ["d"] }), row("d"),
    ])).not.toThrow();
  });
});

describe("row-order independence", () => {
  it("evaluateRows decisions are identical across permutations of the shipped table", () => {
    const inputs = generatedInputs();
    const perms = permutations([...ADMISSION_TABLE]);
    const stages = new Set();
    const matched = new Set();
    for (const input of inputs) {
      const expected = evaluateRows(ADMISSION_TABLE, input);
      stages.add(input.context.stage);
      matched.add(expected.matchedRule);
      for (const [name, rows] of Object.entries(perms)) {
        expect(evaluateRows(rows, input), `${name}: ${input.context.stage} ${input.tool}`).toEqual(expected);
      }
    }
    expect([...stages].sort()).toEqual(["bootstrap", "lane", "session"]);
    // Coverage control: both complementOf rows and the rows they complement are reached.
    for (const id of ["lane.admit", "lane.policy-refusal", "lane.remote-token-required", "bootstrap.passthrough", "bootstrap.open.research-self-bootstrap", "session.lease.lost", "session.chain.state-refused"]) {
      expect(matched.has(id), id).toBe(true);
    }
  });
});

describe("self-bootstrap tokenPresent guard", () => {
  it("a token-carrying research call at the bootstrap stage passes through without an action", () => {
    const args = { projectId: "p" };
    const tokened = decide({ tool: "rks_agent_research", args, context: { stage: "bootstrap", lane: "ide", tokenPresent: true, tokenGateArmed: true } });
    expect(tokened.matchedRule).toBe("bootstrap.passthrough");
    expect(tokened).not.toHaveProperty("action");
    // Positive control: the same call without a token is the self-bootstrap row.
    const tokenless = decide({ tool: "rks_agent_research", args, context: { stage: "bootstrap", lane: "ide", tokenPresent: false, tokenGateArmed: true } });
    expect(tokenless.matchedRule).toBe("bootstrap.open.research-self-bootstrap");
    expect(tokenless.action).toBe("bootstrap_session");
  });
});

describe("lane refusal parity", () => {
  it("every lane-stage deny row yields a non-null laneRefusal with the same reason", () => {
    const denyRows = ADMISSION_TABLE.filter((r) => r.stage === "lane" && r.effect === "deny");
    expect(denyRows.length).toBeGreaterThan(0);
    const hit = new Set();
    for (const input of generatedInputs().filter((i) => i.context.stage === "lane")) {
      const decision = decide(input);
      if (decision.effect !== "deny") continue;
      const { stage, ...laneInput } = input.context;
      const body = laneRefusal({ tool: input.tool, args: input.args, ...laneInput });
      expect(body, `${decision.matchedRule}: ${input.tool} ${laneInput.lane}`).not.toBeNull();
      hit.add(decision.matchedRule);
      if (decision.matchedRule === "lane.policy-refusal") {
        // The policy row's reason is the umbrella label for every decideLane refusal; the body
        // carries decideLane's own reason, so parity is with decideLane.
        expect(decision.reason).toBe("lane_refused");
        expect(body.reason).toBe(decideLane({ tool: input.tool, args: input.args, ...laneInput }).reason);
      } else {
        expect(body.reason).toBe(decision.reason);
      }
    }
    expect([...hit].sort()).toEqual(denyRows.map((r) => r.id).sort());
  });
});

const PROBE = "__mutation_probe__";
const attemptMutation = (set) => {
  const outcomes = [];
  for (const attempt of [() => set.add(PROBE), () => set.delete([...set][0]), () => set.clear()]) {
    try { attempt(); outcomes.push("returned"); } catch { outcomes.push("threw"); }
  }
  return outcomes;
};
const sessionDecision = (flowType, state, tool) =>
  decide({ tool, args: { projectId: "p" }, session: { flowType, state }, context: { stage: "session", tokenPresent: true, tokenValid: true, tokenGateArmed: true } });

describe("read-only state views", () => {
  it("allowed rejects mutation and checkStateAllowed agrees with decide afterwards", () => {
    for (const flow of FLOWS) {
      for (const [state, entry] of Object.entries(getStates(flow))) {
        const before = [...entry.allowed];
        const first = before[0];
        attemptMutation(entry.allowed);
        expect([...getStates(flow)[state].allowed], `${flow}.${state}`).toEqual(before);
        expect(checkStateAllowed(flow, state, PROBE).allowed).toBe(false);
        expect(sessionDecision(flow, state, PROBE).effect).toBe("deny");
        if (first !== undefined) {
          expect(checkStateAllowed(flow, state, first).allowed, `${flow}.${state} ${first}`)
            .toBe(sessionDecision(flow, state, first).effect === "allow");
        }
      }
    }
  });

  it("allowed keeps Set read behaviour and refusal text after an attempted mutation", () => {
    for (const flow of FLOWS) {
      for (const [state, entry] of Object.entries(getStates(flow))) {
        const set = entry.allowed;
        expect(set).toBeInstanceOf(Set);
        const order = [...set];
        const size = set.size;
        const refusal = checkStateAllowed(flow, state, PROBE);
        attemptMutation(set);
        expect(set).toBeInstanceOf(Set);
        expect(set.size).toBe(size);
        expect([...set]).toEqual(order);
        expect(Array.from(set.values())).toEqual(order);
        for (const tool of order) expect(set.has(tool)).toBe(true);
        expect(set.has(PROBE)).toBe(false);
        expect(checkStateAllowed(flow, state, PROBE)).toEqual(refusal);
      }
    }
  });
});

describe("read-only NAMESPACE_ALLOWLIST", () => {
  it("NAMESPACE_ALLOWLIST is frozen and its Sets reject mutation", () => {
    expect(Object.isFrozen(NAMESPACE_ALLOWLIST)).toBe(true);
    const sets = Object.entries(NAMESPACE_ALLOWLIST).filter(([, v]) => v !== null);
    expect(sets.length).toBeGreaterThan(0);
    for (const [flow, set] of sets) {
      const before = [...set];
      attemptMutation(set);
      expect(set, flow).toBeInstanceOf(Set);
      expect([...set], flow).toEqual(before);
    }
  });

  it("namespaceAllowlistRefusal results are unchanged after an attempted mutation", () => {
    const write = (flowType, filename) => namespaceAllowlistRefusal({ tool: "dendron_create_note", args: { filename }, session: { flowType } });
    const cases = [["story", "scratch.x"], ["story", "backlog.x"], ["qa", "notes.x"], ["qa", "qa.x"], ["open", "scratch.x"]];
    const before = cases.map(([f, n]) => write(f, n));
    expect(before[0]).not.toBeNull();
    expect(before[1]).toBeNull();
    for (const set of Object.values(NAMESPACE_ALLOWLIST)) if (set) attemptMutation(set);
    expect(cases.map(([f, n]) => write(f, n))).toEqual(before);
  });
});

describe("governor-token comments", () => {
  it("no comment claims server.mjs or the outer gate runs checkAllowedTool", () => {
    const src = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs"), "utf8");
    const text = src.split("\n").map((l) => l.replace(/^\s*(\/\*\*|\*\/|\*|\/\/)\s?/, "")).join(" ").replace(/\s+/g, " ");
    expect(text).toContain("checkAllowedTool"); // scope control: the normalised text is searchable
    expect(text).not.toMatch(/checkAllowedTool`?,? which server\.mjs calls for every governed tool call/);
    expect(text).not.toMatch(/server\.mjs calls[^.]*checkAllowedTool|checkAllowedTool[^.]*which server\.mjs calls/);
    expect(text).not.toMatch(/outer gate,? which runs `?checkAllowedTool/);
  });
});

describe("manifest evidence after 572f1619", () => {
  it("every evidence literal citing an admission source file is present in its cited file", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/backlog-archive-manifest.json"), "utf8"));
    const cited = new Set([
      "packages/mcp-rks/src/server.mjs",
      ...["admission-table", "governor-state", "governor-token", "lane-policy"].map((n) => `packages/mcp-rks/src/shared/${n}.mjs`),
    ]);
    const entries = [];
    const walk = (node, id) => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, id));
      if (!node || typeof node !== "object") return;
      const owner = typeof node.id === "string" ? node.id : id;
      if (typeof node.file === "string" && typeof node.literal === "string") entries.push({ id: owner, ...node });
      for (const v of Object.values(node)) walk(v, owner);
    };
    walk(manifest.doneInCode, null);
    const relevant = entries.filter((e) => cited.has(e.file));
    expect(relevant.length).toBeGreaterThan(0);
    const misses = relevant.filter((e) => {
      const abs = path.join(ROOT, e.file);
      return !fs.existsSync(abs) || !fs.readFileSync(abs, "utf8").includes(e.literal);
    }).map((e) => `${e.id} ${e.file} :: ${e.literal}`);
    expect(misses).toEqual([]);
  });
});
