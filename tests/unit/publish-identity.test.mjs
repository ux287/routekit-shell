import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { normalizeExportIdentity } from "../../packages/mcp-rks/src/server/publish.mjs";

// The static-export identity rewrite: dev repo is `routekit-shell-core`, the published
// product is `routekit-shell`. normalizeExportIdentity runs on the extracted snapshot and
// must rewrite ONLY the identity surface via targeted key/line edits — never a global string
// replace (which would corrupt package-lock integrity hashes and tests/** fixtures).

const FROM = "routekit-shell-core";
const TO = "routekit-shell";

// files where NO legitimate FROM substring exists → the whole file must be FROM-free after.
const CLEAN_TARGETS = ["package.json", ".rks/project.json", ".mcp.json.example", "CLAUDE.md", "scripts/setup.mjs"];

// The SUBSTITUTION SENTINEL and the SURVIVING PLACEHOLDER — two DIFFERENT tokens, never one.
// The sentinel resolves to the target id in the delivered skills tree; the placeholder must
// SURVIVE into the delivered tree for the Governor prompt to resolve later.
const SENTINEL = "__RKS_SOURCE_PROJECT__";
const PLACEHOLDER = "__PROJECT_ID__";
const SKILL_REL = ".claude/skills/arch/SKILL.md";

// FIXTURE NOTE (PASS 9 N2). The shared `beforeEach` above deliberately creates NO
// `.claude/skills` directory — that is what keeps the six-file exact-equality pin
// satisfiable. Cases that need a skills-bearing tree call `seedSkillsTree(dir)` in their own
// body, so the tree the ORDERING guard runs against is DISTINCT from the tree the six-file
// pin runs against, even though both descend from the same `beforeEach` root.
function seedSkillsTree(root) {
  mkdirSync(join(root, ".claude", "skills", "arch"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "skills", "arch", "SKILL.md"),
    `# ARCH Governor Skill\n\n` +
      `    You are an ARCH Governor for projectId ${SENTINEL}. Read your prompt at\n` +
      `    .rks/prompts/governor-arch.md. Replace ${PLACEHOLDER} with ${SENTINEL}\n` +
      `    and __STORY_IDS__ with $ARGUMENTS. Then execute the ARCH review.\n`,
  );
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rks-identity-"));

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: FROM, version: "0.20.21" }, null, 2) + "\n");

  // package-lock with a CONTRIVED integrity hash that embeds the FROM substring, to prove the
  // transform touches only the name fields and never the integrity/resolved fields.
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify(
      {
        name: FROM,
        version: "0.20.21",
        lockfileVersion: 3,
        packages: {
          "": { name: FROM, version: "0.20.21" },
          "node_modules/dep": {
            version: "1.0.0",
            resolved: "https://reg/dep/-/dep-1.0.0.tgz",
            integrity: "sha512-routekit-shell-coreFAKEHASH==",
          },
        },
      },
      null,
      2,
    ) + "\n",
  );

  mkdirSync(join(dir, ".rks"), { recursive: true });
  writeFileSync(join(dir, ".rks", "project.json"), JSON.stringify({ id: FROM, kgFile: "routekit/kg.yaml" }, null, 2) + "\n");

  writeFileSync(
    join(dir, ".mcp.json.example"),
    JSON.stringify(
      {
        mcpServers: {
          "rks-gov": { command: "node", env: { ROUTEKIT_PROJECT_ID: FROM } },
          rks: { command: "node", env: { ROUTEKIT_REPO_ROOT: "${workspaceFolder}" } },
        },
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(join(dir, "CLAUDE.md"), `# CLAUDE.md\n\n**projectId**: \`"${FROM}"\`\n\nProse mentioning ${FROM} a second time.\n`);

  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "scripts", "setup.mjs"),
    `// falls back to ${FROM}\nexport function readProjectId(r){ try { return JSON.parse(x).id || "${FROM}"; } catch { return "${FROM}"; } }\n`,
  );

  // DECOY: a tests/ fixture that asserts the literal on purpose — MUST stay untouched.
  mkdirSync(join(dir, "tests", "unit"), { recursive: true });
  writeFileSync(join(dir, "tests", "unit", "some.test.mjs"), `expect(id).toBe("${FROM}");\n`);
});
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const readJson = (rel) => JSON.parse(readFileSync(join(dir, rel), "utf8"));
const readText = (rel) => readFileSync(join(dir, rel), "utf8");

