/**
 * Per-test result collection for the declared-red baseline
 * (backlog.feat.exec-declared-red-baseline-tests). Pure functions only: no spawning,
 * no file writes. A result is `available: true` only when observed output proves it complete.
 *
 * Every ambiguity resolves to a REFUSAL, never a false proof: `passed` is populated only from
 * suffix-free PASSED lines, a mis-split id either lands an undeclared id in the failing set
 * (baseline_failed) or leaves a declared id unobserved (id_not_observed), and a spurious or
 * missing outcome line changes a parsed count (count_mismatch).
 */
import path from "path";

export const UNAVAILABLE = (reason) => ({ available: false, reason, failed: [], passed: [], skipped: [] });

/** Detect the result adapter from a resolved argv. Returns "pytest" | "vitest" | null. */
export function detectResultAdapter(cmd, args = []) {
  const tokens = [cmd, ...args].filter((t) => typeof t === "string").map((t) => path.basename(t));
  if (tokens.some((t) => t === "pytest" || t === "py.test")) return "pytest";
  if (tokens.some((t) => t === "vitest" || t === "vitest-runner.mjs")) return "vitest";
  return null;
}

/** Split a baselineRedTests entry into { file, testId|null, style }. */
export function parseDeclaredEntry(entry) {
  if (entry.includes("::")) return { file: entry.split("::")[0], testId: entry, style: "pytest" };
  if (entry.includes(" > ")) return { file: entry.split(" > ")[0], testId: entry, style: "vitest" };
  return { file: entry, testId: null, style: "file" };
}

/**
 * The argv an adapter needs to report per-test outcomes. The caller places pytest's flags
 * AFTER the declared args (`-r` and `--color` are last-occurrence-wins) and before testPaths.
 */
export function resultCollectionArgs(adapter, { builtin, reportPath }) {
  if (adapter === "pytest") return ["-rA", "--color=no"];
  if (adapter === "vitest") return builtin ? ["--json-output", reportPath] : ["--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`];
  return [];
}

// ── pytest short test summary (-rA) ─────────────────────────────────

const SUMMARY_HEADER = /^=+ short test summary info =+$/;
const COUNTS_LINE = /^(?:=+ )?(no tests ran|\d+ [a-z]+(?:, \d+ [a-z]+)*) in \d+(?:\.\d+)?s(?: \([^)]*\))?(?: =+)?$/;
const SEPARATOR_LINE = /^[=-]{3,}/;
const OUTCOME_LINE = /^(PASSED|FAILED|ERROR|XFAIL|XPASS) (\S.*)$/;
const SKIP_LINE = /^SKIPPED \[(\d+)\] \S/;
// Lines whose untrimmed message (running_on_ci) may continue onto following lines.
const CONTINUABLE = new Set(["FAILED", "ERROR", "XFAIL"]);
// Final-line term → the parsed-line bucket it is reconciled against.
const RECONCILED_TERMS = {
  passed: "passed", failed: "failed", error: "error", errors: "error",
  skipped: "skipped", xfailed: "xfailed", xpassed: "xpassed",
};

/**
 * The id rule. FAILED/ERROR/XFAIL separate the message with " - ", XPASS with a plain space,
 * PASSED carries no suffix at all. A parametrized id is kept whole: the shortest prefix ending
 * in "]" that is followed by the separator or end-of-line.
 */
function splitOutcomeId(word, rest) {
  if (word === "PASSED") return rest;
  const sep = word === "XPASS" ? " " : " - ";
  const firstSep = rest.indexOf(sep);
  const prefix = firstSep === -1 ? rest : rest.slice(0, firstSep);
  const lastColons = prefix.lastIndexOf("::");
  const segment = lastColons === -1 ? prefix : prefix.slice(lastColons + 2);
  if (segment.includes("[")) {
    for (let j = rest.indexOf("]"); j !== -1; j = rest.indexOf("]", j + 1)) {
      if (j + 1 === rest.length || rest.startsWith(sep, j + 1)) return rest.slice(0, j + 1);
    }
  }
  return prefix;
}

/** An outcome id's path part (before the first "::") must hold no ":" — rejects log lines. */
function idPathIsValid(id) {
  const cut = id.indexOf("::");
  return !(cut === -1 ? id : id.slice(0, cut)).includes(":");
}

