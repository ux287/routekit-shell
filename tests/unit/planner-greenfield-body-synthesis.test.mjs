/**
 * Witness for backlog.fix.planner-greenfield-body-synthesis.
 *
 * THE BUG (clean-machine UAT, 2026-07-11): on a fresh child with an empty RAG index, a story
 * whose targets are all `op: create` never produced code. The JSON-embedded planner emitted
 * NARRATION in the `content` field —
 *
 *     { action: "create_file", path: "src/components/Calculator.tsx",
 *       content: "Create a Calculator component that handles the four basic operations." }
 *
 * — instead of a file body. Two things then went wrong, and they compounded:
 *
 *   1. DIVERGENCE. The LLM-side rule ("content is a non-empty string") called that plan
 *      `executable`. The server-side create-coverage gate was stricter and called the same
 *      target uncovered. Neither side could win: the plan was too "good" to retry usefully and
 *      too empty to execute, so it round-tripped as generic `output_invalid` / `has_note_steps`
 *      until retries exhausted. No amount of refinement fixes this — the planner cannot emit a
 *      whole file body through the JSON channel, so asking it again just re-narrates.
 *
 *   2. NO SYNTHESIS PATH. Test files had an escape hatch (enrichTestFileContent makes a focused
 *      raw-code call), but source files had none. Greenfield is exactly the case where every
 *      file is a source file being born.
 *
 * THE FIX, pinned here:
 *   A. ONE shared predicate — isSynthesizedBody — answers "is this a real body?" for BOTH sides.
 *   B. enrichCreateFileContent synthesizes real bodies via a raw-code LLM call, upstream of every
 *      gate, UNGATED on testExemplar (a fresh child has none — and a fresh child is the case).
 *
 * The predicate is deliberately CONSERVATIVE: when in doubt it says "this is a real body". A
 * false negative is catastrophic (a real 200-line component gets downgraded to a note, or a
 * covered create target is declared unauthorable → hard, unrefinable failure). A false positive
 * is merely the status quo ante. The counterexample tests below hold that line.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { isSynthesizedBody } from "../../packages/mcp-rks/src/server/plan-quality.mjs";
import {
  computeHasExecutableWithContent,
  enrichCreateFileContent,
} from "../../packages/mcp-rks/src/llm/planner.mjs";

const TSX = "src/components/Calculator.tsx";

// ── The predicate ────────────────────────────────────────────────────────────────

describe("isSynthesizedBody — rejects only what is provably not a body", () => {
  it("rejects an empty or whitespace-only body", () => {
    expect(isSynthesizedBody("", TSX)).toBe(false);
    expect(isSynthesizedBody("   \n\t \n", TSX)).toBe(false);
    expect(isSynthesizedBody(null, TSX)).toBe(false);
    expect(isSynthesizedBody(undefined, TSX)).toBe(false);
  });

  it("rejects a body that is ONLY placeholder comments", () => {
    expect(isSynthesizedBody("// TODO: implement the calculator", TSX)).toBe(false);
    expect(isSynthesizedBody("/* FIXME: fill this in */", TSX)).toBe(false);
    expect(isSynthesizedBody("// TODO: add integration logic\n// FIXME: later", TSX)).toBe(false);
    expect(isSynthesizedBody("<!-- placeholder text -->", "public/index.html")).toBe(false);
  });

  it("REJECTS PROSE NARRATION in a code file — the actual greenfield bug", () => {
    expect(
      isSynthesizedBody("Create a Calculator component that handles the four basic operations.", TSX)
    ).toBe(false);
    expect(
      isSynthesizedBody("Implement the display module that renders the current value.", "src/Display.tsx")
    ).toBe(false);
    expect(
      isSynthesizedBody("Add a test file covering the arithmetic logic.", "src/calc.test.ts")
    ).toBe(false);
  });

  it("rejects a SHORT imperative sentence in a code file ('Create a Calculator.')", () => {
    // The narration patterns keyed on a verb+noun pair miss bare one-liners. A shapeless body
    // that is simply an English sentence is narration regardless of length.
    expect(isSynthesizedBody("Create a Calculator.", TSX)).toBe(false);
    expect(isSynthesizedBody("Create the display.", "src/components/Display.tsx")).toBe(false);
  });

  it("does NOT eat shapeless-but-real content that is not a sentence", () => {
    // The plain-sentence clause requires terminal punctuation, so non-prose bodies survive.
    expect(isSynthesizedBody("SELECT * FROM users", "db/query.sql")).toBe(true);
    expect(isSynthesizedBody("alpha\nbravo\ncharlie", "tests/fixtures/words.txt")).toBe(true);
  });

  it("ACCEPTS a real code body", () => {
    expect(isSynthesizedBody("export const Calculator = () => <div>0</div>;", TSX)).toBe(true);
    expect(
      isSynthesizedBody("import React from 'react';\n\nexport function App() {\n  return null;\n}\n", TSX)
    ).toBe(true);
    expect(isSynthesizedBody("def add(a, b):\n    return a + b\n", "calc.py")).toBe(true);
  });
});

