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

  it("is idempotent, no-ops when from === to, and never throws on missing files", () => {
    normalizeExportIdentity(dir, FROM, TO);
    expect(normalizeExportIdentity(dir, FROM, TO).changed).toEqual([]); // nothing left to change
    expect(normalizeExportIdentity(dir, TO, TO).changed).toEqual([]); // from === to short-circuits
    expect(() => normalizeExportIdentity(join(dir, "does-not-exist"), FROM, TO)).not.toThrow();
  });
});
