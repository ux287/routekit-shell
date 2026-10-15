import fs from "fs/promises";
import path from "path";
import { readRksVersion } from "./read-rks-version.mjs";

async function assertDirExists(dirPath, label) {
  try {
    const stats = await fs.stat(dirPath);
    if (!stats.isDirectory()) {
      throw new Error(`${label} is not a directory: ${dirPath}`);
    }
  } catch {
    throw new Error(`${label} not found: ${dirPath}`);
  }
}

async function assertFileExists(filePath, label) {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`${label} is not a file: ${filePath}`);
    }
  } catch {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

async function ensureEmptyDirectory(targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(targetDir);
  if (entries.length > 0) {
    throw new Error(`Target path is not empty: ${targetDir}`);
  }
}

export async function initProjectFromStack({ shellRoot, id, stackId, targetPath }) {
  if (!id) throw new Error("project id is required");
  if (!stackId) throw new Error("stack id is required");
  if (!targetPath) throw new Error("target path is required");

  const resolvedTarget = path.resolve(targetPath);
  const templateRoot = path.join(shellRoot, "templates", stackId);
  const skeletonDir = path.join(templateRoot, "skeleton");
  const stackKgFile = path.join(templateRoot, "kg.yaml");

  await assertDirExists(templateRoot, "Stack template root");
  await assertDirExists(skeletonDir, "Stack skeleton");
  await assertFileExists(stackKgFile, "Stack kg.yaml");
  await ensureEmptyDirectory(resolvedTarget);

  await fs.cp(skeletonDir, resolvedTarget, { recursive: true });

  // Update .rks/project.json with the actual project ID
  const projectJsonPath = path.join(resolvedTarget, ".rks", "project.json");
  // Stamp the ACTUAL shell release version, not the skeleton's frozen "0.1.0" literal.
  // "0.1.0" is the UNSTAMPED sentinel, used only if the shell version can't be read.
  const rksVersion = readRksVersion(shellRoot);
  try {
    const projectJson = JSON.parse(await fs.readFile(projectJsonPath, "utf8"));
    projectJson.id = id;
    if (rksVersion) projectJson.rksVersion = rksVersion;
    await fs.writeFile(projectJsonPath, JSON.stringify(projectJson, null, 2) + "\n");
  } catch (e) {
    // If project.json doesn't exist or is malformed, create minimal one
    // Ensure .rks/ directory exists first
    await fs.mkdir(path.dirname(projectJsonPath), { recursive: true });
    const minimalConfig = { id, rksVersion: rksVersion || "0.1.0", kgFile: "routekit/kg.yaml" };
    await fs.writeFile(projectJsonPath, JSON.stringify(minimalConfig, null, 2) + "\n");
  }

  return {
    projectId: id,
    stackId,
    targetPath: resolvedTarget,
    templateRoot,
    stackKgFile,
  };
}
