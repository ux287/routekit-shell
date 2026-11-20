import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";

vi.mock("../../scripts/lib/spawn-managed.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnManaged: vi.fn((...args) => actual.spawnManaged(...args)) };
});

import { spawnManaged, ALL_EXIT_CODES } from "../../scripts/lib/spawn-managed.mjs";
import {
  classifyCommand,
  handleRunCommandStep,
  loadCommandPolicy,
} from "../../packages/mcp-rks/src/exec/command-runner.mjs";

const TIMEOUT = 15_000;
const EXECUTING = ["auto_execute", "execute_with_plan_approval"];

const DEFAULTS = {
  auto_execute: ["git status", "git diff", "npm test", "npm run lint", "npm run build"],
  execute_with_plan_approval: ["git add", "git rm --cached", "git commit", "npm install"],
  require_explicit_confirmation: ["rm", "git reset", "git push --force", "git branch -D"],
};

const FILE_POLICY = {
  auto_execute: ["git status", "git diff", "git log", "npm test", "node"],
  execute_with_plan_approval: ["git add", "npm run", "git branch"],
  require_explicit_confirmation: ["rm", "git reset", "git branch -D"],
};

// Each entry names the marker file a shell would create if it interpreted the command.
const SHELL_SYNTAX = [
  { cmd: "node -e 0 && touch PWNED_AND", marker: "PWNED_AND" },
  { cmd: "git status --short; touch PWNED_SEMI", marker: "PWNED_SEMI" },
  { cmd: "git diff | sh", marker: null },
  { cmd: "npm test $(touch PWNED_SUBST)", marker: "PWNED_SUBST" },
  { cmd: "npm test `touch PWNED_TICK`", marker: "PWNED_TICK" },
  { cmd: "git status > PWNED_REDIR", marker: "PWNED_REDIR" },
  { cmd: "git status --short\ntouch PWNED_NL", marker: "PWNED_NL" },
];

// Plan-approval-tier prefixes carrying shell syntax.
const PLAN_TIER_SHELL_SYNTAX = [
  { cmd: "git add --no-such-flag-7f3a || touch PWNED_ADD", marker: "PWNED_ADD" },
  { cmd: "npm run build; touch PWNED_RUN", marker: "PWNED_RUN" },
];

const ALL_SHELL_SYNTAX = [...SHELL_SYNTAX, ...PLAN_TIER_SHELL_SYNTAX];

// The headline side-effect command. Its admitted prefix EXITS 0 in a non-git temp root, so the
// pre-fix /bin/sh -c executor reaches `touch`. (tests/helpers/tmp.mjs: nothing above os.tmpdir()
// is a git repository, so a `git status && ...` prefix would short-circuit and prove nothing.)
const HEADLINE = "node -e 0 && touch PWNED";

// The pre-fix classifier's executing-tier rule (classifyCommand before this story): a pattern
// admits a command when cmd === pattern or cmd starts with pattern + " ". Used only by the
// non-vacuity control below.
function legacyAdmits(cmd, policy) {
  const c = cmd.trim();
  return [...policy.auto_execute, ...policy.execute_with_plan_approval].some(
    (p) => c === p || c.startsWith(p + " "),
  );
}

