import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASE_MACHINE } from "../../packages/mcp-rks/src/workflow/phases.mjs";
import { generateAgentToolDefinitions } from "../../packages/mcp-rks/src/agents/registry.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const note = (slug) => read(`notes/${slug}.md`);

// The five notes this story EDITS.
const EDITED = [
  "how-to.golden-path",
  "how-to.rks",
  "how-to.branch-topology",
  "how-to.dendron-note-creation",
  "public.canon.getting-started",
];

// The two notes this story deliberately does NOT edit. Their content was proposed for
// correction and the proposal was REFUTED — routekit/project.json is what
// `routekit project attach` actually writes (bootstrap.mjs:850, :863). These are pinned
// by anti-fix guards below so the correction is never re-proposed.
const NOT_EDITED = ["how-to.project-attach", "how-to.child-project-kickoff"];

describe("how-to corpus publish accuracy", () => {
  it("all seven notes this story reasons about still exist", () => {
    for (const slug of [...EDITED, ...NOT_EDITED]) {
      expect(existsSync(join(ROOT, `notes/${slug}.md`))).toBe(true);
    }
  });

  describe("stack id", () => {
    const stacksSrc = read("packages/mcp-rks/src/templates.mjs");
    const liveStacks = [...stacksSrc.matchAll(/"([a-z0-9.-]+)"/g)].map((m) => m[1]);

    it.each(["how-to.golden-path", "how-to.rks"])(
      "%s carries no web-vite-rag-agency",
      (slug) => {
        expect(note(slug)).not.toContain("web-vite-rag-agency");
      },
    );

    it("the stack id used in the docs is one templates.mjs enumerates", () => {
      for (const slug of ["how-to.golden-path", "how-to.rks"]) {
        const m = note(slug).match(/--stack[= ]([A-Za-z0-9.-]+)/);
        expect(m, `${slug} has no --stack example`).toBeTruthy();
        expect(liveStacks).toContain(m[1]);
      }
    });
  });

  describe("how-to.rks tool names and lifecycle", () => {
    const src = () => note("how-to.rks");

    it("carries no rks_ape", () => expect(src()).not.toContain("rks_ape"));
    it("carries no orchestrator_query", () =>
      expect(src()).not.toContain("orchestrator_query"));
    it("names rks_agent_research in the RAG Queries section", () =>
      expect(src()).toContain("rks_agent_research"));

    // The registration oracle is a UNION and must stay one. server.mjs alone UNDER-REPORTS:
    // agent tools are registered in agents/registry.mjs as `toolName: 'rks_agent_research'`
    // (single-quoted, different key, different file), and `name: "rks_agent_research"`
    // returns ZERO over packages/mcp-rks/src — positive-controlled by a bare
    // `rks_agent_research` search returning 45 matches across 5 files, so that zero is real.
    // generateAgentToolDefinitions() (exported, registry.mjs:160) emits `name: config.toolName`
    // (:196) plus `name: 'rks_agent_run'` (:165), so calling it yields the agent half directly.
    // Do NOT substitute a string-presence check under packages/mcp-rks/src — orchestrator_query
    // appears there as hook vocabulary (shared/read-classification.mjs:147, inside a string)
    // and would satisfy a presence check falsely.
    const registeredTools = () => {
      const serverSrc = read("packages/mcp-rks/src/server.mjs");
      const fromServer = [...serverSrc.matchAll(/name:\s*["']([a-z_]+)["']/g)].map((m) => m[1]);
      const fromAgents = generateAgentToolDefinitions().map((d) => d.name);
      return new Set([...fromServer, ...fromAgents]);
    };

    // ORACLE SELF-CHECK — must pass BEFORE any absence assertion is trusted. An oracle that
    // under-reports registered tools turns a CORRECT doc into a test failure. If this fails,
    // the ORACLE is broken, not the documentation.
    it("the registration oracle recognises the tools the corrected docs cite", () => {
      const registered = registeredTools();
      expect(registered.has("rks_agent_research")).toBe(true);
      const cited = new Set([...src().matchAll(/`(rks_[a-z_]+)`/g)].map((m) => m[1]));
      expect(cited.size).toBeGreaterThan(0);
      for (const t of cited) {
        expect(registered.has(t), `oracle does not recognise cited tool ${t}`).toBe(true);
      }
    });

    it("every rks_ tool the doc names is actually registered", () => {
      const registered = registeredTools();
      const cited = new Set([...src().matchAll(/`(rks_[a-z_]+)`/g)].map((m) => m[1]));
      for (const t of cited) expect([...registered]).toContain(t);
    });

    it("the tools this story removes are genuinely unregistered", () => {
      const registered = registeredTools();
      expect(registered.has("rks_ape")).toBe(false);
      expect(registered.has("orchestrator_query")).toBe(false);
    });

    const chainLine = () =>
      src()
        .split("\n")
        .find((l) => l.includes("draft") && l.includes("→"));

    it("every phase on the lifecycle chain is a live PHASE_MACHINE state", () => {
      const chain = chainLine();
      expect(chain).toBeTruthy();
      const tokens = chain.split("→").map((t) => t.trim().replace(/[`*]/g, ""));
      for (const t of tokens) expect(PHASE_MACHINE.states).toContain(t);
      expect(tokens).toContain("arch-approved");
      expect(tokens).not.toContain("implemented");
    });

    it("the bullet glossary agrees with the corrected chain", () => {
      const tokens = chainLine()
        .split("→")
        .map((t) => t.trim().replace(/[`*]/g, ""));
      const glossary = src()
        .split("\n")
        .filter((l) => /^\s*[-*]\s/.test(l))
        .join("\n");
      for (const t of tokens) expect(glossary).toContain(t);
    });

    it("the Quick Start Checklist gates QA and ARCH before planning", () => {
      const lines = src().split("\n");
      const story = lines.findIndex((l) => l.includes("Create a backlog story"));
      const plan = lines.findIndex((l, i) => i > story && l.includes("rks_plan"));
      expect(story).toBeGreaterThan(-1);
      expect(plan).toBeGreaterThan(story);
      const window = lines.slice(story + 1, plan);
      expect(window.some((l) => /\bQA\b/.test(l))).toBe(true);
      expect(window.some((l) => /\bARCH\b/i.test(l))).toBe(true);
    });
  });

  describe("how-to.branch-topology", () => {
    const src = () => note("how-to.branch-topology");
    it("carries no snacks reference, case-insensitively", () =>
      expect(src()).not.toMatch(/snacks/i));
    it("preserves the Tools Reference section", () =>
      expect(src()).toContain("## Tools Reference"));
    it("preserves projects/index.jsonl", () =>
      expect(src()).toContain("projects/index.jsonl"));
  });

  describe("how-to.dendron-note-creation", () => {
    const src = () => note("how-to.dendron-note-creation");
    const MARKERS = [
      "fm.title",
      "[First Action]",
      "[Second Action]",
      "## Purpose",
      "## Prerequisites",
      "## Step-by-Step Instructions",
    ];
    it.each(MARKERS)("placeholder %s is gone", (m) => expect(src()).not.toContain(m));
    it("the first body heading is Overview", () => {
      const body = src().split(/^---$/m).slice(2).join("---");
      const firstHeading = body.split("\n").find((l) => l.startsWith("#"));
      expect(firstHeading.trim()).toBe("## Overview");
    });
  });

  describe("public.canon.getting-started", () => {
    const src = () => note("public.canon.getting-started");
    it("carries no bare /onboard command", () =>
      expect(src()).not.toMatch(/\/onboard(?!er)/));
    it("names /rks-onboard at least three times", () =>
      expect((src().match(/\/rks-onboard/g) || []).length).toBeGreaterThanOrEqual(3));
    it("the rks-onboard skill directory exists on disk", () =>
      expect(existsSync(join(ROOT, ".claude/skills/rks-onboard"))).toBe(true));
  });

  // ANTI-FIX GUARDS. These are NOT coverage. They pin three paths that a literal search
  // reported as "missing" only because each is assembled with path.join and therefore
  // cannot appear as a literal in source. Three separate proposed corrections in this
  // story's lineage would each have broken working documentation.
  describe("anti-fix guards — do not 'correct' these", () => {
    it("both attach docs keep routekit/project.json and gain no .rks/project.json", () => {
      // bootstrap.mjs:850 path.join(routekitDir, "project.json"); :863 writeJSONWithBackup
      // resolve-project-root.mjs:19 path.join(current, "routekit", "project.json")
      for (const slug of NOT_EDITED) {
        expect(note(slug)).toContain("routekit/project.json");
        expect(note(slug)).not.toContain(".rks/project.json");
      }
    });
    it("preserves the two real routekit paths in how-to.project-attach", () => {
      const s = note("how-to.project-attach");
      expect(s).toContain("routekit/registry.json");
      expect(s).toContain("routekit/kg.yaml");
    });
  });
});
