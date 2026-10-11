/**
 * Witness for backlog.fix.agent-definition-unknown-keys-silently-dropped.
 *
 * `agentDefinitionSchema` is a plain `z.object` with no `.strict()`, and a `z.object` STRIPS keys it
 * does not declare. So an author who wrote `"prompt": "..."` into `.rks/agents/<name>.json` got
 * `ok: true` back, the agent registered, and their key was gone — a success report on a definition
 * that had lost its payload.
 *
 * REPORTED, NOT REFUSED. `registry.mjs` faces the same problem at per-call dispatch and refuses,
 * because there a dropped key changes what work runs. This is a startup registration: refusing would
 * turn "registers minus a key" into "the agent vanishes", for a mechanism with no working example
 * anywhere to calibrate against. The set-difference derivation is copied from that precedent; the
 * verdict deliberately is not.
 *
 * Honest scope note, recorded rather than glossed: this fix cannot make a project agent WORK. The
 * mechanism reaches the runner with no prompt, no user message and no tools, and three of its six
 * declared fields are read by nothing. Its value is that an author who hits that wall is now told
 * which of their keys evaporated instead of being left to guess.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateAgentDefinition,
  AGENT_DEFINITION_KEYS,
} from "../../packages/mcp-rks/src/shared/agent-schema.mjs";
import {
  discoverProjectAgents,
  registerProjectAgents,
} from "../../packages/mcp-rks/src/agents/discovery.mjs";

const VALID = { name: "trading-ops", description: "does trading things" };

let tmpRoot;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-agent-defs-"));
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Writes one definition file and returns the project root the discovery loop is given. */
function writeDefinition(filename, definition) {
  const dir = path.join(tmpRoot, ".rks", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), `${JSON.stringify(definition, null, 2)}\n`);
  return tmpRoot;
}

describe("validateAgentDefinition names the keys it dropped", () => {
  it("reports an undeclared key BY NAME rather than succeeding silently", () => {
    const res = validateAgentDefinition({ ...VALID, prompt: "You are a trading agent." });

    expect(res.ok).toBe(true); // still registers — reported, not refused
    expect(res.unknownKeys).toEqual(["prompt"]);
    // And the key really is gone from the parsed data — the report is not cosmetic.
    expect(res.data.prompt).toBeUndefined();
  });

  it("reports ALL undeclared keys, not just the first", () => {
    const res = validateAgentDefinition({
      ...VALID,
      prompt: "p",
      model: "claude-opus-5",
      maxTurns: 10,
    });

    expect(res.unknownKeys).toEqual(["maxTurns", "model", "prompt"]);
  });

  it("a definition using only declared keys reports nothing dropped", () => {
    const res = validateAgentDefinition({
      ...VALID,
      allowedTools: ["rks_preflight"],
      guardrails: { maxSpend: 100 },
    });

    expect(res.ok).toBe(true);
    expect(res.unknownKeys).toEqual([]);
    expect(res.data.allowedTools).toEqual(["rks_preflight"]);
  });

  it("the field is ALWAYS present, so a caller never has to test for presence first", () => {
    // A conditionally-attached field reads the same as "nothing was dropped" whether or not the
    // check ran — the ambiguity this fix exists to remove.
    expect(validateAgentDefinition(VALID).unknownKeys).toEqual([]);
  });

  it("an arbitrary key INSIDE guardrails is not reported — that is the declared contract", () => {
    // guardrails is z.record(z.unknown()); reporting its keys would be noise, not a finding.
    const res = validateAgentDefinition({
      ...VALID,
      guardrails: { anythingAtAll: true, nested: { deep: 1 } },
    });

    expect(res.unknownKeys).toEqual([]);
    expect(res.data.guardrails).toEqual({ anythingAtAll: true, nested: { deep: 1 } });
  });

  it("the recognised-key list is DERIVED from the schema, not restated", () => {
    // A hand-written second list is free to drift from the schema — the same defect class.
    expect(AGENT_DEFINITION_KEYS).toEqual([
      "name",
      "description",
      "allowedTools",
      "telemetryEvents",
      "guardrails",
      "validationHooks",
    ]);
  });
});

