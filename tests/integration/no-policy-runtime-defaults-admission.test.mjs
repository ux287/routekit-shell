/**
 * no-policy-runtime-defaults-admission.test.mjs
 *
 * Story: backlog.fix.child-read-hooks-block-governor-runtime-files
 *
 * A child project with NO .routekit/read-policy.yaml runs both read gates on their
 * hardcoded fallback defaults. Those defaults must admit the files every Governor is
 * told to read (its own prompt, .rks/project.json, .rks/rag/config.json) and nothing
 * wider. Both hooks are spawned from packages/hooks/read against a TEMP root, so the
 * shell's own policy file and any live off-rail scope cannot decide an assertion.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOKS = ["redirect-read-to-agent.mjs", "enforce-read-provenance.mjs"];
const GATE_A = path.join(REPO_ROOT, "packages", "hooks", "read", HOOKS[0]);
const GATE_B = path.join(REPO_ROOT, "packages", "hooks", "read", HOOKS[1]);

const ADDED = [".rks/prompts/governor-ship.md", ".rks/project.json", ".rks/rag/config.json"];

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-no-policy-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// A hook that crashed or never ran is a failure, never an allow.
function runHook(hook, relPath) {
  const r = spawnSync("node", [hook], {
    input: JSON.stringify({
      session_id: randomUUID(),
      tool_name: "Read",
      tool_input: { file_path: path.join(root, relPath) },
      cwd: root,
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ROUTEKIT_PROJECT_ROOT: root, RKS_GUARDRAILS: "on" },
    encoding: "utf8",
    timeout: 15_000,
  });
  if (r.error || r.status !== 0) {
    throw new Error(`hook did not run to completion: ${hook} (target ${relPath})`, { cause: r.error ?? r.stderr });
  }
  return r;
}

const gateADenies = (rel) => runHook(GATE_A, rel).stdout.includes('"permissionDecision":"deny"');

// Gate B is warn-only without a policy, so its decision is read from the reason it logs.
function gateBReason(rel) {
  runHook(GATE_B, rel);
  const log = path.join(root, ".routekit", "telemetry", "provenance-blocks.log");
  const lines = fs.readFileSync(log, "utf8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  // A stale line for another path must never decide the result.
  expect(last.path).toBe(path.join(root, rel));
  return last.reason;
}

describe("no read-policy.yaml: fallback defaults", () => {
  it("precondition: the temp root has no policy file and no off-rail scope", () => {
    expect(fs.existsSync(path.join(root, ".routekit", "read-policy.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".rks", "active-scope.json"))).toBe(false);
  });

  for (const rel of ADDED) {
    it(`gate A admits ${rel}`, () => {
      expect(gateADenies(rel)).toBe(false);
    });
    it(`gate B classifies ${rel} as runtime_config`, () => {
      expect(gateBReason(rel)).toBe("runtime_config");
    });
  }

  it("gate A still denies an unprovenanced source read", () => {
    expect(gateADenies("src/app.ts")).toBe(true);
  });

  it("gate B does not classify a source read as runtime_config", () => {
    expect(gateBReason("src/app.ts")).not.toBe("runtime_config");
  });

  it("gate A denies a non-named sibling under .rks/rag/", () => {
    expect(gateADenies(".rks/rag/other.json")).toBe(true);
  });
});

describe("policy present: its own list replaces the defaults", () => {
  it("a policy that omits .rks/prompts/* does not inherit it from the defaults", () => {
    fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".routekit", "read-policy.yaml"),
      "provenance_enforcement:\n  enabled: true\n  mode: block\n  runtime_paths:\n    - package.json\n",
      "utf8",
    );
    expect(gateADenies("package.json")).toBe(false); // positive control: the policy list was loaded
    expect(gateADenies(".rks/prompts/governor-ship.md")).toBe(true);
  });
});

describe("deploy parity", () => {
  it("deployed and template copies match source where present", () => {
    for (const name of HOOKS) {
      const src = fs.readFileSync(path.join(REPO_ROOT, "packages", "hooks", "read", name));
      for (const base of [".routekit", path.join("templates", "generic", ".routekit")]) {
        const copy = path.join(REPO_ROOT, base, "hooks", "read", name);
        if (!fs.existsSync(copy)) continue; // .routekit/hooks is moved aside during off-rail
        expect(fs.readFileSync(copy).equals(src), `${path.relative(REPO_ROOT, copy)} drifted`).toBe(true);
      }
    }
  });
});
