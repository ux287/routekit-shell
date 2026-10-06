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
import { ARCH_MAX_ROUNDS, findingKey, noteSubjectDigest, noteLegacySubjectDigest } from "../../packages/mcp-rks/src/workflow/arch-verdict.mjs";
import { runPlanReadyTool } from "../../packages/mcp-rks/src/server/plan-ready.mjs";

const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
let root;

const STORY = "backlog.feat.fixture-story";

// `body` defaults to the exact body every pre-existing fixture was written with, so those
// fixtures (and the subject digests derived from them) are byte-for-byte unchanged.
function writeStory(extraFm = {}, body = "## Problem\nbody\n") {
  const fm = { id: STORY, title: "Fixture", created: 1, updated: 2, phase: "ready", ...extraFm };
  const lines = Object.entries(fm).map(([k, v]) =>
    Array.isArray(v)
      ? v.length === 0
        ? `${k}: []`
        : `${k}:\n${v.map((x) => `  - ${JSON.stringify(x)}`).join("\n")}`
      : `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`,
  );
  fs.writeFileSync(path.join(root, "notes", `${STORY}.md`), `---\n${lines.join("\n")}\n---\n\n${body}`);
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

    // backlog.fix.arch-verdict-never-retracts-arch-approved flipped the former KNOWN GAP
    // pin here (which asserted phase stayed arch-approved). A rebased needs-revision on an
    // arch-approved story now RETRACTS the phase to ready, so the story no longer carries
    // a buildable phase beside a refusing verdict.
    expect(readFm().arch_verdict).toBe("needs-revision");
    expect(readFm().phase).toBe("ready");
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

// ---------------------------------------------------------------------------------------------
// backlog.fix.arch-verdict-enforces-plan-ready-create-gate
//
// rks_arch_verdict must never approve a story that rks_plan_ready then blocks with
// create_target_no_authorable_block. Reported: a story passed ARCH (approved, 0 findings) and
// /build then failed at plan_ready. Scope is that ONE check. ROUTEKIT_PROJECT_ROOT is the temp
// root, so every target path below resolves under it: op:create paths are left ABSENT, and every
// op:edit path a fixture declares is created on disk (except the stale-path negative control).
// ---------------------------------------------------------------------------------------------

const CREATE_PATH = "src/gate/new-thing.mjs";
const createTarget = (p = CREATE_PATH) => ({ path: p, op: "create", desc: "new module" });
const editTarget = (p) => ({ path: p, op: "edit", desc: "edit module" });

// Directive in one ### section, the ONLY fenced block in a DIFFERENT ### section. The planner's
// extractor binds a block only within the directive's own section, so nothing is authorable.
const REPORTED_BODY = [
  "## Problem",
  "body",
  "",
  "### Create directive",
  "",
  `// CREATE FILE: ${CREATE_PATH}`,
  "",
  "### Reference",
  "",
  "```js",
  "export const newThing = () => 42;",
  "```",
  "",
].join("\n");

// Control: real content in the SAME ### section, immediately after the directive.
const CONTROL_BODY = [
  "## Problem",
  "body",
  "",
  "### Create directive",
  "",
  `// CREATE FILE: ${CREATE_PATH}`,
  "```js",
  "export const newThing = () => 42;",
  "```",
  "",
].join("\n");

// Directive plus a placeholder-only block — isSynthesizedBody rejects it.
const PLACEHOLDER_BODY = [
  "## Problem",
  "body",
  "",
  "### Create directive",
  "",
  `// CREATE FILE: ${CREATE_PATH}`,
  "```js",
  "// TODO: implement",
  "```",
  "",
].join("\n");

function writeReportedCase(extraFm = {}) {
  writeStory({ targetFiles: [createTarget()], ...extraFm }, REPORTED_BODY);
}

function touch(rel) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "export const existing = 1;\n");
}

function expectNoGateKey(values) {
  for (const v of values || []) {
    expect(String(v)).not.toContain(CREATE_PATH);
    expect(String(v)).not.toContain("create_target_no_authorable_block");
  }
}

