export async function handleAnalyzeCommand({ args, callMcpTool }) {
  const projectId = args[1];
  if (!projectId || projectId.startsWith("--")) {
    console.error("Usage: routekit analyze <projectId>");
    process.exit(2);
  }
  const response = await callMcpTool("rks_analyze", { projectId });
  console.log(JSON.stringify(response, null, 2));
  process.exit(0);
}
