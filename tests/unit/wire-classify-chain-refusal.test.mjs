/**
 * backlog.feat.wire-classify-chain-refusal
 *
 * v0.43.0 shipped `classifyChainRefusal` exported, unit-tested, and called by nothing — and it
 * was additionally INERT even if wired, because its phase half requires a `phaseAllows` probe
 * and no production supplier of `storyPhase` existed. So its whole reason for existing, the
 * `blockedBy: 'both'` / `wedged` case, was unreachable by construction.
 *
 * This suite pins the wiring, the probe, and the four hazards that make the wiring dangerous:
 *   A — call-site placement (the classifier bypasses STATE_BYPASS_TOOLS and COMMON_TOOLS, so
 *       it is only correct AT the refusal site)
 *   B — the decoy second refusal builder `assertToolAllowed`, which must not be wired
 *   C — the phase resolver must never throw; an existing test drives it with a nonexistent note
 *   D — no new top-level `export function` in governor-token.mjs, or source-window slices in
 *       four other suites truncate
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { phaseAllows, PHASE_GATE_EXEC, OPERATION_TRANSITIONS } from "../../packages/mcp-rks/src/workflow/phases.mjs";
import { createSession, checkAllowedTool, getSession, endSession, setProjectRoot } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { makeTempDir, ensureDir } from "../helpers/tmp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOKEN_SRC = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs"), "utf8");

describe("phaseAllows — the probe that makes the classifier non-inert", () => {
  it("permits any tool that is not phase-gated", () => {
    // A tool wrongly reported as phase-blocked sends the caller down the wrong recovery, so
    // the default must be permissive.
    expect(phaseAllows("draft", "rks_agent_research")).toBe(true);
    expect(phaseAllows("integrated", "rks_refine")).toBe(true);
  });

  it("gates rks_exec on the exec phase", () => {
    expect(phaseAllows(PHASE_GATE_EXEC, "rks_exec")).toBe(true);
    expect(phaseAllows("arch-approved", "rks_exec")).toBe(false);
    expect(phaseAllows("draft", "rks_exec")).toBe(false);
  });

  it("gates rks_plan from the phase machine, not a hardcoded list", () => {
    // Derived from OPERATION_TRANSITIONS so it cannot drift from the machine the rest of the
    // system obeys — asserted against that same source rather than against literals.
    for (const phase of OPERATION_TRANSITIONS.plan.from) {
      expect(phaseAllows(phase, "rks_plan"), `${phase} should permit rks_plan`).toBe(true);
    }
    expect(phaseAllows("draft", "rks_plan")).toBe(false);
  });

  it("treats an unknown or empty phase as permissive rather than blocking", () => {
    for (const phase of [null, undefined, "", 42, {}]) {
      expect(phaseAllows(phase, "rks_exec")).toBe(true);
    }
  });
});

describe("the refusal is enriched at the refusal site", () => {
  let token;
  let root;

  beforeEach(() => {
    root = makeTempDir("classify-refusal");
    ensureDir(path.join(root, "notes"));
    setProjectRoot(root);
    ({ token } = createSession({ projectId: "p", flowType: "story", problemId: "backlog.fix.x" }));
  });

  afterEach(() => {
    try { endSession(token); } catch { /* already ended */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("an allowed call returns null and is NOT classified", () => {
    // Hazard A: the classifier must never run on the allowed path.
    getSession(token).state = "refining";
    expect(checkAllowedTool(token, "rks_refine")).toBeNull();
  });

  it("a COMMON_TOOLS call returns null before reaching the classifier", () => {
    // Hazard A: COMMON_TOOLS returns early. classifyChainRefusal recomputes state-blocking
    // itself and does not honour that early return, so it must never see these.
    expect(checkAllowedTool(token, "rks_project_get")).toBeNull();
  });

  it("a refused call carries a refusal classification", () => {
    getSession(token).state = "refining";
    const res = checkAllowedTool(token, "rks_exec");
    expect(res).not.toBeNull();
    expect(res.error).toBe("chain_violation");
    expect(res.blockedBy).toBeTruthy();
    expect(res.tool).toBe("rks_exec");
    // `state` carries the chain state; the classifier's own `chainState` is deliberately NOT
    // hoisted, so one fact has exactly one spelling on this object.
    expect(res.state).toBe("refining");
    expect(res).not.toHaveProperty("chainState");
  });

  it("reports the WEDGE when state and phase block independently", () => {
    // The case the classifier exists for, and which was unreachable before the probe.
    // refining forbids rks_exec; phase arch-approved also forbids it.
    fs.writeFileSync(
      path.join(root, "notes", "backlog.fix.x.md"),
      '---\nid: "backlog.fix.x"\nphase: "arch-approved"\n---\n\n## Problem\n',
    );
    getSession(token).state = "refining";
    const res = checkAllowedTool(token, "rks_exec");
    expect(res.blockedBy).toBe("both");
    expect(res.wedged).toBe(true);
    expect(res.storyPhase).toBe("arch-approved");
    expect(res.recovery.join(" ")).toContain("rks_exec_abort");
  });

  it("reports state-only when the phase permits the tool", () => {
    fs.writeFileSync(
      path.join(root, "notes", "backlog.fix.x.md"),
      `---\nid: "backlog.fix.x"\nphase: "${PHASE_GATE_EXEC}"\n---\n\n## Problem\n`,
    );
    getSession(token).state = "refining";
    const res = checkAllowedTool(token, "rks_exec");
    expect(res.blockedBy).toBe("state");
    expect(res.wedged).toBe(false);
  });

  it("preserves every pre-existing field on the refusal object", () => {
    // Strictly additive — server.mjs serialises this verbatim, so removing a field would
    // change what every caller sees.
    getSession(token).state = "refining";
    const res = checkAllowedTool(token, "rks_exec");
    for (const key of ["ok", "error", "tool", "flowType", "state", "message"]) {
      expect(res, `lost field ${key}`).toHaveProperty(key);
    }
    expect(res.ok).toBe(false);
  });
});