describe("normalizeExportIdentity — export-only identity rewrite", () => {
  it("rewrites all six identity targets to the public name and reports them", () => {
    const { changed } = normalizeExportIdentity(dir, FROM, TO);

    expect(readJson("package.json").name).toBe(TO);
    expect(readJson("package-lock.json").name).toBe(TO);
    expect(readJson("package-lock.json").packages[""].name).toBe(TO);
    expect(readJson(".rks/project.json").id).toBe(TO);
    expect(readJson(".mcp.json.example").mcpServers["rks-gov"].env.ROUTEKIT_PROJECT_ID).toBe(TO);
    expect(readText("CLAUDE.md")).toContain(`"${TO}"`);
    expect(readText("scripts/setup.mjs")).toContain(`"${TO}"`);

    // every file with no legitimate FROM substring is now FROM-free
    for (const rel of CLEAN_TARGETS) expect(readText(rel)).not.toContain(FROM);

    expect(changed.sort()).toEqual(
      ["package.json", "package-lock.json", ".rks/project.json", ".mcp.json.example", "CLAUDE.md", "scripts/setup.mjs"].sort(),
    );
  });

  it("NEVER touches package-lock integrity/resolved or tests/** fixtures (no global replace)", () => {
    normalizeExportIdentity(dir, FROM, TO);
    const lock = readJson("package-lock.json");
    // the integrity hash embedding the substring is preserved verbatim
    expect(lock.packages["node_modules/dep"].integrity).toBe("sha512-routekit-shell-coreFAKEHASH==");
    expect(lock.packages["node_modules/dep"].resolved).toBe("https://reg/dep/-/dep-1.0.0.tgz");
    // the tests/ decoy that asserts the old literal is untouched
    expect(readText("tests/unit/some.test.mjs")).toContain(`"${FROM}"`);
  });

  it("is idempotent and never throws on missing files", () => {
    normalizeExportIdentity(dir, FROM, TO);
    expect(normalizeExportIdentity(dir, FROM, TO).changed).toEqual([]); // nothing left to change
    expect(() => normalizeExportIdentity(join(dir, "does-not-exist"), FROM, TO)).not.toThrow();
  });

  // THE ORDERING GUARD (PASS 9 N2). Runs against a SKILLS-BEARING tree — seeded here, not in
  // `beforeEach` — because with no skills tree a MISORDERED rewrite changes nothing and this
  // case stays green, which is exactly how a misordered implementation shipped undetected.
  //
  // Note also that `changed` ALONE can never detect the misordering: the short-circuit returns
  // a fresh `{ changed: [] }`, discarding anything a rewrite placed above it had pushed. The
  // operative assertion is therefore that the delivered skill file is BYTE-UNCHANGED — still
  // carrying the sentinel, and NOT carrying TO.
  it("short-circuits when from === to WITHOUT rewriting the delivered skills tree", () => {
    seedSkillsTree(dir);
    const before = readText(SKILL_REL);

    // first call on this tree, so the sentinel is still intact and a misordered rewrite would fire
    expect(normalizeExportIdentity(dir, TO, TO).changed).toEqual([]);

    expect(readText(SKILL_REL)).toBe(before);
    expect(readText(SKILL_REL)).toContain(SENTINEL);
    expect(readText(SKILL_REL)).not.toContain(TO);
  });

  // ACCEPTED CONSEQUENCE, recorded: a from === to export leaves sentinels unsubstituted. That
  // cannot arise for the real rks-public profile, whose identity is routekit-shell-core → routekit-shell.
  it("substitutes the sentinel across the delivered skills tree, preserving the placeholder", () => {
    seedSkillsTree(dir);

    const { changed } = normalizeExportIdentity(dir, FROM, TO);
    const delivered = readText(SKILL_REL);

    expect(delivered).toContain(`for projectId ${TO}.`); // (a) carries TO verbatim
    expect(delivered).not.toContain(SENTINEL); // (b) no surviving sentinel
    expect(delivered).toContain(PLACEHOLDER); // (c) placeholder SURVIVES
    expect(changed).toContain(SKILL_REL); // (d) reported in changed

    // TWO DISTINCT TOKENS: the trailing clause keeps the placeholder and resolves only the sentinel.
    expect(delivered).toContain(`Replace ${PLACEHOLDER} with ${TO}`);
  });
});
