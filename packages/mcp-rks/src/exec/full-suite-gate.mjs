// Opt-in full-suite regression gate (backlog.feat.full-suite-regression-gate).
// Blocks only on failing node IDs absent from the baseline; never on counts.
//
// OPT-IN ONLY. The gate is configured by the `fullSuiteGate` key of the project's OWN
// `.rks/project.json` and nothing else — no user-level or machine-level source is read.
// An absent key means no gate: no test run, no step, no new field on any ship result.
//
//   fullSuiteGate: {
//     enabled: true,                       // required boolean
//     knownFailing: ["tests/a.py::test_x"], // runner-native node IDs (the baseline), default []
//     command: { cmd: "npx", args: ["vitest", "run"] }, // optional argv override, default null
//     timeoutMs: 300000,                   // optional positive number, default 300000
//     testPaths: ["tests/unit/a.test.mjs"], // optional non-empty list of repo-relative existing test
//                                          // files; absent = the whole suite (testPaths: null)
//   }
//
// testPaths (backlog.feat.ship-gate-repo-guard-tests) scopes the run: the list is handed to
// runProjectTests, which partitions it per vitest config tier (one synchronous spawn per tier).
// testPaths together with command is misconfigured: a command override bypasses that per-tier
// partitioning. A project-declared testCommand is NOT rejected: runProjectTests appends the paths
// to it as one spawn, and a runner whose node ids are not `path > ...` (pytest's `::`) leaves
// every path unobserved, which blocks (fails closed).
//
// Outcomes of resolveFullSuiteGateConfig / runFullSuiteGate:
//   - not_configured           no project.json, or no fullSuiteGate key   → ran false, blocked false
//   - disabled                 enabled: false                             → ran false, blocked false
//   - project_json_unreadable  project.json exists but is not parseable   → ran false, blocked false,
//                              logged via console.error
//   - misconfigured            a present but malformed fullSuiteGate      → ran false, blocked TRUE
//                              (fail closed: never a pass, never a silent skip)
//   - full_suite_gate_path_unobserved  a scoped run in which a configured path is absent from the
//                              observed argv, or has no observed node id  → ran true, blocked TRUE
//
// When the suite runs, every field of the result is sourced from the runProjectTests result
// (the argv it spawned, its exit code, its output and its per-node-ID sets), never from config.
// `scope` reports the gate's own runTests argument ("full" for testPaths null, "paths" for the
// configured list); the reported `testPaths` are only the configured paths found in the OBSERVED
// argv, and `unobservedPaths` the configured paths the run did not observe.
import fs from "fs";
import path from "path";
import { runProjectTests, stripAnsi } from "./command-runner.mjs";

export const FULL_SUITE_GATE_DEFAULT_TIMEOUT_MS = 300000;
export const FULL_SUITE_GATE_OUTPUT_TAIL_LINES = 40;
const REPORT_NAME = "full-suite-gate-results.json";

const errMessage = (err) => (err && err.message ? err.message : String(err));
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Resolve the gate's configuration from `<projectRoot>/.rks/project.json` only. Never throws.
 *
 * Returns one of:
 *   { enabled: true, knownFailing, command, timeoutMs }            (testPaths absent)
 *   { enabled: true, knownFailing, command, timeoutMs, testPaths } (testPaths configured)
 *   { enabled: false, reason: "not_configured" | "disabled" }
 *   { enabled: false, reason: "project_json_unreadable", detail }
 *   { enabled: false, misconfigured: true, reason: "misconfigured", field, detail }
 */
