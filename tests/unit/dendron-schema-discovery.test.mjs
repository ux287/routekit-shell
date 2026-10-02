/**
 * Schema discovery across both filename conventions —
 * backlog.fix.schema-discovery-dendron-standard-filenames
 *
 * findMatchingSchema built its candidate list from `<name>.schema.yml` only, so
 * notes/schema.backlog.yml — the only file in this vault whose id is `backlog` —
 * was never a candidate and no backlog note ever received its template frontmatter.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findMatchingSchema,
  loadSchemaTemplate,
  mergeTemplateWithGenerated,
  parseFrontmatter,
} from "../../packages/mcp-rks/src/dendron.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "../..");
const NOTES_DIR = join(PROJECT_ROOT, "notes");

const tmpDirs = [];
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "rks-schema-discovery-"));
  tmpDirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, "utf8");
  }
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const DENDRON_STANDARD_BACKLOG = [
  "version: 1",
  "schemas:",
  "  - id: backlog",
  "    title: Backlog Items",
  "    parent: root",
  "    data:",
  "      namespace: true",
  "    template: templates.backlog",
  "",
].join("\n");

const LEGACY_NAMED = [
  "version: 1",
  "schemas:",
  "  - id: legacy",
  "    title: Legacy",
  "    template: templates.legacy",
  "",
].join("\n");

describe("findMatchingSchema — filename conventions", () => {
  it("discovers the Dendron-standard schema.<name>.yml form", () => {
    const dir = fixture({ "schema.backlog.yml": DENDRON_STANDARD_BACKLOG });
    const schema = findMatchingSchema(dir, "backlog.fix.anything");
    expect(schema).not.toBeNull();
    expect(schema.id).toBe("backlog");
    expect(schema.template).toBe("templates.backlog");
  });

  it("still discovers the legacy <name>.schema.yml form", () => {
    const dir = fixture({ "legacy.schema.yml": LEGACY_NAMED });
    const schema = findMatchingSchema(dir, "legacy.child");
    expect(schema).not.toBeNull();
    expect(schema.id).toBe("legacy");
    expect(schema.template).toBe("templates.legacy");
  });

  it("resolves each namespace correctly when both conventions share a directory", () => {
    const dir = fixture({
      "legacy.schema.yml": LEGACY_NAMED,
      "schema.backlog.yml": DENDRON_STANDARD_BACKLOG,
    });
    expect(findMatchingSchema(dir, "backlog.fix.x").template).toBe("templates.backlog");
    expect(findMatchingSchema(dir, "legacy.child").template).toBe("templates.legacy");
  });

  it("does not admit an arbitrary .yml file", () => {
    const dir = fixture({
      "random.yml": [
        "version: 1",
        "schemas:",
        "  - id: random",
        "    data:",
        "      namespace: true",
        "    template: templates.random",
        "",
      ].join("\n"),
    });
    expect(findMatchingSchema(dir, "random.child")).toBeNull();
  });

  it("does not relax the namespace gate", () => {
    const dir = fixture({
      "schema.nogate.yml": ["version: 1", "schemas:", "  - id: nogate", "    title: No Gate", ""].join("\n"),
    });
    expect(findMatchingSchema(dir, "nogate.child")).toBeNull();
  });

  it("returns null without throwing on a missing directory", () => {
    expect(() => findMatchingSchema(join(tmpdir(), "rks-does-not-exist-xyz"), "backlog.x")).not.toThrow();
    expect(findMatchingSchema(join(tmpdir(), "rks-does-not-exist-xyz"), "backlog.x")).toBeNull();
  });

  it("survives an unparseable candidate and still finds a well-formed sibling", () => {
    const dir = fixture({
      "schema.broken.yml": "\u0000\u0001 not yaml at all :::\n",
      "schema.backlog.yml": DENDRON_STANDARD_BACKLOG,
    });
    expect(findMatchingSchema(dir, "backlog.fix.x").template).toBe("templates.backlog");
  });
});

describe("findMatchingSchema — this repo's real notes vault", () => {
  // Mirror safety. All three of these are absent from the public mirror:
  // .routekit/publish-profiles.yaml allowlists only notes/public.**, nine explicit
  // notes/how-to.*.md, notes/playbooks.**, notes/root.md and notes/root.schema.yml.
  // Any assertion that DEPENDS on one of them must be guarded or it reddens mirror CI.
  const haveBacklogSchema = existsSync(join(NOTES_DIR, "schema.backlog.yml"));
  const haveLegacyRootSchema = existsSync(join(NOTES_DIR, "backlog.schema.yml"));
  const haveBacklogTemplate = existsSync(join(NOTES_DIR, "templates.backlog.md"));
  const haveFullNotesVault = haveBacklogSchema && haveLegacyRootSchema && haveBacklogTemplate;

  it.skipIf(!haveBacklogSchema)("resolves backlog.* to the backlog schema and template", () => {
    const schema = findMatchingSchema(NOTES_DIR, "backlog.fix.qa-probe");
    expect(schema).not.toBeNull();
    expect(schema.id).toBe("backlog");
    expect(schema.template).toBe("templates.backlog");
  });

  // The root.* match is sourced from notes/backlog.schema.yml (id: root, template:
  // templates.root, no namespace line) — the only file that produces it. That file is
  // off-mirror; the surviving notes/root.schema.yml carries neither template: nor
  // namespace:, so on the mirror findMatchingSchema returns null and an unguarded
  // not.toBeNull() would redden.
  it.skipIf(!haveLegacyRootSchema)("preserves the pre-existing legacy match for root.*", () => {
    const schema = findMatchingSchema(NOTES_DIR, "root.anything");
    expect(schema).not.toBeNull();
    expect(schema.id).toBe("root");
    expect(schema.template).toBe("templates.root");
  });

  it("applies no template to the design, docs, how-to or learning namespaces", () => {
    for (const name of ["design.probe", "docs.probe", "how-to.probe", "learning.probe"]) {
      const schema = findMatchingSchema(NOTES_DIR, name);
      // NOTE: do NOT assert schema.template is falsy. design/docs/how-to yield "type".
      // The observable is the RESOLVED template.
      expect(loadSchemaTemplate(NOTES_DIR, schema && schema.template)).toBeNull();
    }
  });

  it("leaves schema.yml inert under the broadened filter", () => {
    expect(findMatchingSchema(NOTES_DIR, "notes.probe")).toBeNull();
    expect(findMatchingSchema(NOTES_DIR, "assets.probe")).toBeNull();
  });

  // notes/root.schema.yml IS on the mirror allowlist, so this stays unguarded and remains a
  // real assertion everywhere the suite runs, including the mirror.
  it("does not rename, move or delete notes/root.schema.yml", () => {
    expect(existsSync(join(NOTES_DIR, "root.schema.yml"))).toBe(true);
  });

  // The other three are off-mirror, so this witness is guarded.
  it.skipIf(!haveFullNotesVault)("renames, moves and deletes nothing in the full notes vault", () => {
    for (const f of ["schema.backlog.yml", "backlog.schema.yml", "templates.backlog.md"]) {
      expect(existsSync(join(NOTES_DIR, f))).toBe(true);
    }
  });

  it.skipIf(!haveBacklogTemplate)("merges template frontmatter while generated values win", () => {
    const templateParsed = parseFrontmatter(readFileSync(join(NOTES_DIR, "templates.backlog.md"), "utf8"));
    const generated = {
      id: "backlog.fix.qa-probe",
      title: "QA Probe",
      desc: "probe desc",
      created: 111,
      updated: 222,
      phase: "draft",
    };
    const { merged } = mergeTemplateWithGenerated({
      generated,
      templateParsed,
      content: "## Problem\nprobe",
      id: "backlog.fix.qa-probe",
    });
    expect(merged.status).toBe("not-implemented");
    expect(merged.testFile).toBe("");
    expect(merged.targetFiles).toEqual([]);
    expect(merged.title).toBe("QA Probe");
    expect(merged.title).not.toBe("Backlog");
    expect(merged.desc).toBe("probe desc");
    expect(merged.phase).toBe("draft");
    expect(merged.created).not.toBe(1768613956601);
    expect(merged.updated).not.toBe(1770319591053);
  });
});
