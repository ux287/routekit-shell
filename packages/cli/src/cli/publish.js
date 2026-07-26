import path from "node:path";
import fs from "node:fs";
import {
  publish as _publish,
  loadPublishProfiles as _loadPublishProfiles,
  getRemoteConfig as _getRemoteConfig,
} from "../../../mcp-rks/src/server/publish.mjs";

/**
 * `routekit publish` — re-publish a snapshot to a configured remote (default: rks-public →
 * the public github.com/ux287/routekit-shell) WITHOUT cutting a formal release.
 *
 * Because the CLI runs in a FRESH node process each invocation, it loads the current on-disk
 * publish.mjs — sidestepping the "stale in-memory publish.mjs" bug that bit publishes routed
 * through the long-lived MCP server (v0.20.17 / v0.20.21). Force-push (publish.mjs does
 * `git push -f`) is gated behind an explicit --yes; --dry-run previews without pushing.
 *
 * Every side-effecting dependency is injectable (deps) so the dispatch is unit-testable
 * without touching git or the network.
 */
export async function handlePublishCommand({ kv = {}, args = [], SHELL_ROOT } = {}, deps = {}) {
  const publish = deps.publish || _publish;
  const loadPublishProfiles = deps.loadPublishProfiles || _loadPublishProfiles;
  const getRemoteConfig = deps.getRemoteConfig || _getRemoteConfig;
  const processExit = deps.processExit ?? process.exit;
  const log = deps.log || console.log;
  const errorLog = deps.errorLog || console.error;

  if (kv.help === true || kv.h === true) {
    printUsage(log);
    return processExit(0);
  }

  // projectRoot: cwd default; --root / ROUTEKIT_PROJECT_ROOT override, existence-guarded.
  if (typeof kv.root === "string" && !fs.existsSync(path.resolve(kv.root))) {
    errorLog(`--root path not found: ${path.resolve(kv.root)}`);
    printUsage(errorLog);
    return processExit(2);
  }
  const envRoot =
    process.env.ROUTEKIT_PROJECT_ROOT && fs.existsSync(process.env.ROUTEKIT_PROJECT_ROOT)
      ? process.env.ROUTEKIT_PROJECT_ROOT
      : null;
  const rootOverride = (typeof kv.root === "string" && kv.root) || envRoot;
  const projectRoot = rootOverride ? path.resolve(rootOverride) : process.cwd();

  // Resolve remote (default: the single configured remote) + its profile/branch.
  const config = loadPublishProfiles(projectRoot) || {};
  const remoteNames = Object.keys(config.remotes || {});
  let remote = typeof kv.remote === "string" ? kv.remote : null;
  if (!remote) {
    if (remoteNames.length === 1) {
      remote = remoteNames[0];
    } else {
      errorLog(
        remoteNames.length === 0
          ? "No remotes configured in .routekit/publish-profiles.yaml"
          : `Multiple remotes configured (${remoteNames.join(", ")}) — specify --remote`,
      );
      printUsage(errorLog);
      return processExit(2);
    }
  }
  const remoteConfig = getRemoteConfig(projectRoot, remote) || {};
  const profile = (typeof kv.profile === "string" && kv.profile) || remoteConfig.profile || remote;
  const branch = (typeof kv.branch === "string" && kv.branch) || remoteConfig.branch || "main";
  const message =
    (typeof kv.message === "string" && kv.message) || shortFlagValue(args, "-m") || "Publish snapshot";
  const dryRun = kv["dry-run"] === true || kv["dry-run"] === "true";
  const yes = kv.yes === true || kv.yes === "true";

  // Force-push gate: a real publish REPLACES the remote branch history — require --yes.
  if (!dryRun && !yes) {
    errorLog(`Refusing to force-push to '${remote}' (${branch}) without confirmation.`);
    errorLog(`This REPLACES the remote branch history. Re-run with --yes, or --dry-run to preview.`);
    return processExit(2);
  }

  try {
    const result = await publish(projectRoot, { remote, profile, branch, dryRun, message });
    if (!result || result.ok !== true) {
      errorLog(`publish failed: ${(result && result.error) || "unknown error"}`);
      return processExit(1);
    }
    if (dryRun) {
      log(`Dry run — would publish profile "${profile}" to ${remote}/${branch} (no push):`);
      log(`  include patterns: ${(result.includePatterns || []).length}`);
      if (result.identity) log(`  identity rewrite: ${result.identity.from} → ${result.identity.to}`);
    } else {
      log(`✓ ${result.message || `Published to ${remote}/${branch}`}`);
    }
    return processExit(0);
  } catch (err) {
    errorLog(`publish failed: ${err?.message || err}`);
    return processExit(1);
  }
}

/** Read a single-dash flag's value from the raw args (parseArgs only handles --flags). */
function shortFlagValue(args, flag) {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("-")) return args[i + 1];
  return null;
}

function printUsage(out = console.log) {
  out(`usage: routekit publish [--remote <name>] [--profile <name>] [--branch <name>] [--dry-run] [-m|--message <msg>] [--root <path>] [--yes]

  Re-publish a snapshot to a configured remote WITHOUT a formal release. Runs in a fresh
  process (loads the current publish.mjs). Default remote/profile: the single entry in
  .routekit/publish-profiles.yaml (rks-public → github.com/ux287/routekit-shell).

    --dry-run   preview the include set + identity rewrite; no push
    --yes       confirm the force-push (required for a real publish — REPLACES remote history)`);
}