describe("isSynthesizedBody — the catastrophic false-negatives it must NOT produce", () => {
  // Each of these is a REAL body. Under the coverage gate, wrongly calling one of them "not a
  // body" produces an unrefinable hard failure on a plan that was actually fine. These are the
  // counterexamples ARCH raised against an earlier, unanchored substring-matching draft.

  it("a real component containing an INCIDENTAL TODO comment is still a real body", () => {
    const real = [
      "import { useState } from 'react';",
      "",
      "export function Calculator() {",
      "  const [value, setValue] = useState('0');",
      "  // TODO: handle divide-by-zero",
      "  return <div className='calc'>{value}</div>;",
      "}",
    ].join("\n");
    expect(isSynthesizedBody(real, TSX)).toBe(true);
  });

  it("a README whose prose literally says 'Replace this' is still a real body", () => {
    const readme = "# Calculator\n\nA calculator app.\n\n## Setup\n\nReplace this section with your own notes.\n";
    expect(isSynthesizedBody(readme, "README.md")).toBe(true);
  });

  it("a YAML config whose comment says '# TODO' is still a real body", () => {
    const yml = "# TODO: pin the node version\nname: ci\non:\n  push:\n    branches: [main]\n";
    expect(isSynthesizedBody(yml, ".github/workflows/ci.yml")).toBe(true);
  });

  it("prose in a PROSE file type is legitimate content, not narration", () => {
    // The narration heuristic applies to CODE files only. A markdown deck or a note is allowed
    // to consist entirely of sentences — that IS its body.
    expect(isSynthesizedBody("Create a deck about governed AI delivery.", "notes/deck.md")).toBe(true);
    expect(isSynthesizedBody("Build the thing.", "docs/plan.txt")).toBe(true);
  });
});

// ── The two sides agree ──────────────────────────────────────────────────────────

describe("both gates ask the SAME question (the divergence that caused the loop)", () => {
  const proseStep = { action: "create_file", path: TSX, content: "Create a Calculator component." };
  const realStep = { action: "create_file", path: TSX, content: "export const C = () => null;" };

  it("a prose-only plan is NOT executable (old rule said it was)", () => {
    expect(computeHasExecutableWithContent([proseStep])).toBe(false);
  });

  it("a plan with a real body IS executable", () => {
    expect(computeHasExecutableWithContent([realStep])).toBe(true);
  });

  it("the LLM-side executability rule and the server-side coverage rule agree, step for step", () => {
    // The server gate is: create_file && isSynthesizedBody(content, path).
    // The LLM gate is: computeHasExecutableWithContent. For a single create_file step they must
    // never disagree — disagreement is precisely the unwinnable state.
    for (const content of [
      "",
      "   ",
      "// TODO: implement",
      "Create a Calculator component that handles the four basic operations.",
      "export const C = () => null;",
      "function add(a, b) { return a + b; }",
    ]) {
      const step = { action: "create_file", path: TSX, content };
      const serverSaysCovered = isSynthesizedBody(step.content, step.path);
      const llmSaysExecutable = computeHasExecutableWithContent([step]);
      expect(llmSaysExecutable).toBe(serverSaysCovered);
    }
  });

  it("search_replace and delete_file steps remain executable (unrelated to body synthesis)", () => {
    expect(
      computeHasExecutableWithContent([
        { action: "search_replace", path: "src/App.tsx", edits: [{ search: "a", replace: "b" }] },
      ])
    ).toBe(true);
    expect(computeHasExecutableWithContent([{ action: "delete_file", path: "src/old.ts" }])).toBe(true);
  });
});

// ── The synthesizer ──────────────────────────────────────────────────────────────

// No trailing newline: the raw-code channel runs output through stripMarkdownFences, which trims.
const REAL_BODY = "export function Calculator() {\n  return <div>0</div>;\n}";

// Stub the LLM transport. enrichCreateFileContent's whole job is to make a focused RAW-CODE call
// (not a JSON call) and swap the result in; we assert that behavior, not the model.
const callAnthropicChatWithUsage = vi.fn();
vi.mock("../../packages/mcp-rks/src/llm/clients.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createAnthropicClient: () => ({}),
    createOpenAiClient: () => ({}),
    callAnthropicChatWithUsage: (...args) => callAnthropicChatWithUsage(...args),
  };
});

const ENV = { provider: "anthropic", model: "claude-test", apiKey: "test" };

