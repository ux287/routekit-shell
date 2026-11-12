/**
 * backlog.feat.suppressible-public-publish — Step 7 / Step 7b / telemetry coverage for the
 * release path (CALLER 1).
 *
 * MANDATORY LINK-2 PROOF (ARCH Finding 1). `publishResult` is a LOCAL variable inside
 * runRelease, so a test that only drives publish() and asserts `pubResult.ok !== true` proves
 * link 1 of a two-link chain — and link 2 is code this story rewrites. Link 2 is the mapping
 * from a publish() result onto the `publishResult` shape that Step 7b gates on, and it is
 * extracted as the exported pure function `mapPublishOutcome`.
 *
 * There is deliberately NO vi.mock and NO child_process interception anywhere in this file.
 * The pure-function extraction exists precisely so the proof does not depend on the unresolved
 * question of whether `vi.mock("child_process")` intercepts inside git-release.mjs — the
 * question that left tests/unit/git-release.gh-release.test.mjs describe.skip'd.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mapPublishOutcome } from "../../packages/mcp-rks/src/server/git/git-release.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const RELEASE_SRC = readFileSync(
  join(ROOT, "packages/mcp-rks/src/server/git/git-release.mjs"),
  "utf-8",
);

/** The literal Step 7b gate condition, `if (publishResult?.ok)`, evaluated on a mapped outcome. */
const step7bWouldFire = (pubResult) => Boolean(mapPublishOutcome(pubResult)?.ok);

// ═══════════════════════════════════════════════════════════════════════════════════
// MANDATORY, MOCK-FREE: the mapping layer
// ═══════════════════════════════════════════════════════════════════════════════════

