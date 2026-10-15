/**
 * Witness for backlog.feat.exec-terminal-telemetry-build-fidelity.
 *
 * exec.mjs used to produce exec.start and exec.complete TWICE per run: once from
 * collector.startTimer("exec") and its telemetryTimer.complete, which emit implicitly,
 * and once from the literal collector.emit calls. A survey that counted only literal
 * emit sites could not see the timer's half. A-prime drops the timer, so every exec
 * lifecycle event is a literal emit, and the surviving terminals carry what a
 * first-attempt pass rate needs: attempts, runId, a reason, and the correlationId on
 * the emit OPTIONS argument, where createEvent reads it.
 *
 * Spawns no subprocess.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// MANDATORY. tests/setup.mjs installs a suite-wide vi.mock of both telemetry specifiers
// and replaces TelemetryCollector with a stub whose addListener is a NO-OP. Without this
// escape the listener below records nothing and the first requirement fails on zero.
// vi.unmock is one of the sanctioned escapes named in tests/setup.mjs, and vitest hoists
// it above the imports. Both specifiers are escaped, which is also what keeps this file
// classified UN-SHADOWED by tests/unit/telemetry-global-mock-triage.test.mjs — that guard
// treats a file that unmocks only the subpath while importing the barrel as NOT clean.
vi.unmock("@routekit/telemetry");
vi.unmock("@routekit/telemetry/collector");

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TelemetryCollector } from "@routekit/telemetry/collector";
import { generateReport } from "@routekit/telemetry/reports";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const EXEC_REL = "packages/mcp-rks/src/server/exec.mjs";
const EXEC_SRC = fs.readFileSync(path.join(REPO_ROOT, EXEC_REL), "utf8");

/**
 * Count PRODUCERS of an exec lifecycle event type, not literal occurrences.
 * The regression happened because a survey counted only literal emit sites and
 * concluded the top level was uninstrumented, while collector.startTimer("exec")
 * was silently producing the same types.
 */
const literalEmits = (src, type) =>
  [...src.matchAll(new RegExp(`collector\\.emit\\("${type.replace(".", "\\.")}"`, "g"))].length;
const timerStarts = (src) => [...src.matchAll(/collector\.startTimer\(\s*"exec"/g)].length;
const timerCompletes = (src) => [...src.matchAll(/telemetryTimer\.complete\(/g)].length;

/**
 * Every `collector.emit(` call in the source, split into its top-level arguments.
 * Balanced over (), {} and [], and skips string and template-literal contents, so a
 * `${...}` inside a payload value cannot unbalance it.
 */
function emitCalls(src) {
  const calls = [];
  const opener = "collector.emit(";
  let idx = src.indexOf(opener);
  while (idx !== -1) {
    const args = [];
    let depth = 0;
    let start = idx + opener.length;
    let i = start;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const close = src.indexOf(ch, i + 1);
        i = close;
        continue;
      }
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) {
        args.push(src.slice(start, i).trim());
        start = i + 1;
      }
    }
    const last = src.slice(start, i).trim();
    if (last.length > 0) args.push(last);
    calls.push({ index: idx, args });
    idx = src.indexOf(opener, i);
  }
  return calls;
}

const CALLS = emitCalls(EXEC_SRC);
const callsOf = (type) => CALLS.filter((c) => c.args[0] === `"${type}"`);
const onlyCall = (type, predicate = () => true) => {
  const matches = callsOf(type).filter(predicate);
  expect(matches, `exactly one ${type} emit matching the predicate`).toHaveLength(1);
  return matches[0];
};

describe("collector.startTimer emits a start event implicitly", () => {
  it("startTimer with type exec emits exactly one exec.start", () => {
    // No `enabled` option is passed: the collector derives `this.enabled` from
    // process.env.RKS_TELEMETRY and IGNORES any constructor option of that name, so
    // `{ enabled: true }` would be a decorative argument that proves nothing.
    const collector = new TelemetryCollector({});
    const seen = [];
    collector.addListener((ev) => seen.push(ev.type));
    collector.startTimer("exec", "test-proj", {});
    expect(seen.filter((t) => t === "exec.start")).toHaveLength(1);
  });
});

