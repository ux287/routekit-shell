import { describe, it, expect } from "vitest";
import {
  VALID_TRANSITIONS,
  canTransition,
  getValidNextPhases,
} from "../../packages/mcp-rks/src/workflow/state-machine.mjs";

describe("state-machine — VALID_TRANSITIONS", () => {
  it("arch-approved reaches at least planned and ready (additive-tolerant; R1.1 also adds executing)", () => {
    // R1.1 (backlog.feat.phase-machine-add-executing-phase) added arch-approved→executing.
    // R1.2 may add more. Use toContain so the test tolerates future additive edges.
    expect(VALID_TRANSITIONS["arch-approved"]).toContain("planned");
    expect(VALID_TRANSITIONS["arch-approved"]).toContain("ready");
  });

  it("preserves existing transitions (regression)", () => {
    expect(VALID_TRANSITIONS.draft).toEqual(["ready"]);
    expect(VALID_TRANSITIONS.ready).toContain("planned");
    expect(VALID_TRANSITIONS.ready).toContain("draft");
    expect(VALID_TRANSITIONS.planned).toContain("executed");
    expect(VALID_TRANSITIONS.executed).toContain("integrated");
  });
});

describe("state-machine — canTransition", () => {
  it("canTransition('arch-approved', 'planned') returns true", () => {
    expect(canTransition("arch-approved", "planned")).toBe(true);
  });

  it("canTransition('arch-approved', 'ready') returns true", () => {
    expect(canTransition("arch-approved", "ready")).toBe(true);
  });

  it("canTransition('arch-approved', 'draft') returns false", () => {
    expect(canTransition("arch-approved", "draft")).toBe(false);
  });

  it("canTransition('arch-approved', 'implemented') returns false", () => {
    expect(canTransition("arch-approved", "implemented")).toBe(false);
  });
});

describe("state-machine — getValidNextPhases", () => {
  it("getValidNextPhases('arch-approved') includes planned and ready (additive-tolerant; R1.1 also adds executing)", () => {
    // See VALID_TRANSITIONS describe above for the R1.1 additive context.
    const next = getValidNextPhases("arch-approved");
    expect(next).toContain("planned");
    expect(next).toContain("ready");
  });

  it("getValidNextPhases('ready') still includes planned (regression)", () => {
    expect(getValidNextPhases("ready")).toContain("planned");
  });
});