function writePolicy(root, policy) {
  fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
  const list = (xs) => xs.map((x) => `    - ${JSON.stringify(x)}`).join("\n");
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

function isShellSpawn(call) {
  const [cmd, args = [], opts = {}] = call;
  return /(^|\/)(sh|bash|zsh|dash)$/.test(String(cmd)) || args[0] === "-c" || opts.shell === true;
}

let bareRoot;
let policyRoot;

beforeEach(() => {
  spawnManaged.mockClear();
  bareRoot = makeTempDir("cr-shell-bare");
  policyRoot = makeTempDir("cr-shell-policy");
  writePolicy(policyRoot, FILE_POLICY);
});

afterEach(() => {
  fs.rmSync(bareRoot, { recursive: true, force: true });
  fs.rmSync(policyRoot, { recursive: true, force: true });
});

describe("classifyCommand shell-syntax rejection", () => {
  it("never classifies a shell-syntax command as an executing tier under the default policy", () => {
    const policy = loadCommandPolicy(bareRoot);
    for (const { cmd } of SHELL_SYNTAX) {
      expect(EXECUTING, cmd).not.toContain(classifyCommand(cmd, policy));
    }
    for (const cmd of ["git status && touch X", "git status; touch X", "git status\ntouch X", "git add . && touch X"]) {
      expect(EXECUTING, cmd).not.toContain(classifyCommand(cmd, policy));
    }
  });

  it("never classifies a shell-syntax command as an executing tier under a file-supplied policy, for both executing tiers", () => {
    const policy = loadCommandPolicy(policyRoot);
    for (const { cmd } of ALL_SHELL_SYNTAX) {
      expect(EXECUTING, cmd).not.toContain(classifyCommand(cmd, policy));
    }
  });
});

describe("handleRunCommandStep shell-syntax rejection", () => {
  it("returns a non-executed outcome with a shell-syntax reason and spawns no process", async () => {
    for (const { cmd } of ALL_SHELL_SYNTAX) {
      const r = await handleRunCommandStep(cmd, { projectRoot: policyRoot, planApproved: true, timeout: TIMEOUT });
      expect(r.skipped, cmd).toBe(true);
      expect(r.executed, cmd).toBeUndefined();
      expect(r.exec, cmd).toBeUndefined();
      expect(String(r.reason), cmd).toMatch(/shell/i);
    }
    expect(spawnManaged).not.toHaveBeenCalled();
  });

  it("leaves no side-effect file on disk when an admitted prefix carries shell syntax", async () => {
    const r = await handleRunCommandStep(HEADLINE, {
      projectRoot: policyRoot,
      planApproved: true,
      timeout: TIMEOUT,
    });
    expect(r.executed).toBeUndefined();
    expect(fs.existsSync(path.join(policyRoot, "PWNED"))).toBe(false);

    for (const { cmd } of ALL_SHELL_SYNTAX) {
      await handleRunCommandStep(cmd, { projectRoot: policyRoot, planApproved: true, timeout: TIMEOUT });
    }
    for (const { marker } of ALL_SHELL_SYNTAX.filter((c) => c.marker)) {
      expect(fs.existsSync(path.join(policyRoot, marker)), marker).toBe(false);
    }
  });

  // Non-vacuity control. The side-effect assertions above would also pass against UNFIXED code
  // if the pre-fix classifier refused a command, or if /bin/sh -c never reached its marker. This
  // pins both halves: every marker command is admitted by the pre-fix rule under FILE_POLICY, and
  // the pre-fix executor's exact spawn (/bin/sh -c, every exit code allowed) creates its marker.
  it.skipIf(process.platform === "win32")(
    "control: every marker command is admitted by the pre-fix rule and creates its marker under /bin/sh -c",
    async () => {
      const controlRoot = makeTempDir("cr-shell-control");
      try {
        for (const { cmd, marker } of [...ALL_SHELL_SYNTAX, { cmd: HEADLINE, marker: "PWNED" }]) {
          expect(legacyAdmits(cmd, FILE_POLICY), cmd).toBe(true);
          if (!marker) continue;
          await spawnManaged("/bin/sh", ["-c", cmd], {
            cwd: controlRoot,
            timeoutMs: TIMEOUT,
            allowedExitCodes: ALL_EXIT_CODES,
          });
          expect(fs.existsSync(path.join(controlRoot, marker)), marker).toBe(true);
        }
      } finally {
        fs.rmSync(controlRoot, { recursive: true, force: true });
      }
    },
  );
});

describe("classifyCommand argv-word matching", () => {
  it("does not match a pattern that is only a string prefix of the first word", () => {
    expect(EXECUTING).not.toContain(classifyCommand("git statusx", DEFAULTS));
  });

  it("matches a command whose leading argv words equal the pattern words", () => {
    expect(classifyCommand("git status --short", DEFAULTS)).toBe("auto_execute");
  });

  it("admits a quoted argument containing metacharacters as one literal word", () => {
    expect(classifyCommand('git log --format="%h (%s)"', FILE_POLICY)).toBe("auto_execute");
  });
});

// Re-homed (backlog.fix.run-command-allowlist-admits-arbitrary-code): a bare `node` entry is a
// runner entry and is refused, so these executions go through a specific-script entry instead.
// FILE_POLICY is deliberately left unchanged (legacyAdmits control, loadCommandPolicy toEqual).
const SCRIPT_POLICY = {
  auto_execute: ["node argv-probe.mjs"],
  execute_with_plan_approval: ["git add"],
  require_explicit_confirmation: ["rm"],
};
const ARGV_PROBE =
  'const [mode, ...rest] = process.argv.slice(2); if (mode === "argv") process.stdout.write(JSON.stringify(rest)); else if (mode === "print") process.stdout.write(rest.join(" ")); else process.exit(Number(rest[0] ?? 0));\n';

describe("executeCommand runs argv without a shell", () => {
  let scriptRoot;

  beforeEach(() => {
    scriptRoot = makeTempDir("cr-shell-script");
    writePolicy(scriptRoot, SCRIPT_POLICY);
    fs.writeFileSync(path.join(scriptRoot, "argv-probe.mjs"), ARGV_PROBE);
  });

  afterEach(() => {
    fs.rmSync(scriptRoot, { recursive: true, force: true });
  });

  it("passes a quoted metacharacter argument to the child verbatim and uninterpreted", { timeout: TIMEOUT }, async () => {
    const r = await handleRunCommandStep('node argv-probe.mjs argv "%h (%s)"', {
      projectRoot: scriptRoot,
      planApproved: true,
      timeout: TIMEOUT,
    });
    expect(r.executed).toBe(true);
    expect(r.exec.code).toBe(0);
    expect(JSON.parse(r.exec.stdout)).toEqual(["%h (%s)"]);
  });

  it("spawns the tokenized argv through spawnManaged with no shell", { timeout: TIMEOUT }, async () => {
    await handleRunCommandStep("node argv-probe.mjs exit 0", {
      projectRoot: scriptRoot,
      planApproved: true,
      timeout: TIMEOUT,
    });
    expect(spawnManaged).toHaveBeenCalledTimes(1);
    const call = spawnManaged.mock.calls[0];
    expect(isShellSpawn(call)).toBe(false);
    expect(call[0]).toBe("node");
    expect(call[1]).toEqual(["argv-probe.mjs", "exit", "0"]);
    expect(call[2].timeoutMs).toBe(TIMEOUT);
  });

  it("positive control: an admitted command still executes, captures stdout and reports its exit code", { timeout: TIMEOUT }, async () => {
    const ok = await handleRunCommandStep("node argv-probe.mjs print 42", {
      projectRoot: scriptRoot,
      planApproved: true,
      timeout: TIMEOUT,
    });
    expect(ok.executed).toBe(true);
    expect(ok.exec.code).toBe(0);
    expect(ok.exec.stdout).toBe("42");
    expect(ok.exec.error).toBeUndefined();

    const bad = await handleRunCommandStep("node argv-probe.mjs exit 3", {
      projectRoot: scriptRoot,
      planApproved: true,
      timeout: TIMEOUT,
    });
    expect(bad.executed).toBe(true);
    expect(bad.exec.code).toBe(3);
    expect(bad.exec.error).toBe(true);
  });
});

describe("require_explicit_confirmation still blocks", () => {
  it("classifies and skips confirmation-tier commands without spawning", async () => {
    for (const cmd of ["rm -rf build", "git reset --hard"]) {
      expect(classifyCommand(cmd, DEFAULTS), cmd).toBe("require_explicit_confirmation");
      const r = await handleRunCommandStep(cmd, { projectRoot: bareRoot, planApproved: true, timeout: TIMEOUT });
      expect(r.skipped, cmd).toBe(true);
      expect(r.reason, cmd).toBe("requires_explicit_confirmation");
      expect(r.executed, cmd).toBeUndefined();
    }
    expect(spawnManaged).not.toHaveBeenCalled();
  });
});

describe("classifyCommand tier precedence", () => {
  it("checks require_explicit_confirmation before either executing tier", () => {
    expect(classifyCommand("git branch -D topic", FILE_POLICY)).toBe("require_explicit_confirmation");
    expect(classifyCommand("git branch topic", FILE_POLICY)).toBe("execute_with_plan_approval");
  });

  it("fires a confirmation pattern only on leading argv words", () => {
    expect(classifyCommand('git log --format="%h (%s)"', FILE_POLICY)).toBe("auto_execute");
    expect(classifyCommand("git rm --cached file.txt", DEFAULTS)).toBe("execute_with_plan_approval");
  });

  it("rejects shell syntax before the confirmation tier", async () => {
    const r = await handleRunCommandStep("rm -rf build; ls", {
      projectRoot: bareRoot,
      planApproved: true,
      timeout: TIMEOUT,
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).not.toBe("requires_explicit_confirmation");
    expect(String(r.reason)).toMatch(/shell/i);
    expect(spawnManaged).not.toHaveBeenCalled();
  });
});

describe("spawn failure is a failed exec result, not a throw", () => {
  it("reports an admitted command missing from PATH as exit 127", async () => {
    const root = makeTempDir("cr-shell-missing");
    try {
      writePolicy(root, {
        auto_execute: ["rks-no-such-binary-7f3a"],
        execute_with_plan_approval: ["git add"],
        require_explicit_confirmation: ["rm"],
      });
      const r = await handleRunCommandStep("rks-no-such-binary-7f3a --flag", {
        projectRoot: root,
        planApproved: true,
        timeout: TIMEOUT,
      });
      expect(r.classification).toBe("auto_execute");
      expect(r.executed).toBe(true);
      expect(r.exec.code).toBe(127);
      expect(r.exec.error).toBe(true);
      expect(r.exec.spawnError).toBe("ENOENT");
      expect(spawnManaged).toHaveBeenCalledTimes(1);
      expect(isShellSpawn(spawnManaged.mock.calls[0])).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("planner prompt describes run_command without a shell", () => {
  const src = fs.readFileSync(new URL("../../packages/mcp-rks/src/llm/planner.mjs", import.meta.url), "utf8");

  it("no longer tells the planner that run_command takes a shell command", () => {
    for (const s of [
      "shell command if run_command",
      "command = shell command string",
      "Shell command execution",
      "provide concrete shell commands",
    ]) {
      expect(src.includes(s), s).toBe(false);
    }
  });

  it("says WITHOUT a shell in every run_command description in both prompt bodies", () => {
    const lines = src.split("\n");
    const commandFields = lines.filter((l) => l.includes('"command": "'));
    const actionLines = lines.filter((l) => l.includes('- "run_command":'));
    expect(commandFields.length).toBeGreaterThanOrEqual(2);
    expect(actionLines.length).toBeGreaterThanOrEqual(2);
    for (const l of [...commandFields, ...actionLines]) {
      expect(l, l).toContain("WITHOUT a shell");
    }
  });
});

describe("loadCommandPolicy", () => {
  it("returns the unchanged default policy when no policy file is present", () => {
    expect(loadCommandPolicy(bareRoot)).toEqual(DEFAULTS);
  });

  it("lets a present policy file replace the defaults wholesale", () => {
    expect(loadCommandPolicy(policyRoot)).toEqual(FILE_POLICY);
  });
});