describe("rks_arch_verdict — plan-ready create gate refuses approval", () => {
  it("the reported case: findings = [] returns needs-revision, not approved", async () => {
    // Precondition, so the case cannot pass vacuously: the create target is absent.
    expect(fs.existsSync(path.join(root, CREATE_PATH))).toBe(false);
    writeReportedCase();
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(res.ok).toBe(true);
    expect(res.verdict).toBe("needs-revision");
  });

  it("carries gateIssues entries { check, file, suggestion } naming the target path", async () => {
    writeReportedCase();
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(Array.isArray(res.gateIssues)).toBe(true);
    expect(res.gateIssues).toHaveLength(1);
    for (const g of res.gateIssues) {
      expect(Object.keys(g).sort()).toEqual(["check", "file", "suggestion"]);
      expect(g.check).toBe("create_target_no_authorable_block");
      expect(typeof g.suggestion).toBe("string");
      expect(g.suggestion.length).toBeGreaterThan(0);
    }
    expect(res.gateIssues[0].file).toBe(CREATE_PATH);
  });

  it("keeps gate issues out of the response blocking and deferred channels", async () => {
    writeReportedCase();
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(res.gateIssues.length).toBeGreaterThan(0);
    expectNoGateKey(res.blocking);
    expectNoGateKey(res.deferred);
    expect(res.blocking).toEqual([]);
    expect(res.deferred).toEqual([]);
  });

  it("findingsCount equals gateIssues.length (never 0 on a refusal) and matches disk", async () => {
    writeReportedCase();
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(res.findingsCount).toBe(res.gateIssues.length);
    expect(res.findingsCount).not.toBe(0);
    expect(String(readFm().arch_findings_count)).toBe(String(res.gateIssues.length));
  });

  it("findingsCount combines ledger-blocking and gate issues: 1 submitted + gateIssues.length", async () => {
    writeReportedCase();
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
    expect(res.round).toBe(1);
    expect(res.findingsCount).toBe(1 + res.gateIssues.length);
    expect(String(readFm().arch_findings_count)).toBe(String(1 + res.gateIssues.length));
  });

  it("does not advance the phase: disk holds phase ready and arch_verdict needs-revision", async () => {
    writeReportedCase();
    await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    const fm = readFm();
    expect(fm.phase).toBe("ready");
    expect(fm.arch_verdict).toBe("needs-revision");
  });

  it("reads back against the FINAL gated verdict: ok true, no read_back_mismatch, response equals disk", async () => {
    writeReportedCase();
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    const fm = readFm();
    expect(res.verdict).toBe(fm.arch_verdict);
    expect(res.phase).toBe(fm.phase);
  });

  it("never ledgers a gate issue: arch_ledger and arch_deferred on disk are empty", async () => {
    writeReportedCase();
    await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    const fm = readFm();
    expect(fm.arch_ledger ?? []).toEqual([]);
    expect(fm.arch_deferred ?? []).toEqual([]);
    expectNoGateKey(fm.arch_ledger);
    expectNoGateKey(fm.arch_deferred);
  });

  it("a second call on the unamended note still refuses — round 1 freezing does not absorb the gate", async () => {
    writeReportedCase();
    const first = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(first.round).toBe(1);
    const second = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(second.ok).toBe(true);
    expect(second.rebased).toBe(false);
    expect(second.round).toBe(2);
    expect(second.verdict).toBe("needs-revision");
    expect(second.gateIssues.length).toBeGreaterThan(0);
    expect(second.gateIssues.map((g) => g.file)).toContain(CREATE_PATH);
    expectNoGateKey(readFm().arch_deferred);
    expectNoGateKey(readFm().arch_ledger);
  });

  it("the round cap cannot approve it: capped true, needs-revision and gateIssues in one response", async () => {
    writeReportedCase({ arch_round: String(ARCH_MAX_ROUNDS - 1) });
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(res.ok).toBe(true);
    expect(res.round).toBe(ARCH_MAX_ROUNDS);
    expect(res.capped).toBe(true);
    expect(res.verdict).toBe("needs-revision");
    expect(res.gateIssues.length).toBeGreaterThan(0);
    const fm = readFm();
    expect(fm.phase).toBe("ready");
    expect(fm.arch_verdict).toBe("needs-revision");
  });

  it("refuses a directive followed by a placeholder-only block (isSynthesizedBody semantics)", async () => {
    writeStory({ targetFiles: [createTarget()] }, PLACEHOLDER_BODY);
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(res.verdict).toBe("needs-revision");
    expect(res.gateIssues.map((g) => g.check)).toEqual(["create_target_no_authorable_block"]);
    expect(res.gateIssues[0].file).toBe(CREATE_PATH);
  });
});

