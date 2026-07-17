import fs from "fs";
import path from "path";
import os from "os";
import YAML from "yaml";
import matter from "gray-matter";
import { ensureProjectMetadata } from "./metadata.js";

const DEFAULT_ROOT = path.join(os.homedir(), "Documents", "projects");
const PROJECTS_ROOT = path.resolve(process.env.ROUTEKIT_PROJECTS_ROOT || DEFAULT_ROOT);
const REGISTRY_FILE = path.join("projects", "index.jsonl");

export function ensureProjectDirs(id, rootOverride = null) {
  const base = rootOverride ? path.resolve(rootOverride) : PROJECTS_ROOT;
  const projectDir = path.join(base, id);
  const notesDir = path.join(projectDir, "notes");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(notesDir, { recursive: true });
  return { projectDir, notesDir };
}

export function appendProject(record, baseDir = process.cwd(), opts = {}) {
  const filePath = opts.registryPath || path.join(baseDir, REGISTRY_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + "\n");
}

export function writeRegistry(records, baseDir = process.cwd(), opts = {}) {
  const filePath = opts.registryPath || path.join(baseDir, REGISTRY_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = (records || []).map((entry) => JSON.stringify(entry)).join("\n");
  const text = normalized ? `${normalized}\n` : "";
  fs.writeFileSync(filePath, text);
  return filePath;
}

export function upsertProject(record, baseDir = process.cwd(), opts = {}) {
  if (!record?.id) throw new Error("upsertProject requires record.id");
  const existing = loadProjects(baseDir, opts).filter((p) => p.id !== record.id);
  const next = [...existing, record];
  writeRegistry(next, baseDir, opts);
  return record;
}

export function loadProjects(baseDir = process.cwd(), opts = {}) {
  const filePath = opts.registryPath || path.join(baseDir, REGISTRY_FILE);
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const projects = [];
  for (const line of lines) {
    try {
      projects.push(JSON.parse(line));
    } catch {
      console.warn("[routekit project] skipping malformed registry line");
    }
  }
  return projects;
}

export function writeProjectConfig(projectDir, config) {
  const configPath = path.join(projectDir, "project.config.yaml");
  const lines = Object.entries(config)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${v}`);
  fs.writeFileSync(configPath, lines.join("\n"));
  return configPath;
}

export function getProjectsRoot() {
  return PROJECTS_ROOT;
}

export function getProjectById(id, baseDir = process.cwd(), opts = {}) {
  if (!id) return null;
  const projects = loadProjects(baseDir, opts);
  return projects.find((p) => p.id === id) || null;
}

const SCAFFOLD_NOTE_MAP = {
  "project-overview": "project.overview.md",
  "discovery-interview": "discovery.interview.kickoff.md",
  "problem-backlog": "backlog.problems.md",
};

export function resolveScaffoldNotePath(project, target) {
  if (!project || !project.notesRoot) return null;
  const fileName = SCAFFOLD_NOTE_MAP[target];
  if (!fileName) return null;
  return path.join(project.notesRoot, fileName);
}

function buildScaffoldTemplate(project, target, createdAt) {
  const id = project?.id || "project";
  const client = project?.client || "";
  const mission = project?.mission || "";
  const type = project?.type || "";
  const dateVal = createdAt || new Date().toISOString();

  if (target === "project-overview") {
    return [
      "---",
      `title: Project Overview – ${id}`,
      `projectId: ${id}`,
      `created: ${dateVal}`,
      "tags:",
      "  - overview",
      "---",
      "",
      "# Project Overview",
      "",
      `- Client: ${client}`,
      `- Mission: ${mission}`,
      `- Type: ${type}`,
      "",
      "## Vision",
      "",
      "## Stakeholders",
      "",
      "## Constraints",
      "",
    ].join("\n");
  }

  if (target === "discovery-interview") {
    return [
      "---",
      `title: Discovery Interview – ${id}`,
      `projectId: ${id}`,
      `created: ${dateVal}`,
      "tags:",
      "  - discovery",
      "---",
      "",
      "# Discovery Interview Notes",
      "",
      "- Who:",
      "- When:",
      "",
      "## Questions",
      "",
      "## Answers / Insights",
      "",
      "## Follow-ups",
      "",
    ].join("\n");
  }

  if (target === "problem-backlog") {
    return [
      "---",
      `title: Problem Backlog – ${id}`,
      `projectId: ${id}`,
      `created: ${dateVal}`,
      "tags:",
      "  - backlog",
      "  - problems",
      "---",
      "",
      "# Problem Backlog",
      "",
      "- [ ] Problem 1",
      "- [ ] Problem 2",
      "- [ ] Problem 3",
      "",
    ].join("\n");
  }

  return null;
}

export function applyScaffoldNoteActions(project, actions, opts = {}) {
  if (!project || !project.notesRoot) throw new Error("Project metadata missing notesRoot");
  if (!Array.isArray(actions) || actions.length === 0) return { created: [], existing: [] };
  const created = [];
  const existing = [];
  for (const action of actions) {
    if (!action || action.kind !== "scaffold-note") continue;
    const target = action.target;
    const notePath = resolveScaffoldNotePath(project, target);
    if (!notePath) continue;
    if (fs.existsSync(notePath)) {
      existing.push(notePath);
      console.log(`Note already exists: ${notePath}`);
      continue;
    }
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    const body = buildScaffoldTemplate(project, target, opts.createdAt);
    if (!body) continue;
    fs.writeFileSync(notePath, body);
    created.push(notePath);
    console.log(`Created note: ${notePath}`);
  }
  return { created, existing };
}

export function writeDendronConfig(project) {
  if (!project?.root || !project?.notesRoot) {
    throw new Error("writeDendronConfig requires project.root and project.notesRoot");
  }
  const dendronPath = path.join(project.root, "dendron.yml");
  if (fs.existsSync(dendronPath)) {
    console.log(`dendron.yml already exists for project ${project.id || ""}, skipping.`);
    return dendronPath;
  }
  const config = {
    version: 1,
    vaults: [{ fsPath: "notes" }],
  };
  const yamlText = YAML.stringify(config);
  fs.writeFileSync(dendronPath, yamlText);
  return dendronPath;
}

export function writeVSCodeConfig(project) {
  if (!project?.root) {
    throw new Error("writeVSCodeConfig requires project.root");
  }
  const vscodeDir = path.join(project.root, ".vscode");
  const settingsPath = path.join(vscodeDir, "settings.json");
  const extensionsPath = path.join(vscodeDir, "extensions.json");

  fs.mkdirSync(vscodeDir, { recursive: true });

  if (fs.existsSync(settingsPath)) {
    console.log(`${settingsPath} already exists, skipping.`);
  } else {
    const settings = {
      "dendron.rootDir": ".",
      "dendron.defaultVault": "notes",
      "dendron.enableTelemetry": false,
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }

  if (fs.existsSync(extensionsPath)) {
    console.log(`${extensionsPath} already exists, skipping.`);
  } else {
    const ext = { recommendations: ["dendron.dendron"] };
    fs.writeFileSync(extensionsPath, JSON.stringify(ext, null, 2) + "\n");
  }

  return { settingsPath, extensionsPath };
}

export function getProjectRagRoot(project) {
  if (!project?.root) throw new Error("getProjectRagRoot requires project.root");
  return path.join(project.root, ".routekit", "lancedb", `${project.id || "project"}.lancedb`);
}

export function getProjectSearchDirs(project) {
  if (!project?.root || !project?.notesRoot) return [];
  const candidates = [
    project.notesRoot,
    path.join(project.root, "src"),
    path.join(project.root, "docs"),
  ];
  return candidates.filter((dir) => fs.existsSync(dir));
}

export { ensureProjectMetadata } from "./metadata.js";

const TEMPLATE_TARGET_MAP = {
  "project-overview": "project.overview.md",
  "discovery-interview": "discovery.interview.kickoff.md",
  "problem-backlog": "backlog.problems.md",
  "ia-overview": "ia.overview.md",
  "content-inventory": "content.inventory.md",
  "case-studies-template": "case-studies.template.md",
  "dev-setup": "dev.setup.md",
  "brand-direction": "brand.direction.md",
  "drafts-plan-kickoff": "drafts.plan.kickoff.md",
};

function buildTitleFromTarget(target, projectName, projectId) {
  const name = projectName || projectId || "Project";
  switch (target) {
    case "project-overview":
      return `Project Overview – ${name}`;
    case "discovery-interview":
      return "Discovery Interview – Kickoff";
    case "problem-backlog":
      return `Problem Backlog – ${projectId || name}`;
    case "ia-overview":
      return `IA Overview – ${name}`;
    case "content-inventory":
      return `Content Inventory – ${name}`;
    case "case-studies-template":
      return `Case Study Template – ${name}`;
    case "dev-setup":
      return `Dev Setup – ${name}`;
    case "brand-direction":
      return `Brand Direction – ${name}`;
    case "drafts-plan-kickoff":
      return `Kickoff Plan – ${name}`;
    default:
      return `${name} – ${target}`;
  }
}

function substituteTemplatePlaceholders(body, project) {
  const replacements = {
    "${PROJECT_NAME}": project?.name || project?.id || "Project",
    "${PROJECT_ID}": project?.id || "project-id",
    "${CLIENT_NAME}": project?.client || "Client",
  };
  let output = body || "";
  for (const [needle, val] of Object.entries(replacements)) {
    output = output.replaceAll(needle, val);
  }
  return output;
}

export async function seedProjectTemplateNotes(project, opts = {}) {
  if (!project?.notesRoot || !project?.template) return { created: [], existing: [] };
  if (project.template !== "content-cms") return { created: [], existing: [] };

  const shellRoot = opts.shellRoot ? path.resolve(opts.shellRoot) : process.cwd();
  const pattern = path.join(shellRoot, "notes", "project-templates.content-cms.*.md");
  const { glob } = await import("glob");
  const files = await glob(pattern, { nodir: true });
  const created = [];
  const existing = [];

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = matter(raw);
    const target = parsed.data?.target;
    const destRel = TEMPLATE_TARGET_MAP[target];
    if (!destRel) continue;
    const destPath = path.join(project.notesRoot, destRel);

    if (fs.existsSync(destPath)) {
      existing.push(destPath);
      console.log(`Note already exists, skipping template seed: ${destPath}`);
      continue;
    }

    const frontmatter = {
      title: buildTitleFromTarget(target, project.name, project.id),
      projectId: project.id,
      created: "{{date}}",
      tags: (function computeTags() {
        const base = Array.isArray(parsed.data?.tags) ? parsed.data.tags : [];
        const extras =
          target === "drafts-plan-kickoff" ? ["kickoff", "planning", project.id] : [project.id];
        return Array.from(new Set([...base, ...extras].filter(Boolean)));
      })(),
    };
    const body = substituteTemplatePlaceholders(parsed.content, project).trim() + "\n";
    const output = matter.stringify(body, frontmatter);

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, output);
    created.push(destPath);
    console.log(`Seeded template note: ${destPath}`);
  }

  return { created, existing };
}