describe("mapPublishOutcome — the Step 7 → Step 7b link (no mocking of any kind)", () => {
  it("(a) a SUPPRESSED publish maps to an outcome whose .ok is NOT truthy, carrying suppressed + reason", () => {
    const reason = 'Remote "rks-public" is disarmed: enabled: false';
    const mapped = mapPublishOutcome({ ok: false, suppressed: true, reason });

    // This is literally the Step 7b gate condition `if (publishResult?.ok)`.
    expect(mapped.ok).toBeFalsy();
    expect(mapped.suppressed).toBe(true);
    expect(mapped.reason).toBe(reason);
    expect(step7bWouldFire({ ok: false, suppressed: true, reason })).toBe(false);
  });

  it("(b) a GENUINE failure still produces the `Publish to ... failed` warning shape", () => {
    const mapped = mapPublishOutcome({ ok: false, error: "no ssh key" }, "rks-public");

    expect(mapped.ok).toBeFalsy();
    expect(mapped.warning).toMatch(/^Publish to rks-public failed: /);
    expect(mapped.warning).toContain("no ssh key");
    // Genuine failure is NOT a suppression.
    expect(mapped.suppressed).toBeUndefined();
    expect(step7bWouldFire({ ok: false, error: "no ssh key" })).toBe(false);
  });

  it("(c) BACKWARD-COMPAT CONTROL: a real publish still maps to ok === true so Step 7b fires", () => {
    // Without this control a mapping that always returns ok:false passes (a) and (b).
    expect(mapPublishOutcome({ ok: true }).ok).toBe(true);
    expect(step7bWouldFire({ ok: true })).toBe(true);
  });

  it("FORBIDDEN SHAPE: no suppressed input ever yields a truthy .ok", () => {
    // `publishResult = { ok: true, suppressed: true }` satisfies every other requirement in this
    // story and then executes `gh release create v<version> --repo <public mirror>` — a write to
    // the public mirror in the exact scenario suppression exists to prevent.
    const suppressedInputs = [
      { ok: false, suppressed: true, reason: "disarmed" },
      { ok: false, suppressed: true },
      { suppressed: true, reason: "disarmed" },
      { ok: true, suppressed: true, reason: "disarmed" },
    ];
    for (const input of suppressedInputs) {
      const mapped = mapPublishOutcome(input);
      expect(mapped.ok, `suppressed input must never map to a truthy .ok: ${JSON.stringify(input)}`)
        .toBeFalsy();
      expect(mapped.suppressed).toBe(true);
      expect(step7bWouldFire(input)).toBe(false);
    }
  });

  it("suppression is kept OFF the `Publish to ... failed` string — SKIP and FAIL stay discriminable", () => {
    const suppressed = mapPublishOutcome({ ok: false, suppressed: true, reason: "disarmed" }, "rks-public");
    const failed = mapPublishOutcome({ ok: false, error: "no ssh key" }, "rks-public");

    expect(suppressed.warning).toBeUndefined();
    expect(JSON.stringify(suppressed)).not.toMatch(/Publish to .* failed/);
    expect(failed.reason).toBeUndefined();
    expect(failed.warning).toMatch(/Publish to .* failed/);
  });

  it("RELEASE honest reporting: a suppressed outcome states SKIPPED and why", () => {
    const mapped = mapPublishOutcome({
      ok: false,
      suppressed: true,
      reason: 'Remote "rks-public" is disarmed: enabled: false. Publish SKIPPED.',
    });

    // The rks_release result carries this object as `result.publishResult` and the MCP handler
    // JSON-stringifies the result unchanged, so the operator sees the skip and the reason.
    expect(mapped.skipped).toBe(true);
    expect(mapped.reason).toMatch(/disarmed/);
    expect(mapped.reason).toMatch(/SKIPPED/);
    expect(mapped.ok).toBeFalsy(); // it does NOT report a successful publish
  });

  it("is pure — same input, same output, and the input is not mutated", () => {
    const input = { ok: false, suppressed: true, reason: "disarmed" };
    const snapshot = JSON.stringify(input);
    const a = mapPublishOutcome(input);
    const b = mapPublishOutcome(input);

    expect(a).toEqual(b);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("derives the remote name from the publish result when not passed explicitly", () => {
    const mapped = mapPublishOutcome({ ok: false, error: "boom", remote: "rks-public" });
    expect(mapped.warning).toContain("rks-public");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
// MUTATION 4 (GitHub Release leak) — the gate, and what lives behind it
// ═══════════════════════════════════════════════════════════════════════════════════

/** Step 7b: from the gate to the checkout that follows the block. */
function step7bBlock() {
  const start = RELEASE_SRC.indexOf("if (publishResult?.ok) {");
  const end = RELEASE_SRC.indexOf('spawnSync("git", ["checkout", branchConfig.integration]', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return { start, end, text: RELEASE_SRC.slice(start, end) };
}

describe("Step 7b cannot fire when the publish was suppressed", () => {
  it("Step 7 routes its outcome through mapPublishOutcome", () => {
    expect(RELEASE_SRC).toMatch(/publishResult = mapPublishOutcome\(pubResult/);
  });

  it("the gate is still the literal `if (publishResult?.ok)`", () => {
    expect(RELEASE_SRC).toMatch(/if \(publishResult\?\.ok\)/);
  });

  it("every `gh release ... --repo <publicRepo>` invocation lives INSIDE that gate", () => {
    const { start, end } = step7bBlock();
    const occurrences = [];
    let i = RELEASE_SRC.indexOf('"--repo", publicRepo');
    while (i !== -1) {
      occurrences.push(i);
      i = RELEASE_SRC.indexOf('"--repo", publicRepo', i + 1);
    }
    expect(occurrences.length).toBeGreaterThan(0);
    for (const idx of occurrences) {
      expect(idx, "a public-mirror gh release call escaped the publishResult?.ok gate").toBeGreaterThan(start);
      expect(idx).toBeLessThan(end);
    }
  });

  it("the gated block is the one that creates/edits the public GitHub Release", () => {
    const { text } = step7bBlock();
    expect(text).toMatch(/"release",\s*"create"/);
    expect(text).toMatch(/"release",\s*"edit"/);
    expect(text).toContain('"--target", publicBranch');
  });

  it("DETERMINISTIC CHAIN: gate condition (source) + mapping (mock-free) ⇒ no public release on suppression", () => {
    // Gate reads `.ok`; a suppressed publish maps to a falsy `.ok`; therefore the block that
    // holds every `--repo publicRepo` call is not entered.
    expect(RELEASE_SRC).toMatch(/if \(publishResult\?\.ok\)/);
    expect(step7bWouldFire({ ok: false, suppressed: true, reason: "disarmed" })).toBe(false);
    expect(step7bWouldFire({ ok: true })).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
// Honest reporting + telemetry
// ═══════════════════════════════════════════════════════════════════════════════════

describe("rks_release result propagates the suppression", () => {
  it("the release result carries publishResult, so suppressed + reason reach the caller unchanged", () => {
    expect(RELEASE_SRC).toMatch(/const result = \{ ok: true,[^\n]*publishResult/);
  });

  it("Step 7 logs a SKIP distinctly from a failure", () => {
    expect(RELEASE_SRC).toMatch(/publishResult\.suppressed/);
    expect(RELEASE_SRC).toMatch(/publish SKIPPED/);
  });
});

/** The full `collector.emit("release.complete", ...)` call text. */
function releaseCompleteEmit() {
  const idx = RELEASE_SRC.indexOf('collector.emit("release.complete"');
  expect(idx).toBeGreaterThan(-1);
  const end = RELEASE_SRC.indexOf("\n", idx);
  return { idx, text: RELEASE_SRC.slice(idx, end) };
}

describe("release.complete telemetry — publishSuppressed is APPEND-ONLY", () => {
  it("carries publishSuppressed: true plus the reason, conditionally spread", () => {
    const { text } = releaseCompleteEmit();
    expect(text).toMatch(
      /\.\.\.\(publishResult\?\.suppressed \? \{ publishSuppressed: true, publishSuppressedReason: publishResult\.reason \} : \{\}\)/,
    );
  });

  it("both fields are ABSENT from the emit when publish was not suppressed", () => {
    // The spread is guarded on `publishResult?.suppressed`, and a non-suppressed outcome never
    // sets that flag — asserted mock-free at the mapping layer.
    expect(mapPublishOutcome({ ok: true }).suppressed).toBeUndefined();
    expect(mapPublishOutcome({ ok: false, error: "no ssh key" }).suppressed).toBeUndefined();
    const { text } = releaseCompleteEmit();
    expect(text).toContain("publishResult?.suppressed ?");
  });

  it("the new spread sits AFTER the overrideApplied spread (mirrors ciGateOverridden / overrideReason)", () => {
    const { text } = releaseCompleteEmit();
    expect(text.indexOf("ciGateOverridden")).toBeGreaterThan(-1);
    expect(text.indexOf("publishSuppressed")).toBeGreaterThan(text.indexOf("ciGateOverridden"));
    expect(text.indexOf("overrideApplied")).toBeLessThan(text.indexOf("publishResult?.suppressed"));
  });

  it("no leading scalar field was reordered or relocated", () => {
    const { text } = releaseCompleteEmit();
    const order = ["version:", "tag:", "sha:", "bump:", "branch:", "durationMs:", "changelogLines:"];
    let cursor = -1;
    for (const field of order) {
      const at = text.indexOf(field);
      expect(at, `missing leading scalar field ${field}`).toBeGreaterThan(-1);
      expect(at, `leading scalar field out of order: ${field}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("the FIRST `})` after the event name still falls after changelogLines (the non-greedy-capture pin)", () => {
    // tests/integration/git-release.test.mjs:353,:378 capture with a NON-GREEDY
    // /collector\.emit\("release\.complete"[\s\S]*?\}\)/ that terminates at the first `})`.
    // A spread inserted BEFORE the scalar fields would truncate that capture and drop
    // version / tag / durationMs / changelogLines out of it.
    const { idx } = releaseCompleteEmit();
    const firstClose = RELEASE_SRC.indexOf("})", idx);
    const changelog = RELEASE_SRC.indexOf("changelogLines:", idx);
    expect(firstClose).toBeGreaterThan(-1);
    expect(changelog).toBeGreaterThan(-1);
    expect(firstClose).toBeGreaterThan(changelog);
  });

  it("durationMs still falls inside the fixed 300-char window sliced from the event name", () => {
    // tests/unit/telemetry-lifecycle-gaps.test.mjs:189-193 slices src.slice(idx, idx + 300)
    // from '"release.complete"' and asserts /version/, /tag/, /durationMs/.
    const idx = RELEASE_SRC.indexOf('"release.complete"');
    const window = RELEASE_SRC.slice(idx, idx + 300);
    expect(window).toMatch(/version/);
    expect(window).toMatch(/tag/);
    expect(window).toMatch(/durationMs/);
  });
});
