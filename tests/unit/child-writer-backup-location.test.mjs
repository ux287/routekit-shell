// backlog.fix.child-writer-sibling-bak-dirties-tree
//
// Every rks CLI write-backup lands under <root>/.rks/.backup/, never as a sibling
// <file>.bak.<n>. A sibling is an untracked file outside .rks/, which rks_exec's
// dirty-tree gate (getUncommittedFiles) refuses. Fixtures live under os.tmpdir()
// (realpath'd), never inside the repo, so the root walk cannot reach the shell's .rks.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  BACKUP_DIR,
  findBackupRoot,
  backupPathFor,
  backupBeforeWrite,
} from "../../packages/cli/src/project/backup-path.mjs";
import {
  ensureClaudeSettings,
  ensureHookRegistration,
  migrateChildSettingsHookPaths,
} from "../../packages/cli/src/project/bootstrap.mjs";
import { mergeRksPermissionAllow } from "../../packages/cli/src/project/child-permissions.mjs";
import { repinMcpServer } from "../../packages/cli/src/project/repin-mcp.mjs";
import { upgradeProject } from "../../packages/cli/src/project/upgrade.mjs";
import { runDoctor } from "../../packages/cli/src/project/doctor.mjs";
import { getUncommittedFiles } from "../../packages/mcp-rks/src/utils/git.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST_PATH = path.join(REPO_ROOT, ".routekit", "hooks-manifest.json");
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const SRC = (f) => fs.readFileSync(path.join(REPO_ROOT, "packages/cli/src/project", f), "utf8");

const BAK_RE = /\.bak\.\d+$/;
const created = [];
const tmp = (p) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  created.push(d);
  return d;
};
const siblingBaks = (p) =>
  fs.readdirSync(path.dirname(p)).filter((f) => f.startsWith(path.basename(p) + ".bak."));
const movedBaks = (root, rel) => {
  const d = path.join(root, ".rks", ".backup", path.dirname(rel));
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.startsWith(path.basename(rel) + ".bak.")) : [];
};

/** A child with .rks/, full hook payload stubs and a hooks-less .claude/settings.json. */
function makeChild(root, settings = { mcpServers: { rks: { command: "node", args: [] } } }) {
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify({ rksVersion: "0.59.6" }, null, 2) + "\n");
  const rels = [...new Set(Object.values(manifest).map((e) => e.path).filter(Boolean))];
  for (const rel of rels) {
    const p = path.join(root, ".routekit", "hooks", rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "// stub hook\n");
  }
  const sp = path.join(root, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify(settings, null, 2));
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify(
      { mcpServers: { rks: { command: "node", args: ["/old-shell/packages/mcp-rks/bin/mcp-rks.mjs"], env: { ROUTEKIT_PROJECT_ROOT: root } } } },
      null,
      2,
    ) + "\n",
  );
  return sp;
}

function makeShell() {
  const shell = tmp("rks-bak-shell-");
  fs.mkdirSync(path.join(shell, ".routekit"), { recursive: true });
  fs.copyFileSync(MANIFEST_PATH, path.join(shell, ".routekit", "hooks-manifest.json"));
  return shell;
}

const git = (cwd, args) => {
  const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r;
};
function gitInitCommitAll(root) {
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
}

let prevHome;
beforeEach(() => {
  prevHome = process.env.HOME;
  process.env.HOME = tmp("rks-bak-home-");
});
afterEach(() => {
  process.env.HOME = prevHome;
  while (created.length) fs.rmSync(created.pop(), { recursive: true, force: true });
});

