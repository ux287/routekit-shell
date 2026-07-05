import fs from "node:fs";
import path from "node:path";

/**
 * Read the rks RELEASE version (semver string) from the shell root `package.json`.
 *
 * CLI-side mirror of `readRksVersion()` in packages/mcp-rks/src/server/preflight.mjs,
 * but parameterized on `shellRoot` instead of an `__dirname` walk so the CLI project
 * layer (bootstrap.mjs, init-stack.js) can stamp a child's `.rks/project.json`.
 * Returns `null` if the file can't be read or parsed (non-fatal — callers fall back
 * to the unstamped sentinel).
 *
 * IMPORTANT — two distinct version concepts, never conflate:
 *   • rksVersion   — this: the release semver STRING (e.g. "0.20.18").
 *   • schemaVersion — an INTEGER config-shape counter (see metadata.js). Different track.
 *
 * A child whose `rksVersion` is "0.1.0" (or absent) is UNSTAMPED — that value was only
 * ever a hardcoded literal, never a real release — so `routekit project upgrade` treats
 * it as "pre-stamp / unknown from-version", not a genuine semver 0.1.0.
 */
export function readRksVersion(shellRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(shellRoot, "package.json"), "utf8"));
    return pkg.version || null;
  } catch {
    return null;
  }
}
