// backlog.feat.fetch-allowlist-owner-cli — unit tests for routekit fetch-allowlist.
// In-process: handleFetchAllowlistCommand({ sub, kv: { path: tmpRoot }, args: ["fetch-allowlist", sub, host] }, deps)
// is driven against a temp project root with injected deps (isTTY, confirm, emit, stdout)
// — no subprocess, no real TTY. emit is a recording stub (type, payload) => void.
import { describe, it, expect, afterEach, afterAll, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { handleFetchAllowlistCommand, validateHostEntry, AUDIT_EVENT_TYPE } from "../../packages/cli/src/cli/fetch-allowlist.js";
import { createDefaultTelemetryEmitter } from "../../packages/cli/src/cli/dispatch.js";
import { hostAllowed } from "../../packages/mcp-rks/src/agents/fetch-raw.mjs";

// backlog.feat.fetch-allowlist-cli-hardening: keep dispatch.js's real exports but replace the
// default telemetry emitter factory with a recording vi.fn, so tests can count constructions
// and no real telemetry is written when emit is not injected.
vi.mock("../../packages/cli/src/cli/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createDefaultTelemetryEmitter: vi.fn(() => async () => {}),
  };
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/cli/bin/routekit.js"), "utf8");
const FETCH_ALLOWLIST_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/cli/src/cli/fetch-allowlist.js"), "utf8");
const CLI_BIN = path.join(REPO_ROOT, "packages/cli/bin/routekit.js");
// The repository's own project config, captured when this file loads (null if absent).
const REPO_CFG_FILE = path.join(REPO_ROOT, ".rks", "project.json");
const REPO_CFG_BYTES_AT_LOAD = fs.existsSync(REPO_CFG_FILE) ? fs.readFileSync(REPO_CFG_FILE) : null;

const tmpRoots = [];
afterEach(() => {
  while (tmpRoots.length) fs.rmSync(tmpRoots.pop(), { recursive: true, force: true });
});

/** A temp project root whose .rks/project.json holds cfg (serialised as given). */
function mkProject(cfg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-fetch-allowlist-"));
  tmpRoots.push(root);
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.writeFileSync(cfgFile(root), JSON.stringify(cfg, null, 2) + "\n");
  return root;
}
const cfgFile = (root) => path.join(root, ".rks", "project.json");
const bytes = (root) => fs.readFileSync(cfgFile(root));
const readCfg = (root) => JSON.parse(fs.readFileSync(cfgFile(root), "utf8"));

function mkDeps(over = {}) {
  const events = [];
  const lines = [];
  const confirms = [];
  const deps = {
    isTTY: true,
    confirm: async (q) => {
      confirms.push(q);
      return true;
    },
    emit: async (type, payload) => {
      events.push({ type, payload });
    },
    stdout: { write: (s) => lines.push(String(s)) },
    ...over,
  };
  return { deps, events, lines, confirms };
}

const run = (root, sub, host, deps) =>
  handleFetchAllowlistCommand(
    { sub, kv: { path: root }, args: host === undefined ? ["fetch-allowlist", sub] : ["fetch-allowlist", sub, host] },
    deps,
  );

const BASE_CFG = {
  projectId: "fixture-project",
  branchModel: "2-branch",
  rag: { fidelityCeiling: "full" },
  fetchRaw: { allowedHosts: ["example.com", "*.docs.example.org"], mode: "allowlist" },
};

describe("fetch-allowlist CLI", () => {
  it("list returns the configured allowedHosts without writing", async () => {
    const root = mkProject(BASE_CFG);
    const before = bytes(root);
    const { deps, events } = mkDeps();
    const r = await run(root, "list", undefined, deps);
    expect(r.ok).toBe(true);
    expect(r.allowedHosts).toEqual(["example.com", "*.docs.example.org"]);
    expect(bytes(root).equals(before)).toBe(true);
    expect(events).toEqual([]);
  });

  it("list returns an empty list when fetchRaw or allowedHosts is absent without writing", async () => {
    for (const cfg of [{ projectId: "p" }, { projectId: "p", fetchRaw: { mode: "open" } }]) {
      const root = mkProject(cfg);
      const before = bytes(root);
      const { deps } = mkDeps();
      const r = await run(root, "list", undefined, deps);
      expect(r.ok).toBe(true);
      expect(r.allowedHosts).toEqual([]);
      expect(bytes(root).equals(before)).toBe(true);
    }
  });

  it("add appends a valid host and is idempotent", async () => {
    const root = mkProject(BASE_CFG);
    const { deps } = mkDeps();
    const first = await run(root, "add", "api.example.net", deps);
    expect(first.ok).toBe(true);
    expect(readCfg(root).fetchRaw.allowedHosts).toEqual(["example.com", "*.docs.example.org", "api.example.net"]);
    const second = await run(root, "add", "api.example.net", deps);
    expect(second.ok).toBe(true);
    const hosts = readCfg(root).fetchRaw.allowedHosts;
    expect(hosts.filter((h) => h === "api.example.net")).toHaveLength(1);
    expect(hosts).toHaveLength(3);
  });

  it("remove deletes an existing host and is a no-op success for an absent host", async () => {
    const root = mkProject(BASE_CFG);
    const { deps } = mkDeps();
    const r = await run(root, "remove", "example.com", deps);
    expect(r.ok).toBe(true);
    expect(readCfg(root).fetchRaw.allowedHosts).toEqual(["*.docs.example.org"]);
    const before = bytes(root);
    const absent = await run(root, "remove", "never-there.example.com", deps);
    expect(absent.ok).toBe(true);
    expect(bytes(root).equals(before)).toBe(true);
  });

  it("add rejects empty, whitespace, URL, path and port entries with no file change", async () => {
    const root = mkProject(BASE_CFG);
    const before = bytes(root);
    const { deps, events } = mkDeps();
    for (const bad of ["", "   ", "https://docs.example.com/x", "docs.example.com/path", "docs.example.com:443"]) {
      const r = await run(root, "add", bad, deps);
      expect(r.ok, `entry ${JSON.stringify(bad)}`).toBe(false);
      expect(bytes(root).equals(before)).toBe(true);
    }
    expect(events).toEqual([]);
  });

  it("a full URL rejection names the hostname to use", async () => {
    const root = mkProject(BASE_CFG);
    const { deps } = mkDeps();
    const r = await run(root, "add", "https://docs.example.com/x", deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("docs.example.com");
    expect(r.error).not.toContain("https://");
  });

  it("every accepted pattern form is honoured by the real hostAllowed", async () => {
    const cases = [
      ["docs.example.com", "docs.example.com"],
      ["*.example.com", "api.example.com"],
      [".example.com", "deep.api.example.com"],
    ];
    for (const [pattern, matching] of cases) {
      const v = validateHostEntry(pattern);
      expect(v.ok, pattern).toBe(true);
      expect(hostAllowed(matching, [v.host]), `${pattern} vs ${matching}`).toBe(true);
      const root = mkProject({ projectId: "p" });
      const { deps } = mkDeps();
      const r = await run(root, "add", pattern, deps);
      expect(r.ok).toBe(true);
      expect(hostAllowed(matching, readCfg(root).fetchRaw.allowedHosts)).toBe(true);
    }
  });

  it("add and remove preserve every other project.json key and never write fetchRaw.mode", async () => {
    // mode present: preserved
    const root = mkProject(BASE_CFG);
    const { deps } = mkDeps();
    const prior = readCfg(root);
    await run(root, "add", "new.example.com", deps);
    let after = readCfg(root);
    for (const k of Object.keys(prior).filter((k) => k !== "fetchRaw")) expect(after[k]).toEqual(prior[k]);
    expect(Object.keys(after).sort()).toEqual(Object.keys(prior).sort());
    expect(after.fetchRaw.mode).toBe("allowlist");
    await run(root, "remove", "example.com", deps);
    after = readCfg(root);
    for (const k of Object.keys(prior).filter((k) => k !== "fetchRaw")) expect(after[k]).toEqual(prior[k]);
    expect(after.fetchRaw.mode).toBe("allowlist");
    expect(Object.keys(after.fetchRaw).sort()).toEqual(["allowedHosts", "mode"]);

    // mode absent: stays absent (both with and without a prior fetchRaw key)
    for (const cfg of [{ projectId: "p", other: { a: [1, 2] } }, { projectId: "p", fetchRaw: { allowedHosts: ["x.example.com"] } }]) {
      const r2 = mkProject(cfg);
      const p2 = readCfg(r2);
      await run(r2, "add", "y.example.com", deps);
      await run(r2, "remove", "y.example.com", deps);
      const a2 = readCfg(r2);
      for (const k of Object.keys(p2).filter((k) => k !== "fetchRaw")) expect(a2[k]).toEqual(p2[k]);
      expect(Object.prototype.hasOwnProperty.call(a2.fetchRaw, "mode")).toBe(false);
    }
  });

  it("add and remove refuse on a non-TTY stdin with no file change", async () => {
    const root = mkProject(BASE_CFG);
    const before = bytes(root);
    const { deps, events, confirms } = mkDeps({ isTTY: false });
    for (const [sub, host] of [["add", "new.example.com"], ["remove", "example.com"]]) {
      const r = await run(root, sub, host, deps);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/person/i);
      expect(r.error).toMatch(/terminal/i);
      expect(bytes(root).equals(before)).toBe(true);
    }
    expect(confirms).toEqual([]);
    expect(events).toEqual([]);
  });

  it("add and remove make no change when the operator declines confirmation", async () => {
    const root = mkProject(BASE_CFG);
    const before = bytes(root);
    const { deps, events, confirms } = mkDeps({ confirm: async (q) => (confirms.push(q), false) });
    for (const [sub, host] of [["add", "new.example.com"], ["remove", "example.com"]]) {
      const r = await run(root, sub, host, deps);
      expect(r.ok).toBe(false);
      expect(r.changed).not.toBe(true);
      expect(bytes(root).equals(before)).toBe(true);
    }
    expect(confirms).toHaveLength(2);
    expect(events).toEqual([]);
  });

  it("a changing add or remove reports changed true from the read-back and emits one cli.fetch-allowlist.changed event, and list emits none", async () => {
    const root = mkProject(BASE_CFG);
    {
      const { deps, events } = mkDeps();
      const r = await run(root, "add", "new.example.com", deps);
      expect(r.ok).toBe(true);
      expect(r.changed).toBe(true);
      expect(r.allowedHosts).toEqual(readCfg(root).fetchRaw.allowedHosts);
      expect(events).toEqual([{ type: "cli.fetch-allowlist.changed", payload: { op: "add", host: "new.example.com", projectRoot: path.resolve(root) } }]);
    }
    {
      const { deps, events } = mkDeps();
      const r = await run(root, "remove", "example.com", deps);
      expect(r.ok).toBe(true);
      expect(r.changed).toBe(true);
      expect(r.allowedHosts).toEqual(readCfg(root).fetchRaw.allowedHosts);
      expect(events).toEqual([{ type: AUDIT_EVENT_TYPE, payload: { op: "remove", host: "example.com", projectRoot: path.resolve(root) } }]);
    }
    {
      const { deps, events } = mkDeps();
      await run(root, "list", undefined, deps);
      expect(events).toEqual([]);
    }
  });

  it("routekit.js imports and dispatches fetch-allowlist", () => {
    expect(CLI_SRC).toMatch(/import\s*\{\s*handleFetchAllowlistCommand\s*\}\s*from\s*["']\.\.\/src\/cli\/fetch-allowlist\.js["']/);
    expect(CLI_SRC).toMatch(/if\s*\(\s*cmd\s*===\s*["']fetch-allowlist["']\s*\)\s*\{[\s\S]{0,400}?handleFetchAllowlistCommand\(/);
  });

  it("a no-op add or a remove of an absent host reports changed false and emits no event", async () => {
    const root = mkProject(BASE_CFG);
    const before = bytes(root);
    const { deps, events } = mkDeps();
    const add = await run(root, "add", "example.com", deps);
    expect(add).toMatchObject({ ok: true, changed: false });
    expect(add).not.toHaveProperty("audited");
    const rem = await run(root, "remove", "absent.example.com", deps);
    expect(rem).toMatchObject({ ok: true, changed: false });
    expect(rem).not.toHaveProperty("audited");
    expect(bytes(root).equals(before)).toBe(true);
    expect(events).toEqual([]);
  });

  it("a changing add or remove whose emit throws reports audited false with ok true and prints one warning line", async () => {
    const throwing = async () => {
      throw new Error("telemetry disk full");
    };
    for (const [sub, host] of [["add", "new.example.com"], ["remove", "example.com"]]) {
      const root = mkProject(BASE_CFG);
      const { deps, lines } = mkDeps({ emit: throwing });
      const r = await run(root, sub, host, deps);
      expect(r).toMatchObject({ ok: true, changed: true, audited: false });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(host);
      expect(lines[0]).toContain("cli.fetch-allowlist.changed");
      const hosts = readCfg(root).fetchRaw.allowedHosts;
      expect(hosts.includes(host)).toBe(sub === "add");

      const root2 = mkProject(BASE_CFG);
      const ok = mkDeps();
      const r2 = await run(root2, sub, host, ok.deps);
      expect(r2).toMatchObject({ ok: true, changed: true, audited: true });
      expect(ok.lines).toEqual([]);
    }
  });
});

// ---------- backlog.feat.fetch-allowlist-cli-hardening ----------

const runArgs = (root, sub, args, deps) => handleFetchAllowlistCommand({ sub, kv: { path: root }, args }, deps);

/** mkDeps without an injected emit, so the default emitter factory is the one used. */
function mkDepsNoEmit(over = {}) {
  const m = mkDeps(over);
  delete m.deps.emit;
  return m;
}

const rksEntries = (root) => fs.readdirSync(path.join(root, ".rks")).sort();

describe("fetch-allowlist CLI hardening", () => {
  beforeEach(() => {
    createDefaultTelemetryEmitter.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a confirmed add or remove keeps a key written to project.json while confirmation was pending", async () => {
    for (const [sub, host] of [["add", "new.example.com"], ["remove", "example.com"]]) {
      const root = mkProject(BASE_CFG);
      const { deps } = mkDeps({
        confirm: async () => {
          const c = readCfg(root);
          c.writtenDuringPrompt = { by: "someone else" };
          fs.writeFileSync(cfgFile(root), JSON.stringify(c, null, 2) + "\n");
          return true;
        },
      });
      const r = await run(root, sub, host, deps);
      expect(r).toMatchObject({ ok: true, changed: true });
      const after = readCfg(root);
      expect(after.writtenDuringPrompt).toEqual({ by: "someone else" });
      expect(after.fetchRaw.allowedHosts.includes(host)).toBe(sub === "add");
      expect(after.fetchRaw.mode).toBe("allowlist");
    }
  });

  it("an add whose host was written during confirmation returns changed false and does not write again", async () => {
    const root = mkProject(BASE_CFG);
    let written = null;
    const { deps, events } = mkDeps({
      confirm: async () => {
        const c = readCfg(root);
        c.fetchRaw.allowedHosts.push("new.example.com");
        fs.writeFileSync(cfgFile(root), JSON.stringify(c, null, 2) + "\n");
        written = bytes(root);
        return true;
      },
    });
    const rename = vi.spyOn(fs, "renameSync");
    const r = await run(root, "add", "new.example.com", deps);
    expect(r).toMatchObject({ ok: true, changed: false });
    expect(rename).not.toHaveBeenCalled();
    expect(bytes(root).equals(written)).toBe(true);
    expect(events).toEqual([]);
  });

  it("a changing write is renamed from a same-directory temp file and leaves no temp file", async () => {
    const root = mkProject(BASE_CFG);
    const { deps } = mkDeps();
    const rename = vi.spyOn(fs, "renameSync");
    const r = await run(root, "add", "new.example.com", deps);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(rename).toHaveBeenCalledTimes(1);
    const [src, dest] = rename.mock.calls[0];
    expect(path.dirname(path.resolve(src))).toBe(path.join(path.resolve(root), ".rks"));
    expect(path.resolve(src)).not.toBe(path.resolve(cfgFile(root)));
    expect(path.resolve(dest)).toBe(path.resolve(cfgFile(root)));
    expect(rksEntries(root)).toEqual(["project.json"]);
  });

  it("a failing rename returns ok false, leaves project.json byte-identical and removes the temp file", async () => {
    const root = mkProject(BASE_CFG);
    const before = bytes(root);
    const { deps, events } = mkDeps();
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("simulated rename failure"), { code: "EXDEV" });
    });
    const r = await run(root, "add", "new.example.com", deps);
    expect(r.ok).toBe(false);
    expect(bytes(root).equals(before)).toBe(true);
    expect(rksEntries(root)).toEqual(["project.json"]);
    expect(events).toEqual([]);
  });

  it("add takes the host as the first positional after the subcommand in space, equals and trailing flag forms", async () => {
    const forms = [
      (root) => ["fetch-allowlist", "add", "--path", root, "docs.example.com"],
      (root) => ["fetch-allowlist", "add", `--path=${root}`, "docs.example.com"],
      (root) => ["fetch-allowlist", "add", "docs.example.com", "--path", root],
    ];
    for (const form of forms) {
      const root = mkProject(BASE_CFG);
      const args = form(root);
      const { deps } = mkDeps();
      const r = await runArgs(root, "add", args, deps);
      expect(r, JSON.stringify(args)).toMatchObject({ ok: true, changed: true, host: "docs.example.com" });
      expect(readCfg(root).fetchRaw.allowedHosts).toContain("docs.example.com");
    }
  });

  it("add or remove with flags only and no positional host returns the empty-host error with no write", async () => {
    const emptyError = validateHostEntry("").error;
    for (const sub of ["add", "remove"]) {
      for (const form of [(root) => ["fetch-allowlist", sub, "--path", root], (root) => ["fetch-allowlist", sub, `--path=${root}`]]) {
        const root = mkProject(BASE_CFG);
        const before = bytes(root);
        const { deps, events, confirms } = mkDeps();
        const r = await runArgs(root, sub, form(root), deps);
        expect(r.ok).toBe(false);
        expect(r.error).toBe(emptyError);
        expect(bytes(root).equals(before)).toBe(true);
        expect(confirms).toEqual([]);
        expect(events).toEqual([]);
      }
    }
  });

  it("the module header, the unknown-subcommand usage and the bin help name the same path-flag syntax", async () => {
    const header = FETCH_ALLOWLIST_SRC.slice(0, FETCH_ALLOWLIST_SRC.indexOf("*/"));
    const root = mkProject(BASE_CFG);
    const { deps } = mkDeps();
    const r = await runArgs(root, "bogus", ["fetch-allowlist", "bogus"], deps);
    expect(r.ok).toBe(false);
    const usage = r.error;
    const helpLines = CLI_SRC.split("\n").filter((l) => /^\s*fetch-allowlist (list|add|remove)\b/.test(l));
    expect(helpLines).toHaveLength(3);
    for (const text of [header, usage, helpLines.join("\n")]) expect(text).toContain("--path=<projectRoot>");
    for (const l of helpLines) expect(l).toContain("[--path=<projectRoot>]");
    for (const sub of ["list", "add <host>", "remove <host>"]) {
      expect(header).toMatch(new RegExp(`fetch-allowlist ${sub}\\s+\\[--path=<projectRoot>\\]`));
    }
    expect(header).not.toContain("[--path <projectRoot>]");
    expect(usage).not.toContain("[--path <projectRoot>]");
  });

  it("remove clears a hand-written single-label entry case-insensitively", async () => {
    for (const value of ["localhost", "LOCALHOST"]) {
      const root = mkProject({ ...BASE_CFG, fetchRaw: { allowedHosts: ["example.com", "localhost"], mode: "allowlist" } });
      const { deps } = mkDeps();
      const r = await run(root, "remove", value, deps);
      expect(r, value).toMatchObject({ ok: true, changed: true });
      expect(readCfg(root).fetchRaw.allowedHosts).toEqual(["example.com"]);
    }
  });

  it("remove rejects an empty value or a value containing whitespace with no write", async () => {
    const root = mkProject({ ...BASE_CFG, fetchRaw: { allowedHosts: ["example.com", "localhost"], mode: "allowlist" } });
    const before = bytes(root);
    const { deps, events, confirms } = mkDeps();
    for (const bad of ["", "   ", "local host", " localhost", "localhost\t", "example .com"]) {
      const r = await run(root, "remove", bad, deps);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(bytes(root).equals(before)).toBe(true);
    }
    expect(confirms).toEqual([]);
    expect(events).toEqual([]);
  });

  it("add still rejects a single-label host", async () => {
    const root = mkProject(BASE_CFG);
    const before = bytes(root);
    const { deps, events } = mkDeps();
    expect(validateHostEntry("localhost").ok).toBe(false);
    const r = await run(root, "add", "localhost", deps);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(validateHostEntry("localhost").error);
    expect(bytes(root).equals(before)).toBe(true);
    expect(events).toEqual([]);
  });

  it("list and every no-change path never construct the default telemetry emitter", async () => {
    const root = mkProject(BASE_CFG);
    const before = bytes(root);
    // list
    expect((await run(root, "list", undefined, mkDepsNoEmit().deps)).ok).toBe(true);
    // validation failure
    expect((await run(root, "add", "https://x.example.com/", mkDepsNoEmit().deps)).ok).toBe(false);
    // not_a_terminal
    expect((await run(root, "add", "new.example.com", mkDepsNoEmit({ isTTY: false }).deps)).reason).toBe("not_a_terminal");
    // no-op add and no-op remove
    expect(await run(root, "add", "example.com", mkDepsNoEmit().deps)).toMatchObject({ ok: true, changed: false });
    expect(await run(root, "remove", "absent.example.com", mkDepsNoEmit().deps)).toMatchObject({ ok: true, changed: false });
    // declined confirmation
    expect((await run(root, "add", "new.example.com", mkDepsNoEmit({ confirm: async () => false }).deps)).reason).toBe("declined");
    expect(createDefaultTelemetryEmitter).not.toHaveBeenCalled();
    expect(bytes(root).equals(before)).toBe(true);
  });

  it("a changing add or remove with no injected emit constructs the default emitter exactly once", async () => {
    for (const [sub, host] of [["add", "new.example.com"], ["remove", "example.com"]]) {
      createDefaultTelemetryEmitter.mockClear();
      const root = mkProject(BASE_CFG);
      const r = await run(root, sub, host, mkDepsNoEmit().deps);
      expect(r).toMatchObject({ ok: true, changed: true, audited: true });
      expect(createDefaultTelemetryEmitter).toHaveBeenCalledTimes(1);
      expect(createDefaultTelemetryEmitter.mock.calls[0][0]).toMatchObject({ targetRoot: path.resolve(root) });
    }
  });
});

describe("fetch-allowlist bin smoke", () => {
  const SPAWN_TIMEOUT_MS = 60_000;
  const mkCwd = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "rks-fetch-allowlist-cwd-"));
    tmpRoots.push(d);
    return d;
  };
  const spawnBin = (args) =>
    spawnSync(process.execPath, [CLI_BIN, ...args], {
      cwd: mkCwd(),
      env: { ...process.env },
      encoding: "utf8",
      input: "",
      timeout: SPAWN_TIMEOUT_MS,
    });
  const assertRepoCfgUnchanged = () => {
    const now = fs.existsSync(REPO_CFG_FILE) ? fs.readFileSync(REPO_CFG_FILE) : null;
    if (REPO_CFG_BYTES_AT_LOAD === null) expect(now).toBeNull();
    else expect(now !== null && now.equals(REPO_CFG_BYTES_AT_LOAD)).toBe(true);
  };

  afterAll(() => {
    // Final guard after every test in the file has run.
    assertRepoCfgUnchanged();
  });

  it(
    "routekit.js fetch-allowlist list prints the temp project hosts and exits 0",
    () => {
      const root = mkProject(BASE_CFG);
      const before = bytes(root);
      const res = spawnBin(["fetch-allowlist", "list", "--path", root]);
      expect(res.error, String(res.error)).toBeUndefined();
      expect(res.status, res.stderr).toBe(0);
      const out = res.stdout.split("\n").map((l) => l.trim());
      for (const h of BASE_CFG.fetchRaw.allowedHosts) expect(out).toContain(h);
      expect(bytes(root).equals(before)).toBe(true);
    },
    SPAWN_TIMEOUT_MS + 10_000,
  );

  it(
    "routekit.js fetch-allowlist add on a non-TTY stdin prints the not-a-terminal message, exits 1 and leaves project.json byte-identical",
    () => {
      const root = mkProject(BASE_CFG);
      const before = bytes(root);
      const res = spawnBin(["fetch-allowlist", "add", "new.example.com", "--path", root]);
      expect(res.error, String(res.error)).toBeUndefined();
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("must be run by a person in an interactive terminal");
      expect(bytes(root).equals(before)).toBe(true);
    },
    SPAWN_TIMEOUT_MS + 10_000,
  );

  it("the repository .rks/project.json is byte-identical after the suite runs", () => {
    assertRepoCfgUnchanged();
  });
});