describe("backup-path helper", () => {
  it("BACKUP_DIR is .rks/.backup", () => {
    expect(BACKUP_DIR).toBe(path.join(".rks", ".backup"));
  });

  it("maps <root>/.claude/settings.json to <root>/.rks/.backup/.claude/settings.json.bak.<stamp>", () => {
    const root = tmp("rks-bak-root-");
    fs.mkdirSync(path.join(root, ".rks"));
    const f = path.join(root, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(f));
    expect(backupPathFor(f, 123)).toBe(path.join(root, ".rks", ".backup", ".claude", "settings.json.bak.123"));
    expect(backupPathFor(path.join(root, ".mcp.json"), 7)).toBe(path.join(root, ".rks", ".backup", ".mcp.json.bak.7"));
  });

  it("the NEAREST ancestor holding .rks or .git wins", () => {
    const outer = tmp("rks-bak-outer-");
    fs.mkdirSync(path.join(outer, ".git"));
    const inner = path.join(outer, "child");
    fs.mkdirSync(path.join(inner, ".rks"), { recursive: true });
    fs.mkdirSync(path.join(inner, ".claude"));
    expect(findBackupRoot(path.join(inner, ".claude", "settings.json"))).toBe(inner);
    expect(findBackupRoot(path.join(outer, "x.json"))).toBe(outer);
  });

  it("with no .rks/.git ancestor the root is the file's own directory — still never a sibling file", () => {
    const d = tmp("rks-bak-bare-");
    const f = path.join(d, "x.json");
    fs.writeFileSync(f, "{}");
    const dest = backupBeforeWrite(f, 5);
    expect(dest).toBe(path.join(d, ".rks", ".backup", "x.json.bak.5"));
    expect(siblingBaks(f)).toEqual([]);
  });

  it("copies byte-for-byte and returns the backup path", () => {
    const root = tmp("rks-bak-bytes-");
    fs.mkdirSync(path.join(root, ".rks"));
    const f = path.join(root, "blob.bin");
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x0a, 0x0d, 0x7b, 0x80]);
    fs.writeFileSync(f, bytes);
    const dest = backupBeforeWrite(f, 9);
    expect(Buffer.compare(fs.readFileSync(dest), bytes)).toBe(0);
    expect(siblingBaks(f)).toEqual([]);
  });

  it("never overwrites: two calls with the same explicit stamp yield two distinct backups", () => {
    const root = tmp("rks-bak-collide-");
    fs.mkdirSync(path.join(root, ".rks"));
    const f = path.join(root, "x.json");
    fs.writeFileSync(f, "original");
    const first = backupBeforeWrite(f, 42);
    fs.writeFileSync(f, "second");
    const second = backupBeforeWrite(f, 42);
    expect(first).toBe(path.join(root, ".rks", ".backup", "x.json.bak.42"));
    expect(second).not.toBe(first);
    expect(second).toMatch(BAK_RE);
    expect(fs.readFileSync(first, "utf8")).toBe("original");
    expect(fs.readFileSync(second, "utf8")).toBe("second");
    expect(movedBaks(root, "x.json")).toHaveLength(2);
    expect(siblingBaks(f)).toEqual([]);
  });

  it("returns null and creates nothing when the file does not exist", () => {
    const root = tmp("rks-bak-absent-");
    fs.mkdirSync(path.join(root, ".rks"));
    expect(backupBeforeWrite(path.join(root, "nope.json"))).toBeNull();
    expect(fs.existsSync(path.join(root, ".rks", ".backup"))).toBe(false);
  });
});