describe("HAZARD C — the phase resolver never throws", () => {
  let token;
  let root;

  beforeEach(() => {
    root = makeTempDir("classify-refusal-degrade");
    ensureDir(path.join(root, "notes"));
    setProjectRoot(root);
  });

  afterEach(() => {
    try { endSession(token); } catch { /* already ended */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("a problemId whose note does NOT exist degrades to phase-unknown", () => {
    // This is not hypothetical: tests/unit/assert-tool-allowed.test.mjs drives exactly this
    // shape — story flow, problemId 'story-1', no such note — straight onto the refusal path.
    ({ token } = createSession({ projectId: "p", flowType: "story", problemId: "story-1" }));
    getSession(token).state = "refining";
    const res = checkAllowedTool(token, "rks_exec");
    expect(res.storyPhase).toBeNull();
    expect(res.blockedBy).toBe("state");
  });

  it("unparseable frontmatter degrades rather than throwing", () => {
    ({ token } = createSession({ projectId: "p", flowType: "story", problemId: "backlog.fix.bad" }));
    fs.writeFileSync(
      path.join(root, "notes", "backlog.fix.bad.md"),
      "---\nphase: \"unclosed\nid: [oops\n---\nbody\n",
    );
    getSession(token).state = "refining";
    expect(() => checkAllowedTool(token, "rks_exec")).not.toThrow();
  });

  it("a session with no problemId degrades to phase-unknown", () => {
    ({ token } = createSession({ projectId: "p", flowType: "open" }));
    getSession(token).state = "researching";
    const res = checkAllowedTool(token, "rks_exec");
    expect(res).not.toBeNull();
    expect(res.storyPhase).toBeNull();
  });

  it("a null _projectRoot degrades to phase-unknown", () => {
    setProjectRoot(null);
    ({ token } = createSession({ projectId: "p", flowType: "story", problemId: "backlog.fix.x" }));
    getSession(token).state = "refining";
    expect(() => checkAllowedTool(token, "rks_exec")).not.toThrow();
  });
});

describe("HAZARD B — the decoy builder is not wired", () => {
  it("assertToolAllowed does not reference classifyChainRefusal", () => {
    // assertToolAllowed has no production caller and builds its own chain_violation twice.
    // Wiring that one instead would enrich nothing the server ever returns.
    const idx = TOKEN_SRC.indexOf("export function assertToolAllowed");
    expect(idx).toBeGreaterThan(-1);
    expect(TOKEN_SRC.slice(idx)).not.toContain("classifyChainRefusal");
  });

  it("every classifyChainRefusal reference sits inside checkAllowedTool", () => {
    const start = TOKEN_SRC.indexOf("export function checkAllowedTool");
    const end = TOKEN_SRC.indexOf("\nexport function", start + 1);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = TOKEN_SRC.slice(start, end);
    // Count INVOCATIONS, not mentions — prose in comments referring to the classifier is not
    // a wiring. There must be exactly one call in the file, and it must be in this body.
    const callsTotal = (TOKEN_SRC.match(/classifyChainRefusal\s*\(/g) || []).length;
    const callsInside = (body.match(/classifyChainRefusal\s*\(/g) || []).length;
    expect(callsTotal).toBe(1);
    expect(callsInside).toBe(1);
  });
});

describe("HAZARD D — no new top-level export in governor-token.mjs", () => {
  it("the phase resolver is NOT exported", () => {
    // Four suites bound source windows with indexOf("\nexport function"). A new top-level
    // export anywhere in this file truncates one of them. A plain `function` is invisible.
    expect(TOKEN_SRC).toContain("function resolveStoryPhase");
    expect(TOKEN_SRC).not.toContain("export function resolveStoryPhase");
  });

  it("the resolver is declared before checkAllowedTool", () => {
    const resolver = TOKEN_SRC.indexOf("function resolveStoryPhase");
    const check = TOKEN_SRC.indexOf("export function checkAllowedTool");
    expect(resolver).toBeGreaterThan(-1);
    expect(resolver).toBeLessThan(check);
  });

  it("nothing was inserted inside the if (!session) branch", () => {
    // research-agent-self-bootstrap.test.mjs takes a FIXED 400-character window from
    // `if (!session)` and asserts on its contents — roughly ten lines of margin.
    const start = TOKEN_SRC.indexOf("export function checkAllowedTool");
    const body = TOKEN_SRC.slice(start);
    const noSession = body.indexOf("if (!session)");
    const window = body.slice(noSession, noSession + 400);
    expect(window).toMatch(/ok:\s*false/);
    expect(window).toMatch(/error:\s*['"]unauthorized['"]/);
    expect(window).not.toMatch(/return null/);
  });
});
