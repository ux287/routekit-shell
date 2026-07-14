import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { findLatestRunDir } from "../utils/git.mjs";

/**
 * Load a plan from a run directory.
 * Supports both plan.json and plan.yaml formats.
 * @param {string} projectRoot - Project root path
 * @param {string|null} slug - Optional slug to find specific run
 * @returns {{ plan: Object, runDir: string, runId: string, runMeta: Object }}
 * @throws {McpError} If no run found or plan is invalid
 */
export function loadPlan(projectRoot, slug = null) {
  const runDir = findLatestRunDir(projectRoot, slug);
  if (!runDir) {
    throw new McpError(
      ErrorCode.InvalidParams,
      slug ? `No plan found for slug ${slug}` : "No runs found."
    );
  }

  const planYamlPath = path.join(runDir, "plan.yaml");
  const planJsonPath = path.join(runDir, "plan.json");
  
  let plan = null;
  if (fs.existsSync(planJsonPath)) {
    plan = JSON.parse(fs.readFileSync(planJsonPath, "utf8"));
  } else if (fs.existsSync(planYamlPath)) {
    plan = yaml.load(fs.readFileSync(planYamlPath, "utf8"));
  } else {
    throw new McpError(ErrorCode.InternalError, `Missing plan in ${runDir}`);
  }

  if (!plan || !Array.isArray(plan.steps)) {
    throw new McpError(ErrorCode.InvalidParams, "Plan is missing steps");
  }

  const runId = path.basename(runDir);
  const selectedSlug = plan.slug || slug || runId.split("_").slice(1).join("_");

  // Load run.json metadata if it exists
  const runJsonPath = path.join(runDir, "run.json");
  let runMeta = {};
  if (fs.existsSync(runJsonPath)) {
    try {
      runMeta = JSON.parse(fs.readFileSync(runJsonPath, "utf8"));
    } catch {
      runMeta = {};
    }
  }

  return { plan, runDir, runId, slug: selectedSlug, runMeta };
}
