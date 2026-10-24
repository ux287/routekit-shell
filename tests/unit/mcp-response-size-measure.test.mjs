// backlog.feat.mcp-tool-response-size-telemetry — measureToolResponse + audit wiring + enums
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { measureToolResponse } from "../../packages/mcp-rks/src/server/response-size.mjs";

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const enumOf = (src, re) => { const m = src.match(re); return m ? m[1] : ""; };

describe("measureToolResponse", () => {
  it("sums exact UTF-8 bytes and chars across every text block; approxTokens = ceil(chars/4)", () => {
    const a = "hello";      // 5 bytes, 5 chars
    const b = "héllo €!"; // 11 bytes, 8 chars
    const r = measureToolResponse({ content: [{ type: "text", text: a }, { type: "text", text: b }] });
    expect(r).toEqual({ responseBytes: 16, responseChars: 13, approxTokens: 4, contentBlocks: 2 });
    expect(r.responseBytes).toBe(Buffer.byteLength(a, "utf8") + Buffer.byteLength(b, "utf8"));
  });

  it("ignores non-text blocks in byte/char/token totals but counts them in contentBlocks", () => {
    expect(measureToolResponse({ content: [{ type: "image", data: "AAAA" }, { type: "text", text: "abcd" }] }))
      .toEqual({ responseBytes: 4, responseChars: 4, approxTokens: 1, contentBlocks: 2 });
    const onlyImage = measureToolResponse({ content: [{ type: "image", data: "AAAA" }] });
    expect([onlyImage.responseBytes, onlyImage.responseChars, onlyImage.approxTokens]).toEqual([0, 0, 0]);
  });

  it("returns all zeros for missing or malformed input and never throws", () => {
    const ZERO = { responseBytes: 0, responseChars: 0, approxTokens: 0, contentBlocks: 0 };
    for (const bad of [undefined, null, {}, { content: "x" }, { content: null }, 42, "str"]) {
      expect(() => measureToolResponse(bad)).not.toThrow();
      expect(measureToolResponse(bad)).toEqual(ZERO);
    }
    expect(() => measureToolResponse({ content: [null, { type: "text", text: 7 }] })).not.toThrow();
  });

  it("is observation-only: does not mutate the response", () => {
    const resp = { content: [{ type: "text", text: "{\"ok\":true}" }] };
    const before = JSON.stringify(resp);
    measureToolResponse(Object.freeze({ ...resp, content: Object.freeze(resp.content.map((c) => Object.freeze({ ...c }))) }));
    measureToolResponse(resp);
    expect(JSON.stringify(resp)).toBe(before);
  });
});

describe("CallToolRequestSchema audit wiring (server.mjs)", () => {
  const server = read("packages/mcp-rks/src/server.mjs");

  it("imports measureToolResponse from ./server/response-size.mjs", () => {
    expect(server).toMatch(/import\s*\{[^}]*\bmeasureToolResponse\b[^}]*\}\s*from\s*["']\.\/server\/response-size\.mjs["']/);
  });

  it("holds the response in _auditResponse, assigned only immediately before return _response", () => {
    expect(server).toContain("let _auditResponse = null;");
    expect(server).toMatch(/_auditResponse = _response;\s*return _response;/);
    expect(server.match(/_auditResponse\s*=(?!=)/g) || []).toHaveLength(2);
  });

  it("sizes only an observed response: the spread is guarded by _auditResponse === null (thrown call omits size keys)", () => {
    expect(server).toMatch(/\.\.\.\(\s*_auditResponse\s*===\s*null\s*\?\s*\{\s*\}\s*:\s*\{\s*\.\.\.measureToolResponse\(_auditResponse\)\s*\}\s*\)/);
  });

  it("spreads measureToolResponse(_auditResponse) into the audit payload after latencyMs", () => {
    const spread = "...measureToolResponse(_auditResponse)";
    expect(server.split(spread)).toHaveLength(2);
    expect(server.indexOf(spread)).toBeGreaterThan(server.indexOf("latencyMs: Date.now() - _auditStart,"));
  });

  it("leaves the failure-class reconciliation pins intact", () => {
    expect(server).toContain("decideToolOutcome({ threw: false, result: toolPayloadFromResponse(_response) })");
    expect(server).toContain("_auditOk = false;");
  });
});

describe("response_sizes is an accepted reportType", () => {
  it("server.mjs zod schema", () => {
    expect(enumOf(read("packages/mcp-rks/src/server.mjs"), /reportType:\s*z\.enum\(\[([^\]]*)\]\)/)).toContain("response_sizes");
  });
  it("server.mjs JSON schema", () => {
    expect(enumOf(read("packages/mcp-rks/src/server.mjs"), /reportType:\s*\{\s*type:\s*"string",\s*enum:\s*\[([^\]]*)\]/)).toContain("response_sizes");
  });
  it("agents/telemetry.mjs zod schema", () => {
    expect(enumOf(read("packages/mcp-rks/src/agents/telemetry.mjs"), /reportType:\s*z\.enum\(\[([^\]]*)\]\)/)).toContain("response_sizes");
  });
});