const uniq = (xs) => [...new Set(xs)];

/**
 * Parse pytest's `-rA` short test summary out of runProjectTests output (already ANSI-stripped).
 * Returns { available: true, runner, source, passed, failed, error, failing, xfailed, xpassed,
 * skipped: [], skippedCount, deselectedCount } or UNAVAILABLE(reason).
 */
export function parsePytestSummary(output) {
  const lines = String(output || "").split("\n").map((l) => l.replace(/\r$/, ""));

  let header = -1;
  lines.forEach((l, i) => { if (SUMMARY_HEADER.test(l)) header = i; });
  if (header === -1) {
    const counts = lines.filter((l) => COUNTS_LINE.test(l));
    const last = counts.length > 0 ? counts[counts.length - 1].match(COUNTS_LINE)[1] : null;
    if (last === "no tests ran") return pytestResult({ passed: [], failed: [], error: [], xfailed: [], xpassed: [], skippedCount: 0, deselectedCount: 0 });
    return { ...UNAVAILABLE("summary_absent"), runner: "pytest" };
  }

  const sets = { passed: [], failed: [], error: [], xfailed: [], xpassed: [] };
  const lineCounts = { passed: 0, failed: 0, error: 0, skipped: 0, xfailed: 0, xpassed: 0 };
  const BUCKET = { PASSED: "passed", FAILED: "failed", ERROR: "error", XFAIL: "xfailed", XPASS: "xpassed" };
  let lastClassified = null;
  let regionEnd = lines.length;

  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i];
    if (SEPARATOR_LINE.test(line) || COUNTS_LINE.test(line)) { regionEnd = i; break; }
    // A blank line carries no outcome; the count reconciliation still backstops it.
    if (line.trim() === "") continue;

    const outcome = line.match(OUTCOME_LINE);
    if (outcome) {
      const id = splitOutcomeId(outcome[1], outcome[2]);
      if (idPathIsValid(id)) {
        const bucket = BUCKET[outcome[1]];
        sets[bucket].push(id);
        lineCounts[bucket]++;
        lastClassified = outcome[1];
        continue;
      }
    }
    const skip = line.match(SKIP_LINE);
    if (skip) {
      lineCounts.skipped += parseInt(skip[1], 10);
      lastClassified = "SKIPPED";
      continue;
    }
    if (CONTINUABLE.has(lastClassified)) continue; // message continuation — ignored
    return { ...UNAVAILABLE("unrecognized_summary_line"), runner: "pytest" };
  }

  let countsText = null;
  for (let i = regionEnd; i < lines.length; i++) {
    const m = lines[i].match(COUNTS_LINE);
    if (m) { countsText = m[1]; break; }
  }
  if (countsText === null) return { ...UNAVAILABLE("summary_counts_absent"), runner: "pytest" };

  const terms = { passed: 0, failed: 0, error: 0, skipped: 0, xfailed: 0, xpassed: 0 };
  let deselectedCount = 0;
  if (countsText !== "no tests ran") {
    for (const part of countsText.split(", ")) {
      const [n, term] = part.split(" ");
      const value = parseInt(n, 10);
      if (term === "rerun" || term === "reruns") return { ...UNAVAILABLE("rerun_not_supported"), runner: "pytest" };
      if (term === "warning" || term === "warnings") continue;
      if (term === "deselected") { deselectedCount += value; continue; }
      const bucket = RECONCILED_TERMS[term];
      if (!bucket) return { ...UNAVAILABLE("unrecognized_summary_term"), runner: "pytest" };
      terms[bucket] += value;
    }
  }
  for (const k of Object.keys(terms)) {
    if (terms[k] !== lineCounts[k]) return { ...UNAVAILABLE("count_mismatch"), runner: "pytest" };
  }

  return pytestResult({ ...sets, skippedCount: lineCounts.skipped, deselectedCount });
}

/** Apply the dual-outcome rule (a PASSED id also FAILED/ERROR is failing) and shape the result. */
function pytestResult({ passed, failed, error, xfailed, xpassed, skippedCount, deselectedCount }) {
  const failing = uniq([...failed, ...error]);
  return {
    available: true,
    runner: "pytest",
    source: "pytest_short_summary",
    passed: uniq(passed).filter((id) => !failing.includes(id)),
    failed: uniq(failed),
    error: uniq(error),
    failing,
    xfailed: uniq(xfailed),
    xpassed: uniq(xpassed),
    skipped: [],
    skippedCount,
    deselectedCount,
  };
}

