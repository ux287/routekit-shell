// backlog.chore.backlog-archive-strays-and-stalls
//
// Unit tests for scripts/backlog-archive-sweep.mjs. Every fixture vault is built under
// tests/helpers/tmp.mjs's TEMP_BASE (outside any real repository). Fixture note names live in
// the `backlog.zzfx.*` namespace, which does not exist under the real notes/, and every note
// filename is built at run time (`${name}.md`), so this file never contains a real note's
// filename-with-extension literal that the sweep's own test_reference guard would treat as a hold.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir, initGitRepo, writeFile } from "../helpers/tmp.mjs";
import { planSweep, applySweep, destinationFor, formatReport, ARCHIVED_BY, COHORT_KEYS, FOLLOWS_CHILDREN_BY } from "../../scripts/backlog-archive-sweep.mjs";
import { parseFrontmatter, splitNoteFrontmatter } from "../../packages/mcp-rks/src/shared/frontmatter.mjs";
import { rewriteWikilinks } from "../../packages/mcp-rks/src/shared/wikilinks.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MD = ".md";
const GIT_TIMEOUT = 120_000;

// ---------------------------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------------------------

function yamlValue(v) {
  if (Array.isArray(v)) return v.length === 0 ? " []" : "\n" + v.map((x) => `  - ${JSON.stringify(x)}`).join("\n");
  return " " + JSON.stringify(v);
}

// Build a note: frontmatter fields (rendered in order) and a body. The body starts on the line
// after the closing fence.
function noteText(fields, body = "\n\n# Fixture\n\nBody text.\n") {
  const lines = Object.entries(fields).map(([k, v]) => `${k}:${yamlValue(v)}`);
  return `---\n${lines.join("\n")}\n---${body}`;
}

function story(name, extra = {}, body) {
  return noteText({ id: name, title: `Fixture ${name}`, status: "not-implemented", ...extra }, body);
}

function notePath(root, name) {
  return path.join(root, "notes", name + MD);
}

function makeVault({ notes = {}, files = {} } = {}) {
  const root = makeTempDir("backlog-archive-sweep");
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  for (const [name, text] of Object.entries(notes)) if (text !== undefined) writeFile(notePath(root, name), text);
  for (const [rel, text] of Object.entries(files)) writeFile(path.join(root, rel), text);
  return root;
}

function git(root, args) {
  const res = spawnSync("git", ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: GIT_TIMEOUT,
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  return res.stdout;
}

function makeGitVault(spec) {
  const root = makeVault(spec);
  initGitRepo(root);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

// name -> bytes for every file under root (recursive, .git excluded).
function snapshot(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === ".git") continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.set(path.relative(root, p), fs.readFileSync(p, "utf8"));
    }
  };
  walk(root);
  return out;
}

