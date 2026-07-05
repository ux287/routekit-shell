import fs from "fs";
import path from "path";
import YAML from "yaml";
import { normalizeProtectedConfig } from "./server/project.mjs";

const OFFICIAL_STACKS = new Set(["web-vite-rag-agency"]);

function readDescription(templateRoot) {
  const readme = path.join(templateRoot, "README.md");
  if (fs.existsSync(readme)) {
    const firstLine = fs.readFileSync(readme, "utf8").split("\n")[0];
    return firstLine.replace(/^#+\s*/, "").trim();
  }
  return null;
}

function readKg(templateRoot) {
  const kgPath = path.join(templateRoot, "kg.yaml");
  if (!fs.existsSync(kgPath)) return { kgPath: null, kg: null };
  try {
    const kg = YAML.parse(fs.readFileSync(kgPath, "utf8"));
    return { kgPath, kg };
  } catch {
    return { kgPath, kg: null };
  }
}

function readProtectedConfig(templateRoot) {
  const protectedPath = path.join(templateRoot, "protected-files.yml");
  if (!fs.existsSync(protectedPath)) {
    return { protectedConfigPath: null, protected: null };
  }
  try {
    const raw = fs.readFileSync(protectedPath, "utf8");
    const parsed = YAML.parse(raw);
    const normalized = normalizeProtectedConfig(parsed);
    return { protectedConfigPath: protectedPath, protected: normalized };
  } catch {
    return { protectedConfigPath: protectedPath, protected: null };
  }
}

function deriveDisplayName(stackId) {
  return stackId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function describeTemplate(stackId, kg, readmeLine) {
  if (kg?.description) return kg.description;
  if (readmeLine) return readmeLine;
  return `${deriveDisplayName(stackId)} stack template`;
}

function isOfficial(stackId, kg) {
  if (kg?.status) {
    const normalized = String(kg.status).toLowerCase();
    if (normalized === "official") return true;
    if (normalized === "experimental") return false;
  }
  if (Array.isArray(kg?.tags)) {
    if (kg.tags.map((tag) => String(tag).toLowerCase()).includes("experimental")) {
      return false;
    }
  }
  return OFFICIAL_STACKS.has(stackId);
}

export function listTemplates(repoRoot) {
  const templatesDir = path.join(repoRoot, "templates");
  if (!fs.existsSync(templatesDir)) return [];
  const entries = fs
    .readdirSync(templatesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  return entries.map((entry) => {
    const templateRoot = path.join(templatesDir, entry.name);
    const readmeLine = readDescription(templateRoot);
    const { kgPath, kg } = readKg(templateRoot);
    const { protectedConfigPath, protected: protectedConfig } = readProtectedConfig(templateRoot);
    return {
      stackId: entry.name,
      displayName: deriveDisplayName(entry.name),
      description: describeTemplate(entry.name, kg, readmeLine),
      official: isOfficial(entry.name, kg),
      kgPath: kgPath ? path.relative(repoRoot, kgPath) : null,
      kg,
      protectedConfigPath: protectedConfigPath ? path.relative(repoRoot, protectedConfigPath) : null,
      protectedConfig,
    };
  });
}
