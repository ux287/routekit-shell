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
//   }
//
// Outcomes of resolveFullSuiteGateConfig / runFullSuiteGate:
//   - not_configured           no project.json, or no fullSuiteGate key   → ran false, blocked false
//   - disabled                 enabled: false                             → ran false, blocked false
//   - project_json_unreadable  project.json exists but is not parseable   → ran false, blocked false,
//                              logged via console.error
//   - misconfigured            a present but malformed fullSuiteGate      → ran false, blocked TRUE
//                              (fail closed: never a pass, never a silent skip)
//
// When the suite runs, every field of the result is sourced from the runProjectTests result
// (the argv it spawned, its exit code, its output and its per-node-ID sets), never from config.
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
 *   { enabled: true, knownFailing, command, timeoutMs }
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

  return { enabled: true, knownFailing, command, timeoutMs };
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

/** The compact ship-step record for an applicable gate result. `ok` is derived, never a literal. */
export function fullSuiteGateStep(result) {
  return {
    step: "full_suite_gate",
    ok: result.blocked !== true,
    ran: result.ran === true,
    reason: result.reason,
    ...(result.commands ? { commands: result.commands } : { command: result.command ?? null }),
    resultsSource: result.resultsSource ?? null,
    exitCode: result.exitCode ?? null,
    counts: result.counts ?? null,
    newFailures: result.newFailures ?? [],
    fixed: result.fixed ?? [],
  };
}

/**
 * Run the opt-in full-suite gate for a project. Synchronous; never throws.
 *
 * options.runTests — injectable runner with runProjectTests' signature (tests inject a stub).
 */
export function runFullSuiteGate(projectRoot, options = {}) {
  const runTests = typeof options.runTests === "function" ? options.runTests : runProjectTests;
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
  let result;
  try {
    result = runTests(projectRoot, {
      testPaths: null,
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

  const evidence = {
    ran: true,
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
  if (newFailures.length > 0) {
    return { ...evidence, blocked: true, reason: "new_failures" };
  }
  if (evidence.exitCode !== 0 && nowFailing.length === 0) {
    return { ...evidence, blocked: true, reason: "exit_nonzero_without_failing_ids" };
  }
  return { ...evidence, blocked: false, reason: "no_new_failures" };
}
