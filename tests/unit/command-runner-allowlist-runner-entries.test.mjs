/**
 * backlog.fix.run-command-allowlist-admits-arbitrary-code
 *
 * Runner entries (bare interpreters / script runners) never admit a command, the built-in
 * destructive-flag veto fires regardless of the policy's own confirmation list, this repo's policy
 * is tightened, and the planner npm-script hint follows the policy. spawnManaged is stubbed: no
 * test in this file may reach execution, and each skip-path test asserts it was never called.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../helpers/tmp.mjs";

vi.mock("../../scripts/lib/spawn-managed.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnManaged: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) };
});

import { spawnManaged } from "../../scripts/lib/spawn-managed.mjs";
import {
  classifyCommand,
  handleRunCommandStep,
  loadCommandPolicy,
  isRunnerEntry,
  refusedPolicyEntries,
  refusedEntryFor,
} from "../../packages/mcp-rks/src/exec/command-runner.mjs";
import { formatScriptsForPrompt } from "../../packages/mcp-rks/src/server/planner-prompts.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TIMEOUT = 15_000;
const EXECUTING = ["auto_execute", "execute_with_plan_approval"];
const REASONS = ["requires_plan_approval", "shell_syntax_rejected", "requires_explicit_confirmation", "unknown_command"];

const DEFAULTS = {
  auto_execute: ["git status", "git diff", "npm test", "npm run lint", "npm run build"],
  execute_with_plan_approval: ["git add", "git rm --cached", "git commit", "npm install"],
  require_explicit_confirmation: ["rm", "git reset", "git push --force", "git branch -D"],
};

const BARE_RUNNERS = [
  "node", "nodejs", "npx", "npm", "npm run", "npm run-script", "npm exec", "npm x",
  "pnpm", "pnpm run", "pnpm exec", "pnpm dlx", "yarn", "yarn run", "yarn exec", "yarn dlx",
  "bun", "bun run", "bunx", "deno", "deno run", "deno eval", "python", "python3", "ruby", "perl",
  "php", "sh", "bash", "zsh", "dash", "fish", "ksh", "env", "xargs", "sudo", "git", "git config",
];

const INLINE_RUNNERS = [
  "node -e", "node --eval", "node -p", "node --print", "node -r", "node --require", "node --import",
  "node --loader", "node --experimental-loader", "bash -c", "sh -c", "python -c", "python3 -c",
  "perl -e", "ruby -e",
];

const SPECIFIC = [
  "node scripts/foo.mjs", "npm run test:unit", "bash tests/smoke-plan.sh",
  "git status", "git add", "git commit", "npm install", "npm test",
];

const PAYLOADS = [
  ["node", "node -e 0"],
  ["npm run", "npm run anything"],
  ["npx", "npx cowsay"],
  ["git config", "git config diff.external x"],
  ["git", "git -c a=b status"],
  ["bash", "bash -c true"],
  ["python", "python -c 0"],
];

const MIXED = {
  auto_execute: ["git status", "node", "npm run test:unit", "bash -c"],
  execute_with_plan_approval: ["git add", "npm run", "git config", "npm install"],
  require_explicit_confirmation: [],
};

const VETO_POLICY = {
  auto_execute: ["git branch", "git push", "git checkout"],
  execute_with_plan_approval: ["git reset", "git clean", "rm", "git commit"],
  require_explicit_confirmation: [],
};

const VETOED = [
  "git branch --delete --force x", "git branch -d -f x", "git branch -df x", "git branch -Df x",
  "git branch -D x", "git branch -M a b", "git branch -C a b", "git branch -f x HEAD~1",
  "git branch --force x", "git push --force", "git push origin -f main", "git push --force-with-lease",
  "git push --force-with-lease=main:abc", "git push --force-if-includes", "git push --delete origin x",
  "git push -d origin x", "git push origin :x", "git push origin +main", "git push --mirror",
  "git push --prune", "git reset --hard", "git reset --merge", "git reset --keep", "git checkout -f",
  "git checkout --force x", "git checkout -B x", "git clean -fd", "rm x",
];

const NEGATIVE = [
  ["git branch topic", "auto_execute"],
  ["git branch -d topic", "auto_execute"],
  ["git branch --list", "auto_execute"],
  ["git checkout a2eff46 -- packages/telemetry-dashboard/vite-plugin-telemetry-api.ts", "auto_execute"],
  ["git checkout HEAD -- -f", "auto_execute"],
  ["git push origin main", "auto_execute"],
  ['git commit -m "fix -f"', "execute_with_plan_approval"],
];

function policyWith(tier, entries) {
  return {
    auto_execute: tier === "auto_execute" ? entries : [],
    execute_with_plan_approval: tier === "execute_with_plan_approval" ? entries : [],
    require_explicit_confirmation: [],
  };
}

function writePolicy(root, policy) {
  fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
  const list = (xs) => (xs.length ? xs.map((x) => `    - ${JSON.stringify(x)}`).join("\n") : "    []");
  fs.writeFileSync(
    path.join(root, ".routekit", "command-policy.yaml"),
    [
      "command_policy:",
      "  auto_execute:",
      list(policy.auto_execute),
      "  execute_with_plan_approval:",
      list(policy.execute_with_plan_approval),
      "  require_explicit_confirmation:",
      list(policy.require_explicit_confirmation),
      "",
    ].join("\n"),
  );
}

let bareRoot;
let vetoRoot;
let nodeRoot;
let errSpy;

beforeEach(() => {
  spawnManaged.mockClear();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  bareRoot = makeTempDir("cr-allow-bare");
  vetoRoot = makeTempDir("cr-allow-veto");
  nodeRoot = makeTempDir("cr-allow-node");
  writePolicy(vetoRoot, VETO_POLICY);
  writePolicy(nodeRoot, { auto_execute: ["node"], execute_with_plan_approval: ["git add"], require_explicit_confirmation: [] });
});

afterEach(() => {
  errSpy.mockRestore();
  for (const r of [bareRoot, vetoRoot, nodeRoot]) fs.rmSync(r, { recursive: true, force: true });
});

describe("isRunnerEntry", () => {
  it("is true for every bare interpreter and script-runner entry", () => {
    for (const e of BARE_RUNNERS) expect(isRunnerEntry(e), e).toBe(true);
  });

  it("is true for an interpreter or shell entry carrying an inline-code flag", () => {
    for (const e of INLINE_RUNNERS) expect(isRunnerEntry(e), e).toBe(true);
  });

  it("is false for an entry naming a specific target or a non-runner verb", () => {
    for (const e of SPECIFIC) expect(isRunnerEntry(e), e).toBe(false);
  });
});

describe("classifyCommand refuses runner entries in both executing tiers", () => {
  it("never admits a payload through a runner entry in either executing tier", () => {
    for (const tier of EXECUTING) {
      for (const [entry, cmd] of PAYLOADS) {
        expect(EXECUTING, `${tier} ${entry} -> ${cmd}`).not.toContain(classifyCommand(cmd, policyWith(tier, [entry])));
      }
      for (const entry of BARE_RUNNERS) {
        const cmd = `${entry} payload`;
        expect(EXECUTING, `${tier} ${cmd}`).not.toContain(classifyCommand(cmd, policyWith(tier, [entry])));
      }
    }
  });

  it("still admits through an entry naming a specific script", () => {
    for (const tier of EXECUTING) {
      const policy = policyWith(tier, ["node scripts/foo.mjs", "npm run test:unit"]);
      expect(classifyCommand("node scripts/foo.mjs --x", policy)).toBe(tier);
      expect(classifyCommand("npm run test:unit -- tests/unit/x.test.mjs", policy)).toBe(tier);
    }
  });
});

describe("refusedPolicyEntries", () => {
  it("lists every runner entry with its tier and reason runner_entry", () => {
    const refused = refusedPolicyEntries(MIXED);
    expect(refused).toHaveLength(4);
    expect(refused).toEqual(
      expect.arrayContaining([
        { tier: "auto_execute", entry: "node", reason: "runner_entry" },
        { tier: "auto_execute", entry: "bash -c", reason: "runner_entry" },
        { tier: "execute_with_plan_approval", entry: "npm run", reason: "runner_entry" },
        { tier: "execute_with_plan_approval", entry: "git config", reason: "runner_entry" },
      ]),
    );
  });

  it("agrees with classifyCommand for every executing-tier entry", () => {
    const refused = refusedPolicyEntries(MIXED);
    for (const tier of EXECUTING) {
      for (const entry of MIXED[tier]) {
        const listed = refused.some((r) => r.tier === tier && r.entry === entry);
        const got = classifyCommand(entry, MIXED);
        if (listed) expect(EXECUTING, entry).not.toContain(got);
        else expect(got, entry).toBe(tier);
      }
    }
  });
});

describe("built-in destructive-flag veto", () => {
  it("classifies every flag-spelled destructive form require_explicit_confirmation with an empty confirmation list", () => {
    for (const cmd of VETOED) expect(classifyCommand(cmd, VETO_POLICY), cmd).toBe("require_explicit_confirmation");
  });

  it("handleRunCommandStep skips every vetoed form and spawns nothing", async () => {
    for (const cmd of VETOED) {
      const r = await handleRunCommandStep(cmd, { projectRoot: vetoRoot, planApproved: true, timeout: TIMEOUT });
      expect(r.skipped, cmd).toBe(true);
      expect(r.reason, cmd).toBe("requires_explicit_confirmation");
      expect(r.executed, cmd).toBeUndefined();
    }
    expect(spawnManaged).not.toHaveBeenCalled();
  });

  it("does not veto the negative controls, which classify as their executing tier", () => {
    for (const [cmd, tier] of NEGATIVE) expect(classifyCommand(cmd, VETO_POLICY), cmd).toBe(tier);
  });
});

describe("classification precedence", () => {
  it("rejects shell syntax before the built-in veto", () => {
    const policy = { ...VETO_POLICY, auto_execute: [...VETO_POLICY.auto_execute, "rm"] };
    expect(classifyCommand("rm -rf build; ls", policy)).toBe("shell_syntax_rejected");
  });

  it("ranks the built-in veto above auto_execute", () => {
    const policy = { auto_execute: ["git branch", "git push"], execute_with_plan_approval: [], require_explicit_confirmation: [] };
    expect(classifyCommand("git branch -D x", policy)).toBe("require_explicit_confirmation");
    expect(classifyCommand("git push --force", policy)).toBe("require_explicit_confirmation");
  });
});

describe("this repo's command policy", () => {
  it("classifies the measured commands as pinned", () => {
    const policy = loadCommandPolicy(REPO_ROOT);
    expect(EXECUTING).not.toContain(classifyCommand("node -e 0", policy));
    expect(EXECUTING).not.toContain(classifyCommand("npm run test:smoke", policy));
    expect(classifyCommand("npm run test:unit -- tests/unit/x.test.mjs", policy)).toBe("auto_execute");
    expect(classifyCommand("npm install ./vendor-pkg", policy)).toBe("execute_with_plan_approval");
    expect(EXECUTING).not.toContain(classifyCommand("git branch --delete --force x", policy));
  });

  it("holds no runner entry and keeps the sanctioned plan-approval entries", () => {
    const policy = loadCommandPolicy(REPO_ROOT);
    expect(policy.auto_execute).not.toContain("node");
    expect(policy.auto_execute).toContain("npm run test:unit");
    for (const gone of ["npm run", "git branch", "git merge"]) {
      expect(policy.execute_with_plan_approval, gone).not.toContain(gone);
    }
    expect(policy.execute_with_plan_approval).toEqual(
      expect.arrayContaining(["git add", "git rm --cached", "git commit", "git checkout", "npm install"]),
    );
    expect(refusedPolicyEntries(policy)).toEqual([]);
  });
});

describe("default policy", () => {
  it("deep-equals the defaults literal and refuses none of its entries", () => {
    expect(loadCommandPolicy(bareRoot)).toEqual(DEFAULTS);
    expect(refusedPolicyEntries(DEFAULTS)).toEqual([]);
  });
});

describe("handleRunCommandStep reasons are unchanged", () => {
  it("skips a runner-refused command with unknown_command and spawns nothing", async () => {
    const r = await handleRunCommandStep("node -e 0", { projectRoot: nodeRoot, planApproved: true, timeout: TIMEOUT });
    expect(r.classification).toBe("unknown");
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("unknown_command");
    expect(r.refusedEntry).toEqual({ tier: "auto_execute", entry: "node", reason: "runner_entry" });
    expect(spawnManaged).not.toHaveBeenCalled();
  });

  it("logs the refused runner entry exactly once on stderr", async () => {
    await handleRunCommandStep("node -e 0", { projectRoot: nodeRoot, planApproved: true, timeout: TIMEOUT });
    const lines = errSpy.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes("runner_entry"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("auto_execute");
    expect(lines[0]).toContain('"node"');
    expect(lines[0]).toContain("node -e 0");
  });

  it("derives refusedEntry from refusedPolicyEntries in either executing tier", () => {
    for (const tier of EXECUTING) {
      const policy = policyWith(tier, ["git status", "npm run"]);
      const got = refusedEntryFor("npm run anything", policy);
      expect(got, tier).toEqual({ tier, entry: "npm run", reason: "runner_entry" });
      expect(refusedPolicyEntries(policy), tier).toContainEqual(got);
      expect(refusedEntryFor("git status", policy), tier).toBeNull();
      expect(refusedEntryFor("frobnicate --now", policy), tier).toBeNull();
    }
  });

  it("sets no refusedEntry and logs nothing when no refused entry matches or the outcome is not unknown", async () => {
    const unknown = await handleRunCommandStep("frobnicate --now", { projectRoot: nodeRoot, planApproved: true, timeout: TIMEOUT });
    expect(unknown.reason).toBe("unknown_command");
    expect(unknown).not.toHaveProperty("refusedEntry");
    const plan = await handleRunCommandStep("git add .", { projectRoot: nodeRoot, planApproved: false, timeout: TIMEOUT });
    expect(plan.reason).toBe("requires_plan_approval");
    expect(plan).not.toHaveProperty("refusedEntry");
    const vetoed = await handleRunCommandStep("git branch -D x", { projectRoot: vetoRoot, planApproved: true, timeout: TIMEOUT });
    expect(vetoed.reason).toBe("requires_explicit_confirmation");
    expect(vetoed).not.toHaveProperty("refusedEntry");
    expect(errSpy.mock.calls.some((c) => c.map(String).join(" ").includes("runner_entry"))).toBe(false);
    expect(spawnManaged).not.toHaveBeenCalled();
  });

  it("emits only the four existing skip reasons", async () => {
    const corpus = ["node -e 0", "git branch -D x", "git add .", "git status; ls", "frobnicate --now"];
    const seen = new Set();
    for (const cmd of corpus) {
      const r = await handleRunCommandStep(cmd, { projectRoot: nodeRoot, planApproved: false, timeout: TIMEOUT });
      expect(r.skipped, cmd).toBe(true);
      expect(REASONS, cmd).toContain(r.reason);
      seen.add(r.reason);
    }
    expect([...seen].sort()).toEqual([...REASONS].sort());
    expect(spawnManaged).not.toHaveBeenCalled();
  });
});

describe("formatScriptsForPrompt follows the policy", () => {
  it("returns the one-argument output unchanged when the policy argument is absent", () => {
    const scripts = { test: "vitest", lint: "eslint .", "test:smoke": "bash x.sh" };
    expect(formatScriptsForPrompt(scripts, undefined)).toEqual(formatScriptsForPrompt(scripts));
    expect(formatScriptsForPrompt(scripts, null)).toEqual(formatScriptsForPrompt(scripts));
    expect(formatScriptsForPrompt(null, undefined)).toEqual(formatScriptsForPrompt(null));
  });

  it("lists only admitted npm scripts for this repo's policy and scripts", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    const text = formatScriptsForPrompt(pkg.scripts, loadCommandPolicy(REPO_ROOT)).join("\n");
    expect(text).toMatch(/^\s*npm run test:unit →/m);
    expect(text).not.toMatch(/^\s*npm run test:smoke →/m);
  });

  it("returns the no-admitted-scripts line when no script qualifies", () => {
    const text = formatScriptsForPrompt({ setup: "node setup.mjs", dev: "vite" }, DEFAULTS).join("\n");
    expect(text).toContain("Do NOT generate run_command steps");
    expect(text).toContain(".routekit/command-policy.yaml");
    expect(text).not.toContain("npm run setup");
    expect(text).not.toContain("npm run dev");
  });
});

describe("planner-context passes the command policy to the script hint", () => {
  it("imports loadCommandPolicy and passes loadCommandPolicy(projectRoot) to formatScriptsForPrompt", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/planner-context.mjs"), "utf8");
    expect(src).toMatch(/import\s*\{[^}]*\bloadCommandPolicy\b[^}]*\}\s*from\s*["']\.\.\/exec\/command-runner\.mjs["']/);
    expect(src).toMatch(/formatScriptsForPrompt\(\s*pkgScripts\s*,\s*loadCommandPolicy\(\s*projectRoot\s*\)\s*\)/);
  });
});
