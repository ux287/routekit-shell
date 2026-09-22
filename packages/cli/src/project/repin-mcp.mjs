/**
 * repin-mcp.mjs — update a child project's .mcp.json args[0] to point at a
 * specific routekit-shell install's mcp-rks.mjs binary.
 *
 * Use case: when the user upgrades shells (e.g. dev → release), every child
 * project still points its MCP server at the OLD shell path. There is no
 * code in bootstrap.mjs that updates an existing .mcp.json — ensureMcpJson()
 * is create-only by design. This module owns the "update" responsibility.
 *
 * Inlined JSON-with-backup writer — bootstrap.mjs's writeJSONWithBackup is
 * module-internal and intentionally not re-exported. Inlining the 3-line
 * helper keeps the bootstrap module's export surface stable.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Compute the canonical args[0] path for a given shell install.
 */
function shellMcpBinary(shellRoot) {
  return path.join(shellRoot, "packages", "mcp-rks", "bin", "mcp-rks.mjs");
}

/**
 * Inline JSON-with-backup writer. Mirrors bootstrap.mjs's writeJSONWithBackup
 * format byte-for-byte (2-space indent, trailing newline) so .mcp.json files
 * written by either path are stylistically consistent. Not imported from
 * bootstrap.mjs — see module docstring.
 */
function writeJSONWithBackupLocal(mcpPath, obj) {
  if (fs.existsSync(mcpPath)) {
    const bak = mcpPath + `.bak.${Date.now()}`;
    fs.copyFileSync(mcpPath, bak);
  }
  fs.writeFileSync(mcpPath, JSON.stringify(obj, null, 2) + "\n");
}

/**
 * Repin the MCP server path in a child project's .mcp.json.
 *
 * @param {object} args
 * @param {string} args.projectRoot - Absolute path to the child project root.
 * @param {string} args.shellRoot   - Absolute path to the routekit-shell install
 *                                    whose mcp-rks.mjs should be referenced.
 * @returns {{ ok: true, changed: boolean, mcpPath: string }}
 * @throws if the child's .mcp.json does not exist (creation is bootstrap's job).
 */
export function repinMcpServer({ projectRoot, shellRoot } = {}) {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new Error("repinMcpServer: projectRoot is required");
  }
  if (!shellRoot || typeof shellRoot !== "string") {
    throw new Error("repinMcpServer: shellRoot is required");
  }

  const mcpPath = path.join(projectRoot, ".mcp.json");
  if (!fs.existsSync(mcpPath)) {
    throw new Error(
      `${mcpPath} not found — child not bootstrapped. Run \`routekit project attach\` first.`,
    );
  }

  const desiredBin = shellMcpBinary(shellRoot);
  const raw = fs.readFileSync(mcpPath, "utf8");
  const config = JSON.parse(raw);
  const currentArgs = config?.mcpServers?.rks?.args;
  const currentBin = Array.isArray(currentArgs) ? currentArgs[0] : undefined;

  if (currentBin === desiredBin) {
    return { ok: true, changed: false, mcpPath };
  }

  config.mcpServers = config.mcpServers || {};
  config.mcpServers.rks = config.mcpServers.rks || {};
  const newArgs = Array.isArray(currentArgs) ? [...currentArgs] : [];
  newArgs[0] = desiredBin;
  config.mcpServers.rks.args = newArgs;

  writeJSONWithBackupLocal(mcpPath, config);
  return { ok: true, changed: true, mcpPath };
}
