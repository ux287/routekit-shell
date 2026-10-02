import assert from "node:assert";
import { runLlmPlanner } from "../src/llm/planner.mjs";
import { buildNoteDrivenSteps } from "../src/server.mjs";

describe("LLM planner", () => {
  it("returns null without keys", async () => {
    const res = await runLlmPlanner({ requirements: "test", context: "", targets: [], runFolder: null, useReplay: false });
    assert.strictEqual(res, null);
  });

  it("keeps deterministic fallback valid", () => {
    const note = `# Requirements\n- Parse numbered lists\n- Add table support\n- Add planner docs`;
    const steps = buildNoteDrivenSteps(note);
    assert.ok(steps.length > 0, "expected steps");
    steps.forEach((s) => {
      if (s.action === "note") return;
      assert.ok(s.path && s.path.trim().length > 0, "path present");
      if (s.action === "edit_file" || s.action === "create_file") {
        assert.ok(s.content && s.content.trim().length > 0, "content present");
      }
    });
  });
});