export function resolveFullSuiteGateConfig(projectRoot) {
  const configPath = path.join(projectRoot, ".rks", "project.json");
  let parsed;
  try {
    if (!fs.existsSync(configPath)) return { enabled: false, reason: "not_configured" };
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    return { enabled: false, reason: "project_json_unreadable", detail: errMessage(err) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { enabled: false, reason: "project_json_unreadable", detail: "project.json is not a JSON object" };
  }

  const raw = parsed.fullSuiteGate;
  if (raw === undefined) return { enabled: false, reason: "not_configured" };

  const misconfigured = (field, detail) => ({ enabled: false, misconfigured: true, reason: "misconfigured", field, detail });

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return misconfigured("fullSuiteGate", "fullSuiteGate must be an object such as { enabled: true }");
  }
  if (typeof raw.enabled !== "boolean") {
    return misconfigured("fullSuiteGate.enabled", "fullSuiteGate.enabled must be a boolean");
  }
  if (raw.enabled === false) return { enabled: false, reason: "disabled" };

  let knownFailing = [];
  if (raw.knownFailing !== undefined) {
    if (!isStringArray(raw.knownFailing)) {
      return misconfigured("fullSuiteGate.knownFailing", "fullSuiteGate.knownFailing must be an array of node-ID strings");
    }
    knownFailing = [...new Set(raw.knownFailing)];
  }

  let command = null;
  if (raw.command !== undefined) {
    const c = raw.command;
    if (!c || typeof c !== "object" || Array.isArray(c) || typeof c.cmd !== "string" || c.cmd.trim() === "") {
      return misconfigured("fullSuiteGate.command", "fullSuiteGate.command must be an object with a non-empty string cmd");
    }
    if (c.args !== undefined && !isStringArray(c.args)) {
      return misconfigured("fullSuiteGate.command", "fullSuiteGate.command.args must be an array of strings");
    }
    command = { cmd: c.cmd, args: Array.isArray(c.args) ? [...c.args] : [] };
  }

  let timeoutMs = FULL_SUITE_GATE_DEFAULT_TIMEOUT_MS;
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== "number" || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0) {
      return misconfigured("fullSuiteGate.timeoutMs", "fullSuiteGate.timeoutMs must be a positive number");
    }
    timeoutMs = raw.timeoutMs;
  }

  if (raw.testPaths === undefined) return { enabled: true, knownFailing, command, timeoutMs };

  const field = "fullSuiteGate.testPaths";
  const tp = raw.testPaths;
  if (!Array.isArray(tp) || tp.length === 0) {
    return misconfigured(field, "fullSuiteGate.testPaths must be a non-empty array of repo-relative test file paths");
  }
  for (const entry of tp) {
    if (typeof entry !== "string" || entry.trim() === "") {
      return misconfigured(field, "fullSuiteGate.testPaths entries must be non-empty strings");
    }
    if (path.isAbsolute(entry) || path.win32.isAbsolute(entry)) {
      return misconfigured(field, `fullSuiteGate.testPaths entry ${JSON.stringify(entry)} must be repo-relative, not absolute`);
    }
    if (entry.split(/[\\/]/).includes("..")) {
      return misconfigured(field, `fullSuiteGate.testPaths entry ${JSON.stringify(entry)} must not contain a .. segment`);
    }
    let isFile = false;
    try { isFile = fs.statSync(path.join(projectRoot, entry)).isFile(); } catch { isFile = false; }
    if (!isFile) {
      return misconfigured(field, `fullSuiteGate.testPaths entry ${JSON.stringify(entry)} is not an existing file under the project root`);
    }
  }
  if (command) {
    return misconfigured(
      field,
      "fullSuiteGate.testPaths cannot be combined with fullSuiteGate.command (a command override bypasses per-tier partitioning)",
    );
  }

  return { enabled: true, knownFailing, command, timeoutMs, testPaths: [...new Set(tp)] };
}

/** New failures are node IDs failing now and absent from the baseline; fixed is the reverse. */
export function diffFailingNodeIds({ baselineFailing = [], nowFailing = [] } = {}) {
  const base = new Set(baselineFailing);
  const now = new Set(nowFailing);
  return {
    newFailures: [...now].filter((id) => !base.has(id)),
    fixed: [...base].filter((id) => !now.has(id)),
  };
}

/** The last N lines of the ANSI-stripped output. */
function tailLines(output, n = FULL_SUITE_GATE_OUTPUT_TAIL_LINES) {
  const text = stripAnsi(typeof output === "string" ? output : "");
  if (text === "") return "";
  const lines = text.replace(/\n+$/, "").split("\n");
  return lines.slice(-n).join("\n");
}

/**
 * True when the gate result must be reflected on a ship result — it ran, or it blocks.
 * False for not_configured / disabled / project_json_unreadable, which add nothing anywhere.
 */
