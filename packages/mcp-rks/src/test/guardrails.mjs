import { loadProjectProtectedConfig, isProtectedPath } from "../server/project.mjs";

// Lightweight, pure guardrail checks for planner outputs.

function detectWholeFileRewrite(plan, protectedFiles = [], sizeThreshold = 4000) {
  const failures = [];
  const actions = plan?.actions || [];
  for (const step of actions) {
    if (step?.action !== "edit_file") continue;
    if (!isProtectedPath(step.path, protectedFiles)) continue;
    const scope = step.scope || "file";
    const content = step.content || "";
    if ((scope === "file" || !scope) && typeof content === "string" && content.length >= sizeThreshold) {
      failures.push(`Whole-file rewrite of protected file: ${step.path}`);
    }
  }
  return { failures, warnings: [] };
}

function detectHallucinatedImports(plan, protectedFiles = []) {
  const warnings = [];
  const actions = plan?.actions || [];
  for (const step of actions) {
    if (step?.action !== "edit_file") continue;
    if (!isProtectedPath(step.path, protectedFiles)) continue;
    const content = step.content || "";
    if (typeof content === "string" && /import\s+.*from\s+['"]/.test(content)) {
      warnings.push(`Possible new imports in protected file: ${step.path}`);
    }
  }
  return { failures: [], warnings };
}

function detectMissingFunctionSlices(plan, expectedMode) {
  const failures = [];
  if (expectedMode !== "function_scope") return { failures, warnings: [] };
  const actions = plan?.actions || [];
  for (const step of actions) {
    if (step?.action !== "edit_file") continue;
    const scope = step.scope || "file";
    if (scope !== "function" || !step.targetId) {
      failures.push(`Missing function scope/targetId on edit for ${step.path || "(unknown path)"}`);
    }
  }
  return { failures, warnings: [] };
}

function detectConcernCoverage(plan) {
  const warnings = [];
  const critic = plan?.critic || {};
  const concerns = critic.concerns || [];
  if (!concerns.length) return { failures: [], warnings };

  const actions = plan?.actions || [];
  const mappedCounts = new Map();
  concerns.forEach((c) => mappedCounts.set(c.id, 0));
  actions.forEach((a) => {
    const cid = a.concernId || a?.meta?.concernId;
    if (cid && mappedCounts.has(cid)) {
      mappedCounts.set(cid, mappedCounts.get(cid) + 1);
    }
  });
  for (const [cid, count] of mappedCounts.entries()) {
    if (count === 0) warnings.push(`Concern ${cid} has no mapped steps`);
  }
  const hasMapped = actions.some((a) => a.concernId || a?.meta?.concernId);
  if (!hasMapped) warnings.push("Concerns exist but no steps carry concernId");
  return { failures: [], warnings };
}

function detectMonolithicPlans(plan, options = {}) {
  const warnings = [];
  const concerns = plan?.critic?.concerns || [];
  const actions = plan?.actions || [];
  const concernThreshold = options.concernThreshold ?? 3;
  const actionThreshold = options.actionThreshold ?? 2;
  if (concerns.length >= concernThreshold && actions.length <= actionThreshold) {
    warnings.push("Monolithic plan detected with many concerns but few steps");
  }
  return { failures: [], warnings };
}

export function runGuardrails(plan, options = {}) {
  const failures = [];
  const warnings = [];
  let protectedFiles = options.protectedFiles || [];
  if (options.projectRoot) {
    const pc = loadProjectProtectedConfig(options.projectRoot);
    const extra = [...(pc.protected || []), ...(pc.projectProtected || [])];
    protectedFiles = protectedFiles.concat(extra);
  }
  const expectedMode = options.expectedMode;

  const checks = [
    detectWholeFileRewrite(plan, protectedFiles, options.sizeThreshold),
    detectHallucinatedImports(plan, protectedFiles),
    detectMissingFunctionSlices(plan, expectedMode),
    detectConcernCoverage(plan),
    detectMonolithicPlans(plan, options.monolithicOptions),
  ];

  for (const result of checks) {
    if (!result) continue;
    if (result.failures?.length) failures.push(...result.failures);
    if (result.warnings?.length) warnings.push(...result.warnings);
  }

  return {
    passed: failures.length === 0,
    warnings,
    failures,
  };
}

export {
  detectWholeFileRewrite,
  detectHallucinatedImports,
  detectMissingFunctionSlices,
  detectConcernCoverage,
  detectMonolithicPlans,
};
