// backlog.fix.child-rks-permission-allow-list — hybrid wildcard child permission rules +
// additive merge. All fixtures are temp dirs (fs.mkdtempSync(os.tmpdir())); never a real
// child or registry.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHILD_RKS_ALLOW_TOOLS,
  CHILD_RKS_PROMPT_TOOLS,
  CHILD_RKS_ALLOW_RULES,
  CHILD_RKS_ASK_RULES,
  mergeRksPermissionAllow,
} from "../../packages/cli/src/project/child-permissions.mjs";
import {
  ensureClaudeSettings,
  ensureHookRegistration,
  buildHookRegistration,
  loadHookManifest,
} from "../../packages/cli/src/project/bootstrap.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RKS = "mcp__rks__";
const rksOnly = (list) => (list || []).filter((e) => e.startsWith(RKS));
const nonRks = (list) => (list || []).filter((e) => !e.startsWith(RKS));

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "child-perms-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A temp child .claude dir; returns { root, settingsPath, localSettingsPath }. */
function child({ settings, local } = {}) {
  const root = tmp();
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  const settingsPath = path.join(root, ".claude", "settings.json");
  const localSettingsPath = path.join(root, ".claude", "settings.local.json");
  const put = (p, v) => fs.writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n");
  if (settings !== undefined) put(settingsPath, settings);
  if (local !== undefined) put(localSettingsPath, local);
  return { root, settingsPath, localSettingsPath };
}
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const bytes = (p) => fs.readFileSync(p, "utf8");
const bakFiles = (p) => fs.readdirSync(path.dirname(p)).filter((f) => f.startsWith(path.basename(p) + ".bak"));

describe("exports", () => {
  it("shapes and freezing", () => {
    expect(Object.isFrozen(CHILD_RKS_ALLOW_TOOLS)).toBe(true);
    expect(CHILD_RKS_ALLOW_TOOLS.every((t) => typeof t === "string" && t.startsWith(RKS) && !t.includes("*"))).toBe(true);
    expect(new Set(CHILD_RKS_ALLOW_TOOLS).size).toBe(CHILD_RKS_ALLOW_TOOLS.length);

    expect(Object.isFrozen(CHILD_RKS_PROMPT_TOOLS)).toBe(true);
    for (const [k, v] of Object.entries(CHILD_RKS_PROMPT_TOOLS)) {
      expect(k.startsWith(RKS)).toBe(true);
      expect(typeof v === "string" && v.length > 0).toBe(true);
    }

    expect(Object.isFrozen(CHILD_RKS_ALLOW_RULES)).toBe(true);
    expect([...CHILD_RKS_ALLOW_RULES]).toEqual(["mcp__rks__*"]);
    expect(Object.isFrozen(CHILD_RKS_ASK_RULES)).toBe(true);
    expect([...CHILD_RKS_ASK_RULES]).toEqual(Object.keys(CHILD_RKS_PROMPT_TOOLS));
    expect(typeof mergeRksPermissionAllow).toBe("function");
  });

  it("CHILD_RKS_ALLOW_TOOLS holds every AC-named governed-chain tool", () => {
    const named = [
      "rks_governor_init", "rks_story_ship", "rks_ship", "rks_git_push", "rks_git_merge", "rks_staging_pr",
      "rks_plan", "rks_plan_ready", "rks_plan_review", "rks_exec", "rks_refine", "rks_refine_apply",
      "rks_arch_verdict", "rks_exhaustive_search", "dendron_create_note", "dendron_read_note",
      "dendron_edit_note", "dendron_update_field",
    ].map((n) => RKS + n);
    expect(named.filter((n) => !CHILD_RKS_ALLOW_TOOLS.includes(n))).toEqual([]);
  });

  it("CHILD_RKS_PROMPT_TOOLS is exactly the four checkpoints, disjoint from the allow set", () => {
    expect(new Set(Object.keys(CHILD_RKS_PROMPT_TOOLS))).toEqual(
      new Set(["rks_guardrails_off", "rks_release", "rks_publish", "rks_publish_profiles"].map((n) => RKS + n)),
    );
    expect(Object.keys(CHILD_RKS_PROMPT_TOOLS).filter((k) => CHILD_RKS_ALLOW_TOOLS.includes(k))).toEqual([]);
  });
});

