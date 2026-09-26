/**
 * Tests for backlog.fix.arch-verdict-handler-write-integrity.
 *
 * Three defects in the rks_arch_verdict handler, all shipped in be164150:
 *
 *  1. Six sequential frontmatter writes with no try/catch. A mid-sequence failure
 *     left the note holding a state the monotone ledger forbids, with no rollback.
 *  2. `Number(before.arch_round || 0)` turned a corrupt arch_round into NaN, which
 *     fell back to 0 — silently restarting the round counter and re-freezing the
 *     ledger, discarding the recorded round.
 *  3. The result object handed to commitDendronWriteResult carried no `path`, so
 *     `path.join(notesDir, undefined)` threw and the verdict was written but never
 *     committed. Observed three times in production ARCH runs.
 *
 * EVIDENCE IS TAKEN FROM GIT AND FROM DISK, NOT FROM THE RESPONSE ENVELOPE.
 * commitDendronWriteResult's catch hardcodes `writeOk: true` (server.mjs:562) —
 * which is exactly why defect 3 reported a successful write while failing. A
 * witness that trusted `writeOk` would have been green throughout.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTempDir, initGitRepo } from "../helpers/tmp.mjs";

const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
let root;

const STORY = "backlog.feat.write-integrity-fixture";
const BODY = "\n## Problem\n\nA body with a multi-byte dash — and two paragraphs.\n\n## Solution\n\nSecond paragraph.\n";

function notePath() {
  return path.join(root, "notes", `${STORY}.md`);
}

function git(...args) {
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  return res.stdout;
}

/** Writes the fixture note. `arch_round` is emitted RAW so non-scalar shapes are representable. */
function writeStory({ archRoundYaml = null, extra = "" } = {}) {
  const lines = [
    "---",
    `id: "${STORY}"`,
    'title: "Fixture"',
    "created: 1",
    "updated: 2",
    'phase: "ready"',
  ];
  if (archRoundYaml !== null) lines.push(archRoundYaml);
  if (extra) lines.push(extra);
  lines.push("---");
  fs.writeFileSync(notePath(), `${lines.join("\n")}\n${BODY}`);
}

/** Everything after the closing frontmatter delimiter — the markdown body. */
function readBody() {
  const raw = fs.readFileSync(notePath(), "utf8");
  const end = raw.indexOf("\n---", raw.indexOf("---") + 3);
  return raw.slice(raw.indexOf("\n", end + 1));
}

function readFm() {
  const raw = fs.readFileSync(notePath(), "utf8");
  const fm = {};
  let listKey = null;
  for (const line of raw.split("\n").slice(1)) {
    if (line.trim() === "---") break;
    // List items belong to the key above them. Without this the parser returned "" for
    // EVERY list-valued field — so an assertion on one would have compared "" against the
    // expected list and could only be made to pass by weakening it. arch_ledger,
    // arch_deferred and arch_round_findings are all lists.
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      fm[listKey].push(item[1].trim().replace(/^"|"$/g, ""));
      continue;
    }
    const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (m) {
      listKey = null;
      if (m[2] === "") {
        // A key with nothing after the colon opens a block list.
        listKey = m[1];
        fm[m[1]] = [];
      } else {
        fm[m[1]] = m[2].replace(/^"|"$/g, "");
      }
    }
  }
  return fm;
}

async function callVerdict(args) {
  const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const r = await client.callTool({ name: "rks_arch_verdict", arguments: args });
    return JSON.parse(r?.content?.[0]?.text ?? "{}");
  } finally {
    await client.close();
  }
}

const F = (item, file) => ({ item, file, detail: "d" });

beforeAll(() => {
  root = makeTempDir("arch-verdict-write-integrity");
  initGitRepo(root);
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  process.env.ROUTEKIT_PROJECT_ROOT = root;
});

