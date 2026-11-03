// Per-project opt-in to accept UNVERIFIED test-requirement coverage
// (backlog.fix.exec-test-requirements-coverage-gate, Decision 9).
//
// Configured by the `testRequirementCoverage` key of the project's OWN `.rks/project.json`,
// following resolveFullSuiteGateConfig (exec/full-suite-gate.mjs):
//
//   testRequirementCoverage: {
//     acceptUnverified: true,   // required boolean
//   }
//
// The opt-in is a WAIVER, so every doubt resolves to "not accepted" (fail closed): absent
// file, unparseable file, absent key, malformed key, or acceptUnverified !== true.
// It never waives an observed failing/skipped/todo test; exec consults it only when
// per-test results are unavailable. Never throws.
import fs from "fs";
import path from "path";

export const UNVERIFIED_COVERAGE_POLICY_SOURCE = ".rks/project.json#testRequirementCoverage.acceptUnverified";

const errMessage = (err) => (err && err.message ? err.message : String(err));

export function resolveUnverifiedCoveragePolicy(projectRoot) {
  let parsed;
  try {
    const configPath = path.join(projectRoot, ".rks", "project.json");
    if (!fs.existsSync(configPath)) return { acceptUnverified: false, reason: "not_configured" };
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    return { acceptUnverified: false, reason: "project_json_unreadable", detail: errMessage(err) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { acceptUnverified: false, reason: "project_json_unreadable", detail: "project.json is not a JSON object" };
  }
  const raw = parsed.testRequirementCoverage;
  if (raw === undefined) return { acceptUnverified: false, reason: "not_configured" };
  const misconfigured = (field, detail) => ({ acceptUnverified: false, misconfigured: true, reason: "misconfigured", field, detail });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return misconfigured("testRequirementCoverage", "testRequirementCoverage must be an object such as { acceptUnverified: true }");
  }
  if (typeof raw.acceptUnverified !== "boolean") {
    return misconfigured("testRequirementCoverage.acceptUnverified", "testRequirementCoverage.acceptUnverified must be a boolean");
  }
  if (raw.acceptUnverified !== true) return { acceptUnverified: false, reason: "disabled" };
  return { acceptUnverified: true, reason: "enabled", source: UNVERIFIED_COVERAGE_POLICY_SOURCE };
}
