/**
 * backlog.fix.governor-po-prompt-chain-states — prompt-vs-table check.
 *
 * Both PO prompts (shell and templates/base) are replayed against the REAL open-flow
 * state table so their research-step count and state labels cannot drift from it again.
 *
 * Run:
 *   npx vitest run --config vitest.config.unit.mjs tests/unit/governor-po-prompt-chain-states.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getNextState } from "../../packages/mcp-rks/src/shared/governor-state.mjs";
import {
  createSession,
  advanceState,
  checkAllowedTool,
  endSession,
  setProjectRoot,
} from "../../packages/mcp-rks/src/shared/governor-token.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHELL = ".rks/prompts/governor-po.md";
const TEMPLATE = "templates/base/.rks/prompts/governor-po.md";
const OPEN_STATE_NAMES = ["init", "researching", "concern-separating", "test-file-scanning", "writing", "review", "failed"];
const STEP_RE = /^(\d+[a-z]?)\.\s/;
const RESEARCH_CALL = "mcp__rks__rks_agent_research(";
const CREATE_CALL = "mcp__rks__dendron_create_note(";

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

function chainSection(src) {
  const start = src.indexOf("## Chain");
  if (start === -1) return "";
  const end = src.indexOf("\n## ", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

/** Split the Chain section into step blocks { id, head, text }; a block runs to the next step line. */
function steps(src) {
  const out = [];
  for (const line of chainSection(src).split("\n")) {
    const m = line.match(STEP_RE);
    if (m) out.push({ id: m[1], head: line, text: line });
    else if (out.length) out[out.length - 1].text += "\n" + line;
  }
  return out;
}

/** The research steps that precede the first backlog create step. */
function researchBeforeCreate(src) {
  const all = steps(src);
  const createIdx = all.findIndex((s) => s.head.includes(CREATE_CALL));
  const before = createIdx === -1 ? [] : all.slice(0, createIdx);
  return { all, createIdx, research: before.filter((s) => s.head.includes(RESEARCH_CALL)) };
}

/** Replay n rks_agent_research calls through the open-flow table from init. */
function replay(n) {
  const reached = [];
  let state = "init";
  for (let i = 0; i < n; i++) {
    state = getNextState("open", state, "rks_agent_research");
    reached.push(state);
  }
  return { state, reached };
}

/** Open-flow state names mentioned in a piece of text (bounded, so 'init' does not match 'initial'). */
const statesNamed = (text) =>
  OPEN_STATE_NAMES.filter((s) => new RegExp(`(^|[^a-z-])${s}([^a-z-]|$)`, "m").test(text));

let tmpRoot;
beforeAll(() => {
  // Sessions persist to disk; keep them out of the repository.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "po-chain-states-"));
  setProjectRoot(tmpRoot);
});
afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** checkAllowedTool result for a backlog create after n research calls on a real open session. */
function backlogCreateAfter(n) {
  const token = createSession({ projectId: "po-chain-states-test", flowType: "open" }).token;
  try {
    for (let i = 0; i < n; i++) advanceState(token, "rks_agent_research");
    return checkAllowedTool(token, "dendron_create_note", { filename: "backlog.feat.some-story" });
  } finally {
    endSession(token);
  }
}

describe("governor-po prompt chain states", () => {
  it("shell prompt research steps replay from init to test-file-scanning", () => {
    const { research } = researchBeforeCreate(read(SHELL));
    expect(replay(research.length).state).toBe("test-file-scanning");
  });

  it("template prompt research steps replay from init to test-file-scanning", () => {
    const { research } = researchBeforeCreate(read(TEMPLATE));
    expect(replay(research.length).state).toBe("test-file-scanning");
  });

  it("replayed research count admits backlog create and one fewer is refused", () => {
    for (const rel of [SHELL, TEMPLATE]) {
      const n = researchBeforeCreate(read(rel)).research.length;
      expect(n, rel).toBeGreaterThan(1);
      expect(backlogCreateAfter(n), rel).toBeNull();
      const refused = backlogCreateAfter(n - 1);
      expect(refused?.ok, rel).toBe(false);
      expect(refused.error, rel).toBe("namespace_violation");
    }
  });

  it("shell prompt research step labels match the state table", () => {
    const { research } = researchBeforeCreate(read(SHELL));
    expect(research.map((s) => s.id)).toEqual(["1", "1c", "1d"]);
    const { reached } = replay(research.length);
    research.forEach((step, i) => {
      expect(statesNamed(step.text), `step ${step.id}`).toContain(reached[i]);
      for (const line of step.text.split("\n").filter((l) => /advance/i.test(l))) {
        expect(statesNamed(line).filter((s) => s !== reached[i]), `step ${step.id}: ${line}`).toEqual([]);
      }
    });
  });

  it("shell prompt step 1d states backlog create is admitted on entering test-file-scanning", () => {
    const d = steps(read(SHELL)).find((s) => s.id === "1d");
    expect(d).toBeDefined();
    const lines = d.text.split("\n");
    expect(
      lines.some((l) => l.includes("dendron_create_note") && /backlog/.test(l) && l.includes("test-file-scanning")),
    ).toBe(true);
    expect(d.text).not.toMatch(/advances the chain to `?writing/);
  });

  it("shell prompt step 1b external research wording matches init and later-state transitions", () => {
    expect(getNextState("open", "init", "rks_agent_external_research")).toBe("researching");
    for (const s of ["researching", "concern-separating", "test-file-scanning", "writing"]) {
      expect(getNextState("open", s, "rks_agent_external_research"), s).toBe(s);
    }
    const b = steps(read(SHELL)).find((s) => s.id === "1b");
    expect(b).toBeDefined();
    expect(b.text).not.toContain("(does not advance state");
    expect(statesNamed(b.text)).toEqual(expect.arrayContaining(["init", "researching"]));
  });

  it("template prompt has MANDATORY 1c and 1d research steps before the backlog create with corrected labels", () => {
    const { all, createIdx } = researchBeforeCreate(read(TEMPLATE));
    const ci = all.findIndex((s) => s.id === "1c");
    const di = all.findIndex((s) => s.id === "1d");
    expect(ci).toBeGreaterThan(-1);
    expect(di).toBeGreaterThan(ci);
    expect(createIdx).toBeGreaterThan(di);
    for (const [idx, state] of [[ci, "concern-separating"], [di, "test-file-scanning"]]) {
      expect(all[idx].head).toContain(RESEARCH_CALL);
      expect(all[idx].head).toContain("MANDATORY");
      expect(statesNamed(all[idx].text)).toContain(state);
    }
  });

  it("parser positive control and single-research-step fixture replays to researching", () => {
    for (const rel of [SHELL, TEMPLATE]) {
      const { all, research } = researchBeforeCreate(read(rel));
      expect(all.filter((s) => s.head.includes(CREATE_CALL)), rel).toHaveLength(1);
      expect(research.length, rel).toBeGreaterThan(0);
    }
    // The pre-fix template shape: one research step, then the backlog create.
    const fixture = [
      "## Chain",
      "0. mcp__rks__rks_governor_init({ projectId: 'p' })",
      "1. mcp__rks__rks_agent_research({ projectId: 'p', query: 'q' })",
      "2. mcp__rks__dendron_create_note({ projectId: 'p', filename: 'backlog.feat.x' })",
      "",
      "## Rules",
    ].join("\n");
    const { research } = researchBeforeCreate(fixture);
    expect(research).toHaveLength(1);
    expect(replay(research.length).state).toBe("researching");
  });
});
