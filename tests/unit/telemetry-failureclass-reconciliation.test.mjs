import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  classifyMarkerFailure,
  decideToolOutcome,
  TOOL_COMPLETE,
  TOOL_FAILED,
  toolPayloadFromResponse,
} from "../../packages/mcp-rks/src/server/failure-classification.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("mcp.tool.failed counting", () => {
  it("records a non-throwing ok:false payload as failed", () => {
    // Defect-present value: TOOL_COMPLETE. _auditOk flipped false only inside
    // the catch arm, so a payload-level failure never reached it.
    expect(decideToolOutcome({ threw: false, result: { ok: false } })).toBe(TOOL_FAILED);
  });

  it("records a thrown error as failed", () => {
    expect(decideToolOutcome({ threw: true })).toBe(TOOL_FAILED);
  });

  it("records a successful call as complete", () => {
    expect(decideToolOutcome({ threw: false, result: { ok: true } })).toBe(TOOL_COMPLETE);
  });

  it("counts N failing interruptions as exactly N failed events", () => {
    const outcomes = [
      { threw: true },
      { threw: true },
      { threw: false, result: { ok: false } },
    ].map(decideToolOutcome);

    // Defect-present value: 2 failed + 1 complete — the reported 2-of-3 undercount.
    expect(outcomes.filter((o) => o === TOOL_FAILED)).toHaveLength(3);
    expect(outcomes.filter((o) => o === TOOL_COMPLETE)).toHaveLength(0);
  });
});

describe("marker failure classification", () => {
  it("gives a structural marker its own message, not the worker-crashed fallback", () => {
    const { failureClass, message } = classifyMarkerFailure({
      status: "refinement_required",
      failureClass: "structural",
      uncoveredCreateTargets: ["public/decks/repro-deck.html"],
    });

    expect(failureClass).toBe("structural");
    // Defect-present value: "The plan worker crashed before producing a plan."
    // reached through the fallback, because no structural branch existed.
    expect(message).not.toMatch(/worker crashed/i);
    expect(message).toContain("public/decks/repro-deck.html");
  });

  // Every arm of server.mjs:2626-2629, plus the stamped-class short-circuit.
  // The "if botched" column is what an inexact transplant returns instead; a
  // stub returning undefined fails all five rows.
  const ARMS = [
    // row A — if the inner reason check is dropped: "output_invalid"
    { name: "A refinement_required + create_file_complexity",
      marker: { status: "refinement_required", reason: "create_file_complexity" },
      expected: "story_unplannable" },
    // row B — if the inner ternary is inverted: "story_unplannable"
    { name: "B refinement_required + any other reason",
      marker: { status: "refinement_required", reason: "has_note_steps" },
      expected: "output_invalid" },
    // row C — if this arm is dropped it falls to the final else: "worker_crashed"
    { name: "C quality_failed",
      marker: { status: "quality_failed" },
      expected: "output_invalid" },
    // row D — if refinement_required becomes the else-branch: "output_invalid"
    { name: "D unknown status",
      marker: { status: "something_else" },
      expected: "worker_crashed" },
    // row D' — absent status must behave as row D
    { name: "D' absent status",
      marker: {},
      expected: "worker_crashed" },
    // row E — if the || short-circuit is dropped and re-derivation runs first,
    // this stamped marker would come back as "output_invalid"
    { name: "E stamped class wins over re-derivation",
      marker: { status: "refinement_required", reason: "has_note_steps", failureClass: "structural" },
      expected: "structural" },
  ];

  it.each(ARMS)("maps arm $name to its documented class", ({ marker, expected }) => {
    expect(classifyMarkerFailure(marker).failureClass).toBe(expected);
  });
});

describe("tool response envelope", () => {
  it("pulls an ok:false payload back out of the MCP text envelope", () => {
    // The `ok` flag the outcome decision needs is only reachable by re-parsing, because
    // handlers return `{ content: [{ type: "text", text: JSON.stringify(result) }] }`.
    const envelope = { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "nope" }) }] };
    expect(toolPayloadFromResponse(envelope)).toEqual({ ok: false, error: "nope" });
    expect(decideToolOutcome({ threw: false, result: toolPayloadFromResponse(envelope) })).toBe(TOOL_FAILED);
  });

  it("treats an unparseable or non-text envelope as absence of evidence, not failure", () => {
    // A null payload must NOT be read as ok:false — that would invent failures from
    // envelopes this function simply cannot see into, which is the same defect inverted.
    expect(toolPayloadFromResponse({ content: [{ type: "text", text: "not json" }] })).toBeNull();
    expect(toolPayloadFromResponse({ content: [{ type: "image" }] })).toBeNull();
    expect(toolPayloadFromResponse(undefined)).toBeNull();
    expect(decideToolOutcome({ threw: false, result: null })).toBe(TOOL_COMPLETE);
  });

  it("passes an ok:true payload through as complete", () => {
    const envelope = { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    expect(decideToolOutcome({ threw: false, result: toolPayloadFromResponse(envelope) })).toBe(TOOL_COMPLETE);
  });
});

describe("SSOT — the taxonomy is derived in exactly one place", () => {
  const read = (rel) => fs.readFileSync(path.resolve(__dirname, "../../", rel), "utf8");

  it("server.mjs no longer re-derives the class inline", () => {
    // Defect-present value: server.mjs:2626-2629 carried its own four-arm ternary, a second
    // answer to a question planner.mjs had already answered. This is the assertion that
    // fails if someone reintroduces a local derivation instead of calling the module.
    const server = read("packages/mcp-rks/src/server.mjs");
    expect(server).not.toContain('marker.status === "quality_failed"');
    expect(server).not.toContain('marker.reason === "create_file_complexity"');
    expect(server).toContain("classifyMarkerFailure(marker)");
  });

  it("server.mjs decides the audit outcome from the RETURNED payload, not only the catch", () => {
    // Defect-present value: mcp.tool.complete. `_auditOk` was initialised true and flipped
    // false ONLY inside `} catch`, so a handler returning ok:false without throwing was
    // audited as a completion — the 2-of-3 undercount. The decision is now taken from the
    // return value, via the same exported helper this file drives directly above.
    const server = read("packages/mcp-rks/src/server.mjs");
    expect(server).toContain("decideToolOutcome({ threw: false, result: toolPayloadFromResponse(_response) })");
    expect(server).toContain("_auditOk = false;");
  });

  it("neither caller assigns a taxonomy literal in code", () => {
    // Comments may still name the classes — they document the taxonomy. What must not
    // recur is an assignment, so this pins the module as the only place a class is chosen.
    const strip = (src) =>
      src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

    for (const rel of ["packages/mcp-rks/src/server.mjs", "packages/mcp-rks/src/server/planner.mjs"]) {
      const code = strip(read(rel));
      for (const literal of ['"worker_crashed"', '"story_unplannable"', '"output_invalid"']) {
        expect(code, `${rel} assigns ${literal} outside the classifier`).not.toContain(literal);
      }
    }
  });

  it("the retry-exhausted emit always carries a class, structural or not", () => {
    // Defect-present value: `...(structural ? { failureClass: ... } : {})` — so a
    // non-structural exhausted run emitted payload.failureClass === undefined.
    const planner = read("packages/mcp-rks/src/server/planner.mjs");
    expect(planner).not.toContain("...(structural ? { failureClass:");
    expect(planner).toContain("failureClass: exhaustedClass,");
    expect(planner).toContain("payload.failureClass = exhaustedClass;");
  });
});
