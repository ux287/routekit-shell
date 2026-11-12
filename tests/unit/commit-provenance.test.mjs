// backlog.feat.commit-provenance-trailer AC1, AC2, AC6 (pure builder; no subprocesses)
import { describe, it, expect } from "vitest";
import { PROVENANCE_KEY, buildProvenanceTrailer, sessionRefFromToken } from "../../packages/mcp-rks/src/shared/commit-provenance.mjs";

const BASE = { sessionRef: "abc123def456", tool: "dendron_update_field", client: "claude-code", via: "mcp", actor: "qa", runId: "run-1" };
const FIELDS = ["sessionRef", "tool", "client", "via", "actor", "runId"];

describe("buildProvenanceTrailer", () => {
  it("returns exactly one line beginning Rks-Provenance: v1 with session, tool, client, via, actor and run fields", () => {
    const line = buildProvenanceTrailer(BASE);
    expect(line).not.toMatch(/[\r\n]/);
    expect(line.startsWith(`${PROVENANCE_KEY}: v1 `)).toBe(true);
    expect(line).toBe("Rks-Provenance: v1 session=abc123def456 tool=dendron_update_field client=claude-code via=mcp actor=qa run=run-1");
  });

  it("renders run=none, session=none and client=unknown-client when those inputs are absent", () => {
    const line = buildProvenanceTrailer({ ...BASE, runId: null, sessionRef: null, client: undefined });
    expect(line).toContain(" run=none");
    expect(line).toContain(" session=none ");
    expect(line).toContain(" client=unknown-client ");
  });

  for (const field of FIELDS) {
    it(`throws when ${field} contains CR or LF`, () => {
      expect(() => buildProvenanceTrailer({ ...BASE, [field]: "a\rb" })).toThrow();
      expect(() => buildProvenanceTrailer({ ...BASE, [field]: "a\nb" })).toThrow();
    });
  }

  it("replaces other whitespace inside a value with _ so every field is one space-free token", () => {
    const line = buildProvenanceTrailer({ ...BASE, client: "Claude Desktop", actor: "a\tb" });
    expect(line).toContain(" client=Claude_Desktop ");
    expect(line).toContain(" actor=a_b ");
    const values = line.slice(`${PROVENANCE_KEY}: v1 `.length).split(" ");
    expect(values).toHaveLength(6);
  });
});

describe("sessionRefFromToken", () => {
  it("is stable for one token, differs between tokens, and never contains the token", () => {
    const t1 = "f2b5d22d-d804-41b8-b2e5-618d2ceacd9a";
    const t2 = "0f6c1a2b-0000-4000-8000-123456789abc";
    expect(sessionRefFromToken(t1)).toBe(sessionRefFromToken(t1));
    expect(sessionRefFromToken(t1)).not.toBe(sessionRefFromToken(t2));
    expect(sessionRefFromToken(t1)).not.toContain(t1);
  });
});
