import { describe, it, expect } from "vitest";
import { parsePlannerJson, normalizePlannerSteps, classifyPlan } from "../packages/mcp-rks/src/llm/planner.mjs";

const sampleRaw = [
  "```json",
  "{",
  '  "planSummary": "Add CLI guardrails",',
  '  "steps": [',
  "    {",
  '      "title": "Enforce clean tree",',
  '      "description": "Check git status before exec",',
  '      "action": "edit_file",',
  '      "path": "packages/cli/bin/routekit.js",',
  '      "content": "patch content"',
  "    },",
  "    {",
  '      "title": "Clarify base branch",',
  '      "description": "Document baseBranch expectation",',
  '      "action": "note",',
  '      "path": null,',
  '      "content": null',
  "    }",
  "  ]",
  "}",
  "```",
].join("\n");

describe("planner JSON parsing", () => {
  it("parses fenced JSON and normalizes steps", () => {
    const parsed = parsePlannerJson(sampleRaw);
    expect(parsed).toBeTruthy();
    expect(parsed.planSummary).toBe("Add CLI guardrails");
    expect(Array.isArray(parsed.steps)).toBe(true);
    const normalized = normalizePlannerSteps(parsed.steps);
    expect(normalized.steps.length).toBe(2);
    expect(normalized.hasExecutableWithContent).toBe(true);
    expect(normalized.steps[0].action).toBe("edit_file");
    expect(normalized.steps[0].path).toBe("packages/cli/bin/routekit.js");
    expect(normalized.steps[0].content).toBe("patch content");
    expect(normalized.steps[1].action).toBe("note");
    expect(normalized.steps[1].path).toBeNull();
  });

  it("detects missing content on executable steps", () => {
    const raw = JSON.stringify({
      planSummary: "test plan",
      steps: [
        { title: "no content", action: "edit_file", path: "packages/cli/bin/routekit.js", content: "" },
      ],
    });
    const parsed = parsePlannerJson(raw);
    const normalized = normalizePlannerSteps(parsed.steps);
    expect(normalized.hasExecutableWithContent).toBe(false);
    expect(
      classifyPlan({
        parsed,
        hasExecutableWithContent: normalized.hasExecutableWithContent,
        diffRejected: normalized.diffRejected,
      })
    ).toBe("note_only");
  });

  it("classifies error when parsed is null", () => {
    expect(classifyPlan({ parsed: null, hasExecutableWithContent: false, diffRejected: false })).toBe("error");
  });

  it("coerces note with code content to edit_file", () => {
    const raw = JSON.stringify({
      planSummary: "coerce note",
      steps: [
        {
          action: "note",
          content: "import fs from 'fs';\nconst x = 1;",
          path: "packages/mcp-rks/src/server.mjs",
        },
      ],
    });
    const parsed = parsePlannerJson(raw);
    const normalized = normalizePlannerSteps(parsed.steps);
    expect(normalized.steps[0].action).toBe("edit_file");
    expect(normalized.hasExecutableWithContent).toBe(true);
  });
});
