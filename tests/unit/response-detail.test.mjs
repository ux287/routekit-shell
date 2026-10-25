// backlog.feat.mcp-tool-response-summary-default
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildToolResponse, spillDir, MAX_SPILL_FILES_PER_TOOL } from "../../packages/mcp-rks/src/server/response-detail.mjs";
import { summarizeGuardrailsOnResponse, guardrailsOnMustInline } from "../../packages/mcp-rks/src/server/guardrails-audit.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
const parse = (env) => JSON.parse(env.content[0].text);
const big = (extra = {}) => ({ ok: true, shipOutcome: "shipped", blob: "x".repeat(5000), ...extra });

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "response-detail-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe("buildToolResponse", () => {
  it("detail full returns the payload unchanged and writes nothing", () => {
    const payload = big();
    expect(parse(buildToolResponse({ projectRoot: root, tool: "t", payload, detail: "full" }))).toEqual(payload);
    expect(fs.existsSync(spillDir(root, "t"))).toBe(false);
  });
  it("small payload is inline and writes nothing", () => {
    const payload = { ok: true, a: 1 };
    expect(parse(buildToolResponse({ projectRoot: root, tool: "t", payload }))).toEqual(payload);
    expect(fs.existsSync(spillDir(root, "t"))).toBe(false);
  });
  it("large payload spills and returns a summary with fullPayloadPath", () => {
    const payload = big();
    const out = parse(buildToolResponse({ projectRoot: root, tool: "t", payload, summarize: ({ blob, ...rest }) => rest }));
    expect(out.detail).toBe("summary");
    expect(out.omittedKeys).toContain("blob");
    expect(typeof out.fullPayloadBytes).toBe("number");
    expect(out.fullPayloadPath.startsWith(spillDir(root, "t") + path.sep)).toBe(true);
    expect(JSON.parse(fs.readFileSync(out.fullPayloadPath, "utf8"))).toEqual(payload);
  });
  it("mustInline true returns the full payload inline", () => {
    const payload = big();
    const out = parse(buildToolResponse({ projectRoot: root, tool: "t", payload, mustInline: () => true }));
    expect(out).toEqual(payload);
    expect(out).not.toHaveProperty("fullPayloadPath");
  });
  it("failed write falls back inline with detailFallback write_failed", () => {
    const file = path.join(root, "not-a-dir");
    fs.writeFileSync(file, "x");
    const out = parse(buildToolResponse({ projectRoot: file, tool: "t", payload: big() }));
    expect(out.detailFallback).toBe("write_failed");
    expect(out).not.toHaveProperty("fullPayloadPath");
  });
  it("prune failure after a successful write still returns the summary with fullPayloadPath", () => {
    vi.spyOn(fs, "readdirSync").mockImplementation(() => { throw new Error("prune boom"); });
    const payload = big();
    const out = parse(buildToolResponse({ projectRoot: root, tool: "t", payload }));
    vi.restoreAllMocks();
    expect(out.detail).toBe("summary");
    expect(out).not.toHaveProperty("detailFallback");
    expect(out.pruneError).toContain("prune boom");
    expect(JSON.parse(fs.readFileSync(out.fullPayloadPath, "utf8"))).toEqual(payload);
  });
  it("prunes each tool spill directory to MAX_SPILL_FILES_PER_TOOL", () => {
    for (let i = 0; i < 55; i++) buildToolResponse({ projectRoot: root, tool: "t", payload: big({ i }) });
    expect(MAX_SPILL_FILES_PER_TOOL).toBe(50);
    expect(fs.readdirSync(spillDir(root, "t")).filter((f) => f.endsWith(".json"))).toHaveLength(50);
  });
});

describe("rks_guardrails_on summary contract", () => {
  const full = {
    ok: true, shipOutcome: "shipped", failedShipSteps: [], autoShipped: true, message: "m", commitId: "abc", sessionId: "s",
    changedFiles: ["a", "b", "c"], newFiles: ["d"],
    hookDeploy: { ok: true, count: 3, files: ["h"] }, fullSuiteGate: { ok: true, ran: true, failures: [] },
    artifactAdmissions: [{ p: 1 }, { p: 2 }],
    shipSteps: [
      { step: "commit", ok: true, commitId: "abc" },
      { step: "review", ok: true, verdict: "pass", findingCount: 1, findings: [{}], acCoverage: { notCovered: ["x", "y"] }, diffTruncation: { unseenFiles: ["z"] } },
    ],
  };
  it("replaces arrays with counts and reduces nested objects to scalars", () => {
    const s = summarizeGuardrailsOnResponse(full);
    expect(s).not.toHaveProperty("changedFiles");
    expect(s).not.toHaveProperty("newFiles");
    expect(s.changedFileCount).toBe(3);
    expect(s.newFileCount).toBe(1);
    expect(s.artifactAdmissionCount).toBe(2);
    expect(s.hookDeploy).toEqual({ ok: true, count: 3 });
    expect(s.fullSuiteGate).toEqual({ ok: true, ran: true });
    expect(s.shipSteps.map((x) => x.step)).toEqual(["commit", "review"]);
    for (const step of s.shipSteps) for (const v of Object.values(step)) expect(v === null || typeof v !== "object").toBe(true);
    expect(s.shipSteps[1].acNotCoveredCount).toBe(2);
    expect(s.shipSteps[1].unseenFileCount).toBe(1);
    for (const k of ["ok", "shipOutcome", "failedShipSteps", "autoShipped", "message", "commitId", "sessionId"]) expect(s[k]).toEqual(full[k]);
  });
  it("mustInline covers failures, halts, shipped_with_failures and coAuthorRejected", () => {
    expect(guardrailsOnMustInline({ ok: false })).toBe(true);
    for (const o of ["failed", "halted", "shipped_with_failures"]) expect(guardrailsOnMustInline({ ok: true, shipOutcome: o })).toBe(true);
    expect(guardrailsOnMustInline({ ok: true, shipOutcome: "shipped", coAuthorRejected: true })).toBe(true);
    for (const o of ["shipped", "nothing_to_ship", "skipped"]) expect(guardrailsOnMustInline({ ok: true, shipOutcome: o })).toBe(false);
  });
});

describe("wiring", () => {
  it("server.mjs declares detail in the zod and JSON schemas", () => {
    const src = read("packages/mcp-rks/src/server.mjs");
    expect(src).toMatch(/detail: z\.enum\(\["summary", "full"\]\)\.optional\(\)/);
    expect(src).toMatch(/detail: \{ type: "string", enum: \["summary", "full"\]/);
  });
  it("governance.mjs routes rks_guardrails_on through buildToolResponse with input.detail", () => {
    const src = read("packages/mcp-rks/src/server/handlers/governance.mjs");
    const hits = src.match(/buildToolResponse\(\{[^}]*tool: "rks_guardrails_on"/g) || [];
    expect(hits.length).toBe(2);
    expect(src).toMatch(/detail: input\.detail/);
  });
});
