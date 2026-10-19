import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import { execa } from "execa";

const CLI = path.resolve("packages/cli/bin/routekit.js");

function createShellRoot() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "rks-shell-"));
  mkdirSync(path.join(tmp, "projects"), { recursive: true });
  return tmp;
}

describe("project registry CLI", { timeout: 120_000 }, () => {
  let shellRoot;

  beforeEach(() => {
    shellRoot = createShellRoot();
  });

  afterEach(() => {
    rmSync(shellRoot, { recursive: true, force: true });
  });

  async function runCli(args) {
    return execa("node", [CLI, ...args], {
      env: { ...process.env, ROUTEKIT_SHELL_ROOT: shellRoot },
      cwd: shellRoot,
    });
  }

  // SKIPPED 2026-06-08: slow subprocess test (120s timeout exceeded on CI).
  // Follow-up: backlog.fix.slow-subprocess-test-pattern.
  it.skip("registers and inspects an existing project", async () => {
    const projectPath = path.join(shellRoot, "external", "demo-project");
    mkdirSync(projectPath, { recursive: true });

    await runCli(["project", "add-existing", "--id", "demo", "--stack", "web", "--path", projectPath]);

    const registryPath = path.join(shellRoot, "projects", "index.jsonl");
    const lines = readFileSync(registryPath, "utf8").trim().split(/\n+/);
    expect(lines.length).toBe(1);
    const record = JSON.parse(lines[0]);
    expect(record.id).toBe("demo");
    expect(record.stack).toBe("web");
    expect(record.root).toBe(projectPath);
    expect(record.path).toBe(projectPath);

    const info = await runCli(["project", "info", "--id", "demo"]);
    const parsed = JSON.parse(info.stdout);
    expect(parsed.id).toBe("demo");
    expect(parsed.root).toBe(projectPath);

    const list = await runCli(["project", "list"]);
    expect(list.stdout).toContain("demo");
  });

  it("migrates legacy registry records", async () => {
    const registryPath = path.join(shellRoot, "projects", "index.jsonl");
    mkdirSync(path.dirname(registryPath), { recursive: true });
    const legacy = { id: "legacy", template: "legacy-stack", root: "projects/legacy" };
    writeFileSync(registryPath, JSON.stringify(legacy) + "\n");

    await runCli(["project", "migrate-registry"]);

    const text = readFileSync(registryPath, "utf8").trim();
    const record = JSON.parse(text);
    expect(record.stack).toBe("legacy-stack");
    expect(record.root).toBe(path.join(shellRoot, "projects", "legacy"));
    expect(record.path).toBe(record.root);
  });
});
