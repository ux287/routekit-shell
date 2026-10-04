import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { vendorViaSubtree } from "../../packages/cli/src/vendor/toolchain.mjs";

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}\n${res.stderr || res.stdout}`);
  }
  return String(res.stdout || "").trim();
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}_${Date.now()}_`));
}

describe("vendoring toolchain (subtree)", () => {
  it("adds then pulls a subtree and writes ROUTEKIT_PIN.json", async () => {
    const shellSrc = tmpDir("rks_shell_src");
    run("git", ["init"], shellSrc);
    run("git", ["config", "user.email", "test@example.com"], shellSrc);
    run("git", ["config", "user.name", "Test"], shellSrc);
    fs.writeFileSync(path.join(shellSrc, "package.json"), JSON.stringify({ name: "routekit-shell", version: "1.0.0" }, null, 2));
    run("git", ["add", "."], shellSrc);
    run("git", ["commit", "-m", "init"], shellSrc);
    run("git", ["branch", "-M", "main"], shellSrc);

    const bare = tmpDir("rks_shell_bare");
    run("git", ["init", "--bare"], bare);
    run("git", ["remote", "add", "origin", bare], shellSrc);
    run("git", ["push", "-u", "origin", "main"], shellSrc);

    const projectRoot = tmpDir("rks_project_subtree");
    run("git", ["init"], projectRoot);
    run("git", ["config", "user.email", "test@example.com"], projectRoot);
    run("git", ["config", "user.name", "Test"], projectRoot);
    fs.writeFileSync(path.join(projectRoot, "README.md"), "hi\n");
    run("git", ["add", "."], projectRoot);
    run("git", ["commit", "-m", "init"], projectRoot);

    const addRes = await vendorViaSubtree({
      shellRoot: shellSrc,
      projectRoot,
      remoteUrl: bare,
      ref: "main",
      gitInit: false,
    });
    expect(addRes.ok).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "tools", "routekit-shell", "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "tools", "routekit-shell", "ROUTEKIT_PIN.json"))).toBe(true);

    fs.writeFileSync(path.join(shellSrc, "package.json"), JSON.stringify({ name: "routekit-shell", version: "1.0.1" }, null, 2));
    run("git", ["add", "."], shellSrc);
    run("git", ["commit", "-m", "bump"], shellSrc);
    run("git", ["push"], shellSrc);

    const pullRes = await vendorViaSubtree({
      shellRoot: shellSrc,
      projectRoot,
      remoteUrl: bare,
      ref: "main",
      gitInit: false,
    });
    expect(pullRes.ok).toBe(true);
    const vendoredPkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "tools", "routekit-shell", "package.json"), "utf8"));
    expect(vendoredPkg.version).toBe("1.0.1");
  }, { timeout: 60000 });

  it("requires a git repo (or --git-init) and a HEAD commit", async () => {
    const shellSrc = tmpDir("rks_shell_src2");
    fs.writeFileSync(path.join(shellSrc, "package.json"), "{}\n");

    const bare = tmpDir("rks_shell_bare2");
    run("git", ["init", "--bare"], bare);

    const projectRoot = tmpDir("rks_project_no_git");
    await expect(
      vendorViaSubtree({ shellRoot: shellSrc, projectRoot, remoteUrl: bare, ref: "main", gitInit: false })
    ).rejects.toThrow(/--git-init|initialize git/i);

    await expect(
      vendorViaSubtree({ shellRoot: shellSrc, projectRoot, remoteUrl: bare, ref: "main", gitInit: true })
    ).rejects.toThrow(/at least one commit|HEAD/i);
  }, { timeout: 60000 });
});

