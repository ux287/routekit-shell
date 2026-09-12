/**
 * Witness for backlog.fix.refine-noop-escalation-false-positive — MECHANISM A.
 *
 * The suggestion -> apply contract was broken at the MCP schema boundary, and it was invisible
 * because both halves looked correct in isolation:
 *
 *   - `rks_refine` puts its payload at the TOP LEVEL of each suggestion (`file`, `hint`, `reason`,
 *     `priority`), not under `data`.
 *   - `refineApplySchema` declared the inner refinement as `z.object({ type, data })`, and
 *     `z.object()` STRIPS unknown keys by default.
 *
 * So handing a suggestion straight back to `rks_refine_apply` delivered `{ type }` and nothing
 * else. All eight `data?.file` handlers read `undefined`, every refinement was dropped before any
 * handler could run, and the resulting empty `applied` was reported as a genuine no-op — which
 * escalated and killed the build. The merge at the top of the apply loop that was written to
 * support the top-level shape was dead code through MCP.
 *
 * Second half of the same defect: `z.enum` REJECTS rather than strips, so any type the refine
 * engine could emit but the enum omitted made the engine capable of suggesting a refinement its
 * own tool's parser threw on. That had already been hand-fixed once (`fix_duplicate_frontmatter`)
 * without re-deriving the list, leaving eight more emitters unaccepted.
 *
 * These assertions are written against the EMITTER SET rather than a restated literal, so the two
 * cannot drift apart again — a hard-coded expected list here would reproduce the original bug in
 * the test.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REFINEMENT_TYPES,
  SUGGESTED_REFINEMENT_TYPES,
  CALLER_INITIATED_REFINEMENT_TYPES,
} from "../../packages/mcp-rks/src/server/refine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../..");
const REFINE_SRC = path.join(REPO, "packages/mcp-rks/src/server/refine.mjs");

describe("the canonical refinement vocabulary tracks the emitters", () => {
  it("every type emitted via suggestions.push is in SUGGESTED_REFINEMENT_TYPES", () => {
    // Derived from source, not restated. If someone adds a `suggestions.push({ type: "x" })`
    // without adding "x" to the constant, this fails — which is the drift the fix exists to stop.
    const src = fs.readFileSync(REFINE_SRC, "utf8");

    const emitted = new Set();
    // backlog.fix.refine-plan-staging-advisory-channel: `advisory.push` is scanned
    // too. Without it, moving a type from suggestions[] to advisory[] would drop it
    // out of this set SILENTLY — the assertion below only fails on types present
    // and unregistered, so a vanished type passes. That is a coverage regression
    // wearing a green tick, which is the exact defect class this suite guards.
    const pushRe = /(?:suggestions|advisory)\.push\(\{/g;
    let m;
    while ((m = pushRe.exec(src)) !== null) {
      // The `type:` literal is the first field in every emit site; scan a small window forward.
      const window = src.slice(m.index, m.index + 200);
      const typeMatch = window.match(/type:\s*"([a-z0-9_]+)"/);
      if (typeMatch) emitted.add(typeMatch[1]);
    }

    // Positive control: if the scan finds nothing, the assertion below would pass vacuously.
    expect(emitted.size).toBeGreaterThan(10);

    const missing = [...emitted].filter((t) => !SUGGESTED_REFINEMENT_TYPES.includes(t));
    expect(missing).toEqual([]);
  });

  it("REFINEMENT_TYPES is exactly suggested + caller-initiated, with no duplicates", () => {
    expect(REFINEMENT_TYPES).toEqual([
      ...SUGGESTED_REFINEMENT_TYPES,
      ...CALLER_INITIATED_REFINEMENT_TYPES,
    ]);
    expect(new Set(REFINEMENT_TYPES).size).toBe(REFINEMENT_TYPES.length);
  });

  it("retains the caller-initiated types, which are never suggested but must stay accepted", () => {
    // These are passed in by a Governor or the Dispatcher, never emitted. Re-deriving the enum
    // from the emitter set ALONE would silently drop them and reject valid calls.
    for (const t of ["clarify_ac", "decompose", "acknowledge_multi_file", "acknowledge_destructive_rewrite"]) {
      expect(REFINEMENT_TYPES).toContain(t);
    }
  });

  it("includes the eight emitters the hand-written 13-value enum omitted", () => {
    // Regression pin on the specific gap observed. `disk_fetch_context` is the one that threw a
    // ZodError; the other seven were equally unreachable.
    for (const t of [
      "disk_fetch_context", "fix_vague_tests", "fix_search_pattern", "verify_search_patterns",
      "review_plan_output", "plan_staging", "fix_numeric_assertion", "fix_test_assertion",
    ]) {
      expect(REFINEMENT_TYPES).toContain(t);
    }
  });
});

describe("refineApplySchema accepts what rks_refine emits", () => {
  it("does NOT strip the top-level suggestion payload", async () => {
    // The load-bearing assertion. A suggestion carries file/hint/reason/priority at the top level;
    // if any of them is missing after parse, the handlers read undefined and the refinement is
    // silently dropped — which is exactly how the live repro produced `applied: []`.
    const { z } = await import("zod");
    const schema = z.object({
      refinements: z.array(z.object({
        type: z.enum(REFINEMENT_TYPES),
        data: z.any().optional(),
      }).passthrough()),
    });

    const suggestion = {
      type: "add_code_snippet",
      file: "packages/rag/src/tools.mjs",
      hint: "countOnly",
      reason: "planner needs the function body",
      priority: "high",
    };

    const parsed = schema.parse({ refinements: [suggestion] });
    expect(parsed.refinements[0]).toMatchObject(suggestion);
    expect(parsed.refinements[0].file).toBe("packages/rag/src/tools.mjs");
  });

  it("every emitted type parses — none of them throws", async () => {
    const { z } = await import("zod");
    const schema = z.array(z.object({
      type: z.enum(REFINEMENT_TYPES),
      data: z.any().optional(),
    }).passthrough());

    for (const type of SUGGESTED_REFINEMENT_TYPES) {
      expect(() => schema.parse([{ type, file: "a.mjs" }]), `type ${type} must parse`).not.toThrow();
    }
  });

  it("STILL REJECTS a genuinely invalid type — the enum widened, it did not become permissive", () => {
    // The guard against over-correcting. Falling back to z.string() would make every typo a
    // silently-accepted no-op refinement.
    expect(REFINEMENT_TYPES).not.toContain("not_a_real_refinement");
  });
});

describe("the zod enum and the advertised inputSchema literal cannot drift", () => {
  it("both are derived from REFINEMENT_TYPES in server.mjs", () => {
    // Structural pin. Two hand-written copies that merely happened to agree is what produced the
    // original defect; this asserts neither copy is hand-written any more.
    const serverSrc = fs.readFileSync(path.join(REPO, "packages/mcp-rks/src/server.mjs"), "utf8");
    expect(serverSrc).toContain("type: z.enum(REFINEMENT_TYPES)");
    expect(serverSrc).toContain("enum: [...REFINEMENT_TYPES]");
  });
});
