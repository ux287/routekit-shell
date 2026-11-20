import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createResearchAgent } from "../../../packages/mcp-rks/src/agents/research.mjs";

// backlog.fix.research-agent-verbatim-regex-double-escape: behavioral coverage of the
// `read <path> verbatim` short-circuit regex. No source-text pinning.
const CONTENT = "VERBATIM_SENTINEL_e21b\nsecond line\n";
const EVIL = "EVIL_SIBLING_SENTINEL_3c9d";
const SECRET = "sk_live_DOTENV_SECRET_7f3a91";
const SECRET_LOCAL = "sk_local_DOTENV_SECRET_c42e";
const EXAMPLE = "EXAMPLE_KEY=placeholder_EXAMPLE_5b8d\n";

let parent;
let root;

beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), "rks-verbatim-regex-"));
  root = path.join(parent, "proj");
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes", "x.md"), CONTENT);
  fs.mkdirSync(path.join(parent, "proj-evil"));
  fs.writeFileSync(path.join(parent, "proj-evil", "x.md"), EVIL);
  fs.writeFileSync(path.join(root, ".env"), `API_KEY=${SECRET}\n`);
  fs.writeFileSync(path.join(root, ".env.local"), `LOCAL_KEY=${SECRET_LOCAL}\n`);
  fs.writeFileSync(path.join(root, ".env.example"), EXAMPLE);
});

afterEach(() => {
  fs.rmSync(parent, { recursive: true, force: true });
});

const cfgFor = (query) => createResearchAgent({ projectId: "t", query, projectRoot: root });

describe("research agent verbatim short-circuit regex", () => {
  it("a natural read-path-verbatim query short-circuits to the exact file content", async () => {
    const cfg = cfgFor("read notes/x.md verbatim");
    expect(typeof cfg.shortCircuit).toBe("function");
    const res = await cfg.shortCircuit();
    expect(res).toEqual({
      ok: true,
      answer: CONTENT,
      sources: [{ file: "notes/x.md" }],
      confidence: 1.0,
      advisory: false,
    });
  });

  it("an upper-case READ path VERBATIM query short-circuits", async () => {
    const cfg = cfgFor("READ notes/x.md VERBATIM");
    expect(typeof cfg.shortCircuit).toBe("function");
    const res = await cfg.shortCircuit();
    expect(res.answer).toBe(CONTENT);
  });

  it("multiple spaces between tokens still short-circuit", async () => {
    const cfg = cfgFor("read   notes/x.md   verbatim");
    expect(typeof cfg.shortCircuit).toBe("function");
    const res = await cfg.shortCircuit();
    expect(res.answer).toBe(CONTENT);
    expect(res.sources[0].file).toBe("notes/x.md");
  });

  it("a query holding a literal backslash-s does not short-circuit", () => {
    // One backslash character followed by s, between every token.
    const q = "read\\snotes/x.md\\sverbatim";
    expect(q.includes("\\s")).toBe(true);
    expect(cfgFor(q).shortCircuit).toBeUndefined();
  });

  it("a query that does not end in verbatim leaves shortCircuit undefined", () => {
    expect(cfgFor("read notes/x.md and summarize").shortCircuit).toBeUndefined();
  });

  it("a prefix-sibling path short-circuits to null", async () => {
    const cfg = cfgFor("read ../proj-evil/x.md verbatim");
    expect(typeof cfg.shortCircuit).toBe("function");
    expect(await cfg.shortCircuit()).toBeNull();
  });

  it("a missing in-root file short-circuits to null", async () => {
    const cfg = cfgFor("read notes/missing.md verbatim");
    expect(typeof cfg.shortCircuit).toBe("function");
    expect(await cfg.shortCircuit()).toBeNull();
  });

  it("a .env secret file short-circuits to null and its secret value never appears", async () => {
    const cfg = cfgFor("read .env verbatim");
    expect(typeof cfg.shortCircuit).toBe("function");
    const res = await cfg.shortCircuit();
    expect(res).toBeNull();
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it("a .env.local secret file short-circuits to null and its secret value never appears", async () => {
    const cfg = cfgFor("read .env.local verbatim");
    expect(typeof cfg.shortCircuit).toBe("function");
    const res = await cfg.shortCircuit();
    expect(res).toBeNull();
    expect(JSON.stringify(res)).not.toContain(SECRET_LOCAL);
  });

  it("a .env.example file still short-circuits to its exact content", async () => {
    const cfg = cfgFor("read .env.example verbatim");
    expect(typeof cfg.shortCircuit).toBe("function");
    const res = await cfg.shortCircuit();
    expect(res).toMatchObject({ ok: true, answer: EXAMPLE, sources: [{ file: ".env.example" }] });
  });

  it("a directory path short-circuits to null without throwing", async () => {
    const cfg = cfgFor("read notes verbatim");
    expect(typeof cfg.shortCircuit).toBe("function");
    expect(() => cfg.shortCircuit()).not.toThrow();
    expect(await cfg.shortCircuit()).toBeNull();
  });
});
