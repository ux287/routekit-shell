import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { callMcpTool } from "../mcp/index.js";

export async function handleExecCommand({
  kv,
  SHELL_ROOT,
  readStdin,
  ensureDir,
}) {
  if (kv.project === true) { console.error("routekit exec: --project requires a value"); process.exit(2); }
  if (kv.label === true) { console.error("routekit exec: --label requires a value"); process.exit(2); }
  const projectId = typeof kv.project === "string" ? kv.project : null;
  const label = typeof kv.label === "string" ? kv.label : null;
  const applyFlag = Object.prototype.hasOwnProperty.call(kv, "apply");
  const yesFlag = Object.prototype.hasOwnProperty.call(kv, "yes");
  const runCommandsFlag = Object.prototype.hasOwnProperty.call(kv, "run-commands");
  const skipTestsFlag = Object.prototype.hasOwnProperty.call(kv, "skip-tests");
  if (!projectId || !label) {
    console.error("usage: routekit exec --project <id> --label <label> [--apply] [--yes] [--skip-tests]");
    process.exit(2);
  }
  const runsDir = path.join(SHELL_ROOT, ".rks", "runs");
  const findLatestPlanJson = (proj, lbl) => {
    if (!fs.existsSync(runsDir)) return null;
    // Accept folders that end with _<lbl> or _<lbl>- (trailing dash(s)).
    const escapeForRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escaped = escapeForRegex(lbl);
    const re = new RegExp(`_${escaped}-*$`);
    const dirs = fs
      .readdirSync(runsDir)
      .filter((d) => re.test(d))
      .sort()
      .reverse();
    for (const dir of dirs) {
      const planPath = path.join(runsDir, dir, "plan.json");
      if (!fs.existsSync(planPath)) continue;
      const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
      if (plan.projectId && plan.projectId !== proj) continue;
      return { runFolder: path.join(runsDir, dir), planPath, plan };
    }
    return null;
  };

  const parseCommandParts = (cmd) => {
    if (!cmd || typeof cmd !== "string") return null;
    if (/[|;&<>`]/.test(cmd)) return null;
    if (/\.\./.test(cmd)) return null;
    const parts = cmd.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    return { file: parts[0], args: parts.slice(1) };
  };

  const buildWhitelist = () => {
    const defaults = [
      "npm run test:unit",
      "npm run lint",
      "npm run format -- --check",
      "node scripts/rag/embed.mjs",
      "node scripts/rag/query.mjs",
    ];
    const extra = process.env.RKS_EXEC_EXTRA_CMDS
      ? process.env.RKS_EXEC_EXTRA_CMDS.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    return [...defaults, ...extra];
  };

  const isWhitelisted = (command, whitelist) => {
    if (!command) return false;
    return whitelist.some((allowed) => command === allowed || command.startsWith(`${allowed} `));
  };

  const result = await callMcpTool("rks_exec", {
    projectId,
    label,
    apply: applyFlag,
    yes: yesFlag,
    runCommands: runCommandsFlag,
    skipTests: skipTestsFlag
  });

  console.log(result);
  process.exit(0);
}
