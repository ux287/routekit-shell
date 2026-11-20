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

/**
 * Write a child's `.rks/project.json` `rksVersion` stamp to `to`, read-modify-write so
 * all sibling config (id, offRail, fetchRaw, skillDefaults, kgFile, …) is preserved.
 * Best-effort: a missing/malformed file is repaired to a fresh `{ rksVersion }`; never throws.
 *
 * Extracted here (from upgrade.mjs) so BOTH the upgrade path and the plain `sync` path can
 * stamp without a circular import — upgrade.mjs already imports `syncProject` from ./sync.mjs,
 * so sync.mjs cannot import back from upgrade.mjs. read-rks-version.mjs is the shared home.
 */
export function advanceStamp(rksJsonPath, to) {
  let json = {};
  try {
    json = JSON.parse(fs.readFileSync(rksJsonPath, "utf8"));
  } catch {
    /* create fresh */
  }
  json.rksVersion = to;
  fs.mkdirSync(path.dirname(rksJsonPath), { recursive: true });
  fs.writeFileSync(rksJsonPath, JSON.stringify(json, null, 2) + "\n");
}
