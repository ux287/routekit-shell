/**
 * Witness for backlog.fix.shell-self-sync-skill-wipe-health-gate — THE CORE WITNESS.
 *
 * THE BUG: `syncProject` copies skills by rm'ing each destination skill and then copying the source
 * over it. When projectRoot === shellRoot, source and destination are THE SAME DIRECTORY: the rm
 * destroys the source, the copy finds nothing, and the whole thing exits 0 saying "Synced 0 file(s)".
 * Every skill, gone, silently. A clean-machine UAT lost all 17 distributable skills this way, and
 * `rks_preflight` reported 7/7 green throughout.
 *
 * It is reachable from FOUR callers that loop the project registry — `project sync --all`,
 * `project upgrade --all`, `routekit doctor`, and bootstrap — because setup.mjs registers the SHELL
 * ITSELF in that registry, and nothing told them a shell is not one of its own children.
 *
 * THE BOUNDARY RULE this file exists to pin: the guard fires IFF projectRoot and shellRoot are THE
 * SAME DIRECTORY (device + inode). It must NOT fire when one merely CONTAINS the other — a
 * legitimate child at <shellRoot>/children/kid is a different directory and must sync normally.
 *
 * ANTI-VACUITY. Every negative assertion here carries a positive control, because "the guard did not
 * fire" is also satisfied by a fixture that never constructed the firing condition:
 *   - projectId is pinned to "routekit-shell". sync.mjs only runs the projectId-substitution
 *     readdir when projectId !== "routekit-shell", so under ANY OTHER id the old wipe ENOENT-THREW
 *     instead of failing silently. A witness that used a different id would go red against the old
 *     code for the wrong reason — an incidental throw, not the silent wipe — and would stay green
 *     against a "fix" that only stopped the throw. This is the mirror's own identity, and the mirror
 *     is where the silence actually happened.
 *   - We assert the guard AFFIRMATIVELY FIRED (SelfSyncRefusedError), never merely that files still
 *     exist — a sync that never ran also leaves the files alone.
 *   - We assert the fixture HAS >= 2 non-excluded skills before every call, so "the skills survived"
 *     cannot be trivially true. `promote` surviving alone is a FAILURE.
 *   - We assert dev+ino IDENTITY for the self-target arms and dev+ino DIFFERENCE for the child arms,
 *     so neither arm can pass because the fixture accidentally built the other one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  syncProject,
  sameDirectory,
  SelfSyncRefusedError,
  MissingRequiredSourceError,
} from "../../packages/cli/src/project/sync.mjs";

// The mirror's rewritten identity — see the note above. Load-bearing, not incidental.
const SHELL_ID = "routekit-shell";

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rks-self-guard-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A shell with 3 skill dirs: two distributable, plus the shell-only `promote`. */
function makeShell(name = "shell") {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
  fs.writeFileSync(
    path.join(root, ".routekit", "skills-manifest.json"),
    JSON.stringify({ version: 1, skills: ["arch", "build", "promote"], shellOnly: ["promote"] }),
  );
  for (const skill of ["arch", "build", "promote"]) {
    const dir = path.join(root, ".claude", "skills", skill);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${skill}\nbody for ${skill}\n`);
  }
  // An optional source (hooks). Prompts and agents are deliberately absent — they are optional too.
  const hooks = path.join(root, "templates", "generic", ".routekit", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "a-hook.mjs"), "// hook\n");
  return root;
}

/** Distributable skills (i.e. NOT `promote`) that are present with a non-empty SKILL.md. */
function presentDistributable(root) {
  return ["arch", "build"].filter((s) => {
    const f = path.join(root, ".claude", "skills", s, "SKILL.md");
    return fs.existsSync(f) && fs.statSync(f).size > 0;
  });
}

function ino(p) {
  const s = fs.statSync(p);
  return `${s.dev}:${s.ino}`;
}

// ══════════════════════════════════════════════════════════════════════════════════
// THE SELF-TARGET GUARD — a shell must never sync from itself
// ══════════════════════════════════════════════════════════════════════════════════

describe("syncProject refuses to sync a directory from itself", () => {
  it("REFUSES when projectRoot === shellRoot, and the skills SURVIVE", () => {
    const shell = makeShell();

    // POSITIVE CONTROL: the firing condition genuinely exists before we call.
    expect(presentDistributable(shell)).toHaveLength(2); // not vacuous — there IS something to lose
    expect(sameDirectory(shell, shell)).toBe(true);

    // The guard AFFIRMATIVELY fires. "The files are still there" is NOT sufficient — a sync that
    // never ran also leaves them there.
    let err;
    try {
      syncProject({ projectRoot: shell, projectId: SHELL_ID, shellRoot: shell });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SelfSyncRefusedError);
    expect(err.code).toBe("self_sync_refused");
    expect(err.message).toMatch(/same directory/i);

    // And the skills are intact — INCLUDING the distributable ones. `promote` surviving alone would
    // mean the wipe ran and only the excluded skill was spared, which is exactly what happened on
    // the UAT box.
    expect(presentDistributable(shell)).toEqual(["arch", "build"]);
    expect(fs.existsSync(path.join(shell, ".claude", "skills", "promote", "SKILL.md"))).toBe(true);
  });

  // Each of these is a DIFFERENT STRING for the same directory. A `===` compare passes all of them
  // and wipes; `realpathSync` misses the last two. dev+ino sees all of them.
  it("REFUSES a trailing-slash spelling of the same directory", () => {
    const shell = makeShell();
    const spelled = shell + path.sep;
    expect(ino(spelled)).toBe(ino(shell)); // same directory, different string
    expect(() => syncProject({ projectRoot: spelled, projectId: SHELL_ID, shellRoot: shell })).toThrow(
      SelfSyncRefusedError,
    );
    expect(presentDistributable(shell)).toHaveLength(2);
  });

  it("REFUSES a `..`-segment spelling of the same directory", () => {
    const shell = makeShell();
    const spelled = `${shell}${path.sep}.claude${path.sep}..`;
    expect(ino(spelled)).toBe(ino(shell));
    expect(() => syncProject({ projectRoot: spelled, projectId: SHELL_ID, shellRoot: shell })).toThrow(
      SelfSyncRefusedError,
    );
    expect(presentDistributable(shell)).toHaveLength(2);
  });

  it("REFUSES a SYMLINK that points at the shell", () => {
    const shell = makeShell();
    const link = path.join(tmp, "link-to-shell");
    fs.symlinkSync(shell, link, "dir");
    expect(ino(link)).toBe(ino(shell)); // statSync follows the link — that is the point
    expect(() => syncProject({ projectRoot: link, projectId: SHELL_ID, shellRoot: shell })).toThrow(
      SelfSyncRefusedError,
    );
    expect(presentDistributable(shell)).toHaveLength(2);
  });

  it("REFUSES when the DESTINATION SKILLS DIR is a symlink back to the shell's (entry guard blind spot)", () => {
    // The entry guard compares projectRoot to shellRoot — and here they are genuinely DIFFERENT
    // directories, so it does not fire. But <child>/.claude/skills/arch is a symlink to the shell's
    // own `arch`, so the rm inside the skills loop would delete THROUGH the link and destroy the
    // shell's skill with the entry guard none the wiser. The guard has to live where the destruction
    // happens, not only at the door.
    const shell = makeShell();
    const child = path.join(tmp, "child");
    fs.mkdirSync(path.join(child, ".claude", "skills"), { recursive: true });
    fs.symlinkSync(path.join(shell, ".claude", "skills", "arch"), path.join(child, ".claude", "skills", "arch"), "dir");

    expect(sameDirectory(child, shell)).toBe(false); // the entry guard genuinely does NOT fire here
    expect(ino(path.join(child, ".claude", "skills", "arch"))).toBe(ino(path.join(shell, ".claude", "skills", "arch")));

    expect(() => syncProject({ projectRoot: child, projectId: "child-x", shellRoot: shell })).toThrow(
      SelfSyncRefusedError,
    );
    // The shell's skill was NOT deleted through the link.
    expect(presentDistributable(shell)).toEqual(["arch", "build"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// THE BOUNDARY — identity, NOT containment (N1 negative control + positive arm)
// ══════════════════════════════════════════════════════════════════════════════════

describe("the guard fires on IDENTITY, never on CONTAINMENT", () => {
  // ONE fixture factory. The single parameterized difference is WHERE the child lives: AT the shell
  // (must refuse) or NESTED INSIDE the shell (must sync normally). The natural-but-wrong
  // implementation — `projectRoot.startsWith(shellRoot)` — passes the first and WRONGLY REFUSES the
  // second, and every fixture that used sibling temp dirs would stay green while it did.
  const arrange = (where) => {
    const shell = makeShell();
    const child = where === "self" ? shell : path.join(shell, "children", "kid");
    if (where !== "self") fs.mkdirSync(child, { recursive: true });
    return { shell, child };
  };

  it("POSITIVE ARM: a child AT the shell is refused", () => {
    const { shell, child } = arrange("self");
    expect(ino(child)).toBe(ino(shell));
    expect(() => syncProject({ projectRoot: child, projectId: SHELL_ID, shellRoot: shell })).toThrow(
      SelfSyncRefusedError,
    );
    expect(presentDistributable(shell)).toHaveLength(2);
  });

  it("NEGATIVE CONTROL: a legitimate child NESTED INSIDE the shell dir syncs NORMALLY", () => {
    const { shell, child } = arrange("nested");

    // The child is genuinely nested — string containment holds. This is precisely the predicate we
    // are proving is NOT sufficient grounds to refuse.
    expect(path.resolve(child).startsWith(path.resolve(shell) + path.sep)).toBe(true);
    // …and it is genuinely a DIFFERENT directory.
    expect(ino(child)).not.toBe(ino(shell));
    expect(sameDirectory(child, shell)).toBe(false);
    // The shell has skills to give (so "the child got skills" cannot be vacuously true).
    expect(presentDistributable(shell)).toHaveLength(2);

    const updated = syncProject({ projectRoot: child, projectId: "kid", shellRoot: shell });

    // It actually DID something — "no error thrown" is not enough; a silent no-op also throws nothing.
    expect(updated.length).toBeGreaterThan(0);
    expect(presentDistributable(child)).toEqual(["arch", "build"]);
    // The shell-only skill was NOT distributed.
    expect(fs.existsSync(path.join(child, ".claude", "skills", "promote"))).toBe(false);
    // And the shell still has its own.
    expect(presentDistributable(shell)).toEqual(["arch", "build"]);
  });

  it("a sibling child (the ordinary case) still syncs normally", () => {
    const shell = makeShell();
    const child = path.join(tmp, "sibling");
    fs.mkdirSync(child, { recursive: true });
    const updated = syncProject({ projectRoot: child, projectId: "sib", shellRoot: shell });
    expect(updated.length).toBeGreaterThan(0);
    expect(presentDistributable(child)).toEqual(["arch", "build"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// THE ENOENT FALLBACK — attach's legitimate case, and the bypass it must not open
// ══════════════════════════════════════════════════════════════════════════════════

describe("a not-yet-existing projectRoot (attach) is not the shell", () => {
  it("syncs normally into a projectRoot that does not exist yet", () => {
    const shell = makeShell();
    const child = path.join(tmp, "not-created-yet");
    expect(fs.existsSync(child)).toBe(false);

    // dev+ino cannot compare a directory that isn't there — and a directory that does not exist
    // cannot BE the shell, so we proceed. This is the only case identity cannot decide, and it
    // decides safely.
    expect(sameDirectory(child, shell)).toBe(false);

    const updated = syncProject({ projectRoot: child, projectId: "fresh", shellRoot: shell });
    // Genuinely populated — "it didn't throw" would also be true of a silent no-op.
    expect(updated.length).toBeGreaterThan(0);
    expect(presentDistributable(child)).toEqual(["arch", "build"]);
  });

  it("a MISSING shellRoot is not-the-same-directory (safe) — and the missing SOURCE is what goes loud", () => {
    const child = path.join(tmp, "child");
    fs.mkdirSync(child, { recursive: true });
    const gone = path.join(tmp, "no-such-shell");

    // A directory that does not exist cannot BE another directory, so there is nothing to destroy
    // and `false` is the correct answer. The real problem — a shell that isn't there — is reported
    // by the required-source check, LOUDLY, rather than being smuggled through the identity guard.
    expect(sameDirectory(child, gone)).toBe(false);
    expect(() => syncProject({ projectRoot: child, projectId: "child-x", shellRoot: gone })).toThrow(
      MissingRequiredSourceError,
    );
  });

  it("a NON-ENOENT stat error is NEVER swallowed (the EACCES bypass)", () => {
    // Swallowing every stat error would mean an EACCES/EPERM/ELOOP on a path that IS the shell reads
    // as "not the same directory" — and the destructive copy proceeds. Only ENOENT/ENOTDIR are safe
    // to treat as "not a directory"; everything else must surface.
    const shell = makeShell();
    const notADir = path.join(shell, "package.json"); // a FILE — statting through it is ENOTDIR
    expect(sameDirectory(path.join(notADir, "nested"), shell)).toBe(false); // ENOTDIR → safe false

    const spy = vi.spyOn(fs, "statSync").mockImplementation(() => {
      const e = new Error("permission denied");
      e.code = "EACCES";
      throw e;
    });
    try {
      expect(() => sameDirectory(shell, shell)).toThrow(/permission denied/);
    } finally {
      spy.mockRestore();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// REQUIRED vs OPTIONAL SOURCES — the other half of the silence
// ══════════════════════════════════════════════════════════════════════════════════

describe("a missing skills source is LOUD; missing optional sources are tolerated", () => {
  it("THROWS when the shell has no skills to give", () => {
    // Built on a genuinely DIFFERENT, skill-less shell — so it is the missing-source check that
    // makes this loud, NOT the self-target guard. Without this assertion the test would prove the
    // wrong thing.
    const shell = makeShell("bare-shell");
    fs.rmSync(path.join(shell, ".claude", "skills"), { recursive: true, force: true });
    const child = path.join(tmp, "child");
    fs.mkdirSync(child, { recursive: true });
    expect(sameDirectory(child, shell)).toBe(false); // NOT the self-guard's doing

    let err;
    try {
      syncProject({ projectRoot: child, projectId: "child-x", shellRoot: shell });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingRequiredSourceError);
    expect(err.code).toBe("missing_required_source");
    expect(err.code).not.toBe("self_sync_refused"); // the identity of the error matters
  });

  it("TOLERATES missing hooks / prompts / agents, and still syncs the skills", () => {
    const shell = makeShell();
    // Remove every OPTIONAL source. Hooks is the interesting one: it has no call-site existsSync at
    // all — its toleration comes solely from the early return inside copyDirOverwriteTracked.
    fs.rmSync(path.join(shell, "templates"), { recursive: true, force: true });
    expect(fs.existsSync(path.join(shell, "templates", "generic", ".routekit", "hooks"))).toBe(false);
    expect(fs.existsSync(path.join(shell, ".rks", "prompts"))).toBe(false);
    expect(fs.existsSync(path.join(shell, ".claude", "agents"))).toBe(false);

    const child = path.join(tmp, "child");
    fs.mkdirSync(child, { recursive: true });

    const updated = syncProject({ projectRoot: child, projectId: "child-x", shellRoot: shell });

    // Completed, and did real work — not a silent bail.
    expect(updated.length).toBeGreaterThan(0);
    expect(presentDistributable(child)).toEqual(["arch", "build"]);
    // Nothing was fabricated for the absent optional sources.
    expect(fs.existsSync(path.join(child, ".routekit", "hooks"))).toBe(false);
  });
});
