import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { reenableGuardrailsAfterExec } from "../../packages/mcp-rks/src/server/exec.mjs";

const execPath = path.resolve("packages/mcp-rks/src/server/exec.mjs");
const typesPath = path.resolve("packages/telemetry/src/types.mjs");

describe("exec divergence telemetry", () => {
  const execSource = fs.readFileSync(execPath, "utf8");
  const typesSource = fs.readFileSync(typesPath, "utf8");

  it("exec.mjs emits exec.guardrails_off when guardrails are disabled", () => {
    expect(execSource).toContain('emit("exec.guardrails_off"');
  });

  it("exec.mjs emits exec.guardrails_on when guardrails are re-enabled", () => {
    expect(execSource).toContain('emit("exec.guardrails_on"');
  });

  it("exec.mjs emits exec.divergence_detected on per-step divergence", () => {
    expect(execSource).toContain('emit("exec.divergence_detected"');
  });

  it("no references to exec.off_rail.start remain in exec.mjs", () => {
    expect(execSource).not.toContain("exec.off_rail.start");
  });

  it("no references to exec.off_rail.complete remain in exec.mjs", () => {
    expect(execSource).not.toContain("exec.off_rail.complete");
  });

  it("types.mjs defines EXEC_GUARDRAILS_OFF constant", () => {
    expect(typesSource).toContain('EXEC_GUARDRAILS_OFF: "exec.guardrails_off"');
  });

  it("types.mjs defines EXEC_GUARDRAILS_ON constant", () => {
    expect(typesSource).toContain('EXEC_GUARDRAILS_ON: "exec.guardrails_on"');
  });

  it("types.mjs defines EXEC_DIVERGENCE_DETECTED constant", () => {
    expect(typesSource).toContain('EXEC_DIVERGENCE_DETECTED: "exec.divergence_detected"');
  });

  it("no references to off_rail remain in types.mjs", () => {
    expect(typesSource).not.toContain("off_rail");
  });
});

// backlog.fix.offrail-hooks-bak-orphan-restore-fail-closed (AC11)
function recordingCollector() {
  const events = [];
  return { events, emit: (type, projectId, payload) => { events.push({ type, projectId, payload }); } };
}
const callHelper = (guardrailsOn, collector) =>
  reenableGuardrailsAfterExec({ guardrailsOn, collector, projectRoot: "/nonexistent-root", projectId: "p", payload: { problemId: "backlog.x" } });
const onEvents = (c) => c.events.filter((e) => e.type === "exec.guardrails_on");

describe("reenableGuardrailsAfterExec (AC11)", () => {
  it("observes a non-ok guardrailsOn result and emits exec.guardrails_on with ok=false, reason and provenance", async () => {
    const collector = recordingCollector();
    const res = await callHelper(async () => ({ ok: false, reason: "hooks_backup_missing", provenance: null }), collector);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("hooks_backup_missing");
    expect(Object.prototype.hasOwnProperty.call(res, "provenance")).toBe(true);
    expect(res.provenance).toBeNull();
    const evs = onEvents(collector);
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.ok).toBe(false);
    expect(evs[0].payload.reason).toBe("hooks_backup_missing");
    expect(Object.prototype.hasOwnProperty.call(evs[0].payload, "provenance")).toBe(true);
    expect(evs[0].payload.provenance).toBeNull();
  });

  it("treats a thrown guardrailsOn as non-ok without throwing", async () => {
    const collector = recordingCollector();
    const res = await callHelper(async () => { throw new Error("boom"); }, collector);
    expect(res.ok).toBe(false);
    expect(typeof res.reason).toBe("string");
    expect(res.reason.length).toBeGreaterThan(0);
    const evs = onEvents(collector);
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.ok).toBe(false);
  });

  it("reports ok=true only when guardrailsOn resolves ok === true", async () => {
    const collector = recordingCollector();
    const res = await callHelper(async () => ({ ok: true }), collector);
    expect(res.ok).toBe(true);
    const evs = onEvents(collector);
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.ok).toBe(true);
    const missing = await callHelper(async () => undefined, recordingCollector());
    expect(missing.ok).toBe(false);
  });
});

describe("exec.mjs call sites route through reenableGuardrailsAfterExec (AC11, source)", () => {
  const src = fs.readFileSync(execPath, "utf8");
  const declAt = src.indexOf("function reenableGuardrailsAfterExec(");
  const declEnd = src.indexOf("\n}\n", declAt);

  it("declares the helper once and every guardrailsOn( call sits inside it", () => {
    expect(declAt).toBeGreaterThan(-1);
    expect(src.indexOf("function reenableGuardrailsAfterExec(", declAt + 1)).toBe(-1);
    expect(declEnd).toBeGreaterThan(declAt);
    const calls = [...src.matchAll(/guardrailsOn\(/g)].map((m) => m.index);
    expect(calls.length).toBeGreaterThan(0);
    for (const at of calls) {
      expect(at).toBeGreaterThan(declAt);
      expect(at).toBeLessThan(declEnd);
    }
    const sites = [...src.matchAll(/reenableGuardrailsAfterExec\(/g)].map((m) => m.index).filter((i) => i < declAt || i > declEnd);
    expect(sites).toHaveLength(2);
  });

  it("the divergence path calls the helper and surfaces guardrailsRestore and guardrailsWarning", () => {
    const start = src.indexOf('applyResult.error === "exec.diverged"');
    const end = src.indexOf("let appliedFiles = applyResult.appliedFiles", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toContain("reenableGuardrailsAfterExec(");
    expect(block).toContain("guardrailsRestore");
    expect(block).toContain("guardrailsWarning");
  });

  it("the post-commit restore calls the helper and the pending_ship result carries guardrailsRestore and guardrailsWarning", () => {
    const afterDivergence = src.indexOf("let appliedFiles = applyResult.appliedFiles");
    const idxShip = src.indexOf("status: 'pending_ship'");
    expect(afterDivergence).toBeGreaterThan(-1);
    expect(idxShip).toBeGreaterThan(afterDivergence);
    expect(src.slice(afterDivergence, idxShip)).toContain("reenableGuardrailsAfterExec(");
    const shipObj = src.slice(src.lastIndexOf("return {", idxShip), src.indexOf("};", idxShip));
    expect(shipObj).toContain("guardrailsRestore");
    expect(shipObj).toContain("guardrailsWarning");
  });
});
