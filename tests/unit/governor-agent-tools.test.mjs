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
  it("includes every tool a Governor prompt names as mandatory", () => {
    // backlog.fix.exec-abort-missing-from-governor-toolset — the third instance of
    // one class: a tool named as mandatory in a Governor prompt but absent from this
    // allowlist, which makes the instruction physically unsatisfiable.
    //
    // rks_exec_abort is the reason this block exists. governor-build.md tells the
    // Build Governor to "Call rks_exec_abort to clean up any incomplete run", and the
    // server side is complete — exec.mjs carries a RESET leg that recovers a story
    // stranded at phase `executing` by a dead session. Without the entry below that
    // recovery is unreachable from the flow that needs it, and a story wedges: the
    // only phase meaning "a plan ran against this" is the one phase plan_ready bars.
    //
    // The other two are pinned here rather than in separate blocks because they are
    // the same defect, not three coincidences. NOTE both of those stories still read
    // phase arch-approved while their work is already in the tree — building either
    // as written would attempt a create-over-existing or a redundant insert.
    for (const t of [
      "mcp__rks__rks_exec_abort",
      "mcp__rks__rks_exhaustive_search",
      "mcp__rks__rks_fetch_raw",
    ]) {
      expect(tools, `${t} is mandated by a Governor prompt but missing from the allowlist`).toContain(t);
    }
  });

  it("lists no tool twice", () => {
    // The story's own @@SEARCH anchor is `  - mcp__rks__rks_exec`, which is a strict
    // substring of `  - mcp__rks__rks_exec_abort` once applied — so a refine or retry
    // loop that re-applies it inserts a duplicate entry. Every toContain assertion
    // above still passes on a doubled array, and so does the length lower bound, so
    // nothing else here would catch it. YAML preserves duplicate sequence items.
    expect(new Set(tools).size, `duplicate entries: ${tools.filter((t, i) => tools.indexOf(t) !== i).join(", ")}`).toBe(tools.length);
  });

  it("includes rks_exhaustive_search (enables the exhaustive regression-witness scan)", () => {
    expect(tools).toContain("mcp__rks__rks_exhaustive_search");
  });

  it("retains the read-only research + built-in tools (additive change, no removals)", () => {
    for (const t of ["mcp__rks__rks_agent_research", "mcp__rks__rks_governor_init", "Read", "Grep", "Glob"]) {
      expect(tools).toContain(t);
    }
  });

  it("includes rks_arch_verdict (the ARCH Governor's only path to record a verdict)", () => {
    // This closed list is the SOLE gate on which MCP tools a Governor subagent may
    // call — no skill carries its own. Since dendron.mjs now refuses a direct
    // arch_verdict write, omitting this entry would leave the reworked ARCH prompt
    // mandating a call the harness never exposes.
    expect(tools).toContain("mcp__rks__rks_arch_verdict");
  });

  it("still EXCLUDES file-mutation / shell built-ins (governors never shell out or mutate directly)", () => {
    for (const t of ["Bash", "Edit", "Write", "NotebookEdit"]) {
      expect(tools).not.toContain(t);
    }
  });
});
