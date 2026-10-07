#!/usr/bin/env node
/**
 * Process-group-killing vitest wrapper.
 * Delegates all spawn/cleanup logic to spawnManagedInherit.
 *
 * Usage:
 *   node scripts/vitest-runner.mjs --config vitest.config.unit.mjs [--timeout 120000] [file1 file2 ...]
 *
 * Optional per-Story B1 JSON-reporter passthrough:
 *   node scripts/vitest-runner.mjs --config vitest.config.unit.mjs --json-output [<path>]
 *   ROUTEKIT_VITEST_JSON_OUTPUT=<path> node scripts/vitest-runner.mjs ...
 *
 *   When EITHER --json-output flag OR ROUTEKIT_VITEST_JSON_OUTPUT env var is
 *   set, vitest is invoked with the multi-reporter form (--reporter=default
 *   --reporter=json --outputFile.json=<path>). When neither is set the runner
 *   behaves EXACTLY as before — no JSON write, no disk side effect, current
 *   reporter unchanged. See backlog.feat.capture-per-test-timing-in-ci.
 */

import path from "node:path";
import { parseArgs } from "node:util";
import { spawnManagedInherit } from "./lib/spawn-managed.mjs";

const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: "string" },
    timeout: { type: "string" },
    "json-output": { type: "string" },
    // Tier 1 (audit paper §6): forward vitest's --shard=N/M for CI matrix sharding.
    // Without explicit declaration the flag would be silently dropped under strict:false.
    shard: { type: "string" },
  },
  allowPositionals: true,
  strict: false,
});

const configArg = flags.config;
const timeoutMs = flags.timeout ? parseInt(flags.timeout, 10) : 900_000;

// B1: derive JSON output path from --json-output flag (with optional value),
// from ROUTEKIT_VITEST_JSON_OUTPUT env var, or skip entirely. When the flag
// is present without a value, or the env var is set without a path, we
// generate a default path under .rks/test-reports/ using the config-derived
// tier name and a timestamp.
function deriveTier(configPath) {
  if (!configPath) return "default";
  const base = path.basename(configPath, path.extname(configPath));
  // vitest.config.unit, vitest.config.mock, etc. → unit, mock, ...
  const parts = base.split(".");
  return parts[parts.length - 1] || "default";
}

function resolveJsonOutputPath() {
  const flagVal = flags["json-output"];
  const envVal = process.env.ROUTEKIT_VITEST_JSON_OUTPUT;
  if (flagVal === undefined && !envVal) return null;
  // If env var holds a non-empty path, use it verbatim.
  if (envVal && envVal !== "" && envVal !== "1" && envVal !== "true") return envVal;
  // If flag has an explicit value, use it.
  if (flagVal && flagVal !== "") return flagVal;
  // Otherwise, generate a default path.
  const tier = deriveTier(configArg);
  // Single timestamp for the run; not Date.now to keep it readable.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(".rks", "test-reports", `vitest-${tier}-${ts}.json`);
}

const jsonOutputPath = resolveJsonOutputPath();

const vitestArgs = ["vitest", "run"];
if (configArg) vitestArgs.push("--config", configArg);
if (flags.shard) vitestArgs.push(`--shard=${flags.shard}`);

if (jsonOutputPath) {
  // Multi-reporter form: keep the default reporter for stdout (humans + CI
  // log) AND emit the JSON to disk for downstream analysis. vitest accepts
  // multiple --reporter flags; --outputFile.json= scopes the path to the
  // json reporter specifically.
  vitestArgs.push("--reporter=default", "--reporter=json", `--outputFile.json=${jsonOutputPath}`);
}

vitestArgs.push(...positionals);

const { code } = await spawnManagedInherit("npx", vitestArgs, { timeoutMs });
process.exit(code);
