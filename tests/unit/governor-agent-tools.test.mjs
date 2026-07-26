import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

// The `governor` subagent's tool allowlist is defined in .claude/agents/governor.md frontmatter.
// The QA/ARCH regression-witness scan is prompted to use rks_exhaustive_search — so the governor
// MUST have it, or the scan degrades to RAG recall. This pins that (and the additive-only
// capability model: read-only research tools present, mutation built-ins absent).

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_DEF = join(__dirname, "../..", ".claude", "agents", "governor.md");
const tools = matter(readFileSync(AGENT_DEF, "utf8")).data.tools || [];

describe("governor subagent tool allowlist", () => {
  it("includes rks_exhaustive_search (enables the exhaustive regression-witness scan)", () => {
    expect(tools).toContain("mcp__rks__rks_exhaustive_search");
  });

  it("retains the read-only research + built-in tools (additive change, no removals)", () => {
    for (const t of ["mcp__rks__rks_agent_research", "mcp__rks__rks_governor_init", "Read", "Grep", "Glob"]) {
      expect(tools).toContain(t);
    }
  });

  it("still EXCLUDES file-mutation / shell built-ins (governors never shell out or mutate directly)", () => {
    for (const t of ["Bash", "Edit", "Write", "NotebookEdit"]) {
      expect(tools).not.toContain(t);
    }
  });
});
