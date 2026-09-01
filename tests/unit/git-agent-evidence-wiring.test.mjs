/**
 * backlog.feat.git-agent-evidence-bound-output-contract — the wiring.
 *
 * git-evidence.test.mjs proves the pure functions. This proves they are actually CONNECTED:
 * that createGitAgent hands the same ledger to both the instrumented tools and the outputSchema
 * transform, and that instrumenting did not disturb the tool metadata two live suites depend on.
 *
 * The end-to-end assertion here is the one that catches the tools array being closed as `])`
 * instead of `], ledger)`. That mistake compiles, leaves ledger undefined, and throws a TypeError
 * on the FIRST tool call of every git invocation — at runtime, not at parse.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGitAgent, GitOutputSchema } from "../../packages/mcp-rks/src/agents/git.mjs";
import { instrumentToolsWithLedger, createEvidenceLedger } from "../../packages/mcp-rks/src/agents/git-evidence.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GIT_SRC = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/agents/git.mjs"), "utf8");

const agent = () => createGitAgent({ projectRoot: process.cwd() });

describe("the ledger is genuinely wired into the agent", () => {
  it("END TO END — a real tool call lands in the evidence the transform seals", async () => {
    const a = agent();
    const list = a.tools.find((t) => t.name === "git_stash");
    expect(list, "git_stash is not registered").toBeTruthy();

    await list.execute({ action: "list" });

    const out = a.outputSchema.parse({ ok: true, summary: "listed the stashes" });
    expect(out.evidence.callCount, "the call never reached the ledger the schema seals").toBe(1);
    expect(out.evidence.calls[0].tool).toBe("git_stash");
  });

  it("each createGitAgent gets its OWN ledger — no cross-invocation bleed", async () => {
    const a = agent();
    await a.tools.find((t) => t.name === "git_stash").execute({ action: "list" });
    expect(a.outputSchema.parse({ ok: true, summary: "s" }).evidence.callCount).toBe(1);

    const b = agent();
    expect(
      b.outputSchema.parse({ ok: true, summary: "s" }).evidence.callCount,
      "a fresh agent inherited a prior invocation's calls",
    ).toBe(0);
  });

  it("the module-level GitOutputSchema is NOT the bound one", () => {
    // The per-invocation schema carries the transform; the exported base does not. If these were
    // the same object, one ledger would be shared by every agent in the process.
    expect(agent().outputSchema).not.toBe(GitOutputSchema);
  });
});

describe("instrumentation is transparent to the live suites that depend on it", () => {
  // agent-stash-create-guard.test.mjs finds by name and reads inputSchema enum values;
  // git-agent-read-tools.test.mjs finds by name. A spread that dropped either reddens both tiers.
  it("every tool keeps name, description and inputSchema", () => {
    const tools = agent().tools;
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(typeof t.name, "a tool lost its name").toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema, `${t.name} lost its inputSchema`).toBeTruthy();
      expect(typeof t.execute).toBe("function");
    }
  });

  it("the wrapper preserves metadata by REFERENCE, not by copy", () => {
    // Reference identity, not deep equality — a rebuilt-but-equal schema would still break a
    // caller holding the original. Driven through a stub array because createGitAgent builds its
    // schemas per call and the uninstrumented tool is not exported.
    const schema = { shape: { action: {} } };
    const original = { name: "probe", description: "d", inputSchema: schema, execute: async () => "r" };
    const [wrapped] = instrumentToolsWithLedger([original], createEvidenceLedger());
    expect(wrapped.inputSchema).toBe(schema);
    expect(wrapped.name).toBe(original.name);
    expect(wrapped.description).toBe(original.description);
    expect(wrapped.execute, "the wrapper must replace execute, or nothing is recorded").not.toBe(original.execute);
  });

  it("the git_stash enum is still readable — the exact access agent-stash-create-guard makes", () => {
    const shape = agent().tools.find((t) => t.name === "git_stash").inputSchema.shape;
    const values = shape.action?._def?.values ?? [];
    expect(values).toEqual(expect.arrayContaining(["pop", "list", "apply", "drop"]));
    expect(values).not.toContain("save");
  });
});

describe("GIT_SYSTEM_PROMPT carries the claim instruction", () => {
  // Asserted on SOURCE, not on agent().prompt. git.mjs resolves `cfg.prompt || GIT_SYSTEM_PROMPT`,
  // and this repo ships .rks/prompts/agent-git.md — so the project prompt displaces the default
  // entirely here. That displacement is intended and fails closed (an overridden agent declares no
  // claims, so every response degrades with no_claims_declared and carries the banner), which the
  // last test in this block pins.
  //
  // Non-brittle: durable tokens only. Pinning an exact sentence or slicing a fixed source window
  // has reddened CI in this repo before.
  it.each(["findings", "evidenceIndex", "conclusions", "basis"])("names %s", (token) => {
    expect(GIT_SRC).toContain(token);
  });

  it("says plainly that absence of output is not evidence of absence", () => {
    expect(GIT_SRC).toMatch(/absence of output is\s+not evidence of absence/i);
  });

  it("records that the instruction is SECONDARY to the code-side audit", () => {
    expect(GIT_SRC).toMatch(/SECONDARY/);
  });

  it("records at the override site what a project prompt displaces", () => {
    expect(GIT_SRC).toMatch(/no_claims_declared/);
  });

  it("OVERRIDE FAILS CLOSED — an agent whose prompt is overridden still degrades loudly", () => {
    // This repo IS the override case. The contract must announce it is not being used rather
    // than silently returning unbound prose.
    const a = agent();
    const out = a.outputSchema.parse({ ok: true, summary: "unbound prose" });
    expect(out.evidenceAudit.degraded).toBe(true);
    expect(out.evidenceAudit.reasons).toContain("no_claims_declared");
    expect(out.summary.startsWith("> ⚠️")).toBe(true);
  });
});
