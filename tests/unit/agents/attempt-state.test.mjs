/**
 * backlog.feat.runner-attempt-lifecycle - unit contract for the attempt-state primitive.
 * Pure in-memory; no LLM, no filesystem, no subprocess.
 */
import { describe, it, expect, vi } from "vitest";
import { createAttemptState } from "../../../packages/mcp-rks/src/agents/attempt-state.mjs";

const restart = (index, kind = "same_model_retry") => ({ index, kind, model: "m", resumed: false });
const resume = (index) => ({ index, kind: "escalation", model: "m2", resumed: true });

describe("createAttemptState - scoped()", () => {
  it("returns the init() value and lists the name in snapshot().items", () => {
    const s = createAttemptState();
    const b = s.scoped("budget", () => ({ used: 0 }));
    expect(b).toEqual({ used: 0 });
    expect(s.snapshot().items).toEqual(["budget"]);
  });

  it("rejects a non-function init, an unknown onResume, and a duplicate name", () => {
    const s = createAttemptState();
    expect(() => s.scoped("a", { used: 0 })).toThrow(TypeError);
    expect(() => s.scoped("b", () => ({}), { onResume: "keep" })).toThrow(TypeError);
    s.scoped("c", () => ({}));
    expect(() => s.scoped("c", () => ({}))).toThrow(/already registered/);
  });
});

describe("createAttemptState - beginAttempt()", () => {
  it("a restart attempt re-initialises a plain object IN PLACE (same identity, stale keys removed)", () => {
    const s = createAttemptState();
    const b = s.scoped("budget", () => ({ used: 0 }));
    b.used = 5;
    b.stale = true;
    s.beginAttempt(restart(1));
    expect(b).toEqual({ used: 0 });
    expect("stale" in b).toBe(false);
  });

  it("a restart attempt calls reset() when the registered value has one, keeping identity", () => {
    const s = createAttemptState();
    const ledger = { entries: [1, 2], reset: vi.fn(function () { this.entries.length = 0; }) };
    const got = s.scoped("ledger", () => ledger);
    s.beginAttempt(restart(1));
    expect(got).toBe(ledger);
    expect(ledger.reset).toHaveBeenCalledTimes(1);
    expect(ledger.entries).toEqual([]);
  });

  it("a resumed attempt carries an item registered with onResume 'carry' (the default)", () => {
    const s = createAttemptState();
    const b = s.scoped("budget", () => ({ used: 0 }));
    b.used = 3;
    s.beginAttempt(resume(1));
    expect(b.used).toBe(3);
  });

  it("a resumed attempt re-initialises an item registered with onResume 'reset'", () => {
    const s = createAttemptState();
    const b = s.scoped("budget", () => ({ used: 0 }), { onResume: "reset" });
    b.used = 3;
    s.beginAttempt(resume(1));
    expect(b.used).toBe(0);
  });

  it("never touches items registered on a different attempt state (no shared registry)", () => {
    const a = createAttemptState();
    const b = createAttemptState();
    a.scoped("budget", () => ({ used: 0 }));
    const other = b.scoped("budget", () => ({ used: 0 }));
    other.used = 4;
    a.beginAttempt(restart(1));
    a.beginAttempt(restart(2, "escalation"));
    expect(other.used).toBe(4);
    expect(a.snapshot().items).toEqual(["budget"]);
    expect(b.snapshot().attempt).toBeNull();
  });

  it("snapshot().attempt is null before any attempt, then a copy of the latest ctx", () => {
    const s = createAttemptState();
    expect(s.snapshot().attempt).toBeNull();
    const ctx = restart(1);
    s.beginAttempt(ctx);
    ctx.index = 99;
    expect(s.snapshot().attempt).toEqual({ index: 1, kind: "same_model_retry", model: "m", resumed: false });
  });
});