// backlog.fix.create-directive-binds-only-same-section — ARCH and plan-ready agree, per shape.
describe("rks_arch_verdict — create gate by shape, identical to rks_plan_ready", () => {
  const TICKS3 = "`" + "`" + "`";
  const DIR = "// CREATE" + " FILE: ";
  const planReadySuggestion = async (file) => {
    const pr = await runPlanReadyTool({ projectId: "p", problemId: STORY, projectRoot: root });
    return (pr.issues || []).find((i) => i.check === "create_target_no_authorable_block" && i.file === file)?.suggestion;
  };

  it("frontmatter-only heading shape (no directive, real content under ### T): empty gateIssues", async () => {
    writeStory({ targetFiles: [createTarget()] }, ["## Problem", "body", "", `### ${CREATE_PATH}`, TICKS3 + "js", "export const t = 1;", TICKS3, ""].join("\n"));
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(res.gateIssues).toEqual([]);
  });

  it("shape (e): one keys-exact gateIssues entry whose suggestion equals plan_ready's", async () => {
    writeStory({ targetFiles: [createTarget()] }, "## Problem\nbody\n");
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(res.gateIssues).toHaveLength(1);
    expect(Object.keys(res.gateIssues[0]).sort()).toEqual(["check", "file", "suggestion"]);
    expect(res.gateIssues[0].suggestion).toBe(await planReadySuggestion(CREATE_PATH));
  });

  it("shape (b) and shape (c): the gateIssues suggestion is character-identical to plan_ready's", async () => {
    // (b) a directive under ## Target Files, no fence in that section, no ### T section.
    writeStory({ targetFiles: [createTarget()] }, ["## Target Files", "", `${DIR}${CREATE_PATH}`, "", "## Notes", "prose", ""].join("\n"));
    const b = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    const bEntry = b.gateIssues.find((g) => g.file === CREATE_PATH);
    expect(Object.keys(bEntry).sort()).toEqual(["check", "file", "suggestion"]);
    expect(bEntry.suggestion).toBe(await planReadySuggestion(CREATE_PATH));
    expect(bEntry.suggestion).toContain("Target Files");

    // (c) two directives, one fence, no rescue — the target is the first path.
    const X = "src/gate/x.mjs";
    const Y = "src/gate/y.mjs";
    writeStory({ targetFiles: [createTarget(X), createTarget(Y)] },
      ["## Shared", `${DIR}${X}`, `${DIR}${Y}`, TICKS3 + "js", "export const y = 1;", TICKS3, ""].join("\n"));
    const c = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    const cEntry = c.gateIssues.find((g) => g.file === X);
    expect(Object.keys(cEntry).sort()).toEqual(["check", "file", "suggestion"]);
    expect(cEntry.suggestion).toBe(await planReadySuggestion(X));
    expect(cEntry.suggestion).toContain(Y);
  });
});