function expectSnapshotsEqual(a, b) {
  expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
  for (const [k, v] of a) expect(b.get(k), k).toBe(v);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function emptyManifest(extra = {}) {
  return { version: 1, doneInCode: [], archive: [], held: [], ...extra };
}

function readData(root, name) {
  return parseFrontmatter(fs.readFileSync(notePath(root, name), "utf8")).data;
}

function heldFor(plan, id) {
  return plan.held.find((h) => h.id === id);
}

function moveFor(plan, id) {
  return plan.moves.find((m) => m.from === id);
}

function applyReviewed(root, manifest, opts = {}) {
  const plan = planSweep({ projectRoot: root, manifest, ...opts });
  const result = applySweep({ projectRoot: root, manifest, expectDigest: plan.digest, ...opts });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return { plan, result };
}

// Split frontmatter into top-level key blocks: key -> raw block text.
function keyBlocks(frontmatter) {
  const blocks = new Map();
  let key = null;
  for (const line of frontmatter.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_$-]+):(\s|$)/);
    if (m) {
      key = m[1];
      blocks.set(key, line);
    } else if (key !== null) {
      blocks.set(key, blocks.get(key) + "\n" + line);
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------------

describe("backlog-archive-sweep", () => {
  it("planSweep writes nothing and reports counts, moves, wikilink rewrites and digest", () => {
    const root = makeVault({
      notes: {
        "backlog.zzfx.rel-one": story("backlog.zzfx.rel-one", { phase: "released" }),
        "backlog.zzfx.linker": story("backlog.zzfx.linker", { phase: "draft" }, "\n\nSee [[backlog.zzfx.rel-one]].\n"),
      },
    });
    const before = snapshot(root);
    const plan = planSweep({ projectRoot: root, manifest: emptyManifest() });
    expectSnapshotsEqual(before, snapshot(root));

    expect(plan.counts.cohorts).toEqual({ A: 1, "A'": 0, B: 0, C1: 0, C2: 0, C3: 0, C4: 0 });
    expect(plan.counts.held).toEqual({ user_hold: 1 });
    const mv = moveFor(plan, "backlog.zzfx.rel-one");
    expect(mv.to).toBe("backlog.z_implemented.zzfx.rel-one");
    expect(mv.updates).toMatchObject({ id: "backlog.z_implemented.zzfx.rel-one", status: "implemented" });
    expect(plan.wikilinkRewrites).toEqual([{ file: "backlog.zzfx.linker", count: 1, moved: false }]);
    expect(plan.counts.wikilinkRewrites).toBe(1);
    expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("CLI with no flags exits 0 and leaves notes git status unchanged", () => {
    const status = () =>
      spawnSync("git", ["status", "--porcelain", "--", "notes"], { cwd: REPO_ROOT, encoding: "utf8", timeout: GIT_TIMEOUT }).stdout;
    const before = status();
    const run = spawnSync(process.execPath, ["scripts/backlog-archive-sweep.mjs"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 512 * 1024 * 1024,
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/digest: [0-9a-f]{64}/);
    expect(status()).toBe(before);
  }, 360_000);

  it("planSweep digest is deterministic", () => {
    const root = makeVault({
      notes: {
        "backlog.zzfx.rel-a": story("backlog.zzfx.rel-a", { phase: "released" }),
        "backlog.zzfx.int-b": story("backlog.zzfx.int-b", { phase: "integrated" }),
      },
    });
    const a = planSweep({ projectRoot: root, manifest: emptyManifest() });
    const b = planSweep({ projectRoot: root, manifest: emptyManifest() });
    expect(a.digest).toBe(b.digest);
    expect(a.moves.length).toBe(2);
  });

  it("applySweep refuses without expectDigest", () => {
    const root = makeGitVault({ notes: { "backlog.zzfx.rel-a": story("backlog.zzfx.rel-a", { phase: "released" }) } });
    const before = snapshot(root);
    const res = applySweep({ projectRoot: root, manifest: emptyManifest() });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("digest_required");
    expectSnapshotsEqual(before, snapshot(root));
  });

  it("applySweep refuses on digest mismatch", () => {
    const root = makeGitVault({ notes: { "backlog.zzfx.rel-a": story("backlog.zzfx.rel-a", { phase: "released" }) } });
    const before = snapshot(root);
    const res = applySweep({ projectRoot: root, manifest: emptyManifest(), expectDigest: "0".repeat(64) });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("digest_mismatch");
    expectSnapshotsEqual(before, snapshot(root));
  });

  it("applySweep refuses tree_dirty", () => {
    const root = makeGitVault({ notes: { "backlog.zzfx.rel-a": story("backlog.zzfx.rel-a", { phase: "released" }) } });
    writeFile(notePath(root, "backlog.zzfx.untracked-draft"), story("backlog.zzfx.untracked-draft", { phase: "draft" }));
    const before = snapshot(root);
    const plan = planSweep({ projectRoot: root, manifest: emptyManifest() });
    const res = applySweep({ projectRoot: root, manifest: emptyManifest(), expectDigest: plan.digest });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("tree_dirty");
    expectSnapshotsEqual(before, snapshot(root));
  });

  it("cohort A released moves to z_implemented with metadata", () => {
    const name = "backlog.zzfx.rel-meta";
    const root = makeGitVault({ notes: { [name]: story(name, { phase: "released", releasedIn: "0.90.1" }) } });
    applyReviewed(root, emptyManifest());
    const dest = destinationFor(name, "z_implemented");
    expect(dest).toBe("backlog.z_implemented.zzfx.rel-meta");
    expect(fs.existsSync(notePath(root, name))).toBe(false);
    const d = readData(root, dest);
    expect(d.id).toBe(dest);
    expect(d.status).toBe("implemented");
    expect(d.phase).toBe("released");
    expect(d.releasedIn).toBe("0.90.1");
    expect(d.archivedBy).toBe(ARCHIVED_BY);
    expect(d.archivedBy).toBe("backlog.chore.backlog-archive-strays-and-stalls");
    expect(d.archiveCohort).toBe("released");
  });

  it("cohort A-prime integrated moves to z_implemented with metadata", () => {
    const name = "backlog.zzfx.int-meta";
    const root = makeGitVault({ notes: { [name]: story(name, { phase: "integrated" }) } });
    const { plan } = applyReviewed(root, emptyManifest());
    expect(plan.counts.cohorts["A'"]).toBe(1);
    expect(plan.releaseCandidates).toEqual([name]);
    const dest = destinationFor(name, "z_implemented");
    const d = readData(root, dest);
    expect(d.id).toBe(dest);
    expect(d.status).toBe("implemented");
    expect(d.phase).toBe("integrated");
    expect(d.archiveCohort).toBe("integrated");
  });

  it("already-archived and body-quoted phase notes are not selected", () => {
    const archived = "backlog.z_implemented.zzfx.already";
    const quoted = "backlog.zzfx.quoted";
    const root = makeVault({
      notes: {
        [archived]: story(archived, { phase: "released" }),
        [quoted]: story(quoted, { phase: "draft" }, '\n\nAn example line:\n\nphase: "released"\n'),
      },
    });
    const plan = planSweep({ projectRoot: root, manifest: emptyManifest() });
    expect(plan.moves).toEqual([]);
    expect(moveFor(plan, archived)).toBeUndefined();
    expect(heldFor(plan, quoted).reason).toBe("user_hold");
    expect(heldFor(plan, archived)).toBeUndefined();
  });

  it("cohort B done-in-code moves with evidence and phase unchanged", () => {
    const name = "backlog.zzfx.done-code";
    const root = makeGitVault({
      notes: { [name]: story(name, { phase: "ready" }) },
      files: { "src/thing.mjs": 'export const NAME = "zzfx_tool";\n' },
    });
    const manifest = emptyManifest({ doneInCode: [{ id: name, evidence: [{ file: "src/thing.mjs", literal: 'NAME = "zzfx_tool"' }] }] });
    const { plan } = applyReviewed(root, manifest);
    expect(plan.counts.cohorts.B).toBe(1);
    const dest = destinationFor(name, "z_implemented");
    const d = readData(root, dest);
    expect(d.id).toBe(dest);
    expect(d.phase).toBe("ready");
    expect(d.status).toBe("implemented");
    expect(d.archivedFromPhase).toBe("ready");
    expect(d.archiveEvidence).toEqual(['src/thing.mjs :: NAME = "zzfx_tool"']);
    expect(d.archiveCohort).toBe("done-in-code");
    expect(Object.prototype.hasOwnProperty.call(d, "releasedIn")).toBe(false);
  });

  it("cohort B missing literal is held evidence_not_found", () => {
    const name = "backlog.zzfx.done-missing";
    const root = makeGitVault({
      notes: { [name]: story(name, { phase: "draft" }) },
      files: { "src/thing.mjs": "export const OTHER = 1;\n" },
    });
    const before = fs.readFileSync(notePath(root, name), "utf8");
    const manifest = emptyManifest({ doneInCode: [{ id: name, evidence: [{ file: "src/thing.mjs", literal: "zzfx_absent_literal" }] }] });
    const { plan } = applyReviewed(root, manifest);
    expect(heldFor(plan, name).reason).toBe("evidence_not_found");
    expect(fs.readFileSync(notePath(root, name), "utf8")).toBe(before);
  });

  it("cohort C1 superseded moves to z_archive with supersededBy", () => {
    const name = "backlog.zzfx.old-way";
    const by = "backlog.zzfx.new-way";
    const root = makeGitVault({
      notes: { [name]: story(name, { phase: "ready" }), [by]: story(by, { phase: "draft" }) },
    });
    const manifest = emptyManifest({ archive: [{ id: name, kind: "superseded", supersededBy: by, reason: "replaced" }] });
    const { plan } = applyReviewed(root, manifest);
    expect(plan.counts.cohorts.C1).toBe(1);
    const dest = destinationFor(name, "z_archive");
    expect(dest).toBe("z_archive.backlog.zzfx.old-way");
    const d = readData(root, dest);
    expect(d.id).toBe(dest);
    expect(d.status).toBe("superseded");
    expect(d.phase).toBe("ready");
    expect(d.supersededBy).toBe(by);
    expect(d.archivedFromPhase).toBe("ready");
    expect(d.archiveCohort).toBe("superseded");

    {
    // List form: a note split into several successors names them as a list; every one must resolve.
    const name = "backlog.zzfx.split-old";
    const by = ["backlog.zzfx.split-new-1", "backlog.zzfx.split-new-2"];
    const root = makeGitVault({
      notes: { [name]: story(name, { phase: "decomposed" }), [by[0]]: story(by[0], { phase: "released" }), [by[1]]: story(by[1], { phase: "draft" }) },
    });
    const manifest = emptyManifest({ archive: [{ id: name, kind: "superseded", supersededBy: by, reason: "split" }] });
    applyReviewed(root, manifest);
    expect(readData(root, destinationFor(name, "z_archive")).supersededBy).toEqual(by);
    const missing = emptyManifest({ archive: [{ id: "backlog.zzfx.split-new-2", kind: "superseded", supersededBy: ["backlog.zzfx.split-old", "backlog.zzfx.nowhere"], reason: "x" }] });
    expect(heldFor(planSweep({ projectRoot: root, manifest: missing }), "backlog.zzfx.split-new-2").reason).toBe("superseder_not_found");
    }
  });

  it("cohort C1 unresolved superseder is held superseder_not_found", () => {
    const name = "backlog.zzfx.old-orphan";
    const root = makeVault({ notes: { [name]: story(name, { phase: "ready" }) } });
    const manifest = emptyManifest({ archive: [{ id: name, kind: "superseded", supersededBy: "backlog.zzfx.nowhere", reason: "x" }] });
    const plan = planSweep({ projectRoot: root, manifest });
    expect(heldFor(plan, name).reason).toBe("superseder_not_found");
    expect(plan.moves).toEqual([]);
  });

  it("cohort C2 wont-do moves to z_archive with archiveReason", () => {
    const name = "backlog.zzfx.never";
    const root = makeGitVault({ notes: { [name]: story(name, { phase: "draft" }) } });
    const manifest = emptyManifest({ archive: [{ id: name, kind: "wont-do", reason: "out of scope for fixture" }] });
    const { plan } = applyReviewed(root, manifest);
    expect(plan.counts.cohorts.C2).toBe(1);
    const dest = destinationFor(name, "z_archive");
    const d = readData(root, dest);
    expect(d.id).toBe(dest);
    expect(d.status).toBe("wont-do");
    expect(d.phase).toBe("draft");
    expect(d.archiveReason).toBe("out of scope for fixture");
    expect(d.archivedFromPhase).toBe("draft");
    expect(d.archiveCohort).toBe("wont-do");
  });

  it("cohort C3 decomposed with all children shipped moves to z_implemented", () => {
    const parent = "backlog.zzfx.parent";
    const childArchived = "backlog.z_implemented.zzfx.parent.child-1";
    const childReleased = "backlog.zzfx.parent.child-2";
    const root = makeGitVault({
      notes: {
        [parent]: story(parent, { phase: "decomposed" }),
        [childArchived]: story(childArchived, { phase: "released" }),
        [childReleased]: story(childReleased, { phase: "released" }),
      },
    });
    const { plan } = applyReviewed(root, emptyManifest());
    expect(plan.counts.cohorts.C3).toBe(1);
    const dest = destinationFor(parent, "z_implemented");
    const d = readData(root, dest);
    expect(d.id).toBe(dest);
    expect(d.status).toBe("implemented");
    expect(d.phase).toBe("decomposed");
    expect([...d.decomposedInto].sort()).toEqual([childArchived, destinationFor(childReleased, "z_implemented")].sort());
    expect(d.archiveCohort).toBe("decomposed");
  });

  it("cohort C3 holds children_not_shipped and no_children", () => {
    const pArch = "backlog.zzfx.p-arch";
    const pLive = "backlog.zzfx.p-live";
    const pNone = "backlog.zzfx.p-none";
    const root = makeGitVault({
      notes: {
        [pArch]: story(pArch, { phase: "decomposed" }),
        ["z_archive.backlog.zzfx.p-arch.child-1"]: story("z_archive.backlog.zzfx.p-arch.child-1", { phase: "draft" }),
        [pLive]: story(pLive, { phase: "decomposed" }),
        ["backlog.zzfx.p-live.child-1"]: story("backlog.zzfx.p-live.child-1", { phase: "ready" }),
        [pNone]: story(pNone, { phase: "decomposed" }),
      },
    });
    const before = snapshot(root);
    const { plan } = applyReviewed(root, emptyManifest());
    // A parent whose only child is archived follows it (cohort C4,
    // backlog-sweep-decomposed-parent-follows-children); it is no longer held.
    expect(heldFor(plan, pArch)).toBeUndefined();
    expect(moveFor(plan, pArch).cohort).toBe("C4");
    expect(heldFor(plan, pLive).reason).toBe("children_not_shipped");
    expect(heldFor(plan, pNone).reason).toBe("no_children");
    expect(plan.moves.map((m) => m.from)).toEqual([pArch]);
    const after = snapshot(root);
    const rel = (n) => path.join("notes", n + MD);
    expect(after.has(rel(pArch))).toBe(false);
    expect(after.has(rel(destinationFor(pArch, "z_archive")))).toBe(true);
    for (const n of [pLive, pNone, "backlog.zzfx.p-live.child-1", "z_archive.backlog.zzfx.p-arch.child-1"]) expect(after.get(rel(n)), n).toBe(before.get(rel(n)));
  });

  it("target_exists holds and preserves both files", () => {
    const a = "backlog.zzfx.dup-impl";
    const b = "backlog.zzfx.dup-arch";
    const aDest = destinationFor(a, "z_implemented");
    const bOther = destinationFor(b, "z_archive");
    const root = makeGitVault({
      notes: {
        [a]: story(a, { phase: "released" }),
        [aDest]: story(aDest, { phase: "decomposed" }),
        [b]: story(b, { phase: "released" }),
        [bOther]: story(bOther, { phase: "draft" }),
      },
    });
    const before = snapshot(root);
    const { plan } = applyReviewed(root, emptyManifest());
    expect(heldFor(plan, a).reason).toBe("target_exists");
    expect(heldFor(plan, b).reason).toBe("target_exists");
    expectSnapshotsEqual(before, snapshot(root));
  });

  it("test_reference holds on filename.md literal only", () => {
    const pinned = "backlog.zzfx.pinned";
    const idOnly = "backlog.zzfx.id-only";
    const root = makeVault({
      notes: {
        [pinned]: story(pinned, { phase: "released" }),
        [idOnly]: story(idOnly, { phase: "released" }),
      },
      files: {
        "tests/unit/fixture-pin.test.mjs": `// header\nconst P = "notes/${pinned}${MD}";\n`,
        "tests/unit/fixture-mention.test.mjs": `// ${idOnly}\n`,
      },
    });
    const plan = planSweep({ projectRoot: root, manifest: emptyManifest() });
    const h = heldFor(plan, pinned);
    expect(h.reason).toBe("test_reference");
    expect(h.refs).toEqual([{ file: "tests/unit/fixture-pin.test.mjs", line: 2 }]);
    expect(moveFor(plan, idOnly)).toBeDefined();
    expect(heldFor(plan, idOnly)).toBeUndefined();
  });

  it("readme_reference holds z_archive destinations only", () => {
    const toArchive = "backlog.zzfx.readme-wontdo";
    const toImpl = "backlog.zzfx.readme-released";
    const root = makeVault({
      notes: {
        [toArchive]: story(toArchive, { phase: "draft" }),
        [toImpl]: story(toImpl, { phase: "released" }),
      },
      files: { "README.md": `# Fixture\n\nSee ${toArchive} and ${toImpl}.\n` },
    });
    const manifest = emptyManifest({ archive: [{ id: toArchive, kind: "wont-do", reason: "x" }] });
    const plan = planSweep({ projectRoot: root, manifest });
    expect(heldFor(plan, toArchive).reason).toBe("readme_reference");
    expect(moveFor(plan, toImpl)).toBeDefined();
  });

  it("unparseable and duplicate-key frontmatter is held unmodified", () => {
    const bad = "backlog.zzfx.bad-yaml";
    const dup = "backlog.zzfx.dup-key";
    const root = makeGitVault({
      notes: {
        [bad]: `---\nid: "${bad}"\nphase: [released\n---\n\nBody.\n`,
        [dup]: `---\nid: "${dup}"\nphase: "released"\nphase: "draft"\n---\n\nBody.\n`,
      },
    });
    const before = snapshot(root);
    const { plan } = applyReviewed(root, emptyManifest());
    expect(heldFor(plan, bad).reason).toBe("frontmatter_unparseable");
    expect(heldFor(plan, dup).reason).toBe("duplicate_key");
    expectSnapshotsEqual(before, snapshot(root));
  });

  it("unselected notes are unchanged except reported wikilink rewrites", () => {
    const rel = "backlog.zzfx.shipped";
    const unselected = {
      "backlog.zzfx.u-arch": story("backlog.zzfx.u-arch", { phase: "arch-approved" }, `\n\nDepends on [[${rel}]].\n`),
      "backlog.zzfx.u-draft": story("backlog.zzfx.u-draft", { phase: "draft" }),
      "backlog.zzfx.u-ready": story("backlog.zzfx.u-ready", { phase: "ready" }),
      "backlog.zzfx.u-nophase": story("backlog.zzfx.u-nophase"),
    };
    const root = makeGitVault({ notes: { [rel]: story(rel, { phase: "released" }), ...unselected } });
    const before = snapshot(root);
    const { plan } = applyReviewed(root, emptyManifest());
    for (const name of Object.keys(unselected)) {
      expect(heldFor(plan, name)?.reason, name).toBe("user_hold");
      expect(moveFor(plan, name)).toBeUndefined();
    }
    expect(plan.rewrittenUnmovedNotes).toEqual(["backlog.zzfx.u-arch"]);
    for (const name of Object.keys(unselected)) {
      const rel2 = path.join("notes", name + MD);
      const after = fs.readFileSync(path.join(root, rel2), "utf8");
      if (name === "backlog.zzfx.u-arch") {
        expect(after).toBe(before.get(rel2).replace(`[[${rel}]]`, `[[${destinationFor(rel, "z_implemented")}]]`));
      } else {
        expect(after).toBe(before.get(rel2));
      }
    }
  });

  it("wikilinks are rewritten with measured count", () => {
    const rel = "backlog.zzfx.target";
    const other = "research.zzfx.paper";
    const otherText = noteText({ id: other }, `\n\n[[${rel}]] and [[label|${rel}#anchor]] and [[${rel}.child]].\n`);
    const root = makeGitVault({ notes: { [rel]: story(rel, { phase: "released" }), [other]: otherText } });
    const newId = destinationFor(rel, "z_implemented");
    const expected = rewriteWikilinks(otherText, new Map([[rel, newId]]));
    const { plan, result } = applyReviewed(root, emptyManifest());
    expect(expected.count).toBe(2);
    expect(plan.counts.wikilinkRewrites).toBe(expected.count);
    expect(result.wikilinkRewriteCount).toBe(expected.count);
    const after = fs.readFileSync(notePath(root, other), "utf8");
    expect(after).toBe(expected.text);
    expect(after).toContain(`[[${newId}]]`);
    expect(after).toContain(`[[label|${newId}#anchor]]`);
    expect(after).toContain(`[[${rel}.child]]`);
  });

  it("moved notes re-parse and archived is reported from the filesystem", () => {
    const a = "backlog.zzfx.mv-a";
    const b = "backlog.zzfx.mv-b";
    const root = makeGitVault({
      notes: { [a]: story(a, { phase: "released" }), [b]: story(b, { phase: "integrated" }) },
    });
    const { result } = applyReviewed(root, emptyManifest());
    expect(result.archived.length).toBe(2);
    for (const entry of result.archived) {
      expect(entry.archived).toBe(true);
      expect(entry.reparsed).toBe(true);
      expect(fs.existsSync(notePath(root, entry.from))).toBe(false);
      expect(fs.existsSync(notePath(root, entry.to))).toBe(true);
      expect(readData(root, entry.to).id).toBe(entry.to);
    }
  });

  it("untouched keys and body are byte-preserved", () => {
    const name = "backlog.zzfx.preserve";
    const raw =
      "---\n" +
      `id: ${name}\n` +
      "title: >-\n  A folded\n  title\n" +
      "status: not-implemented\n" +
      "retrieved: 2026-09-29\n" +
      "targetFiles:\n  - path: src/a.mjs\n    op: edit\n" +
      "phase: released\n" +
      "releasedIn: '0.80.0'\n" +
      "---\n\n# Heading\n\n  indented body line\n\ntrailing\n";
    const root = makeGitVault({ notes: { [name]: raw } });
    const { plan } = applyReviewed(root, emptyManifest());
    const mv = moveFor(plan, name);
    const after = fs.readFileSync(notePath(root, mv.to), "utf8");
    const s0 = splitNoteFrontmatter(raw);
    const s1 = splitNoteFrontmatter(after);
    expect(s1.body).toBe(s0.body);
    const b0 = keyBlocks(s0.frontmatter);
    const b1 = keyBlocks(s1.frontmatter);
    const setKeys = new Set(Object.keys(mv.updates));
    for (const [k, v] of b0) {
      if (setKeys.has(k)) continue;
      expect(b1.get(k), k).toBe(v);
    }
  });

  it("existing z_archive id mismatches are listed and fixed only with flag", () => {
    const name = "z_archive.backlog.zzfx.legacy";
    const root = makeGitVault({ notes: { [name]: story("backlog.zzfx.legacy", { phase: "draft", status: "superseded" }) } });
    const before = fs.readFileSync(notePath(root, name), "utf8");
    const { plan } = applyReviewed(root, emptyManifest());
    expect(plan.existingArchiveIdMismatches).toEqual([{ file: name, id: "backlog.zzfx.legacy" }]);
    expect(fs.readFileSync(notePath(root, name), "utf8")).toBe(before);

    const { result } = applyReviewed(root, emptyManifest(), { fixExistingArchiveIds: true });
    expect(result.idFixes).toEqual([name]);
    expect(readData(root, name).id).toBe(name);
  });

  it("singleton note no longer claims z_archive is inside backlog", () => {
    const id = "backlog.fix.singleton-rule-false-parallel-research-premise";
    const candidates = [id, destinationFor(id, "z_implemented")].map((n) => path.join(REPO_ROOT, "notes", n + MD));
    const found = candidates.find((p) => fs.existsSync(p));
    expect(found, candidates.join(" | ")).toBeDefined();
    const text = fs.readFileSync(found, "utf8");
    expect(text).not.toContain("is INSIDE `backlog.*`");
    expect(text).toContain("is OUTSIDE `backlog.*`");
  });

  it("real manifest parses and resolves the two stalled stories", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts", "backlog-archive-manifest.json"), "utf8"));
    expect(Array.isArray(manifest.doneInCode)).toBe(true);
    expect(Array.isArray(manifest.archive)).toBe(true);
    expect(Array.isArray(manifest.held)).toBe(true);
    for (const e of manifest.doneInCode) {
      expect(Array.isArray(e.evidence) && e.evidence.length > 0, e.id).toBe(true);
    }
    for (const id of ["backlog.feat.public-library-pass1", "backlog.feat.readme-public-launch-update"]) {
      const done = manifest.doneInCode.find((e) => e.id === id);
      const held = manifest.held.find((e) => e.id === id);
      const ok = (done && done.evidence.length > 0) || (held && typeof held.reason === "string" && held.reason.trim() !== "");
      expect(Boolean(ok), id).toBe(true);
    }
  });

  it("decision_reference holds z_archive destinations only", () => {
    const toArchive = "backlog.zzfx.decided-superseded";
    const by = "backlog.zzfx.decided-winner";
    const toImpl = "backlog.zzfx.decided-released";
    const decision = "decision.zzfx-record";
    const root = makeVault({
      notes: {
        [toArchive]: story(toArchive, { phase: "ready" }),
        [by]: story(by, { phase: "draft" }),
        [toImpl]: story(toImpl, { phase: "released" }),
        [decision]: noteText({ id: decision }, `\n\nLine two.\n${toArchive} is closed as superseded.\n${toImpl} shipped.\n`),
      },
    });
    const manifest = emptyManifest({ archive: [{ id: toArchive, kind: "superseded", supersededBy: by, reason: "x" }] });
    const plan = planSweep({ projectRoot: root, manifest });
    const h = heldFor(plan, toArchive);
    expect(h.reason).toBe("decision_reference");
    expect(h.refs).toEqual([{ file: `notes/${decision}${MD}`, line: 6 }]);
    expect(moveFor(plan, toImpl)).toBeDefined();
  });

  it("doneInCode entry at phase released is handled as cohort A and reported as overlap", () => {
    const name = "backlog.zzfx.overlap";
    const root = makeVault({
      notes: { [name]: story(name, { phase: "released" }) },
      files: { "src/x.mjs": "zzfx literal\n" },
    });
    const manifest = emptyManifest({ doneInCode: [{ id: name, evidence: [{ file: "src/x.mjs", literal: "zzfx literal" }] }] });
    const plan = planSweep({ projectRoot: root, manifest });
    const mv = moveFor(plan, name);
    expect(mv.cohort).toBe("A");
    expect(mv.updates.archiveCohort).toBe("released");
    expect(mv.updates.phase).toBeUndefined();
    expect(plan.counts.cohorts.A).toBe(1);
    expect(plan.counts.cohorts.B).toBe(0);
    expect(plan.overlaps).toEqual([{ id: name, list: "doneInCode", cohort: "A" }]);
  });

  it("explicit archive entry overrides no_children hold for a decomposed note", () => {
    const name = "backlog.zzfx.hand-split";
    const by = "backlog.zzfx.hand-split-replacement";
    const root = makeGitVault({
      notes: { [name]: story(name, { phase: "decomposed" }), [by]: story(by, { phase: "draft" }) },
    });
    const manifest = emptyManifest({ archive: [{ id: name, kind: "superseded", supersededBy: by, reason: "split by hand" }] });
    const { plan } = applyReviewed(root, manifest);
    expect(heldFor(plan, name)).toBeUndefined();
    const dest = destinationFor(name, "z_archive");
    const d = readData(root, dest);
    expect(d.status).toBe("superseded");
    expect(d.archiveCohort).toBe("superseded");
    expect(d.phase).toBe("decomposed");
  });

  it("released_in_reference holds z_archive destinations only", () => {
    const toArchive = "backlog.zzfx.rel-in-wontdo";
    const toImpl = "backlog.zzfx.rel-in-released";
    const root = makeGitVault({
      notes: {
        [toArchive]: story(toArchive, { phase: "draft", releasedIn: "0.86.0" }),
        [toImpl]: story(toImpl, { phase: "released", releasedIn: "0.86.0" }),
      },
    });
    const before = fs.readFileSync(notePath(root, toArchive), "utf8");
    const manifest = emptyManifest({ archive: [{ id: toArchive, kind: "wont-do", reason: "x" }] });
    const { plan } = applyReviewed(root, manifest);
    const h = heldFor(plan, toArchive);
    expect(h.reason).toBe("released_in_reference");
    expect(h.detail).toContain("0.86.0");
    expect(fs.readFileSync(notePath(root, toArchive), "utf8")).toBe(before);
    const d = readData(root, destinationFor(toImpl, "z_implemented"));
    expect(d.releasedIn).toBe("0.86.0");
  });
  // -------------------------------------------------------------------------------------------
  // backlog.chore.backlog-sweep-clear-mechanical-holds
  // -------------------------------------------------------------------------------------------

  it("dry run lists holds cleared by reviewed manifest lists with cohort, destination and evidence and writes nothing", () => {
    const tr = "backlog.zzfx.cl-tr";
    const fmParent = "backlog.zzfx.cl-fm-parent";
    const fmKidArchived = "backlog.zzfx.cl-fm-kid-a";
    const fmKidLive = "backlog.zzfx.cl-fm-kid-b";
    const bodyParent = "backlog.zzfx.cl-body-parent";
    const bodyKid = "backlog.zzfx.cl-body-kid";
    const decOld = "backlog.zzfx.cl-dec-old";
    const decNew = "backlog.zzfx.cl-dec-new";
    const record = "decision.zzfx-cl-record";
    const dupLive = "backlog.zzfx.cl-dup";
    const dupSurvivor = destinationFor(dupLive, "z_implemented");
    const testLine = `const NAMES = ["${tr}${MD}"];`;
    const dupText = story(dupLive, { phase: "released", releasedIn: "0.1.0" });
    const root = makeVault({
      notes: {
        [tr]: story(tr, { phase: "released" }),
        [fmParent]: story(fmParent, { phase: "decomposed", childStories: [fmKidArchived, fmKidLive] }),
        [destinationFor(fmKidArchived, "z_implemented")]: story(destinationFor(fmKidArchived, "z_implemented"), { phase: "released" }),
        [fmKidLive]: story(fmKidLive, { phase: "released" }),
        [bodyParent]: story(bodyParent, { phase: "decomposed" }, `\n\nSplit into ${bodyKid}.\n`),
        [destinationFor(bodyKid, "z_implemented")]: story(destinationFor(bodyKid, "z_implemented"), { phase: "released" }),
        [decOld]: story(decOld, { phase: "ready" }),
        [decNew]: story(decNew, { phase: "draft" }),
        [record]: noteText({ id: record }, `\n\n${decOld} is closed as superseded.\n`),
        [dupLive]: dupText,
        [dupSurvivor]: story(dupSurvivor, { phase: "executed", status: "implemented" }),
      },
      files: {
        "tests/unit/fx-data.test.mjs": `// fixture\n${testLine}\n`,
        "tests/unit/docs/fx-record.test.mjs": 'const P = "z_archive.backlog.";\n',
      },
    });
    const manifest = emptyManifest({
      archive: [{ id: decOld, kind: "superseded", supersededBy: decNew, reason: "x" }],
      testReferences: [{ id: tr, file: "tests/unit/fx-data.test.mjs", line: 2, text: `"${tr}${MD}"`, use: "data" }],
      decomposedChildren: [{ id: bodyParent, children: [bodyKid] }],
      decisionTestsAcceptArchive: [{ record, test: "tests/unit/docs/fx-record.test.mjs", literal: "z_archive.backlog." }],
      duplicates: [{ live: dupLive, survivor: dupSurvivor, sha256: sha256(dupText) }],
    });
    const before = snapshot(root);
    const plan = planSweep({ projectRoot: root, manifest });
    expectSnapshotsEqual(before, snapshot(root));

    const mTr = moveFor(plan, tr);
    expect(mTr).toMatchObject({ cohort: "A", to: destinationFor(tr, "z_implemented") });
    expect(mTr.clearedBy.testReferences).toEqual([{ file: "tests/unit/fx-data.test.mjs", line: 2, text: `"${tr}${MD}"`, use: "data" }]);

    const mFm = moveFor(plan, fmParent);
    expect(mFm).toMatchObject({ cohort: "C3", to: destinationFor(fmParent, "z_implemented") });
    expect(mFm.clearedBy.children).toEqual(
      expect.arrayContaining([
        { id: fmKidArchived, resolved: destinationFor(fmKidArchived, "z_implemented"), shipped: true, source: "childStories" },
        { id: fmKidLive, resolved: fmKidLive, shipped: true, source: "childStories" },
      ]),
    );

    const mBody = moveFor(plan, bodyParent);
    expect(mBody).toMatchObject({ cohort: "C3", to: destinationFor(bodyParent, "z_implemented") });
    expect(mBody.clearedBy.children).toEqual([{ id: bodyKid, resolved: destinationFor(bodyKid, "z_implemented"), shipped: true, source: "decomposedChildren" }]);

    const mDec = moveFor(plan, decOld);
    expect(mDec).toMatchObject({ cohort: "C1", to: destinationFor(decOld, "z_archive") });
    expect(mDec.clearedBy.decisionTestsAcceptArchive).toEqual([{ record, test: "tests/unit/docs/fx-record.test.mjs", literal: "z_archive.backlog." }]);

    expect(moveFor(plan, dupLive)).toBeUndefined();
    expect(heldFor(plan, dupLive)).toBeUndefined();
    expect(plan.duplicatesResolved).toEqual([
      expect.objectContaining({ live: dupLive, survivor: dupSurvivor, sha256: sha256(dupText), identical: false, phaseKept: "released", releasedInKept: "0.1.0" }),
    ]);
    expect(plan.duplicatesResolved[0].differingKeys).toEqual(expect.arrayContaining(["id", "phase", "releasedIn"]));
    expectSnapshotsEqual(before, snapshot(root));
  });

  it("new manifest lists enter the digest and a stale expectDigest is refused", () => {
    const tr = "backlog.zzfx.dg-tr";
    const bodyParent = "backlog.zzfx.dg-body-parent";
    const bodyKid = "backlog.zzfx.dg-body-kid";
    const decOld = "backlog.zzfx.dg-dec-old";
    const decNew = "backlog.zzfx.dg-dec-new";
    const record = "decision.zzfx-dg-record";
    const dupLive = "backlog.zzfx.dg-dup";
    const dupSurvivor = destinationFor(dupLive, "z_implemented");
    const dupText = story(dupLive, { phase: "released", releasedIn: "0.3.0" });
    const root = makeGitVault({
      notes: {
        [tr]: story(tr, { phase: "released" }),
        [bodyParent]: story(bodyParent, { phase: "decomposed" }, `\n\nSplit into ${bodyKid}.\n`),
        [destinationFor(bodyKid, "z_implemented")]: story(destinationFor(bodyKid, "z_implemented"), { phase: "released" }),
        [decOld]: story(decOld, { phase: "ready" }),
        [decNew]: story(decNew, { phase: "draft" }),
        [record]: noteText({ id: record }, `\n\n${decOld} is closed as superseded.\n`),
        [dupLive]: dupText,
        [dupSurvivor]: story(dupSurvivor, { phase: "executed" }),
      },
      files: {
        "tests/unit/fx-data.test.mjs": `const NAMES = ["${tr}${MD}"];\n`,
        "tests/unit/docs/fx-record.test.mjs": 'const P = "z_archive.backlog.";\n',
      },
    });
    const base = emptyManifest({ archive: [{ id: decOld, kind: "superseded", supersededBy: decNew, reason: "x" }] });
    const additions = {
      testReferences: { id: tr, file: "tests/unit/fx-data.test.mjs", line: 1, text: `"${tr}${MD}"`, use: "data" },
      duplicates: { live: dupLive, survivor: dupSurvivor, sha256: sha256(dupText) },
      decomposedChildren: { id: bodyParent, children: [bodyKid] },
      decisionTestsAcceptArchive: { record, test: "tests/unit/docs/fx-record.test.mjs", literal: "z_archive.backlog." },
    };
    const before = snapshot(root);
    const basePlan = planSweep({ projectRoot: root, manifest: base });
    expect(basePlan.duplicatesResolved).toEqual([]);
    for (const [list, entry] of Object.entries(additions)) {
      const withEntry = { ...base, [list]: [entry] };
      const plan = planSweep({ projectRoot: root, manifest: withEntry });
      expect(plan.digest, list).not.toBe(basePlan.digest);
      if (list === "duplicates") {
        expect(plan.duplicatesResolved.length).toBe(1);
        expect(plan.counts.duplicatesResolved).toBe(1);
      }
      const res = applySweep({ projectRoot: root, manifest: withEntry, expectDigest: basePlan.digest });
      expect(res.ok, list).toBe(false);
      expect(res.reason, list).toBe("digest_mismatch");
      expectSnapshotsEqual(before, snapshot(root));
    }
  });

  it("listed test reference with matching text clears test_reference", () => {
    const name = "backlog.zzfx.tr-listed";
    const root = makeGitVault({
      notes: { [name]: story(name, { phase: "released" }) },
      files: { "tests/unit/fx-comment.test.mjs": `// header\n// see notes/${name}${MD} for the requirements\n` },
    });
    const manifest = emptyManifest({ testReferences: [{ id: name, file: "tests/unit/fx-comment.test.mjs", line: 2, text: `notes/${name}${MD}`, use: "comment" }] });
    const { plan } = applyReviewed(root, manifest);
    expect(heldFor(plan, name)).toBeUndefined();
    const mv = moveFor(plan, name);
    expect(mv.cohort).toBe("A");
    expect(mv.to).toBe(destinationFor(name, "z_implemented"));
    expect(fs.existsSync(notePath(root, name))).toBe(false);
    expect(fs.existsSync(notePath(root, mv.to))).toBe(true);
  });

  it("unlisted test reference still holds test_reference", () => {
    const listed = "backlog.zzfx.tr-one";
    const unlisted = "backlog.zzfx.tr-two";
    const root = makeVault({
      notes: { [listed]: story(listed, { phase: "released" }), [unlisted]: story(unlisted, { phase: "released" }) },
      files: { "tests/unit/fx-two.test.mjs": `const A = "${listed}${MD}";\nconst B = "${unlisted}${MD}";\n` },
    });
    const manifest = emptyManifest({ testReferences: [{ id: listed, file: "tests/unit/fx-two.test.mjs", line: 1, text: `"${listed}${MD}"`, use: "data" }] });
    const plan = planSweep({ projectRoot: root, manifest });
    expect(moveFor(plan, listed)).toBeDefined();
    const h = heldFor(plan, unlisted);
    expect(h.reason).toBe("test_reference");
    expect(h.refs).toEqual([{ file: "tests/unit/fx-two.test.mjs", line: 2 }]);
  });

  it("listed test reference whose line no longer contains its text still holds test_reference", () => {
    const name = "backlog.zzfx.tr-stale";
    const root = makeVault({
      notes: { [name]: story(name, { phase: "released" }) },
      files: { "tests/unit/fx-stale.test.mjs": `const P = fs.readFileSync("notes/${name}${MD}");\n` },
    });
    const manifest = emptyManifest({ testReferences: [{ id: name, file: "tests/unit/fx-stale.test.mjs", line: 1, text: `// comment naming ${name}${MD}`, use: "comment" }] });
    const plan = planSweep({ projectRoot: root, manifest });
    expect(moveFor(plan, name)).toBeUndefined();
    expect(heldFor(plan, name).reason).toBe("test_reference");
    // A listed entry at the wrong line does not clear it either.
    const wrongLine = emptyManifest({ testReferences: [{ id: name, file: "tests/unit/fx-stale.test.mjs", line: 2, text: `"notes/${name}${MD}"`, use: "data" }] });
    expect(heldFor(planSweep({ projectRoot: root, manifest: wrongLine }), name).reason).toBe("test_reference");
  });

  it("listed duplicate pair with matching sha256 removes the live copy and keeps furthest phase and releasedIn", () => {
    const live = "backlog.zzfx.dup-ok";
    const survivor = destinationFor(live, "z_implemented");
    const liveText = story(live, { phase: "released", releasedIn: "0.2.0" });
    const linker = "backlog.zzfx.dup-linker";
    const root = makeGitVault({
      notes: {
        [live]: liveText,
        [survivor]: story(survivor, { phase: "executed", status: "implemented" }),
        [linker]: story(linker, { phase: "draft" }, `\n\nSee [[${live}]].\n`),
      },
    });
    const manifest = emptyManifest({ duplicates: [{ live, survivor, sha256: sha256(liveText) }] });
    const { plan, result } = applyReviewed(root, manifest);
    expect(plan.duplicatesResolved.map((d) => d.live)).toEqual([live]);
    expect(fs.existsSync(notePath(root, live))).toBe(false);
    const d = readData(root, survivor);
    expect(d.phase).toBe("released");
    expect(d.releasedIn).toBe("0.2.0");
    expect(d.status).toBe("implemented");
    expect(result.duplicatesRemoved).toEqual([{ live, survivor, removed: true }]);
    expect(fs.readFileSync(notePath(root, linker), "utf8")).toContain(`[[${survivor}]]`);

    // The survivor already carries the further phase and its own releasedIn: both are kept.
    const live2 = "backlog.zzfx.dup-ok2";
    const survivor2 = destinationFor(live2, "z_implemented");
    const live2Text = story(live2, { phase: "planned" });
    const root2 = makeGitVault({
      notes: { [live2]: live2Text, [survivor2]: story(survivor2, { phase: "released", releasedIn: "0.9.0" }) },
    });
    const m2 = emptyManifest({ doneInCode: [], duplicates: [{ live: live2, survivor: survivor2, sha256: sha256(live2Text) }] });
    // planned is not a shipped phase, so the live copy needs a done-in-code entry to be proposed.
    writeFile(path.join(root2, "src/x.mjs"), "zzfx evidence\n");
    git(root2, ["add", "-A"]);
    git(root2, ["commit", "-q", "-m", "evidence"]);
    m2.doneInCode.push({ id: live2, evidence: [{ file: "src/x.mjs", literal: "zzfx evidence" }] });
    applyReviewed(root2, m2);
    expect(fs.existsSync(notePath(root2, live2))).toBe(false);
    const d2 = readData(root2, survivor2);
    expect(d2.phase).toBe("released");
    expect(d2.releasedIn).toBe("0.9.0");
  });

  it("listed duplicate pair with mismatched sha256 stays held target_exists", () => {
    const live = "backlog.zzfx.dup-bad";
    const survivor = destinationFor(live, "z_implemented");
    const root = makeGitVault({
      notes: { [live]: story(live, { phase: "released", releasedIn: "0.2.0" }), [survivor]: story(survivor, { phase: "executed" }) },
    });
    const manifest = emptyManifest({ duplicates: [{ live, survivor, sha256: "0".repeat(64) }] });
    const before = snapshot(root);
    const { plan } = applyReviewed(root, manifest);
    const h = heldFor(plan, live);
    expect(h.reason).toBe("target_exists");
    expect(h.pair).toMatchObject({ live, survivor, identical: false });
    expect(h.pair.differingKeys).toEqual(expect.arrayContaining(["id", "phase", "releasedIn"]));
    expect(plan.duplicatesResolved).toEqual([]);
    expectSnapshotsEqual(before, snapshot(root));
  });

  it("decomposed parent with all childStories shipped moves with decomposedInto", () => {
    const parent = "backlog.zzfx.cs-parent";
    const kidArchived = "backlog.zzfx.cs-kid-1";
    const kidReleased = "backlog.zzfx.cs-kid-2";
    const root = makeGitVault({
      notes: {
        [parent]: story(parent, { phase: "decomposed", childStories: [kidArchived, kidReleased] }),
        [destinationFor(kidArchived, "z_implemented")]: story(destinationFor(kidArchived, "z_implemented"), { phase: "released" }),
        [kidReleased]: story(kidReleased, { phase: "released" }),
      },
    });
    const { plan } = applyReviewed(root, emptyManifest());
    expect(moveFor(plan, parent).cohort).toBe("C3");
    const d = readData(root, destinationFor(parent, "z_implemented"));
    expect(d.status).toBe("implemented");
    expect(d.phase).toBe("decomposed");
    expect([...d.decomposedInto].sort()).toEqual([destinationFor(kidArchived, "z_implemented"), destinationFor(kidReleased, "z_implemented")].sort());
  });

  it("decomposed parent with an unshipped childStories child is held children_not_shipped", () => {
    const parent = "backlog.zzfx.cs-held";
    const shipped = "backlog.zzfx.cs-held-kid-1";
    const unshipped = "backlog.zzfx.cs-held-kid-2";
    const missing = "backlog.zzfx.cs-held-kid-missing";
    const root = makeVault({
      notes: {
        [parent]: story(parent, { phase: "decomposed", childStories: [shipped, unshipped] }),
        [destinationFor(shipped, "z_implemented")]: story(destinationFor(shipped, "z_implemented"), { phase: "released" }),
        [unshipped]: story(unshipped, { phase: "ready" }),
        ["backlog.zzfx.cs-missing-parent"]: story("backlog.zzfx.cs-missing-parent", { phase: "decomposed", childStories: [missing] }),
      },
    });
    const plan = planSweep({ projectRoot: root, manifest: emptyManifest() });
    const h = heldFor(plan, parent);
    expect(h.reason).toBe("children_not_shipped");
    expect(h.detail).toContain(unshipped);
    expect(moveFor(plan, parent)).toBeUndefined();
    const h2 = heldFor(plan, "backlog.zzfx.cs-missing-parent");
    expect(h2.reason).toBe("children_not_shipped");
    expect(h2.detail).toContain(missing);
  });

  it("body-only children move only through a decomposedChildren entry", () => {
    const parent = "backlog.zzfx.bo-parent";
    const kid1 = "backlog.zzfx.bo-kid-1";
    const kid2 = "backlog.zzfx.bo-kid-2";
    const notes = {
      [parent]: story(parent, { phase: "decomposed" }, `\n\n| 1 | \`${kid1}\` |\n| 2 | \`${kid2}\` |\n`),
      [destinationFor(kid1, "z_implemented")]: story(destinationFor(kid1, "z_implemented"), { phase: "released" }),
      [destinationFor(kid2, "z_implemented")]: story(destinationFor(kid2, "z_implemented"), { phase: "released" }),
    };
    const root = makeGitVault({ notes });
    expect(heldFor(planSweep({ projectRoot: root, manifest: emptyManifest() }), parent).reason).toBe("no_children");

    const unresolved = emptyManifest({ decomposedChildren: [{ id: parent, children: [kid1, "backlog.zzfx.bo-kid-absent"] }] });
    expect(heldFor(planSweep({ projectRoot: root, manifest: unresolved }), parent).reason).toBe("children_not_shipped");

    const notInBody = emptyManifest({ decomposedChildren: [{ id: parent, children: [kid1, kid2, "backlog.zzfx.bo-kid-1x"] }] });
    expect(moveFor(planSweep({ projectRoot: root, manifest: notInBody }), parent)).toBeUndefined();

    const listed = emptyManifest({ decomposedChildren: [{ id: parent, children: [kid1, kid2] }] });
    const { plan } = applyReviewed(root, listed);
    expect(moveFor(plan, parent).cohort).toBe("C3");
    const d = readData(root, destinationFor(parent, "z_implemented"));
    expect([...d.decomposedInto].sort()).toEqual([destinationFor(kid1, "z_implemented"), destinationFor(kid2, "z_implemented")].sort());

    // A listed child that is not shipped keeps the parent held.
    const root2 = makeVault({ notes: { ...notes, [destinationFor(kid2, "z_implemented")]: undefined, [kid2]: story(kid2, { phase: "draft" }) } });
    expect(heldFor(planSweep({ projectRoot: root2, manifest: listed }), parent).reason).toBe("children_not_shipped");
  });

  it("decision_reference skips a z_archive proposal when every citing record has a decisionTestsAcceptArchive entry", () => {
    const old = "backlog.zzfx.dr-old";
    const by = "backlog.zzfx.dr-new";
    const recA = "decision.zzfx-dr-a";
    const recB = "decision.zzfx-dr-b";
    const root = makeGitVault({
      notes: {
        [old]: story(old, { phase: "ready" }),
        [by]: story(by, { phase: "draft" }),
        [recA]: noteText({ id: recA }, `\n\n${old} superseded.\n`),
        [recB]: noteText({ id: recB }, `\n\nAlso ${old}.\n`),
      },
      files: {
        "tests/unit/docs/fx-a.test.mjs": 'const A = "z_archive.backlog.";\n',
        "tests/unit/docs/fx-b.test.mjs": 'const B = `z_archive.backlog.${rest}`;\n',
      },
    });
    const manifest = emptyManifest({
      archive: [{ id: old, kind: "superseded", supersededBy: by, reason: "x" }],
      decisionTestsAcceptArchive: [
        { record: recA, test: "tests/unit/docs/fx-a.test.mjs", literal: "z_archive.backlog." },
        { record: recB, test: "tests/unit/docs/fx-b.test.mjs", literal: "z_archive.backlog." },
      ],
    });
    const { plan } = applyReviewed(root, manifest);
    expect(heldFor(plan, old)).toBeUndefined();
    const mv = moveFor(plan, old);
    expect(mv.cohort).toBe("C1");
    expect(mv.to).toBe(destinationFor(old, "z_archive"));
    expect(fs.existsSync(notePath(root, destinationFor(old, "z_archive")))).toBe(true);
  });

  it("decision_reference holds when a citing record has no decisionTestsAcceptArchive entry", () => {
    const old = "backlog.zzfx.dr-half";
    const by = "backlog.zzfx.dr-half-new";
    const recA = "decision.zzfx-half-a";
    const recB = "decision.zzfx-half-b";
    const root = makeVault({
      notes: {
        [old]: story(old, { phase: "ready" }),
        [by]: story(by, { phase: "draft" }),
        [recA]: noteText({ id: recA }, `\n\n${old} superseded.\n`),
        [recB]: noteText({ id: recB }, `\n\nAlso ${old}.\n`),
      },
      files: { "tests/unit/docs/fx-a.test.mjs": 'const A = "z_archive.backlog.";\n' },
    });
    const manifest = emptyManifest({
      archive: [{ id: old, kind: "superseded", supersededBy: by, reason: "x" }],
      decisionTestsAcceptArchive: [{ record: recA, test: "tests/unit/docs/fx-a.test.mjs", literal: "z_archive.backlog." }],
    });
    const plan = planSweep({ projectRoot: root, manifest });
    const h = heldFor(plan, old);
    expect(h.reason).toBe("decision_reference");
    expect(h.detail).toContain(recB);
    expect(moveFor(plan, old)).toBeUndefined();
  });

  it("decision_reference holds when the listed test lacks its literal or does not exist", () => {
    const old = "backlog.zzfx.dr-lit";
    const by = "backlog.zzfx.dr-lit-new";
    const rec = "decision.zzfx-lit";
    const root = makeVault({
      notes: {
        [old]: story(old, { phase: "ready" }),
        [by]: story(by, { phase: "draft" }),
        [rec]: noteText({ id: rec }, `\n\n${old} superseded.\n`),
      },
      files: { "tests/unit/docs/fx-lit.test.mjs": 'const A = "backlog.z_implemented.";\n' },
    });
    const archive = [{ id: old, kind: "superseded", supersededBy: by, reason: "x" }];
    const lacks = emptyManifest({ archive, decisionTestsAcceptArchive: [{ record: rec, test: "tests/unit/docs/fx-lit.test.mjs", literal: "z_archive.backlog." }] });
    expect(heldFor(planSweep({ projectRoot: root, manifest: lacks }), old).reason).toBe("decision_reference");
    const absent = emptyManifest({ archive, decisionTestsAcceptArchive: [{ record: rec, test: "tests/unit/docs/fx-nowhere.test.mjs", literal: "z_archive.backlog." }] });
    expect(heldFor(planSweep({ projectRoot: root, manifest: absent }), old).reason).toBe("decision_reference");
  });

  it("manifest without the new lists plans as before", () => {
    const tr = "backlog.zzfx.mb-tr";
    const parent = "backlog.zzfx.mb-parent";
    const old = "backlog.zzfx.mb-old";
    const by = "backlog.zzfx.mb-new";
    const rec = "decision.zzfx-mb";
    const dup = "backlog.zzfx.mb-dup";
    const rel = "backlog.zzfx.mb-rel";
    const root = makeVault({
      notes: {
        [tr]: story(tr, { phase: "released" }),
        [parent]: story(parent, { phase: "decomposed" }, "\n\nChildren: backlog.zzfx.mb-kid.\n"),
        ["backlog.z_implemented.zzfx.mb-kid"]: story("backlog.z_implemented.zzfx.mb-kid", { phase: "released" }),
        [old]: story(old, { phase: "ready" }),
        [by]: story(by, { phase: "draft" }),
        [rec]: noteText({ id: rec }, `\n\n${old}.\n`),
        [dup]: story(dup, { phase: "released" }),
        [destinationFor(dup, "z_implemented")]: story(destinationFor(dup, "z_implemented"), { phase: "executed" }),
        [rel]: story(rel, { phase: "released" }),
      },
      files: { "tests/unit/fx.test.mjs": `const A = "${tr}${MD}";\n`, "tests/unit/docs/fx.test.mjs": 'const A = "z_archive.backlog.";\n' },
    });
    const legacy = { version: 1, doneInCode: [], archive: [{ id: old, kind: "superseded", supersededBy: by, reason: "x" }], held: [] };
    const plan = planSweep({ projectRoot: root, manifest: legacy });
    const explicit = planSweep({
      projectRoot: root,
      manifest: { ...legacy, testReferences: [], duplicates: [], decomposedChildren: [], decisionTestsAcceptArchive: [] },
    });
    expect(explicit).toEqual(plan);
    expect(heldFor(plan, tr).reason).toBe("test_reference");
    expect(heldFor(plan, parent).reason).toBe("no_children");
    expect(heldFor(plan, old).reason).toBe("decision_reference");
    expect(heldFor(plan, dup).reason).toBe("target_exists");
    expect(plan.moves.map((m) => m.from)).toEqual([rel]);
    expect(plan.moves[0].clearedBy).toBeUndefined();
    expect(plan.duplicatesResolved).toEqual([]);
    expect(plan.counts.duplicatesResolved).toBe(0);
    expect(plan.counts.cohorts).toEqual({ A: 1, "A'": 0, B: 0, C1: 0, C2: 0, C3: 0, C4: 0 });
  });

  it("real manifest carries the new lists, decision test entries and 02-extract-prompts doneInCode evidence", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts", "backlog-archive-manifest.json"), "utf8"));
    for (const list of ["testReferences", "duplicates", "decomposedChildren", "decisionTestsAcceptArchive"]) {
      expect(Array.isArray(manifest[list]), list).toBe(true);
    }
    for (const record of ["decision.server-mjs-handler-family-partition", "decision.arch-finding-relations"]) {
      const e = manifest.decisionTestsAcceptArchive.find((x) => x.record === record);
      expect(e, record).toBeDefined();
      const abs = path.join(REPO_ROOT, e.test);
      expect(fs.existsSync(abs), e.test).toBe(true);
      expect(typeof e.literal === "string" && e.literal !== "").toBe(true);
      expect(fs.readFileSync(abs, "utf8")).toContain(e.literal);
    }
    const done = manifest.doneInCode.find((e) => e.id === "backlog.architecture.planner-modularization.02-extract-prompts");
    expect(done).toBeDefined();
    expect(Array.isArray(done.evidence) && done.evidence.length > 0).toBe(true);
    for (const ev of done.evidence) {
      expect(fs.readFileSync(path.join(REPO_ROOT, ev.file), "utf8")).toContain(ev.literal);
    }
  });

  it("story-note tests no longer pin a note filename literal", () => {
    const pins = [
      ["tests/integration/server-handler-governance.test.mjs", "backlog.feat.server-mjs-governance-handler-family"],
      ["tests/unit/llm-supported-providers-truthful.test.mjs", "backlog.fix.llm-provider-inference"],
    ];
    for (const [file, id] of pins) {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      expect(text.includes(`${id}${MD}`), file).toBe(false);
    }
  });

  it("resolved duplicate pair is reported in duplicatesResolved not moves and cohort keys stay the seven", () => {
    const live = "backlog.zzfx.ck-dup";
    const survivor = destinationFor(live, "z_implemented");
    const liveText = story(live, { phase: "released" });
    const root = makeVault({
      notes: { [live]: liveText, [survivor]: story(survivor, { phase: "released" }), ["backlog.zzfx.ck-rel"]: story("backlog.zzfx.ck-rel", { phase: "released" }) },
    });
    const plan = planSweep({ projectRoot: root, manifest: emptyManifest({ duplicates: [{ live, survivor, sha256: sha256(liveText) }] }) });
    expect(plan.duplicatesResolved.map((d) => d.live)).toEqual([live]);
    expect(plan.moves.map((m) => m.from)).not.toContain(live);
    expect(plan.counts.duplicatesResolved).toBe(1);
    expect(Object.keys(plan.counts.cohorts)).toEqual(["A", "A'", "B", "C1", "C2", "C3", "C4"]);
    expect(Object.keys(plan.counts.cohorts)).toEqual(COHORT_KEYS);
  });
});

// ---------------------------------------------------------------------------------------------
// backlog.chore.backlog-sweep-shelve-stale-notes — the shelved cohort S (--cutoff), current-paper
// detection, the user-ruled shelve[] list and supersededBy rewrites. Fixture names stay in the
// backlog.zzfx namespace (papers use a zzfx slug) and every filename is built at run time.
// ---------------------------------------------------------------------------------------------

const CUTOFF = "2026-10-03";
const CUTOFF_MS = Date.UTC(2026, 9, 3);
const OLD = Date.UTC(2026, 0, 10, 12); // before the cutoff
const NEW = Date.UTC(2026, 10, 1, 12); // on or after the cutoff
const SHELVED_BY = "backlog.chore.backlog-sweep-shelve-stale-notes";
const IN_FLIGHT = ["planned", "executing", "executed", "building"];
const RECORD_ID = "decision.backlog-note-disposition";
const RULED = [
  "backlog.agents.orchestration-and-parallelization",
  "backlog.architecture.planner-slim-orchestrator",
  "backlog.architecture.abstract-code-context",
  "backlog.architecture.abstract-target-resolver",
  "backlog.architecture.ci-integration-testing",
];

function oldStory(name, extra = {}, body) {
  return story(name, { phase: "draft", updated: OLD, ...extra }, body);
}

function paper(name, body, extra = {}) {
  return noteText({ id: name, title: `Paper ${name}`, ...extra }, `\n\n# Paper\n\n${body}\n`);
}

function planCut(root, manifest = emptyManifest(), cutoff = CUTOFF) {
  return planSweep({ projectRoot: root, manifest, cutoff });
}

function realManifest() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts", "backlog-archive-manifest.json"), "utf8"));
}

function bodyOf(text) {
  return splitNoteFrontmatter(text).body;
}

describe("backlog-archive-sweep", () => {
  it("cutoff dry run lists an old draft in the shelved cohort with phase, age and destination and writes nothing", () => {
    const name = "backlog.zzfx.sh-old";
    const root = makeVault({ notes: { [name]: oldStory(name) } });
    const before = snapshot(root);
    const plan = planCut(root);
    expectSnapshotsEqual(before, snapshot(root));
    const mv = moveFor(plan, name);
    expect(mv).toBeDefined();
    expect(mv.cohort).toBe("S");
    expect(mv.fromPhase).toBe("draft");
    expect(mv.age).toEqual({ source: "updated", value: OLD });
    expect(mv.to).toBe("z_archive.backlog.zzfx.sh-old");
    expect(mv.to).toBe(destinationFor(name, "z_archive"));
    expect(plan.cutoff).toBe(CUTOFF);
  });

  it("cutoff dry run reports cohort counts, held reason counts and age source counts", () => {
    const root = makeVault({
      notes: {
        "backlog.zzfx.cc-upd": oldStory("backlog.zzfx.cc-upd"),
        "backlog.zzfx.cc-cre": story("backlog.zzfx.cc-cre", { phase: "draft", created: OLD }),
        "backlog.zzfx.cc-new": oldStory("backlog.zzfx.cc-new", { updated: NEW }),
        "backlog.zzfx.cc-aa": oldStory("backlog.zzfx.cc-aa", { phase: "arch-approved" }),
        "backlog.zzfx.cc-rel": story("backlog.zzfx.cc-rel", { phase: "released" }),
      },
    });
    const plan = planCut(root);
    expect(Object.keys(plan.counts.cohorts)).toEqual([...COHORT_KEYS, "S"]);
    expect(plan.counts.cohorts).toEqual({ A: 1, "A'": 0, B: 0, C1: 0, C2: 0, C3: 0, C4: 0, S: 2 });
    expect(plan.counts.held).toEqual({ kept_recent: 1, kept_arch_approved: 1 });
    expect(plan.counts.ageSource).toEqual({ updated: 3, created: 1 });
    const text = formatReport(plan);
    expect(text).toContain("== Moves: cohort S (2) ==");
    expect(text).toMatch(/age source: updated 3, created 1/);
    expect(text).toContain("kept_recent: 1");
  });

  it("note named by a dated current paper is kept and the protecting paper and line are reported", () => {
    const name = "backlog.zzfx.cp-named";
    const pap = "research.2026.11.01.zzfx-current";
    const root = makeVault({ notes: { [name]: oldStory(name), [pap]: paper(pap, `Line one.\n\nKeeps ${name} alive.`) } });
    const plan = planCut(root);
    expect(moveFor(plan, name)).toBeUndefined();
    const h = heldFor(plan, name);
    expect(h.reason).toBe("kept_current_paper");
    const lineNo = fs.readFileSync(notePath(root, pap), "utf8").split("\n").findIndex((l) => l.includes(name)) + 1;
    expect(h.paperRefs).toEqual([{ file: `notes/${pap}${MD}`, line: lineNo }]);
    expect(plan.papers.current.map((p) => p.id)).toContain(pap);
    expect(plan.keptByPaper).toEqual([{ id: name, refs: [{ file: `notes/${pap}${MD}`, line: lineNo }] }]);
    expect(formatReport(plan)).toContain(`notes/${pap}${MD}:${lineNo}`);
  });

  it("note named only by a paper dated before the cutoff is shelved and the paper is reported not current", () => {
    const name = "backlog.zzfx.np-named";
    const res = "research.2026.09.01.zzfx-older";
    const rm = "roadmap.2026.07.10.zzfx-older";
    const root = makeVault({ notes: { [name]: oldStory(name), [res]: paper(res, name), [rm]: paper(rm, name) } });
    const plan = planCut(root);
    expect(moveFor(plan, name).cohort).toBe("S");
    const notCurrent = plan.papers.notCurrent.map((p) => p.id);
    expect(notCurrent).toContain(res);
    expect(notCurrent).toContain(rm);
    expect(plan.papers.current.map((p) => p.id)).not.toContain(res);
    expect(moveFor(plan, name).namedByNotCurrent.map((r) => r.file).sort()).toEqual([`notes/${res}${MD}`, `notes/${rm}${MD}`].sort());
  });

  it("undated paper currency follows its updated against the cutoff", () => {
    const a = "backlog.zzfx.ud-a";
    const b = "backlog.zzfx.ud-b";
    const fresh = "research.zzfx-undated-fresh";
    const stale = "roadmap.zzfx-undated-stale";
    const root = makeVault({
      notes: { [a]: oldStory(a), [b]: oldStory(b), [fresh]: paper(fresh, a, { updated: NEW }), [stale]: paper(stale, b, { updated: OLD }) },
    });
    const plan = planCut(root);
    expect(heldFor(plan, a).reason).toBe("kept_current_paper");
    expect(moveFor(plan, b).cohort).toBe("S");
    expect(plan.papers.current.map((p) => p.id)).toContain(fresh);
    expect(plan.papers.notCurrent.map((p) => p.id)).toContain(stale);
  });

  it("currentPapers entry makes an older paper current and protects the notes it names", () => {
    const name = "backlog.zzfx.cpe-named";
    const rm = "roadmap.2026.07.01.zzfx-ruled";
    const root = makeVault({ notes: { [name]: oldStory(name), [rm]: paper(rm, name) } });
    expect(moveFor(planCut(root), name).cohort).toBe("S");
    const plan = planCut(root, emptyManifest({ currentPapers: [{ id: rm, reason: "user ruled it still current" }] }));
    expect(heldFor(plan, name).reason).toBe("kept_current_paper");
    const cur = plan.papers.current.find((p) => p.id === rm);
    expect(cur).toBeDefined();
    expect(cur.basis).toContain("user ruled it still current");
  });

  it("z_archive paper is never current and protects nothing", () => {
    const name = "backlog.zzfx.za-named";
    const zp = "z_archive.research.2026.11.01.zzfx-archived";
    const root = makeVault({ notes: { [name]: oldStory(name), [zp]: paper(zp, name, { updated: NEW }) } });
    const plan = planCut(root, emptyManifest({ currentPapers: [{ id: zp, reason: "try to force it" }] }));
    expect(moveFor(plan, name).cohort).toBe("S");
    expect(plan.papers.current.map((p) => p.id)).not.toContain(zp);
    expect(plan.papers.notCurrent.map((p) => p.id)).toContain(zp);
  });

  it("arch-approved, released and integrated old notes are not shelved", () => {
    const aa = "backlog.zzfx.ph-aa";
    const rel = "backlog.zzfx.ph-rel";
    const int = "backlog.zzfx.ph-int";
    const root = makeVault({
      notes: { [aa]: oldStory(aa, { phase: "arch-approved" }), [rel]: oldStory(rel, { phase: "released" }), [int]: oldStory(int, { phase: "integrated" }) },
    });
    const plan = planCut(root);
    expect(heldFor(plan, aa).reason).toBe("kept_arch_approved");
    expect(moveFor(plan, rel).cohort).toBe("A");
    expect(moveFor(plan, int).cohort).toBe("A'");
    expect(plan.moves.filter((m) => m.cohort === "S")).toEqual([]);
  });

  it("manifest held entry is not shelved", () => {
    const name = "backlog.zzfx.mh-held";
    const root = makeVault({ notes: { [name]: oldStory(name) } });
    const plan = planCut(root, emptyManifest({ held: [{ id: name, reason: "user keeps it" }] }));
    expect(moveFor(plan, name)).toBeUndefined();
    expect(heldFor(plan, name).reason).toBe("manifest_held");
  });

  it("old note with releasedIn is held not shelved", () => {
    const name = "backlog.zzfx.ri-old";
    const root = makeVault({ notes: { [name]: oldStory(name, { releasedIn: "0.1.0" }) } });
    const plan = planCut(root);
    expect(moveFor(plan, name)).toBeUndefined();
    expect(heldFor(plan, name).reason).toBe("kept_released_in");
  });

  it("age comes from updated and falls back to created", () => {
    const recent = "backlog.zzfx.ag-recent";
    const created = "backlog.zzfx.ag-created";
    const root = makeVault({
      notes: {
        [recent]: story(recent, { phase: "draft", created: OLD, updated: NEW }),
        [created]: story(created, { phase: "draft", created: OLD }),
      },
    });
    const plan = planCut(root);
    expect(heldFor(plan, recent).reason).toBe("kept_recent");
    expect(moveFor(plan, recent)).toBeUndefined();
    const mv = moveFor(plan, created);
    expect(mv.cohort).toBe("S");
    expect(mv.age).toEqual({ source: "created", value: OLD });
  });

  it("unreadable age is held with its own reason", () => {
    const none = "backlog.zzfx.ua-none";
    const bad = "backlog.zzfx.ua-bad";
    const root = makeVault({ notes: { [none]: story(none, { phase: "draft" }), [bad]: story(bad, { phase: "draft", updated: "not-a-time" }) } });
    const plan = planCut(root);
    for (const n of [none, bad]) {
      expect(moveFor(plan, n), n).toBeUndefined();
      expect(heldFor(plan, n).reason, n).toBe("age_unreadable");
    }
  });

  it("quoted ISO datetime updated before the cutoff is shelved with its epoch-millisecond age", () => {
    const name = "backlog.zzfx.iso-dt";
    const root = makeVault({ notes: { [name]: story(name, { phase: "draft", updated: "2026-01-10T12:00:00.000Z" }) } });
    const mv = moveFor(planCut(root), name);
    expect(mv).toBeDefined();
    expect(mv.cohort).toBe("S");
    expect(mv.age).toEqual({ source: "updated", value: Date.UTC(2026, 0, 10, 12) });
  });

  it("quoted date-only updated is read as UTC midnight and one on the cutoff is kept_recent", () => {
    const old = "backlog.zzfx.iso-day-old";
    const onCut = "backlog.zzfx.iso-day-cut";
    const root = makeVault({
      notes: { [old]: story(old, { phase: "draft", updated: "2026-01-10" }), [onCut]: story(onCut, { phase: "draft", updated: CUTOFF }) },
    });
    const plan = planCut(root);
    const mv = moveFor(plan, old);
    expect(mv.cohort).toBe("S");
    expect(mv.age).toEqual({ source: "updated", value: Date.UTC(2026, 0, 10) });
    expect(moveFor(plan, onCut)).toBeUndefined();
    expect(heldFor(plan, onCut).reason).toBe("kept_recent");
  });

  it("ISO datetime with a numeric offset is read as that instant", () => {
    const plus = "backlog.zzfx.iso-plus";
    const minus = "backlog.zzfx.iso-minus";
    const root = makeVault({
      notes: {
        [plus]: story(plus, { phase: "draft", updated: "2026-01-10T12:00:00+02:00" }),
        [minus]: story(minus, { phase: "draft", updated: "2026-01-10T12:00:00-05:00" }),
      },
    });
    const plan = planCut(root);
    expect(moveFor(plan, plus).age).toEqual({ source: "updated", value: Date.UTC(2026, 0, 10, 10) });
    expect(moveFor(plan, minus).age).toEqual({ source: "updated", value: Date.UTC(2026, 0, 10, 17) });
  });

  it("quoted ISO created is the age source when updated is absent", () => {
    const name = "backlog.zzfx.iso-created";
    const root = makeVault({ notes: { [name]: story(name, { phase: "draft", created: "2026-01-10T12:00:00.000Z" }) } });
    const mv = moveFor(planCut(root), name);
    expect(mv.cohort).toBe("S");
    expect(mv.age).toEqual({ source: "created", value: Date.UTC(2026, 0, 10, 12) });
  });

  it("zoneless datetimes, impossible dates and non-dates stay age_unreadable", () => {
    const values = { "iso-zoneless": "2026-01-10T12:00:00", "iso-impossible": "2025-02-30", "iso-nondate": "not-a-time" };
    const notes = {};
    for (const [k, v] of Object.entries(values)) notes[`backlog.zzfx.${k}`] = story(`backlog.zzfx.${k}`, { phase: "draft", updated: v });
    const plan = planCut(makeVault({ notes }));
    for (const id of Object.keys(notes)) {
      expect(moveFor(plan, id), id).toBeUndefined();
      expect(heldFor(plan, id).reason, id).toBe("age_unreadable");
    }
  });

  it("epoch numbers, all-digit strings and unquoted timestamps are read as before", () => {
    const num = "backlog.zzfx.iso-num";
    const digits = "backlog.zzfx.iso-digits";
    const unquoted = "backlog.zzfx.iso-unquoted";
    const unquotedText = `---\nid: ${JSON.stringify(unquoted)}\ntitle: "Fixture"\nstatus: "not-implemented"\nphase: "draft"\nupdated: 2026-01-10T12:00:00.000Z\n---\n\n# Fixture\n\nBody text.\n`;
    const root = makeVault({
      notes: {
        [num]: story(num, { phase: "draft", updated: OLD }),
        [digits]: story(digits, { phase: "draft", updated: String(OLD) }),
        [unquoted]: unquotedText,
      },
    });
    expect(readData(root, unquoted).updated instanceof Date).toBe(true);
    const plan = planCut(root);
    for (const id of [num, digits, unquoted]) expect(moveFor(plan, id).age, id).toEqual({ source: "updated", value: OLD });
  });

  it("reviewed apply of a quoted ISO-dated note records shelvedAge with source and milliseconds", () => {
    const name = "backlog.zzfx.iso-apply";
    const root = makeGitVault({ notes: { [name]: story(name, { phase: "draft", updated: "2026-01-10T12:00:00.000Z" }) } });
    applyReviewed(root, emptyManifest(), { cutoff: CUTOFF });
    const d = readData(root, destinationFor(name, "z_archive"));
    expect(typeof d.shelvedAge).toBe("string");
    expect(d.shelvedAge).toContain("updated");
    expect(d.shelvedAge).toContain(String(Date.UTC(2026, 0, 10, 12)));
  });

  it("planSweep without a cutoff holds quoted ISO-dated notes user_hold and keeps the six cohort keys", () => {
    const dt = "backlog.zzfx.iso-nc-dt";
    const day = "backlog.zzfx.iso-nc-day";
    const root = makeVault({
      notes: { [dt]: story(dt, { phase: "draft", updated: "2026-01-10T12:00:00.000Z" }), [day]: story(day, { phase: "draft", updated: "2026-01-10" }) },
    });
    const plan = planSweep({ projectRoot: root, manifest: emptyManifest() });
    expect(heldFor(plan, dt).reason).toBe("user_hold");
    expect(heldFor(plan, day).reason).toBe("user_hold");
    expect(plan.moves.filter((m) => m.cohort === "S")).toEqual([]);
    expect(Object.keys(plan.counts.cohorts)).toEqual(COHORT_KEYS);
    expect(Object.keys(plan.counts.cohorts)).not.toContain("S");
  });

  it("undated paper currency reads a quoted ISO updated against the cutoff", () => {
    const a = "backlog.zzfx.iso-ud-a";
    const b = "backlog.zzfx.iso-ud-b";
    const fresh = "research.zzfx-iso-undated-fresh";
    const stale = "roadmap.zzfx-iso-undated-stale";
    const root = makeVault({
      notes: {
        [a]: oldStory(a),
        [b]: oldStory(b),
        [fresh]: paper(fresh, a, { updated: CUTOFF }),
        [stale]: paper(stale, b, { updated: "2026-01-10T12:00:00.000Z" }),
      },
    });
    const plan = planCut(root);
    expect(plan.papers.current.map((p) => p.id)).toContain(fresh);
    expect(heldFor(plan, a).reason).toBe("kept_current_paper");
    expect(plan.papers.notCurrent.map((p) => p.id)).toContain(stale);
    expect(moveFor(plan, b).cohort).toBe("S");
  });

  it("in-flight phases with no other exception are shelved in cohort S", () => {
    const notes = {};
    for (const ph of IN_FLIGHT) notes[`backlog.zzfx.if-${ph}`] = oldStory(`backlog.zzfx.if-${ph}`, { phase: ph });
    const root = makeVault({ notes });
    const plan = planCut(root);
    for (const ph of IN_FLIGHT) {
      const id = `backlog.zzfx.if-${ph}`;
      const mv = moveFor(plan, id);
      expect(mv, id).toBeDefined();
      expect(mv.cohort, id).toBe("S");
      expect(mv.fromPhase, id).toBe(ph);
      expect(mv.updates.archivedFromPhase, id).toBe(ph);
      expect(heldFor(plan, id), id).toBeUndefined();
    }
    expect(plan.held.filter((h) => h.reason === "in_flight_review")).toEqual([]);
    expect([...plan.inFlight].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      IN_FLIGHT.map((ph) => ({ id: `backlog.zzfx.if-${ph}`, phase: ph })).sort((a, b) => a.id.localeCompare(b.id)),
    );
    const text = formatReport(plan);
    expect(text).toMatch(new RegExp(`== In-flight notes[^\\n]*\\(${IN_FLIGHT.length}\\)`));
    expect(text).not.toContain("In-flight notes held for review");
  });

  it("old in-flight note with found doneInCode evidence moves in cohort B not S", () => {
    const name = "backlog.zzfx.ifd-executed";
    const root = makeVault({
      notes: { [name]: oldStory(name, { phase: "executed" }) },
      files: { "src/ifd.mjs": 'export const IFD = "zzfx_ifd";\n' },
    });
    const manifest = emptyManifest({ doneInCode: [{ id: name, evidence: [{ file: "src/ifd.mjs", literal: 'IFD = "zzfx_ifd"' }] }] });
    const plan = planCut(root, manifest);
    const mv = moveFor(plan, name);
    expect(mv).toBeDefined();
    expect(mv.cohort).toBe("B");
    expect(mv.to).toBe(destinationFor(name, "z_implemented"));
    expect(mv.to.startsWith("backlog.z_implemented.")).toBe(true);
    expect(plan.moves.filter((m) => m.cohort === "S").map((m) => m.from)).not.toContain(name);
    expect(plan.inFlight.map((h) => h.id)).not.toContain(name);
  });

  it("old in-flight note kept by another exception is held under that reason", () => {
    const recent = "backlog.zzfx.ifk-recent";
    const named = "backlog.zzfx.ifk-named";
    const parent = "backlog.zzfx.ifk-parent";
    const kid = "backlog.zzfx.ifk-parent.kid";
    const pap = "research.2026.11.03.zzfx-ifk";
    const root = makeVault({
      notes: {
        [recent]: oldStory(recent, { phase: "planned", updated: NEW }),
        [named]: oldStory(named, { phase: "executed" }),
        [parent]: oldStory(parent, { phase: "building" }),
        [kid]: oldStory(kid, { updated: NEW }),
        [pap]: paper(pap, `Names ${named}.`),
      },
    });
    const plan = planCut(root);
    for (const [id, reason] of [[recent, "kept_recent"], [named, "kept_current_paper"], [parent, "kept_live_child"]]) {
      expect(moveFor(plan, id), id).toBeUndefined();
      expect(heldFor(plan, id).reason, id).toBe(reason);
    }
    expect(plan.held.filter((h) => h.reason === "in_flight_review")).toEqual([]);
    expect(plan.inFlight).toEqual([]);
  });

  it("reviewed apply shelves to z_archive.backlog with shelved metadata and preserved body", () => {
    const name = "backlog.zzfx.ap-old";
    const other = "backlog.zzfx.ap-other";
    const body = `\n\n# Old idea\n\nSee [[${other}]] and keep   spacing.\n`;
    const root = makeGitVault({ notes: { [name]: oldStory(name, {}, body), [other]: oldStory(other) } });
    const { plan } = applyReviewed(root, emptyManifest(), { cutoff: CUTOFF });
    const dest = destinationFor(name, "z_archive");
    expect(fs.existsSync(notePath(root, name))).toBe(false);
    expect(fs.existsSync(notePath(root, dest))).toBe(true);
    const d = readData(root, dest);
    expect(d.id).toBe(dest);
    expect(d.status).toBe("shelved");
    expect(d.archivedBy).toBe(SHELVED_BY);
    expect(d.archiveCohort).toBe("shelved");
    expect(d.archivedFromPhase).toBe("draft");
    expect(d.shelvedCutoff).toBe(CUTOFF);
    expect(typeof d.shelvedAge).toBe("string");
    expect(d.shelvedAge).toContain("updated");
    expect(d.shelvedAge).toContain(String(OLD));
    expect(d.phase).toBe("draft");
    expect(Object.keys(moveFor(plan, name).updates)).not.toContain("phase");
    const map = new Map(plan.moves.map((m) => [m.from, m.to]));
    expect(bodyOf(fs.readFileSync(notePath(root, dest), "utf8"))).toBe(rewriteWikilinks(body, map).text);
  });

  it("shelved cohort never targets backlog.z_implemented", () => {
    const root = makeVault({
      notes: {
        "backlog.zzfx.nz-a": oldStory("backlog.zzfx.nz-a"),
        "backlog.zzfx.nz-b": story("backlog.zzfx.nz-b", { created: OLD }),
        "backlog.zzfx.nz-c": oldStory("backlog.zzfx.nz-c", { phase: "ready" }),
      },
    });
    const plan = planCut(root);
    const s = plan.moves.filter((m) => m.cohort === "S");
    expect(s.length).toBe(3);
    for (const m of s) {
      expect(m.to.startsWith("backlog.z_implemented.")).toBe(false);
      expect(m.to.startsWith("z_archive.backlog.")).toBe(true);
    }
  });

  it("cutoff and currentPapers enter the digest and a different cutoff is refused", () => {
    const name = "backlog.zzfx.dg-old";
    const rm = "roadmap.2026.01.01.zzfx-dg";
    const root = makeGitVault({ notes: { [name]: oldStory(name), [rm]: paper(rm, "nothing named") } });
    const a = planCut(root);
    const b = planCut(root, emptyManifest(), "2026-09-01");
    expect(a.digest).not.toBe(b.digest);
    const c = planCut(root, emptyManifest({ currentPapers: [{ id: rm, reason: "ruled current" }] }));
    expect(c.digest).not.toBe(a.digest);
    const before = snapshot(root);
    const res = applySweep({ projectRoot: root, manifest: emptyManifest(), expectDigest: a.digest, cutoff: "2026-09-01" });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("digest_mismatch");
    expectSnapshotsEqual(before, snapshot(root));
  });

  it("apply without a cutoff against a cutoff dry run refuses", () => {
    const name = "backlog.zzfx.nc-old";
    const root = makeGitVault({ notes: { [name]: oldStory(name) } });
    const plan = planCut(root);
    const before = snapshot(root);
    const res = applySweep({ projectRoot: root, manifest: emptyManifest(), expectDigest: plan.digest });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("digest_mismatch");
    expectSnapshotsEqual(before, snapshot(root));
  });

  it("planSweep without a cutoff plans as before", () => {
    const dated = "backlog.zzfx.pb-dated";
    const undated = "backlog.zzfx.pb-undated";
    const planned = "backlog.zzfx.pb-planned";
    const root = makeVault({ notes: { [dated]: oldStory(dated), [undated]: story(undated, { phase: "draft" }), [planned]: oldStory(planned, { phase: "planned" }) } });
    const plan = planSweep({ projectRoot: root, manifest: emptyManifest() });
    expect(plan.moves.filter((m) => m.cohort === "S")).toEqual([]);
    expect(heldFor(plan, dated).reason).toBe("user_hold");
    expect(heldFor(plan, undated).reason).toBe("user_hold");
    expect(heldFor(plan, planned).reason).toBe("user_hold");
    expect(Object.keys(plan.counts.cohorts)).toEqual(COHORT_KEYS);
    expect(Object.keys(plan.counts.cohorts)).not.toContain("S");
    expect(COHORT_KEYS).toEqual(["A", "A'", "B", "C1", "C2", "C3", "C4"]);
    expect(formatReport(plan)).not.toContain("cohort S");
  });

  it("existing guards hold shelve proposals", () => {
    const twin = "backlog.zzfx.eg-twin";
    const readme = "backlog.zzfx.eg-readme";
    const root = makeVault({
      notes: { [twin]: oldStory(twin), [destinationFor(twin, "z_archive")]: story(destinationFor(twin, "z_archive"), { status: "shelved" }), [readme]: oldStory(readme) },
      files: { "README.md": `# Fixture\n\nSee ${readme}.\n` },
    });
    const plan = planCut(root);
    expect(heldFor(plan, twin).reason).toBe("target_exists");
    expect(heldFor(plan, twin).cohort).toBe("S");
    expect(heldFor(plan, readme).reason).toBe("readme_reference");
  });

  // backlog.chore.backlog-sweep-residual-mechanical-holds: a shelve (cohort S) proposal whose only
  // existing destination is its z_implemented twin may resolve through a reviewed duplicates entry.
  it("cutoff dry run resolves a shelve proposal against its z_implemented twin through a reviewed duplicates entry", () => {
    const live = "backlog.zzfx.sd-ok";
    const survivor = destinationFor(live, "z_implemented");
    const liveText = oldStory(live, { phase: "planned" });
    const root = makeVault({ notes: { [live]: liveText, [survivor]: story(survivor, { phase: "executed", status: "implemented" }) } });
    const before = snapshot(root);
    const plan = planCut(root, emptyManifest({ duplicates: [{ live, survivor, sha256: sha256(liveText), reason: "same story" }] }));
    expectSnapshotsEqual(before, snapshot(root));
    expect(plan.duplicatesResolved.map((d) => d.live)).toEqual([live]);
    const d = plan.duplicatesResolved[0];
    expect(d.cohort).toBe("S");
    expect(d.survivor).toBe(survivor);
    expect(d.sha256).toBe(sha256(liveText));
    expect(moveFor(plan, live)).toBeUndefined();
    expect(heldFor(plan, live)).toBeUndefined();
    expect(plan.counts.duplicatesResolved).toBe(1);
    // Without the cutoff the note is not a shelve proposal, so the entry resolves nothing.
    const noCut = planSweep({ projectRoot: root, manifest: emptyManifest({ duplicates: [{ live, survivor, sha256: sha256(liveText), reason: "same story" }] }) });
    expect(noCut.duplicatesResolved).toEqual([]);
  });

  it("reviewed apply of a resolved shelve duplicate removes the live copy and keeps the furthest phase on the z_implemented survivor", () => {
    const live = "backlog.zzfx.sd-apply";
    const survivor = destinationFor(live, "z_implemented");
    const liveText = oldStory(live, { phase: "executed" });
    const root = makeGitVault({ notes: { [live]: liveText, [survivor]: story(survivor, { phase: "planned", status: "implemented" }) } });
    const manifest = emptyManifest({ duplicates: [{ live, survivor, sha256: sha256(liveText), reason: "same story" }] });
    const { plan, result } = applyReviewed(root, manifest, { cutoff: CUTOFF });
    expect(plan.duplicatesResolved.map((d) => d.live)).toEqual([live]);
    expect(result.duplicatesRemoved).toEqual([{ live, survivor, removed: true }]);
    expect(fs.existsSync(notePath(root, live))).toBe(false);
    expect(fs.existsSync(notePath(root, destinationFor(live, "z_archive")))).toBe(false);
    const d = readData(root, survivor);
    expect(d.id).toBe(survivor);
    expect(d.phase).toBe("executed");
    expect(d.status).toBe("implemented");
  });

  it("shelve proposal with a z_archive twin stays held target_exists even with a duplicates entry", () => {
    const live = "backlog.zzfx.sd-zarch";
    const twin = destinationFor(live, "z_archive");
    const liveText = oldStory(live);
    const root = makeVault({ notes: { [live]: liveText, [twin]: story(twin, { status: "shelved" }) } });
    const plan = planCut(root, emptyManifest({ duplicates: [{ live, survivor: twin, sha256: sha256(liveText), reason: "x" }] }));
    const h = heldFor(plan, live);
    expect(h.reason).toBe("target_exists");
    expect(h.cohort).toBe("S");
    expect(h.existing).toEqual([twin]);
    expect(plan.duplicatesResolved).toEqual([]);
    expect(moveFor(plan, live)).toBeUndefined();
  });

  it("shelve proposal with both twins stays held target_exists even with a duplicates entry", () => {
    const live = "backlog.zzfx.sd-both";
    const zi = destinationFor(live, "z_implemented");
    const za = destinationFor(live, "z_archive");
    const liveText = oldStory(live);
    const root = makeVault({ notes: { [live]: liveText, [zi]: story(zi, { phase: "executed" }), [za]: story(za, { status: "shelved" }) } });
    const plan = planCut(root, emptyManifest({ duplicates: [{ live, survivor: zi, sha256: sha256(liveText), reason: "x" }] }));
    const h = heldFor(plan, live);
    expect(h.reason).toBe("target_exists");
    expect(h.cohort).toBe("S");
    expect(h.existing).toEqual([zi, za]);
    expect(plan.duplicatesResolved).toEqual([]);
  });

  it("shelve duplicate with mismatched sha256 stays held target_exists", () => {
    const live = "backlog.zzfx.sd-sha";
    const zi = destinationFor(live, "z_implemented");
    const root = makeGitVault({ notes: { [live]: oldStory(live), [zi]: story(zi, { phase: "executed" }) } });
    const manifest = emptyManifest({ duplicates: [{ live, survivor: zi, sha256: "0".repeat(64), reason: "x" }] });
    const before = snapshot(root);
    const { plan } = applyReviewed(root, manifest, { cutoff: CUTOFF });
    const h = heldFor(plan, live);
    expect(h.reason).toBe("target_exists");
    expect(h.cohort).toBe("S");
    expect(h.duplicateDetail).toContain("does not match the live copy");
    expect(plan.duplicatesResolved).toEqual([]);
    expectSnapshotsEqual(before, snapshot(root));
  });

  it("parent with a live or same-run shelved child is not shelved", () => {
    const p1 = "backlog.zzfx.pc-one";
    const c1 = "backlog.zzfx.pc-one.kid";
    const p2 = "backlog.zzfx.pc-two";
    const c2 = "backlog.zzfx.pc-two.kid";
    const root = makeVault({ notes: { [p1]: oldStory(p1), [c1]: oldStory(c1, { updated: NEW }), [p2]: oldStory(p2), [c2]: oldStory(c2) } });
    const plan = planCut(root);
    expect(heldFor(plan, p1).reason).toBe("kept_live_child");
    expect(heldFor(plan, p1).detail).toContain(c1);
    expect(moveFor(plan, c2).cohort).toBe("S");
    expect(moveFor(plan, p2)).toBeUndefined();
    expect(heldFor(plan, p2).reason).toBe("kept_live_child");
  });

  it("disposition decision record has the canon sections, status lines, exceptions and recorded rulings", () => {
    const file = path.join(REPO_ROOT, "notes", RECORD_ID + MD);
    expect(fs.existsSync(file)).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(parseFrontmatter(text).data.id).toBe(RECORD_ID);
    const body = bodyOf(text);
    const headings = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
    for (const s of ["Context", "Decision", "Status", "Consequences", "Supersedes / Superseded by"]) expect(headings, s).toContain(s);
    const section = (name) => {
      const lines = body.split("\n");
      const start = lines.findIndex((l) => l.trim() === `## ${name}`);
      let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
      if (end === -1) end = lines.length;
      return lines.slice(start + 1, end).join("\n");
    };
    const status = section("Status");
    expect(status).toMatch(/^accepted \(/m);
    const residue = status.split("\n").find((l) => l.startsWith("Open residue:"));
    expect(residue).toBeDefined();
    expect(status).toMatch(/^Measured at:/m);
    const decision = section("Decision");
    const item = (n) => decision.split("\n").find((l) => l.startsWith(`${n}. `)) || "";
    const i3 = item(3);
    for (const re of [/arch-approved/, /current research paper|current paper/, /held\[\]/, /releasedIn/, /age cannot be read|unreadable age/, /child still live|live child/]) {
      expect(i3, String(re)).toMatch(re);
    }
    expect(i3).toMatch(/in-flight phase \(planned, executing, executed or building\) is not an exception/);
    expect(i3).toMatch(/first checked for work done in code/);
    expect(i3).toMatch(/otherwise shelved/);
    expect(item(7)).toContain("Check, then shelve");
    expect(item(7)).toContain("Not current");
    expect(residue).not.toContain("user rulings on in-flight notes");
    expect(text.includes("backlog.scaffold-story-type")).toBe(false);
    expect(item(8)).toContain("shelve[]");
    expect(item(8)).toContain("supersededBy");
    const ids = realManifest().shelve.map((e) => e.id);
    expect(ids.length).toBe(5);
    for (const id of ids) expect(text.includes(id), id).toBe(false);
  });

  it("real manifest currentPapers entries resolve with reasons", () => {
    const m = realManifest();
    expect(Array.isArray(m.currentPapers)).toBe(true);
    for (const e of m.currentPapers) {
      expect(typeof e.id === "string" && fs.existsSync(path.join(REPO_ROOT, "notes", e.id + MD)), String(e.id)).toBe(true);
      expect(typeof e.reason === "string" && e.reason.trim() !== "", String(e.id)).toBe(true);
    }
  });

  it("real manifest currentPapers has no entry for the not-current older roadmap", () => {
    const m = realManifest();
    expect(Array.isArray(m.currentPapers)).toBe(true);
    expect(m.currentPapers.map((e) => e && e.id)).not.toContain("roadmap.2026.07.10.v1-oss-readiness");
  });

  it("real manifest keeps readme-public-launch-update in held", () => {
    expect(realManifest().held.map((e) => e.id)).toContain("backlog.feat.readme-public-launch-update");
  });

  it("shelve entry waives only the age and current-paper protections and records shelveReason", () => {
    const recent = "backlog.zzfx.se-recent";
    const named = "backlog.zzfx.se-named";
    const pap = "research.2026.11.02.zzfx-se";
    const root = makeGitVault({ notes: { [recent]: oldStory(recent, { updated: NEW }), [named]: oldStory(named), [pap]: paper(pap, `Names ${named}.`) } });
    const manifest = emptyManifest({ shelve: [{ id: recent, reason: "ruled: Shelve them" }, { id: named, reason: "ruled: Shelve anyway" }] });
    const plan = planCut(root, manifest);
    const r = moveFor(plan, recent);
    const n = moveFor(plan, named);
    expect(r.cohort).toBe("S");
    expect(n.cohort).toBe("S");
    expect(r.waived).toEqual(["updated on or after the cutoff"]);
    const lineNo = fs.readFileSync(notePath(root, pap), "utf8").split("\n").findIndex((l) => l.includes(named)) + 1;
    expect(n.waived).toEqual([`current paper notes/${pap}${MD}:${lineNo}`]);
    const text = formatReport(plan);
    expect(text).toContain("waived: updated on or after the cutoff");
    expect(text).toContain(`waived: current paper notes/${pap}${MD}:${lineNo}`);
    const result = applySweep({ projectRoot: root, manifest, expectDigest: plan.digest, cutoff: CUTOFF });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    for (const [id, reason] of [[recent, "ruled: Shelve them"], [named, "ruled: Shelve anyway"]]) {
      const d = readData(root, destinationFor(id, "z_archive"));
      expect(d.shelveReason).toBe(reason);
      expect(d.status).toBe("shelved");
      expect(d.archiveCohort).toBe("shelved");
      expect(d.archivedBy).toBe(SHELVED_BY);
      expect(d.shelvedCutoff).toBe(CUTOFF);
      expect(typeof d.shelvedAge).toBe("string");
    }
  });

  it("shelve entry blocked by another exception is held shelve_entry_blocked", () => {
    const ids = {
      aa: ["backlog.zzfx.sb-aa", { phase: "arch-approved" }, "arch-approved"],
      rel: ["backlog.zzfx.sb-rel", { phase: "released" }, "released"],
      ri: ["backlog.zzfx.sb-ri", { releasedIn: "0.2.0" }, "releasedIn"],
      par: ["backlog.zzfx.sb-parent", {}, "backlog.zzfx.sb-parent.kid"],
    };
    const notes = { "backlog.zzfx.sb-parent.kid": oldStory("backlog.zzfx.sb-parent.kid", { updated: NEW }) };
    for (const [id, extra] of Object.values(ids)) notes[id] = oldStory(id, extra);
    const twin = "backlog.zzfx.sb-twin";
    notes[twin] = oldStory(twin);
    notes[destinationFor(twin, "z_archive")] = story(destinationFor(twin, "z_archive"));
    const planned = "backlog.zzfx.sb-planned";
    notes[planned] = oldStory(planned, { phase: "planned" });
    const root = makeVault({ notes });
    const shelve = [...Object.values(ids).map(([id]) => ({ id, reason: "ruled" })), { id: twin, reason: "ruled" }, { id: planned, reason: "ruled" }];
    const plan = planCut(root, emptyManifest({ shelve }));
    for (const [id, , needle] of Object.values(ids)) {
      expect(moveFor(plan, id), id).toBeUndefined();
      const h = heldFor(plan, id);
      expect(h.reason, id).toBe("shelve_entry_blocked");
      expect(h.detail, id).toContain(needle);
    }
    expect(heldFor(plan, twin).reason).toBe("target_exists");
    expect(moveFor(plan, planned).cohort).toBe("S");
    expect(heldFor(plan, planned)).toBeUndefined();
  });

  it("shelve entries obey manifest conflict, reason and not-found rules", () => {
    const dup = "backlog.zzfx.sr-dup";
    const blank = "backlog.zzfx.sr-blank";
    const root = makeVault({ notes: { [dup]: oldStory(dup), [blank]: oldStory(blank) } });
    const plan = planCut(
      root,
      emptyManifest({
        held: [{ id: dup, reason: "keep" }],
        shelve: [{ id: dup, reason: "ruled" }, { id: blank, reason: "  " }, { id: "backlog.zzfx.sr-missing", reason: "ruled" }],
      }),
    );
    expect(heldFor(plan, dup).reason).toBe("manifest_conflict");
    expect(heldFor(plan, blank).reason).toBe("invalid_manifest_entry");
    expect(heldFor(plan, "backlog.zzfx.sr-missing").reason).toBe("note_not_found");
    expect(plan.moves).toEqual([]);
  });

  it("shelve list moves nothing without a cutoff and enters the digest only when non-empty", () => {
    const name = "backlog.zzfx.sn-recent";
    const root = makeVault({ notes: { [name]: oldStory(name, { updated: NEW }), "backlog.zzfx.sn-old": oldStory("backlog.zzfx.sn-old") } });
    const withEntry = emptyManifest({ shelve: [{ id: name, reason: "ruled" }] });
    const plain = planSweep({ projectRoot: root, manifest: emptyManifest() });
    const listed = planSweep({ projectRoot: root, manifest: withEntry });
    expect(moveFor(listed, name)).toBeUndefined();
    expect(heldFor(listed, name)).toEqual(heldFor(plain, name));
    expect(listed.moves).toEqual(plain.moves);
    expect(listed.held).toEqual(plain.held);
    expect(listed.counts).toEqual(plain.counts);
    for (const cutoff of [undefined, CUTOFF]) {
      const a = planSweep({ projectRoot: root, manifest: emptyManifest(), cutoff });
      const b = planSweep({ projectRoot: root, manifest: emptyManifest({ shelve: [] }), cutoff });
      expect(b.digest).toBe(a.digest);
    }
    expect(planCut(root, withEntry).digest).not.toBe(planCut(root).digest);
  });

  it("supersededBy pointers to a shelved note are rewritten and reported", () => {
    const target = "backlog.zzfx.sp-target";
    const rel = "backlog.zzfx.sp-rel";
    const zs = "z_archive.backlog.zzfx.sp-string";
    const za = "z_archive.backlog.zzfx.sp-array";
    const zo = "z_archive.backlog.zzfx.sp-other";
    const root = makeGitVault({
      notes: {
        [target]: oldStory(target),
        [rel]: story(rel, { phase: "released" }),
        [zs]: noteText({ id: zs, status: "superseded", supersededBy: target }),
        [za]: noteText({ id: za, status: "superseded", supersededBy: [target, rel] }),
        [zo]: noteText({ id: zo, status: "superseded", supersededBy: rel }),
      },
    });
    const zoBefore = fs.readFileSync(notePath(root, zo), "utf8");
    const newId = destinationFor(target, "z_archive");
    const { plan } = applyReviewed(root, emptyManifest(), { cutoff: CUTOFF });
    expect(moveFor(plan, target).cohort).toBe("S");
    expect(moveFor(plan, rel).cohort).toBe("A");
    expect(plan.supersededByRewrites).toEqual([
      { note: za, old: [target, rel], new: [newId, rel] },
      { note: zs, old: target, new: newId },
    ]);
    expect(readData(root, zs).supersededBy).toBe(newId);
    expect(readData(root, za).supersededBy).toEqual([newId, rel]);
    expect(fs.readFileSync(notePath(root, zo), "utf8")).toBe(zoBefore);
    expect(formatReport(planCut(makeVault({ notes: { [target]: oldStory(target), [zs]: noteText({ id: zs, supersededBy: target }) } })))).toContain("supersededBy rewrites (1)");
  });

  it("real manifest shelve list carries the five ruled notes with reasons", () => {
    const m = realManifest();
    expect(Array.isArray(m.shelve)).toBe(true);
    for (const e of m.shelve) {
      expect(typeof e.reason === "string" && e.reason.trim() !== "", String(e.id)).toBe(true);
      const live = fs.existsSync(path.join(REPO_ROOT, "notes", e.id + MD));
      const shelved = fs.existsSync(path.join(REPO_ROOT, "notes", destinationFor(e.id, "z_archive") + MD));
      expect(live || shelved, e.id).toBe(true);
    }
    const ids = m.shelve.map((e) => e.id);
    for (const id of RULED) expect(ids, id).toContain(id);
  });

  it("shelve entry with unparseable or missing frontmatter keeps the existing frontmatter hold reason", () => {
    const bad = "backlog.zzfx.sf-bad";
    const bare = "backlog.zzfx.sf-bare";
    const root = makeVault({ notes: { [bad]: `---\nid: "${bad}"\nphase: [draft\n---\n\nBody.\n`, [bare]: "# No frontmatter\n\nBody.\n" } });
    const plan = planCut(root, emptyManifest({ shelve: [{ id: bad, reason: "ruled" }, { id: bare, reason: "ruled" }] }));
    expect(heldFor(plan, bad).reason).toBe("frontmatter_unparseable");
    expect(heldFor(plan, bare).reason).toBe("no_frontmatter");
    expect(plan.moves).toEqual([]);
    expect(plan.held.filter((h) => h.reason === "shelve_entry_blocked")).toEqual([]);
    expect(plan.shelveEntries.find((e) => e.id === bad).outcome).toBe("frontmatter_unparseable");
    expect(plan.shelveEntries.find((e) => e.id === bare).outcome).toBe("no_frontmatter");
  });
});

// ---------------------------------------------------------------------------------------------
// Cohort C4 (decomposed parent follows children). A decomposed parent
// with no live or held child, at least one resolvable child, no manifest defect and not every child
// shipped follows its children to z_archive.backlog.<rest> as superseded. The story id is imported
// from the script (FOLLOWS_CHILDREN_BY), never written here.
// ---------------------------------------------------------------------------------------------

describe("backlog-archive-sweep decomposed parent follows children", () => {
  const za = (n) => destinationFor(n, "z_archive");
  const zi = (n) => destinationFor(n, "z_implemented");

  it("C4 moves a decomposed parent whose only child is archived to z_archive.backlog", () => {
    const parent = "backlog.zzfx.f4-only";
    const kid = za(`${parent}.child-1`);
    const root = makeVault({ notes: { [parent]: story(parent, { phase: "decomposed" }), [kid]: story(kid, { phase: "draft", status: "shelved" }) } });
    const plan = planSweep({ projectRoot: root, manifest: emptyManifest() });
    const mv = moveFor(plan, parent);
    expect(mv.cohort).toBe("C4");
    expect(mv.kind).toBe("z_archive");
    expect(mv.to).toBe(`z_archive.backlog.${parent.replace(/^backlog\./, "")}`);
    expect(mv.to).toBe(za(parent));
    expect(plan.counts.cohorts.C4).toBe(1);
    expect(heldFor(plan, parent)).toBeUndefined();
  });

  it("C4 not C3 for a parent with one shipped and one archived child", () => {
    const parent = "backlog.zzfx.f4-mixed";
    const kidShipped = "backlog.zzfx.f4-mixed-kid-1";
    const kidArchived = "backlog.zzfx.f4-mixed-kid-2";
    const root = makeVault({
      notes: {
        [parent]: story(parent, { phase: "decomposed", childStories: [kidShipped, kidArchived] }),
        [zi(kidShipped)]: story(zi(kidShipped), { phase: "released", status: "implemented" }),
        [za(kidArchived)]: story(za(kidArchived), { phase: "draft", status: "shelved" }),
      },
    });
    const plan = planSweep({ projectRoot: root, manifest: emptyManifest() });
    expect(moveFor(plan, parent).cohort).toBe("C4");
    expect(moveFor(plan, parent).to).toBe(za(parent));
    expect(plan.counts.cohorts.C3).toBe(0);
    expect(plan.counts.cohorts.C4).toBe(1);
  });

  it("C4 writes superseded metadata and never writes phase", () => {
    const parent = "backlog.zzfx.f4-meta";
    const kidShipped = "backlog.zzfx.f4-meta-kid-1";
    const kidArchived = "backlog.zzfx.f4-meta-kid-2";
    const root = makeGitVault({
      notes: {
        [parent]: story(parent, { phase: "decomposed", childStories: [kidShipped, kidArchived] }),
        [zi(kidShipped)]: story(zi(kidShipped), { phase: "released", status: "implemented" }),
        [za(kidArchived)]: story(za(kidArchived), { phase: "draft", status: "shelved" }),
      },
    });
    const { plan } = applyReviewed(root, emptyManifest());
    expect(moveFor(plan, parent).cohort).toBe("C4");
    expect(Object.prototype.hasOwnProperty.call(moveFor(plan, parent).updates, "phase")).toBe(false);
    expect(fs.existsSync(notePath(root, parent))).toBe(false);
    const d = readData(root, za(parent));
    const resolved = [zi(kidShipped), za(kidArchived)].sort();
    expect(d.id).toBe(za(parent));
    expect(d.status).toBe("superseded");
    expect([...d.supersededBy].sort()).toEqual(resolved);
    expect([...d.decomposedInto].sort()).toEqual(resolved);
    expect(d.archivedBy).toBe(FOLLOWS_CHILDREN_BY);
    expect(FOLLOWS_CHILDREN_BY).not.toBe(ARCHIVED_BY);
    expect(d.archiveCohort).toBe("decomposed-unshipped");
    expect(d.archivedFromPhase).toBe("decomposed");
    expect(d.phase).toBe("decomposed");
    expect(Object.prototype.hasOwnProperty.call(d, "missingChildren")).toBe(false);
  });

  it("C4 records missingChildren for a declared child that resolves nowhere", () => {
    const parent = "backlog.zzfx.f4-miss";
    const kidArchived = "backlog.zzfx.f4-miss-kid-1";
    const kidMissing = "backlog.zzfx.f4-miss-kid-2";
    const root = makeGitVault({
      notes: {
        [parent]: story(parent, { phase: "decomposed", childStories: [kidArchived, kidMissing] }),
        [za(kidArchived)]: story(za(kidArchived), { phase: "draft", status: "shelved" }),
      },
    });
    const { plan } = applyReviewed(root, emptyManifest());
    expect(moveFor(plan, parent).cohort).toBe("C4");
    const d = readData(root, za(parent));
    expect(d.missingChildren).toEqual([kidMissing]);
    expect(d.supersededBy).toEqual([za(kidArchived)]);
    expect(d.decomposedInto).toEqual([za(kidArchived)]);
    expect(d.status).toBe("superseded");
  });

  it("C3 still moves an all-shipped parent to z_implemented with unchanged metadata", () => {
    const parent = "backlog.zzfx.f4-c3";
    const kid1 = zi(`${parent}.child-1`);
    const kid2 = `${parent}.child-2`;
    const root = makeGitVault({
      notes: {
        [parent]: story(parent, { phase: "decomposed" }),
        [kid1]: story(kid1, { phase: "released", status: "implemented" }),
        [kid2]: story(kid2, { phase: "released" }),
      },
    });
    const { plan } = applyReviewed(root, emptyManifest());
    expect(moveFor(plan, parent).cohort).toBe("C3");
    expect(plan.counts.cohorts.C4).toBe(0);
    const d = readData(root, zi(parent));
    expect(d.status).toBe("implemented");
    expect(d.archiveCohort).toBe("decomposed");
    expect(d.archivedBy).toBe(ARCHIVED_BY);
    expect([...d.decomposedInto].sort()).toEqual([kid1, zi(kid2)].sort());
    for (const k of ["supersededBy", "missingChildren"]) expect(Object.prototype.hasOwnProperty.call(d, k), k).toBe(false);
    expect(d.archiveCohort).not.toBe("decomposed-unshipped");
  });

  it("a live child at any phase keeps the parent held children_not_shipped", () => {
    const parent = "backlog.zzfx.f4-live";
    const archived = za(`${parent}.child-1`);
    const live = `${parent}.child-2`;
    const root = makeVault({
      notes: {
        [parent]: story(parent, { phase: "decomposed" }),
        [archived]: story(archived, { phase: "draft", status: "shelved" }),
        [live]: story(live, { phase: "ready" }),
      },
    });
    const plan = planSweep({ projectRoot: root, manifest: emptyManifest() });
    const h = heldFor(plan, parent);
    expect(h.reason).toBe("children_not_shipped");
    expect(moveFor(plan, parent)).toBeUndefined();
    expect(h.detail).toContain(live);
    expect(h.detail).toMatch(new RegExp(`live: [^;]*${live.replace(/[.]/g, "\\.")}`));
    expect(plan.counts.cohorts.C4).toBe(0);
  });

  it("a live nested decomposed child keeps the parent held for this run", () => {
    const parent = "backlog.zzfx.f4-nest";
    const child = `${parent}.child-1`;
    const grandchild = za(`${child}.child-1`);
    const root = makeVault({
      notes: {
        [parent]: story(parent, { phase: "decomposed" }),
        [child]: story(child, { phase: "decomposed" }),
        [grandchild]: story(grandchild, { phase: "draft", status: "shelved" }),
      },
    });
    const plan = planSweep({ projectRoot: root, manifest: emptyManifest() });
    expect(moveFor(plan, child).cohort).toBe("C4");
    expect(moveFor(plan, parent)).toBeUndefined();
    const h = heldFor(plan, parent);
    expect(h.reason).toBe("children_not_shipped");
    expect(h.detail).toContain(child);
  });

  it("a live child with a z_implemented twin keeps the parent held", () => {
    const parent = "backlog.zzfx.f4-twin";
    const archived = za(`${parent}.child-1`);
    const live = `${parent}.child-2`;
    const root = makeVault({
      notes: {
        [parent]: story(parent, { phase: "decomposed" }),
        [archived]: story(archived, { phase: "draft", status: "shelved" }),
        [live]: story(live, { phase: "draft" }),
        [zi(live)]: story(zi(live), { phase: "released", status: "implemented" }),
      },
    });
    const plan = planSweep({ projectRoot: root, manifest: emptyManifest() });
    const h = heldFor(plan, parent);
    expect(h.reason).toBe("children_not_shipped");
    expect(moveFor(plan, parent)).toBeUndefined();
    expect(h.detail).toContain(live);
  });

  it("a child named in held[] keeps the parent held even with no note", () => {
    const parent = "backlog.zzfx.f4-held";
    const kidArchived = "backlog.zzfx.f4-held-kid-1";
    const kidHeld = "backlog.zzfx.f4-held-kid-2";
    const root = makeVault({
      notes: {
        [parent]: story(parent, { phase: "decomposed", childStories: [kidArchived, kidHeld] }),
        [za(kidArchived)]: story(za(kidArchived), { phase: "draft", status: "shelved" }),
      },
    });
    const plan = planSweep({ projectRoot: root, manifest: emptyManifest({ held: [{ id: kidHeld, reason: "user decision" }] }) });
    const h = heldFor(plan, parent);
    expect(h.reason).toBe("children_not_shipped");
    expect(moveFor(plan, parent)).toBeUndefined();
    expect(h.detail).toMatch(new RegExp(`held: [^;]*${kidHeld.replace(/[.]/g, "\\.")}`));
  });

  it("unresolvable, empty and defective child sets keep their existing holds", () => {
    const pUnres = "backlog.zzfx.f4-unres";
    const pNone = "backlog.zzfx.f4-none";
    const pDef = "backlog.zzfx.f4-def";
    const defKid = za(`${pDef}.child-1`);
    const root = makeVault({
      notes: {
        [pUnres]: story(pUnres, { phase: "decomposed", childStories: ["backlog.zzfx.f4-unres-kid-absent"] }),
        [pNone]: story(pNone, { phase: "decomposed" }),
        [pDef]: story(pDef, { phase: "decomposed" }),
        [defKid]: story(defKid, { phase: "draft", status: "shelved" }),
      },
    });
    const plan = planSweep({ projectRoot: root, manifest: emptyManifest() });
    expect(heldFor(plan, pUnres).reason).toBe("children_not_shipped");
    expect(heldFor(plan, pNone).reason).toBe("no_children");
    expect(moveFor(plan, pDef).cohort).toBe("C4");
    for (const children of [[], ["backlog.zzfx.f4-def-kid-not-in-text"]]) {
      const p2 = planSweep({ projectRoot: root, manifest: emptyManifest({ decomposedChildren: [{ id: pDef, children }] }) });
      expect(moveFor(p2, pDef), JSON.stringify(children)).toBeUndefined();
      expect(heldFor(p2, pDef).reason, JSON.stringify(children)).toBe("children_not_shipped");
    }
    expect(plan.moves.map((m) => m.from)).toEqual([pDef]);
  });

  it("C4 proposals are held target_exists when a destination twin exists", () => {
    const pArch = "backlog.zzfx.f4-te-arch";
    const pImpl = "backlog.zzfx.f4-te-impl";
    const kA = za(`${pArch}.child-1`);
    const kI = za(`${pImpl}.child-1`);
    const implText = story(pImpl, { phase: "decomposed" });
    const root = makeVault({
      notes: {
        [pArch]: story(pArch, { phase: "decomposed" }),
        [kA]: story(kA, { phase: "draft", status: "shelved" }),
        [za(pArch)]: story(za(pArch), { status: "superseded" }),
        [pImpl]: implText,
        [kI]: story(kI, { phase: "draft", status: "shelved" }),
        [zi(pImpl)]: story(zi(pImpl), { phase: "decomposed", status: "implemented" }),
      },
    });
    const plan = planSweep({ projectRoot: root, manifest: emptyManifest({ duplicates: [{ live: pImpl, survivor: zi(pImpl), sha256: sha256(implText), reason: "same story" }] }) });
    const hA = heldFor(plan, pArch);
    expect(hA.reason).toBe("target_exists");
    expect(hA.cohort).toBe("C4");
    const hI = heldFor(plan, pImpl);
    expect(hI.reason).toBe("target_exists");
    expect(hI.cohort).toBe("C4");
    expect(hI.existing).toEqual([zi(pImpl)]);
    expect(plan.duplicatesResolved).toEqual([]);
    expect(plan.moves).toEqual([]);
  });

  it("C4 proposals are subject to the z_archive guards", () => {
    const pDec = "backlog.zzfx.f4-g-dec";
    const pRead = "backlog.zzfx.f4-g-readme";
    const kD = za(`${pDec}.child-1`);
    const kR = za(`${pRead}.child-1`);
    const record = "decision.zzfx-f4-guard";
    const root = makeVault({
      notes: {
        [pDec]: story(pDec, { phase: "decomposed" }),
        [kD]: story(kD, { phase: "draft", status: "shelved" }),
        [pRead]: story(pRead, { phase: "decomposed" }),
        [kR]: story(kR, { phase: "draft", status: "shelved" }),
        [record]: noteText({ id: record, title: "Fixture decision" }, `\n\n# Decision\n\nKeep ${pDec} live.\n`),
      },
      files: { "README.md": `# Fixture\n\nSee ${pRead}.\n` },
    });
    const plan = planSweep({ projectRoot: root, manifest: emptyManifest() });
    const hD = heldFor(plan, pDec);
    expect(hD.reason).toBe("decision_reference");
    expect(hD.cohort).toBe("C4");
    const hR = heldFor(plan, pRead);
    expect(hR.reason).toBe("readme_reference");
    expect(hR.cohort).toBe("C4");
    expect(plan.moves).toEqual([]);
  });

  it("COHORT_KEYS includes C4 and plan cohort counts follow it", () => {
    expect(COHORT_KEYS).toEqual(["A", "A'", "B", "C1", "C2", "C3", "C4"]);
    const n = "backlog.zzfx.f4-keys";
    const root = makeVault({ notes: { [n]: story(n, { phase: "released" }) } });
    expect(Object.keys(planSweep({ projectRoot: root, manifest: emptyManifest() }).counts.cohorts)).toEqual(COHORT_KEYS);
    expect(Object.keys(planCut(root).counts.cohorts)).toEqual([...COHORT_KEYS, "S"]);
  });

  it("script header documents cohort C4", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, "scripts", "backlog-archive-sweep.mjs"), "utf8");
    const header = [];
    for (const line of text.split("\n").slice(1)) {
      if (!line.startsWith("//")) break;
      header.push(line);
    }
    const start = header.findIndex((l) => /^\/\/ Cohorts/.test(l));
    expect(start).toBeGreaterThan(-1);
    const c4 = header.slice(start).find((l) => /^\/\/\s+C4\s/.test(l));
    expect(c4).toBeDefined();
    expect(c4).toContain("decomposed");
    expect(c4).toContain("z_archive.backlog.<rest>");
  });

  it("disposition decision record states the decomposed-parent follows-children rule", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, "notes", RECORD_ID + MD), "utf8");
    const lines = bodyOf(text).split("\n");
    const start = lines.findIndex((l) => l.trim() === "## Decision");
    let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    if (end === -1) end = lines.length;
    const decision = lines.slice(start + 1, end);
    const item = (k) => decision.find((l) => l.startsWith(`${k}. `)) || "";
    for (let k = 1; k <= 9; k++) expect(item(k), `item ${k}`).not.toBe("");
    const i9 = item(9);
    expect(i9).toMatch(/decomposed/);
    expect(i9).toContain("z_archive.backlog");
    expect(i9).toMatch(/superseded/);
    expect(i9).toContain('"Follow children');
    expect(i9).not.toMatch(/backlog\.(?:feat|fix|chore)\.[A-Za-z0-9]/);
    const i3 = item(3);
    expect(i3).not.toContain("held until every child is shipped");
    expect(i3).toMatch(/child still live/);
    expect(item(1)).toContain("every child shipped");
  });
});
