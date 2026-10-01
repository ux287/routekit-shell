/**
 * Witness for backlog.feat.rag-namespace-embed-deny-list.
 *
 * Namespace embed eligibility used to be decided by TWO mechanisms that disagreed: an
 * eight-member allow-list glob in `utils.mjs` selecting files, and a predicate in
 * `embed.mjs` rejecting some of the very namespaces that glob selected. `notes.*` and
 * `prototype.*` were in the glob AND force-rejected; `research.*` was in neither and
 * embedded by falling through a default. A project could not create a namespace for its own
 * domain without editing rks.
 *
 * The model is now inverted: a small, documented, reserved set does not embed, and
 * everything else does — including namespaces this code has never heard of.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { RESERVED_NAMESPACES, getProjectContext } from "../../../packages/rag/src/utils.mjs";
import { buildEmbeddingRows } from "../../../packages/rag/src/embed.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const EMBED_SRC = readFileSync(path.join(REPO_ROOT, "packages/rag/src/embed.mjs"), "utf8");

/** The body of the archiveIgnorePatterns array literal, as source text. */
function ignoreArrayBody() {
  const start = EMBED_SRC.indexOf("const archiveIgnorePatterns = [");
  const end = EMBED_SRC.indexOf("];", start);
  expect(start, "archiveIgnorePatterns literal not found").toBeGreaterThan(-1);
  return EMBED_SRC.slice(start, end);
}

/** Drive the real predicate through the only exported function that reaches it. */
async function embeds(vaultPath, relName, body = "---\ntitle: T\n---\n\ncontent here\n") {
  const file = path.join(vaultPath, relName);
  writeFileSync(file, body);
  const result = await buildEmbeddingRows(file, {
    vaultPath,
    projectSlug: "test",
    embedderFn: async () => new Array(8).fill(0),
  });
  return { embedded: !result.skipped, reason: result.reason ?? null };
}