afterAll(() => {
  if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
  else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

beforeEach(() => {
  writeStory();
  git("add", "-A");
  git("commit", "-m", "fixture", "--allow-empty");
});

describe("defect 2 — a corrupt arch_round is refused, not coerced", () => {
  it.each([
    ["non-numeric string", 'arch_round: "abc"'],
    ["array", "arch_round:\n  - 1\n  - 2"],
    ["object", "arch_round:\n  a: 1"],
    ["boolean", "arch_round: true"],
  ])("refuses a %s arch_round, naming the field and its raw value", async (_label, yaml) => {
    writeStory({ archRoundYaml: yaml });
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [], skipCommit: true });

    expect(res.ok).toBe(false);
    expect(res.error).toBe("invalid_arch_round");
    expect(res.field).toBe("arch_round");
    expect(res).toHaveProperty("value");
  });

  it("writes NOTHING on refusal — the note is byte-identical", async () => {
    writeStory({ archRoundYaml: 'arch_round: "abc"' });
    const before = fs.readFileSync(notePath(), "utf8");
    await callVerdict({ projectId: "p", storyId: STORY, findings: [], skipCommit: true });
    expect(fs.readFileSync(notePath(), "utf8")).toBe(before);
  });

  it.each([
    ["absent", null],
    ["null", "arch_round: null"],
    ["empty string", 'arch_round: ""'],
  ])("treats an %s arch_round as round 0 and proceeds", async (_label, yaml) => {
    writeStory({ archRoundYaml: yaml });
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [], skipCommit: true });
    expect(res.ok).toBe(true);
    expect(res.round).toBe(1);
  });

  it.each([
    ['"0"', 'arch_round: "0"', 1],
    ['"2"', 'arch_round: "2"', 3],
  ])("accepts arch_round %s and advances the round", async (_label, yaml, expectedRound) => {
    writeStory({ archRoundYaml: yaml });
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [], skipCommit: true });
    expect(res.ok).toBe(true);
    expect(res.round).toBe(expectedRound);
  });
});

describe("defect 1 — one write, and the body survives it", () => {
  // The regression that would have shipped: formatWithFrontmatter writes only what
  // it is handed, and the handler's read discarded .content. A body-destroying
  // write passes every other assertion in this suite.
  it("leaves the markdown body byte-identical after a successful call", async () => {
    const bodyBefore = readBody();
    expect(bodyBefore.trim().length).toBeGreaterThan(0);

    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")], skipCommit: true });
    expect(res.ok).toBe(true);

    const bodyAfter = readBody();
    expect(bodyAfter).toBe(bodyBefore);
    expect(bodyAfter.trim().length).toBeGreaterThan(0);
  });

  it("advances updated", async () => {
    const before = Number(readFm().updated);
    await callVerdict({ projectId: "p", storyId: STORY, findings: [], skipCommit: true });
    expect(Number(readFm().updated)).toBeGreaterThan(before);
  });

  it("applies every arch field in one pass — verdict, ledger, subject and cumulative cost agree on disk", async () => {
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")], skipCommit: true });
    const fm = readFm();
    // A partial write is exactly a disagreement between these.
    expect(fm.arch_verdict).toBe("needs-revision");
    expect(fm.arch_findings_count).toBe("1");
    expect(fm.arch_round).toBe("1");
    expect(fm.phase).toBe("ready");
    // arch_subject joined the coalesced write in backlog.fix.arch-ledger-subject-rebinding.
    expect(fm.arch_subject).toMatch(/^[0-9a-f]{32}$/);
    // The cumulative fields joined the SAME coalesced write. Re-checking the single-pass
    // property rather than only bumping the number in the title: a partial write is a
    // disagreement between these, and adding fields is exactly when that regresses.
    expect(fm.arch_total_rounds).toBe("1");
    expect(fm.arch_round_findings).toEqual(["1"]);
    expect(res.verdict).toBe(fm.arch_verdict);
    expect(res.totalRounds).toBe(1);
  });

  it("retains the read-back verification — reported values match disk", async () => {
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [], skipCommit: true });
    const fm = readFm();
    expect(res.verdict).toBe(fm.arch_verdict);
    expect(res.phase).toBe(fm.phase);
    expect(String(res.findingsCount)).toBe(fm.arch_findings_count);
  });
});

