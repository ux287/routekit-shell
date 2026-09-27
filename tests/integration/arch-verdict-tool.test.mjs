/**
 * Tests for backlog.feat.arch-verdict-monotone-ledger — the rks_arch_verdict handler.
 *
 * ASSERTS ON WHAT THE CALLER RECEIVES AND WHAT LANDS ON DISK. Every case boots the
 * real server with createServer() over an InMemoryTransport and reads the emitted MCP
 * text block, then re-reads the note off disk. The pure computation is covered
 * separately in tests/unit/workflow/arch-verdict.spec.mjs; the defect this file
 * guards is in the wiring — whether the verdict actually reaches the note, whether
 * the phase advances only on approval, and whether the response is sourced from a
 * read-back rather than from intent.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTempDir } from "../helpers/tmp.mjs";
import { parseFrontmatter } from "../../packages/mcp-rks/src/dendron.mjs";
import { ARCH_MAX_ROUNDS, findingKey } from "../../packages/mcp-rks/src/workflow/arch-verdict.mjs";

const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
let root;

const STORY = "backlog.feat.fixture-story";

function writeStory(extraFm = {}) {
  const fm = { id: STORY, title: "Fixture", created: 1, updated: 2, phase: "ready", ...extraFm };
  const lines = Object.entries(fm).map(([k, v]) =>
    Array.isArray(v)
      ? v.length === 0
        ? `${k}: []`
        : `${k}:\n${v.map((x) => `  - ${JSON.stringify(x)}`).join("\n")}`
      : `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`,
  );
  fs.writeFileSync(path.join(root, "notes", `${STORY}.md`), `---\n${lines.join("\n")}\n---\n\n## Problem\nbody\n`);
}

function readFm() {
  return parseFrontmatter(fs.readFileSync(path.join(root, "notes", `${STORY}.md`), "utf8")).data;
}

async function callVerdict(args) {
  const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const r = await client.callTool({ name: "rks_arch_verdict", arguments: { skipCommit: true, ...args } });
    return JSON.parse(r?.content?.[0]?.text ?? "{}");
  } finally {
    await client.close();
  }
}

async function listArchVerdictTool() {
  const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const { tools } = await client.listTools();
    return tools.find((t) => t.name === "rks_arch_verdict");
  } finally {
    await client.close();
  }
}

const F = (item, file, detail = "d") => ({ item, file, detail });

beforeAll(() => {
  root = makeTempDir("arch-verdict-tool");
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  process.env.ROUTEKIT_PROJECT_ROOT = root;
});

afterAll(() => {
  if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
  else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

beforeEach(() => writeStory());

describe("rks_arch_verdict — registration", () => {
  it("is advertised with the documented input shape", async () => {
    const tool = await listArchVerdictTool();
    expect(tool).toBeTruthy();
    // TRIPWIRE — backlog.fix.arch-no-cumulative-round-bound-across-rebases.
    //
    // This was `arrayContaining` on BOTH assertions. arrayContaining is a SUPERSET matcher,
    // so adding an input left it green: the "do not add tool inputs" invariant it was
    // credited with guarding was in fact unguarded. It is now an EXACT set.
    //
    // The asymmetry that justifies the brittleness: a false red costs one deliberate
    // decision and one line; a false green silently reopens a channel by which a CALLER
    // could influence a verdict this module exists to DERIVE.
    //
    // Do NOT substitute another arrayContaining. Do NOT pin the exported
    // INPUT_SCHEMA.properties to three names instead — server.mjs imports INPUT_SCHEMA
    // under an alias, assigns it by reference, and mutates it in place to inject
    // _governorToken, so the exported object and the advertised object are ONE module
    // singleton. A three-name pin is ungreenable, and tier-dependent: vitest.config.unit
    // sets isolate:true, the fallback tier that `npm test` runs does not.
    //
    // This tripwire fires ONCE. The standing guard is the forbidden-name list below.
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(
      ["_governorToken", "findings", "projectId", "storyId"],
    );
    expect([...tool.inputSchema.required].sort()).toEqual(["findings", "projectId", "storyId"]);
  });

  it("is a PROTECTED tool — _governorToken is injected into its schema", async () => {
    const tool = await listArchVerdictTool();
    expect(tool.inputSchema.properties).toHaveProperty("_governorToken");
  });

  it("types findings[].item as a number, so the derived key format is a parse-time guarantee", async () => {
    const tool = await listArchVerdictTool();
    expect(tool.inputSchema.properties.findings.items.properties.item.type).toBe("number");
  });
});

describe("rks_arch_verdict — round 1 records the verdict on the note", () => {
  it("writes needs-revision and does NOT advance the phase", async () => {
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs"), F(2, "b.mjs")] });
    expect(res.ok).toBe(true);
    expect(res.verdict).toBe("needs-revision");

    const fm = readFm();
    expect(fm.arch_verdict).toBe("needs-revision");
    expect(String(fm.arch_findings_count)).toBe("2");
    expect(String(fm.arch_round)).toBe("1");
    expect(fm.arch_ledger).toHaveLength(2);
    expect(fm.phase).toBe("ready");
  });

  it("writes approved and advances the phase when nothing is submitted", async () => {
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(res.verdict).toBe("approved");

    const fm = readFm();
    expect(fm.arch_verdict).toBe("approved");
    expect(fm.phase).toBe("arch-approved");
    expect(String(fm.arch_findings_count)).toBe("0");
  });

  it("derives ledger keys from { item, file } — a caller-supplied key is ignored", async () => {
    await callVerdict({
      projectId: "p",
      storyId: STORY,
      findings: [{ item: 1, file: "a.mjs", detail: "d", key: "forged-key" }],
    });
    const fm = readFm();
    expect(fm.arch_ledger).toEqual([findingKey({ item: 1, file: "a.mjs" })]);
    expect(fm.arch_ledger).not.toContain("forged-key");
  });
});

describe("rks_arch_verdict — round 2 may only shrink", () => {
  it("defers a finding first raised in round 2 and approves", async () => {
    writeStory({ arch_round: "1", arch_ledger: [findingKey(F(1, "a.mjs"))] });
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(9, "z.mjs")] });

    expect(res.verdict).toBe("approved");
    const fm = readFm();
    expect(fm.arch_deferred).toEqual([findingKey(F(9, "z.mjs"))]);
    expect(fm.arch_ledger).toEqual([]);
    expect(fm.phase).toBe("arch-approved");
  });

  // The reproduction: round 2 previously returned a wholly disjoint finding set and
  // blocked on it. Under the ledger that set is recorded but cannot block.
  it("cannot block on a wholly disjoint round-2 set", async () => {
    writeStory({ arch_round: "1", arch_ledger: [findingKey(F(1, "a.mjs")), findingKey(F(2, "b.mjs"))] });
    const res = await callVerdict({
      projectId: "p",
      storyId: STORY,
      findings: [F(7, "x.mjs"), F(8, "y.mjs"), F(9, "z.mjs"), F(10, "w.mjs")],
    });
    expect(res.verdict).toBe("approved");
    expect(readFm().arch_deferred).toHaveLength(4);
  });

  it("still blocks on a re-raised round-1 finding", async () => {
    writeStory({ arch_round: "1", arch_ledger: [findingKey(F(1, "a.mjs"))] });
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
    expect(res.verdict).toBe("needs-revision");
    expect(readFm().phase).toBe("ready");
  });
});

describe("rks_arch_verdict — the cap terminates the loop", () => {
  it("approves at ARCH_MAX_ROUNDS even with the ledger fully re-raised", async () => {
    writeStory({ arch_round: String(ARCH_MAX_ROUNDS - 1), arch_ledger: [findingKey(F(1, "a.mjs"))] });
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });

    expect(res.verdict).toBe("approved");
    expect(res.capped).toBe(true);
    const fm = readFm();
    expect(fm.phase).toBe("arch-approved");
    expect(fm.arch_ledger).toEqual([]);
    expect(fm.arch_deferred).toContain(findingKey(F(1, "a.mjs")));
  });
});

describe("rks_arch_verdict — evidence-bound reporting", () => {
  it("reports values read back off the note, matching what is on disk", async () => {
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
    const fm = readFm();
    expect(res.verdict).toBe(fm.arch_verdict);
    expect(res.phase).toBe(fm.phase);
    expect(res.blocking).toEqual(fm.arch_ledger);
    expect(String(res.findingsCount)).toBe(String(fm.arch_findings_count));
  });

  it("reports the round cap it applied, so the bound is visible to the caller", async () => {
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(res.maxRounds).toBe(ARCH_MAX_ROUNDS);
    expect(res.round).toBe(1);
  });

  it("rejects an unknown story rather than reporting a verdict for nothing", async () => {
    // Throws McpError rather than returning an envelope — same contract as every
    // other dendron-backed tool for a missing note.
    await expect(
      callVerdict({ projectId: "p", storyId: "backlog.feat.does-not-exist", findings: [] }),
    ).rejects.toThrow(/Note not found/);
  });
});

// ── backlog.fix.arch-ledger-subject-rebinding ────────────────────────────────

describe("rks_arch_verdict — the ledger is bound to the story's content", () => {
  it("writes arch_subject on every recorded verdict", async () => {
    await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(readFm().arch_subject).toMatch(/^[0-9a-f]{32}$/);
  });

  // THE OVER-RESET GUARD. If the digest covered any field the tool itself writes,
  // recording a verdict would invalidate the subject it was recorded against, every
  // round would look amended, and the ledger would reset forever — total loss of
  // termination, strictly worse than the defect this whole mechanism replaced.
  it("does NOT rebase on two consecutive calls with no intervening edit", async () => {
    const first = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
    expect(first.round).toBe(1);
    expect(first.rebased).toBe(false);
    const subjectAfterFirst = readFm().arch_subject;

    const second = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
    expect(second.rebased).toBe(false);
    expect(second.round).toBe(2);
    expect(readFm().arch_subject).toBe(subjectAfterFirst);
  });

  it("rebases to round 1 when the note body is amended between calls", async () => {
    const first = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
    expect(first.round).toBe(1);

    // A material amendment — the shape PO makes when resolving findings.
    const p = path.join(root, "notes", `${STORY}.md`);
    fs.writeFileSync(p, fs.readFileSync(p, "utf8") + "\n## Acceptance Criteria\n\n- [ ] a new one\n");

    const second = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(9, "z.mjs")] });
    expect(second.rebased).toBe(true);
    expect(second.round).toBe(1);
    expect(second.verdict).toBe("needs-revision");
    expect(second.deferred).toEqual([]);
  });

  // The absorbing-approval reproduction, end to end: approve, amend, re-review.
  it("can block an amended story that was previously APPROVED", async () => {
    const approved = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(approved.verdict).toBe("approved");
    expect(readFm().phase).toBe("arch-approved");

    const p = path.join(root, "notes", `${STORY}.md`);
    fs.writeFileSync(p, fs.readFileSync(p, "utf8") + "\n## New Section\n\nMaterial change.\n");

    const after = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(4, "srv.mjs")] });
    expect(after.rebased).toBe(true);
    expect(after.verdict).toBe("needs-revision");

    // KNOWN GAP, pinned deliberately so a future fix is a visible change rather
    // than a silent one. The handler only ever SETS phase, on approval; the
    // original ledger story specified "on needs-revision, leave phase untouched",
    // which was safe while approval was absorbing and no approved story could be
    // re-blocked. Rebasing makes it unsafe: this story is now blocked by ARCH and
    // still carries a buildable phase. Reverting the phase on a rebased
    // needs-revision is not in this story's acceptance criteria and needs its own.
    expect(readFm().arch_verdict).toBe("needs-revision");
    expect(readFm().phase).toBe("arch-approved");
  });

  it("grandfathers a note that carries a round but no arch_subject", async () => {
    writeStory({ arch_round: "1", arch_ledger: [findingKey(F(1, "a.mjs"))] });
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(9, "z.mjs")] });
    expect(res.rebased).toBe(false);
    expect(res.round).toBe(2);
    expect(res.deferred).toEqual([findingKey(F(9, "z.mjs"))]);
  });

  it("exposes no parameter that forces or suppresses a rebase", async () => {
    const tool = await listArchVerdictTool();
    const keys = Object.keys(tool.inputSchema.properties);
    // STANDING GUARD — backlog.fix.arch-no-cumulative-round-bound-across-rebases.
    // Unlike the exact-set tripwire above, this does not redden on lawful schema growth,
    // so it keeps guarding after that tripwire has been legitimately spent once. The
    // cumulative-cost names are added because they are the plausible next request: a caller
    // asking to set its own totalRounds would be asserting the very cost this measures.
    for (const forbidden of [
      "rebase", "reset", "force", "arch_subject", "subject",
      "totalRounds", "priorTotalRounds", "roundFindings",
      "arch_total_rounds", "arch_round_findings",
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });
});

// ── backlog.fix.arch-guidance-write-self-rebases-ledger ──────────────────────
//
// governor-arch.md step 3(b) REQUIRES ARCH to write a `## ARCH Guidance` section into
// the story body on every pass — approved, needs-revision and RAG-unavailable alike.
// The digest covered the whole body, so the tool invalidated the subject it had just
// recorded as a normal step of its own review. On the mandated path `round` was
// permanently 1, `deferred` never fired, and ARCH_MAX_ROUNDS was unreachable.
//
// These drive the tool the way the PROMPT drives it: a guidance write between every
// pair of calls, and nothing else. The four witnesses in the block above drive it with
// no guidance write and prove computeArchVerdict was correct in isolation the whole
// time — so this block and that one measure the composition and the function
// separately, and neither substitutes for the other.
//
// THE FIXTURE CARRIES THE DECOY. Its body quotes the heading literal in reviewable
// prose ABOVE the real column-0 section, indented and inside an inline-code span. A
// single-occurrence fixture cannot distinguish the anchored condition from a substring
// `indexOf`: it passes under both and would ship the bug green.

const DECOY_BODY = [
  "",
  "## Problem",
  "",
  "A story about ARCH quotes the heading in prose. Indented, as the prompt's own",
  "worked template does:",
  "",
  "   ## ARCH Guidance",
  "",
  "and inline as `## ARCH Guidance` in a sentence.",
  "",
  "## Acceptance Criteria",
  "",
  "- [ ] reviewable material that must survive the subtraction",
  "",
].join("\n");

const GUIDANCE_HEADING = "## ARCH Guidance";

function writeDecoyStory(extraFm = {}) {
  const fm = { id: STORY, title: "Fixture", created: 1, updated: 2, phase: "ready", ...extraFm };
  const lines = Object.entries(fm).map(([k, v]) =>
    Array.isArray(v)
      ? v.length === 0
        ? `${k}: []`
        : `${k}:\n${v.map((x) => `  - ${JSON.stringify(x)}`).join("\n")}`
      : `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`,
  );
  fs.writeFileSync(path.join(root, "notes", `${STORY}.md`), `---\n${lines.join("\n")}\n---\n${DECOY_BODY}`);
}

function readRaw() {
  return fs.readFileSync(path.join(root, "notes", `${STORY}.md`), "utf8");
}

/**
 * Do what step 3(b) does, and NOTHING else: append the section on a first pass,
 * replace it verbatim on a re-review. No amendment to reviewable prose, targetFiles
 * or testRequirements — so any rebase this provokes is ARCH's own write.
 */
