import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  applyFidelity,
  getEffectiveFidelity,
  FIDELITY_LEVELS,
} from "@routekit/rag/fidelity-filter";
import { resolveFidelityCeiling } from "@routekit/rag/tools";

/**
 * backlog.feat.rag-boundary-deep-scrub-property-tests
 *
 * First property-based suite in the repo (fast-check). Freezes the RAG fidelity-matcher invariants
 * as universal properties — the safety net that must hold before the physical `packages/rag/` split.
 */

const SOURCE_CLASSES = ["project", "public", "client", "sensitive", "legal", "unknown-class"];
const SECRET_KEYWORDS = ["password", "secret", "key", "token", "credential", "api_key", "access_token"];

describe("fidelity matcher — universal properties", () => {
  it("effective fidelity is NEVER greater than requested (Math.min contract)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SOURCE_CLASSES),
        fc.integer({ min: 0, max: 3 }),
        fc.dictionary(fc.constantFrom("project", "public", "client"), fc.integer({ min: 0, max: 3 })),
        (sc, requested, overrides) => getEffectiveFidelity(sc, requested, overrides) <= requested,
      ),
    );
  });

  it("an override NEVER elevates above requested AND never exceeds the override (role-cap wins)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("project", "public", "client"),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 3 }),
        (sc, requested, ov) => {
          const eff = getEffectiveFidelity(sc, requested, { [sc]: ov });
          return eff <= requested && eff <= ov;
        },
      ),
    );
  });

  it("L0 never returns text or preview, for ANY input", () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.string(),
          path: fc.string(),
          score: fc.double({ min: 0, max: 1, noNaN: true }),
          source_class: fc.constantFrom(...SOURCE_CLASSES),
          text: fc.string(),
        }),
        (result) => {
          const out = applyFidelity(result, FIDELITY_LEVELS.L0_METADATA);
          return out.text === null && out.preview === null && out.fidelity === "L0";
        },
      ),
    );
  });

  it("a planted secret VALUE never appears in ANY returned field, at ANY tier", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3 }),
        fc.constantFrom(...SOURCE_CLASSES),
        fc.constantFrom(...SECRET_KEYWORDS),
        fc.hexaString({ minLength: 8, maxLength: 24 }), // non-whitespace value → matched by REDACTION_PATTERN's \S+
        (fidelity, sc, keyword, value) => {
          const secret = `${keyword}=${value}`;
          const result = {
            id: "chunk-1",
            path: "notes/some-note.md",
            score: 0.5,
            source_class: sc,
            text: `intro text ${secret} trailing text`,
            title: `heading ${secret}`,
            tags: [`tag ${secret}`, "clean-tag"],
            meta: { nested: `deep ${secret}` },
          };
          const out = applyFidelity(result, fidelity);
          // The literal secret value must not survive anywhere in the serialized output.
          return !JSON.stringify(out).includes(value);
        },
      ),
    );
  });

  it("FALSE-POSITIVE GUARD: non-credential compounds and prose are NOT redacted", () => {
    // `monkey=banana` (contains 'key' but not a \b-bounded keyword) and prose "the key to success"
    // (no `[:=]value`) must pass through unredacted at L3.
    const result = {
      id: "1",
      path: "notes/n.md",
      score: 1,
      source_class: "project",
      text: "monkey=banana and the key to success is persistence",
    };
    const out = applyFidelity(result, FIDELITY_LEVELS.L3_FULL);
    expect(out.text).toContain("monkey=banana");
    expect(out.text).toContain("the key to success");
    expect(out.text).not.toContain("[REDACTED]");
  });
});

describe("resolveFidelityCeiling — fail-closed property", () => {
  let root;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rks-ceiling-prop-"));
    mkdirSync(join(root, ".rks"), { recursive: true });
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("returns 'redacted' for ANY value that is not exactly 'full' (fails closed)", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s !== "full"),
        (val) => {
          writeFileSync(join(root, ".rks", "project.json"), JSON.stringify({ id: "p", rag: { fidelityCeiling: val } }));
          return resolveFidelityCeiling(root) === "redacted";
        },
      ),
    );
  });

  it("returns 'full' for exactly 'full'", () => {
    writeFileSync(join(root, ".rks", "project.json"), JSON.stringify({ id: "p", rag: { fidelityCeiling: "full" } }));
    expect(resolveFidelityCeiling(root)).toBe("full");
  });
});