describe("rks_arch_verdict — plan-ready create gate passes (current behaviour preserved)", () => {
  it("control: an authorable block in the same ### section approves and advances the phase", async () => {
    writeStory({ targetFiles: [createTarget()] }, CONTROL_BODY);
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(res.ok).toBe(true);
    expect(res.verdict).toBe("approved");
    expect(res.gateIssues).toEqual([]);
    expect(readFm().phase).toBe("arch-approved");
  });

  it("gateIssues is present and empty on the control fixture and on a fixture with no targetFiles", async () => {
    writeStory({ targetFiles: [createTarget()] }, CONTROL_BODY);
    const control = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(control.gateIssues).toEqual([]);

    writeStory();
    const none = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(none.gateIssues).toEqual([]);
    expect(none.verdict).toBe("approved");
    expect(none.findingsCount).toBe(0);
  });

  it("findingsCount is unchanged without gate issues: two round-1 findings write 2, [] writes 0", async () => {
    writeStory();
    const two = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs"), F(2, "b.mjs")] });
    expect(two.gateIssues).toEqual([]);
    expect(String(readFm().arch_findings_count)).toBe("2");

    writeStory();
    const zero = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(zero.gateIssues).toEqual([]);
    expect(String(readFm().arch_findings_count)).toBe("0");
  });

  it("multi_file_blocked alone does not block: three edit targets on existing paths approve", async () => {
    const paths = ["src/multi/a.mjs", "src/multi/b.mjs", "src/multi/c.mjs"];
    paths.forEach(touch);
    writeStory({ targetFiles: paths.map(editTarget) });
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(res.ok).toBe(true);
    expect(res.verdict).toBe("approved");
    expect(res.findingsCount).toBe(0);
    expect(res.gateIssues).toEqual([]);
  });

  it("scope negative control: a stale op:edit path (plan_ready stale_target_path) still approves", async () => {
    const stale = "src/scope/missing-edit.mjs";
    expect(fs.existsSync(path.join(root, stale))).toBe(false);
    writeStory({ targetFiles: [editTarget(stale)] });
    // Positive control: plan_ready DOES report this fixture, just not with the gated check.
    const pr = await runPlanReadyTool({ projectId: "p", problemId: STORY, projectRoot: root });
    expect(pr.issues.map((i) => i.check)).toContain("stale_target_path");
    expect(pr.issues.map((i) => i.check)).not.toContain("create_target_no_authorable_block");

    writeStory({ targetFiles: [editTarget(stale)] });
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(res.verdict).toBe("approved");
    expect(res.gateIssues).toEqual([]);
  });
});

describe("rks_arch_verdict — parity with rks_plan_ready", () => {
  it("classifies the reported-case fixture identically to runPlanReadyTool", async () => {
    writeReportedCase();
    const pr = await runPlanReadyTool({ projectId: "p", problemId: STORY, projectRoot: root });
    const planReadyFiles = pr.issues
      .filter((i) => i.check === "create_target_no_authorable_block")
      .map((i) => i.file)
      .sort();
    expect(planReadyFiles.length).toBeGreaterThan(0);

    writeReportedCase();
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(res.gateIssues.map((g) => g.file).sort()).toEqual(planReadyFiles);
  });
});

describe("the create-target predicate is shared, not duplicated", () => {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const planReadySrc = fs.readFileSync(path.join(repo, "packages/mcp-rks/src/server/plan-ready.mjs"), "utf8");
  const serverSrc = fs.readFileSync(path.join(repo, "packages/mcp-rks/src/server.mjs"), "utf8");

  it("plan-ready.mjs exports the predicate and runPlanReadyTool uses it", async () => {
    const mod = await import("../../packages/mcp-rks/src/server/plan-ready.mjs");
    expect(typeof mod.createTargetNoAuthorableBlockIssue).toBe("function");
    expect(typeof mod.findCreateTargetNoAuthorableBlockIssues).toBe("function");
    const runBody = planReadySrc.slice(planReadySrc.indexOf("export async function runPlanReadyTool("));
    // backlog.fix.create-directive-binds-only-same-section: the predicate now also receives the
    // body and the declared-create set, so it can name the actual misplacement.
    expect(runBody).toContain("createTargetNoAuthorableBlockIssue(createFileBlocks, target, { body, declaredCreatePaths: fmCreateFiles })");
    // The check name is raised in exactly one place: the shared predicate.
    expect(planReadySrc.match(/check: "create_target_no_authorable_block"/g)).toHaveLength(1);
  });

  it("server.mjs imports it from ./server/plan-ready.mjs and does not re-implement it", () => {
    expect(serverSrc).toMatch(
      /import\s*\{[^}]*\bfindCreateTargetNoAuthorableBlockIssues\b[^}]*\}\s*from\s*"\.\/server\/plan-ready\.mjs"/,
    );
    expect(serverSrc).not.toMatch(/\bextractCreateFileBlocks\s*\(/);
    expect(serverSrc).not.toMatch(/\bisSynthesizedBody\s*\(/);
  });
});

