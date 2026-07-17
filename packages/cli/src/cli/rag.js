import path from "path";
import { spawnSync } from "child_process";

export async function handleRagCommand({ args, kv, SHELL_ROOT, printRagHelp }) {
  const subcmd = args[1];
  if (!subcmd || subcmd === "help" || subcmd === "--help") {
    printRagHelp();
    process.exit(subcmd ? 0 : 2);
  }
  if (!["init", "embed", "query"].includes(subcmd)) {
    console.error(`Unknown rag subcommand: ${subcmd}`);
    printRagHelp();
    process.exit(2);
  }
  const projectId = args[2];
  // RKS: start log added to validate rag CLI planning/apply flows (backlog.rks-dev.rag-hello-log)
  console.log(`[rag start] subcommand=${subcmd} projectId=${projectId ?? "unknown"}`);
  if (!projectId || projectId.startsWith("--")) {
    console.error("routekit rag <init|embed|query> <projectId> [...]");
    process.exit(2);
  }
  const { getProjectById } = await import("../project/index.js");
  const project = getProjectById(projectId, SHELL_ROOT);
  if (!project || !(project.root || project.path)) {
    console.error(`Project not found: ${projectId}`);
    process.exit(1);
  }
  const projectRoot = project.root || project.path;
  const scriptPath = path.join(SHELL_ROOT, "scripts", "rag", `${subcmd}.mjs`);
  const env = { ...process.env, ROUTEKIT_PROJECT_ROOT: projectRoot, ROUTEKIT_PROJECT_ID: projectId };
  let scriptArgs = [];
  if (subcmd === "query") {
    const query = args.slice(3).join(" ").trim();
    if (!query) {
      console.error("routekit rag query <projectId> \"question text\"");
      process.exit(2);
    }
    scriptArgs.push(query);
  }
  const result = spawnSync("node", [scriptPath, ...scriptArgs], {
    stdio: "inherit",
    env,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
  console.log(`[rag ${subcmd}] project=${projectId} root=${projectRoot}`);
  process.exit(0);
}
