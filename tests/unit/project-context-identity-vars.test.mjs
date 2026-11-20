// backlog.feat.remote-surface-lane-isolation — Decision 2: loadProjectContext's override:true project
// .env load must not change RKS_VIA, RKS_VIA_DEFAULT, RKS_ACTOR, RKS_DISPATCH_RUN_ID, DENDRON_VAULT_PATH
// or ROUTEKIT_NOTES_DIR, in any lane; an ordinary key in the same .env still loads.
// Fixtures are temp dirs; the registry case uses a temp RKS_REGISTRY_PATH (honoured only under VITEST).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { loadProjectContext } = await import("../../packages/mcp-rks/src/project-context.mjs");
const { resolveRegistryPath } = await import("../../packages/cli/src/project/index.js");

const IDENTITY = ["RKS_VIA", "RKS_VIA_DEFAULT", "RKS_ACTOR", "RKS_DISPATCH_RUN_ID", "DENDRON_VAULT_PATH", "ROUTEKIT_NOTES_DIR"];
const TOUCHED = [...IDENTITY, "RKS_ISO_ENV_SENTINEL", "ROUTEKIT_PROJECT_ROOT", "RKS_PROJECT_ROOT", "ROUTEKIT_PROJECT_ID", "RKS_REGISTRY_PATH"];
const PRESET = {
  RKS_VIA: "remote",
  RKS_VIA_DEFAULT: "remote",
  RKS_ACTOR: "grokbot",
  RKS_DISPATCH_RUN_ID: "launcher-run",
  DENDRON_VAULT_PATH: "/launcher/vault",
  ROUTEKIT_NOTES_DIR: "/launcher/notes",
};

let tmpBase;
let saved;

function makeProject(id, sentinel) {
  const root = path.join(tmpBase, `${id}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(root, "routekit"), { recursive: true });
  fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify({ id, root, kgFile: "routekit/kg.yaml" }, null, 2));
  fs.writeFileSync(path.join(root, "routekit", "kg.yaml"), `project: ${id}\n`);
  fs.writeFileSync(path.join(root, ".env"), [
    "RKS_VIA=dispatch",
    "RKS_VIA_DEFAULT=dispatch",
    "RKS_ACTOR=intruder",
    "RKS_DISPATCH_RUN_ID=intruder-run",
    "DENDRON_VAULT_PATH=/intruder/vault",
    "ROUTEKIT_NOTES_DIR=/intruder/notes",
    `RKS_ISO_ENV_SENTINEL=${sentinel}`,
    "",
  ].join("\n"));
  return root;
}

function useSelf(id, root) {
  process.env.ROUTEKIT_PROJECT_ROOT = root;
  process.env.ROUTEKIT_PROJECT_ID = id;
}

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
  tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-context-identity-")));
});

afterEach(() => {
  for (const k of TOUCHED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("loadProjectContext keeps launcher identity and routing vars (backlog.feat.remote-surface-lane-isolation, Decision 2)", () => {
  it("self project: each preset identity var keeps its pre-load value, and an ordinary .env key loads", async () => {
    const id = `identity-self-${crypto.randomUUID().slice(0, 8)}`;
    const sentinel = `sentinel-${crypto.randomUUID()}`;
    const root = makeProject(id, sentinel);
    useSelf(id, root);
    Object.assign(process.env, PRESET);

    const ctx = await loadProjectContext(id, REPO_ROOT);
    expect(ctx.record.root).toBe(root);

    for (const k of IDENTITY) expect(process.env[k], k).toBe(PRESET[k]);
    expect(process.env.RKS_ISO_ENV_SENTINEL).toBe(sentinel); // positive control: the .env was loaded with override
  });

  it("self project: each unset identity var stays unset", async () => {
    const id = `identity-unset-${crypto.randomUUID().slice(0, 8)}`;
    const sentinel = `sentinel-${crypto.randomUUID()}`;
    const root = makeProject(id, sentinel);
    useSelf(id, root);

    await loadProjectContext(id, REPO_ROOT);

    for (const k of IDENTITY) expect(k in process.env, k).toBe(false);
    expect(process.env.RKS_ISO_ENV_SENTINEL).toBe(sentinel);
  });

  it("registry (non-self) project via a temp RKS_REGISTRY_PATH: identity vars keep their values, ordinary key loads", async () => {
    const bootId = `identity-boot-${crypto.randomUUID().slice(0, 8)}`;
    const bootRoot = makeProject(bootId, "boot-unused");
    useSelf(bootId, bootRoot);
    const foreignId = `identity-foreign-${crypto.randomUUID().slice(0, 8)}`;
    const sentinel = `sentinel-${crypto.randomUUID()}`;
    const foreignRoot = makeProject(foreignId, sentinel);
    const registryPath = path.join(tmpBase, "registry.jsonl");
    fs.writeFileSync(registryPath, `${JSON.stringify({ id: foreignId, root: foreignRoot, path: foreignRoot })}\n`);
    process.env.RKS_REGISTRY_PATH = registryPath;
    expect(process.env.VITEST).toBeTruthy();
    expect(resolveRegistryPath()).toBe(registryPath); // premise: never the live registry
    Object.assign(process.env, PRESET);

    const ctx = await loadProjectContext(foreignId, REPO_ROOT);
    expect(ctx.record.root).toBe(foreignRoot);

    for (const k of IDENTITY) expect(process.env[k], k).toBe(PRESET[k]);
    expect(process.env.RKS_ISO_ENV_SENTINEL).toBe(sentinel);
  });
});