// ── vitest JSON reporter ────────────────────────────────────────────

const VITEST_SKIPPED = new Set(["skipped", "pending", "todo", "disabled"]);

/**
 * Parse a vitest JSON report (its text, or an already-parsed object). Ids are
 * `rel/path > describe > title` with empty ancestor titles dropped; a failed file with no
 * assertion results (a load failure) is a file-level failing id.
 */
export function parseVitestJsonReport(report, projectRoot) {
  if (report === null || report === undefined || report === "") return { ...UNAVAILABLE("report_missing"), runner: "vitest" };
  let data = report;
  if (typeof report === "string") {
    try { data = JSON.parse(report); } catch { return { ...UNAVAILABLE("report_unparseable"), runner: "vitest" }; }
  }
  if (!data || !Array.isArray(data.testResults)) return { ...UNAVAILABLE("report_malformed"), runner: "vitest" };

  const passed = [];
  const failed = [];
  const skipped = [];
  for (const file of data.testResults) {
    if (!file || typeof file.name !== "string") return { ...UNAVAILABLE("report_malformed"), runner: "vitest" };
    const rel = (path.isAbsolute(file.name) && projectRoot ? path.relative(projectRoot, file.name) : file.name).split(path.sep).join("/");
    const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    if (assertions.length === 0) {
      if (file.status === "failed") failed.push(rel);
      continue;
    }
    for (const a of assertions) {
      const id = [rel, ...(Array.isArray(a.ancestorTitles) ? a.ancestorTitles : []), a.title].filter((t) => typeof t === "string" && t !== "").join(" > ");
      if (a.status === "passed") passed.push(id);
      else if (a.status === "failed") failed.push(id);
      else if (VITEST_SKIPPED.has(a.status)) skipped.push(id);
      else return { ...UNAVAILABLE("unrecognized_status"), runner: "vitest" };
    }
  }
  const failing = uniq(failed);
  return {
    available: true,
    runner: "vitest",
    source: "vitest_json",
    passed: uniq(passed).filter((id) => !failing.includes(id)),
    failed: failing,
    error: [],
    failing,
    xfailed: [],
    xpassed: [],
    skipped: uniq(skipped).filter((id) => !failing.includes(id)),
    skippedCount: skipped.length,
    deselectedCount: 0,
  };
}

// ── Declared-red evaluation ─────────────────────────────────────────

const failingOf = (results) => uniq([...(results.failing || []), ...(results.failed || []), ...(results.error || [])]);

/** The file-part checks every entry must pass before anything is observed. */
export function invalidDeclaredFiles({ entries, testFiles, existingTestFiles }) {
  const invalid = [];
  for (const entry of entries) {
    const { file } = parseDeclaredEntry(entry);
    if (!(testFiles || []).includes(file)) invalid.push({ entry, why: "not_in_testFiles" });
    else if (!(existingTestFiles || []).includes(file)) invalid.push({ entry, why: "file_absent" });
  }
  return invalid;
}

/** Why a pytest id is in no observed set: the -rA skip lines carry no node id. */
function notObservedCause(results) {
  if (results.runner !== "pytest") return "not_in_results";
  if (results.skippedCount > 0) return "pytest_skip_unattributable";
  if (results.deselectedCount > 0) return "deselected_or_absent";
  return "not_in_results";
}

/**
 * Pre-apply proof. Proceeds iff every failing id is declared (or inside a declared file) and every
 * per-test declaration is observed. Refusal order follows the note: file validation, then the
 * subset rule, then existence; each refusal still carries the other lists when non-empty.
 *
 * @returns {{ ok: true, observedFailing, stale }
 *          | { ok: false, reason, invalidDeclarations?, undeclaredFailing?, observedFailing?, stale? }}
 */
