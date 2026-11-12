// resolveUnverifiedCoveragePolicy against temp project dirs (Decision 9). No subprocess.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveUnverifiedCoveragePolicy, UNVERIFIED_COVERAGE_POLICY_SOURCE } from "../../packages/mcp-rks/src/exec/requirement-coverage-policy.mjs";

const dirs = [];
function projectWith(json) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-cov-policy-"));
  dirs.push(root);
  if (json !== undefined) {
    fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".rks", "project.json"), typeof json === "string" ? json : JSON.stringify(json));
  }
  return root;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

describe("resolveUnverifiedCoveragePolicy", () => {
  it("accepts only testRequirementCoverage.acceptUnverified === true, with the policy source (AC12/AC13)", () => {
    expect(UNVERIFIED_COVERAGE_POLICY_SOURCE).toBe(".rks/project.json#testRequirementCoverage.acceptUnverified");
    const accepted = resolveUnverifiedCoveragePolicy(projectWith({ id: "p", testRequirementCoverage: { acceptUnverified: true } }));
    expect(accepted.acceptUnverified).toBe(true);
    expect(accepted.source).toBe(".rks/project.json#testRequirementCoverage.acceptUnverified");
    // Nothing else is accepted.
    for (const json of [{}, { testRequirementCoverage: { acceptUnverified: false } }, { testRequirementCoverage: { acceptUnverified: "true" } }, { testRequirementCoverage: {} }, { acceptUnverified: true }]) {
      const r = resolveUnverifiedCoveragePolicy(projectWith(json));
      expect(r.acceptUnverified, JSON.stringify(json)).toBe(false);
      expect(r).not.toHaveProperty("source");
    }
  });

  it("fails closed: absent file, unparseable JSON, array root, absent key, false (AC13)", () => {
    expect(resolveUnverifiedCoveragePolicy(projectWith(undefined))).toEqual({ acceptUnverified: false, reason: "not_configured" });
    const unparseable = resolveUnverifiedCoveragePolicy(projectWith("{ not json"));
    expect(unparseable.acceptUnverified).toBe(false);
    expect(unparseable.reason).toBe("project_json_unreadable");
    expect(unparseable.detail).toEqual(expect.any(String));
    const arrayRoot = resolveUnverifiedCoveragePolicy(projectWith("[1, 2]"));
    expect(arrayRoot.acceptUnverified).toBe(false);
    expect(arrayRoot.reason).toBe("project_json_unreadable");
    expect(resolveUnverifiedCoveragePolicy(projectWith({ id: "p" }))).toEqual({ acceptUnverified: false, reason: "not_configured" });
    expect(resolveUnverifiedCoveragePolicy(projectWith({ testRequirementCoverage: { acceptUnverified: false } }))).toEqual({ acceptUnverified: false, reason: "disabled" });
  });

  it("misconfigured with field and detail for non-object key and non-boolean acceptUnverified (AC13)", () => {
    for (const value of [null, [], ["x"], "yes", true, false]) {
      const r = resolveUnverifiedCoveragePolicy(projectWith({ testRequirementCoverage: value }));
      expect(r.acceptUnverified, JSON.stringify(value)).toBe(false);
      expect(r.misconfigured, JSON.stringify(value)).toBe(true);
      expect(r.field, JSON.stringify(value)).toBe("testRequirementCoverage");
      expect(typeof r.detail).toBe("string");
      expect(r.detail.length).toBeGreaterThan(0);
    }
    for (const inner of [{ acceptUnverified: "true" }, { acceptUnverified: 1 }, {}, { other: true }]) {
      const r = resolveUnverifiedCoveragePolicy(projectWith({ testRequirementCoverage: inner }));
      expect(r.acceptUnverified, JSON.stringify(inner)).toBe(false);
      expect(r.misconfigured, JSON.stringify(inner)).toBe(true);
      expect(r.field, JSON.stringify(inner)).toBe("testRequirementCoverage.acceptUnverified");
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });

  it("never throws: project.json is a directory, projectRoot missing (AC13)", () => {
    const root = projectWith(undefined);
    fs.mkdirSync(path.join(root, ".rks", "project.json"), { recursive: true });
    let dirResult;
    expect(() => { dirResult = resolveUnverifiedCoveragePolicy(root); }).not.toThrow();
    expect(dirResult).toEqual(expect.objectContaining({ acceptUnverified: false }));

    const missing = path.join(os.tmpdir(), `rks-cov-policy-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    let missingResult;
    expect(() => { missingResult = resolveUnverifiedCoveragePolicy(missing); }).not.toThrow();
    expect(missingResult).toEqual(expect.objectContaining({ acceptUnverified: false }));

    for (const bad of [undefined, null, 42]) {
      let r;
      expect(() => { r = resolveUnverifiedCoveragePolicy(bad); }).not.toThrow();
      expect(r.acceptUnverified).toBe(false);
    }
  });
});
