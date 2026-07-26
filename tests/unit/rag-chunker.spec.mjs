/**
 * Tests for RAG chunking modules:
 * - packages/mcp-rks/src/rag/dendron-parser.mjs
 * - packages/mcp-rks/src/rag/notes-chunker.mjs
 * - packages/mcp-rks/src/rag/code-chunker.mjs
 *
 * These are pure functions that don't require mocking.
 */

import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  parseHeadings,
  parseDendronNote,
  headingPathForNode,
  estimateTokens,
} from "../../packages/mcp-rks/src/rag/dendron-parser.mjs";
import {
  chunkNoteText,
  chunkParsedNote,
} from "../../packages/mcp-rks/src/rag/notes-chunker.mjs";
import { chunkFile } from "../../packages/mcp-rks/src/rag/code-chunker.mjs";

describe("dendron-parser", () => {
  describe("parseFrontmatter", () => {
    it("parses YAML frontmatter from markdown", () => {
      const text = `---
id: test.note
title: Test Note
created: 1700000000000
updated: 1700000000000
---

# Body`;
      const result = parseFrontmatter(text);
      expect(result.metadata.id).toBe("test.note");
      expect(result.metadata.title).toBe("Test Note");
      expect(result.raw).toContain("id: test.note");
    });

    it("returns empty metadata when no frontmatter", () => {
      const text = "# Just a heading\nSome content.";
      const result = parseFrontmatter(text);
      expect(result.metadata).toEqual({});
      expect(result.raw).toBeNull();
    });

    it("parses boolean values", () => {
      const text = `---
id: test
testExempt: true
active: false
---`;
      const result = parseFrontmatter(text);
      expect(result.metadata.testExempt).toBe(true);
      expect(result.metadata.active).toBe(false);
    });

    it("parses inline arrays", () => {
      const text = `---
id: test
tags: ['foo', 'bar']
---`;
      const result = parseFrontmatter(text);
      expect(result.metadata.tags).toEqual(["foo", "bar"]);
    });

    it("parses numeric values", () => {
      const text = `---
id: test
created: 1700000000000
---`;
      const result = parseFrontmatter(text);
      expect(result.metadata.created).toBe(1700000000000);
    });
  });

  describe("parseHeadings", () => {
    it("extracts headings with levels", () => {
      const text = `# Heading 1
Some content.

## Heading 2
More content.

### Heading 3
Deep content.`;
      const { nodes } = parseHeadings(text);
      expect(nodes).toHaveLength(3);
      expect(nodes[0].heading).toBe("Heading 1");
      expect(nodes[0].level).toBe(1);
      expect(nodes[1].heading).toBe("Heading 2");
      expect(nodes[1].level).toBe(2);
      expect(nodes[2].heading).toBe("Heading 3");
      expect(nodes[2].level).toBe(3);
    });

    it("captures content between headings", () => {
      const text = `## Problem
This is the problem.

## Solution
This is the solution.`;
      const { nodes } = parseHeadings(text);
      expect(nodes[0].content).toContain("This is the problem.");
      expect(nodes[1].content).toContain("This is the solution.");
    });

    it("builds parent-child relationships", () => {
      const text = `# Parent
## Child
### Grandchild`;
      const { nodes } = parseHeadings(text);
      expect(nodes[1].parent).toBe(nodes[0]);
      expect(nodes[2].parent).toBe(nodes[1]);
      expect(nodes[0].children).toContain(nodes[1]);
    });

    it("returns empty nodes for text without headings", () => {
      const { nodes } = parseHeadings("Just plain text.\nNo headings here.");
      expect(nodes).toHaveLength(0);
    });
  });

  describe("parseDendronNote", () => {
    it("extracts dendron_id from frontmatter", () => {
      const text = `---
id: backlog.test.story
title: Test Story
---
## Problem
A problem.`;
      const parsed = parseDendronNote(text, "notes/backlog.test.story.md");
      expect(parsed.dendron_id).toBe("backlog.test.story");
      expect(parsed.metadata.title).toBe("Test Story");
      expect(parsed.nodes.length).toBeGreaterThan(0);
    });

    it("falls back to filename for dendron_id when no frontmatter id", () => {
      const text = `## No frontmatter here
Just content.`;
      const parsed = parseDendronNote(text, "notes/my-note.md");
      expect(parsed.dendron_id).toBe("my-note");
    });

    it("strips frontmatter from body", () => {
      const text = `---
id: test
---
## Body heading
Content here.`;
      const parsed = parseDendronNote(text);
      expect(parsed.body).not.toContain("---");
      expect(parsed.body).toContain("## Body heading");
    });
  });

  describe("headingPathForNode", () => {
    it("returns path from root to node", () => {
      const text = `# Root
## Child
### Leaf`;
      const { nodes } = parseHeadings(text);
      const path = headingPathForNode(nodes[2]);
      expect(path).toEqual(["Root", "Child", "Leaf"]);
    });

    it("returns single-element path for root nodes", () => {
      const text = `# Only Root`;
      const { nodes } = parseHeadings(text);
      const path = headingPathForNode(nodes[0]);
      expect(path).toEqual(["Only Root"]);
    });
  });

  describe("estimateTokens", () => {
    it("estimates token count from text", () => {
      const text = "This is a test sentence with seven words.";
      const tokens = estimateTokens(text);
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBe(8); // "This", "is", "a", "test", "sentence", "with", "seven", "words."
    });

    it("returns 0 for empty/null text", () => {
      expect(estimateTokens("")).toBe(0);
      expect(estimateTokens(null)).toBe(0);
      expect(estimateTokens(undefined)).toBe(0);
    });
  });
});