export function evaluateDeclaredRed({ entries, testFiles, existingTestFiles, results }) {
  const fileInvalid = invalidDeclaredFiles({ entries, testFiles, existingTestFiles });
  if (fileInvalid.length > 0) return { ok: false, reason: "baseline_red_declaration_invalid", invalidDeclarations: fileInvalid };
  if (!results?.available) {
    return { ok: false, reason: "baseline_red_results_unavailable", runner: results?.runner || null, resultsUnavailableReason: results?.reason || null };
  }

  const parsed = entries.map((entry) => ({ entry, ...parseDeclaredEntry(entry) }));
  const failing = failingOf(results);
  const declaredIds = new Set(parsed.filter((p) => p.testId).map((p) => p.testId));
  const declaredFiles = new Set(parsed.filter((p) => !p.testId).map((p) => p.file));
  const inDeclaredFile = (id) => declaredFiles.has(parseDeclaredEntry(id).file);

  const undeclaredFailing = failing.filter((id) => !declaredIds.has(id) && !inDeclaredFile(id));
  const stale = [];
  const invalid = [];
  for (const p of parsed) {
    if (!p.testId) {
      if (!failing.some((id) => parseDeclaredEntry(id).file === p.file)) stale.push(p.entry);
      continue;
    }
    if (failing.includes(p.testId)) continue;
    if (results.xfailed?.includes(p.testId)) { invalid.push({ entry: p.entry, why: "outcome_not_declarable", outcome: "xfailed" }); continue; }
    if (results.xpassed?.includes(p.testId)) { invalid.push({ entry: p.entry, why: "outcome_not_declarable", outcome: "xpassed" }); continue; }
    if (results.passed?.includes(p.testId)) { stale.push(p.entry); continue; }
    // Only an adapter that reports skips per id (vitest JSON) can make a skipped id stale.
    if (results.skipped?.includes(p.testId)) { stale.push(p.entry); continue; }
    invalid.push({ entry: p.entry, why: "id_not_observed", cause: notObservedCause(results) });
  }

  const extra = {
    observedFailing: failing,
    stale,
    ...(invalid.length > 0 ? { invalidDeclarations: invalid } : {}),
    ...(undeclaredFailing.length > 0 ? { undeclaredFailing } : {}),
  };
  if (undeclaredFailing.length > 0) return { ok: false, reason: "baseline_failed", ...extra };
  if (invalid.length > 0) return { ok: false, reason: "baseline_red_declaration_invalid", ...extra };
  return { ok: true, observedFailing: failing, stale };
}

/** Post-apply: every per-test declared id must be observed passed and not failing. */
export function evaluateDeclaredPostApply({ entries, results, verificationSkipped }) {
  const declared = Array.isArray(entries) ? entries : [];
  if (verificationSkipped) {
    return { declaredPassed: [], declaredNotPassing: declared.map((id) => ({ id, outcome: "verification_skipped" })) };
  }
  const perTest = declared.filter((e) => parseDeclaredEntry(e).testId);
  if (!results?.available) {
    return { declaredPassed: [], declaredNotPassing: perTest.map((id) => ({ id, outcome: "results_unavailable" })) };
  }
  const failing = failingOf(results);
  const declaredPassed = [];
  const declaredNotPassing = [];
  for (const id of perTest) {
    if (failing.includes(id)) declaredNotPassing.push({ id, outcome: results.error?.includes(id) ? "error" : "failed" });
    else if (results.xfailed?.includes(id)) declaredNotPassing.push({ id, outcome: "xfailed" });
    else if (results.xpassed?.includes(id)) declaredNotPassing.push({ id, outcome: "xpassed" });
    else if (results.passed?.includes(id)) declaredPassed.push(id);
    else if (results.skipped?.includes(id)) declaredNotPassing.push({ id, outcome: "skipped" });
    else declaredNotPassing.push({ id, outcome: "not_observed", cause: notObservedCause(results) });
  }
  return { declaredPassed, declaredNotPassing };
}

/** Prefix a labelled declared-not-passing block onto test output; unchanged for an empty list. */
export function formatDeclaredNotPassing(declaredNotPassing, output) {
  if (!Array.isArray(declaredNotPassing) || declaredNotPassing.length === 0) return output;
  const rows = declaredNotPassing.map((d) => `  - ${d.id}: ${d.outcome}${d.cause ? ` (${d.cause})` : ""}`);
  return [
    "[rks.exec] baselineRedTests: declared tests NOT observed passing after apply (each must be observed passed):",
    ...rows,
    "",
    output || "",
  ].join("\n");
}