export function fullSuiteGateApplies(result) {
  if (!result || typeof result !== "object") return false;
  return result.ran === true || result.blocked === true;
}

/**
 * The compact ship-step record for an applicable gate result. `ok` is derived, never a literal.
 *
 * observed — optional { landing, testedSha } (backlog.feat.landing-gate-combined-tree-test).
 * When `landing` (a prepareLandingCandidate result) is supplied, the step also reports the
 * tested tree: `testedSha` is the HEAD the call site read AFTER the run, and preparedSha,
 * targetSha, mergedTarget and landingTarget come from that observed preparation, plus the
 * observed story testFiles (`extraTestPaths`). With no landing the step carries none of them.
 */
export function fullSuiteGateStep(result, observed = undefined) {
  const landing = observed && observed.landing && typeof observed.landing === "object" ? observed.landing : null;
  return {
    step: "full_suite_gate",
    ok: result.blocked !== true,
    ran: result.ran === true,
    reason: result.reason,
    scope: result.scope ?? null,
    ...(result.scope === "paths"
      ? { testPaths: result.testPaths ?? [], unobservedPaths: result.unobservedPaths ?? [] }
      : {}),
    ...(result.commands ? { commands: result.commands } : { command: result.command ?? null }),
    resultsSource: result.resultsSource ?? null,
    exitCode: result.exitCode ?? null,
    counts: result.counts ?? null,
    newFailures: result.newFailures ?? [],
    fixed: result.fixed ?? [],
    ...(landing
      ? {
          testedSha: observed.testedSha ?? null,
          preparedSha: landing.preparedSha ?? null,
          targetSha: landing.targetSha ?? null,
          mergedTarget: landing.mergedTarget === true,
          landingTarget: landing.target ?? null,
          extraTestPaths: result.extraTestPaths ?? [],
        }
      : {}),
  };
}

/**
 * Run the opt-in full-suite gate for a project. Synchronous; never throws.
 *
 * options.runTests — injectable runner with runProjectTests' signature (tests inject a stub).
 * options.extraTestPaths — the story's testFiles, repo-relative (backlog.feat.landing-gate-combined-tree-test).
 *   With configured testPaths the run scope is the de-duplicated union, and every extra path is
 *   held to the same observed-path rule; with a whole-suite gate they add nothing; null or []
 *   is exactly an absent option. They never make an inert (not_configured / disabled) gate run.
 */