describe("defect 3 — the verdict is committed, not merely written", () => {
  it("returns commitOk with a commitId and no commitError", async () => {
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });

    expect(res.commitError).toBeUndefined();
    expect(res.commitOk).toBe(true);
    expect(res.commitId).toBeTruthy();
  });

  it("leaves the note clean in git status and the verdict present at HEAD", async () => {
    await callVerdict({ projectId: "p", storyId: STORY, findings: [] });

    // Evidence from git, not from the envelope — writeOk is hardcoded true in the
    // helper's catch, so it cannot witness this.
    expect(git("status", "--porcelain", `notes/${STORY}.md`).trim()).toBe("");
    expect(git("show", `HEAD:notes/${STORY}.md`)).toContain('arch_verdict: "approved"');
  });

  it("commits exactly the story note — indirect witness that `path` is populated", async () => {
    await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    const files = git("show", "--name-only", "--format=", "HEAD").trim().split("\n").filter(Boolean);
    expect(files).toEqual([`notes/${STORY}.md`]);
  });

  it("names the story in the commit subject — indirect witness that `id` is populated", async () => {
    await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    const subject = git("show", "--format=%s", "--no-patch", "HEAD").trim();
    // buildDendronCommitMessage derives scope from the id prefix and falls back to
    // `notes` with an empty id when innerResult.id is undefined.
    expect(subject).toContain("backlog");
    expect(subject).toContain(STORY);
  });

  it("still short-circuits on skipCommit, leaving HEAD untouched", async () => {
    const head = git("rev-parse", "HEAD").trim();
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [], skipCommit: true });

    expect(res.commitOk).toBe(false);
    expect(res.skipCommit).toBe(true);
    expect(git("rev-parse", "HEAD").trim()).toBe(head);
  });
});

// ── backlog.fix.arch-guidance-write-self-rebases-ledger ──────────────────────
//
// SETTLED BY OBSERVATION, and the observation was POSITIVE. The story asked whether
// formatWithFrontmatter's leading-whitespace strip (shared/frontmatter.mjs
// `replace(/^\s+/, "")`) also destabilises the digest on this write path, separately
// from the guidance write. It does: a body authored with two leading newlines came
// back with one, so the arch_subject just recorded was a digest of a document that no
// longer existed on disk, and the NEXT call rebased even with no guidance write at all.
//
// This is a SECOND, independent rebase source on the same write path. Excluding the
// guidance section from the digest does not close it — the bytes on either side of the
// write still differ. The handler now re-serialises the frontmatter and rejoins the
// body VERBATIM via the byte-stable splitNoteFrontmatter / joinNoteFrontmatter pair
// that backlog.fix.refine-apply-note-newline-growth-false-unchanged already landed,
// rather than adding a second such pair.
//
// The fixture body deliberately carries leading whitespace. A body of exactly one
// leading newline is already a fixed point under the strip, so it cannot witness this.

const WHITESPACE_BODY = "\n\n\n## Problem\n\nAuthored with three leading newlines.\n\n## Solution\n\nSecond.\n";

function writeWhitespaceStory() {
  fs.writeFileSync(
    notePath(),
    `---\nid: "${STORY}"\ntitle: "Fixture"\ncreated: 1\nupdated: 2\nphase: "ready"\n---${WHITESPACE_BODY}`,
  );
}

describe("the verdict write is body-byte-stable", () => {
  beforeEach(() => writeWhitespaceStory());

  it("leaves the authored body bytes untouched across a recorded verdict", async () => {
    const before = readBody();
    expect(before).toContain("\n\n\n## Problem");

    await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")], skipCommit: true });

    // Evidence from disk, not from the envelope.
    expect(readBody()).toBe(before);
  });

  it("does not rebase on a second call with NO intervening edit of any kind", async () => {
    // The composition-level consequence. Before the fix this returned rebased: true —
    // caused by the writer, not by ARCH, and not closed by the guidance exclusion.
    const first = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")], skipCommit: true });
    expect(first.round).toBe(1);
    const subjectAfterFirst = readFm().arch_subject;

    const second = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")], skipCommit: true });
    expect(second.rebased).toBe(false);
    expect(second.round).toBe(2);
    expect(readFm().arch_subject).toBe(subjectAfterFirst);
  });

  it("still writes every arch field — byte stability did not cost the coalesced write", async () => {
    await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")], skipCommit: true });
    const fm = readFm();
    expect(fm.arch_verdict).toBe("needs-revision");
    expect(fm.arch_round).toBe("1");
    expect(fm.arch_subject).toMatch(/^[0-9a-f]{32}$/);
    expect(fm.arch_total_rounds).toBe("1");
  });

  it("keeps the note parseable — the rejoined frontmatter fence is well formed", async () => {
    await callVerdict({ projectId: "p", storyId: STORY, findings: [], skipCommit: true });
    const raw = fs.readFileSync(notePath(), "utf8");
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw.match(/^---\n[\s\S]*?\n---/)).toBeTruthy();
    expect(raw).toContain('arch_verdict: "approved"');
    expect(raw).toContain("## Solution");
  });
});
