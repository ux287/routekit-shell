import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createResearchAgent } from "../../../packages/mcp-rks/src/agents/research.mjs";

const SECRET = "sk-dotenv-case-secret-7f3a91";
const EXEMPT_BODY = "API_KEY=your-key-here\n";
const PLAIN_BODY = "hello plain file\n";
const SECRET_NAMES = [".ENV", ".Env", ".ENV.LOCAL", ".env.Production"];
const EXEMPT_NAMES = [".env.example", ".ENV.EXAMPLE", ".Env.Sample", ".env.TEMPLATE"];

let parent;
let root;

// One directory per name, so names that differ only in case never share a directory.
function fixture(dir, name, body) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, name), body);
  return `${dir}/${name}`;
}
function symlinkFixture(linkRel, targetRel) {
  fs.mkdirSync(path.dirname(path.join(root, linkRel)), { recursive: true });
  fs.symlinkSync(path.join(root, targetRel), path.join(root, linkRel));
  return linkRel;
}
const readFileTool = () =>
  createResearchAgent({ projectId: "t", query: "q", projectRoot: root }).tools.find((t) => t.name === "read_file");
async function shortCircuit(rel) {
  const cfg = createResearchAgent({ projectId: "t", query: `read ${rel} verbatim`, projectRoot: root });
  expect(typeof cfg.shortCircuit).toBe("function");
  return cfg.shortCircuit();
}

beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), "rks-dotenv-case-"));
  root = path.join(parent, "proj");
  fs.mkdirSync(root);
});
afterEach(() => {
  fs.rmSync(parent, { recursive: true, force: true });
});

describe("research dotenv rule case and symlink", () => {
  it("read_file redacts case-variant dotenv names", async () => {
    for (const [i, name] of SECRET_NAMES.entries()) {
      const rel = fixture(`s${i}`, name, `API_KEY=${SECRET}\n`);
      const res = await readFileTool().execute({ path: rel });
      expect(res.redacted, name).toBe(true);
      expect(res.variableNames, name).toContain("API_KEY");
      expect(JSON.stringify(res), name).not.toContain(SECRET);
    }
  });

  it("verbatim short-circuit returns null for case-variant dotenv names", async () => {
    for (const [i, name] of SECRET_NAMES.entries()) {
      const rel = fixture(`s${i}`, name, `API_KEY=${SECRET}\n`);
      const res = await shortCircuit(rel);
      expect(res, name).toBeNull();
      expect(JSON.stringify(res ?? null), name).not.toContain(SECRET);
    }
  });

  it("read_file reads case-variant exempt names normally", async () => {
    for (const [i, name] of EXEMPT_NAMES.entries()) {
      const rel = fixture(`e${i}`, name, EXEMPT_BODY);
      const res = await readFileTool().execute({ path: rel });
      expect(res.redacted, name).toBeFalsy();
      expect(JSON.stringify(res), name).toContain("your-key-here");
    }
  });

  it("verbatim short-circuit returns exact content for case-variant exempt names", async () => {
    for (const [i, name] of EXEMPT_NAMES.entries()) {
      const rel = fixture(`e${i}`, name, EXEMPT_BODY);
      const res = await shortCircuit(rel);
      expect(res, name).toMatchObject({ ok: true, answer: EXEMPT_BODY });
    }
  });

  it("read_file redacts a non-dotenv-named symlink to an in-root .env", async () => {
    fs.writeFileSync(path.join(root, ".env"), `API_KEY=${SECRET}\n`);
    const rel = symlinkFixture("notes/cfg.txt", ".env");
    const res = await readFileTool().execute({ path: rel });
    expect(res.redacted).toBe(true);
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it("verbatim short-circuit returns null for a non-dotenv-named symlink to an in-root .env", async () => {
    fs.writeFileSync(path.join(root, ".env"), `API_KEY=${SECRET}\n`);
    const rel = symlinkFixture("notes/cfg.txt", ".env");
    const res = await shortCircuit(rel);
    expect(res).toBeNull();
    expect(JSON.stringify(res ?? null)).not.toContain(SECRET);
  });

  it("a non-dotenv-named symlink to an ordinary file reads normally through both callers", async () => {
    fixture("plain", "data.txt", PLAIN_BODY);
    const rel = symlinkFixture("notes/link.txt", "plain/data.txt");
    const rf = await readFileTool().execute({ path: rel });
    expect(rf.redacted).toBeFalsy();
    expect(JSON.stringify(rf)).toContain("hello plain file");
    const sc = await shortCircuit(rel);
    expect(sc).toMatchObject({ ok: true, answer: PLAIN_BODY });
  });

  it("both callers agree on dotenv classification for every fixture", async () => {
    const rels = [];
    for (const [i, name] of SECRET_NAMES.entries()) rels.push(fixture(`s${i}`, name, `API_KEY=${SECRET}\n`));
    for (const [i, name] of EXEMPT_NAMES.entries()) rels.push(fixture(`e${i}`, name, EXEMPT_BODY));
    fs.writeFileSync(path.join(root, ".env"), `API_KEY=${SECRET}\n`);
    rels.push(".env");
    rels.push(symlinkFixture("notes/cfg.txt", ".env"));
    fixture("plain", "data.txt", PLAIN_BODY);
    rels.push(symlinkFixture("notes/link.txt", "plain/data.txt"));
    for (const rel of rels) {
      const rf = await readFileTool().execute({ path: rel });
      const sc = await shortCircuit(rel);
      expect(sc === null, rel).toBe(rf.redacted === true);
    }
  });

  it("lowercase .env, .env.local and .env.example behavior is unchanged", async () => {
    for (const [i, name] of [".env", ".env.local"].entries()) {
      const rel = fixture(`l${i}`, name, `API_KEY=${SECRET}\n`);
      const rf = await readFileTool().execute({ path: rel });
      expect(rf.redacted, name).toBe(true);
      expect(JSON.stringify(rf), name).not.toContain(SECRET);
      expect(await shortCircuit(rel), name).toBeNull();
    }
    const ex = fixture("l2", ".env.example", EXEMPT_BODY);
    const rf = await readFileTool().execute({ path: ex });
    expect(rf.redacted).toBeFalsy();
    expect(JSON.stringify(rf)).toContain("your-key-here");
    expect(await shortCircuit(ex)).toMatchObject({ ok: true, answer: EXEMPT_BODY });
  });
});