describe("the reserved set is the one source of truth", () => {
  it("is exactly three members, and they are the documented ones", () => {
    expect(RESERVED_NAMESPACES).toEqual(["drafts.", "scratch.", "z_archive."]);
  });

  it("the selection ignore list is DERIVED from it, not restated", () => {
    // A hardcoded literal and a map are behaviourally identical, so this half can only be
    // asserted at the source. The derived half is what stops the two mechanisms drifting.
    expect(ignoreArrayBody()).toContain("RESERVED_NAMESPACES.map(");
  });

  it("the ignore list holds exactly the derived globs plus the two DIRECTORY forms", () => {
    // Order-insensitive membership. The directory forms stay literal because a name-prefix
    // set cannot express a path.
    const literals = [...ignoreArrayBody().matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    expect(literals.sort()).toEqual(["drafts/**", "z_archive/**"]);
  });

  it("DROPS the dotless variants that used to be ignored", () => {
    // `drafts*` matched `draftsFoo.md`, which is not in the `drafts.` namespace. Scoped to
    // the array body, not whole-source: `**/z_archive*` elsewhere in the file must survive.
    const body = ignoreArrayBody();
    expect(body).not.toMatch(/"drafts\*"/);
    expect(body).not.toMatch(/"z_archive\*"/);
  });

  it("the guide documents every reserved namespace — no drift between code and docs", () => {
    const guide = readFileSync(path.join(REPO_ROOT, "notes/public.guide.notes-structure.md"), "utf8");
    for (const ns of RESERVED_NAMESPACES) {
      expect(guide, `guide does not document reserved namespace ${ns}`).toContain(ns);
    }
  });
});

describe("the predicate admits by default and denies only the reserved set", () => {
  let vault;

  beforeEach(() => {
    vault = mkdtempSync(path.join(tmpdir(), "rks-reserved-ns-"));
  });

  afterEach(() => {
    try { rmSync(vault, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it.each(RESERVED_NAMESPACES)("denies %s", async (ns) => {
    const r = await embeds(vault, `${ns}thing.md`);
    expect(r.embedded).toBe(false);
    expect(r.reason).toBe("excluded");
  });

  it.each([
    "backlog.feat.x.md",
    "design.x.md",
    "docs.x.md",
    "how-to.x.md",
    "research.2026.01.x.md",
    "public.canon.x.md",
    "agents.x.md",
    "playbooks.x.md",
    "some-business-domain.x.md",
  ])("admits %s", async (name) => {
    expect((await embeds(vault, name)).embedded).toBe(true);
  });

  // A DELIBERATE WIDENING, one witness each so a single failure names the namespace that
  // regressed. All three were force-rejected before; notes.* and prototype.* were also in
  // the old allow-list glob, which is the contradiction this story removes. These notes
  // will begin embedding on the next re-embed, and that is the intended behaviour change,
  // not a side effect.
  it.each(["notes.x.md", "prototype.x.md", "daily.x.md"])(
    "ADMITS %s, which the old mechanism force-rejected",
    async (name) => {
      expect((await embeds(vault, name)).embedded).toBe(true);
    },
  );

  it("ADMITS keyless-notes.* — its retrievability is load-bearing for the keyless demo", async () => {
    // Named explicitly rather than relying on "unlisted namespaces embed": this one is
    // written by the Dispatcher in keyless mode and then retrieved by the next query, so a
    // refactor that swept it into the reserved set would break the demo silently.
    expect((await embeds(vault, "keyless-notes.demo.md")).embedded).toBe(true);
  });

  it("ADMITS a dotless near-miss — the set is not trying to catch every name", async () => {
    // `draftsFoo` and `draft.foo` are not the `drafts.` namespace. Under the old dotless
    // ignore pattern the first was silently dropped.
    expect((await embeds(vault, "draftsFoo.md")).embedded).toBe(true);
    expect((await embeds(vault, "draft.foo.md")).embedded).toBe(true);
    expect((await embeds(vault, "z_archiveFoo.md")).embedded).toBe(true);
  });

  it("honours the frontmatter OPT-OUT", async () => {
    const r = await embeds(vault, "backlog.opted.md", "---\ntitle: T\nrag: false\n---\n\nbody\n");
    expect(r.embedded).toBe(false);
    expect(r.reason).toBe("excluded");
  });

  it("honours private: true", async () => {
    const r = await embeds(vault, "backlog.private.md", "---\ntitle: T\nprivate: true\n---\n\nbody\n");
    expect(r.embedded).toBe(false);
  });

  it("has NO opt-IN — rag:true cannot rescue a reserved namespace", async () => {
    const r = await embeds(vault, "drafts.forced.md", "---\ntitle: T\nrag: true\n---\n\nbody\n");
    expect(r.embedded).toBe(false);
  });

  it("rag:true no longer overrides private:true — the one measured outcome change", async () => {
    // Deleting the opt-in is NOT outcome-neutral everywhere. This combination previously
    // embedded, because the opt-in was tested first and short-circuited. It now skips.
    const r = await embeds(vault, "backlog.both.md", "---\ntitle: T\nrag: true\nprivate: true\n---\n\nbody\n");
    expect(r.embedded).toBe(false);
  });
});

describe("selection selects the whole vault, nested notes included", () => {
  it("the derived glob is recursive, not top-level-only", () => {
    // `*` would make the primary selection non-zero far more often, which stops the
    // recursive fallback firing and silently drops notes in subdirectories.
    expect(getProjectContext(REPO_ROOT).noteGlob).toBe("**/*");
  });

  it("stays a plain STRING, so the object-identity pin in getDefaultRagConfig holds", () => {
    // An array would be a fresh object per call and would fail a toBe() comparison that
    // getDefaultRagConfig's own witness makes.
    expect(typeof getProjectContext(REPO_ROOT).noteGlob).toBe("string");
  });

  it("SELECTS a nested note — driven through globby, not asserted on the glob string", async () => {
    // The first cut of this witness looped over nested files asserting
    // `expect(noteGlob).toBe('**/*')`, which is tautological: it re-asserts the string in
    // every iteration and would pass with the selection machinery entirely broken. This one
    // runs the real selection the way embedNotes does — derived glob, `.md` suffixing,
    // derived ignore list, cwd at the vault — so a top-level-only pattern FAILS it.
    const vaultDir = mkdtempSync(path.join(tmpdir(), "rks-nested-select-"));
    try {
      mkdirSync(path.join(vaultDir, "release-notes"), { recursive: true });
      writeFileSync(path.join(vaultDir, "flat.md"), "---\ntitle: F\n---\n\nbody\n");
      writeFileSync(path.join(vaultDir, "release-notes", "nested.md"), "---\ntitle: N\n---\n\nbody\n");
      writeFileSync(path.join(vaultDir, "drafts.hidden.md"), "---\ntitle: D\n---\n\nbody\n");

      const basePattern = getProjectContext(REPO_ROOT).noteGlob;
      const globWithExt = basePattern.endsWith(".md") ? basePattern : `${basePattern}.md`;
      const ignore = [...RESERVED_NAMESPACES.map((ns) => `${ns}*`), "z_archive/**", "drafts/**"];

      const { globby } = await import("globby");
      const selected = (await globby([globWithExt], { cwd: vaultDir, ignore })).sort();

      expect(selected, "the nested note must be selected").toContain("release-notes/nested.md");
      expect(selected).toContain("flat.md");
      // And the DERIVED half of the ignore list is exercised here rather than only scanned
      // as source text: a reserved namespace is dropped at selection.
      expect(selected).not.toContain("drafts.hidden.md");
    } finally {
      try { rmSync(vaultDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