describe("settings.json writers back up under .rks/.backup, never as a sibling", () => {
  let root, sp, original;
  beforeEach(() => {
    root = tmp("rks-bak-child-");
    sp = makeChild(root);
    original = fs.readFileSync(sp, "utf8");
  });
  const REL = path.join(".claude", "settings.json");
  const assertMoved = () => {
    expect(siblingBaks(sp)).toEqual([]);
    const moved = movedBaks(root, REL);
    expect(moved.length).toBeGreaterThanOrEqual(1);
    const stampOf = (name) => Number(name.slice(name.lastIndexOf(".") + 1));
    const first = [...moved].sort((a, b) => stampOf(a) - stampOf(b))[0];
    expect(first).toMatch(/^settings\.json\.bak\.\d+$/);
    expect(fs.readFileSync(path.join(root, ".rks", ".backup", ".claude", first), "utf8")).toBe(original);
  };

  it("ensureHookRegistration", () => {
    expect(ensureHookRegistration({ settingsPath: sp, manifest }).changed).toBe(true);
    assertMoved();
  });

  it("migrateChildSettingsHookPaths", () => {
    const flat = {
      hooks: {
        PreToolUse: [
          { matcher: "Read", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR"/.routekit/hooks/redirect-read-to-agent.mjs' }] },
        ],
      },
    };
    fs.writeFileSync(sp, JSON.stringify(flat, null, 2));
    original = fs.readFileSync(sp, "utf8");
    expect(migrateChildSettingsHookPaths({ settingsPath: sp, manifest })).toBeTruthy();
    assertMoved();
  });

  it("mergeRksPermissionAllow", () => {
    const r = mergeRksPermissionAllow({
      settingsPath: sp,
      localSettingsPath: path.join(root, ".claude", "settings.local.json"),
    });
    expect(r.changed).toBe(true);
    assertMoved();
  });

  it("ensureClaudeSettings", () => {
    ensureClaudeSettings({ projectRoot: root, shellRoot: REPO_ROOT });
    expect(fs.readFileSync(sp, "utf8")).not.toBe(original);
    assertMoved();
  });

  it("an idempotent second run creates no further backup", () => {
    ensureHookRegistration({ settingsPath: sp, manifest });
    const n = movedBaks(root, REL).length;
    expect(ensureHookRegistration({ settingsPath: sp, manifest }).changed).toBe(false);
    expect(movedBaks(root, REL).length).toBe(n);
    expect(siblingBaks(sp)).toEqual([]);
  });

  it("a fresh create (no prior settings.json) creates no backup", () => {
    fs.rmSync(sp);
    ensureHookRegistration({ settingsPath: sp, manifest });
    expect(movedBaks(root, REL)).toEqual([]);
    expect(siblingBaks(sp)).toEqual([]);
  });
});

describe("repinMcpServer backs up .mcp.json under .rks/.backup", () => {
  it("backup is <child>/.rks/.backup/.mcp.json.bak.<n>, byte-identical, no sibling", () => {
    const root = tmp("rks-bak-repin-");
    makeChild(root);
    const mcp = path.join(root, ".mcp.json");
    const before = fs.readFileSync(mcp, "utf8");
    const r = repinMcpServer({ projectRoot: root, shellRoot: makeShell() });
    expect(r.changed).toBe(true);
    expect(siblingBaks(mcp)).toEqual([]);
    const moved = movedBaks(root, ".mcp.json");
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatch(/^\.mcp\.json\.bak\.\d+$/);
    expect(fs.readFileSync(path.join(root, ".rks", ".backup", moved[0]), "utf8")).toBe(before);
  });
});

describe("the exec dirty-tree gate sees no .bak after upgrade / doctor", () => {
  it("upgradeProject (patch boundary) leaves no .bak.<n> in getUncommittedFiles", () => {
    const root = tmp("rks-bak-upgrade-");
    makeChild(root);
    gitInitCommitAll(root);
    const shellRoot = makeShell();
    const r = upgradeProject(
      { projectRoot: root, projectId: "child", shellRoot },
      {
        readRksVersion: () => "0.59.7",
        syncProject: () => [],
        migrateConfig: () => ({ ok: true, applied: [], noOp: true }),
        now: () => "TS",
      },
    );
    expect(r.boundary).toBe("patch");
    const dirty = getUncommittedFiles(root);
    // Positive control: the writers really ran and changed a tracked file.
    expect(dirty).toContain(".claude/settings.json");
    expect(dirty.filter((f) => BAK_RE.test(f))).toEqual([]);
    expect(movedBaks(root, path.join(".claude", "settings.json")).length).toBeGreaterThanOrEqual(1);
  });

  it("runDoctor Checks 3/6/7 repairs leave no .bak.<n> in getUncommittedFiles", async () => {
    const root = tmp("rks-bak-doctor-");
    makeChild(root);
    gitInitCommitAll(root);
    const shellRoot = makeShell();
    await runDoctor({
      shellRoot,
      dryRun: false,
      deps: {
        syncHooks: vi.fn(),
        checkDrift: vi.fn(() => ({ ok: true, issues: [], srcCount: 0, destCount: 0 })),
        syncProject: vi.fn(() => []),
        migrateConfig: vi.fn(() => ({ ok: true, applied: [], noOp: true, fromVersion: 1, currentVersion: 1 })),
        upsertProject: vi.fn(),
        loadProjects: vi.fn(() => [{ id: "child-x", root }]),
        isPinned: vi.fn(() => false),
      },
    });
    const dirty = getUncommittedFiles(root);
    expect(dirty).toContain(".claude/settings.json");
    expect(dirty).toContain(".mcp.json");
    expect(dirty.filter((f) => BAK_RE.test(f))).toEqual([]);
  });
});

describe("source guards", () => {
  it("no project writer builds a sibling `.bak.${Date.now()}` path; each imports backup-path.mjs", () => {
    for (const f of ["bootstrap.mjs", "child-permissions.mjs", "repin-mcp.mjs"]) {
      const src = SRC(f);
      expect(src, f).not.toMatch(/\.bak\.\$\{Date\.now\(\)\}/);
      expect(src, f).toMatch(/from\s+["']\.\/backup-path\.mjs["']/);
      expect(src, f).toMatch(/backupBeforeWrite\(/);
    }
  });

  it("repin-mcp.mjs does not import bootstrap.mjs; bootstrap keeps writeJSONWithBackup module-internal", () => {
    expect(SRC("repin-mcp.mjs")).not.toMatch(/from\s+["']\.\/bootstrap(\.mjs)?["']/);
    const b = SRC("bootstrap.mjs");
    expect(b).toMatch(/^function writeJSONWithBackup/m);
    expect(b).not.toMatch(/^export\s+function\s+writeJSONWithBackup/m);
  });
});
