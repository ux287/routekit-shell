import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import * as researchModule from "../../../packages/mcp-rks/src/agents/research.mjs";
import { createResearchAgent } from "../../../packages/mcp-rks/src/agents/research.mjs";
import { createPlannerAgent } from "../../../packages/mcp-rks/src/agents/planner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../../../packages/mcp-rks/src/agents");
const SECRET = "sk-live-xyz";
const LOCAL_SECRET = "local-secret-4e1b";
const UPPER_SECRET = "upper-secret-90ad";
const EXAMPLE_VALUE = "your-key-here";
const ORDINARY = "ORDINARY_SENTINEL_3c7f";

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-planner-dotenv-"));
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify({ id: "t" }));
  fs.writeFileSync(path.join(root, ".env"), `SECRET_KEY=${SECRET}\n`);
  fs.writeFileSync(path.join(root, ".env.local"), `LOCAL_KEY=${LOCAL_SECRET}\n`);
  fs.writeFileSync(path.join(root, ".env.example"), `SECRET_KEY=${EXAMPLE_VALUE}\n`);
  fs.writeFileSync(path.join(root, "x.md"), ORDINARY);
  // Own directory: .ENV and .env collide on a case-insensitive filesystem.
  fs.mkdirSync(path.join(root, "upper"));
  fs.writeFileSync(path.join(root, "upper", ".ENV"), `UPPER_KEY=${UPPER_SECRET}\n`);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// A fresh agent per call, so no per-attempt read budget is shared between cases.
const plannerReadFile = () =>
  createPlannerAgent({ projectId: "t", storyId: "backlog.t.x", projectRoot: root }).tools.find((t) => t.name === "read_file");
const researchReadFile = () =>
  createResearchAgent({ projectId: "t", query: "q", projectRoot: root }).tools.find((t) => t.name === "read_file");

describe("planner agent read_file dotenv redaction", () => {
  it("redacts .env to variable names only", async () => {
    const res = await plannerReadFile().execute({ path: ".env" });
    expect(res.redacted).toBe(true);
    expect(res.variableNames).toContain("SECRET_KEY");
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it("redacts .env.local to variable names only", async () => {
    const res = await plannerReadFile().execute({ path: ".env.local" });
    expect(res.redacted).toBe(true);
    expect(res.variableNames).toContain("LOCAL_KEY");
    expect(JSON.stringify(res)).not.toContain(LOCAL_SECRET);
  });

  it("reads .env.example normally", async () => {
    const res = await plannerReadFile().execute({ path: ".env.example" });
    expect(res.redacted).toBeUndefined();
    expect(res.content).toContain(EXAMPLE_VALUE);
  });

  it("returns an ordinary in-root file unchanged", async () => {
    const res = await plannerReadFile().execute({ path: "x.md" });
    expect(Object.keys(res).sort()).toEqual(["content", "limit", "offset", "path", "totalLines"]);
    expect(res.path).toBe("x.md");
    expect(res.offset).toBe(0);
    expect(res.limit).toBe(200);
    expect(res.content).toBe(ORDINARY);
  });

  it("returns the same redacted result as the research agent read_file", async () => {
    const planner = await plannerReadFile().execute({ path: ".env" });
    const research = await researchReadFile().execute({ path: ".env" });
    expect(planner).toEqual(research);
    expect(planner).not.toHaveProperty("totalLines");
  });

  it("redacts an uppercase .ENV file", async () => {
    const res = await plannerReadFile().execute({ path: "upper/.ENV" });
    expect(res.redacted).toBe(true);
    expect(JSON.stringify(res)).not.toContain(UPPER_SECRET);
  });
});

describe("research agent read_file dotenv redaction shape", () => {
  it("keeps the existing redacted stub shape", async () => {
    const res = await researchReadFile().execute({ path: ".env" });
    expect(res.redacted).toBe(true);
    expect(res.reason).toBe("dotenv secret file — values are never returned");
    expect(res.variableNames).toEqual(["SECRET_KEY"]);
    expect(res.content.startsWith("[REDACTED dotenv file: .env]")).toBe(true);
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });
});

describe("single dotenv rule shared from research.mjs", () => {
  const plannerSrc = () => fs.readFileSync(path.join(SRC, "planner.mjs"), "utf8");
  const researchSrc = () => fs.readFileSync(path.join(SRC, "research.mjs"), "utf8");

  it("planner.mjs holds no dotenv regex and research.mjs holds the exemption once", () => {
    expect(plannerSrc()).not.toContain("example|sample|template");
    expect(plannerSrc()).not.toContain("\\.env");
    expect(researchSrc().split("example|sample|template").length - 1).toBe(1);
  });

  it("planner.mjs imports a research.mjs function beyond createResearchAgent and isWithinProjectRoot", () => {
    const m = plannerSrc().match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/research\.mjs['"]/);
    expect(m).not.toBeNull();
    const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    const extra = names.filter((n) => n !== "createResearchAgent" && n !== "isWithinProjectRoot");
    expect(extra.length).toBeGreaterThanOrEqual(1);
    for (const n of extra) expect(typeof researchModule[n]).toBe("function");
  });
});
