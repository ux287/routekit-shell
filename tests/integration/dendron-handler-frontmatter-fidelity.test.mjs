/**
 * backlog.fix.dendron-update-field-rewrites-untouched-frontmatter (ARCH round-2 amendment)
 *
 * dendron_edit_note, dendron_mark_implemented and rks_arch_verdict build and write
 * frontmatter inline in server.mjs instead of calling the dendron.mjs library writers.
 * Each is driven here through the REAL server (createServer over InMemoryTransport,
 * skipCommit: true) against a temp project root, and the note is re-read from disk.
 * Evidence is taken from disk, never from the response envelope.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTempDir, writeFile } from "../helpers/tmp.mjs";
import { parseFrontmatter } from "../../packages/mcp-rks/src/dendron.mjs";

const STORY = "backlog.fix.probe";
const ORIGINAL_LINES = [
  "id: backlog.fix.probe",
  "title: Probe story",
  "status: draft",
  "retrieved: 2026-09-29",
  'quoted: "already quoted"',
  "created: 1790709875399",
  "updated: 1790709893251",
  "phase: draft",
];
const BODY = "\n## Problem\n\nBody text.\n\n## Solution\n\nSecond paragraph.\n";
const RAW = `---\n${ORIGINAL_LINES.join("\n")}\n---\n${BODY}`;

function frontmatterLines(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error("no frontmatter block on disk");
  return m[1].split("\n");
}

function afterFence(raw) {
  const m = raw.match(/^---\n[\s\S]*?\n---/);
  if (!m) throw new Error("no frontmatter block");
  return raw.slice(m[0].length);
}

function expectLinesInOrder(after, expected) {
  const lines = frontmatterLines(after);
  let cursor = -1;
  for (const line of expected) {
    const at = lines.indexOf(line);
    expect(at, `untouched line lost or rewritten: ${line}`).toBeGreaterThan(-1);
    expect(at, `untouched line reordered: ${line}`).toBeGreaterThan(cursor);
    cursor = at;
  }
}

const except = (...keys) => ORIGINAL_LINES.filter((l) => !keys.some((k) => l.startsWith(`${k}:`)));

async function callTool(name, args) {
  const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const r = await client.callTool({ name, arguments: { skipCommit: true, ...args } });
    return JSON.parse(r?.content?.[0]?.text ?? "{}");
  } finally {
    await client.close();
  }
}

describe("MCP frontmatter writers leave untouched frontmatter byte-identical", () => {
  const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
  let savedTz;
  let root;
  let notePath;

  beforeEach(() => {
    savedTz = process.env.TZ;
    process.env.TZ = "America/Denver";
    root = makeTempDir("dendron_handler_fm_fidelity");
    fs.mkdirSync(path.join(root, "notes"), { recursive: true });
    process.env.ROUTEKIT_PROJECT_ROOT = root;
    notePath = path.join(root, "notes", `${STORY}.md`);
    writeFile(notePath, RAW);
  });

  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
    if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
    else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("positive control: the pinned zone is west of UTC, so Date.toString() shifts the day", () => {
    expect(String(new Date("2026-09-29"))).toContain("Sep 28 2026");
  });

  it("dendron_edit_note keeps every frontmatter line except updated: byte-identical and emits today's body form", async () => {
    const res = await callTool("dendron_edit_note", {
      filename: STORY,
      patches: [{ search: "Body text.", replace: "Patched text." }],
    });
    expect(res.ok).toBe(true);
    const after = fs.readFileSync(notePath, "utf8");
    expectLinesInOrder(after, except("updated"));
    expect(frontmatterLines(after)).toContain("retrieved: 2026-09-29");
    expect(frontmatterLines(after)).toContain("title: Probe story");
    expect(frontmatterLines(after)).toContain('quoted: "already quoted"');
    expect(after).not.toMatch(/GMT/);
    // today's emitted body form: closing fence, one blank line, patched body with leading whitespace stripped
    expect(afterFence(after)).toBe("\n\n## Problem\n\nPatched text.\n\n## Solution\n\nSecond paragraph.\n");
    const data = parseFrontmatter(after).data;
    expect(typeof data.updated).toBe("number");
    expect(data.updated).not.toBe(1790709893251);
  });

  it("dendron_edit_note on a note with no id key adds an id: line and keeps every other line byte-identical", async () => {
    const noIdLines = except("id");
    writeFile(notePath, `---\n${noIdLines.join("\n")}\n---\n${BODY}`);
    const res = await callTool("dendron_edit_note", {
      filename: STORY,
      patches: [{ search: "Body text.", replace: "Patched text." }],
    });
    expect(res.ok).toBe(true);
    const after = fs.readFileSync(notePath, "utf8");
    expect(frontmatterLines(after).some((l) => l.startsWith("id:"))).toBe(true);
    expect(parseFrontmatter(after).data.id).toBe(STORY);
    expectLinesInOrder(after, noIdLines.filter((l) => !l.startsWith("updated:")));
  });

  it("dendron_mark_implemented moves the note, changes only id/status/updated/commitId, and carries the body byte-for-byte", async () => {
    const res = await callTool("dendron_mark_implemented", { filename: STORY, commitId: "abc1234" });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(notePath)).toBe(false);
    const movedPath = path.join(root, "notes", "backlog.z_implemented.fix.probe.md");
    expect(fs.existsSync(movedPath)).toBe(true);
    const after = fs.readFileSync(movedPath, "utf8");
    expectLinesInOrder(after, except("id", "status", "updated", "commitId"));
    expect(frontmatterLines(after)).toContain("retrieved: 2026-09-29");
    expect(after).not.toMatch(/GMT/);
    const data = parseFrontmatter(after).data;
    expect(data.id).toBe("backlog.z_implemented.fix.probe");
    expect(data.status).toBe("implemented");
    expect(data.commitId).toBe("abc1234");
    expect(afterFence(after)).toBe(afterFence(RAW));
  });

  it("rks_arch_verdict (approved) changes only updated:, the arch_* lines and phase:, and leaves the body byte-identical", async () => {
    const res = await callTool("rks_arch_verdict", { projectId: "p", storyId: STORY, findings: [] });
    expect(res.ok).toBe(true);
    expect(res.verdict).toBe("approved");
    const after = fs.readFileSync(notePath, "utf8");
    expectLinesInOrder(after, except("updated", "phase"));
    expect(frontmatterLines(after)).toContain("retrieved: 2026-09-29");
    expect(frontmatterLines(after)).toContain("title: Probe story");
    expect(after).not.toMatch(/GMT/);
    // the written arch_* lines keep their current emitted form
    expect(frontmatterLines(after)).toContain('arch_verdict: "approved"');
    expect(parseFrontmatter(after).data.phase).toBe("arch-approved");
    expect(afterFence(after)).toBe(afterFence(RAW));
  });

  it("rks_arch_verdict (needs-revision) leaves phase: and every other non-arch line byte-identical", async () => {
    const res = await callTool("rks_arch_verdict", {
      projectId: "p",
      storyId: STORY,
      findings: [{ item: 1, file: "a.mjs", detail: "d" }],
    });
    expect(res.ok).toBe(true);
    expect(res.verdict).toBe("needs-revision");
    const after = fs.readFileSync(notePath, "utf8");
    expectLinesInOrder(after, except("updated"));
    expect(frontmatterLines(after)).toContain("phase: draft");
    expect(after).not.toMatch(/GMT/);
    expect(afterFence(after)).toBe(afterFence(RAW));
  });
});
