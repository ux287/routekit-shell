import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const notesDir = path.resolve(__dirname, "../../notes");

function readNote(slug) {
  return fs.readFileSync(path.join(notesDir, `${slug}.md`), "utf8");
}

function parseFrontmatterFields(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const block = match[1];
  const fields = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^(\w+):/);
    if (m) fields[m[1]] = true;
  }
  return fields;
}

// ─── public.canon.rks-config ─────────────────────────────────────────────────

describe("public.canon.rks-config", () => {
  const content = readNote("public.canon.rks-config");

  it("contains 'skillDefaults' entry in the .rks/project.json fields table", () => {
    expect(content).toContain("skillDefaults");
  });

  it("describes skillDefaults as mapping skill name to verbosity", () => {
    expect(content.toLowerCase()).toMatch(/skill.*verbosity|verbosity.*skill/);
  });

  it("contains 'offRail' entry in the .rks/project.json fields table", () => {
    expect(content).toContain("offRail");
  });

  it("describes offRail.enabled as a boolean", () => {
    expect(content).toMatch(/offRail.*enabled|enabled.*bool/i);
  });

  it("describes offRail.roots as an array", () => {
    expect(content).toMatch(/offRail.*roots|roots.*array/i);
  });

  it("has valid Dendron frontmatter with required fields", () => {
    const fields = parseFrontmatterFields(content);
    expect(fields.id).toBe(true);
    expect(fields.title).toBe(true);
    expect(fields.desc).toBe(true);
    expect(fields.created).toBe(true);
    expect(fields.updated).toBe(true);
  });
});

// ─── public.canon.getting-started ────────────────────────────────────────────

describe("public.canon.getting-started", () => {
  const content = readNote("public.canon.getting-started");

  it("onboarder section lists all seven stage names", () => {
    expect(content).toContain("welcome");
    expect(content).toContain("expectations");
    expect(content).toContain("stance");
    expect(content).toContain("first_story");
    expect(content).toContain("first_build");
    expect(content).toContain("first_ship");
    expect(content).toContain("next_steps");
  });

  it("includes a bridge paragraph describing what happens after the onboarder completes", () => {
    expect(content).toMatch(/after the onboarder completes|after.*onboarder.*complet/i);
  });

  it("has valid Dendron frontmatter with required fields", () => {
    const fields = parseFrontmatterFields(content);
    expect(fields.id).toBe(true);
    expect(fields.title).toBe(true);
    expect(fields.desc).toBe(true);
    expect(fields.created).toBe(true);
    expect(fields.updated).toBe(true);
  });
});

// ─── public.canon.build-path-analysis ────────────────────────────────────────

describe("public.canon.build-path-analysis", () => {
  const content = readNote("public.canon.build-path-analysis");

  it("includes 'arch-approved' gate between QA and Build in the on-rail sequence", () => {
    expect(content).toContain("arch-approved");
    expect(content).toMatch(/arch.*gate|\/arch|ARCH Governor/i);
  });

  it("includes a section distinguishing 2-branch from 3-branch ship paths", () => {
    expect(content).toMatch(/2-branch|two.branch/i);
    expect(content).toMatch(/3-branch|three.branch/i);
  });

  it("explains push → PR → merge for 3-branch", () => {
    expect(content).toMatch(/push.*PR.*merge|PR.*merge/i);
  });

  it("explains local merge with no PR for 2-branch", () => {
    expect(content).toMatch(/local merge|no PR/i);
  });

  it("has valid Dendron frontmatter with required fields", () => {
    const fields = parseFrontmatterFields(content);
    expect(fields.id).toBe(true);
    expect(fields.title).toBe(true);
    expect(fields.desc).toBe(true);
    expect(fields.created).toBe(true);
    expect(fields.updated).toBe(true);
  });
});

// ─── public.guide.rag-usage ──────────────────────────────────────────────────

describe("public.guide.rag-usage", () => {
  it("exists at notes/public.guide.rag-usage.md", () => {
    expect(fs.existsSync(path.join(notesDir, "public.guide.rag-usage.md"))).toBe(true);
  });

  const content = readNote("public.guide.rag-usage");

  it("contains correct DB path '.rks/rag/'", () => {
    expect(content).toContain(".rks/rag/");
  });

  it("does not contain the old '~/.routekit/rag/' path", () => {
    expect(content).not.toContain("~/.routekit/rag/");
  });

  it("references '.mcp.json' for MCP entry point", () => {
    expect(content).toContain(".mcp.json");
  });

  it("references 'packages/mcp-rks/bin/mcp-rks.mjs'", () => {
    expect(content).toContain("packages/mcp-rks/bin/mcp-rks.mjs");
  });

  it("does not reference 'npm run mcp:rag' as entry point", () => {
    expect(content).not.toMatch(/npm run mcp:rag/);
  });

  it("contains a section comparing rks_rag_query vs /research", () => {
    expect(content).toContain("rks_rag_query");
    expect(content).toContain("/research");
    expect(content).toMatch(/vs|versus|compared/i);
  });

  it("documents fidelity level L0", () => {
    expect(content).toMatch(/L0|fidelity.*0|level.*0/i);
  });

  it("documents fidelity level L1", () => {
    expect(content).toMatch(/L1|fidelity.*1|level.*1/i);
  });

  it("documents fidelity level L2", () => {
    expect(content).toMatch(/L2|fidelity.*2|level.*2/i);
  });

  it("contains a hybrid search section", () => {
    expect(content).toMatch(/hybrid search|hybrid/i);
  });

  it("contains a versioning sentinel footer", () => {
    expect(content).toMatch(/versioning sentinel|sentinel.*v1/i);
  });

  it("has valid Dendron frontmatter with required fields", () => {
    const fields = parseFrontmatterFields(content);
    expect(fields.id).toBe(true);
    expect(fields.title).toBe(true);
    expect(fields.desc).toBe(true);
    expect(fields.created).toBe(true);
    expect(fields.updated).toBe(true);
  });
});

