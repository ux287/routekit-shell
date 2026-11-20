// backlog.fix.remote-http-entry-env-leaks: the shared git env scrub set, the one-source rule, and the
// loadProjectContext launcher-secret and git restore groups. Temp project roots only (self mode via
// ROUTEKIT_PROJECT_ROOT); no git is spawned; the real repo, .rks and registry are never touched.
// Assertions compare and report key presence only, never values.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRUB_PATH = path.join(REPO_ROOT, "packages/mcp-rks/src/shared/remote-env-scrub.mjs");
const CONTEXT_PATH = path.join(REPO_ROOT, "packages/mcp-rks/src/project-context.mjs");
const BIN_PATH = path.join(REPO_ROOT, "packages/mcp-rks/bin/mcp-rks-http.mjs");
const { isScrubbedGitEnvKey, scrubGitEnv } = await import(pathToFileURL(SCRUB_PATH).href);
const { loadProjectContext } = await import(pathToFileURL(CONTEXT_PATH).href);

const LOCATION = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"];
const CONFIG = ["GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"];
const INDEXED = ["GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_17", "GIT_CONFIG_VALUE_17"];
const ALL_GIT = [...LOCATION, ...CONFIG, ...INDEXED];
const OTHER = ["RKS_REMOTE_BEARER", "RKS_SCRUB_SENTINEL", "ROUTEKIT_PROJECT_ROOT", "RKS_PROJECT_ROOT", "ROUTEKIT_PROJECT_ID"];
const touched = (k) => k.startsWith("GIT_") || OTHER.includes(k);
const present = (k) => Object.prototype.hasOwnProperty.call(process.env, k);

let saved;
let tmpBase;
beforeEach(() => {
  saved = {};
  for (const k of Object.keys(process.env)) if (touched(k)) saved[k] = process.env[k];
  for (const k of Object.keys(saved)) delete process.env[k];
  tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "remote-env-scrub-")));
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (touched(k)) delete process.env[k];
  Object.assign(process.env, saved);
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

/** A self-mode temp project whose .env carries envLines. */
function makeProject(envLines) {
  const id = `scrub-${crypto.randomUUID().slice(0, 8)}`;
  const root = path.join(tmpBase, id);
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(root, "routekit"), { recursive: true });
  fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify({ id, kgFile: "routekit/kg.yaml" }));
  fs.writeFileSync(path.join(root, "routekit", "kg.yaml"), `project: ${id}\n`);
  fs.writeFileSync(path.join(root, ".env"), envLines.join("\n") + "\n");
  process.env.ROUTEKIT_PROJECT_ROOT = root;
  process.env.ROUTEKIT_PROJECT_ID = id;
  return { id, root };
}

describe("remote-env-scrub key set (backlog.fix.remote-http-entry-env-leaks)", () => {
  it("admits every location key, every config-injection key and GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n for any index", () => {
    for (const k of [...LOCATION, ...CONFIG]) expect(isScrubbedGitEnvKey(k), k).toBe(true);
    for (const n of [0, 1, 9, 42, 1000]) {
      expect(isScrubbedGitEnvKey(`GIT_CONFIG_KEY_${n}`), `KEY_${n}`).toBe(true);
      expect(isScrubbedGitEnvKey(`GIT_CONFIG_VALUE_${n}`), `VALUE_${n}`).toBe(true);
    }
  });

  it("rejects ordinary git keys and near-miss names (positive control: not a GIT_ prefix rule)", () => {
    for (const k of ["GIT_AUTHOR_NAME", "GIT_COMMITTER_EMAIL", "GIT_CEILING_DIRECTORIES", "GIT_CONFIG_KEY_", "GIT_CONFIG_KEY_x", "GIT_CONFIG_KEYS_0", "GIT_CONFIG_VALUE_1a", "git_dir", "XGIT_DIR"]) {
      expect(isScrubbedGitEnvKey(k), k).toBe(false);
    }
  });

  it("scrubGitEnv deletes every scrubbed key from the given env, keeps the rest and returns names only", () => {
    const env = { PATH: "/usr/bin", GIT_AUTHOR_NAME: "a" };
    for (const k of ALL_GIT) env[k] = `v-${k}`;
    const removed = scrubGitEnv(env);
    expect([...removed].sort()).toEqual([...ALL_GIT].sort());
    expect(Object.keys(env).sort()).toEqual(["GIT_AUTHOR_NAME", "PATH"]);
  });

  it("bin and project-context take the key set from the shared module and carry no quoted GIT_DIR literal", () => {
    const bin = fs.readFileSync(BIN_PATH, "utf8");
    const ctx = fs.readFileSync(CONTEXT_PATH, "utf8");
    expect(bin).toContain("../src/shared/remote-env-scrub.mjs");
    expect(ctx).toContain("./shared/remote-env-scrub.mjs");
    for (const src of [bin, ctx]) {
      expect(src.includes('"GIT_DIR"')).toBe(false);
      expect(src.includes("'GIT_DIR'")).toBe(false);
    }
  });
});