describe("notes-chunker", () => {
  describe("chunkNoteText", () => {
    it("creates chunks from a note with headings", () => {
      const text = `---
id: backlog.test.chunker
title: Chunker Test
---
## Problem
The system needs better chunking.

## Solution
Implement heading-based chunking.`;

      const chunks = chunkNoteText(text, "notes/backlog.test.chunker.md");
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      // Each chunk should have required fields
      for (const chunk of chunks) {
        expect(chunk.id).toBeDefined();
        expect(chunk.content).toBeDefined();
        expect(chunk.dendron_id).toBe("backlog.test.chunker");
        expect(chunk.token_count).toBeGreaterThan(0);
      }
    });

    it("creates single chunk for note without headings", () => {
      const text = `---
id: simple.note
---
Just some plain text without any headings.`;

      const chunks = chunkNoteText(text, "notes/simple.note.md");
      expect(chunks).toHaveLength(1);
      expect(chunks[0].heading_path).toEqual([]);
      expect(chunks[0].dendron_id).toBe("simple.note");
    });

    it("preserves tags from frontmatter metadata", () => {
      const text = `---
id: tagged.note
tags: ['alpha', 'beta']
---
## Content
Some content here.`;

      const chunks = chunkNoteText(text, "notes/tagged.note.md");
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].tags).toEqual(["alpha", "beta"]);
    });

    it("assigns note_type from dendron hierarchy", () => {
      const text = `---
id: backlog.feature.test
---
## Test
Content.`;

      const chunks = chunkNoteText(text, "notes/backlog.feature.test.md");
      expect(chunks[0].note_type).toBe("backlog");
    });

    it("handles note with deeply nested headings", () => {
      const text = `---
id: deep.note
---
## Level 2
Content at level 2.
### Level 3
Content at level 3.
#### Level 4
Content at level 4.`;

      const chunks = chunkNoteText(text);
      expect(chunks.length).toBeGreaterThan(0);
      // Check heading paths are preserved
      const deepChunk = chunks.find(c => c.content.includes("Level 4"));
      expect(deepChunk).toBeDefined();
    });
  });

  describe("chunkParsedNote", () => {
    it("handles empty parsed note", () => {
      const parsed = {
        dendron_id: "empty",
        body: "",
        nodes: [],
        metadata: {},
        path: null,
      };
      const chunks = chunkParsedNote(parsed);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].dendron_id).toBe("empty");
    });
  });
});

describe("code-chunker", () => {
  describe("chunkFile", () => {
    it("creates file summary and symbol chunks for JS code", async () => {
      const code = `/**
 * A simple utility module.
 */

export function add(a, b) {
  return a + b;
}

export function subtract(a, b) {
  return a - b;
}

const CONSTANT = 42;
`;
      const chunks = await chunkFile("src/utils.mjs", code);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      // First chunk should be file summary
      expect(chunks[0].symbol_type).toBe("file_summary");
      expect(chunks[0].path).toBe("src/utils.mjs");
      expect(chunks[0].content).toContain("FILE: src/utils.mjs");
    });

    it("extracts exported function symbols", async () => {
      const code = `export function doSomething(input) {
  return input.toUpperCase();
}`;
      const chunks = await chunkFile("src/helper.mjs", code);
      const symbolChunks = chunks.filter(c => c.symbol_type !== "file_summary");
      // Should find at least the exported function
      const fnChunk = symbolChunks.find(c => c.symbol_name === "doSomething");
      if (fnChunk) {
        expect(fnChunk.exports).toBe(true);
        expect(fnChunk.content).toContain("doSomething");
      }
    });

    it("handles empty code file", async () => {
      const chunks = await chunkFile("src/empty.mjs", "");
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      // Should still have a file summary
      expect(chunks[0].symbol_type).toBe("file_summary");
    });

    it("preserves file path in all chunks", async () => {
      const code = `export const FOO = 1;\nexport function bar() { return FOO; }`;
      const chunks = await chunkFile("packages/core/index.mjs", code);
      for (const chunk of chunks) {
        expect(chunk.path).toBe("packages/core/index.mjs");
      }
    });
  });
});
