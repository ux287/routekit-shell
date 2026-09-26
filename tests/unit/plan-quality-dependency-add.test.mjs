/**
 * Witness for backlog.fix.dependency-add-contract-executable — the dependency contract, both ways.
 *
 * A clean-machine greenfield build was killed on turn one by this. The planner wrote an idiomatic RTL
 * test importing `@testing-library/user-event`, which the scaffold does not ship. The
 * `import_not_declared` gate correctly rejected the plan — and then told the Build Governor to
 * "decompose" and "use search_replace". Neither of those can declare a dependency. The Governor
 * followed advice that could not possibly work, and burned two identical retries.
 *
 * The gate had ALREADY computed the right answer: `checkImportGrounding` attaches
 * `suggestion: 'ground_imports'` to every issue it raises. `reviewPlan` threw it away and returned a
 * hardcoded pair. That is one line, and it travels — planner-persistence copies these into the
 * plan-failure marker and server.mjs splices them into the response the Governor actually reads.
 *
 * The mirror-image bug is here too: nothing flagged a plan that "installs" a package package.json
 * ALREADY declares. That happened, rewrote the manifest for nothing, and exec's scope guard rolled
 * the whole plan back.
 *
 * `reviewPlan` is async and takes a named-args object; driven directly against real package.json
 * fixtures. No source-text greps, no re-implementation of the rules.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reviewPlan,
  deriveSuggestions,
  planDependencyAdditions,
} from "../../packages/mcp-rks/src/server/plan-quality.mjs";

let projectRoot;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dep-contract-"));
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify({
      name: "fixture",
      dependencies: { react: "^18.0.0" },
      devDependencies: { vitest: "^2.0.0" },
    }),
  );
});
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

const planWith = (steps) => ({ problemId: "p", steps });
const review = (steps) => reviewPlan({ projectRoot, plan: planWith(steps) });

const UNDECLARED_IMPORT = [
  {
    action: "create_file",
    path: "src/Thing.test.tsx",
    target: "src/Thing.test.tsx",
    content:
      'import userEvent from "@testing-library/user-event";\n' +
      'export function t() { return userEvent; }\n',
  },
];

// ══════════════════════════════════════════════════════════════════════════════════
// W2 — the advice must name the REAL remedy
// ══════════════════════════════════════════════════════════════════════════════════

describe("an import_not_declared failure suggests the remedy that can actually fix it", () => {
  it("names ground_imports — NOT the hardcoded decompose / use_search_replace pair", async () => {
    const r = await review(UNDECLARED_IMPORT);

    // POSITIVE CONTROL: the failure was genuinely constructed. Without this, "the suggestions are
    // right" is also true of a plan that never failed at all.
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.check === "import_not_declared")).toBe(true);

    const types = r.suggestions.map((s) => s.type);
    expect(types).toContain("ground_imports");
    // THE BUG: this advice was returned for ANY error, and neither can declare a dependency.
    expect(types).not.toContain("decompose");
    expect(types).not.toContain("use_search_replace");
  });

  it("the advice actually tells you what to do", async () => {
    const r = await review(UNDECLARED_IMPORT);
    const s = r.suggestions.find((x) => x.type === "ground_imports");
    expect(s.detail).toMatch(/dependency-add step|npm install/i);
  });

  it("a plan that declares the dependency it imports PASSES the import gate", async () => {
    // POSITIVE CONTROL for the whole mechanism: the escape hatch the gate offers must genuinely work,
    // or the advice above is a cruel joke.
    const r = await review([
      { action: "run_command", command: "npm install @testing-library/user-event" },
      {
        action: "create_file",
        path: "src/Thing.test.tsx",
        target: "src/Thing.test.tsx",
        content: 'import userEvent from "@testing-library/user-event";\nexport const t = userEvent;\n',
      },
    ]);
    expect(r.errors.some((e) => e.check === "import_not_declared")).toBe(false);
  });

  // DERIVATION CONTROL. Without this, "ground_imports" could just be a second hardcode — the fix has
  // to DERIVE the advice from the failing check, not swap one constant for another.
  it("a DIFFERENT error yields its OWN suggestion, and no-remedy errors still fall back", () => {
    expect(
      deriveSuggestions([{ check: "x", suggestion: "remove_redundant_dependency_add" }]).map((s) => s.type),
    ).toEqual(["remove_redundant_dependency_add"]);
    expect(deriveSuggestions([{ check: "y" }]).map((s) => s.type)).toEqual(["decompose", "use_search_replace"]);
    expect(deriveSuggestions([])).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// W3 — the other direction: installing what is already there
// ══════════════════════════════════════════════════════════════════════════════════

describe("a dependency-add for an ALREADY-DECLARED package is flagged", () => {
  it("flags an npm install of a package package.json already declares", async () => {
    const r = await review([
      { action: "run_command", command: "npm install react" }, // react is ALREADY a dependency
      { action: "create_file", path: "src/a.mjs", target: "src/a.mjs", content: "export const a = 1;\n" },
    ]);

    const issue = r.errors.find((e) => e.check === "redundant_dependency_add");
    expect(issue).toBeTruthy();
    expect(issue.package).toBe("react");
    expect(r.suggestions.map((s) => s.type)).toContain("remove_redundant_dependency_add");
  });

  it("flags a devDependency too", async () => {
    const r = await review([{ action: "run_command", command: "npm i -D vitest" }]);
    expect(r.errors.some((e) => e.check === "redundant_dependency_add" && e.package === "vitest")).toBe(true);
  });

  // POSITIVE CONTROL. Without this, "no redundant adds" is also satisfied by a checker that flags
  // nothing at all — or by a plan that contains no dependency-add step to begin with.
  it("does NOT flag a genuinely MISSING package — and that plan really did contain a dep-add step", async () => {
    const steps = [{ action: "run_command", command: "npm install @testing-library/user-event" }];
    // The dep-add step is genuinely there and genuinely parsed.
    expect([...planDependencyAdditions({ steps })]).toContain("@testing-library/user-event");

    const r = await review(steps);
    expect(r.errors.some((e) => e.check === "redundant_dependency_add")).toBe(false);
  });

  it("version specifiers do not fool it (react@18 is still react)", async () => {
    const r = await review([{ action: "run_command", command: "npm install react@18.3.0" }]);
    expect(r.errors.some((e) => e.check === "redundant_dependency_add" && e.package === "react")).toBe(true);
  });
});
