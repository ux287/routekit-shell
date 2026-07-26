import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  applyFidelity,
  getEffectiveFidelity,
  filterByFidelity,
  FIDELITY_LEVELS,
} from "../../packages/mcp-rks/src/rag/fidelity-filter.mjs";
import { resolveFidelityCeiling } from "../../packages/mcp-rks/src/rag/tools.mjs";

/**
 * backlog.feat.rag-fidelity-ownership-scoped
 *
 * Ownership-scoped RAG fidelity. A project that OWNS its corpus (.rks/project.json →
 * rag.fidelityCeiling: "full") is authorized to L3 full-text retrieval — the keyless user gets a
 * real "simulated Research Governor" experience instead of L2 previews. The redaction ceiling is
 * PRESERVED (future RKS-Pro / multi-tenant), the config FAILS CLOSED, a low Governor role token is
 * never elevated by ownership, and literal secret values stay scrubbed even at L3.
 */

describe("resolveFidelityCeiling — ownership flag, fail-closed", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rks-fidelity-"));
    mkdirSync(join(root, ".rks"), { recursive: true });
  });
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });
  const writeProject = (obj) => writeFileSync(join(root, ".rks", "project.json"), JSON.stringify(obj));

  it("returns 'full' when rag.fidelityCeiling is 'full' (owned corpus)", () => {
    writeProject({ id: "p", rag: { fidelityCeiling: "full" } });
    expect(resolveFidelityCeiling(root)).toBe("full");
  });

  it("FAILS CLOSED to 'redacted' when the flag is absent", () => {
    writeProject({ id: "p", rag: { enabled: true } });
    expect(resolveFidelityCeiling(root)).toBe("redacted");
  });

  it("FAILS CLOSED to 'redacted' for an explicit 'redacted' value (Pro posture)", () => {
    writeProject({ id: "p", rag: { fidelityCeiling: "redacted" } });
    expect(resolveFidelityCeiling(root)).toBe("redacted");
  });

  it("FAILS CLOSED to 'redacted' for a malformed/unknown value", () => {
    writeProject({ id: "p", rag: { fidelityCeiling: "MAYBE" } });
    expect(resolveFidelityCeiling(root)).toBe("redacted");
  });

  it("FAILS CLOSED to 'redacted' when project.json is missing or unparseable", () => {
    expect(resolveFidelityCeiling(join(root, "does-not-exist"))).toBe("redacted");
    writeFileSync(join(root, ".rks", "project.json"), "{ not valid json ");
    expect(resolveFidelityCeiling(root)).toBe("redacted");
  });
});

describe("applyFidelity L3 — full content, but literal secrets scrubbed", () => {
  it("returns full text at L3 (not null, not a preview)", () => {
    const r = applyFidelity(
      { id: "1", path: "a.md", score: 1, source_class: "project", text: "hello world this is the full body" },
      FIDELITY_LEVELS.L3_FULL,
    );
    expect(r.fidelity).toBe("L3");
    expect(r.text).toBe("hello world this is the full body");
    expect(r.preview).toBeUndefined();
  });

  it("scrubs literal secret VALUES from full L3 text while preserving surrounding content", () => {
    const text =
      "config start\ntoken=SUPERSECRET123\npassword: hunter2\nsecret=xyz789\ncredential=zzz000\nend of body";
    const r = applyFidelity({ id: "1", path: "a.md", score: 1, source_class: "project", text }, FIDELITY_LEVELS.L3_FULL);
    expect(r.fidelity).toBe("L3");
    // full surrounding content survives
    expect(r.text).toContain("config start");
    expect(r.text).toContain("end of body");
    // literal secret values are gone
    expect(r.text).not.toContain("SUPERSECRET123");
    expect(r.text).not.toContain("hunter2");
    expect(r.text).not.toContain("xyz789");
    expect(r.text).not.toContain("zzz000");
    expect(r.text).toContain("[REDACTED]");
  });
});

describe("filterByFidelity — owned-corpus overrides lift the project ceiling to L3", () => {
  const rows = [
    { id: "1", path: "note.md", score: 1, source_class: "project", text: "full project body with token=SECRETVAL here" },
  ];

  it("WITHOUT overrides: project-class still caps at L2 (Pro/redacted default preserved)", () => {
    const [r] = filterByFidelity(rows, FIDELITY_LEVELS.L3_FULL); // request L3, but default ceiling caps
    expect(r.fidelity).toBe("L2");
    expect(r.text).toBeNull();
    expect(r.preview).not.toContain("SECRETVAL");
  });

  it("WITH owned-corpus overrides: project-class returns L3 full text (secret scrubbed)", () => {
    const [r] = filterByFidelity(rows, FIDELITY_LEVELS.L3_FULL, { overrides: { project: FIDELITY_LEVELS.L3_FULL } });
    expect(r.fidelity).toBe("L3");
    expect(r.text).toContain("full project body");
    expect(r.text).not.toContain("SECRETVAL");
    expect(r.text).toContain("[REDACTED]");
  });

  it("ROLE CAP WINS: a low requested fidelity is NOT elevated by ownership overrides", () => {
    // Simulates a low Governor role token (requested L0), even over an owned corpus.
    const [r] = filterByFidelity(rows, FIDELITY_LEVELS.L0_METADATA, { overrides: { project: FIDELITY_LEVELS.L3_FULL } });
    expect(r.fidelity).toBe("L0");
    expect(r.text).toBeNull();
  });
});

describe("getEffectiveFidelity — ownership override never exceeds the requested cap", () => {
  it("Math.min(requested, override): the lower request always wins", () => {
    expect(
      getEffectiveFidelity("project", FIDELITY_LEVELS.L0_METADATA, { project: FIDELITY_LEVELS.L3_FULL }),
    ).toBe(FIDELITY_LEVELS.L0_METADATA);
    expect(
      getEffectiveFidelity("project", FIDELITY_LEVELS.L3_FULL, { project: FIDELITY_LEVELS.L3_FULL }),
    ).toBe(FIDELITY_LEVELS.L3_FULL);
  });
});
