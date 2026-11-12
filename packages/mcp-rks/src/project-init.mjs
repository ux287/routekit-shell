import fs from "fs";
import path from "path";
import { initProjectFromStack } from "../../cli/src/project/init-stack.js";
import { upsertProject } from "../../cli/src/project/index.js";
import YAML from "yaml";
import {
  normalizeProtectedConfig,
  mergeProtectedConfigs,
  writeProjectProtectedConfig,
  projectProtectedRelativePath,
} from "./server/project.mjs";

function assertDir(dirPath, label) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`${label} not found: ${dirPath}`);
  }
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function ensureTargetEmpty(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  const entries = fs.readdirSync(targetPath);
  if (entries.length > 0) {
    throw new Error(`Target path is not empty: ${targetPath}`);
  }
}

function buildProjectMetadata(id, stackId, targetPath) {
  return {
    id,
    stackId,
    root: targetPath,
    notesRoot: path.join(targetPath, "notes"),
    routekitDir: path.join(targetPath, "routekit"),
    kgPath: path.join(targetPath, "routekit", "kg.yaml"),
    projectJsonPath: path.join(targetPath, "routekit", "project.json"),
  };
}

export async function runProjectInit({
  shellRoot,
  id,
  stackId,
  targetPath,
  apply = false,
  register = false,
}) {
  if (!id) throw new Error("project id is required");
  if (!stackId) throw new Error("stack id is required");
  if (!targetPath) throw new Error("target path is required");

  const resolvedTarget = path.resolve(targetPath);
  const templateRoot = path.join(shellRoot, "templates", stackId);
  const skeletonDir = path.join(templateRoot, "skeleton");
  const stackKgFile = path.join(templateRoot, "kg.yaml");
  const templateProtectedPath = path.join(templateRoot, "protected-files.yml");

  assertDir(templateRoot, "Stack template root");
  assertDir(skeletonDir, "Stack skeleton");
  assertFile(stackKgFile, "Stack kg.yaml");
  ensureTargetEmpty(resolvedTarget);

  const metadata = buildProjectMetadata(id, stackId, resolvedTarget);

  if (!apply) {
    return {
      applied: false,
      project: metadata,
      templateRoot,
      skeletonDir,
      message: "Dry run only. Pass apply: true to scaffold the project.",
    };
  }

  const result = await initProjectFromStack({
    shellRoot,
    id,
    stackId,
    targetPath: resolvedTarget,
  });

  // Write protected-files.yml from template into project (.rks/protected-files.yml), merging if already present.
  if (fs.existsSync(templateProtectedPath)) {
    let templateConfig = null;
    try {
      const parsed = YAML.parse(fs.readFileSync(templateProtectedPath, "utf8"));
      templateConfig = normalizeProtectedConfig(parsed);
    } catch {
      templateConfig = null;
    }
    if (templateConfig) {
      const projectProtectedPath = path.join(resolvedTarget, projectProtectedRelativePath);
      let merged = templateConfig;
      if (fs.existsSync(projectProtectedPath)) {
        try {
          const existing = YAML.parse(fs.readFileSync(projectProtectedPath, "utf8"));
          merged = mergeProtectedConfigs(normalizeProtectedConfig(existing), templateConfig);
        } catch {
          merged = templateConfig;
        }
      }
      writeProjectProtectedConfig(resolvedTarget, merged);
    }
  }

  let registryRecord = null;
  if (register) {
    registryRecord = {
      id,
      stack: stackId,
      root: resolvedTarget,
      path: resolvedTarget,
      notesRoot: metadata.notesRoot,
      addedAt: new Date().toISOString(),
    };
    upsertProject(registryRecord, shellRoot);
  }

  return {
    applied: true,
    project: {
      ...metadata,
      kgPath: result.kgPath,
      projectJsonPath: result.projectJsonPath,
    },
    registryRecord,
  };
}
