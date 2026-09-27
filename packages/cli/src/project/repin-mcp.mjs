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

const ENV_ROOT_KEYS = ["ROUTEKIT_PROJECT_ROOT", "RKS_PROJECT_ROOT"];

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Rewrite env project-root keys in config.mcpServers.rks.env whose value is an
 * absolute path that does not realpath-resolve to projectRoot (missing, or a
 * different directory). Relative values (including ".") are left alone, and a
 * key that is absent is never added. Mutates config in place.
 *
 * @returns {Array<{ key: string, from: string, to: string }>}
 */
function reconcileEnvRoots(config, projectRoot) {
  const env = config?.mcpServers?.rks?.env;
  if (!env || typeof env !== "object") return [];
  const want = realpathOrNull(projectRoot) ?? path.resolve(projectRoot);
  const changes = [];
  for (const key of ENV_ROOT_KEYS) {
    const value = env[key];
    if (typeof value !== "string" || !path.isAbsolute(value)) continue;
    if (realpathOrNull(value) === want) continue;
    env[key] = projectRoot;
    changes.push({ key, from: value, to: projectRoot });
  }
  return changes;
}

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
 * @returns {{ ok: true, changed: boolean, argsChanged: boolean, envRootChanges: Array<{ key: string, from: string, to: string }>, mcpPath: string }}
 *   changed === argsChanged || envRootChanges.length > 0
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

  const envRootChanges = reconcileEnvRoots(config, projectRoot);
  const argsChanged = currentBin !== desiredBin;
  if (!argsChanged && envRootChanges.length === 0) {
    return { ok: true, changed: false, argsChanged: false, envRootChanges: [], mcpPath };
  }

  config.mcpServers = config.mcpServers || {};
  config.mcpServers.rks = config.mcpServers.rks || {};
  const newArgs = Array.isArray(currentArgs) ? [...currentArgs] : [];
  newArgs[0] = desiredBin;
  config.mcpServers.rks.args = newArgs;

  writeJSONWithBackupLocal(mcpPath, config);
  return { ok: true, changed: true, argsChanged, envRootChanges, mcpPath };
}
