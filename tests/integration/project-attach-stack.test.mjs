import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { makeTempDir, ensureDir, writeFile } from "../helpers/tmp.mjs";

function copyDirRecursive(srcDir, destDir) {
  ensureDir(destDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dest);
      continue;
    }
    if (!entry.isFile()) continue;
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}

describe("routekit project attach --stack", () => {
  it("applies template kg/protected-files and seeds notes without overwrite", () => {
    const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
    const cliPath = path.join(repoRoot, "packages", "cli", "bin", "routekit.js");

    const shellRoot = makeTempDir("shellroot_attach_stack");
    const templateSrc = path.join(repoRoot, "templates", "web-11ty-nunjucks");
    const templateDest = path.join(shellRoot, "templates", "web-11ty-nunjucks");
    copyDirRecursive(templateSrc, templateDest);

    // The rks-version stamp reads the shell root package.json version.
    writeFile(path.join(shellRoot, "package.json"), JSON.stringify({ name: "routekit-shell-core", version: "9.9.9" }));

    const projectRoot = makeTempDir("attached_project");
    ensureDir(path.join(projectRoot, "notes"));
    writeFile(path.join(projectRoot, "notes", "root.md"), "DO NOT OVERWRITE\n");

    writeFile(
      path.join(projectRoot, ".rks", "protected-files.yml"),
      YAML.stringify({ protected: ["existing/**"], projectProtected: [] })
    );

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "project",
        "attach",
        "--id",
        "snacks",
        "--path",
        projectRoot,
        "--stack",
        "web-11ty-nunjucks",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, ROUTEKIT_SHELL_ROOT: shellRoot },
      }
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);

    const kgPath = path.join(projectRoot, "routekit", "kg.yaml");
    expect(fs.existsSync(kgPath)).toBe(true);
    expect(fs.readFileSync(kgPath, "utf8")).toMatch(/framework:\s*eleventy-nunjucks/);

    const projectJsonPath = path.join(projectRoot, "routekit", "project.json");
    const projectJson = JSON.parse(fs.readFileSync(projectJsonPath, "utf8"));
    expect(projectJson.stack).toBe("web-11ty-nunjucks");

    const protectedPath = path.join(projectRoot, ".rks", "protected-files.yml");
    const protectedConfig = YAML.parse(fs.readFileSync(protectedPath, "utf8"));
    expect(protectedConfig.protected).toContain("existing/**");
    expect(protectedConfig.projectProtected).toContain("tools/routekit-shell/**");

    const dendronPath = path.join(projectRoot, "dendron.yml");
    const dendronConfig = YAML.parse(fs.readFileSync(dendronPath, "utf8"));
    expect(dendronConfig.version).toBe(5);
    expect(Array.isArray(dendronConfig?.workspace?.vaults)).toBe(true);

    expect(fs.existsSync(path.join(projectRoot, "notes", "stack.welcome.md"))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "notes", "root.schema.yml"))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "notes", "root.md"))).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, "notes", "root.md"), "utf8")).toBe("DO NOT OVERWRITE\n");
    expect(fs.existsSync(path.join(projectRoot, "notes", "snacks.welcome.md"))).toBe(false);

    const registryPath = path.join(shellRoot, "projects", "index.jsonl");
    expect(fs.existsSync(registryPath)).toBe(true);
    const lines = fs.readFileSync(registryPath, "utf8").trim().split("\n").filter(Boolean);
    const record = JSON.parse(lines[lines.length - 1]);
    expect(record.id).toBe("snacks");
    expect(record.stack).toBe("web-11ty-nunjucks");

    // rks-version stamp: attach writes the REAL shell version into .rks/project.json,
    // not the frozen "0.1.0" literal.
    const rksProjectJson = JSON.parse(fs.readFileSync(path.join(projectRoot, ".rks", "project.json"), "utf8"));
    expect(rksProjectJson.rksVersion).toBe("9.9.9");
    expect(rksProjectJson.rksVersion).not.toBe("0.1.0");

    // Re-attach after a shell version bump advances the stamp (update branch).
    writeFile(path.join(shellRoot, "package.json"), JSON.stringify({ name: "routekit-shell-core", version: "9.9.10" }));
    const reattach = spawnSync(
      process.execPath,
      [cliPath, "project", "attach", "--id", "snacks", "--path", projectRoot, "--stack", "web-11ty-nunjucks"],
      { encoding: "utf8", timeout: 60000, env: { ...process.env, ROUTEKIT_SHELL_ROOT: shellRoot } }
    );
    expect(reattach.status, reattach.stderr || reattach.stdout).toBe(0);
    const rksProjectJson2 = JSON.parse(fs.readFileSync(path.join(projectRoot, ".rks", "project.json"), "utf8"));
    expect(rksProjectJson2.rksVersion).toBe("9.9.10");
  });
});
