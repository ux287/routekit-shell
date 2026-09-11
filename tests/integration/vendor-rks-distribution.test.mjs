import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir, ensureDir } from "../helpers/tmp.mjs";

const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."));
const vendorScript = path.join(repoRoot, "scripts", "vendor-rks.sh");
const SCRIPT_TIMEOUT = 90_000;

function makeTargetProject(name) {
  const targetDir = makeTempDir(name);
  ensureDir(path.join(targetDir, ".rks"));
  fs.writeFileSync(
    path.join(targetDir, ".rks", "project.json"),
    JSON.stringify({ projectId: name }, null, 2)
  );
  return targetDir;
}

// SUBSTITUTION WITNESS. Until this case existed, this file contained ZERO `routekit-shell`
// matches and never asserted substitution at all — which is exactly why a vendor-rks half-fix
// once passed green here. It drives the script against a SYNTHETIC source via the
// ROUTEKIT_SHELL_ROOT override, so nothing writes into the real worktree.
describe("vendor-rks.sh projectId substitution", () => {
  const SENTINEL = "__RKS_SOURCE_PROJECT__";
  const PLACEHOLDER = "__PROJECT_ID__";

  function makeSyntheticSource() {
    const shellRoot = makeTempDir("test-vendor-src-shell");
    ensureDir(path.join(shellRoot, ".claude", "skills", "arch"));
    // A COMPLETE TWO-TOKEN LAUNCH DIRECTIVE: the sentinel is SUBSTITUTED, the placeholder SURVIVES.
    fs.writeFileSync(
      path.join(shellRoot, ".claude", "skills", "arch", "SKILL.md"),
      `# ARCH Governor Skill\n\n` +
        `    You are an ARCH Governor for projectId ${SENTINEL}. Read your prompt at\n` +
        `    .rks/prompts/governor-arch.md. Replace ${PLACEHOLDER} with ${SENTINEL}\n` +
        `    and __STORY_IDS__ with $ARGUMENTS. Then execute the ARCH review.\n`
    );
    ensureDir(path.join(shellRoot, ".rks", "prompts"));
    fs.writeFileSync(path.join(shellRoot, ".rks", "prompts", "governor-arch.md"), "# ARCH Governor\n");
    return shellRoot;
  }

  it("substitutes the sentinel with the target projectId and preserves the placeholder", () => {
    const shellRoot = makeSyntheticSource();
    const target = makeTargetProject("test-vendor-subst");

    const result = spawnSync("bash", [vendorScript, target], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT,
      env: { ...process.env, ROUTEKIT_SHELL_ROOT: shellRoot },
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);

    // Read the witness skill BY NAME. The script can SKIP skills, so a missing file must FAIL
    // with an explicit message naming it — never skip, never pass silently.
    const witness = path.join(target, ".claude", "skills", "arch", "SKILL.md");
    expect(
      fs.existsSync(witness),
      `vendor run did not copy the witness skill ${witness}\n${result.stdout}\n${result.stderr}`
    ).toBe(true);

    const delivered = fs.readFileSync(witness, "utf8");
    // the id the script resolved, read back from the target's own registry file
    const targetId = JSON.parse(
      fs.readFileSync(path.join(target, ".rks", "project.json"), "utf8")
    ).projectId;
    expect(targetId).toBeTruthy();

    expect(delivered).toContain(`for projectId ${targetId}.`); // target id VERBATIM
    expect(delivered).not.toContain(SENTINEL); // NO surviving sentinel
    expect(delivered).toContain(PLACEHOLDER); // placeholder STILL RETAINED
    expect(delivered).toContain(`Replace ${PLACEHOLDER} with ${targetId}`); // two distinct tokens
  });
});