// ─── public.guide.rag-setup ──────────────────────────────────────────────────

describe("public.guide.rag-setup", () => {
  it("exists at notes/public.guide.rag-setup.md", () => {
    expect(fs.existsSync(path.join(notesDir, "public.guide.rag-setup.md"))).toBe(true);
  });

  const content = readNote("public.guide.rag-setup");

  it("contains correct DB path '.rks/rag/'", () => {
    expect(content).toContain(".rks/rag/");
  });

  it("does not reference '~/.routekit/rag/'", () => {
    expect(content).not.toContain("~/.routekit/rag/");
  });

  it("contains correct MCP registration referencing '.mcp.json'", () => {
    expect(content).toContain(".mcp.json");
  });

  it("does not instruct to run 'npm run mcp:rag'", () => {
    expect(content).not.toMatch(/npm run mcp:rag/);
  });

  it("contains ONNX troubleshooting referencing 'RKS_RAG_EMBEDDINGS_MODE=stub'", () => {
    expect(content).toContain("RKS_RAG_EMBEDDINGS_MODE=stub");
  });

  it("contains a versioning sentinel footer", () => {
    expect(content).toMatch(/versioning sentinel|sentinel.*v1/i);
  });

  it("has valid Dendron frontmatter with required fields", () => {
    const fields = parseFrontmatterFields(content);
    expect(fields.id).toBe(true);
    expect(fields.title).toBe(true);
    expect(fields.desc).toBe(true);
    expect(fields.created).toBe(true);
    expect(fields.updated).toBe(true);
  });
});

// ─── public.guide.notes-structure ────────────────────────────────────────────

describe("public.guide.notes-structure", () => {
  it("exists at notes/public.guide.notes-structure.md", () => {
    expect(fs.existsSync(path.join(notesDir, "public.guide.notes-structure.md"))).toBe(true);
  });

  const content = readNote("public.guide.notes-structure");

  it("does not include slug prefix in note ID examples", () => {
    // Note IDs should NOT be like "my-app.how-to.getting-started" in the ID field
    // They should be like "how-to.getting-started" or "guide.rag-usage"
    expect(content).not.toMatch(/id:\s*my-app\.|id:\s*\[project-slug\]\./);
  });

  it("frontmatter schema section lists 'id' field", () => {
    expect(content).toMatch(/\bid\b.*string|\bid\b.*required/i);
  });

  it("frontmatter schema section lists 'title' field", () => {
    expect(content).toMatch(/title.*string|title.*required/i);
  });

  it("frontmatter schema section lists 'desc' field", () => {
    expect(content).toMatch(/desc.*string|desc.*recommended/i);
  });

  it("frontmatter schema section lists 'updated' field", () => {
    expect(content).toMatch(/updated.*timestamp|updated.*number/i);
  });

  it("frontmatter schema section lists 'created' field", () => {
    expect(content).toMatch(/created.*timestamp|created.*number/i);
  });

  it("namespace table includes 'public.canon.*'", () => {
    expect(content).toContain("public.canon.*");
  });

  it("namespace table includes 'public.guide.*'", () => {
    expect(content).toContain("public.guide.*");
  });

  it("contains a versioning sentinel footer", () => {
    expect(content).toMatch(/versioning sentinel|sentinel.*v1/i);
  });

  it("has valid Dendron frontmatter with required fields", () => {
    const fields = parseFrontmatterFields(content);
    expect(fields.id).toBe(true);
    expect(fields.title).toBe(true);
    expect(fields.desc).toBe(true);
    expect(fields.created).toBe(true);
    expect(fields.updated).toBe(true);
  });
});

// ─── public.guide.surgical-install ───────────────────────────────────────────

describe("public.guide.surgical-install", () => {
  it("exists at notes/public.guide.surgical-install.md", () => {
    expect(fs.existsSync(path.join(notesDir, "public.guide.surgical-install.md"))).toBe(true);
  });

  const content = readNote("public.guide.surgical-install");

  it("uses '.rks/rag/' paths (not '.routekit/rag/')", () => {
    expect(content).toContain(".rks/rag/");
    expect(content).not.toContain(".routekit/rag/");
  });

  it("references '.mcp.json' entry point", () => {
    expect(content).toContain(".mcp.json");
  });

  it("does not reference 'npm run mcp:rag'", () => {
    expect(content).not.toMatch(/npm run mcp:rag/);
  });

  it("does not reference 'rag-server.mjs'", () => {
    expect(content).not.toContain("rag-server.mjs");
  });

  it("contains an updated 'what gets created' file list", () => {
    expect(content).toMatch(/what gets created|gets created/i);
  });

  it("contains a versioning sentinel footer", () => {
    expect(content).toMatch(/versioning sentinel|sentinel.*v1/i);
  });

  it("has valid Dendron frontmatter with required fields", () => {
    const fields = parseFrontmatterFields(content);
    expect(fields.id).toBe(true);
    expect(fields.title).toBe(true);
    expect(fields.desc).toBe(true);
    expect(fields.created).toBe(true);
    expect(fields.updated).toBe(true);
  });
});