// ── backlog.fix.arch-verdict-never-retracts-arch-approved ────────────────────
//
// The handler promoted on approved and had no converse: a rebased needs-revision on an
// arch-approved story left phase arch-approved beside arch_verdict needs-revision.
// Retraction is arch-approved -> ready ONLY. draft/ready keep their phase, and the
// mid-build phases planned / executing / executed are deliberately not demoted.

function notePathFor() {
  return path.join(root, "notes", `${STORY}.md`);
}

function amendBody(extra = "\n## New Section\n\nMaterial change.\n") {
  const p = notePathFor();
  fs.writeFileSync(p, fs.readFileSync(p, "utf8") + extra);
}

describe("rks_arch_verdict — a needs-revision verdict retracts arch-approved", () => {
  it("the retraction call returns ok true, no read_back_mismatch, and phase ready matching disk", async () => {
    const approved = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(approved.phase).toBe("arch-approved");
    amendBody();

    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(4, "srv.mjs")] });
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.mismatches).toBeUndefined();
    expect(res.verdict).toBe("needs-revision");
    expect(res.phase).toBe("ready");
    expect(res.phase).toBe(readFm().phase);
  });

  it("retracts when needs-revision comes ONLY from the plan-ready create gate", async () => {
    const approved = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(approved.verdict).toBe("approved");
    expect(readFm().phase).toBe("arch-approved");

    // Amend: add an op:create target with no authorable block, keeping every other field.
    const { id: _id, ...rest } = readFm();
    expect(fs.existsSync(path.join(root, CREATE_PATH))).toBe(false);
    writeStory({ ...rest, targetFiles: [createTarget()] });

    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(res.ok).toBe(true);
    expect(res.verdict).toBe("needs-revision");
    expect(res.gateIssues.length).toBeGreaterThan(0);
    expect(res.blocking).toEqual([]);
    expect(readFm().phase).toBe("ready");
    expect(res.phase).toBe("ready");
  });

  it("leaves a draft story at draft on needs-revision", async () => {
    writeStory({ phase: "draft" });
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
    expect(res.ok).toBe(true);
    expect(res.verdict).toBe("needs-revision");
    expect(readFm().phase).toBe("draft");
    expect(res.phase).toBe("draft");
  });

  it("leaves a ready story at ready on needs-revision", async () => {
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
    expect(res.ok).toBe(true);
    expect(readFm().phase).toBe("ready");
    expect(res.phase).toBe("ready");
  });

  it.each(["planned", "executing", "executed"])(
    "does NOT demote a story at phase %s on needs-revision",
    async (phase) => {
      writeStory({ phase });
      const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
      expect(res.ok).toBe(true);
      expect(res.error).toBeUndefined();
      expect(res.verdict).toBe("needs-revision");
      expect(readFm().phase).toBe(phase);
      expect(res.phase).toBe(phase);
    },
  );

  it("promotion is unchanged: a first approved verdict on a ready story sets arch-approved", async () => {
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(res.ok).toBe(true);
    expect(res.phase).toBe("arch-approved");
    expect(readFm().phase).toBe("arch-approved");
  });

  it("promotion is unchanged: the capped ARCH_MAX_ROUNDS approval sets arch-approved", async () => {
    writeStory({ arch_round: String(ARCH_MAX_ROUNDS - 1), arch_ledger: [findingKey(F(1, "a.mjs"))] });
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs")] });
    expect(res.capped).toBe(true);
    expect(res.verdict).toBe("approved");
    expect(readFm().phase).toBe("arch-approved");
  });

  it("re-approval after retraction returns the story to arch-approved", async () => {
    await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    amendBody();
    const retracted = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(4, "srv.mjs")] });
    expect(retracted.verdict).toBe("needs-revision");
    expect(readFm().phase).toBe("ready");

    const reapproved = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(reapproved.ok).toBe(true);
    expect(reapproved.verdict).toBe("approved");
    expect(readFm().phase).toBe("arch-approved");
    expect(reapproved.phase).toBe("arch-approved");
  });
});