describe("exec.mjs emits exactly one start and one terminal per run", () => {
  it("declares exactly ONE exec.start producer", () => {
    expect(literalEmits(EXEC_SRC, "exec.start") + timerStarts(EXEC_SRC)).toBe(1);
  });

  it("declares exactly ONE exec.complete producer", () => {
    expect(literalEmits(EXEC_SRC, "exec.complete") + timerCompletes(EXEC_SRC)).toBe(1);
  });

  it("under A-prime the timer contributes ZERO producers of either type", () => {
    expect(timerStarts(EXEC_SRC)).toBe(0);
    expect(timerCompletes(EXEC_SRC)).toBe(0);
    // Positive control. Two zeroes prove nothing on their own — a broken counter returns
    // zero for everything. These two assertions show the same counters DO find the
    // literals, so the zeroes above are measurements rather than an instrument failure.
    expect(literalEmits(EXEC_SRC, "exec.start")).toBe(1);
    expect(literalEmits(EXEC_SRC, "exec.complete")).toBe(1);
  });
});

describe("the surviving terminals carry what a pass rate needs", () => {
  it("the argument splitter is sound — every exec emit has a type, a projectId and a payload", () => {
    const exec = CALLS.filter((c) => /^"exec\./.test(c.args[0]));
    expect(exec.length).toBeGreaterThanOrEqual(4);
    for (const c of exec) {
      expect(c.args.length).toBeGreaterThanOrEqual(3);
      expect(c.args[1]).toBe("projectId");
      expect(c.args[2].startsWith("{")).toBe(true);
    }
  });

  it("exec.complete carries attempts from the same attemptNumber runMeta.attempts records", () => {
    const [, , payload] = onlyCall("exec.complete").args;
    expect(payload).toMatch(/\battempts:\s*attemptNumber\b/);
    expect(EXEC_SRC).toMatch(/runMeta\.attempts\s*=\s*attemptNumber\b/);
  });

  it("exec.complete carries a runId", () => {
    const [, , payload] = onlyCall("exec.complete").args;
    expect(payload).toMatch(/\brunId:/);
  });

  it("exec.complete carries correlationId as the FOURTH argument, never in the payload", () => {
    // createEvent sets the event-level correlationId from options.correlationId alone, and
    // cost-report pairs exec.failed with a later exec.complete on ev.correlationId. A
    // payload placement would satisfy a looser wording and silently break that pairing.
    const { args } = onlyCall("exec.complete");
    expect(args).toHaveLength(4);
    expect(args[3]).toMatch(/^\{\s*correlationId\s*\}$/);
    expect(args[2]).not.toMatch(/\bcorrelationId\b/);
  });

  it("exec.start carries a runId computed BEFORE the emission", () => {
    const call = onlyCall("exec.start");
    expect(call.args[2]).toMatch(/\brunId:\s*runIdValue\b/);
    expect(call.args[3]).toMatch(/^\{\s*correlationId\s*\}$/);
    const declared = EXEC_SRC.indexOf("const runIdValue =");
    expect(declared).toBeGreaterThan(-1);
    expect(declared).toBeLessThan(call.index);
  });

  it("the tests-exhausted exec.failed keeps attempts and runId and gains a reason", () => {
    const { args } = onlyCall("exec.failed", (c) => /\btestsFailed:\s*true\b/.test(c.args[2]));
    expect(args[2]).toMatch(/\battempts:\s*attemptNumber\b/);
    expect(args[2]).toMatch(/\brunId:\s*runIdValue\b/);
    expect(args[2]).toMatch(/\breason:\s*"tests_exhausted"/);
    expect(args[3]).toMatch(/^\{\s*correlationId\s*\}$/);
  });

  it("the dirty-tree terminal is a literal exec.failed with reason, runId and durationMs", () => {
    const { args } = onlyCall("exec.failed", (c) => /\breason:\s*"dirty_tree"/.test(c.args[2]));
    expect(args[2]).toMatch(/\brunId:\s*runIdValue\b/);
    expect(args[2]).toMatch(/\bdurationMs:/);
    expect(args[3]).toMatch(/^\{\s*correlationId\s*\}$/);
  });

  it("every emit this story touched carries correlationId ONLY in the options argument", () => {
    const touched = [
      ["exec.start", onlyCall("exec.start")],
      ["exec.complete", onlyCall("exec.complete")],
      ["tests-exhausted exec.failed", onlyCall("exec.failed", (c) => /\btestsFailed:\s*true\b/.test(c.args[2]))],
      ["dirty-tree exec.failed", onlyCall("exec.failed", (c) => /\breason:\s*"dirty_tree"/.test(c.args[2]))],
    ];
    for (const [label, { args }] of touched) {
      expect(args, label).toHaveLength(4);
      expect(args[3], label).toMatch(/^\{\s*correlationId\s*\}$/);
      expect(args[2], label).not.toMatch(/\bcorrelationId\b/);
    }
  });

  it("telemetryTimer has ZERO remaining consumers, and the same run finds the literals", () => {
    expect([...EXEC_SRC.matchAll(/\btelemetryTimer\b/g)]).toHaveLength(0);
    // Positive control on the same source and the same run: the instrument is live.
    expect(callsOf("exec.failed").length).toBeGreaterThanOrEqual(2);
    expect(callsOf("exec.start")).toHaveLength(1);
    expect(callsOf("exec.complete")).toHaveLength(1);
  });
});

describe("first-attempt pass rate is computable from the stream as emitted", () => {
  it("two starts, one first-attempt complete and one failure yield one half", () => {
    const stream = [
      { type: "exec.start", payload: { runId: "run-a" } },
      { type: "exec.start", payload: { runId: "run-b" } },
      { type: "exec.complete", payload: { runId: "run-a", attempts: 1 } },
      { type: "exec.failed", payload: { runId: "run-b", reason: "tests_exhausted", attempts: 3 } },
    ];
    // No de-duplication step: under A-prime each run emits one start and one terminal.
    const runs = new Set(stream.filter((e) => e.type === "exec.start").map((e) => e.payload.runId));
    const firstAttemptPasses = stream.filter((e) => e.type === "exec.complete" && e.payload.attempts === 1).length;

    expect(runs.size).toBe(2);
    expect(firstAttemptPasses / runs.size).toBe(0.5);
  });
});

describe("the failures report buckets the tests-exhausted terminal by its reason", () => {
  const roots = [];
  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  });

  it("lands in a reason-named bucket, not the unspecified one", async () => {
    // The reason is read from the emit in exec.mjs, not restated.
    const { args } = onlyCall("exec.failed", (c) => /\btestsFailed:\s*true\b/.test(c.args[2]));
    const reason = /\breason:\s*"([^"]+)"/.exec(args[2])?.[1];
    expect(reason).toBe("tests_exhausted");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "exec-failures-bucket-"));
    roots.push(root);
    const dir = path.join(root, ".rks", "telemetry");
    fs.mkdirSync(dir, { recursive: true });
    const events = [
      { type: "exec.failed", payload: { reason, testsFailed: true, attempts: 3, runId: "run-b" } },
      // Positive control: a reasonless failure DOES land in the unspecified bucket.
      { type: "exec.failed", payload: {} },
    ];
    fs.writeFileSync(
      path.join(dir, "events-2026-09-01.jsonl"),
      events.map((e) => JSON.stringify({ timestamp: "2026-09-01T12:00:00.000Z", ...e })).join("\n") + "\n",
    );

    const { failures } = await generateReport(root, { reportType: "failures" });
    expect(failures["exec.failed"], "the report read the fixture store").toBeDefined();
    const byReason = failures["exec.failed"].byReason;
    const named = Object.entries(byReason).filter(([, v]) => v.example === reason);

    expect(named).toHaveLength(1);
    expect(named[0][0]).not.toBe("UNKNOWN");
    expect(named[0][1].count).toBe(1);
    expect(byReason.UNKNOWN?.count).toBe(1);
  });
});