export function runFullSuiteGate(projectRoot, options = {}) {
  const runTests = typeof options.runTests === "function" ? options.runTests : runProjectTests;
  const extraTestPaths = Array.isArray(options.extraTestPaths)
    ? [...new Set(options.extraTestPaths.filter((p) => typeof p === "string" && p.trim() !== "").map((p) => p.trim()))]
    : [];
  const config = resolveFullSuiteGateConfig(projectRoot);

  if (!config.enabled) {
    if (config.reason === "misconfigured") {
      console.error(`[rks.full-suite-gate] blocking: ${config.detail} (in .rks/project.json)`);
      return { ran: false, blocked: true, reason: "misconfigured", field: config.field, detail: config.detail };
    }
    if (config.reason === "project_json_unreadable") {
      console.error(
        `[rks.full-suite-gate] .rks/project.json could not be read (${config.detail}); ` +
          `full-suite gate not run (reason: project_json_unreadable)`,
      );
      return { ran: false, blocked: false, reason: "project_json_unreadable", detail: config.detail };
    }
    return { ran: false, blocked: false, reason: config.reason };
  }

  const baselineFailing = [...config.knownFailing];
  // Scoped run: the configured paths plus the story's extra paths, de-duplicated. A whole-suite
  // gate (no testPaths) already runs every file, so extras add nothing there.
  const configuredPaths = Array.isArray(config.testPaths) ? [...new Set([...config.testPaths, ...extraTestPaths])] : null;
  const requestedExtras = configuredPaths ? extraTestPaths : [];
  // The scope of the runTests call the gate makes below, not a config echo.
  const scope = configuredPaths ? "paths" : "full";
  let result;
  try {
    result = runTests(projectRoot, {
      testPaths: configuredPaths ? [...configuredPaths] : null,
      timeout: config.timeoutMs,
      collectTestResults: { reportName: REPORT_NAME },
      ...(config.command ? { command: config.command } : {}),
    });
  } catch (err) {
    return {
      ran: false,
      blocked: true,
      reason: "run_threw",
      detail: errMessage(err),
      available: false,
      baselineFailing,
      nowFailing: [],
      newFailures: [],
      fixed: [],
    };
  }

  if (!result || typeof result !== "object") {
    return { ran: false, blocked: true, reason: "no_result", available: false, baselineFailing, nowFailing: [], newFailures: [], fixed: [] };
  }

  if (result.skipped === true) {
    return {
      ran: false,
      blocked: true,
      reason: "no_test_runner",
      detail: result.reason ?? null,
      available: false,
      baselineFailing,
      nowFailing: [],
      newFailures: [],
      fixed: [],
    };
  }

  // Everything below is observed from the run, never copied from config.
  const tr = result.testResults && typeof result.testResults === "object" ? result.testResults : null;
  const available = tr ? tr.available === true : false;
  const nowFailing = available
    ? [...new Set([...(tr.failing || []), ...(tr.failed || []), ...(tr.error || [])])]
    : [];
  const { newFailures, fixed } = available
    ? diffFailingNodeIds({ baselineFailing, nowFailing })
    : { newFailures: [], fixed: [] };

  // Scoped run: a configured path is reported only when it is in the OBSERVED argv, and is
  // observed only when, in addition, some node id equals it or begins with it plus " > ".
  let pathEvidence = {};
  if (scope === "paths") {
    const observedArgv = Array.isArray(result.commands)
      ? result.commands.flatMap((c) => (c && Array.isArray(c.args) ? c.args : []))
      : (result.command && Array.isArray(result.command.args) ? result.command.args : []);
    const configured = new Set(configuredPaths);
    const testPaths = [...new Set(observedArgv.filter((a) => configured.has(a)))];
    const inArgv = new Set(testPaths);
    const nodeIds = tr
      ? ["passed", "failed", "failing", "error", "skipped"].flatMap((k) => (Array.isArray(tr[k]) ? tr[k] : []))
      : [];
    const hasNode = (p) => nodeIds.some((id) => typeof id === "string" && (id === p || id.startsWith(`${p} > `)));
    const unobservedPaths = configuredPaths.filter((p) => !inArgv.has(p) || !hasNode(p));
    pathEvidence = { testPaths, unobservedPaths };
    if (requestedExtras.length > 0) {
      // the story testFiles the observed argv actually carried
      pathEvidence.extraTestPaths = requestedExtras.filter((p) => inArgv.has(p));
    }
  }

  const evidence = {
    ran: true,
    scope,
    ...pathEvidence,
    ...(Array.isArray(result.commands) ? { commands: result.commands } : { command: result.command ?? null }),
    resultsSource: available ? tr.source ?? null : null,
    available,
    exitCode: result.exitCode ?? null,
    outputTail: tailLines(result.output),
    counts: available
      ? {
          passed: Array.isArray(tr.passed) ? tr.passed.length : 0,
          failing: nowFailing.length,
          skipped: Array.isArray(tr.skipped) ? tr.skipped.length : 0,
        }
      : null,
    baselineFailing,
    nowFailing,
    newFailures,
    fixed,
  };

  if (result.noTestsFound === true) {
    return { ...evidence, blocked: true, reason: "no_tests_found" };
  }
  if (!available) {
    return { ...evidence, blocked: true, reason: (tr && tr.reason) || "results_unavailable" };
  }
  if (scope === "paths" && evidence.unobservedPaths.length > 0) {
    return { ...evidence, blocked: true, reason: "full_suite_gate_path_unobserved" };
  }
  if (newFailures.length > 0) {
    return { ...evidence, blocked: true, reason: "new_failures" };
  }
  if (evidence.exitCode !== 0 && nowFailing.length === 0) {
    return { ...evidence, blocked: true, reason: "exit_nonzero_without_failing_ids" };
  }
  return { ...evidence, blocked: false, reason: "no_new_failures" };
}
