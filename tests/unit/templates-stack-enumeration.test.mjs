import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listTemplates } from "../../packages/mcp-rks/src/templates.mjs";

// backlog.feat.template-library-cleanup
// Anti-phantom guard: listTemplates enumerates ONLY dirs with a real skeleton + kg.yaml, so a
// stack can never again be advertised-but-unscaffoldable (the app-web phantom / generic stub bug).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const stacks = listTemplates(repoRoot);
const ids = stacks.map((s) => s.stackId).sort();
const tplPath = (id, ...rest) => path.join(repoRoot, "templates", id, ...rest);

describe("template stack enumeration — anti-phantom guard", () => {
  it("every enumerated stack has a kg.yaml + a non-empty skeleton/", () => {
    expect(stacks.length).toBeGreaterThan(0);
    for (const s of stacks) {
      expect(fs.existsSync(tplPath(s.stackId, "kg.yaml")), `${s.stackId} kg.yaml`).toBe(true);
      const skeleton = tplPath(s.stackId, "skeleton");
      expect(fs.existsSync(skeleton) && fs.statSync(skeleton).isDirectory(), `${s.stackId} skeleton/`).toBe(true);
      expect(fs.readdirSync(skeleton).length, `${s.stackId} skeleton/ empty`).toBeGreaterThan(0);
    }
  });

  it("includes app.web.react.spa and base", () => {
    expect(ids).toContain("app.web.react.spa");
    expect(ids).toContain("base");
  });

  it("excludes the removed/broken stacks (generic stub, app-web phantom, web-11ty-nunjucks, web-vite-rag-agency)", () => {
    expect(ids).not.toContain("generic");
    expect(ids).not.toContain("app-web");
    expect(ids).not.toContain("web-11ty-nunjucks");
    expect(ids).not.toContain("web-vite-rag-agency");
  });

  it("app.web.react.spa is official React/Vite with NO dead rag scripts + a routing baseline", () => {
    const spa = stacks.find((s) => s.stackId === "app.web.react.spa");
    expect(spa).toBeDefined();
    expect(spa.official).toBe(true);
    expect(Object.keys(spa.kg?.scripts ?? {}).some((k) => /rag/i.test(k))).toBe(false);

    const pkg = JSON.parse(fs.readFileSync(tplPath("app.web.react.spa", "skeleton", "package.json"), "utf8"));
    expect(Object.keys(pkg.scripts).some((k) => /rag|content|guardrails/i.test(k))).toBe(false);
    expect(fs.existsSync(tplPath("app.web.react.spa", "skeleton", "scripts", "rag"))).toBe(false);
    // basic client-side routing is part of "what all apps need"
    expect(pkg.dependencies["react-router-dom"]).toBeTypeOf("string");
    expect(pkg.dependencies.react).toMatch(/18\./);
  });

  it("deriveDisplayName renders a dotted id cleanly (no leading-dot / empty segments)", () => {
    const spa = stacks.find((s) => s.stackId === "app.web.react.spa");
    expect(spa.displayName).toBe("App Web React Spa");
  });
});
