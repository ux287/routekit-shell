import { describe, it, expect } from "vitest";
import { extractJsonFromText } from "../../../packages/mcp-rks/src/agents/runner.mjs";

// Ported from the retired node:test suite packages/mcp-rks/__tests__/agent-runner.spec.mjs
// (`extractJsonFromText` block; ran in no CI tier). backlog.chore.retire-agent-runner-node-test-spec.
// Origin: backlog.fix.research-agent-output-contract-reliability.
describe("extractJsonFromText — output-contract tolerance", () => {
  it("parses pure valid JSON unchanged", () => {
    expect(extractJsonFromText('{"ok":true,"n":1}')).toEqual({ ok: true, n: 1 });
  });

  it("returns the FIRST object when multiple JSON blocks are present", () => {
    const raw = '```json\n{"first":1}\n```\nthen\n```json\n{"second":2}\n```';
    expect(extractJsonFromText(raw)).toEqual({ first: 1 });
  });

  it("returns undefined for genuinely non-JSON text", () => {
    expect(extractJsonFromText("not valid json at all")).toBeUndefined();
  });

  it("extracts JSON from a fenced json block with surrounding prose", () => {
    const raw = 'Here is the result:\n```json\n{"answer":"hi","sources":[]}\n```\nDone.';
    expect(extractJsonFromText(raw)).toEqual({ answer: "hi", sources: [] });
  });

  it("extracts a bare JSON object after leading prose", () => {
    const raw = 'Now I have the answer: {"ok":true,"value":42} that should do it.';
    expect(extractJsonFromText(raw)).toEqual({ ok: true, value: 42 });
  });

  it("is string-aware so a closing brace inside a string value does not close the object early", () => {
    const raw = 'prose {"path":"a}b","note":"x{y}z"} more prose';
    expect(extractJsonFromText(raw)).toEqual({ path: "a}b", note: "x{y}z" });
  });

  it("handles escaped quotes inside string values", () => {
    const raw = '{"msg":"she said \\"hi\\" }","ok":true}';
    expect(extractJsonFromText(raw)).toEqual({ msg: 'she said "hi" }', ok: true });
  });

  it("extracts JSON wrapped in XML or HTML tags", () => {
    expect(extractJsonFromText('<result>{"wrapped":true}</result>')).toEqual({ wrapped: true });
  });

  it("skips a false-start brace and finds the real JSON object", () => {
    const raw = 'use { to open and the data is {"real":true}';
    expect(extractJsonFromText(raw)).toEqual({ real: true });
  });

  it("returns undefined for empty or whitespace input and for non-strings", () => {
    expect(extractJsonFromText("   ")).toBeUndefined();
    expect(extractJsonFromText("")).toBeUndefined();
    expect(extractJsonFromText(null)).toBeUndefined();
    expect(extractJsonFromText(undefined)).toBeUndefined();
  });
});
