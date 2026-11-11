// backlog.fix.test-suite-mutates-live-project-registry — run-level guard.
// Registered as a vitest globalSetup in the unit, mock, e2e and workflow tiers. It records the
// digest of the live, gitignored project registry before any worker starts and fails the run if
// that digest changed by the end. It ONLY reads the file: it never writes, restores or prunes it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const LIVE_REGISTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "projects",
  "index.jsonl",
);

export function digestRegistry(filePath = LIVE_REGISTRY) {
  if (!fs.existsSync(filePath)) return "absent";
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function compareRegistryDigest(before, after, filePath = LIVE_REGISTRY) {
  if (before === after) return { ok: true };
  return {
    ok: false,
    message:
      `live project registry ${filePath} changed during the test run ` +
      `(before ${before}, after ${after}). A test wrote the real registry: point it at a temp ` +
      `registry via RKS_REGISTRY_PATH. If you ran routekit project commands yourself during ` +
      `the run, re-run to confirm.`,
  };
}

let before = null;

export function setup() {
  before = digestRegistry();
}

export function teardown() {
  const result = compareRegistryDigest(before, digestRegistry());
  if (!result.ok) {
    process.exitCode = 1;
    throw new Error(result.message);
  }
}