describe("vendor-rks.sh vitest runner distribution", () => {
  it("copies scripts/vitest-runner.mjs to target project", () => {
    const target = makeTargetProject("test-vendor-vitest");
    const result = spawnSync("bash", [vendorScript, target], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.existsSync(path.join(target, "scripts", "vitest-runner.mjs"))).toBe(true);
  });

  it("copies scripts/lib/spawn-managed.mjs to target project", () => {
    const target = makeTargetProject("test-vendor-spawn");
    const result = spawnSync("bash", [vendorScript, target], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.existsSync(path.join(target, "scripts", "lib", "spawn-managed.mjs"))).toBe(true);
  });

  it("creates scripts/lib/ directory in target project if absent", () => {
    const target = makeTargetProject("test-vendor-mkdir");
    expect(fs.existsSync(path.join(target, "scripts"))).toBe(false);
    const result = spawnSync("bash", [vendorScript, target], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.existsSync(path.join(target, "scripts", "lib"))).toBe(true);
  });

  it("overwrites existing vitest-runner.mjs with latest from source", () => {
    const target = makeTargetProject("test-vendor-overwrite");
    ensureDir(path.join(target, "scripts"));
    fs.writeFileSync(path.join(target, "scripts", "vitest-runner.mjs"), "STALE CONTENT");
    const result = spawnSync("bash", [vendorScript, target], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const content = fs.readFileSync(path.join(target, "scripts", "vitest-runner.mjs"), "utf8");
    expect(content).not.toBe("STALE CONTENT");
    expect(content).toContain("spawn-managed.mjs");
  });

  it("source scripts/vitest-runner.mjs is unchanged after vendor run", () => {
    const target = makeTargetProject("test-vendor-src-vitest-unchanged");
    const srcBefore = fs.readFileSync(path.join(repoRoot, "scripts", "vitest-runner.mjs"), "utf8");
    spawnSync("bash", [vendorScript, target], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT,
    });
    const srcAfter = fs.readFileSync(path.join(repoRoot, "scripts", "vitest-runner.mjs"), "utf8");
    expect(srcAfter).toBe(srcBefore);
  });

  it("source scripts/lib/spawn-managed.mjs is unchanged after vendor run", () => {
    const target = makeTargetProject("test-vendor-src-spawn-unchanged");
    const srcBefore = fs.readFileSync(path.join(repoRoot, "scripts", "lib", "spawn-managed.mjs"), "utf8");
    spawnSync("bash", [vendorScript, target], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT,
    });
    const srcAfter = fs.readFileSync(path.join(repoRoot, "scripts", "lib", "spawn-managed.mjs"), "utf8");
    expect(srcAfter).toBe(srcBefore);
  });

  it("import integrity: copied vitest-runner.mjs references spawn-managed.mjs and content matches source", () => {
    const target = makeTargetProject("test-vendor-import-integrity");
    const result = spawnSync("bash", [vendorScript, target], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const runnerPath = path.join(target, "scripts", "vitest-runner.mjs");
    const spawnPath = path.join(target, "scripts", "lib", "spawn-managed.mjs");
    expect(fs.existsSync(runnerPath)).toBe(true);
    expect(fs.existsSync(spawnPath)).toBe(true);
    const runnerContent = fs.readFileSync(runnerPath, "utf8");
    expect(runnerContent).toContain("spawn-managed.mjs");
    const srcRunner = fs.readFileSync(path.join(repoRoot, "scripts", "vitest-runner.mjs"), "utf8");
    expect(runnerContent).toBe(srcRunner);
  });

  it("vendor script exits with code 0 and leaves no .bak files in target (cross-platform sed)", () => {
    const target = makeTargetProject("test-vendor-cross-platform");
    const result = spawnSync("bash", [vendorScript, target], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    // Verify no .bak residue left by sed -i.bak
    const bakFiles = [];
    function findBak(dir) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) findBak(full);
        else if (entry.name.endsWith(".bak")) bakFiles.push(full);
      }
    }
    findBak(target);
    expect(bakFiles, `unexpected .bak files: ${bakFiles.join(", ")}`).toHaveLength(0);
  });
});