describe("prompt-reference scan", () => {
  const DIRS = [".rks/prompts", "templates/base/.rks/prompts"];
  const scan = () => {
    const tokens = [];
    const files = {};
    for (const dir of DIRS) {
      const abs = path.join(REPO_ROOT, dir);
      files[dir] = fs.readdirSync(abs).filter((f) => /^governor-.*\.md$/.test(f));
      for (const f of files[dir]) {
        const src = fs.readFileSync(path.join(abs, f), "utf8");
        for (const m of src.match(/mcp__rks__[a-z_]+/g) || []) tokens.push({ file: `${dir}/${f}`, tool: m });
      }
    }
    return { tokens, files };
  };

  it("every mcp__rks__ tool a governor prompt calls is allow-classified, never a checkpoint", () => {
    const { tokens } = scan();
    const failures = tokens.filter(
      ({ tool }) => !CHILD_RKS_ALLOW_TOOLS.includes(tool) || tool in CHILD_RKS_PROMPT_TOOLS,
    );
    expect(failures).toEqual([]);
  });

  it("positive controls — the scan is not vacuous", () => {
    const { tokens, files } = scan();
    for (const dir of DIRS) expect(files[dir].length, dir).toBeGreaterThan(0);
    const from = (f) => tokens.filter((t) => t.file === f).map((t) => t.tool);
    expect(from(".rks/prompts/governor-build.md").length).toBeGreaterThan(0);
    expect(from(".rks/prompts/governor-qa.md").length).toBeGreaterThan(0);
    expect(from("templates/base/.rks/prompts/governor-build.md").length).toBeGreaterThan(0);
    expect(from("templates/base/.rks/prompts/governor-ship.md")).toContain("mcp__rks__rks_ship");
  });
});