describe("REGRESSION GUARD — a definition invalid on a DECLARED key still fails as before", () => {
  it.each([
    ["missing name", { description: "d" }],
    ["non-string name", { name: 42, description: "d" }],
    ["allowedTools holding a non-string", { ...VALID, allowedTools: ["ok", 7] }],
    ["telemetryEvent missing name", { ...VALID, telemetryEvents: [{ fields: ["a"] }] }],
  ])("%s returns ok:false with path-prefixed error strings", (_label, definition) => {
    const res = validateAgentDefinition(definition);

    expect(res.ok).toBe(false);
    expect(Array.isArray(res.errors)).toBe(true);
    expect(res.errors.length).toBeGreaterThan(0);
    for (const e of res.errors) expect(typeof e).toBe("string");
    // The failure path carries no unknownKeys — there is no validated data to report against.
    expect(res.unknownKeys).toBeUndefined();
  });
});

describe("the real discovery loop warns on the SUCCESS path", () => {
  it("ANTI-VACUITY — a dropped key is named, with its filename, and the agent still registers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = writeDefinition("trading-ops.json", { ...VALID, prompt: "You are a trading agent." });

    const agents = discoverProjectAgents(root);

    expect(agents).toHaveLength(1); // registered, not skipped
    expect(agents[0].name).toBe("trading-ops");

    const messages = warn.mock.calls.map((c) => String(c[0]));
    const dropped = messages.find((m) => m.includes("DROPPED"));
    expect(dropped, `no dropped-key warning in: ${JSON.stringify(messages)}`).toBeTruthy();
    expect(dropped).toContain("trading-ops.json");
    expect(dropped).toContain("prompt");
  });

  it("the dropped-key warning is DISTINGUISHABLE from the invalid-agent warning", () => {
    // Different consequence, different wording: one says the agent was skipped, the other says it
    // registered and part of what the author wrote did not survive.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeDefinition("good.json", { ...VALID, name: "good", prompt: "p" });
    writeDefinition("bad.json", { description: "no name here" });

    const agents = discoverProjectAgents(tmpRoot);
    const messages = warn.mock.calls.map((c) => String(c[0]));

    expect(agents.map((a) => a.name)).toEqual(["good"]);
    expect(messages.find((m) => m.includes("Skipping invalid agent"))).toContain("bad.json");
    expect(messages.find((m) => m.includes("DROPPED"))).toContain("good.json");
  });

  it("a clean definition produces NO dropped-key warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = writeDefinition("clean.json", { ...VALID, name: "clean", allowedTools: ["rks_preflight"] });

    expect(discoverProjectAgents(root)).toHaveLength(1); // positive control
    expect(warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes("DROPPED"))).toBeUndefined();
  });
});

describe("REGRESSION GUARD — what a registered agent carries is unchanged", () => {
  it("the factory still emits its full field set with the same defaults", () => {
    // NOTE: the story's acceptance criterion says "six fields"; the factory emits TEN. Asserted as
    // the measured set, and deliberately without a line range — this story's own edits shift lines
    // in this file, so a pinned range would be self-invalidating.
    const root = writeDefinition("shape.json", { ...VALID, name: "shape", prompt: "dropped" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = {};

    registerProjectAgents(registry, discoverProjectAgents(root));
    const config = registry.shape.factory({ projectId: "p", projectRoot: "/tmp/p" });

    expect(Object.keys(config).sort()).toEqual([
      "allowedTools",
      "description",
      "guardrails",
      "name",
      "projectId",
      "projectRoot",
      "request",
      "source",
      "telemetryEvents",
      "validationHooks",
    ]);
    expect(config.allowedTools).toEqual([]);
    expect(config.telemetryEvents).toEqual([]);
    expect(config.guardrails).toEqual({});
    expect(config.validationHooks).toEqual({});
    expect(config.request).toBe("");
    expect(config.source).toBe("project");
    // The dropped key is not smuggled through the factory either.
    expect(config.prompt).toBeUndefined();
  });
});