describe("enrichCreateFileContent — synthesizes bodies the JSON planner could not author", () => {
  beforeEach(() => {
    callAnthropicChatWithUsage.mockReset();
    callAnthropicChatWithUsage.mockResolvedValue({ content: REAL_BODY, usage: {} });
  });

  it("replaces a PROSE-narrated create_file body with real synthesized code", async () => {
    const actions = [
      { action: "create_file", path: TSX, content: "Create a Calculator component that adds numbers." },
    ];
    const out = await enrichCreateFileContent({ actions, requirements: "A calculator", env: ENV });

    expect(callAnthropicChatWithUsage).toHaveBeenCalledTimes(1);
    expect(out[0].content).toBe(REAL_BODY);
    // ...and the plan is now executable, which is the entire point.
    expect(computeHasExecutableWithContent(out)).toBe(true);
  });

  it("fills an EMPTY create_file body", async () => {
    const actions = [{ action: "create_file", path: TSX, content: "" }];
    const out = await enrichCreateFileContent({ actions, requirements: "A calculator", env: ENV });
    expect(out[0].content).toBe(REAL_BODY);
  });

  it("does NOT touch a create_file that already has a real body (no wasted LLM call)", async () => {
    const actions = [{ action: "create_file", path: TSX, content: REAL_BODY }];
    const out = await enrichCreateFileContent({ actions, requirements: "x", env: ENV });
    expect(callAnthropicChatWithUsage).not.toHaveBeenCalled();
    expect(out).toBe(actions); // same reference — untouched
  });

  it("does NOT touch edit_file / search_replace steps (create-only scope)", async () => {
    const actions = [
      { action: "edit_file", path: "src/App.tsx", content: "Add a route for the calculator." },
      { action: "search_replace", path: "src/main.tsx", edits: [{ search: "a", replace: "b" }] },
    ];
    const out = await enrichCreateFileContent({ actions, requirements: "x", env: ENV });
    expect(callAnthropicChatWithUsage).not.toHaveBeenCalled();
    expect(out).toBe(actions);
  });

  it("is UNGATED on testExemplar — a fresh child (no exemplar) still gets bodies", async () => {
    // enrichTestFileContent early-returns without an exemplar. This one must not: a brand-new
    // project has no prior test to imitate, and that is exactly the project we must serve.
    const actions = [{ action: "create_file", path: TSX, content: "Create a Calculator." }];
    const out = await enrichCreateFileContent({ actions, requirements: "calc", env: ENV /* no testExemplar */ });
    expect(out[0].content).toBe(REAL_BODY);
  });

  it("KEEPS the original step when synthesis returns another non-body (→ downstream fails LOUD)", async () => {
    // Never swap one unauthorable body for another: that would re-enter the loop this fix exists
    // to break. Leaving it uncovered routes to the loud, unrefinable structural failure, which is
    // the correct outcome when synthesis itself cannot author the file.
    callAnthropicChatWithUsage.mockResolvedValue({ content: "// TODO: implement", usage: {} });
    const actions = [{ action: "create_file", path: TSX, content: "Create a Calculator." }];
    const out = await enrichCreateFileContent({ actions, requirements: "calc", env: ENV });
    expect(out[0].content).toBe("Create a Calculator."); // unchanged
    expect(computeHasExecutableWithContent(out)).toBe(false); // → uncovered → structural fail
  });

  it("survives an LLM error without throwing (keeps the original step)", async () => {
    callAnthropicChatWithUsage.mockRejectedValue(new Error("upstream 529"));
    const actions = [{ action: "create_file", path: TSX, content: "Create a Calculator." }];
    const out = await enrichCreateFileContent({ actions, requirements: "calc", env: ENV });
    expect(out[0].content).toBe("Create a Calculator.");
  });

  it("synthesizes EVERY needy create in a multi-file greenfield plan", async () => {
    const actions = [
      { action: "create_file", path: "src/components/Calculator.tsx", content: "Create the calculator." },
      { action: "create_file", path: "src/components/Display.tsx", content: "Create the display." },
      { action: "create_file", path: "src/lib/calc.ts", content: "export const add = (a, b) => a + b;" }, // real
    ];
    const out = await enrichCreateFileContent({ actions, requirements: "calc app", env: ENV });
    expect(callAnthropicChatWithUsage).toHaveBeenCalledTimes(2); // only the two needy ones
    expect(out[0].content).toBe(REAL_BODY);
    expect(out[1].content).toBe(REAL_BODY);
    expect(out[2].content).toBe("export const add = (a, b) => a + b;");
  });

  it("sends a raw-code system prompt, not the JSON-planner prompt (the channel that could not author bodies)", async () => {
    const actions = [{ action: "create_file", path: TSX, content: "Create a Calculator." }];
    await enrichCreateFileContent({ actions, requirements: "calc", env: ENV });
    const { systemPrompt, prompt } = callAnthropicChatWithUsage.mock.calls[0][0];
    expect(systemPrompt).toMatch(/raw/i);
    expect(systemPrompt).toMatch(/no json/i); // must NOT ask for a JSON-wrapped plan
    expect(prompt).toContain(TSX); // names the file it must write
  });
});