function writeGuidance(narrative) {
  const raw = readRaw();
  const section = `${GUIDANCE_HEADING}\n\n${narrative}\n`;
  const lines = raw.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) if (lines[i] === GUIDANCE_HEADING) start = i;
  const next =
    start === -1
      ? `${raw}\n${section}`
      : `${lines.slice(0, start).join("\n")}\n${section}`;
  fs.writeFileSync(path.join(root, "notes", `${STORY}.md`), next);
}

describe("rks_arch_verdict — ARCH's own mandated guidance write does not rebase", () => {
  beforeEach(() => writeDecoyStory());

  // RED AT HEAD. Before the fix the second call returned rebased: true, round: 1.
  it("advances the round across a guidance-only pass and keeps the frozen ledger blocking", async () => {
    const first = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
    expect(first.round).toBe(1);
    expect(first.rebased).toBe(false);
    const subjectAfterFirst = readFm().arch_subject;

    writeGuidance("**Verdict:** needs-revision\n\nItem 1 — a.mjs — one finding.");

    const second = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
    expect(second.rebased).toBe(false);
    expect(second.round).toBe(2);
    expect(second.blocking).toEqual([findingKey(F(1, "a.mjs"))]);
    expect(second.verdict).toBe("needs-revision");
    // The subject is byte-equal across ARCH's own write — the whole point.
    expect(readFm().arch_subject).toBe(subjectAfterFirst);
  });

  it("fires the deferred channel: a finding first raised at round 2 defers, never blocks", async () => {
    await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
    writeGuidance("**Verdict:** needs-revision\n\nItem 1.");

    const second = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs"), F(9, "z.mjs")] });
    expect(second.round).toBe(2);
    expect(second.deferred).toEqual([findingKey(F(9, "z.mjs"))]);
    expect(second.blocking).not.toContain(findingKey(F(9, "z.mjs")));
  });

  it("reaches ARCH_MAX_ROUNDS on the mandated path — capped, approved, residue deferred", async () => {
    expect(ARCH_MAX_ROUNDS).toBe(3);

    await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs"), F(2, "b.mjs")] });
    writeGuidance("pass 1");
    const second = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
    expect(second.round).toBe(2);
    writeGuidance("pass 2");

    const third = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
    expect(third.round).toBe(ARCH_MAX_ROUNDS);
    expect(third.capped).toBe(true);
    expect(third.verdict).toBe("approved");
    expect(third.blocking).toEqual([]);
    expect(third.deferred).toContain(findingKey(F(1, "a.mjs")));
    expect(readFm().phase).toBe("arch-approved");
  });

  // The exclusion must not MASK a concurrent genuine amendment made in the same edit.
  it("STILL rebases when a guidance replacement is accompanied by a prose amendment", async () => {
    await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
    writeGuidance("pass 1");

    const p = path.join(root, "notes", `${STORY}.md`);
    fs.writeFileSync(p, readRaw().replace("reviewable material", "AMENDED material"));
    writeGuidance("pass 2 — replaced in the same edit");

    const second = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(9, "z.mjs")] });
    expect(second.rebased).toBe(true);
    expect(second.round).toBe(1);
    expect(second.blocking).toEqual([findingKey(F(9, "z.mjs"))]);
  });

  // The decoys are reviewable body, not ARCH-owned. Editing one is a genuine amendment.
  it("STILL rebases when the DECOY prose is edited", async () => {
    await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
    writeGuidance("pass 1");

    const p = path.join(root, "notes", `${STORY}.md`);
    fs.writeFileSync(p, readRaw().replace("in a sentence.", "in a sentence, edited."));

    const second = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(9, "z.mjs")] });
    expect(second.rebased).toBe(true);
    expect(second.round).toBe(1);
  });

  // The naive-parser hazard, asserted rather than assumed. Under a substring indexOf
  // the strip would start inside the Problem section, so amending the Acceptance
  // Criteria — which sits BELOW the first decoy and above the real section — would be
  // invisible to the digest and this would return rebased: false.
  it("does not go blind to material BELOW the decoy and above the real section", async () => {
    await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
    writeGuidance("pass 1");

    const p = path.join(root, "notes", `${STORY}.md`);
    fs.writeFileSync(p, readRaw().replace("- [ ] reviewable material", "- [ ] a newly added criterion"));

    const second = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(9, "z.mjs")] });
    expect(second.rebased).toBe(true);
    expect(second.round).toBe(1);
  });

  it("leaves the decoy prose on disk — the subtraction is to the DIGEST, not the note", async () => {
    await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    const raw = readRaw();
    expect(raw).toContain("   ## ARCH Guidance");
    expect(raw).toContain("inline as `## ARCH Guidance` in a sentence.");
    expect(raw).toContain("- [ ] reviewable material that must survive the subtraction");
  });
});
