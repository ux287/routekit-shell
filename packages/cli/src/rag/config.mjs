import fs from "fs";
import path from "path";

const DEFAULT_CONFIG = {
  version: 2,
  engine: "lancedb",
  paths: {
    // Unified database path - uses project slug for isolation
    unified: ".rks/rag/{projectSlug}.lancedb",
  },
};

// Legacy config for migration reference
const LEGACY_CONFIG = {
  version: 1,
  engine: "lancedb",
  paths: {
    notes: ".rks/rag/lance/notes.lance",
    code: ".rks/rag/lance/code.lance",
    kg: ".rks/rag/lance/kg.lance",
  },
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function initializeConfig(projectRoot, configPath) {
  const ragDir = path.join(projectRoot, ".rks", "rag");
  ensureDir(ragDir);
  ensureDir(path.dirname(configPath));

  // Get project slug from directory name
  const projectSlug = path.basename(projectRoot);

  // Create config with resolved unified path
  const config = {
    ...DEFAULT_CONFIG,
    paths: {
      unified: `.rks/rag/${projectSlug}.lancedb`,
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function getRagConfig(projectRoot) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const configPath = path.join(projectRoot, ".rks", "rag", "config.json");
  if (!fs.existsSync(configPath)) {
    initializeConfig(projectRoot, configPath);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return { config, configPath };
}

export function getRagPaths(projectRoot) {
  const { config } = getRagConfig(projectRoot);
  const projectSlug = path.basename(projectRoot);
  const resolveRel = (rel) => path.join(projectRoot, rel);

  // Version 2+ uses unified path
  if (config.version >= 2 && config.paths.unified) {
    const unifiedPath = config.paths.unified.replace("{projectSlug}", projectSlug);
    const resolvedUnified = resolveRel(unifiedPath);
    return {
      unified: resolvedUnified,
      // Aliases for backwards compatibility
      notes: resolvedUnified,
      code: resolvedUnified,
      kg: resolvedUnified,
    };
  }

  // Legacy version 1 - separate databases
  return {
    unified: resolveRel(config.paths.notes), // Use notes as primary for legacy
    notes: resolveRel(config.paths.notes),
    code: resolveRel(config.paths.code),
    kg: resolveRel(config.paths.kg),
  };
}
