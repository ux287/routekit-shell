/**
 * backlog.feat.plugin-surface-v1 — the OSS declarative plugin surface.
 *
 * Manifest validator (fail-closed) + loader that installs a validated plugin's declared
 * agents/skills/hooks by REUSING the bootstrap copy primitives. All fs work is against temp dirs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateManifest, MANIFEST_FILENAME, ALLOWED_SURFACES } from "../../packages/cli/src/plugin/manifest-schema.mjs";
import { installPlugin, loadManifest } from "../../packages/cli/src/plugin/loader.mjs";
import { copyDirOverwrite, copyDirNoOverwrite } from "../../packages/cli/src/project/bootstrap.mjs";

function tmp(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), `rks-plugin-${prefix}-`));
}
function write(p, content = "stub") {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

// A well-formed plugin fixture on disk: manifest + one agent, one skill, one hook.
function buildPlugin(root, manifest) {
  write(path.join(root, "agents", "my-agent.md"), "---\nname: my-agent\n---\nAgent body");
  write(path.join(root, "skills", "my-skill", "SKILL.md"), "# My Skill");
  write(path.join(root, "hooks", "write", "my-hook.mjs"), "// my-hook");
  write(path.join(root, MANIFEST_FILENAME), JSON.stringify(manifest ?? {
    name: "my-plugin",
    version: "1.0.0",
    contributes: { agents: "agents", skills: "skills", hooks: "hooks" },
  }));
}

describe("validateManifest() — fail-closed", () => {
  const good = { name: "p", version: "1.0.0", contributes: { agents: "agents" } };

  it("accepts a well-formed manifest declaring agents/skills/hooks", () => {
    const r = validateManifest({ name: "p", version: "1.0.0", description: "d", contributes: { agents: "a", skills: "s", hooks: "h" } });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("rejects missing required fields (name, version) with per-field errors", () => {
    const r = validateManifest({ contributes: { agents: "a" } });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.field === "name")).toBe(true);
    expect(r.errors.some((e) => e.field === "version")).toBe(true);
  });

  it("rejects wrong-typed fields (name number, contributes array)", () => {
    expect(validateManifest({ name: 5, version: "1", contributes: { agents: "a" } }).ok).toBe(false);
    const r = validateManifest({ name: "p", version: "1", contributes: ["a"] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.field === "contributes")).toBe(true);
  });

  it("FAIL-CLOSED: rejects UNKNOWN top-level fields", () => {
    const r = validateManifest({ ...good, license: "MIT", entitlement: "pro" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.field === "license")).toBe(true);
    expect(r.errors.some((e) => e.field === "entitlement")).toBe(true);
  });

  it("FAIL-CLOSED: rejects UNKNOWN contributes surfaces", () => {
    const r = validateManifest({ name: "p", version: "1", contributes: { agents: "a", commands: "c" } });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.field === "contributes.commands")).toBe(true);
  });

  it("requires at least one surface, and rejects absolute / parent-traversal paths", () => {
    expect(validateManifest({ name: "p", version: "1", contributes: {} }).ok).toBe(false);
    expect(validateManifest({ name: "p", version: "1", contributes: { agents: "/etc" } }).ok).toBe(false);
    expect(validateManifest({ name: "p", version: "1", contributes: { agents: "../escape" } }).ok).toBe(false);
  });

  it("never throws on malformed/null/non-object input", () => {
    for (const bad of [null, undefined, 5, "str", []]) {
      expect(() => validateManifest(bad)).not.toThrow();
      expect(validateManifest(bad).ok).toBe(false);
    }
  });
});

describe("installPlugin() — install correctness over the three surfaces", () => {
  let pluginRoot, projectRoot;
  beforeEach(() => {
    pluginRoot = tmp("src");
    projectRoot = tmp("proj");
    buildPlugin(pluginRoot);
  });
  afterEach(() => {
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const manifest = () => JSON.parse(readFileSync(path.join(pluginRoot, MANIFEST_FILENAME), "utf8"));

  it("installs agents → .claude/agents, skills → .claude/skills, hooks → .routekit/hooks", () => {
    const r = installPlugin({ manifest: manifest(), pluginRoot, projectRoot });
    expect(r.ok).toBe(true);
    expect(r.installed.sort()).toEqual([...ALLOWED_SURFACES].sort());
    expect(existsSync(path.join(projectRoot, ".claude", "agents", "my-agent.md"))).toBe(true);
    expect(existsSync(path.join(projectRoot, ".claude", "skills", "my-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(projectRoot, ".routekit", "hooks", "write", "my-hook.mjs"))).toBe(true);
    // content landed byte-for-byte
    expect(readFileSync(path.join(projectRoot, ".claude", "agents", "my-agent.md"), "utf8")).toContain("Agent body");
  });

  it("DELEGATES to the reused bootstrap copy primitives (does not reimplement copying)", () => {
    const spyOver = vi.fn(copyDirOverwrite);
    const spyNo = vi.fn(copyDirNoOverwrite);
    const r = installPlugin({ manifest: manifest(), pluginRoot, projectRoot }, { copyDirOverwrite: spyOver, copyDirNoOverwrite: spyNo });
    expect(r.ok).toBe(true);
    // agents + skills → overwrite; hooks → no-overwrite (preserve project customizations)
    expect(spyOver).toHaveBeenCalledTimes(2);
    expect(spyNo).toHaveBeenCalledTimes(1);
    const hooksCall = spyNo.mock.calls[0];
    expect(hooksCall[1]).toBe(path.join(projectRoot, ".routekit", "hooks"));
  });

  it("hooks install is NO-OVERWRITE: an existing project hook is preserved", () => {
    const projHook = path.join(projectRoot, ".routekit", "hooks", "write", "my-hook.mjs");
    write(projHook, "// PROJECT CUSTOMIZATION");
    installPlugin({ manifest: manifest(), pluginRoot, projectRoot });
    expect(readFileSync(projHook, "utf8")).toBe("// PROJECT CUSTOMIZATION"); // not clobbered
  });

  it("is idempotent: re-installing produces the same result without crashing", () => {
    const r1 = installPlugin({ manifest: manifest(), pluginRoot, projectRoot });
    const r2 = installPlugin({ manifest: manifest(), pluginRoot, projectRoot });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.installed.sort()).toEqual(r1.installed.sort());
    expect(existsSync(path.join(projectRoot, ".claude", "agents", "my-agent.md"))).toBe(true);
  });

  it("installs only the DECLARED surfaces (a manifest with just agents installs no skills/hooks)", () => {
    const r = installPlugin({ manifest: { name: "p", version: "1", contributes: { agents: "agents" } }, pluginRoot, projectRoot });
    expect(r.ok).toBe(true);
    expect(r.installed).toEqual(["agents"]);
    expect(existsSync(path.join(projectRoot, ".claude", "agents", "my-agent.md"))).toBe(true);
    expect(existsSync(path.join(projectRoot, ".claude", "skills"))).toBe(false);
    expect(existsSync(path.join(projectRoot, ".routekit", "hooks"))).toBe(false);
  });
});

describe("installPlugin() — validate-before-install (no partial corruption)", () => {
  let pluginRoot, projectRoot;
  beforeEach(() => {
    pluginRoot = tmp("src");
    projectRoot = tmp("proj");
    buildPlugin(pluginRoot);
  });
  afterEach(() => {
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("rejects an INVALID manifest up-front and installs NOTHING", () => {
    const r = installPlugin({ manifest: { name: "p", contributes: { bogus: "x" } }, pluginRoot, projectRoot });
    expect(r.ok).toBe(false);
    expect(r.phase).toBe("validate");
    expect(existsSync(path.join(projectRoot, ".claude"))).toBe(false);
    expect(existsSync(path.join(projectRoot, ".routekit"))).toBe(false);
  });

  it("a MISSING contribution source fails cleanly and installs NOTHING (no partial write)", () => {
    // agents dir exists, but declare a hooks dir that does not exist → whole install must abort
    const manifest = { name: "p", version: "1", contributes: { agents: "agents", hooks: "does-not-exist" } };
    const r = installPlugin({ manifest, pluginRoot, projectRoot });
    expect(r.ok).toBe(false);
    expect(r.phase).toBe("resolve");
    expect(r.errors.some((e) => e.field === "contributes.hooks")).toBe(true);
    // agents must NOT have been partially installed
    expect(existsSync(path.join(projectRoot, ".claude", "agents", "my-agent.md"))).toBe(false);
  });
});

describe("loadManifest() + OSS-tier scope guard", () => {
  let pluginRoot;
  beforeEach(() => { pluginRoot = tmp("src"); buildPlugin(pluginRoot); });
  afterEach(() => { rmSync(pluginRoot, { recursive: true, force: true }); });

  it("loadManifest reads + validates rks-plugin.json from a plugin dir", () => {
    const r = loadManifest(pluginRoot);
    expect(r.ok).toBe(true);
    expect(r.manifest.name).toBe("my-plugin");
  });

  it("loadManifest fails cleanly on a missing or malformed manifest file", () => {
    expect(loadManifest(tmp("empty")).ok).toBe(false);
    write(path.join(pluginRoot, MANIFEST_FILENAME), "{ not json");
    expect(loadManifest(pluginRoot).ok).toBe(false);
  });

  it("OSS purity: the loader + schema source contain no gating/entitlement/license/telemetry/signing logic", () => {
    const loaderSrc = readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../packages/cli/src/plugin/loader.mjs"), "utf8");
    const schemaSrc = readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../packages/cli/src/plugin/manifest-schema.mjs"), "utf8");
    for (const banned of [/entitlement.*check/i, /verifyLicense/i, /checkLicense/i, /requirePro/i, /emit\(/, /telemetry\./i, /verifySignature/i, /trustRoot/i]) {
      expect(loaderSrc, `loader must not contain ${banned}`).not.toMatch(banned);
      expect(schemaSrc, `schema must not contain ${banned}`).not.toMatch(banned);
    }
  });
});
