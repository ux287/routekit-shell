import { describe, it, expect } from "vitest";
import { parsePossibleArray } from "../../packages/mcp-rks/src/dendron.mjs";

describe("parsePossibleArray", () => {
  describe("handles non-string values", () => {
    it("returns arrays as-is", () => {
      const arr = ["a", "b"];
      expect(parsePossibleArray(arr)).toBe(arr);
    });

    it("returns numbers as-is", () => {
      expect(parsePossibleArray(42)).toBe(42);
    });

    it("returns null/undefined as-is", () => {
      expect(parsePossibleArray(null)).toBe(null);
      expect(parsePossibleArray(undefined)).toBe(undefined);
    });
  });

  describe("handles JSON array strings", () => {
    it("parses simple JSON array", () => {
      expect(parsePossibleArray('["a","b"]')).toEqual(["a", "b"]);
    });

    it("parses single-element JSON array", () => {
      expect(parsePossibleArray('["packages/mcp-rks/src/server.mjs"]')).toEqual([
        "packages/mcp-rks/src/server.mjs",
      ]);
    });

    it("parses JSON array with spaces", () => {
      expect(parsePossibleArray('["a", "b", "c"]')).toEqual(["a", "b", "c"]);
    });
  });

  describe("handles YAML-style lists", () => {
    it("parses YAML list with dashes", () => {
      expect(parsePossibleArray("- a\n- b")).toEqual(["a", "b"]);
    });

    it("parses YAML list with leading newline", () => {
      expect(parsePossibleArray("\n  - a\n  - b")).toEqual(["a", "b"]);
    });

    it("parses YAML list with quoted values", () => {
      expect(parsePossibleArray('- "a"\n- "b"')).toEqual(["a", "b"]);
    });
  });

  describe("handles double-encoded JSON (MCP transport artifact)", () => {
    it("unwraps double-encoded JSON array with double quotes", () => {
      // This is what happens when MCP transport JSON-encodes a JSON array string
      const doubleEncoded = '"[\\"packages/mcp-rks/src/dendron.mjs\\"]"';
      expect(parsePossibleArray(doubleEncoded)).toEqual([
        "packages/mcp-rks/src/dendron.mjs",
      ]);
    });

    it("unwraps double-encoded JSON array with multiple elements", () => {
      const doubleEncoded = '"[\\"a\\",\\"b\\",\\"c\\"]"';
      expect(parsePossibleArray(doubleEncoded)).toEqual(["a", "b", "c"]);
    });

    it("unwraps single-quote encoded JSON array", () => {
      const singleQuoteEncoded = "'[\"a\",\"b\"]'";
      expect(parsePossibleArray(singleQuoteEncoded)).toBe(singleQuoteEncoded);
    });
  });

  describe("handles single-quoted array literals", () => {
    it("parses single-quoted array with one element", () => {
      expect(parsePossibleArray("['foo.mjs']")).toEqual(["foo.mjs"]);
    });

    it("parses single-quoted array with multiple elements", () => {
      expect(parsePossibleArray("['foo.mjs', 'bar.mjs']")).toEqual(["foo.mjs", "bar.mjs"]);
    });

    it("parses single-quoted array with path values", () => {
      expect(parsePossibleArray("['packages/mcp-rks/src/dendron.mjs']")).toEqual([
        "packages/mcp-rks/src/dendron.mjs",
      ]);
    });
  });

  describe("returns original for non-array strings", () => {
    it("returns plain string unchanged", () => {
      expect(parsePossibleArray("hello")).toBe("hello");
    });

    it("returns empty string unchanged", () => {
      expect(parsePossibleArray("")).toBe("");
    });

    it("returns whitespace-only string unchanged", () => {
      expect(parsePossibleArray("   ")).toBe("   ");
    });
  });
});
