/**
 * Tests for backlog.fix.arch-cross-story-finding-batch-identity.
 *
 * A cross-story (Item 11) finding names the sibling it concerns through an optional
 * relatedStoryId. Identity stays { item, file }; the relation lands in the handler-owned
 * ADVISORY field arch_finding_relations and is reported from the read-back, never from
 * intent. Boots the real server over an InMemoryTransport, as arch-verdict-tool.test.mjs
 * does, and re-reads the note off disk.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTempDir } from "../helpers/tmp.mjs";
import { parseFrontmatter, updateField, ARCH_RESERVED_FIELDS } from "../../packages/mcp-rks/src/dendron.mjs";
import { ARCH_MAX_ROUNDS, findingKey, noteSubjectDigest } from "../../packages/mcp-rks/src/workflow/arch-verdict.mjs";

// Same seam as arch-verdict-write-integrity.test.mjs: wrap the splice so a test can make
// the landed arch_finding_relations differ from the written one.
const spliceControl = vi.hoisted(() => ({ tamperRelations: false }));
vi.mock("../../packages/mcp-rks/src/shared/frontmatter.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spliceNoteFrontmatter: (raw, updates, ...rest) => {
      if (spliceControl.tamperRelations && updates && Object.prototype.hasOwnProperty.call(updates, "arch_finding_relations")) {
        return actual.spliceNoteFrontmatter(raw, { ...updates, arch_finding_relations: ["item-0-tampered=backlog.feat.tampered"] }, ...rest);
      }
      return actual.spliceNoteFrontmatter(raw, updates, ...rest);
    },
  };
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STORY = "backlog.feat.fixture-relations";
const SIB_B = "backlog.feat.sibling-b";
const SIB_C = "backlog.feat.sibling-c";
const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
let root;

const notePath = () => path.join(root, "notes", `${STORY}.md`);

function writeStory(extraFm = {}) {
  const fm = { id: STORY, title: "Fixture", created: 1, updated: 2, phase: "ready", ...extraFm };
  const lines = Object.entries(fm).map(([k, v]) =>
    Array.isArray(v)
      ? v.length === 0
        ? `${k}: []`
        : `${k}:\n${v.map((x) => `  - ${JSON.stringify(x)}`).join("\n")}`
      : `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`,
  );
  fs.writeFileSync(notePath(), `---\n${lines.join("\n")}\n---\n\n## Problem\nbody\n`);
}

const readParsed = () => parseFrontmatter(fs.readFileSync(notePath(), "utf8"));
const readFm = () => readParsed().data;
const asList = (v) => (Array.isArray(v) ? v.map(String) : []);

async function withClient(fn) {
  const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const callVerdict = (args) =>
  withClient(async (client) => {
    const r = await client.callTool({
      name: "rks_arch_verdict",
      arguments: { skipCommit: true, projectId: "p", storyId: STORY, ...args },
    });
    return JSON.parse(r?.content?.[0]?.text ?? "{}");
  });

const listArchVerdictTool = () =>
  withClient(async (client) => (await client.listTools()).tools.find((t) => t.name === "rks_arch_verdict"));

const F = (item, file, relatedStoryId) =>
  relatedStoryId === undefined ? { item, file, detail: "d" } : { item, file, detail: "d", relatedStoryId };
const rel = (item, file, storyId) => `${findingKey({ item, file })}=${storyId}`;

beforeAll(() => {
  root = makeTempDir("arch-verdict-finding-relations");
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  process.env.ROUTEKIT_PROJECT_ROOT = root;
});

afterAll(() => {
  if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
  else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

beforeEach(() => writeStory());
afterEach(() => { spliceControl.tamperRelations = false; });

describe("rks_arch_verdict — relatedStoryId input", () => {
  it("advertises findings[].relatedStoryId as an optional string", async () => {
    const tool = await listArchVerdictTool();
    const items = tool.inputSchema.properties.findings.items;
    expect(items.properties.relatedStoryId.type).toBe("string");
    expect(items.required ?? []).not.toContain("relatedStoryId");
  });

  it("the zod schema keeps relatedStoryId, still accepts a finding without it, and rejects a non-string", async () => {
    const { TOOL_ARG_SCHEMAS } = await import("../../packages/mcp-rks/src/server.mjs");
    const schema = TOOL_ARG_SCHEMAS["rks_arch_verdict"];
    const withRel = schema.safeParse({ projectId: "p", storyId: "s", findings: [F(11, "a.mjs", SIB_B)] });
    expect(withRel.success).toBe(true);
    expect(withRel.data.findings[0].relatedStoryId).toBe(SIB_B);
    expect(schema.safeParse({ projectId: "p", storyId: "s", findings: [F(11, "a.mjs")] }).success).toBe(true);
    expect(schema.safeParse({ projectId: "p", storyId: "s", findings: [{ item: 11, file: "a.mjs", relatedStoryId: 5 }] }).success).toBe(false);
  });

  it("findingKey ignores relatedStoryId", () => {
    expect(findingKey({ item: 11, file: "a.mjs", relatedStoryId: SIB_B })).toBe(findingKey({ item: 11, file: "a.mjs" }));
  });
});

describe("rks_arch_verdict — arch_finding_relations", () => {
  it("writes one <key>=<storyId> entry per distinct pair", async () => {
    await callVerdict({ findings: [F(11, "a.mjs", SIB_B), F(11, "a.mjs", SIB_B), F(4, "b.mjs", SIB_C)] });
    expect(asList(readFm().arch_finding_relations).sort()).toEqual([rel(11, "a.mjs", SIB_B), rel(4, "b.mjs", SIB_C)].sort());
  });

  it("two findings on the same { item, file } with different siblings give one ledger key and two relations", async () => {
    await callVerdict({ findings: [F(11, "a.mjs", SIB_B), F(11, "a.mjs", SIB_C)] });
    const fm = readFm();
    expect(asList(fm.arch_ledger)).toEqual([findingKey({ item: 11, file: "a.mjs" })]);
    expect(asList(fm.arch_finding_relations).sort()).toEqual([rel(11, "a.mjs", SIB_B), rel(11, "a.mjs", SIB_C)].sort());
  });

  it("every relation names a key in this round's ledger or deferred set", async () => {
    writeStory({ arch_round: "1", arch_ledger: [findingKey({ item: 11, file: "a.mjs" })] });
    await callVerdict({ findings: [F(11, "a.mjs", SIB_B), F(9, "z.mjs", SIB_C)] });
    const fm = readFm();
    const keys = new Set([...asList(fm.arch_ledger), ...asList(fm.arch_deferred)]);
    const relations = asList(fm.arch_finding_relations);
    expect(relations).toHaveLength(2);
    for (const entry of relations) expect(keys.has(entry.split("=")[0]), entry).toBe(true);
  });

  it("a submission with no relatedStoryId writes an empty arch_finding_relations", async () => {
    await callVerdict({ findings: [F(11, "a.mjs"), F(4, "b.mjs")] });
    expect(asList(readFm().arch_finding_relations)).toEqual([]);
  });

  it("relations are recomputed each round; a prior round's entries are not carried forward", async () => {
    await callVerdict({ findings: [F(11, "a.mjs", SIB_B)] });
    expect(asList(readFm().arch_finding_relations)).toEqual([rel(11, "a.mjs", SIB_B)]);
    await callVerdict({ findings: [F(11, "a.mjs")] });
    expect(asList(readFm().arch_finding_relations)).toEqual([]);
  });
});

describe("rks_arch_verdict — relatedStoryId never changes the verdict", () => {
  const SCENARIOS = [
    ["round 1", {}, [[11, "a.mjs", SIB_B], [4, "b.mjs", SIB_C]]],
    ["round 2, one re-raised and one new", { arch_round: "1", arch_ledger: [findingKey({ item: 11, file: "a.mjs" })] }, [[11, "a.mjs", SIB_B], [9, "z.mjs", SIB_C]]],
    ["at the round cap", { arch_round: String(ARCH_MAX_ROUNDS - 1), arch_ledger: [findingKey({ item: 11, file: "a.mjs" })] }, [[11, "a.mjs", SIB_B]]],
  ];

  const run = async (fixture, specs, withRelations) => {
    writeStory(fixture);
    const res = await callVerdict({ findings: specs.map(([i, f, s]) => F(i, f, withRelations ? s : undefined)) });
    const fm = readFm();
    return {
      res: { ok: res.ok, verdict: res.verdict, round: res.round, blocking: res.blocking, deferred: res.deferred, findingsCount: res.findingsCount, phase: res.phase, capped: res.capped, rebased: res.rebased },
      disk: {
        arch_verdict: fm.arch_verdict, arch_round: String(fm.arch_round), arch_ledger: asList(fm.arch_ledger), arch_deferred: asList(fm.arch_deferred),
        arch_findings_count: String(fm.arch_findings_count), arch_subject: fm.arch_subject, arch_total_rounds: String(fm.arch_total_rounds),
        arch_round_findings: asList(fm.arch_round_findings), phase: fm.phase,
      },
    };
  };

  it.each(SCENARIOS)("verdict, round, ledger, deferred, cap, phase and arch_subject are identical with and without relatedStoryId (%s)", async (_label, fixture, specs) => {
    const withRel = await run(fixture, specs, true);
    const without = await run(fixture, specs, false);
    expect(withRel.res.ok).toBe(true);
    expect(withRel).toEqual(without);
  });
});

describe("rks_arch_verdict — relations are reported from the read-back", () => {
  it("response relations equals arch_finding_relations read back off disk", async () => {
    const res = await callVerdict({ findings: [F(11, "a.mjs", SIB_B), F(4, "b.mjs", SIB_C)] });
    expect(res.ok).toBe(true);
    expect(res.relations).toEqual(asList(readFm().arch_finding_relations));
    expect([...res.relations].sort()).toEqual([rel(11, "a.mjs", SIB_B), rel(4, "b.mjs", SIB_C)].sort());
  });

  it("a landed value differing from the written one returns read_back_mismatch naming arch_finding_relations", async () => {
    spliceControl.tamperRelations = true;
    const res = await callVerdict({ findings: [F(11, "a.mjs", SIB_B)] });
    expect(res.error).toBe("read_back_mismatch");
    expect(res.mismatches).toContain("arch_finding_relations");
  });
});

describe("rks_arch_verdict — arch_finding_relations is reserved and outside the subject", () => {
  it("ARCH_RESERVED_FIELDS holds it and updateField refuses a direct write naming rks_arch_verdict", () => {
    expect(ARCH_RESERVED_FIELDS.has("arch_finding_relations")).toBe(true);
    expect(() => updateField(path.join(root, "notes"), `${STORY}.md`, "arch_finding_relations", "x")).toThrow(/rks_arch_verdict/);
    expect(() => updateField(path.join(root, "notes"), `${STORY}.md`, "arch_finding_relations", "x")).toThrow(/arch_finding_relations/);
  });

  it("noteSubjectDigest ignores arch_finding_relations, and a follow-up verdict is not rebased", async () => {
    const base = noteSubjectDigest(readParsed());
    writeStory({ arch_finding_relations: [rel(11, "a.mjs", SIB_B)] });
    expect(noteSubjectDigest(readParsed())).toBe(base);

    writeStory();
    await callVerdict({ findings: [F(11, "a.mjs", SIB_B)] });
    expect(readFm().arch_subject).toBe(base);
    const second = await callVerdict({ findings: [F(11, "a.mjs", SIB_C)] });
    expect(second.rebased).toBe(false);
    expect(second.round).toBe(2);
  });

  it("the tool description lists arch_finding_relations as handler-written and ADVISORY", async () => {
    const { description } = await listArchVerdictTool();
    expect(description).toMatch(/only permitted writer of [^.]*arch_finding_relations/);
    expect(description).toMatch(/arch_finding_relations[^.]* ADVISORY/);
  });
});

describe("governor-arch.md — Item 11 records the sibling", () => {
  it("Item 11 instructs passing relatedStoryId and raising the mirror finding on the sibling", () => {
    const prompt = fs.readFileSync(path.join(REPO_ROOT, ".rks/prompts/governor-arch.md"), "utf8");
    const start = prompt.indexOf("**Item 11 — Cross-story contradiction check**");
    expect(start).toBeGreaterThan(-1);
    const rest = prompt.slice(start + 2);
    const ends = [rest.indexOf("**Item 12"), rest.search(/\n## /)].filter((i) => i >= 0);
    const section = ends.length ? rest.slice(0, Math.min(...ends)) : rest;
    expect(section).toContain("relatedStoryId");
    expect(section).toMatch(/mirror finding/i);
  });
});
