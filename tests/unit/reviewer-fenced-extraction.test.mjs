import { describe, it, expect } from "vitest";
import { extractExplicitEdits } from "../../packages/mcp-rks/src/llm/reviewer.mjs";

describe("extractExplicitEdits — fenced @@SEARCH/@@REPLACE/@@END blocks", () => {
  const bareStory = `## src/foo.mjs
@@SEARCH
const x = 1;
@@REPLACE
const x = 2;
@@END
`;

  const fencedStory = `## src/foo.mjs
\`\`\`
@@SEARCH
const x = 1;
@@REPLACE
const x = 2;
@@END
\`\`\`
`;

  it("bare block resolves file from heading", () => {
    const edits = extractExplicitEdits(bareStory);
    expect(edits.length).toBeGreaterThan(0);
    const edit = edits.find(e => e.source === "at_marker_block");
    expect(edit).toBeDefined();
    expect(edit.file).toBe("src/foo.mjs");
  });

  it("fenced block resolves file correctly when heading precedes fence", () => {
    const edits = extractExplicitEdits(fencedStory);
    expect(edits.length).toBeGreaterThan(0);
    const edit = edits.find(e => e.source === "at_marker_block");
    expect(edit).toBeDefined();
    expect(edit.file).toBe("src/foo.mjs");
  });

  it("fenced and bare blocks produce identical edit objects for same content", () => {
    const bareEdits = extractExplicitEdits(bareStory);
    const fencedEdits = extractExplicitEdits(fencedStory);
    const bareEdit = bareEdits.find(e => e.source === "at_marker_block");
    const fencedEdit = fencedEdits.find(e => e.source === "at_marker_block");
    expect(fencedEdit.file).toBe(bareEdit.file);
    expect(fencedEdit.search).toBe(bareEdit.search);
    expect(fencedEdit.replace).toBe(bareEdit.replace);
  });

  it("fenced block with File: prefix resolves file", () => {
    const story = `File: services/bar.ts\n\`\`\`\n@@SEARCH\nold code\n@@REPLACE\nnew code\n@@END\n\`\`\`\n`;
    const edits = extractExplicitEdits(story);
    const edit = edits.find(e => e.source === "at_marker_block");
    expect(edit).toBeDefined();
    expect(edit.file).toBe("services/bar.ts");
  });

  it("fenced block with js language tag resolves correctly", () => {
    const story = `## src/utils.js\n\`\`\`js\n@@SEARCH\nfoo()\n@@REPLACE\nbar()\n@@END\n\`\`\`\n`;
    const edits = extractExplicitEdits(story);
    const edit = edits.find(e => e.source === "at_marker_block");
    expect(edit).toBeDefined();
    expect(edit.file).toBe("src/utils.js");
    expect(edit.search.trim()).toBe("foo()");
    expect(edit.replace.trim()).toBe("bar()");
  });

  it("multiple fenced blocks in same story all resolve", () => {
    const story = `## src/a.mjs
\`\`\`
@@SEARCH
aOld
@@REPLACE
aNew
@@END
\`\`\`

## src/b.mjs
\`\`\`
@@SEARCH
bOld
@@REPLACE
bNew
@@END
\`\`\`
`;
    const edits = extractExplicitEdits(story).filter(e => e.source === "at_marker_block");
    expect(edits).toHaveLength(2);
    const files = edits.map(e => e.file);
    expect(files).toContain("src/a.mjs");
    expect(files).toContain("src/b.mjs");
  });

  it("bare (non-fenced) extraction continues to work after changes", () => {
    const story = `## packages/core/index.ts
@@SEARCH
export const VERSION = '1';
@@REPLACE
export const VERSION = '2';
@@END
`;
    const edits = extractExplicitEdits(story);
    const edit = edits.find(e => e.source === "at_marker_block");
    expect(edit).toBeDefined();
    expect(edit.file).toBe("packages/core/index.ts");
    expect(edit.search).toContain("VERSION = '1'");
    expect(edit.replace).toContain("VERSION = '2'");
  });
});