describe("exec.start and exec.complete each have ONE emit site across packages/mcp-rks/src", () => {
  const SRC_ROOT = path.join(REPO_ROOT, "packages/mcp-rks/src");
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|js)$/.test(entry.name)) files.push(full);
    }
  })(SRC_ROOT);

  /** Emit SITES, not mentions: whole-line comments are dropped before counting. */
  const code = (file) =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");

  const sites = (type, quote) => {
    const re = new RegExp(`\\bemit\\(\\s*${quote}${type.replace(".", "\\.")}${quote}`, "g");
    const hits = [];
    for (const file of files) {
      const n = [...code(file).matchAll(re)].length;
      for (let k = 0; k < n; k++) hits.push(path.relative(REPO_ROOT, file).split(path.sep).join("/"));
    }
    return hits;
  };

  it("positive control on each quote form — neither zero below is blind", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(sites("exec.failed", '"').length).toBeGreaterThanOrEqual(2);
    expect(sites("exec.rollback", "'").length).toBeGreaterThanOrEqual(1);
  });

  it.each(["exec.start", "exec.complete"])("%s has exactly one emit site, in exec.mjs", (type) => {
    expect(sites(type, '"')).toEqual([EXEC_REL]);
    expect(sites(type, "'")).toEqual([]);
  });
});