describe("child sources", () => {
  it("ensureClaudeSettings on a FRESH child writes the wildcard + ask rules; bootstrap.mjs imports them", () => {
    const root = tmp();
    ensureClaudeSettings({ projectRoot: root, shellRoot: REPO_ROOT });
    const s = read(path.join(root, ".claude", "settings.json"));
    expect(rksOnly(s.permissions.allow)).toEqual([...CHILD_RKS_ALLOW_RULES]);
    expect(rksOnly(s.permissions.ask)).toEqual([...CHILD_RKS_ASK_RULES]);

    const src = fs.readFileSync(path.join(REPO_ROOT, "packages/cli/src/project/bootstrap.mjs"), "utf8");
    expect(src).not.toContain("mcp__rks__rks_agent_lifecycle");
    expect(src).toMatch(/from\s+["']\.\/child-permissions\.mjs["']/);
  });

  const setDiff = (actual, expected) => ({
    missing: expected.filter((e) => !actual.includes(e)),
    extra: actual.filter((e) => !expected.includes(e)),
  });

  it("templates/base/.claude/settings.json rks subsets match; other keys intact", () => {
    const t = read(path.join(REPO_ROOT, "templates/base/.claude/settings.json"));
    const allow = rksOnly(t.permissions.allow);
    const ask = rksOnly(t.permissions.ask);
    expect(setDiff(allow, [...CHILD_RKS_ALLOW_RULES])).toEqual({ missing: [], extra: [] });
    expect(setDiff(ask, [...CHILD_RKS_ASK_RULES])).toEqual({ missing: [], extra: [] });
    expect(new Set(allow).size).toBe(allow.length);
    expect(new Set(ask).size).toBe(ask.length);
    expect(t.permissions.deny).toBeDefined();
    expect(t.env).toBeDefined();
    expect(t.hooks).toBeDefined();
    // Control: a project-level Bash rule does not break the pin.
    const withBash = rksOnly([...t.permissions.allow, "Bash(git push origin *)"]);
    expect(setDiff(withBash, [...CHILD_RKS_ALLOW_RULES])).toEqual({ missing: [], extra: [] });
  });
});

describe("mergeRksPermissionAllow", () => {
  it("appends the wildcard and ask rules at the end; everything else is preserved", () => {
    const input = {
      env: { A: "1" },
      permissions: { allow: ["Bash(ls:*)", "mcp__rks__rks_preflight"] },
      hooks: { PreToolUse: [] },
      customField: { x: 1 },
    };
    const c = child({ settings: input });
    const r = mergeRksPermissionAllow(c);
    expect(r).toEqual({ changed: true, reason: "added", added: ["mcp__rks__*"], addedAsk: [...CHILD_RKS_ASK_RULES] });
    const s = read(c.settingsPath);
    expect(s.permissions.allow).toEqual(["Bash(ls:*)", "mcp__rks__rks_preflight", "mcp__rks__*"]);
    expect(s.permissions.ask).toEqual([...CHILD_RKS_ASK_RULES]);
    expect(s.env).toEqual(input.env);
    expect(s.hooks).toEqual(input.hooks);
    expect(s.customField).toEqual(input.customField);
    expect(Object.keys(s)).toEqual(Object.keys(input));
  });

  it("never touches non-rks entries (project-level Bash rules survive at their indices)", () => {
    const c = child({
      settings: { permissions: { allow: ["Bash(git push origin *)"], ask: ["Bash(gh pr create *)"] } },
    });
    const before = read(c.settingsPath).permissions;
    mergeRksPermissionAllow(c);
    const after = read(c.settingsPath).permissions;
    expect(after.allow[0]).toBe("Bash(git push origin *)");
    expect(after.ask[0]).toBe("Bash(gh pr create *)");
    expect(nonRks(after.allow)).toEqual(nonRks(before.allow));
    expect(nonRks(after.ask)).toEqual(nonRks(before.ask));
  });

  it("is idempotent", () => {
    const c = child({ settings: { permissions: { allow: [] } } });
    mergeRksPermissionAllow(c);
    const b = bytes(c.settingsPath);
    expect(mergeRksPermissionAllow(c)).toEqual({ changed: false, reason: "unchanged", added: [], addedAsk: [] });
    expect(bytes(c.settingsPath)).toBe(b);
  });

  it("honours settings.local.json and never writes it; an absent local file is empty", () => {
    const c1 = child({
      settings: { permissions: { allow: [] } },
      local: { permissions: { allow: ["mcp__rks__*"], ask: ["mcp__rks__rks_release"] } },
    });
    const localBefore = bytes(c1.localSettingsPath);
    const r1 = mergeRksPermissionAllow(c1);
    expect(r1.added).toEqual([]);
    expect(r1.addedAsk).not.toContain("mcp__rks__rks_release");
    expect(read(c1.settingsPath).permissions.allow).not.toContain("mcp__rks__*");
    expect(bytes(c1.localSettingsPath)).toBe(localBefore);
    mergeRksPermissionAllow(c1);
    expect(bytes(c1.localSettingsPath)).toBe(localBefore);

    const c2 = child({ settings: { permissions: { allow: [] } } });
    expect(mergeRksPermissionAllow(c2).added).toEqual(["mcp__rks__*"]);
    expect(fs.existsSync(c2.localSettingsPath)).toBe(false);
  });

  describe("user decisions win (in settings.json and in settings.local.json)", () => {
    const cases = [
      ["wildcard in deny", { deny: ["mcp__rks__*"] }, (r) => expect(r.added).toEqual([])],
      ["bare server in deny", { deny: ["mcp__rks"] }, (r) => expect(r.added).toEqual([])],
      ["wildcard in ask", { ask: ["mcp__rks__*"] }, (r) => expect(r.added).toEqual([])],
      ["bare server in ask", { ask: ["mcp__rks"] }, (r) => expect(r.added).toEqual([])],
      ["checkpoint in deny", { deny: ["mcp__rks__rks_release"] }, (r) => expect(r.addedAsk).not.toContain("mcp__rks__rks_release")],
      ["checkpoint in allow", { allow: ["mcp__rks__rks_publish"] }, (r) => expect(r.addedAsk).not.toContain("mcp__rks__rks_publish")],
      ["non-checkpoint in ask", { ask: ["mcp__rks__rks_story_ship"] }, (r) => expect(r.added).toEqual(["mcp__rks__*"])],
      ["non-checkpoint in deny", { deny: ["mcp__rks__rks_story_ship"] }, (r) => expect(r.added).toEqual(["mcp__rks__*"])],
    ];
    for (const where of ["settings", "local"]) {
      for (const [label, perms, check] of cases) {
        it(`${label} (${where})`, () => {
          const c =
            where === "settings"
              ? child({ settings: { permissions: { allow: [], ...perms } } })
              : child({ settings: { permissions: { allow: [] } }, local: { permissions: perms } });
          const r = mergeRksPermissionAllow(c);
          check(r);
          if (where === "settings") {
            // The user's entry is left in place.
            const s = read(c.settingsPath).permissions;
            for (const [k, v] of Object.entries(perms)) for (const e of v) expect(s[k]).toContain(e);
          }
        });
      }
    }
  });

  it("an existing wildcard or bare-server allow adds no allow entry; with all asks present, unchanged", () => {
    for (const w of ["mcp__rks__*", "mcp__rks"]) {
      for (const where of ["settings", "local"]) {
        const c =
          where === "settings"
            ? child({ settings: { permissions: { allow: [w] } } })
            : child({ settings: { permissions: { allow: [] } }, local: { permissions: { allow: [w] } } });
        expect(mergeRksPermissionAllow(c).added, `${w} ${where}`).toEqual([]);
      }
      const full = child({ settings: { permissions: { allow: [w], ask: [...CHILD_RKS_ASK_RULES] } } });
      expect(mergeRksPermissionAllow(full).changed).toBe(false);
    }
  });

  it("refuses an unparseable or malformed settings.json, writing nothing", () => {
    for (const bad of [
      "{ not valid json",
      { permissions: "x" },
      { permissions: { allow: "x" } },
      { permissions: { ask: {} } },
      [1, 2],
    ]) {
      const c = child({ settings: bad });
      const before = bytes(c.settingsPath);
      const r = mergeRksPermissionAllow(c);
      expect(r).toEqual({ changed: false, reason: "unparseable", added: [], addedAsk: [], file: ".claude/settings.json" });
      expect(bytes(c.settingsPath)).toBe(before);
      expect(bakFiles(c.settingsPath)).toEqual([]);
    }
  });

  it("R9 — refuses an unparseable or malformed settings.local.json, writing neither file", () => {
    for (const bad of ["{ not valid json", { permissions: { allow: "x" } }]) {
      const c = child({ settings: { permissions: { allow: [] } }, local: bad });
      const main = bytes(c.settingsPath);
      const local = bytes(c.localSettingsPath);
      const r = mergeRksPermissionAllow(c);
      expect(r.changed).toBe(false);
      expect(r.reason).toBe("unparseable");
      expect(r.file).toBe(".claude/settings.local.json");
      expect(bytes(c.settingsPath)).toBe(main);
      expect(bytes(c.localSettingsPath)).toBe(local);
    }
  });

  it("opt-out writes nothing; absent or malformed config is managed", () => {
    const c = child({ settings: { permissions: { allow: [] } } });
    const before = bytes(c.settingsPath);
    const r = mergeRksPermissionAllow({ ...c, projectConfig: { claudePermissions: { manageAllowList: false } } });
    expect(r.reason).toBe("opted-out");
    expect(r.changed).toBe(false);
    expect(bytes(c.settingsPath)).toBe(before);

    for (const projectConfig of [undefined, {}, { claudePermissions: { manageAllowList: "no" } }, { claudePermissions: null }]) {
      const m = child({ settings: { permissions: { allow: [] } } });
      expect(mergeRksPermissionAllow({ ...m, projectConfig }).added).toEqual(["mcp__rks__*"]);
    }
  });

  it("an ABSENT settings.json is created with the rules, and the hook writer composes with it", () => {
    const c = child();
    mergeRksPermissionAllow(c);
    expect(read(c.settingsPath)).toEqual({
      permissions: { allow: [...CHILD_RKS_ALLOW_RULES], ask: [...CHILD_RKS_ASK_RULES] },
    });
    const manifest = loadHookManifest(REPO_ROOT);
    ensureHookRegistration({ settingsPath: c.settingsPath, manifest });
    const s = read(c.settingsPath);
    expect(s.permissions.allow).toEqual([...CHILD_RKS_ALLOW_RULES]);
    expect(s.hooks).toEqual(buildHookRegistration(manifest));
  });
});

describe("ensureClaudeSettings on an EXISTING child", () => {
  it("merges the rules after the user's entries and still registers hooks", () => {
    const c = child({
      settings: { env: { X: "1" }, permissions: { allow: ["mcp__rks__rks_preflight"] }, customField: 7 },
    });
    ensureClaudeSettings({ projectRoot: c.root, shellRoot: REPO_ROOT });
    const s = read(c.settingsPath);
    expect(s.permissions.allow).toEqual(["mcp__rks__rks_preflight", "mcp__rks__*"]);
    expect(s.permissions.ask).toEqual([...CHILD_RKS_ASK_RULES]);
    expect(s.hooks).toEqual(buildHookRegistration(loadHookManifest(REPO_ROOT)));
    expect(s.env).toEqual({ X: "1" });
    expect(s.customField).toBe(7);
  });

  it("passes the child's project config — an opted-out child keeps its permissions, hooks still register", () => {
    const perms = { allow: ["mcp__rks__rks_preflight"] };
    const c = child({ settings: { permissions: perms } });
    fs.mkdirSync(path.join(c.root, ".rks"), { recursive: true });
    fs.writeFileSync(
      path.join(c.root, ".rks", "project.json"),
      JSON.stringify({ id: "c", claudePermissions: { manageAllowList: false } }),
    );
    ensureClaudeSettings({ projectRoot: c.root, shellRoot: REPO_ROOT });
    const s = read(c.settingsPath);
    expect(s.permissions).toEqual(perms);
    expect(s.hooks).toBeDefined();
  });

  it("rks_init path — a child holding the template settings.json ends with each rule exactly once", () => {
    const c = child({ settings: fs.readFileSync(path.join(REPO_ROOT, "templates/base/.claude/settings.json"), "utf8") });
    ensureClaudeSettings({ projectRoot: c.root, shellRoot: REPO_ROOT });
    const s = read(c.settingsPath);
    expect(rksOnly(s.permissions.allow)).toEqual(["mcp__rks__*"]);
    expect(rksOnly(s.permissions.ask)).toEqual([...CHILD_RKS_ASK_RULES]);
  });
});

describe("templates/base/CLAUDE.md Permission mode section", () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, "templates/base/CLAUDE.md"), "utf8");
  const start = src.indexOf("## Permission mode");
  const rest = src.slice(start + 1);
  const next = rest.search(/^## /m);
  const section = start === -1 ? "" : src.slice(start, next === -1 ? undefined : start + 1 + next);

  it("exists and documents the project-level rules and remedies", () => {
    expect(start).toBeGreaterThan(-1);
    for (const s of ["mcp__rks__*", "permissions.ask", "Recently denied", "routekit project upgrade", "routekit doctor", "manageAllowList"]) {
      expect(section).toContain(s);
    }
  });

  it("names nothing user-level and makes no 'cannot override' claim (Revision 3)", () => {
    for (const s of ["cannot override", "~/.claude", "autoMode"]) expect(section).not.toContain(s);
  });
});
