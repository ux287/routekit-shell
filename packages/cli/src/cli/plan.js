import path from "path";
import { listRuns } from "../planner/index.js";

export async function handlePlanCommand({ args, kv, SHELL_ROOT, readStdin, callMcpTool, printPlanHelp }) {
  if (kv.help) {
    printPlanHelp();
    process.exit(0);
  }
  const projectId = args[1] && !args[1].startsWith("--") ? args[1] : null;
  if (!projectId) {
    console.error("routekit plan requires <projectId> as the first argument.");
    printPlanHelp();
    process.exit(2);
  }
  // Handle --list flag
  if (kv.list) {
    const result = listRuns(SHELL_ROOT, projectId);
    console.log(result.text);
    process.exit(0);
  }
  const rest = args.slice(2);
  let problemId = typeof kv.problem === "string" ? kv.problem : null;
  const segments = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--problem") {
      problemId = rest[i + 1];
      i += 1;
      continue;
    }
    if (token && token.startsWith && token.startsWith("--")) continue;
    if (token) segments.push(token);
  }
  let task = null;
  if (!problemId && segments.length) {
    const joined = segments.join(" ");
    if (segments.length === 1 && joined && !joined.includes(" ")) {
      problemId = joined;
    } else {
      task = joined;
    }
  }
  if (!task && !problemId) {
    console.error("Provide either a free-text task or a --problem note id.");
    printPlanHelp();
    process.exit(2);
  }
  if (problemId === "-") {
    const stdinText = await readStdin();
    const trimmed = (stdinText || "").trim();
    if (!trimmed) {
      console.error("routekit plan: --problem - used but no stdin content was provided.");
      process.exit(2);
    }
    task = trimmed;
    problemId = null;
  }
  const payload = {
    projectId,
    task: task || null,
    problemId: problemId || null,
    label: typeof kv.label === "string" ? kv.label : null,
  };
  try {
    const response = await callMcpTool("rks_plan", payload);
    const text = response?.content?.[0]?.text ?? "";
    process.stdout.write(text);
    process.exit(0);
  } catch (error) {
    console.error(error?.message || error);
    process.exit(1);
  }
}
