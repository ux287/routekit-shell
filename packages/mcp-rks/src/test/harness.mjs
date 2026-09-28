import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { runGuardrails } from "./guardrails.mjs";

const TEST_RUNS_ROOT = path.join(process.cwd(), "test-runs");

const defaultTestCases = [
  {
    id: "critic-v2.semantic-clusters",
    projectId: "routekit-shell",
    problemId: "backlog.critic-v2.1-semantic-clusters",
    label: "critic-v2-1-semantic-clusters",
    plannerMode: process.env.RKS_PLANNER_MODE || "full",
  },
  {
    id: "critic-v2.concern-decomposition",
    projectId: "routekit-shell",
    problemId: "backlog.critic-v2.2-concern-decomposition",
    label: "critic-v2-2-concern-decomposition",
    plannerMode: process.env.RKS_PLANNER_MODE || "full",
  },
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function runCliPlan({ projectId, problemId, label, plannerMode }) {
  const env = {
    ...process.env,
    ...(plannerMode ? { RKS_PLANNER_MODE: plannerMode } : {}),
  };
  const args = [
    "packages/cli/bin/routekit.js",
    "plan",
    projectId,
    "--problem",
    problemId,
    "--label",
    label,
  ];
  const result = spawnSync("node", args, { env, encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, error: result.stderr || result.stdout || `exit ${result.status}` };
  }
  let parsed = null;
  try {
    parsed = JSON.parse((result.stdout || "").trim());
  } catch {
    return { ok: false, error: "failed to parse planner stdout JSON" };
  }
  return { ok: true, data: parsed };
}

function copyOutputs(runFolder, destFolder) {
  ensureDir(destFolder);
  const files = ["llm-output.json", "plan.json", "plan.yaml", "problem.yaml"];
  files.forEach((f) => {
    const src = path.join(runFolder, f);
    const dest = path.join(destFolder, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  });
}

async function runHarness(testCases) {
  ensureDir(TEST_RUNS_ROOT);
  const summary = [];
  for (const tc of testCases) {
    const label = tc.label || tc.id;
    const destFolder = path.join(TEST_RUNS_ROOT, label);
    console.error(`\n[planner-harness] running ${label} ...`);
    const res = runCliPlan(tc);
    if (!res.ok) {
      summary.push({ id: label, status: "FAIL", failures: [res.error], warnings: [] });
      console.error(`[planner-harness] plan failed: ${res.error}`);
      continue;
    }

    const runFolder = res.data?.runFolder;
    if (!runFolder || !fs.existsSync(runFolder)) {
      const err = "runFolder missing from planner output";
      summary.push({ id: label, status: "FAIL", failures: [err], warnings: [] });
      console.error(`[planner-harness] ${err}`);
      continue;
    }

    copyOutputs(runFolder, destFolder);
    const planPath = path.join(destFolder, "plan.json");
    const planJson = readJsonSafe(planPath);
    if (!planJson) {
      const err = "plan.json missing or unreadable";
      summary.push({ id: label, status: "FAIL", failures: [err], warnings: [] });
      console.error(`[planner-harness] ${err}`);
      continue;
    }

    const guardrailResult = runGuardrails(planJson, {
      protectedFiles: tc.protectedFiles || [
        "packages/mcp-rks/src/llm/planner.mjs",
        "packages/mcp-rks/src/server/exec.mjs",
      ],
      expectedMode: tc.plannerMode,
      projectRoot: process.cwd(),
    });

    const status = guardrailResult.failures.length
      ? "FAIL"
      : guardrailResult.warnings.length
        ? "WARN"
        : "PASS";
    summary.push({
      id: label,
      status,
      failures: guardrailResult.failures,
      warnings: guardrailResult.warnings,
    });

    if (guardrailResult.warnings.length) {
      console.warn(`[planner-harness] warnings for ${label}:`, guardrailResult.warnings.join("; "));
    }
    if (guardrailResult.failures.length) {
      console.error(`[planner-harness] failures for ${label}:`, guardrailResult.failures.join("; "));
    }
  }

  console.error("\n[planner-harness] summary:");
  summary.forEach((s) => {
    const suffix =
      s.status === "PASS"
        ? ""
        : s.status === "WARN"
          ? ` warnings: ${s.warnings.join("; ")}`
          : ` failures: ${s.failures.join("; ")}`;
    console.error(`- ${s.id}: ${s.status}${suffix}`);
  });

  const hasFailures = summary.some((s) => s.status === "FAIL");
  if (hasFailures) process.exitCode = 1;
}

// Allow filtering by label via CLI args.
const filter = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
const cases = filter ? defaultTestCases.filter((tc) => tc.id === filter || tc.label === filter) : defaultTestCases;

runHarness(cases);
