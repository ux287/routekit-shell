/**
 * backlog.feat.telemetry-dashboard-chain-violations-panel — guardrail-events drill-down.
 *
 * Behavioral witnesses on the REAL exported projectGuardrailEvents (the
 * /api/telemetry/guardrail-events projection) + aggregateTrustCounters preservation, plus
 * source-introspection for the api/component/App wiring (modeled on dashboard-token-costs.test.mjs).
 * Every test carries concrete assertions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  projectGuardrailEvents,
  aggregateTrustCounters,
} from "../../packages/telemetry-dashboard/vite-plugin-telemetry-api.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASH = resolve(__dirname, "../../packages/telemetry-dashboard");
const read = (p) => readFileSync(resolve(DASH, p), "utf8");

const CHAIN = {
  id: "c1",
  type: "chain.violation",
  timestamp: "2026-07-05T10:00:00Z",
  projectId: "p",
  payload: {
    blockedTool: "rks_exec",
    flowType: "open",
    state: "researching",
    violationKind: "flow_allowlist",
    expectedTools: ["rks_agent_research"],
  },
};
const BUMP = {
  id: "b1",
  type: "hook.guardrail_bump",
  timestamp: "2026-07-05T11:00:00Z",
  projectId: "p",
  payload: { hookName: "redirect-bash-to-governor", blockedTool: "Bash", redirectAgent: "rks_agent_git", reason: "git blocked" },
};
const OTHER = { id: "o1", type: "plan.complete", timestamp: "2026-07-05T09:00:00Z", payload: { x: 1 } };

describe("projectGuardrailEvents — read-only drill-down projection", () => {
  it("keeps ONLY chain.violation + hook.guardrail_bump, drops other event types", () => {
    const out = projectGuardrailEvents([CHAIN, OTHER, BUMP]);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.type).sort()).toEqual(["chain.violation", "hook.guardrail_bump"]);
    expect(out.find((e) => e.type === "plan.complete")).toBeUndefined();
  });

  it("preserves the chain.violation payload execution-path context intact", () => {
    const [first] = projectGuardrailEvents([CHAIN]);
    expect(first.payload.blockedTool).toBe("rks_exec");
    expect(first.payload.flowType).toBe("open");
    expect(first.payload.state).toBe("researching");
    expect(first.payload.violationKind).toBe("flow_allowlist");
    expect(first.payload.expectedTools).toEqual(["rks_agent_research"]);
  });

  it("preserves guardrail-bump payload fields (hookName/blockedTool/redirectAgent/reason)", () => {
    const [b] = projectGuardrailEvents([BUMP]);
    expect(b.payload.hookName).toBe("redirect-bash-to-governor");
    expect(b.payload.blockedTool).toBe("Bash");
    expect(b.payload.redirectAgent).toBe("rks_agent_git");
    expect(b.payload.reason).toBe("git blocked");
  });

  it("returns most-recent-first by timestamp", () => {
    const out = projectGuardrailEvents([CHAIN, BUMP]); // BUMP 11:00 is newer than CHAIN 10:00
    expect(out[0].id).toBe("b1");
    expect(out[1].id).toBe("c1");
  });

  it("respects the limit, keeping the most-recent slice", () => {
    const out = projectGuardrailEvents([CHAIN, BUMP], 1);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("b1");
  });

  it("supports the legacy {event} type key as well as {type}", () => {
    const out = projectGuardrailEvents([{ event: "chain.violation", payload: {} }]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("chain.violation");
  });

  it("empty / undefined input is safe and returns []", () => {
    expect(projectGuardrailEvents([])).toEqual([]);
    expect(projectGuardrailEvents(undefined)).toEqual([]);
  });

  it("defaults a missing payload to {} (never throws on sparse events)", () => {
    const [e] = projectGuardrailEvents([{ type: "chain.violation" }]);
    expect(e.payload).toEqual({});
  });
});

describe("aggregateTrustCounters — behavior preserved (regression witness)", () => {
  it("still counts chain.violation into chainViolations and hook.guardrail_bump into guardrailBumps", () => {
    const c = aggregateTrustCounters([CHAIN, BUMP, BUMP, OTHER]);
    expect(c.chainViolations).toBe(1);
    expect(c.guardrailBumps).toBe(2);
    expect(typeof c.trustScore).toBe("number");
  });
});

describe("wiring — source introspection (endpoint + api + component + App)", () => {
  it("the vite plugin registers the read-only /api/telemetry/guardrail-events endpoint", () => {
    const src = read("vite-plugin-telemetry-api.ts");
    expect(src).toContain("/api/telemetry/guardrail-events");
    expect(src).toContain("projectGuardrailEvents");
  });

  it("api.ts fetchGuardrailEvents hits the guardrail-events segment with throw-on-not-ok", () => {
    const src = read("src/lib/api.ts");
    expect(src).toContain("fetchGuardrailEvents");
    expect(src).toContain("/guardrail-events");
    expect(src).toMatch(/if\s*\(!res\.ok\)\s*throw/);
  });

  it("GuardrailBumps renders counts, an empty state, and reads drill-down payload context", () => {
    const src = read("src/components/health/GuardrailBumps.tsx");
    expect(src).toContain("chain-violations-count");
    expect(src).toContain("guardrail-bumps-count");
    expect(src).toContain("guardrail-bumps-empty");
    expect(src).toContain("e.payload");
    expect(src).toContain("blockedTool");
  });

  it("TelemetryPage.tsx composes GuardrailBumps and preserves the StoryActivityTable → TokenCostSection ordering", () => {
    // Sections extracted from App.tsx into TelemetryPage.tsx (routekit-dashboard-nav-shell).
    const src = read("src/pages/TelemetryPage.tsx");
    expect(src).toContain("<GuardrailBumps />");
    expect(src.indexOf("TokenCostSection")).toBeGreaterThan(src.indexOf("StoryActivityTable"));
  });
});
