import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractKeywordsFromStory } from "../../packages/mcp-rks/src/server/planner-context.mjs";

describe("planner-context", () => {
  describe("extractKeywordsFromStory", () => {
    it("returns empty array for null/undefined input", () => {
      expect(extractKeywordsFromStory(null)).toEqual([]);
      expect(extractKeywordsFromStory(undefined)).toEqual([]);
      expect(extractKeywordsFromStory("")).toEqual([]);
    });

    it("extracts function names from code patterns", () => {
      const content = `
        function fetchData() {}
        async function processResults() {}
        const handleClick = () => {}
      `;
      const keywords = extractKeywordsFromStory(content);
      expect(keywords).toContain("fetchData");
      expect(keywords).toContain("processResults");
      expect(keywords).toContain("handleClick");
    });

    it("extracts camelCase function names from prose", () => {
      const content = `
        We need to modify the runPlanTool function.
        Also update fetchCodeSnippets and buildPrompt.
      `;
      const keywords = extractKeywordsFromStory(content);
      expect(keywords).toContain("runPlanTool");
      expect(keywords).toContain("fetchCodeSnippets");
      expect(keywords).toContain("buildPrompt");
    });

    it("extracts CamelCase class names", () => {
      const content = `
        The PlannerContext class handles context.
        Use CodeSnippetManager for snippets.
      `;
      const keywords = extractKeywordsFromStory(content);
      expect(keywords).toContain("PlannerContext");
      expect(keywords).toContain("CodeSnippetManager");
    });

    it("extracts backtick-quoted identifiers", () => {
      const content = `
        Update the \`reviewPlan\` function.
        Modify \`extractKeywords\` to handle edge cases.
      `;
      const keywords = extractKeywordsFromStory(content);
      expect(keywords).toContain("reviewPlan");
      expect(keywords).toContain("extractKeywords");
    });

    it("extracts terms from acceptance criteria", () => {
      const content = `
        ## Acceptance Criteria
        - [ ] telemetry events emitted correctly
        - [ ] snippets returned in proper format
        - [x] validation passes for all inputs
      `;
      const keywords = extractKeywordsFromStory(content);
      expect(keywords).toContain("telemetry");
      expect(keywords).toContain("snippets");
      expect(keywords).toContain("validation");
    });

    it("filters out common words", () => {
      const content = `
        - [ ] should handle this with code from each file
      `;
      const keywords = extractKeywordsFromStory(content);
      expect(keywords).not.toContain("should");
      expect(keywords).not.toContain("this");
      expect(keywords).not.toContain("with");
      expect(keywords).not.toContain("from");
      expect(keywords).not.toContain("each");
      expect(keywords).not.toContain("file");
      expect(keywords).not.toContain("code");
    });

    it("limits results to 15 keywords", () => {
      const content = `
        function one() {}
        function two() {}
        function three() {}
        function four() {}
        function five() {}
        function six() {}
        function seven() {}
        function eight() {}
        function nine() {}
        function ten() {}
        function eleven() {}
        function twelve() {}
        function thirteen() {}
        function fourteen() {}
        function fifteen() {}
        function sixteen() {}
        function seventeen() {}
      `;
      const keywords = extractKeywordsFromStory(content);
      expect(keywords.length).toBeLessThanOrEqual(15);
    });

    it("excludes JavaScript/TypeScript as keywords", () => {
      const content = `
        This is a JavaScript file.
        Written in TypeScript.
      `;
      const keywords = extractKeywordsFromStory(content);
      expect(keywords).not.toContain("JavaScript");
      expect(keywords).not.toContain("TypeScript");
    });

    it("excludes const/let/var/function as keywords", () => {
      const content = `
        Use \`const\` for constants.
        Use \`function\` for declarations.
      `;
      const keywords = extractKeywordsFromStory(content);
      expect(keywords).not.toContain("const");
      expect(keywords).not.toContain("function");
    });
  });
});