describe("rks_arch_verdict — arch_subject is the shared helper's digest of the note on disk", () => {
  const parsedNow = () => parseFrontmatter(fs.readFileSync(notePathFor(), "utf8"));

  it("after approval, and still after an ## ARCH Guidance section is appended", async () => {
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [] });
    expect(res.verdict).toBe("approved");
    expect(readFm().arch_subject).toBe(noteSubjectDigest(parsedNow()));

    amendBody("\n## ARCH Guidance\n\n**Verdict:** approved\n\nNo findings.\n");
    expect(fs.readFileSync(notePathFor(), "utf8")).toContain("## ARCH Guidance");
    expect(readFm().arch_subject).toBe(noteSubjectDigest(parsedNow()));
  });
});

// backlog.fix.arch-subject-digest-guidance-boundary-whitespace — an arch_subject recorded
// before the digest was canonicalized equals the LEGACY digest of the unchanged note. It
// is the same subject, not an amendment, and the handler records the canonical digest.
describe("rks_arch_verdict — an arch_subject equal to the legacy digest is not rebased", () => {
  const notePath = () => path.join(root, "notes", `${STORY}.md`);
  const parsedNow = () => parseFrontmatter(fs.readFileSync(notePath(), "utf8"));

  it("advances arch_round, keeps the ledger, and rewrites arch_subject to the canonical digest", async () => {
    const ledger = [findingKey(F(1, "a.mjs"))];
    writeStory({ arch_round: "1", arch_ledger: ledger, arch_verdict: "needs-revision" });
    const legacy = noteLegacySubjectDigest(parsedNow());
    // The default fixture body ends in a newline, so the two digests differ.
    expect(legacy).not.toBe(noteSubjectDigest(parsedNow()));
    writeStory({ arch_round: "1", arch_ledger: ledger, arch_verdict: "needs-revision", arch_subject: legacy });
    expect(noteLegacySubjectDigest(parsedNow())).toBe(legacy);

    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(1, "a.mjs"), F(9, "z.mjs")] });
    expect(res.rebased).toBe(false);
    expect(res.round).toBe(2);
    expect(String(readFm().arch_round)).toBe("2");
    expect(readFm().arch_ledger).toEqual(ledger);
    expect(readFm().arch_deferred).toEqual([findingKey(F(9, "z.mjs"))]);
    expect(readFm().arch_subject).toBe(noteSubjectDigest(parsedNow()));
    expect(readFm().arch_subject).not.toBe(legacy);
  });

  it("control: an arch_subject matching neither digest still rebases", async () => {
    writeStory({ arch_round: "1", arch_ledger: [findingKey(F(1, "a.mjs"))], arch_subject: "c".repeat(32) });
    const res = await callVerdict({ projectId: "p", storyId: STORY, findings: [F(9, "z.mjs")] });
    expect(res.rebased).toBe(true);
    expect(res.round).toBe(1);
    expect(readFm().arch_subject).toBe(noteSubjectDigest(parsedNow()));
  });
});