describe("loadProjectContext launcher-secret and git restore groups (backlog.fix.remote-http-entry-env-leaks)", () => {
  it(".env RKS_REMOTE_BEARER is not loaded when unset before the call; an ordinary key from the same .env loads", async () => {
    const { id } = makeProject(["RKS_REMOTE_BEARER=dotenv-bearer-0123456789abcdef0123456789", "RKS_SCRUB_SENTINEL=1"]);
    await loadProjectContext(id, REPO_ROOT);
    expect(present("RKS_SCRUB_SENTINEL")).toBe(true);
    expect(present("RKS_REMOTE_BEARER")).toBe(false);
  });

  it("a preset RKS_REMOTE_BEARER is kept exactly against a different .env value", async () => {
    const { id } = makeProject(["RKS_REMOTE_BEARER=dotenv-bearer", "RKS_SCRUB_SENTINEL=1"]);
    process.env.RKS_REMOTE_BEARER = "launch-bearer";
    await loadProjectContext(id, REPO_ROOT);
    expect(present("RKS_SCRUB_SENTINEL")).toBe(true);
    expect(process.env.RKS_REMOTE_BEARER === "launch-bearer").toBe(true);
  });

  it(".env-only git location, config-injection and indexed keys are absent after the call; GIT_AUTHOR_NAME and the sentinel load", async () => {
    const { id } = makeProject([...ALL_GIT.map((k) => `${k}=dotenv-value`), "GIT_AUTHOR_NAME=dotenv-author", "RKS_SCRUB_SENTINEL=1"]);
    await loadProjectContext(id, REPO_ROOT);
    expect(present("RKS_SCRUB_SENTINEL")).toBe(true);
    expect(present("GIT_AUTHOR_NAME")).toBe(true);
    expect(ALL_GIT.filter(present)).toEqual([]);
  });

  it("preset launch git values survive a .env carrying different values; .env-only indexed keys beside them are removed", async () => {
    const preset = { GIT_DIR: "/launch/git-dir", GIT_CONFIG_GLOBAL: "/launch/gitconfig", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "launch.key", GIT_CONFIG_VALUE_0: "launch-value" };
    const { id } = makeProject([...ALL_GIT.map((k) => `${k}=dotenv-value`), "GIT_CONFIG_KEY_5=dotenv.key", "GIT_CONFIG_VALUE_5=dotenv-value", "RKS_SCRUB_SENTINEL=1"]);
    Object.assign(process.env, preset);
    await loadProjectContext(id, REPO_ROOT);
    expect(present("RKS_SCRUB_SENTINEL")).toBe(true);
    expect(Object.keys(preset).filter((k) => process.env[k] !== preset[k])).toEqual([]);
    expect([...ALL_GIT, "GIT_CONFIG_KEY_5", "GIT_CONFIG_VALUE_5"].filter((k) => !(k in preset) && present(k))).toEqual([]);
  });
});
